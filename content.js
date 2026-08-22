// content.js - Bridge between page context and extension
(function() {
  let pageReady = false; // 页面世界的 content-page.js 是否已加载（宿主 tab 就绪判据）

  // 合集解析器（ESM）：以 module 方式注入页面世界，执行后挂 window.BiliCollectionParser。
  // 模块脚本为异步加载，与下方经典脚本的先后顺序不保证，消费方以轮询等待兜底（同 ffmpeg_urls 模式）
  if (!document.getElementById('bilibili-dl-parser')) {
    const p = document.createElement('script');
    p.id = 'bilibili-dl-parser';
    p.type = 'module';
    p.src = chrome.runtime.getURL('lib/collection-parser.js');
    (document.head || document.documentElement).appendChild(p);
  }

  // Always inject page script first (non-blocking)
  if (!document.getElementById('bilibili-downloader-ext')) {
    const s = document.createElement('script');
    s.id = 'bilibili-downloader-ext';
    s.src = chrome.runtime.getURL('content-page.js');
    (document.head || document.documentElement).appendChild(s);
  }

  // Pre-fetch FFmpeg files asynchronously (non-blocking, best-effort)
  const files = [
    { path: 'lib/ffmpeg.worker.js', mime: 'text/javascript', key: 'workerJS' },
    { path: 'lib/ffmpeg-core.js', mime: 'text/javascript', key: 'core' },
    { path: 'lib/ffmpeg-core.wasm', mime: 'application/wasm', key: 'wasm' },
    { path: 'lib/ffmpeg-core.worker.js', mime: 'text/javascript', key: 'coreWorker' }
  ];

  Promise.all(files.map(f =>
    fetch(chrome.runtime.getURL(f.path))
      .then(r => r.arrayBuffer())
      .then(buf => ({ key: f.key, url: URL.createObjectURL(new Blob([buf], { type: f.mime })) }))
      .catch(e => {
        console.debug('[B站下载助手] Pre-fetch failed for', f.path, e);
        return null;
      })
  )).then(results => {
    const urls = {};
    results.filter(Boolean).forEach(r => urls[r.key] = r.url);
    if (urls.workerJS) {
      window.postMessage({ source: 'bilibili-downloader', type: 'ffmpeg_urls', data: urls }, '*');
      console.log('[B站下载助手] FFmpeg pre-fetched OK:', Object.keys(urls).join(', '));
    } else {
      console.debug('[B站下载助手] FFmpeg pre-fetch incomplete');
    }
  });

  // Pending merge callbacks (taskId → callback)
  const pendingMerges = new Map();

  // IndexedDB for merge data
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

  async function saveBlobToDB(key, data) {
    const db = await openMergeDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      const req = tx.objectStore('blobs').put(data, key);
      req.onsuccess = () => resolve();
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

  // Listen for messages from background (including sidepanel via chrome.tabs.sendMessage)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 宿主 tab 就绪探测：仅当页面世界的 content-page.js 已加载（PAGE_READY）才算就绪，
    // 否则 RUN_TASK 会在 content-page.js 注册监听前送达而丢失
    if (message.type === 'HOST_PING') {
      sendResponse(pageReady ? { status: 'ok' } : { status: 'pending' });
      return;
    }
    // Forward queue control messages to page context
    if (message.type === 'RUN_TASK' || message.type === 'ABORT_TASK') {
      window.postMessage({ source: 'bilibili-downloader', type: message.type, data: message.data || {} }, '*');
      // 同步回受理应答：dispatchToHostTab 对 RUN_TASK await tabs.sendMessage，
      // 无应答时 Promise reject 会把已开始执行的任务误标为"下载页面不可用"
      sendResponse({ status: 'ok' });
      return;
    }
    if (message.type === 'offscreen_merge_result') {
      const { taskId, success, error } = message.data;
      const cb = pendingMerges.get(taskId);
      if (!cb) return;
      pendingMerges.delete(taskId);
      
      if (success) {
        // Read merged result from IndexedDB
        readBlobFromDB(taskId + '_merged').then(buffer => {
          deleteBlobFromDB(taskId + '_merged');
          cb({ success: true, buffer });
        }).catch(e => {
          cb({ success: false, error: 'Failed to read merged data: ' + e.message });
        });
      } else {
        cb({ success: false, error });
      }
    }
  });

  // Listen for messages from page context
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'bilibili-downloader') return;

    const { type, data } = event.data;

    // content-page.js 加载完成信号：标记宿主 tab 就绪（RUN_TASK 可安全派发）
    if (type === 'PAGE_READY') {
      pageReady = true;
      return;
    }

    // Handle merge request - store blobs in IndexedDB, then request merge
    if (type === 'merge_request') {
      const { taskId, audio, video } = data;
      console.log('[B站下载助手] Merge request for:', taskId, 'storing blobs in IndexedDB...');
      
      // Store callback
      pendingMerges.set(taskId, (result) => {
        window.postMessage({
          source: 'bilibili-downloader',
          type: 'merge_result',
          data: { taskId, ...result }
        }, '*');
      });
      
      // Store blobs in IndexedDB, then trigger merge
      Promise.all([
        saveBlobToDB(taskId + '_audio', audio),
        saveBlobToDB(taskId + '_video', video)
      ]).then(() => {
        console.log('[B站下载助手] Blobs stored, sending merge request to background');
        chrome.runtime.sendMessage({
          type: 'offscreen_merge',
          data: { taskId }
        });
      }).catch(e => {
        console.debug('[B站下载助手] Failed to store blobs:', e);
        const cb = pendingMerges.get(taskId);
        if (cb) {
          pendingMerges.delete(taskId);
          cb({ success: false, error: e.message });
        }
      });
      return;
    }

    // Handle GET_SETTINGS
    if (type === 'GET_SETTINGS') {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (result) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ source: 'bilibili-downloader', type: 'settings_result', data: {} }, '*');
          return;
        }
        window.postMessage({ source: 'bilibili-downloader', type: 'settings_result', data: result || {} }, '*');
      });
      return;
    }

    // Handle SAVE_BLOB - 在扩展上下文创建 blob URL 并调用 chrome.downloads.download
    if (type === 'SAVE_BLOB') {
      const { requestId, blob, filename, subdir } = data;
      const filePath = subdir ? subdir + '/' + filename : filename;
      // 直接使用页面传来的 Blob 引用：结构化克隆共享底层数据，不做 buffer 全量拷贝
      const extUrl = URL.createObjectURL(blob);
      chrome.runtime.sendMessage({ type: 'SAVE_FILE', data: { url: extUrl, path: filePath } }, (result) => {
        // 响应在下载终态后返回，立即回收数据源；提前 revoke 会中断大文件的写入
        URL.revokeObjectURL(extUrl);
        if (chrome.runtime.lastError) {
          window.postMessage({ source: 'bilibili-downloader', type: 'save_blob_result', data: { requestId, success: false, error: chrome.runtime.lastError.message } }, '*');
          return;
        }
        // downloadId 透传给页面世界，供"合并成功后按设置删除原始文件"使用
        window.postMessage({ source: 'bilibili-downloader', type: 'save_blob_result', data: { requestId, success: result?.success, error: result?.error, downloadId: result?.downloadId || null } }, '*');
      });
      return;
    }

    // Handle DELETE_BLOB_FILE - 删除已落盘的原始文件（合并成功后按设置清理）
    if (type === 'DELETE_BLOB_FILE') {
      const { requestId, downloadId } = data;
      chrome.runtime.sendMessage({ type: 'DELETE_SAVED_FILE', data: { downloadId } }, (result) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ source: 'bilibili-downloader', type: 'delete_blob_result', data: { requestId, success: false, error: chrome.runtime.lastError.message } }, '*');
          return;
        }
        window.postMessage({ source: 'bilibili-downloader', type: 'delete_blob_result', data: { requestId, success: result?.success, error: result?.error } }, '*');
      });
      return;
    }

    // Handle DELETE_FILE
    if (type === 'DELETE_FILE') {
      chrome.runtime.sendMessage({ type: 'DELETE_FILE', data }, () => {});
      return;
    }

    // Forward other messages to background（跳过 OFFSCREEN_*，防 chrome.runtime.sendMessage 广播回声）
    try {
      if (type.startsWith('OFFSCREEN_')) return;
      chrome.runtime.sendMessage({ type, data }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch(e) {}
  });
})();
