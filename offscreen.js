// offscreen.js - 后台下载执行（主）+ FFmpeg 合并（保留）
import { executeTask, cleanupOPFS, cleanupOrphanOpfsParts } from './lib/download-core.js';

// ─── FFmpeg 合并（原有，依赖 lib/ffmpeg.js + FFmpegWASM 全局）───
let ffmpegInstance = null;
let loadPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load: ' + url));
    document.head.appendChild(script);
  });
}

async function loadFFmpeg() {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const extUrl = (path) => chrome.runtime.getURL(path);

    console.log('[FFmpeg Offscreen] Loading ffmpeg.js via script tag...');
    await loadScript(extUrl('lib/ffmpeg.js'));

    const FFmpegClass = self.FFmpegWASM?.FFmpeg || self.FFmpegWASM;
    if (!FFmpegClass) {
      throw new Error('FFmpeg constructor not found. self.FFmpegWASM=' + typeof self.FFmpegWASM);
    }

    ffmpegInstance = new FFmpegClass();

    console.log('[FFmpeg Offscreen] Loading wasm core...');
    await ffmpegInstance.load({
      coreURL: extUrl('lib/ffmpeg-core.js'),
      wasmURL: extUrl('lib/ffmpeg-core.wasm'),
      workerURL: extUrl('lib/ffmpeg-core.worker.js')
    });

    console.log('[FFmpeg Offscreen] Loaded successfully');
    return ffmpegInstance;
  })();

  return loadPromise;
}

function openMergeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('BiliMergeData', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readBlobFromDB(key) {
  const db = await openMergeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlobFromDB(key) {
  const db = await openMergeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const req = tx.objectStore('blobs').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function mergeWithFFmpeg(taskId) {
  const ffmpeg = await loadFFmpeg();

  const audioBuf = await readBlobFromDB(taskId + '_audio');
  const videoBuf = await readBlobFromDB(taskId + '_video');
  
  if (!audioBuf || !videoBuf) {
    throw new Error('Audio or video data not found in IndexedDB for task: ' + taskId);
  }

  console.log('[FFmpeg Offscreen] Read from DB, audio:', audioBuf.byteLength, 'video:', videoBuf.byteLength);
  await ffmpeg.writeFile('audio.m4s', new Uint8Array(audioBuf));
  await ffmpeg.writeFile('video.m4s', new Uint8Array(videoBuf));

  console.log('[FFmpeg Offscreen] Running merge...');
  await ffmpeg.exec(['-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4']);

  const result = await ffmpeg.readFile('output.mp4');
  console.log('[FFmpeg Offscreen] Merge done, output size:', result.length);

  await ffmpeg.deleteFile('audio.m4s');
  await ffmpeg.deleteFile('video.m4s');
  await ffmpeg.deleteFile('output.mp4');

  await deleteBlobFromDB(taskId + '_audio');
  await deleteBlobFromDB(taskId + '_video');

  return result.buffer;
}

// ─── 下载执行引擎（FFmpegBridge，Blob URL Worker）───
const Op = {
  LOAD: 'LOAD', EXEC: 'EXEC',
  WRITE_FILE: 'WRITE_FILE', READ_FILE: 'READ_FILE',
  DELETE_FILE: 'DELETE_FILE',
  ERROR: 'ERROR', LOG: 'LOG', PROGRESS: 'PROGRESS'
};
const RESULT_OPS = new Set([Op.LOAD, Op.EXEC, Op.WRITE_FILE, Op.READ_FILE, Op.DELETE_FILE]);

let nextMsgId = 0;

class FFmpegBridge {
  #worker = null;
  #pending = {};
  #logHandlers = [];
  #progressHandlers = [];
  ready = false;

  constructor(worker) {
    this.#worker = worker;
    this.#attachReceiver();
    this.#worker.onerror = (e) => {
      const err = new Error('FFmpeg worker 错误: ' + (e && e.message ? e.message : 'unknown'));
      const pending = this.#pending;
      this.#pending = {};
      Object.values(pending).forEach(p => p.reject(err));
      this.ready = false;
    };
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

let ffmpegBridge = null;

// offscreen 是扩展上下文（origin 为 chrome-extension://），可直接用扩展 URL 创建 Worker
// 与加载 ffmpeg-core（同源，'self' 即允许），无需 blob: URL（MV3 CSP 禁止 blob: worker）
async function createFFmpeg() {
  if (ffmpegBridge?.ready) return ffmpegBridge;

  const worker = new Worker(chrome.runtime.getURL('lib/ffmpeg.worker.js'));
  ffmpegBridge = new FFmpegBridge(worker);

  ffmpegBridge.on('log', ({ message }) => {
    if (message) console.log('[FFmpeg Offscreen]', message);
  });

  await ffmpegBridge.load({
    coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
    workerURL: chrome.runtime.getURL('lib/ffmpeg-core.worker.js')
  });

  console.log('[B站下载助手] offscreen FFmpeg WASM 初始化完成');
  return ffmpegBridge;
}

// ─── 后台任务执行 ───
const activeTaskControllers = new Map();

function sendToBg(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function notify(taskId, payload) {
  sendToBg({ type: 'OFFSCREEN_PROGRESS', data: { taskId, ...payload } });
}

async function getSettings() {
  try {
    return (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) || {};
  } catch (e) {
    return {};
  }
}

async function saveBlob(blob, filename, subdir) {
  // 直接对 Blob/File 建 URL：不再 arrayBuffer() 整份拷入内存（大文件会 OOM）
  const blobUrl = URL.createObjectURL(blob);
  try {
    // SAVE_FILE 在下载终态（complete/interrupted）后才响应，此时数据源不再被引用，
    // 可安全立即回收；不能提前 revoke，否则大文件尚未从 blob URL 拷完即中断
    const result = await chrome.runtime.sendMessage({
      type: 'SAVE_FILE',
      data: { url: blobUrl, path: subdir ? subdir + '/' + filename : filename }
    });
    if (!result?.success) throw new Error(result?.error || '保存失败');
    return result.downloadId || null; // 供"合并成功后按设置删除原始文件"使用
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// 删除已通过 chrome.downloads 落盘的原始文件（仅删文件，不清理下载历史记录）
async function removeSavedFile(downloadId) {
  const result = await chrome.runtime.sendMessage({
    type: 'DELETE_SAVED_FILE',
    data: { downloadId }
  });
  if (!result?.success) throw new Error(result?.error || '删除原始文件失败');
}

async function runOffscreenTask(taskId, videoInfo, qualityIdx) {
  const controller = new AbortController();
  activeTaskControllers.set(taskId, controller);
  // 保活心跳：任务执行期间每 15s 唤醒 SW，防止 SW 因无活动休眠而连带销毁 offscreen document
  // （offscreen 与 SW 生命周期绑定，SW 终止则 offscreen 关闭，正在执行的任务会中断且无回报）。
  // 心跳不更新 lastProgressAt，与停滞检测解耦——任务真卡住时仍会被 5 分钟停滞检测兜底。
  const keepalive = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_HEARTBEAT', data: { taskId } }).catch(() => {});
  }, 15000);
  try {
    await executeTask(taskId, videoInfo, qualityIdx, {
      getSettings,
      getFFmpeg: createFFmpeg,
      notify: (payload) => notify(taskId, payload),
      saveBlob,
      removeSavedFile,
      signal: controller.signal
    }).then((result) => {
      sendToBg({ type: 'OFFSCREEN_TASK_DONE', data: { taskId, note: result?.note || '' } });
    });
  } catch (e) {
    if (controller.signal.aborted) {
      sendToBg({ type: 'OFFSCREEN_TASK_ABORTED', data: { taskId } });
    } else if (e.code === 'NEEDS_PAGE') {
      sendToBg({ type: 'OFFSCREEN_NEEDS_PAGE', data: { taskId } });
    } else {
      // 预期内的任务失败已通过 OFFSCREEN_TASK_ERROR 上报，用 debug 级避免刷爆扩展错误日志
      console.debug('[B站下载助手] Offscreen task failed:', taskId, e);
      sendToBg({ type: 'OFFSCREEN_TASK_ERROR', data: { taskId, error: e.message } });
    }
  } finally {
    clearInterval(keepalive);
    activeTaskControllers.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_PING') {
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'OFFSCREEN_RUN_TASK') {
    const { taskId, videoInfo, qualityIdx } = message.data || {};
    if (taskId && videoInfo) runOffscreenTask(taskId, videoInfo, qualityIdx || 0);
    // 必须同步回受理应答：pumpQueue 对此消息 await sendMessage，
    // 监听者存在却无人 sendResponse 时 MV3 Promise 必然 reject，
    // 发送方会误判派发失败而走宿主 tab 兜底（误开 B 站首页）。
    // 任务结果经 OFFSCREEN_TASK_DONE/ERROR/ABORTED/NEEDS_PAGE 异步上报。
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'OFFSCREEN_ABORT_TASK') {
    const c = activeTaskControllers.get((message.data || {}).taskId);
    if (c) { try { c.abort(); } catch (e) {} }
    return false;
  }

  if (message.type === 'OFFSCREEN_CLEANUP_OPFS') {
    // 任务删除：清理其 OPFS 半成品（best-effort，无需等待完成）
    const ids = message.data?.taskIds || [];
    cleanupOPFS(ids.flatMap(id => [id + '_audio', id + '_video']));
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'OFFSCREEN_CLEANUP_OPFS_EXCEPT') {
    // 孤儿对账：清理不属于任何现存任务的半成品
    cleanupOrphanOpfsParts(new Set(message.data?.keepPrefixes || []));
    sendResponse({ status: 'ok' });
    return false;
  }

  if (message.type === 'offscreen_merge_request') {
    const { taskId } = message.data;

    console.log('[FFmpeg Offscreen] Merge request for task:', taskId);

    mergeWithFFmpeg(taskId)
      .then(merged => {
        console.log('[FFmpeg Offscreen] Merge success, sending result back');
        chrome.runtime.sendMessage({
          type: 'offscreen_merge_result',
          data: { taskId, success: true, buffer: merged }
        });
      })
      .catch(e => {
        console.error('[FFmpeg Offscreen] Merge failed:', e);
        chrome.runtime.sendMessage({
          type: 'offscreen_merge_result',
          data: { taskId, success: false, error: e.message }
        });
      });

    return false;
  }

  return false;
});
