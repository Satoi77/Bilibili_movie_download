// background.js
import { biliDB } from './lib/db.js';

biliDB.init().then(() => {
  console.log('[Bilibili Downloader] Database initialized');
});

// ─── Download Queue Manager ───
// 队列在后台运行：逐个派发 pending 任务给发起页执行，页面回报 TASK_DONE/ERROR/ABORTED。
// 支持全部/单个 停止-继续，以及删除全部。

let queuePaused = false;
let queueBusy = false;       // 当前是否有任务在派发/执行中
let inFlightTaskId = null;   // 正在执行的任务 id
let nextDispatchAt = 0;      // 下一次允许派发的时间戳（保证任务间延时）

const STALL_TIMEOUT = 5 * 60 * 1000; // 任务超过 5 分钟无进度更新视为停滞

async function loadQueueSettings() {
  const saved = await chrome.storage.local.get('settings');
  return { delayMin: 3000, delayMax: 12000, retryTimes: 3, ...(saved.settings || {}) };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function notifyTask(task) {
  await biliDB.updateTask(task);
  notifySidePanel({ type: 'TASK_UPDATED', data: task });
}

async function sendAbort(task) {
  if (!task || !task.hostTabId) return;
  try {
    await chrome.tabs.sendMessage(task.hostTabId, { type: 'ABORT_TASK', data: { taskId: task.id } });
  } catch (e) {}
}

// 停滞检测：长时间无进度的 downloading 任务标记为失败，并释放队列占用
async function checkStalledTasks() {
  const now = Date.now();
  const all = await biliDB.getTasks();
  let stalled = false;
  for (const t of all) {
    if (t.status === 'downloading' && (now - (t.lastProgressAt || 0)) > STALL_TIMEOUT) {
      t.status = 'failed';
      t.error = '下载超时（长时间无进度）';
      await notifyTask(t);
      stalled = true;
    }
  }
  if (stalled && inFlightTaskId) {
    inFlightTaskId = null;
    queueBusy = false;
  }
  return stalled;
}

// 派发下一个 pending 任务。返回 true 表示已派发。
async function pumpQueue() {
  await checkStalledTasks();
  if (queuePaused || queueBusy || Date.now() < nextDispatchAt) return false;

  const pending = (await biliDB.getTasks())
    .filter(t => t.status === 'pending')
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

  if (pending.length === 0) return false;

  const task = pending[0];
  task.status = 'downloading';
  task.lastProgressAt = Date.now();
  await notifyTask(task);

  inFlightTaskId = task.id;
  queueBusy = true;

  if (!task.hostTabId) {
    await failTask(task.id, '下载页面不可用', false);
    queueBusy = false;
    inFlightTaskId = null;
    nextDispatchAt = 0;
    return pumpQueue(); // 继续处理下一个
  }

  try {
    await chrome.tabs.sendMessage(task.hostTabId, {
      type: 'RUN_TASK',
      data: { taskId: task.id, videoInfo: task.videoInfo, qualityIdx: task.qualityIdx || 0 }
    });
  } catch (e) {
    await failTask(task.id, '下载页面已关闭，任务无法继续', false);
    queueBusy = false;
    inFlightTaskId = null;
    nextDispatchAt = 0;
    return pumpQueue(); // 继续处理下一个
  }
  return true;
}

async function failTask(taskId, error, retryable) {
  const settings = await loadQueueSettings();
  const t = await biliDB.getTask(taskId);
  if (!t) return;
  if (t.status !== 'downloading' && t.status !== 'pending') return;
  t.retryCount = (t.retryCount || 0) + 1;
  t.lastError = error;
  if (retryable && t.retryCount <= settings.retryTimes) {
    // 移到队列末尾重试
    t.status = 'pending';
    t.createdAt = new Date().toISOString();
    t.progress = { audio: 0, video: 0, merge: 0 };
    t.lastProgressAt = 0;
    await notifyTask(t);
    return;
  }
  t.status = 'failed';
  t.error = error;
  await notifyTask(t);
}

// 任务结束后：释放队列占用，按设置延时后派发下一个任务
async function advanceQueue(taskId) {
  if (!taskId || inFlightTaskId === taskId) {
    inFlightTaskId = null;
    queueBusy = false;
  }
  if (queuePaused) return;
  const settings = await loadQueueSettings();
  const delay = Math.floor(Math.random() * (settings.delayMax - settings.delayMin + 1)) + settings.delayMin;
  nextDispatchAt = Date.now() + delay;
  await sleep(delay);
  pumpQueue();
}

// SW 存活兜底：定时唤醒重新派发（SW 休眠期间可能错过 sleep 后的 pump）
chrome.alarms?.create('queue-pump', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'queue-pump') {
    checkStalledTasks();
    pumpQueue();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Bilibili Downloader] Extension installed');
});

