# Task 2: offscreen.html + offscreen.js — offscreen 下载执行器

**Files:**
- Modify: `offscreen.html`（script 改 type=module）
- Rewrite: `offscreen.js`（保留原 FFmpeg 合并 handler，新增下载执行引擎）

**Interfaces:**
- Consumes: `lib/download-core.js` 的 `executeTask`（Task 1 已创建，导出 `executeTask(taskId, videoInfo, qualityIdx, deps)`，deps = `{ getSettings, getFFmpeg, notify, saveBlob, signal }`）
- Produces:
  - 消息处理：`OFFSCREEN_PING` → `sendResponse({status:'ok'})`；`OFFSCREEN_RUN_TASK`（data: taskId/videoInfo/qualityIdx）；`OFFSCREEN_ABORT_TASK`（data: taskId）
  - 消息回报（chrome.runtime.sendMessage 发出）：
    - `OFFSCREEN_PROGRESS` data: `{ taskId, phase, percent, label }`
    - `OFFSCREEN_TASK_DONE` / `OFFSCREEN_TASK_ERROR`(含 error) / `OFFSCREEN_TASK_ABORTED` / `OFFSCREEN_NEEDS_PAGE`，均 data: `{ taskId[, error] }`
  - 保留原 `offscreen_merge_request` / `offscreen_merge_result` handler（一字不改）

- [ ] **Step 1: 修改 `offscreen.html`**

将 `<script src="offscreen.js"></script>` 改为：

```html
<script type="module" src="offscreen.js"></script>
```

- [ ] **Step 2: 重写 `offscreen.js`**

完整内容如下（原 offscreen_merge_request 逻辑保留，追加下载执行引擎）：

```js
// offscreen.js - 后台下载执行（主）+ FFmpeg 合并（保留）
import { executeTask } from './lib/download-core.js';

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

async function toBlobURL(resourceURL, mimeType) {
  const res = await fetch(resourceURL);
  if (!res.ok) throw new Error('fetch 失败: ' + resourceURL + ' HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

async function createFFmpeg() {
  if (ffmpegBridge?.ready) return ffmpegBridge;

  const workerBlobURL = await toBlobURL(chrome.runtime.getURL('lib/ffmpeg.worker.js'), 'text/javascript');
  const worker = new Worker(workerBlobURL);
  ffmpegBridge = new FFmpegBridge(worker);

  ffmpegBridge.on('log', ({ message }) => {
    if (message) console.log('[FFmpeg Offscreen]', message);
  });

  await ffmpegBridge.load({
    coreURL: await toBlobURL(chrome.runtime.getURL('lib/ffmpeg-core.js'), 'text/javascript'),
    wasmURL: await toBlobURL(chrome.runtime.getURL('lib/ffmpeg-core.wasm'), 'application/wasm'),
    workerURL: await toBlobURL(chrome.runtime.getURL('lib/ffmpeg-core.worker.js'), 'text/javascript')
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
  const buffer = await blob.arrayBuffer();
  const blobUrl = URL.createObjectURL(new Blob([buffer], { type: blob.type || 'application/octet-stream' }));
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SAVE_FILE',
      data: { url: blobUrl, path: subdir ? subdir + '/' + filename : filename }
    });
    if (!result?.success) throw new Error(result?.error || '保存失败');
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  }
}

async function runOffscreenTask(taskId, videoInfo, qualityIdx) {
  const controller = new AbortController();
  activeTaskControllers.set(taskId, controller);
  try {
    await executeTask(taskId, videoInfo, qualityIdx, {
      getSettings,
      getFFmpeg: createFFmpeg,
      notify: (payload) => notify(taskId, payload),
      saveBlob,
      signal: controller.signal
    });
    sendToBg({ type: 'OFFSCREEN_TASK_DONE', data: { taskId } });
  } catch (e) {
    if (controller.signal.aborted) {
      sendToBg({ type: 'OFFSCREEN_TASK_ABORTED', data: { taskId } });
    } else if (e.code === 'NEEDS_PAGE') {
      sendToBg({ type: 'OFFSCREEN_NEEDS_PAGE', data: { taskId } });
    } else {
      console.error('[B站下载助手] Offscreen task failed:', taskId, e);
      sendToBg({ type: 'OFFSCREEN_TASK_ERROR', data: { taskId, error: e.message } });
    }
  } finally {
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
    return false;
  }

  if (message.type === 'OFFSCREEN_ABORT_TASK') {
    const c = activeTaskControllers.get((message.data || {}).taskId);
    if (c) { try { c.abort(); } catch (e) {} }
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
```

- [ ] **Step 3: 语法检查**

因 PowerShell 5.1 管道会以 GBK 编码损坏中文（已知环境问题），使用 UTF-8 安全管道：

```powershell
$OutputEncoding = [System.Text.Encoding]::UTF8
[System.IO.File]::ReadAllText('offscreen.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
```

Expected: 无输出，exit code 0
（同时用相同命令检查 `offscreen.html` 之外无 JS 文件；html 改动无语法可查，人工确认 `<script type="module" src="offscreen.js"></script>`）

- [ ] **Step 4: Commit**

```bash
git add offscreen.html offscreen.js
git commit -m "feat(download): offscreen 新增后台下载执行器，监听 OFFSCREEN_RUN_TASK"
```
