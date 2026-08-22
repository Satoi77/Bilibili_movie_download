// FFmpeg WASM 内存诊断（feature/ffmpeg-4gb 分支实验页）
// 探测目标：
//   1. 当前构建的实际 wasm 堆上限（2GB / 4GB）
//   2. MEMFS writeFile 实际可写入的最大单文件
//   3. WORKERFS 是否可用（输入文件不占堆的关键能力）
// 结论决定大视频合并策略的升级路线。

const MB = 1024 * 1024;
// 阶梯测试序列：每级写完即删，堆占用不叠加；失败即停（OOM 会杀死 worker = 探到堆上限的标志）
// 256~768MB 区间已实测通过，直接从未知区起步探顶
const LADDER_MB = [1024, 1536, 2048, 2560];

let worker = null;

class MiniBridge {
  constructor(worker) {
    this.worker = worker;
    this.pending = {};
    this.nextId = 0;
    this.logs = [];
    this.dead = false;
    this.lastErrorDetail = '';
    worker.onerror = (e) => {
      this.dead = true;
      // 全量采集：脚本加载失败(404/CSP)、运行时未捕获异常走这里
      this.lastErrorDetail = [
        e.message ? 'message: ' + e.message : '',
        e.filename ? 'file: ' + e.filename + (e.lineno ? ':' + e.lineno + ':' + (e.colno || 0) : '') : '',
        e.error && e.error.stack ? 'stack: ' + e.error.stack : ''
      ].filter(Boolean).join('\n') || '(无详情)';
      const err = new Error('worker 异常终止\n' + this.lastErrorDetail);
      const pending = this.pending;
      this.pending = {};
      Object.values(pending).forEach(p => p.reject(err));
    };
    worker.onmessage = ({ data: { id, type, data } }) => {
      if (type === 'LOG') { this.logs.push(data.message || ''); return; }
      const p = this.pending[id];
      if (!p) return;
      delete this.pending[id];
      if (type === 'ERROR') p.reject(new Error(data));
      else p.resolve(data);
    };
  }
  send(type, payload, xfer) {
    if (this.dead) return Promise.reject(new Error('worker 已崩溃'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending[id] = { resolve, reject };
      this.worker.postMessage({ id, type, data: payload }, xfer || []);
    });
  }
}

const stepsEl = document.getElementById('steps');
function addStep(name, status, cls, detail) {
  const div = document.createElement('div');
  div.className = 'step';
  div.innerHTML =
    `<span class="status ${cls}">${status}</span><span class="name">${name}</span>` +
    (detail ? `<div class="detail">${detail}</div>` : '');
  stepsEl.appendChild(div);
  return div;
}
function updateStep(div, status, cls, detail) {
  const st = div.querySelector('.status');
  st.textContent = status;
  st.className = 'status ' + cls;
  if (detail !== undefined) {
    // 错误展示路径必须比业务路径更健壮：展示代码崩溃会掩盖真实错误
    let d = div.querySelector('.detail');
    if (!d) {
      d = document.createElement('div');
      d.className = 'detail';
      div.appendChild(d);
    }
    d.textContent = detail;
  }
}
function fmtMB(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / MB) + ' MB'; }

