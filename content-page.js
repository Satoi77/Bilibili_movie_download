// content-page.js - Page context: UI + Download + Progress reporting
(function() {
  if (window.__biliDLInjected) return;
  window.__biliDLInjected = true;

  // ─── Constants ───
  const QMAP = {16:'360P',32:'480P',64:'720P',80:'1080P',112:'1080P高码率',120:'4K',125:'HDR'};

  // ─── Bridge to extension ───
  function notify(type, data) {
    window.postMessage({ source: 'bilibili-downloader', type, data }, '*');
  }

  // 等待 ESM 解析器就绪（模块脚本异步执行，最长等 5 秒）
  async function ensureParser() {
    if (window.BiliCollectionParser) return window.BiliCollectionParser;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.BiliCollectionParser) return window.BiliCollectionParser;
    }
    throw new Error('合集解析器未就绪');
  }

  // ─── API Helpers ───
  async function fetchPageHTML(url) {
    const r = await fetch(url || location.href, {credentials:'include'});
    return r.text();
  }

  async function getVideoInfo(url) {
    const html = await fetchPageHTML(url);
    const parser = await ensureParser();
    const st = parser.extractInitialState(html);
    if (!st || !st.videoData) return null;
    const vd = st.videoData;
    return { aid: vd.aid, bvid: vd.bvid, cid: vd.cid, title: vd.title, pages: vd.pages || [] };
  }

  async function getVideoInfoByBvid(bvid) {
    try {
      const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {credentials:'include'});
      const d = await r.json();
      if (d.code !== 0 || !d.data) return null;
      const vd = d.data;
      return { aid: vd.aid, bvid: vd.bvid, cid: vd.cid, title: vd.title, pages: vd.pages || [] };
    } catch(e) {
      console.debug('[B站下载助手] getVideoInfoByBvid error:', bvid, e);
      return null;
    }
  }

  async function getPlayUrl(avid, bvid, cid, qn = 80, signal) {
    const url = `https://api.bilibili.com/x/player/wbi/playurl?qn=${qn}&fnver=0&fnval=4048&fourk=1&avid=${avid}&bvid=${bvid}&cid=${cid}`;
    const r = await fetchWithTimeout(url, {credentials:'include'}, 30000, signal);
    const d = await r.json();
    if (d.code !== 0) return null;
    return d.data;
  }

  async function sniffCollection() {
    try {
      const html = await fetchPageHTML();
      const parser = await ensureParser();
      const state = parser.extractInitialState(html);
      const tree = state && parser.buildCollectionTree(state);
      if (tree) return tree;
    } catch(e) {
      console.debug('[B站下载助手] __INITIAL_STATE__ 解析失败:', e);
    }

    // DOM 兜底（series 页等无状态数据场景）：partsKnown=false 组，入队时经 getVideoInfoByBvid 展开
    const seen = new Set();
    const groups = [];
    document.querySelectorAll('[data-key^="BV"]').forEach(item => {
      const bvid = item.getAttribute('data-key');
      if (!bvid || seen.has(bvid)) return;
      seen.add(bvid);
      const titleEl = item.querySelector('.title-txt') || item.querySelector('[class*="title"]');
      const title = titleEl?.textContent?.trim() || '';
      if (title) {
        groups.push({ title, bvid, aid: '', cover: '', partsKnown: false, parts: [] });
      }
    });
    if (groups.length === 0) return null;
    const collectionName = document.title?.replace(/- Bilibili.*$/, '').replace(/_哔哩哔哩.*$/, '').trim() || '合集下载';
    console.log('[B站下载助手] DOM 兜底嗅探:', groups.length, '个视频');
    return { collectionName, groups };
  }

  function fmtSize(bytes) {
    if (!bytes) return '未知';
    if (bytes > 1073741824) return (bytes/1073741824).toFixed(2)+'GB';
    if (bytes > 1048576) return (bytes/1048576).toFixed(2)+'MB';
    if (bytes > 1024) return (bytes/1024).toFixed(2)+'KB';
    return bytes+'B';
  }

  // B 站 playurl 的 dash size 字段已实测返回空值：优先取值，空则按 bandwidth(位/秒)×duration(秒) 估算
  function dashSize(entry, durationSec) {
    if (entry?.size) return entry.size;
    if (entry?.bandwidth && durationSec > 0) return Math.round(entry.bandwidth / 8 * durationSec);
    return 0;
  }

  // ─── Timeout / abort helpers ───

  async function fetchWithTimeout(url, options, ms, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const onOuterAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await fetch(url, { ...(options || {}), signal: ctrl.signal });
    } catch (e) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (e && e.name === 'AbortError') throw new Error('请求超时');
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  function readWithTimeout(reader, ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取超时')), ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        (v) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
          else reject(e);
        }
      );
    });
  }

  async function fetchSettings() {
    try {
      return await new Promise((resolve) => {
        notify('GET_SETTINGS');
        const handler = (e) => {
          if (e.data?.source === 'bilibili-downloader' && e.data.type === 'settings_result') {
            window.removeEventListener('message', handler);
            resolve(e.data.data || {});
          }
        };
        window.addEventListener('message', handler);
        setTimeout(() => { window.removeEventListener('message', handler); resolve({}); }, 3000);
      });
    } catch (e) { return {}; }
  }

  // ─── Download with progress ───
  // 进度消息按 1% 粒度节流，避免刷爆后台/侧栏

  // 候选地址列表：主链接 + 备用链接（dash 条目 camelCase/snake_case 字段均兼容）
  function streamUrlList(entry) {
    return [entry?.baseUrl || entry?.base_url, ...(entry?.backupUrl || entry?.backup_url || [])]
      .filter(u => typeof u === 'string' && u.length > 0);
  }

  // 单个地址的完整尝试：请求 + 读流 + 进度上报；state.chunks 跨地址保留已收字节（断点续传）
  async function downloadBlobOnce(url, taskId, phase, label, signal, state) {
    const chunks = state.chunks;
    let baseOffset = chunks.reduce((n, c) => n + c.length, 0);
    let r = await fetchWithTimeout(url, { headers: baseOffset > 0 ? { Range: 'bytes=' + baseOffset + '-' } : {} }, 60000, signal);
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    let total = parseInt(r.headers.get('content-length') || '0');
    if (baseOffset > 0) {
      const m = r.status === 206 ? /^bytes (\d+)-\d+\/(\d+)$/.exec(r.headers.get('content-range') || '') : null;
      if (m && Number(m[1]) === baseOffset) {
        total = Number(m[2]);
      } else if (r.status !== 200) {
        // CDN 未按请求续传且给的不是干净全量（如区间错位的 206）：字节序列不可信，弃响应重发
        try { await r.body.cancel(); } catch (_) {}
        chunks.length = 0;
        baseOffset = 0;
        r = await fetchWithTimeout(url, {}, 60000, signal);
        if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
        total = parseInt(r.headers.get('content-length') || '0');
      } else {
        // CDN 忽略 Range 返回全量：从头覆盖
        chunks.length = 0;
        baseOffset = 0;
      }
    }
    const reader = r.body.getReader();
    let received = 0;
    let lastSent = -1;

    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      let res;
      try {
        res = await readWithTimeout(reader, 30000, signal);
      } catch (e) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        throw e;
      }
      if (res.done) break;
      chunks.push(res.value);
      received += res.value.length;

      const percent = total > 0 ? Math.round((baseOffset + received) / total * 100) : -1;
      if (percent !== lastSent) {
        lastSent = percent;
        notify('download_progress', {
          taskId, phase, percent,
          received: baseOffset + received, total,
          label
        });
      }
    }

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (total > 0 && baseOffset + received !== total) throw new Error(`${label} 流长度不完整(${baseOffset + received}/${total})`);
    return new Blob(chunks);
  }

  // 逐个候选地址尝试：B 站 CDN 瞬时抖动（连接重置等表现为 TypeError: Failed to fetch）
  // 只影响单个地址，切换备用链接并携带已收字节（Range）续传，不再让整任务失败
  async function downloadBlob(urls, taskId, phase, label, signal) {
    const candidates = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
    if (candidates.length === 0) throw new Error(`${label} 无可用下载地址`);
    const state = { chunks: [] };
    let lastErr = null;
    for (const url of candidates) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        return await downloadBlobOnce(url, taskId, phase, label, signal, state);
      } catch (e) {
        // 用户中止立即透传，不浪费剩余地址
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  // 固定下载根目录：浏览器默认下载目录下的 bilibili_download 子目录
  const DOWNLOAD_BASE = 'bilibili_download';
  // wasm32 的 FFmpeg WASM 堆有约 2GB 硬上限：合并需同时容纳 输入+输出 ≈ 2×总大小。
  // 该阈值不是"跳过合并"的一刀切门槛：超过阈值的大文件先落盘分离文件作保底，
  // 仍会尝试合并（卡在内存边界附近的文件有机会成功），失败时保底文件直接可用。
  const MERGE_THRESHOLD = 600 * 1024 * 1024;
  // 实测（2026-08-22 内存诊断）：官方构建 wasm 堆默认上限 2GB，总大小 ≥900MB 时
  // 合并必然 OOM 且会杀死 FFmpeg worker（连累后续任务），直接落盘保底不再尝试
  const MERGE_HARD_LIMIT = 900 * 1024 * 1024;

  // 输出路径解析（与 lib/download-core.js 的导出版保持一致；页面世界经典脚本无法 import）
  function resolveOutputTargets(videoInfo, label) {
    const safeTitle = sanitizeFilename(videoInfo.title || '') || '_';
    if (videoInfo.dir) {
      const safeDir = String(videoInfo.dir).split('/').map(sanitizeFilename).join('/');
      const safeBase = sanitizeFilename(videoInfo.baseName || safeTitle);
      return {
        mergedDir: DOWNLOAD_BASE + '/' + safeDir,
        mergedName: `${safeBase}${label ? '_' + label : ''}.mp4`,
        rawSubdir: DOWNLOAD_BASE + '/' + safeDir + '/' + safeBase
      };
    }
    return {
      mergedDir: DOWNLOAD_BASE,
      mergedName: `${safeTitle}${label ? '_' + label : ''}.mp4`,
      rawSubdir: DOWNLOAD_BASE + '/' + safeTitle
    };
  }

  function fmtBytesText(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
    if (n >= 1048576) return Math.round(n / 1048576) + 'MB';
    return n + 'B';
  }

  // 通过 background.js 的 chrome.downloads.download 保存（可靠，支持子目录）
  async function saveBlobViaDownloads(blob, filename, subdir) {
    // 直接传 Blob 引用：结构化克隆共享底层数据（磁盘 backed），禁止 arrayBuffer() 全量拷贝
    // （大文件多次拷贝会 OOM，正是"只剩 merge.txt"的元凶之一）
    const requestId = filename + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
    try {
      const downloadId = await new Promise((resolve, reject) => {
        const handler = (e) => {
          if (e.data?.source !== 'bilibili-downloader') return;
          if (e.data.type !== 'save_blob_result') return;
          if (e.data.data.requestId !== requestId) return;
          window.removeEventListener('message', handler);
          clearTimeout(t);
          if (e.data.data.success) resolve(e.data.data.downloadId || null);
          else reject(new Error(e.data.data.error || '保存失败'));
        };
        window.addEventListener('message', handler);
        // 保存等待期 = 下载终态确认期（含大文件落盘耗时），超时兜底与后台一致放宽到 30 分钟
        const t = setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('保存超时')); }, 30 * 60 * 1000);
        window.postMessage({ source: 'bilibili-downloader', type: 'SAVE_BLOB', data: { requestId, blob, filename, subdir: subdir || '' } }, '*');
      });
      return downloadId; // 供"合并成功后按设置删除原始文件"使用
    } catch(e) {
      console.debug('[B站下载助手] SAVE_BLOB 失败，回退到 <a download>:', e);
      saveBlob(blob, filename);
      return null;
    }
  }

  // 删除已通过 chrome.downloads 落盘的原始文件（经 content.js 转发到 background）
  async function removeSavedFileViaPage(downloadId) {
    const requestId = 'del_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
    await new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data?.source !== 'bilibili-downloader') return;
        if (e.data.type !== 'delete_blob_result') return;
        if (e.data.data.requestId !== requestId) return;
        window.removeEventListener('message', handler);
        clearTimeout(t);
        if (e.data.data.success) resolve();
        else reject(new Error(e.data.data.error || '删除原始文件失败'));
      };
      window.addEventListener('message', handler);
      const t = setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('删除请求超时')); }, 30000);
      window.postMessage({ source: 'bilibili-downloader', type: 'DELETE_BLOB_FILE', data: { requestId, downloadId } }, '*');
    });
  }

  // 下载文件：保存到设置中的自定义子目录，否则浏览器默认
  async function downloadFile(blob, filename, subdir) {
    await saveBlobViaDownloads(blob, filename, subdir || '');
  }

  /**
   * 保存原始音频/视频文件到最终子目录（目录已含 baseName 隔离层）
   */
  async function saveRawToSubdir(audioBlob, videoBlob, finalSubdir) {
    // MIME 用 video/mp4 且文件名用 .mp4：B 站 dash 流本身是 fMP4 容器，
    // 若命名为 .m4s，Chrome 会按内容类型把扩展名改写成 .mp4
    // 用 slice 改 MIME（引用共享零拷贝）；禁止 arrayBuffer() 全量拷贝（大文件 OOM）
    const audioForSave = audioBlob.slice(0, audioBlob.size, 'video/mp4');
    const videoForSave = videoBlob.slice(0, videoBlob.size, 'video/mp4');
    const audioId = await saveBlobViaDownloads(audioForSave, 'audio.mp4', finalSubdir);
    const videoId = await saveBlobViaDownloads(videoForSave, 'video.mp4', finalSubdir);
    console.log('[B站下载助手] 原始文件已保存到子目录:', finalSubdir);
    return [audioId, videoId]; // downloadId 列表，供合并成功后按设置删除
  }

  /**
   * 保存 merge.txt 合并说明到最终子目录（仅在 FFmpeg 合并失败时调用）
   */
  async function saveMergeTxt(finalSubdir) {
    const txtContent = [
      '将此目录下的 audio.mp4 和 video.mp4 合并为 mp4 文件。',
      '',
      '方法一：使用 ffmpeg 命令行',
      '  ffmpeg -i video.mp4 -i audio.mp4 -vcodec copy -acodec copy merged.mp4',
      '',
      '方法二：将本文件重命名为 merge.bat，双击运行',
      '  （需要已安装 ffmpeg 并添加到 PATH 环境变量）'
    ].join('\r\n');
    const blob = new Blob([txtContent], { type: 'text/plain' });
    await saveBlobViaDownloads(blob, 'merge.txt', finalSubdir);
    console.log('[B站下载助手] merge.txt 已保存到子目录:', finalSubdir);
  }

  async function deleteDownloadedFile(downloadPath) {
    window.postMessage({
      source: 'bilibili-downloader',
      type: 'DELETE_FILE',
      data: { path: downloadPath }
    }, '*');
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').substring(0, 200);
  }

  // ─── FFmpeg WASM 桥接 ───
  // 在页面上下文运行，通过 postMessage 与 lib/ffmpeg.worker.js Worker 通信

  let ffmpegBridge = null;   // FFmpegBridge 单例
  let ffmpegURLs = {};       // content.js 预取的 Blob URL

  window.addEventListener('message', (e) => {
    if (e.data?.source === 'bilibili-downloader' && e.data.type === 'ffmpeg_urls') {
      ffmpegURLs = e.data.data;
      console.log('[B站下载助手] FFmpeg URLs received:', Object.keys(ffmpegURLs));
    }
  });

  // Worker 消息类型
  const Op = {
    LOAD: 'LOAD', EXEC: 'EXEC',
    WRITE_FILE: 'WRITE_FILE', READ_FILE: 'READ_FILE',
    DELETE_FILE: 'DELETE_FILE', RENAME: 'RENAME',
    CREATE_DIR: 'CREATE_DIR', LIST_DIR: 'LIST_DIR',
    DELETE_DIR: 'DELETE_DIR',
    ERROR: 'ERROR', LOG: 'LOG', PROGRESS: 'PROGRESS'
  };

  // 操作结果类型集合（用于 resolve 判断）
  const RESULT_OPS = new Set([
    Op.LOAD, Op.EXEC, Op.WRITE_FILE, Op.READ_FILE,
    Op.DELETE_FILE, Op.RENAME, Op.CREATE_DIR, Op.LIST_DIR, Op.DELETE_DIR
  ]);

  let nextMsgId = 0;

  /**
   * FFmpegBridge - 页面端与 Worker 通信的封装
   */
  class FFmpegBridge {
    #worker = null;
    #pending = {};           // msgId → { resolve, reject }
    #logHandlers = [];
    #progressHandlers = [];
    ready = false;

    constructor(worker) {
      this.#worker = worker;
      this.#attachReceiver();
    }

    #attachReceiver() {
      this.#worker.onmessage = ({ data: { id, type, data } }) => {
        if (type === Op.LOG) {
          this.#logHandlers.forEach(fn => fn(data));
          return;
        }
        if (type === Op.PROGRESS) {
          this.#progressHandlers.forEach(fn => fn(data));
          return;
        }

        const p = this.#pending[id];
        if (!p) return;
        delete this.#pending[id];

        if (type === Op.ERROR) {
          p.reject(new Error(data));
        } else if (RESULT_OPS.has(type)) {
          if (type === Op.LOAD) this.ready = true;
          p.resolve(data);
        }
      };
    }

    #send(type, payload, transferable) {
      return new Promise((resolve, reject) => {
        const id = nextMsgId++;
        this.#pending[id] = { resolve, reject };
        this.#worker.postMessage({ id, type, data: payload }, transferable || []);
      });
    }

    on(event, handler) {
      if (event === 'log') this.#logHandlers.push(handler);
      else if (event === 'progress') this.#progressHandlers.push(handler);
    }

    load(opts) {
      return this.#send(Op.LOAD, opts);
    }

    run(args, timeout) {
      return this.#send(Op.EXEC, { args, timeout: timeout ?? -1 });
    }

    writeFile(path, data) {
      const xfer = data instanceof Uint8Array ? [data.buffer] : [];
      return this.#send(Op.WRITE_FILE, { path, data }, xfer);
    }

    readFile(path, encoding) {
      return this.#send(Op.READ_FILE, { path, encoding });
    }

    deleteFile(path) {
      return this.#send(Op.DELETE_FILE, { path });
    }

    destroy() {
      if (this.#worker) {
        this.#worker.terminate();
        this.#worker = null;
        this.ready = false;
      }
    }
  }

  // fetch → Blob URL（绕过 CSP）
  async function toBlobURL(resourceURL, mimeType) {
    const res = await fetch(resourceURL);
    if (!res.ok) throw new Error('fetch 失败: ' + resourceURL + ' HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }

  /**
   * 获取或初始化 FFmpegBridge 单例
   */
  async function getFFmpeg() {
    if (ffmpegBridge?.ready) return ffmpegBridge;

    if (!ffmpegURLs.workerJS) {
      // 等待 content.js 预取完成（最多 10 秒）
      await new Promise(resolve => {
        let elapsed = 0;
        const tick = setInterval(() => {
          elapsed += 100;
          if (ffmpegURLs.workerJS || elapsed >= 10000) { clearInterval(tick); resolve(); }
        }, 100);
      });
    }
    if (!ffmpegURLs.workerJS) throw new Error('FFmpeg 资源未就绪，请刷新页面重试');

    // 从 Blob URL 创建 Worker
    const workerBlobURL = await toBlobURL(ffmpegURLs.workerJS, 'text/javascript');
    const worker = new Worker(workerBlobURL);
    ffmpegBridge = new FFmpegBridge(worker);

    ffmpegBridge.on('log', ({ message }) => {
      if (message) console.log('[FFmpeg]', message);
    });

    // 初始化 WASM Core
    await ffmpegBridge.load({
      coreURL: ffmpegURLs.core,
      wasmURL: ffmpegURLs.wasm,
      workerURL: ffmpegURLs.coreWorker
    });

    console.log('[B站下载助手] FFmpeg WASM 初始化完成');
    return ffmpegBridge;
  }

  async function mergeWithFFmpeg(audioBlob, videoBlob, taskId) {
    const ffmpeg = await getFFmpeg();

    const tag = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const audioPath = tag + '_audio.m4s';
    const videoPath = tag + '_video.m4s';
    const outputPath = tag + '_merged.mp4';

    // 写入虚拟文件系统
    await ffmpeg.writeFile(audioPath, new Uint8Array(await audioBlob.arrayBuffer()));
    await ffmpeg.writeFile(videoPath, new Uint8Array(await videoBlob.arrayBuffer()));

    // 合并期间发送心跳，避免后台停滞检测误判
    const heartbeat = setInterval(() => {
      notify('download_progress', { taskId, phase: 'merge', percent: 50, label: '合并中' });
    }, 20000);

    // 合并（直接 copy 流，无重编码）
    try {
      await ffmpeg.run(['-i', videoPath, '-i', audioPath, '-vcodec', 'copy', '-acodec', 'copy', outputPath]);
    } finally {
      clearInterval(heartbeat);
    }
    // 先删输入再读输出：读出的副本复用刚释放的输入区，堆峰值从 ≈3×总大小 降到 ≈2×总大小
    ffmpeg.deleteFile(audioPath).catch(() => {});
    ffmpeg.deleteFile(videoPath).catch(() => {});
    const merged = await ffmpeg.readFile(outputPath);
    ffmpeg.deleteFile(outputPath).catch(() => {});

    return new Blob([merged.buffer], { type: 'video/mp4' });
  }

  // 页面卸载时清理资源
  window.addEventListener('beforeunload', () => {
    if (ffmpegBridge) {
      ffmpegBridge.destroy();
      ffmpegBridge = null;
    }
  }, true);

  // ─── Queue-mode task execution ───
  // 后台队列把 RUN_TASK 派发给本页面执行；本页面按 taskId 独立跑下载，
  // 结束后回报 TASK_DONE / TASK_ERROR / TASK_ABORTED。

  const activeTaskControllers = new Map();

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'bilibili-downloader') return;
    if (e.data.type === 'RUN_TASK') {
      const { taskId, videoInfo, qualityIdx } = e.data.data || {};
      if (taskId && videoInfo) runQueuedTask(taskId, videoInfo, qualityIdx || 0);
    } else if (e.data.type === 'ABORT_TASK') {
      abortTask((e.data.data || {}).taskId);
    }
  });

  function abortTask(taskId) {
    const c = activeTaskControllers.get(taskId);
    if (c) { try { c.abort(); } catch (e) {} }
  }

  async function runQueuedTask(taskId, videoInfo, qualityIdx) {
    const controller = new AbortController();
    activeTaskControllers.set(taskId, controller);
    try {
      const result = await executeDownload(taskId, videoInfo, qualityIdx || 0, controller.signal);
      if (controller.signal.aborted) {
        notify('TASK_ABORTED', { taskId });
      } else {
        notify('TASK_DONE', { taskId, note: result?.note || '' });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        notify('TASK_ABORTED', { taskId });
      } else {
        // 预期内的任务失败已通过 TASK_ERROR 上报 UI，用 debug 级避免被浏览器扩展错误日志收集刷屏
        console.debug('[B站下载助手] Task failed:', taskId, e);
        notify('TASK_ERROR', { taskId, error: e.message });
      }
    } finally {
      activeTaskControllers.delete(taskId);
    }
  }

  // ─── Execute a single download ───
  async function executeDownload(taskId, videoInfo, qualityIdx, signal) {
    const settings = await fetchSettings();
    
    const data = await getPlayUrl(videoInfo.aid, videoInfo.bvid, videoInfo.cid, 80, signal);
    if (!data?.dash) {
      console.debug('[B站下载助手] getPlayUrl returned null or no dash:', data);
      throw new Error('获取播放地址失败');
    }
    console.log('[B站下载助手] dash videos:', data.dash.video.length, 'audios:', data.dash.audio.length);
    
    const videoByQ = {};
    data.dash.video.forEach(v => {
      if (!videoByQ[v.id]) videoByQ[v.id] = [];
      videoByQ[v.id].push(v);
    });
    
    const options = Object.keys(videoByQ).map(Number).sort((a,b) => b-a);
    const q = options[qualityIdx] || options[0];
    const streams = videoByQ[q].sort((a,b) => b.bandwidth - a.bandwidth);
    const bestVideo = streams[0];
    const bestAudio = data.dash.audio[0];
    
    const label = QMAP[q] || q + 'P';
    // B 站 playurl 的 dash 条目带精确字节数（size 为空时按码率估算），上报给任务卡片展示
    const dur = data.dash.duration || Math.round((data.timelength || 0) / 1000);
    const totalSize = dashSize(bestVideo, dur) + dashSize(bestAudio, dur);
    notify('download_progress', { taskId, phase: 'quality', percent: 0, label, totalSize });
    
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    
    // Download audio + video in memory
    notify('download_progress', { taskId, phase: 'download', percent: 0, label: '下载中' });
    
    const [audioBlob, videoBlob] = await Promise.all([
      downloadBlob(streamUrlList(bestAudio), taskId, 'audio', '音频', signal),
      downloadBlob(streamUrlList(bestVideo), taskId, 'video', '视频', signal)
    ]);
    
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    
    notify('download_progress', { taskId, phase: 'download', percent: 100, label: '下载完成' });
    // 用真实字节数修正任务卡片的合计容量（入队时的值为估算）
    notify('download_progress', { taskId, phase: 'quality', percent: 0, totalSize: audioBlob.size + videoBlob.size });

    const targets = resolveOutputTargets(videoInfo, label);
    let rawSaved = false;
    let rawFileIds = null;

    // 如果开启了保存原始文件，先保存
    if (settings.saveRawFiles) {
      try {
        notify('download_progress', { taskId, phase: 'merge', percent: 0, label: '保存原始文件' });
        rawFileIds = await saveRawToSubdir(audioBlob, videoBlob, targets.rawSubdir);
        rawSaved = true;
      } catch(e) {
        console.debug('[B站下载助手] 保存原始文件失败:', e);
      }
    }

    // 大文件不再一刀切跳过合并：先落盘分离文件作保底，仍尝试合并（内存边界处有机会成功）
    const bigFile = audioBlob.size + videoBlob.size > MERGE_THRESHOLD;
    let note = '';

    if (!bigFile) {
      // 小文件：直接合并（成功率接近 100%），失败才降级落盘
      try {
        notify('download_progress', { taskId, phase: 'merge', percent: 50, label: '合并中' });
        const mergedBlob = await mergeWithFFmpeg(audioBlob, videoBlob, taskId);
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await downloadFile(mergedBlob, targets.mergedName, targets.mergedDir);
        notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '合并完成' });
      } catch(mergeError) {
        console.debug('[B站下载助手] FFmpeg 合并失败:', mergeError);
        if (signal?.aborted) throw mergeError;
        // 合并执行失败：降级为分离保存，任务正常完成
        if (!rawSaved) {
          try {
            await saveRawToSubdir(audioBlob, videoBlob, targets.rawSubdir);
            rawSaved = true;
          } catch(e) {
            console.debug('[B站下载助手] 兜底保存原始文件也失败:', e);
          }
        }
        try { await saveMergeTxt(targets.rawSubdir); } catch(e) {}
        if (!rawSaved) throw new Error('合并失败且分离文件保存失败: ' + mergeError.message);
        notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '已保存分离文件' });
        note = `合并失败（${mergeError.message}），已保存分离音视频，请按 merge.txt 说明本地合并`;
      }
      return { note };
    }

    // 大文件路径：先落盘分离文件作保底（用户指定的顺序），再尝试合并。
    // 失败时保底文件直接可用并补 merge.txt；成功后按设置决定原始文件去留。
    if (!rawSaved) {
      try {
        notify('download_progress', { taskId, phase: 'merge', percent: 0, label: '保存原始文件' });
        rawFileIds = await saveRawToSubdir(audioBlob, videoBlob, targets.rawSubdir);
        rawSaved = true;
      } catch(e) {
        console.debug('[B站下载助手] 分离文件保存失败:', e);
      }
    }
    if (!rawSaved) throw new Error(`分离文件保存失败（文件 ${fmtBytesText(audioBlob.size + videoBlob.size)}）`);

    // 实测 wasm 堆上限 2GB：总大小 ≥900MB 时合并必然 OOM，直接落盘保底不再尝试
    const worthMerging = audioBlob.size + videoBlob.size < MERGE_HARD_LIMIT;
    let mergedOk = false;
    if (worthMerging) {
      try {
        notify('download_progress', { taskId, phase: 'merge', percent: 50, label: '尝试合并' });
        const mergedBlob = await mergeWithFFmpeg(audioBlob, videoBlob, taskId);
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await downloadFile(mergedBlob, targets.mergedName, targets.mergedDir);
        mergedOk = true;
        notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '合并完成' });
      } catch(mergeError) {
        console.debug('[B站下载助手] 大文件 FFmpeg 合并失败:', mergeError);
        if (signal?.aborted) throw mergeError;
        try { await saveMergeTxt(targets.rawSubdir); } catch(e) {}
        notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '已保存分离文件' });
        note = `内存不足未能自动合并，分离音视频已就绪，请按 merge.txt 说明本地合并`;
      }
    }
    if (!mergedOk && !worthMerging) {
      // 确定性失败区：不浪费一次注定失败的合并尝试，保底文件即最终交付
      try { await saveMergeTxt(targets.rawSubdir); } catch(e) {}
      notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '已保存分离文件' });
      note = `文件较大（${fmtBytesText(audioBlob.size + videoBlob.size)}），已保存分离音视频，请按 merge.txt 说明本地合并`;
    }
    if (mergedOk && !settings.saveRawFiles && rawFileIds) {
      // 合并成功且未开启"保存原始音频和视频文件"→ 删除刚落盘的保底文件
      try {
        for (const id of rawFileIds) {
          if (id) await removeSavedFileViaPage(id);
        }
      } catch(e) {
          console.debug('[B站下载助手] 清理原始文件失败:', e);
      }
    }
    return { note };
  }

  // ─── UI ───
  let currentVideoInfo = null;

  function escAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (!sec) return '';
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function padP(n) { return 'P' + String(n).padStart(2, '0'); }

  function isVideoPage() {
    return /\/video\/BV/.test(location.href) || /\/list\//.test(location.href) || /\/series\//.test(location.href);
  }

  function createUI() {
    if (document.getElementById('bili-dl-root')) return;
    
    const root = document.createElement('div');
    root.id = 'bili-dl-root';
    root.innerHTML = `
      <div id="bili-dl-btn" style="position:fixed;right:20px;bottom:100px;z-index:99999;background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;padding:12px 20px;border-radius:24px;cursor:pointer;font-size:14px;box-shadow:0 4px 16px rgba(0,161,214,0.4);user-select:none;display:${isVideoPage() ? 'flex' : 'none'};align-items:center;gap:8px;transition:transform 0.2s;" onmouseenter="this.style.transform='scale(1.05)'" onmouseleave="this.style.transform='scale(1)'">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 16V4M12 16L8 12M12 16L16 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 20H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        下载
      </div>
      <div id="bili-dl-panel" style="display:none;visibility:hidden;position:fixed;right:20px;bottom:160px;z-index:99999;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);width:380px;max-height:80vh;font-size:14px;color:#333;overflow:hidden;display:flex;flex-direction:column;">
        <div style="background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;">Bilibili 下载助手</span>
          <span id="bili-dl-close" style="cursor:pointer;font-size:18px;opacity:0.8;">&times;</span>
        </div>
        <div id="bili-dl-tabs" style="display:flex;border-bottom:1px solid #f0f0f0;background:#fafafa;">
          <button class="bili-dl-tab active" data-tab="video" style="flex:1;padding:10px 0;border:none;background:none;font-size:13px;font-weight:500;color:#999;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;">视频下载</button>
          <button class="bili-dl-tab" data-tab="collection" style="flex:1;padding:10px 0;border:none;background:none;font-size:13px;font-weight:500;color:#999;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;">合集嗅探</button>
        </div>
        <div id="bili-dl-body" style="padding:16px;flex:1;overflow-y:auto;">
          <div id="bili-dl-loading" style="text-align:center;color:#999;padding:20px;">加载中...</div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    
    // Events
    document.getElementById('bili-dl-btn').addEventListener('click', togglePanel);
    document.getElementById('bili-dl-close').addEventListener('click', hidePanel);
    
    // Click outside to close
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('bili-dl-panel');
      const btn = document.getElementById('bili-dl-btn');
      if (!panel || panel.style.display === 'none') return;
      if (!panel.contains(e.target) && !btn.contains(e.target)) {
        hidePanel();
      }
    });
    
    root.querySelectorAll('.bili-dl-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        root.querySelectorAll('.bili-dl-tab').forEach(t => {
          t.classList.remove('active');
          t.style.color = '#999';
          t.style.borderBottomColor = 'transparent';
        });
        tab.classList.add('active');
        tab.style.color = '#00a1d6';
        tab.style.borderBottomColor = '#00a1d6';
        if (tab.dataset.tab === 'video') showVideoTab();
        else showCollectionTab();
      });
    });
  }

  function togglePanel() {
    const panel = document.getElementById('bili-dl-panel');
    if (!panel) return;
    if (panel.style.display === 'none' || panel.style.visibility === 'hidden') showPanel();
    else hidePanel();
  }

  function hidePanel() {
    const panel = document.getElementById('bili-dl-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.style.visibility = 'hidden';
    }
  }

  async function showPanel() {
    const panel = document.getElementById('bili-dl-panel');
    if (!panel) return;
    panel.style.visibility = 'visible';
    panel.style.display = 'flex';
    
    // Set active tab style
    const tabs = document.querySelectorAll('.bili-dl-tab');
    tabs.forEach(t => {
      t.style.color = '#999';
      t.style.borderBottomColor = 'transparent';
    });
    const activeTab = document.querySelector('.bili-dl-tab.active');
    if (activeTab) {
      activeTab.style.color = '#00a1d6';
      activeTab.style.borderBottomColor = '#00a1d6';
    }
    
    // 根据当前激活的 tab 显示对应内容
    const activeTabName = activeTab?.dataset?.tab || 'video';
    if (activeTabName === 'collection') showCollectionTab();
    else showVideoTab();
  }

  async function showVideoTab() {
    const body = document.getElementById('bili-dl-body');
    
    if (!isVideoPage()) {
      body.innerHTML = '<div style="text-align:center;color:#999;padding:30px 20px;"><div style="font-size:32px;margin-bottom:12px;">📹</div><div style="font-size:15px;color:#333;margin-bottom:8px;">请在视频播放页面使用</div><div style="font-size:12px;color:#999;">打开一个Bilibili视频后，点击下载按钮</div></div>';
      return;
    }
    
    body.innerHTML = '<div id="bili-dl-loading" style="text-align:center;color:#999;padding:20px;">正在获取视频信息...</div>';
    
    try {
      const info = await getVideoInfo();
      if (!info) {
        body.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px;">无法获取视频信息</div>';
        return;
      }
      currentVideoInfo = info;
      
      const data = await getPlayUrl(info.aid, info.bvid, info.cid, 80);
      if (!data?.dash) {
        body.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px;">获取播放地址失败</div>';
        return;
      }
      
      const videoByQ = {};
      data.dash.video.forEach(v => {
        if (!videoByQ[v.id]) videoByQ[v.id] = [];
        videoByQ[v.id].push(v);
      });
      
      const dashDur = data.dash.duration || Math.round((data.timelength || 0) / 1000);
      const options = Object.keys(videoByQ).map(Number).sort((a,b) => b-a).map(q => {
        const streams = videoByQ[q].sort((a,b) => b.bandwidth - a.bandwidth);
        return {
          q, label: QMAP[q] || q+'P',
          videoUrl: streams[0].baseUrl,
          audioUrl: data.dash.audio[0].baseUrl,
          videoSize: dashSize(streams[0], dashDur),
          audioSize: dashSize(data.dash.audio[0], dashDur)
        };
      });
      
      body.innerHTML = `
        <div style="margin-bottom:12px;font-weight:500;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${info.title}">${info.title}</div>
        <div style="margin-bottom:12px;color:#666;font-size:12px;">
          音频: ${fmtSize(options[0].audioSize)} | 视频: ${fmtSize(options[0].videoSize)}
        </div>
        <div style="margin-bottom:16px;">
          ${options.map((o,i) => `
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;padding:8px 12px;border-radius:8px;border:1px solid ${i===0?'#00a1d6':'#e0e0e0'};transition:all 0.2s;" 
              onmouseenter="this.style.borderColor='#00a1d6'" onmouseleave="this.style.borderColor='${i===0?'#00a1d6':'#e0e0e0'}'">
              <input type="radio" name="bili-dl-q" value="${i}" ${i===0?'checked':''} style="accent-color:#00a1d6;">
              <span style="flex:1;">${o.label}</span>
              <span style="color:#999;font-size:12px;">${fmtSize(o.videoSize)}</span>
            </label>
          `).join('')}
        </div>
        <button id="bili-dl-go" style="width:100%;padding:12px;background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s;" onmouseenter="this.style.opacity='0.9'" onmouseleave="this.style.opacity='1'">开始下载</button>
      `;
      
      document.getElementById('bili-dl-go').addEventListener('click', async () => {
        const idx = parseInt(document.querySelector('input[name="bili-dl-q"]:checked')?.value || '0');
        const opt = options[idx];
        
        hidePanel();
        
        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
        notify('ENQUEUE_TASK', {
          task: {
            taskId,
            title: info.title,
            bvid: info.bvid,
            aid: info.aid,
            cid: info.cid,
            quality: opt.label,
            qualityIdx: idx,
            videoSize: opt.videoSize || 0,
            audioSize: opt.audioSize || 0
          }
        });
      });
      
    } catch(e) {
      body.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px;">加载失败: ' + e.message + '</div>';
    }
  }

  async function showCollectionTab() {
    const body = document.getElementById('bili-dl-body');
    body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;margin:0;';
    body.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">正在嗅探合集视频...</div>';

    const tree = await sniffCollection();
    if (!tree || tree.groups.length === 0) {
      body.style.cssText = '';
      body.innerHTML = `<div style="text-align:center;color:#999;padding:20px;">
        <div style="margin-bottom:8px;">未检测到合集/系列视频</div>
        <div style="font-size:12px;color:#bbb;">提示：请在以下页面使用此功能</div>
        <div style="font-size:12px;color:#bbb;">· UP主合集页面（视频右侧有合集列表）</div>
        <div style="font-size:12px;color:#bbb;">· 系列视频页面</div>
        <div style="font-size:12px;color:#bbb;">· 多P视频页面</div>
      </div>`;
      return;
    }

    // 选择状态：每 group 一个槽位；partsKnown=false 组用 checked 表示整视频勾选
    const sel = tree.groups.map(g => ({
      open: false,
      checked: true,
      parts: g.partsKnown ? g.parts.map(() => true) : []
    }));
    const totalParts = tree.groups.reduce((n, g) => n + g.parts.length, 0);

    // 画质档位探测：对第一个可用分P枚举一次，全批统一使用该档位序号
    let options = [];
    probeLoop:
    for (const g of tree.groups) {
      if (!g.partsKnown) continue;
      for (const pt of g.parts) {
        if (!pt.cid) continue;
        try {
          const data = await getPlayUrl(g.aid, g.bvid, pt.cid, 80);
          if (data?.dash) {
            const byQ = {};
            data.dash.video.forEach(v => { (byQ[v.id] = byQ[v.id] || []).push(v); });
            options = Object.keys(byQ).map(Number).sort((a, b) => b - a).map(q => ({
              q, label: QMAP[q] || q + 'P'
            }));
          }
        } catch (e) {}
        break probeLoop;
      }
    }

    const listElRef = () => document.getElementById('bili-dl-video-list');

    function optionsBlock() {
      if (!options.length) return '<span style="font-size:12px;color:#999;">画质：默认最高</span>';
      return '<span style="display:inline-flex;gap:10px;align-items:center;">' + options.map((o, i) =>
        `<label style="cursor:pointer;font-size:12px;color:#333;"><input type="radio" name="bili-dl-q" value="${i}" ${i === 0 ? 'checked' : ''} style="accent-color:#00a1d6;">${o.label}</label>`
      ).join('') + '</span>';
    }

    body.innerHTML = `
      <div style="flex-shrink:0;padding:14px 16px 0 16px;">
        <div style="margin-bottom:10px;font-weight:600;font-size:14px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(tree.collectionName)}">${escAttr(tree.collectionName)}</div>
        <div style="margin-bottom:10px;padding:8px 12px;background:#f5f5f5;border-radius:6px;font-size:12px;color:#666;">
          共 ${tree.groups.length} 个视频 / ${totalParts} 个分P · 已选 <span id="bili-dl-sel-count">-</span> 个分P
        </div>
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label style="cursor:pointer;font-size:12px;color:#00a1d6;white-space:nowrap;">
            <input type="checkbox" id="bili-dl-select-all" checked style="accent-color:#00a1d6;"> 全选
          </label>
          ${optionsBlock()}
        </div>
      </div>
      <div id="bili-dl-video-list" style="flex:1;overflow-y:auto;padding:4px 16px;"></div>
      <div style="flex-shrink:0;padding:12px 16px;border-top:1px solid #f0f0f0;background:#fff;">
        <button id="bili-dl-batch-go" style="width:100%;padding:12px;background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">批量下载</button>
      </div>`;

    function groupBadge(g) {
      return g.partsKnown ? (g.parts.length + 'P') : '整视频';
    }

    function renderTree() {
      listElRef().innerHTML = tree.groups.map((g, gi) => {
        const st = sel[gi];
        const partsWrap = g.partsKnown ? `
          <div class="bili-p-wrap" data-gi="${gi}" style="${st.open ? '' : 'display:none;'}margin-top:3px;padding-left:18px;">
            ${g.parts.length ? g.parts.map((pt, pi) => `
              <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px;border:1px solid #f0f0f0;">
                <input type="checkbox" class="bili-p-check" data-gi="${gi}" data-pi="${pi}" ${st.parts[pi] ? 'checked' : ''} style="accent-color:#00a1d6;">
                <span style="color:#00a1d6;font-size:12px;width:36px;flex-shrink:0;">${padP(pt.p)}</span>
                <span style="flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(pt.title)}">${escAttr(pt.title)}</span>
                ${pt.duration ? `<span style="font-size:11px;color:#bbb;flex-shrink:0;">${fmtDur(pt.duration)}</span>` : ''}
              </label>`).join('') : '<div style="font-size:11px;color:#bbb;padding:4px 12px;">无分P信息</div>'}
          </div>` : '';
        return `
          <div style="margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid #e0e0e0;border-radius:6px;">
              <input type="checkbox" class="bili-g-check" data-gi="${gi}" style="accent-color:#00a1d6;">
              <span class="bili-g-title" data-gi="${gi}" style="flex:1;font-size:13px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(g.title)}">${escAttr(g.title)}</span>
              <span style="font-size:11px;color:#999;flex-shrink:0;">${groupBadge(g)}</span>
              ${g.partsKnown ? `<span class="bili-g-arrow" data-gi="${gi}" style="cursor:pointer;color:#00a1d6;font-size:11px;width:14px;text-align:center;flex-shrink:0;transition:transform 0.15s;">▶</span>` : ''}
            </div>
            ${partsWrap}
          </div>`;
      }).join('');
      bindTreeEvents();
      updateCounts();
    }

    // 父级复选框视觉三态同步（indeterminate 无法用 HTML 表达，须设 property）
    function syncGroupVisual(gi) {
      const cb = listElRef().querySelector(`.bili-g-check[data-gi="${gi}"]`);
      if (!cb) return;
      const st = sel[gi];
      if (!st.parts.length) { cb.checked = st.checked; cb.indeterminate = false; return; }
      const someOn = st.parts.some(Boolean);
      cb.checked = st.parts.every(Boolean);
      cb.indeterminate = someOn && !cb.checked;
    }

    function countSelected() {
      let n = 0;
      tree.groups.forEach((g, gi) => {
        if (!g.partsKnown) { if (sel[gi].checked) n += 1; return; }
        n += sel[gi].parts.filter(Boolean).length;
      });
      return n;
    }

    function updateCounts() {
      const n = countSelected();
      const cnt = document.getElementById('bili-dl-sel-count');
      if (cnt) cnt.textContent = String(n);
      const go = document.getElementById('bili-dl-batch-go');
      go.textContent = n > 0 ? `批量下载 ${n} 个分P` : '请至少选择一个分P';
      go.style.opacity = n > 0 ? '1' : '0.5';
      go.style.pointerEvents = n > 0 ? 'auto' : 'none';
    }

    function toggleOpen(gi) {
      sel[gi].open = !sel[gi].open;
      const wrap = listElRef().querySelector(`.bili-p-wrap[data-gi="${gi}"]`);
      if (wrap) wrap.style.display = sel[gi].open ? '' : 'none';
      const ar = listElRef().querySelector(`.bili-g-arrow[data-gi="${gi}"]`);
      if (ar) ar.style.transform = sel[gi].open ? 'rotate(90deg)' : '';
    }

    function bindTreeEvents() {
      document.getElementById('bili-dl-select-all').onchange = (e) => {
        sel.forEach(s => {
          s.checked = e.target.checked;
          if (s.parts.length) s.parts = s.parts.map(() => e.target.checked);
        });
        renderTree();
      };
      listElRef().querySelectorAll('.bili-g-check').forEach(cb => {
        const gi = +cb.dataset.gi;
        syncGroupVisual(gi);
        cb.onchange = () => {
          sel[gi].checked = cb.checked;
          sel[gi].parts = sel[gi].parts.map(() => cb.checked);
          updateCounts();
        };
      });
      listElRef().querySelectorAll('.bili-p-check').forEach(cb => {
        cb.onchange = () => {
          sel[+cb.dataset.gi].parts[+cb.dataset.pi] = cb.checked;
          syncGroupVisual(+cb.dataset.gi);
          updateCounts();
        };
      });
      listElRef().querySelectorAll('.bili-g-title,.bili-g-arrow').forEach(el => {
        el.onclick = () => toggleOpen(+el.dataset.gi);
      });
      document.getElementById('bili-dl-batch-go').onclick = onBatchGo;
    }

    async function onBatchGo() {
      const qIdx = parseInt(document.querySelector('input[name="bili-dl-q"]:checked')?.value || '0');
      const qualityLabel = options[qIdx]?.label || '';

      const directUnits = [];
      const expandGroups = [];
      tree.groups.forEach((g, gi) => {
        if (!g.partsKnown) {
          if (sel[gi].checked) expandGroups.push(g);
          return;
        }
        g.parts.forEach((pt, pi) => {
          if (sel[gi].parts[pi] && pt.cid) directUnits.push({ g, pt });
        });
      });

      hidePanel();

      // 单P 视频（partCount===1）不建视频名子目录：文件直接以视频名落合集目录；
      // 多P 保持 合集/视频名/Pn_分P名 三级结构（resolveOutputTargets 按 dir/baseName 解析）
      const mkTask = (g, aid, cid, partTitle, pn, partCount) => {
        const flat = partCount === 1;
        return {
          taskId: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          aid, bvid: g.bvid, cid,
          title: `${g.title} | ${pn} ${partTitle}`,
          qualityIdx: qIdx,
          quality: qualityLabel,
          dir: flat ? tree.collectionName : `${tree.collectionName}/${g.title}`,
          baseName: flat ? g.title : `${pn}_${partTitle}`
        };
      };

      const taskItems = directUnits.map(u => mkTask(u.g, u.g.aid, u.pt.cid, u.pt.title, padP(u.pt.p), u.g.parts.length));

      // DOM 兜底组：入队前拉取视频详情展开其全部分P（spec §4.1 第 4 优先级）
      for (const g of expandGroups) {
        try {
          const info = await getVideoInfoByBvid(g.bvid);
          if (!info) continue;
          const pages = (Array.isArray(info.pages) && info.pages.length > 0)
            ? info.pages
            : [{ page: 1, part: '', cid: info.cid }];
          for (const pg of pages) {
            taskItems.push(mkTask(g, info.aid, pg.cid, pg.part || '', padP(pg.page || 1), pages.length));
          }
        } catch (e) {
          console.debug('[B站下载助手] 兜底组解析失败:', g.bvid, e);
        }
      }

      if (taskItems.length === 0) {
        alert('无法获取所选内容的下载信息');
        return;
      }

      notify('ENQUEUE_TASKS', { tasks: taskItems });

      // 异步补全各分P体积（沿用 UPDATE_TASK_SIZE 既有链路；单个失败静默跳过，执行期 quality 上报兜底）
      (async () => {
        for (const it of taskItems) {
          try {
            const d = await getPlayUrl(it.aid, it.bvid, it.cid, 80);
            if (!d?.dash) continue;
            const byQ = {};
            d.dash.video.forEach(v => { (byQ[v.id] = byQ[v.id] || []).push(v); });
            const topQ = Object.keys(byQ).map(Number).sort((a, b) => b - a)[0];
            const topVideo = byQ[topQ].sort((a, b) => b.bandwidth - a.bandwidth)[0];
            const dur = d.dash.duration || Math.round((d.timelength || 0) / 1000);
            notify('UPDATE_TASK_SIZE', {
              taskId: it.taskId,
              videoSize: dashSize(topVideo, dur),
              audioSize: dashSize(d.dash.audio[0], dur)
            });
          } catch (e) {
            console.debug('[B站下载助手] 补全任务体积失败:', it.title, e);
          }
        }
      })();
    }

    renderTree();
  }

  // ─── Init ───
  function waitAndInit() {
    if (document.body) {
      if (isVideoPage()) setTimeout(createUI, 3000);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (isVideoPage()) setTimeout(createUI, 3000);
      });
    }
    
    const startObserver = () => {
      if (!document.body) return;
      let lastUrl = location.href;
      new MutationObserver(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          const el = document.getElementById('bili-dl-root');
          if (el) el.remove();
          currentVideoInfo = null;
          if (isVideoPage()) {
            setTimeout(createUI, 3000);
          }
        }
      }).observe(document.body, {childList:true, subtree:true});
    };
    
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener('DOMContentLoaded', startObserver);
    }
  }
  
  waitAndInit();

  // 通知隔离世界的 content.js 本页面已就绪（RUN_TASK 可安全派发，避免宿主 tab 兜底丢消息）
  window.postMessage({ source: 'bilibili-downloader', type: 'PAGE_READY' }, '*');

  console.log('[B站下载助手] Page script loaded');
})();