// ─── Unified Storage Layer ───
// 所有数据读写通过此 handler，其他上下文不直接访问存储

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
    pumpQueue();
    return true;
  }

  if (type === 'DELETE_TASK') {
    if (!data.taskId) { sendResponse({ status: 'ok' }); return true; }
    (async () => {
      if (inFlightTaskId === data.taskId) {
        const inflight = await biliDB.getTask(data.taskId);
        if (inflight) await sendAbort(inflight);
        inFlightTaskId = null;
        queueBusy = false;
      }
      await biliDB.deleteTask(data.taskId);
      notifySidePanel({ type: 'TASK_REMOVED', data: { taskId: data.taskId } });
      sendResponse({ status: 'ok' });
    })();
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
      if (data.phase === 'quality' && data.label) task.quality = data.label;
      task.lastProgressAt = Date.now();
      biliDB.updateTask(task).then(() => {
        notifySidePanel({ type: 'TASK_UPDATED', data: task });
      });
    });
    sendResponse({ status: 'ok' });
    return true;
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
    return true;
  }

  // ─── Queue Control ───

  if (type === 'ENQUEUE_TASKS') {
    (async () => {
      const list = data.tasks || [];
      const base = Date.now();
      const hostTabId = sender.tab ? sender.tab.id : null;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const task = {
          id: it.taskId,
          title: it.title || '',
          quality: it.quality || '等待中',
          bvid: it.bvid || '',
          videoInfo: { aid: it.aid, bvid: it.bvid, cid: it.cid, title: it.title || '' },
          qualityIdx: it.qualityIdx || 0,
          status: 'pending',
          progress: { audio: 0, video: 0, merge: 0 },
          retryCount: 0,
          createdAt: new Date(base + i).toISOString(),
          lastProgressAt: 0,
          hostTabId
        };
        await biliDB.updateTask(task);
        notifySidePanel({ type: 'TASK_ADDED', data: task });
      }
      if (hostTabId) {
        chrome.sidePanel.open({ tabId: hostTabId }).catch(() => {});
      }
      sendResponse({ status: 'ok', count: list.length });
      pumpQueue();
    })();
    return true;
  }

  if (type === 'ENQUEUE_TASK') {
    (async () => {
      const it = data.task || {};
      const task = {
        id: it.taskId,
        title: it.title || '',
        quality: it.quality || '等待中',
        bvid: it.bvid || '',
        videoInfo: { aid: it.aid, bvid: it.bvid, cid: it.cid, title: it.title || '' },
        qualityIdx: it.qualityIdx || 0,
        status: 'pending',
        progress: { audio: 0, video: 0, merge: 0 },
        retryCount: 0,
        createdAt: new Date().toISOString(),
        lastProgressAt: 0,
        hostTabId: sender.tab ? sender.tab.id : null
      };
      await biliDB.updateTask(task);
      notifySidePanel({ type: 'TASK_ADDED', data: task });
      if (task.hostTabId) {
        chrome.sidePanel.open({ tabId: task.hostTabId }).catch(() => {});
      }
      sendResponse({ status: 'ok' });
      pumpQueue();
    })();
    return true;
  }

  if (type === 'STOP_ALL') {
    (async () => {
      queuePaused = true;
      const all = await biliDB.getTasks();
      for (const t of all) {
        if (t.status === 'downloading' || t.status === 'pending') {
          t.status = 'paused';
          await notifyTask(t);
        }
      }
      const inflight = inFlightTaskId ? await biliDB.getTask(inFlightTaskId) : null;
      if (inflight) await sendAbort(inflight);
      inFlightTaskId = null;
      queueBusy = false;
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'RESUME_ALL') {
    (async () => {
      queuePaused = false;
      const all = await biliDB.getTasks();
      for (const t of all) {
        if (t.status === 'paused') {
          t.status = 'pending';
          await notifyTask(t);
        }
      }
      nextDispatchAt = 0;
      sendResponse({ status: 'ok' });
      pumpQueue();
    })();
    return true;
  }

  if (type === 'STOP_TASK') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && (t.status === 'downloading' || t.status === 'pending')) {
        const wasInFlight = t.status === 'downloading';
        t.status = 'paused';
        await notifyTask(t);
        if (wasInFlight) {
          await sendAbort(t);
          if (inFlightTaskId === t.id) { inFlightTaskId = null; queueBusy = false; }
        }
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'RESUME_TASK') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && (t.status === 'paused' || t.status === 'failed')) {
        t.status = 'pending';
        t.retryCount = 0;
        t.error = '';
        t.lastError = '';
        t.progress = { audio: 0, video: 0, merge: 0 };
        await notifyTask(t);
      }
      sendResponse({ status: 'ok' });
      nextDispatchAt = 0;
      pumpQueue();
    })();
    return true;
  }

  if (type === 'DELETE_ALL') {
    (async () => {
      const inflight = inFlightTaskId ? await biliDB.getTask(inFlightTaskId) : null;
      if (inflight) await sendAbort(inflight);
      const all = await biliDB.getTasks();
      await Promise.all(all.map(t => biliDB.deleteTask(t.id)));
      all.forEach(t => notifySidePanel({ type: 'TASK_REMOVED', data: { taskId: t.id } }));
      inFlightTaskId = null;
      queueBusy = false;
      sendResponse({ status: 'ok', deleted: all.length });
    })();
    return true;
  }

  if (type === 'TASK_DONE') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && t.status === 'downloading') {
        t.status = 'completed';
        t.progress = { audio: 100, video: 100, merge: 100 };
        t.completedAt = new Date().toISOString();
        await notifyTask(t);
      }
      advanceQueue(data.taskId);
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'TASK_ERROR') {
    (async () => {
      await failTask(data.taskId, data.error || '未知错误', true);
      advanceQueue(data.taskId);
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'TASK_ABORTED') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && t.status === 'downloading') {
        t.status = 'paused';
        await notifyTask(t);
      }
      if (inFlightTaskId === data.taskId) {
        inFlightTaskId = null;
        queueBusy = false;
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
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