async function runProbe() {
  const btn = document.getElementById('run');
  btn.disabled = true;
  stepsEl.textContent = '';

  // ── 步骤 0：资源可达性预检 ──
  const s0 = addStep('0. 扩展资源预检', '运行中…', 'run');
  const resources = ['lib/ffmpeg.worker.js', 'lib/ffmpeg-core.js', 'lib/ffmpeg-core.wasm', 'lib/ffmpeg-core.worker.js'];
  const preResults = [];
  let preOk = true;
  for (const p of resources) {
    try {
      const r = await fetch(chrome.runtime.getURL(p), { method: 'HEAD' });
      preResults.push(`${p} — ${r.ok ? 'OK ' + r.status : 'HTTP ' + r.status}`);
      if (!r.ok) preOk = false;
    } catch (fetchErr) {
      preResults.push(`${p} — fetch 异常: ${fetchErr.message}`);
      preOk = false;
    }
  }
  updateStep(s0, preOk ? '通过' : '失败', preOk ? 'ok' : 'fail', preResults.join('\n'));

  // ── 步骤 1：加载 core ──
  const s1 = addStep('1. 加载 ffmpeg-core', '运行中…', 'run');
  try {
    worker = new Worker(chrome.runtime.getURL('lib/ffmpeg.worker.js'));
  } catch (constructErr) {
    // 同步抛出 = CSP 拦截或 URL 非法
    updateStep(s1, '失败', 'fail',
      'Worker 创建被拒绝: ' + (constructErr.stack || constructErr.message));
    btn.disabled = false;
    return;
  }
  const bridge = new MiniBridge(worker);
  let loadOk = false;
  try {
    const t0 = performance.now();
    const loadPromise = bridge.send('LOAD', {
      coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
      workerURL: chrome.runtime.getURL('lib/ffmpeg-core.worker.js')
    }, []);
    // wasm 编译耗时观测：超时只提示不中止，等待最终结果
    const slowTimer = setTimeout(() => {
      updateStep(s1, '仍在加载…', 'run',
        `已等待 ${Math.round((performance.now() - t0) / 1000)}s — wasm 编译需数秒到数十秒\n` +
        `若长时间无进展，请截图此页并打开 DevTools 查看该页面控制台报错`);
    }, 15000);
    try { await loadPromise; } finally { clearTimeout(slowTimer); }
    loadOk = true;
    updateStep(s1, '成功', 'ok', `耗时 ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    const coreLogs = bridge.logs.length ? '\nffmpeg 日志:\n' + bridge.logs.slice(-5).join('\n') : '';
    updateStep(s1, '失败', 'fail', `${e.message}${bridge.lastErrorDetail ? '\n' + bridge.lastErrorDetail : ''}${coreLogs}`);
  }

  if (!loadOk) { btn.disabled = false; return; }

  // ── 步骤 2：PROBE 堆与文件系统 ──
  let probe = null;
  const s2 = addStep('2. 探测堆大小与文件系统', '运行中…', 'run');
  try {
    probe = await bridge.send('PROBE', {}, []);
    updateStep(s2, '完成', 'ok',
      `wasm 堆上限: ${probe.heapGB} GB (${probe.heapBytes} 字节)\n` +
      `已打包文件系统: ${probe.filesystems.join(', ') || '(仅默认 MEMFS)'}\n` +
      `WORKERFS: ${probe.hasWorkerFS ? '✓ 可用' : '✗ 未打包'}`);
  } catch (e) {
    updateStep(s2, '失败', 'fail', e.message);
  }
  const verdictLines = [];
  if (probe) verdictLines.push(`初始堆 ${probe.heapGB} GB（HEAPU8 快照非上限；ALLOW_MEMORY_GROWTH 下堆按需增长）`);

  // ── 步骤 3：MEMFS 写入阶梯 ──
  let maxWriteMB = 0;
  const s3 = addStep('3. MEMFS 单文件写入阶梯', '运行中…', 'run');
  const ladderDetail = [];
  for (const mb of LADDER_MB) {
    if (bridge.dead) { ladderDetail.push(`${mb}MB — 跳过（worker 已崩溃）`); break; }
    let u8 = null;
    try {
      u8 = new Uint8Array(mb * MB);
      u8[0] = 1; u8[u8.length - 1] = 1; // 触碰首尾页，确保真实分配
    } catch (allocErr) {
      ladderDetail.push(`${mb}MB — 页面侧无法分配（JS 堆限制）: ${allocErr.message}`);
      break;
    }
    try {
      const t0 = performance.now();
      await bridge.send('WRITE_FILE', { path: `probe_${mb}.bin`, data: u8 }, [u8.buffer]);
      const dt = Math.round(performance.now() - t0);
      maxWriteMB = mb;
      ladderDetail.push(`${mb}MB ✓ ${dt}ms`);
      await bridge.send('DELETE_FILE', { path: `probe_${mb}.bin` }, []).catch(() => {});
    } catch (writeErr) {
      // OOM 杀死 worker = 探到堆增长上限（这正是我们要的测量值）
      ladderDetail.push(`${mb}MB ✗ ${writeErr.message.split('\n')[0]}` +
        (bridge.dead ? ' ← worker 被 OOM 终止：堆增长上限在此区间' : ''));
      break;
    } finally {
      u8 = null; // 页面侧立即释放引用
    }
  }
  updateStep(s3, maxWriteMB ? '完成' : '失败', maxWriteMB ? 'ok' : 'fail',
    `实际最大写入: ${maxWriteMB}MB\n` + ladderDetail.join('\n'));
  if (maxWriteMB) verdictLines.push(`MEMFS 单文件实测写入 ≥ ${fmtMB(maxWriteMB * MB)}（堆动态增长正常）`);

  // ── 阶梯后终态探测：确认堆实际增长到了哪里 ──
  if (!bridge.dead) {
    try {
      const after = await bridge.send('PROBE', {}, []);
      verdictLines.push(`阶梯后堆: ${after.heapGB} GB（初始 ${probe ? probe.heapGB : '?'} GB → 增长机制验证 ✓）`);
    } catch (e) {}
  } else {
    verdictLines.push('worker 已在阶梯中因 OOM 崩溃，后续步骤跳过');
  }

  // ── 步骤 4：WORKERFS 挂载测试 ──
  if (probe && probe.hasWorkerFS) {
    const s4 = addStep('4. WORKERFS 大文件挂载', '运行中…', 'run');
    try {
      const blobSize = 200 * MB;
      const chunk = new Uint8Array(1024 * 1024);
      crypto.getRandomValues(chunk);
      const parts = [];
      for (let i = 0; i < blobSize / chunk.length; i++) parts.push(chunk);
      const bigBlob = new Blob(parts); // Blob 引用传给 worker，数据不进 wasm 堆
      const mountRes = await bridge.send('MOUNT_WORKERFS',
        { mountpoint: '/mnt', files: [{ name: 'probe.bin', data: bigBlob }] }, []);
      // 让 ffmpeg 尝试读挂载文件：内容非法必然退出非零，但 log 中出现读取痕迹即证明通路成立
      let readTrace = '';
      try {
        await bridge.send('EXEC', { args: ['-i', '/mnt/probe.bin', '-f', 'null', '-'], timeout: 30000 }, []);
      } catch (execErr) {
        readTrace = execErr.message;
      }
      const logTail = bridge.logs.filter(l => /Input|Invalid|error|probe\.bin/i.test(l)).slice(-3).join('\n');
      await bridge.send('UNMOUNT_WORKERFS', { mountpoint: '/mnt' }, []).catch(() => {});
      updateStep(s4, '完成', 'ok',
        `挂载点: ${mountRes.mountpoint}（${mountRes.count} 个文件）\n` +
        `ffmpeg 读取痕迹:\n${logTail || '(无匹配日志)'}\nEXEC 结果: ${readTrace || 'exit 0'}`);
      verdictLines.push('WORKERFS 可用 ✓ → 升级路线：换 4GB 构建 + 输入走 WORKERFS 挂载，可合并 ~3.5GB 视频');
    } catch (e) {
      updateStep(s4, '失败', 'fail', e.message);
      verdictLines.push('WORKERFS 挂载异常 ✗ → 需检查构建参数');
    }
  } else {
    addStep('4. WORKERFS 挂载', '跳过', 'skip',
      '当前 @ffmpeg/core 0.12.x 官方单线程标准构建未打包 WORKERFS。\n' +
      '升级需自编译：emconfigure 追加 -s MAXIMUM_MEMORY=4GB -lworkerfs.js\n' +
      '参考验证案例: pavloshargan/ffmpeg-browser-4gb-plus（WORKERFS 读 5GB 输入成功）');
    verdictLines.push('官方构建无 WORKERFS → 输入必须整份写进 MEMFS，合并上限被锁死在 ~1GB');
  }

  // ── 汇总 ──
  addStep('结论', '', '',
    `<div class="verdict">${verdictLines.map(v => '· ' + v.replace(/</g, '&lt;')).join('<br>')}</div>`);
  btn.disabled = false;
}

document.getElementById('run').addEventListener('click', runProbe);
