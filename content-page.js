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

  // ─── API Helpers ───
  async function fetchPageHTML(url) {
    const r = await fetch(url || location.href, {credentials:'include'});
    return r.text();
  }

  function parseInitialState(html) {
    let m = html.match(/<script>window\.__INITIAL_STATE__=(.+?)<\/script>/);
    if (m && m[1]) {
      try {
        let s = m[1].replace(/;\(function\(\)\{.*?\}\(\)\);?$/, '');
        const st = JSON.parse(s);
        if (st.videoData) return st.videoData;
      } catch(e) {}
    }
    return null;
  }

  async function getVideoInfo(url) {
    const html = await fetchPageHTML(url);
    const vd = parseInitialState(html);
    if (!vd) return null;
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
      console.warn('[B站下载助手] getVideoInfoByBvid error:', bvid, e);
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
    const videos = [];
    const seen = new Set();
    let collectionName = '';
    
    // Extract from __INITIAL_STATE__
    try {
      const html = await fetchPageHTML();
      const stateMatch = html.match(/<script>window\.__INITIAL_STATE__=(.+?)<\/script>/);
      if (stateMatch && stateMatch[1]) {
        let stateStr = stateMatch[1].replace(/;\(function\(\)\{.*?\}\(\)\);?$/, '');
        const state = JSON.parse(stateStr);
        
        // Extract collection name from multiple possible locations
        if (state.ugc_season?.title) {
          collectionName = state.ugc_season.title;
        } else if (state.collection?.title) {
          collectionName = state.collection.title;
        } else if (state.series?.title) {
          collectionName = state.series.title;
        } else if (state.title && state.sections) {
          // Direct top-level with sections = collection page
          collectionName = state.title;
        }
        
        // Extract videos from ugc_season
        if (state.ugc_season?.section) {
          state.ugc_season.section.forEach(section => {
            (section.episodes || []).forEach(ep => {
              const bvid = ep.bvid;
              if (bvid && !seen.has(bvid)) {
                seen.add(bvid);
                videos.push({
                  bvid,
                  title: ep.title || ep.arc?.title || '',
                  aid: ep.aid || ep.arc?.aid,
                  cid: ep.cid,
                  url: `https://www.bilibili.com/video/${bvid}`
                });
              }
            });
          });
        }
        
        // Multi-page video
        if (state.videoData?.pages && state.videoData.pages.length > 1) {
          if (!collectionName) collectionName = state.videoData.title || '';
          state.videoData.pages.forEach(p => {
            const bvid = state.videoData.bvid;
            if (!seen.has(bvid + '_p' + p.page)) {
              seen.add(bvid + '_p' + p.page);
              videos.push({
                bvid,
                title: `P${p.page} ${p.part || ''}`,
                aid: state.videoData.aid,
                cid: p.cid,
                url: `https://www.bilibili.com/video/${bvid}?p=${p.page}`
              });
            }
          });
        }
      }
    } catch(e) {
      console.warn('[B站下载助手] __INITIAL_STATE__ parse error:', e);
    }
    
    // DOM fallback: data-key attributes
    if (videos.length === 0) {
      const items = document.querySelectorAll('[data-key^="BV"]');
      items.forEach(item => {
        const bvid = item.getAttribute('data-key');
        if (!bvid || seen.has(bvid)) return;
        seen.add(bvid);
        const titleEl = item.querySelector('.title-txt') || item.querySelector('[class*="title"]');
        const title = titleEl?.textContent?.trim() || '';
        if (title) {
          videos.push({ bvid, title, url: `https://www.bilibili.com/video/${bvid}` });
        }
      });
    }
    
    // Fallback collection name
    if (!collectionName && videos.length > 0) {
      collectionName = document.title?.replace(/- Bilibili.*$/, '').replace(/_哔哩哔哩.*$/, '').trim() || '合集下载';
    }
    
    console.log('[B站下载助手] Sniffed videos:', videos.length, 'collection:', collectionName);
    return { videos, collectionName };
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
  async function downloadBlob(url, taskId, phase, label, signal) {
    const r = await fetchWithTimeout(url, {}, 60000, signal);
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    
    const total = parseInt(r.headers.get('content-length') || '0');
    const reader = r.body.getReader();
    const chunks = [];
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
      
      const percent = total > 0 ? Math.round(received / total * 100) : -1;
      if (percent !== lastSent) {
        lastSent = percent;
        notify('download_progress', {
          taskId, phase, percent,
          received, total,
          label
        });
      }
    }
    
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Blob(chunks);
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
      console.warn('[B站下载助手] SAVE_BLOB 失败，回退到 <a download>:', e);
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
   * 保存原始音频/视频文件到子目录
   * @param {Blob} audioBlob - 音频数据
   * @param {Blob} videoBlob - 视频数据
   * @param {string} title - 视频标题（用于子目录名）
   */
  async function saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir) {
    const safeTitle = sanitizeFilename(title);
    // MIME 用 video/mp4 且文件名用 .mp4：B 站 dash 流本身是 fMP4 容器，
    // 若命名为 .m4s，Chrome 会按内容类型把扩展名改写成 .mp4
    // 用 slice 改 MIME（引用共享零拷贝）；禁止 arrayBuffer() 全量拷贝（大文件 OOM）
    const audioForSave = audioBlob.slice(0, audioBlob.size, 'video/mp4');
    const videoForSave = videoBlob.slice(0, videoBlob.size, 'video/mp4');

    const subdir = baseSubdir ? baseSubdir + '/' + safeTitle : safeTitle;
    const audioId = await saveBlobViaDownloads(audioForSave, 'audio.mp4', subdir);
    const videoId = await saveBlobViaDownloads(videoForSave, 'video.mp4', subdir);
    console.log('[B站下载助手] 原始文件已保存到子目录:', subdir);
    return [audioId, videoId]; // downloadId 列表，供合并成功后按设置删除
  }

  /**
   * 保存 merge.txt 合并说明到子目录（仅在 FFmpeg 合并失败时调用）
   * @param {string} title - 视频标题
   * @param {string} baseSubdir - 基础子目录
   */
  async function saveMergeTxt(title, baseSubdir) {
    const safeTitle = sanitizeFilename(title);
    const subdir = baseSubdir ? baseSubdir + '/' + safeTitle : safeTitle;
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
    await saveBlobViaDownloads(blob, 'merge.txt', subdir);
    console.log('[B站下载助手] merge.txt 已保存到子目录:', subdir);
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
    const merged = await ffmpeg.readFile(outputPath);

    // 清理临时文件
    ffmpeg.deleteFile(audioPath).catch(() => {});
    ffmpeg.deleteFile(videoPath).catch(() => {});
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
        console.error('[B站下载助手] Task failed:', taskId, e);
        notify('TASK_ERROR', { taskId, error: e.message });
      }
    } finally {
      activeTaskControllers.delete(taskId);
    }
  }

  // ─── Execute a single download ───
  async function executeDownload(taskId, videoInfo, qualityIdx, signal) {
    const title = videoInfo.title;
    const settings = await fetchSettings();
    
    const data = await getPlayUrl(videoInfo.aid, videoInfo.bvid, videoInfo.cid, 80, signal);
    if (!data?.dash) {
      console.error('[B站下载助手] getPlayUrl returned null or no dash:', data);
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
      downloadBlob(bestAudio.baseUrl, taskId, 'audio', '音频', signal),
      downloadBlob(bestVideo.baseUrl, taskId, 'video', '视频', signal)
    ]);
    
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    
    notify('download_progress', { taskId, phase: 'download', percent: 100, label: '下载完成' });
    // 用真实字节数修正任务卡片的合计容量（入队时的值为估算）
    notify('download_progress', { taskId, phase: 'quality', percent: 0, totalSize: audioBlob.size + videoBlob.size });

    const safeTitle = sanitizeFilename(title);
    const baseSubdir = DOWNLOAD_BASE;
    let rawSaved = false;
    let rawFileIds = null;

    // 如果开启了保存原始文件，先保存
    if (settings.saveRawFiles) {
      try {
        notify('download_progress', { taskId, phase: 'merge', percent: 0, label: '保存原始文件' });
        rawFileIds = await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir);
        rawSaved = true;
      } catch(e) {
        console.warn('[B站下载助手] 保存原始文件失败:', e);
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
        await downloadFile(mergedBlob, `${safeTitle}_${label}.mp4`, baseSubdir);
        notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '合并完成' });
      } catch(mergeError) {
        console.error('[B站下载助手] FFmpeg 合并失败:', mergeError);
        if (signal?.aborted) throw mergeError;
        // 合并执行失败：降级为分离保存，任务正常完成
        if (!rawSaved) {
          try {
            await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir);
            rawSaved = true;
          } catch(e) {
            console.error('[B站下载助手] 兜底保存原始文件也失败:', e);
          }
        }
        try { await saveMergeTxt(title, baseSubdir); } catch(e) {}
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
        rawFileIds = await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir);
        rawSaved = true;
      } catch(e) {
        console.error('[B站下载助手] 分离文件保存失败:', e);
      }
    }
    if (!rawSaved) throw new Error(`分离文件保存失败（文件 ${fmtBytesText(audioBlob.size + videoBlob.size)}）`);

    let mergedOk = false;
    try {
      notify('download_progress', { taskId, phase: 'merge', percent: 50, label: '尝试合并' });
      const mergedBlob = await mergeWithFFmpeg(audioBlob, videoBlob, taskId);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      await downloadFile(mergedBlob, `${safeTitle}_${label}.mp4`, baseSubdir);
      mergedOk = true;
      notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '合并完成' });
    } catch(mergeError) {
      console.error('[B站下载助手] 大文件 FFmpeg 合并失败:', mergeError);
      if (signal?.aborted) throw mergeError;
      try { await saveMergeTxt(title, baseSubdir); } catch(e) {}
      notify('download_progress', { taskId, phase: 'merge', percent: 100, label: '已保存分离文件' });
      note = `内存不足未能自动合并，分离音视频已就绪，请按 merge.txt 说明本地合并`;
    }
    if (mergedOk && !settings.saveRawFiles && rawFileIds) {
      // 合并成功且未开启"保存原始音频和视频文件"→ 删除刚落盘的保底文件
      try {
        for (const id of rawFileIds) {
          if (id) await removeSavedFileViaPage(id);
        }
      } catch(e) {
        console.warn('[B站下载助手] 清理原始文件失败:', e);
      }
    }
    return { note };
  }

  // ─── UI ───
  let currentVideoInfo = null;
  let currentCollectionVideos = [];

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
    body.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">正在嗅探合集视频...</div>';
    
    try {
      const { videos, collectionName } = await sniffCollection();
      currentCollectionVideos = videos;
      
      if (videos.length === 0) {
        body.innerHTML = `<div style="text-align:center;color:#999;padding:20px;">
          <div style="margin-bottom:8px;">未检测到合集/系列视频</div>
          <div style="font-size:12px;color:#bbb;">提示：请在以下页面使用此功能</div>
          <div style="font-size:12px;color:#bbb;">· UP主合集页面（视频右侧有合集列表）</div>
          <div style="font-size:12px;color:#bbb;">· 系列视频页面</div>
          <div style="font-size:12px;color:#bbb;">· 多P视频页面</div>
        </div>`;
        return;
      }
      
      body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;margin:0;';
      body.innerHTML = `
        <div style="flex-shrink:0;padding:16px 16px 0 16px;">
        <div style="margin-bottom:12px;padding:8px 12px;background:#f5f5f5;border-radius:6px;font-size:12px;color:#666;">
          合集: <span style="color:#00a1d6;font-weight:500;">${collectionName}</span> (${videos.length}个视频)
        </div>
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:500;">选择下载视频</span>
          <label style="cursor:pointer;font-size:12px;color:#00a1d6;">
            <input type="checkbox" id="bili-dl-select-all" checked> 全选
          </label>
        </div>
        </div>
        <div id="bili-dl-video-list" style="flex:1;overflow-y:auto;padding:0 16px;">
          ${videos.map((v, i) => `
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;cursor:pointer;border:1px solid #e0e0e0;margin-bottom:4px;transition:border-color 0.2s;"
              onmouseenter="this.style.borderColor='#00a1d6'" onmouseleave="this.style.borderColor='#e0e0e0'">
              <input type="checkbox" class="bili-dl-video-check" value="${i}" checked style="accent-color:#00a1d6;">
              <span style="flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${v.title}">${v.title}</span>
            </label>
          `).join('')}
        </div>
        <div style="flex-shrink:0;padding:12px 16px;border-top:1px solid #f0f0f0;background:#fff;">
          <button id="bili-dl-batch-go" style="width:100%;padding:12px;background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">批量下载选中视频</button>
        </div>
      `;
      
      
      document.getElementById('bili-dl-select-all').addEventListener('change', (e) => {
        document.querySelectorAll('.bili-dl-video-check').forEach(cb => cb.checked = e.target.checked);
      });
      
      document.getElementById('bili-dl-batch-go').addEventListener('click', async () => {
        const checked = [...document.querySelectorAll('.bili-dl-video-check:checked')].map(cb => parseInt(cb.value));
        const selected = checked.map(i => videos[i]).filter(Boolean);
        
        if (selected.length === 0) {
          alert('请至少选择一个视频');
          return;
        }
        
        console.log('[B站下载助手] Batch starting, selected:', selected.length, 'collection:', collectionName);
        hidePanel();
        
        // Step 1: Fetch all video infos
        const taskInfos = [];
        for (const v of selected) {
          try {
            let info;
            if (v.aid && v.cid) {
              info = { aid: v.aid, bvid: v.bvid, cid: v.cid, title: v.title };
            } else if (v.bvid) {
              info = await getVideoInfoByBvid(v.bvid);
            }
            if (info) {
              const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
              taskInfos.push({ ...info, taskId });
            } else {
              console.warn('[B站下载助手] Could not get info for:', v.bvid);
            }
          } catch(e) {
            console.error('[B站下载助手] Fetch info error:', v.title, e);
          }
        }
        
        if (taskInfos.length === 0) {
          alert('无法获取任何视频信息');
          return;
        }
        
        // Step 2: Enqueue all tasks to background queue (background dispatches one by one)
        notify('ENQUEUE_TASKS', {
          tasks: taskInfos.map(info => ({
            taskId: info.taskId,
            title: info.title,
            bvid: info.bvid,
            aid: info.aid,
            cid: info.cid,
            quality: '等待中',
            qualityIdx: 0
          }))
        });
        console.log('[B站下载助手] Enqueued', taskInfos.length, 'tasks to background queue');

        // 异步补全各任务合计体积：不阻塞入队，单个失败静默跳过（执行期 quality 上报兜底）
        (async () => {
          for (const info of taskInfos) {
            try {
              const d = await getPlayUrl(info.aid, info.bvid, info.cid, 80);
              if (!d?.dash) continue;
              const byQ = {};
              d.dash.video.forEach(v => {
                if (!byQ[v.id]) byQ[v.id] = [];
                byQ[v.id].push(v);
              });
              const topQ = Object.keys(byQ).map(Number).sort((a,b) => b-a)[0];
              const topVideo = byQ[topQ].sort((a,b) => b.bandwidth - a.bandwidth)[0];
              const dur = d.dash.duration || Math.round((d.timelength || 0) / 1000);
              notify('UPDATE_TASK_SIZE', {
                taskId: info.taskId,
                videoSize: dashSize(topVideo, dur),
                audioSize: dashSize(d.dash.audio[0], dur)
              });
            } catch(e) {
              console.warn('[B站下载助手] 补全任务体积失败:', info.title, e);
            }
          }
        })();
      });
      
    } catch(e) {
      body.innerHTML = '<div style="text-align:center;color:#f44336;padding:20px;">嗅探失败: ' + e.message + '</div>';
    }
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
          currentCollectionVideos = [];
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
