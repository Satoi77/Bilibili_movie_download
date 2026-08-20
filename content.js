// content.js - Bridge between page context and extension
(function() {
  // Pre-fetch FFmpeg files from extension context (where chrome-extension:// is allowed)
  // and expose them as Blob URLs for the page context
  async function preFetchFFmpeg() {
    const files = [
      { path: 'lib/ffmpeg.js', mime: 'text/javascript', key: 'js' },
      { path: 'lib/ffmpeg-core.js', mime: 'text/javascript', key: 'core' },
      { path: 'lib/ffmpeg-core.wasm', mime: 'application/wasm', key: 'wasm' },
      { path: 'lib/ffmpeg-core.worker.js', mime: 'text/javascript', key: 'worker' }
    ];
    const urls = {};
    for (const f of files) {
      const r = await fetch(chrome.runtime.getURL(f.path));
      const buf = await r.arrayBuffer();
      urls[f.key] = URL.createObjectURL(new Blob([buf], { type: f.mime }));
    }
    return urls;
  }

  // Inject page script after FFmpeg URLs are ready
  preFetchFFmpeg().then(urls => {
    // Expose URLs to page context via a global before injecting the main script
    const setupScript = document.createElement('script');
    setupScript.textContent = 'window.__biliDL_ffmpegURLs = ' + JSON.stringify(urls) + ';';
    (document.head || document.documentElement).appendChild(setupScript);
    setupScript.remove();

    // Now inject the page script
    if (!document.getElementById('bilibili-downloader-ext')) {
      const s = document.createElement('script');
      s.id = 'bilibili-downloader-ext';
      s.src = chrome.runtime.getURL('content-page.js');
      (document.head || document.documentElement).appendChild(s);
    }
  }).catch(e => {
    console.error('[B站下载助手] Failed to pre-fetch FFmpeg:', e);
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

  // Listen for merge results from background
  chrome.runtime.onMessage.addListener((message) => {
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
        console.error('[B站下载助手] Failed to store blobs:', e);
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

    // Handle SAVE_FILE - receives ArrayBuffer, creates blob URL in extension context
    if (type === 'SAVE_FILE') {
      const { requestId, buffer, path: filePath, mime } = data;
      const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
      const extUrl = URL.createObjectURL(blob);
      
      chrome.runtime.sendMessage({ type: 'SAVE_FILE', data: { url: extUrl, path: filePath } }, (result) => {
        setTimeout(() => URL.revokeObjectURL(extUrl), 5000);
        if (chrome.runtime.lastError) {
          window.postMessage({ source: 'bilibili-downloader', type: 'save_result', data: { requestId, success: false, error: chrome.runtime.lastError.message } }, '*');
          return;
        }
        window.postMessage({ source: 'bilibili-downloader', type: 'save_result', data: { requestId, success: result?.success, error: result?.error } }, '*');
      });
      return;
    }

    // Handle DELETE_FILE
    if (type === 'DELETE_FILE') {
      chrome.runtime.sendMessage({ type: 'DELETE_FILE', data }, () => {});
      return;
    }

    // Forward other messages to background
    try {
      chrome.runtime.sendMessage({ type, data }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch(e) {}
  });
})();
