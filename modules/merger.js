// modules/merger.js
// Simplified merger - currently saves audio and video separately
// Can be enhanced later with ffmpeg.wasm in content script context

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MERGE_FILES') {
    console.log('[Merger] Received merge request');
    sendResponse({ status: 'ok', message: 'merge not available in service worker' });
  }
  return true;
});

console.log('[Merger] Module loaded');
