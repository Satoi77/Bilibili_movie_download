// background.js
import { biliDB } from './lib/db.js';

biliDB.init().then(() => {
  console.log('[Bilibili Downloader] Database initialized');
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Bilibili Downloader] Extension installed');
});

// ─── Unified Storage Layer ───
// 所有数据读写通过此 handler，其他上下文不直接访问存储

const DIR_HANDLE_DB = 'BiliDirHandleDB';
const DIR_HANDLE_STORE = 'dirHandle';

function openDirHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DIR_HANDLE_DB, 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore(DIR_HANDLE_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;

  // ─── Settings ───
  if (type === 'GET_SETTINGS') {
    chrome.storage.local.get('settings', (result) => {
      sendResponse(result.settings || {});
    });
    return true;
  }

  if (type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ settings: data.settings }, () => {
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  // ─── Tasks ───
  if (type === 'GET_TASKS') {
    biliDB.getTasks().then(tasks => {
      sendResponse({ tasks });
    });
    return true;
  }

  if (type === 'DELETE_TASK') {
    if (!data.taskId) { sendResponse({ status: 'ok' }); return true; }
    biliDB.deleteTask(data.taskId).then(() => {
      notifySidePanel({ type: 'TASK_REMOVED', data: { taskId: data.taskId } });
      sendResponse({ status: 'ok' });
    });
    return true;
  }

  if (type === 'CLEAR_COMPLETED') {
    biliDB.getTasks().then(tasks => {
      const toDelete = tasks.filter(t =>
        (t.status === 'completed' || t.status === 'failed') && t.id
      );
      Promise.all(toDelete.map(t => biliDB.deleteTask(t.id))).then(() => {
        sendResponse({ status: 'ok', deleted: toDelete.length });
      });
    });
    return true;
  }

  // ─── Directory Handle ───
  if (type === 'GET_DIR_HANDLE') {
    openDirHandleDB().then(db => {
      const tx = db.transaction(DIR_HANDLE_STORE, 'readonly');
      const req = tx.objectStore(DIR_HANDLE_STORE).get('current');
      req.onsuccess = () => { db.close(); sendResponse({ handle: req.result || null }); };
      req.onerror = () => { db.close(); sendResponse({ handle: null }); };
    }).catch(() => sendResponse({ handle: null }));
    return true;
  }

  if (type === 'SAVE_DIR_HANDLE') {
    openDirHandleDB().then(db => {
      const tx = db.transaction(DIR_HANDLE_STORE, 'readwrite');
      tx.objectStore(DIR_HANDLE_STORE).put(data.handle, 'current');
      tx.oncomplete = () => { db.close(); sendResponse({ status: 'ok' }); };
      tx.onerror = () => { db.close(); sendResponse({ status: 'error' }); };
    }).catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  // ─── Download Lifecycle ───
  if (type === 'download_start') {
    const task = {
      id: data.taskId,
      title: data.title,
      quality: data.quality,
      bvid: data.bvid,
      videoUrl: data.videoUrl,
      audioUrl: data.audioUrl,
      videoSize: data.videoSize || 0,
      audioSize: data.audioSize || 0,
      status: 'downloading',
      progress: { audio: 0, video: 0 },
      delayMessage: '',
      createdAt: new Date().toISOString()
    };
    biliDB.updateTask(task).then(() => {
      notifySidePanel({ type: 'TASK_UPDATED', data: task });
    });
    if (sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ status: 'ok' });
  }

  if (type === 'task_precreate') {
    const task = {
      id: data.taskId,
      title: data.title,
      quality: '等待中',
      bvid: data.bvid,
      videoUrl: '',
      audioUrl: '',
      videoSize: 0,
      audioSize: 0,
      status: 'downloading',
      progress: { audio: 0, video: 0 },
      createdAt: new Date().toISOString()
    };
    biliDB.updateTask(task).then(() => {
      notifySidePanel({ type: 'TASK_ADDED', data: task });
    });
    if (sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ status: 'ok' });
  }

  if (type === 'download_progress') {
    biliDB.getTask(data.taskId).then(task => {
      if (!task) return;
      if (data.phase === 'audio') task.progress.audio = data.percent;
      if (data.phase === 'video') task.progress.video = data.percent;
      if (data.phase === 'merge') task.progress.merge = data.percent;
      if (data.phase === 'delay') task.delayMessage = data.label;
      biliDB.updateTask(task).then(() => {
        notifySidePanel({ type: 'TASK_UPDATED', data: task });
      });
    });
    sendResponse({ status: 'ok' });
  }

  if (type === 'download_complete') {
    biliDB.getTask(data.taskId).then(task => {
      if (!task) return;
      task.status = 'completed';
      task.progress.audio = 100;
      task.progress.video = 100;
      task.completedAt = new Date().toISOString();
      biliDB.updateTask(task).then(() => {
        notifySidePanel({ type: 'TASK_UPDATED', data: task });
      });
    });
    sendResponse({ status: 'ok' });
  }

  if (type === 'download_error') {
    biliDB.getTask(data.taskId).then(task => {
      if (!task) return;
      task.status = 'failed';
      task.error = data.error;
      biliDB.updateTask(task).then(() => {
        notifySidePanel({ type: 'TASK_UPDATED', data: task });
      });
    });
    sendResponse({ status: 'ok' });
  }

  // ─── File Operations ───
  if (type === 'SAVE_FILE') {
    const { url, path: filePath } = data;
    chrome.downloads.download({ url, filename: filePath, conflictAction: 'uniquify', saveAs: false }, (dlId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: dlId });
      }
    });
    return true;
  }

  if (type === 'SAVE_RAW_FILES') {
    const { files } = data;
    (async () => {
      const results = [];
      for (const file of files) {
        try {
          const dlId = await new Promise((resolve, reject) => {
            chrome.downloads.download({
              url: file.url,
              filename: file.path,
              conflictAction: 'uniquify',
              saveAs: false
            }, (id) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(id);
            });
          });
          results.push({ path: file.path, success: true, downloadId: dlId });
        } catch (e) {
          results.push({ path: file.path, success: false, error: e.message });
        }
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (type === 'DELETE_FILE') {
    chrome.downloads.search({ filenameQuery: data.path, limit: 1 }, (results) => {
      if (results && results.length > 0) {
        chrome.downloads.removeFile(results[0].id, () => sendResponse({ success: true }));
      } else {
        sendResponse({ success: false, error: 'File not found' });
      }
    });
    return true;
  }

  // ─── Offscreen Merge ───
  if (type === 'offscreen_merge' && sender.tab) {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ type: 'offscreen_merge_request', data: data });
    });
    return true;
  }

  if (type === 'offscreen_merge_result') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'offscreen_merge_result', data }).catch(() => {});
      });
    });
    sendResponse({ status: 'ok' });
    return true;
  }

  return true;
});

function notifySidePanel(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch(e) {}
}

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'FFmpeg WASM merge'
  });
}

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });

console.log('[Bilibili Downloader] Background loaded');
