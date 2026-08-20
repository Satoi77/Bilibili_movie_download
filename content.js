// content.js - Bridge between page context and extension
(function() {
  // Inject page script
  if (!document.getElementById('bilibili-downloader-ext')) {
    const s = document.createElement('script');
    s.id = 'bilibili-downloader-ext';
    s.src = chrome.runtime.getURL('content-page.js');
    (document.head || document.documentElement).appendChild(s);
  }

  // Pending merge callbacks
  const pendingMerges = new Map();

  // Listen for merge results from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'offscreen_merge_result') {
      const { taskId, success, buffer, error } = message.data;
      const cb = pendingMerges.get(taskId);
      if (cb) {
        pendingMerges.delete(taskId);
        cb({ success, buffer, error });
      }
    }
  });

  // Listen for messages from page context
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'bilibili-downloader') return;

    const { type, data } = event.data;

    // Handle merge request
    if (type === 'merge_request') {
      const { taskId } = data;
      console.log('[B站下载助手] Merge request for:', taskId);
      
      // Store callback for when result comes back
      pendingMerges.set(taskId, (result) => {
        window.postMessage({
          source: 'bilibili-downloader',
          type: 'merge_result',
          data: { taskId, ...result }
        }, '*');
      });
      
      // Send to background
      chrome.runtime.sendMessage({
        type: 'offscreen_merge',
        data: { taskId, audio: data.audio, video: data.video }
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
