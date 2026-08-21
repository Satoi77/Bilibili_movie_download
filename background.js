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
let inFlightExecutor = null; // 'offscreen' | 'hostTab' | null
let hostTabId = null;        // 宿主 B 站 tab id（兜底执行用）

const STALL_TIMEOUT = 5 * 60 * 1000; // 任务超过 5 分钟无进度更新视为停滞
const MAX_TASK_DURATION = 30 * 60 * 1000; // 单个任务执行超过 30 分钟强制重试（兜底心跳掩盖的卡死）

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

async function sendAbort(taskId) {
  if (inFlightExecutor === 'offscreen') {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_ABORT_TASK', data: { taskId } }); } catch (e) {}
  } else if (inFlightExecutor === 'hostTab' && hostTabId) {
    try { await chrome.tabs.sendMessage(hostTabId, { type: 'ABORT_TASK', data: { taskId } }); } catch (e) {}
  }
}

// ─── Offscreen 与宿主 tab 工具 ───
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '后台下载与 FFmpeg 合并'
    });
  }
  for (let i = 0; i < 50; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
      if (res?.status === 'ok') return;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('offscreen 未就绪');
}

async function ensureHostTab() {
  if (hostTabId) {
    try {
      const tab = await chrome.tabs.get(hostTabId);
      if (tab && tab.status === 'complete') return hostTabId;
    } catch (e) {}
  }
  const tab = await chrome.tabs.create({ url: 'https://www.bilibili.com', active: false });
  hostTabId = tab.id;
  await waitHostTabReady(hostTabId);
  return hostTabId;
}

async function waitHostTabReady(tabId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') {
        try {
          // 仅当 content.js 响应 status:'ok'（即页面世界 content-page.js 已就绪）才算就绪
          const res = await chrome.tabs.sendMessage(tabId, { type: 'HOST_PING' });
          if (res?.status === 'ok') return;
        } catch (e) {}
      }
    } catch (e) {
      throw e;
    }
    await sleep(500);
  }
  throw new Error('宿主页面就绪超时');
}

async function dispatchToHostTab(task) {
  try {
    const host = await ensureHostTab();
    inFlightExecutor = 'hostTab';
    await chrome.tabs.sendMessage(host, {
      type: 'RUN_TASK',
      data: { taskId: task.id, videoInfo: task.videoInfo, qualityIdx: task.qualityIdx || 0 }
    });
    return true;
  } catch (e) {
    await failTask(task.id, '下载页面不可用', false);
    queueBusy = false;
    inFlightTaskId = null;
    inFlightExecutor = null;
    nextDispatchAt = 0;
    return false;
  }
}

async function maybeCloseHostTab() {
  if (!hostTabId) return;
  const all = await biliDB.getTasks();
  const active = all.filter(t => t.status === 'pending' || t.status === 'downloading');
  if (active.length === 0) {
    try { await chrome.tabs.remove(hostTabId); } catch (e) {}
    hostTabId = null;
  }
}

// 停滞自愈：①任务长时间无进度 ②任务总时长超限 ③offscreen 执行器假死（SW 休眠时被 Chrome 销毁/冻结）
// 命中任一即把任务可重试地移到队尾，释放队列，让 pumpQueue 重新派发（会自动重建 offscreen 或走宿主 tab 兜底）
async function checkStalledTasks() {
  const now = Date.now();
  const all = await biliDB.getTasks();
  let stalled = false;
  for (const t of all) {
    if (t.status !== 'downloading') continue;
    const last = t.lastProgressAt || 0;
    if ((now - last) > STALL_TIMEOUT) {
      await failTask(t.id, '下载超时（长时间无进度）', true);
      stalled = true;
    } else if ((now - (t.startedAt || last)) > MAX_TASK_DURATION) {
      await failTask(t.id, '下载超时（任务耗时过长）', true);
      stalled = true;
    }
  }
  // offscreen 假死探测：任务在执行中但 offscreen 无响应 → 立即重派发（无需等停滞超时）
  if (inFlightExecutor === 'offscreen' && inFlightTaskId) {
    let alive = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
      alive = res?.status === 'ok';
    } catch (e) {}
    if (!alive) {
      await failTask(inFlightTaskId, '后台执行器不可用，重新派发', true);
      stalled = true;
    }
  }
  if (stalled && inFlightTaskId) {
    inFlightTaskId = null;
    queueBusy = false;
    inFlightExecutor = null;
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
  if (!task.startedAt) task.startedAt = Date.now();
  await notifyTask(task);

  inFlightTaskId = task.id;
  queueBusy = true;

  try {
    await ensureOffscreen();
    inFlightExecutor = 'offscreen';
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_RUN_TASK',
      data: { taskId: task.id, videoInfo: task.videoInfo, qualityIdx: task.qualityIdx || 0 }
    });
  } catch (e) {
    const ok = await dispatchToHostTab(task);
    if (!ok) return pumpQueue(); // 继续处理下一个
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
    inFlightExecutor = null;
  }
  if (queuePaused) return;
  const settings = await loadQueueSettings();
  const delay = Math.floor(Math.random() * (settings.delayMax - settings.delayMin + 1)) + settings.delayMin;
  nextDispatchAt = Date.now() + delay;
  await sleep(delay);
  maybeCloseHostTab();
  pumpQueue();
}

// SW 存活兜底：定时唤醒重新派发（SW 休眠期间可能错过 sleep 后的 pump）
chrome.alarms?.create('queue-pump', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'queue-pump') {
    checkStalledTasks().then(() => pumpQueue());
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Bilibili Downloader] Extension installed');
});

// ─── Unified Storage Layer ───
// 所有数据读写通过此 handler，其他上下文不直接访问存储

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;

  // ─── Offscreen 后台下载 ───
  if (type === 'OFFSCREEN_PING') {
    sendResponse({ status: 'ok' });
    return true;
  }

  // offscreen 任务执行期保活心跳：仅唤醒 SW（不写 DB、不更新 lastProgressAt），
  // 防止 SW 无活动休眠连带销毁 offscreen document
  if (type === 'OFFSCREEN_HEARTBEAT') {
    sendResponse({ status: 'ok' });
    return true;
  }

  if (type === 'OFFSCREEN_PROGRESS') {
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

  if (type === 'OFFSCREEN_TASK_DONE') {
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

  if (type === 'OFFSCREEN_TASK_ERROR') {
    (async () => {
      await failTask(data.taskId, data.error || '未知错误', true);
      advanceQueue(data.taskId);
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'OFFSCREEN_TASK_ABORTED') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && t.status === 'downloading') {
        t.status = 'paused';
        await notifyTask(t);
      }
      if (inFlightTaskId === data.taskId) {
        inFlightTaskId = null;
        queueBusy = false;
        inFlightExecutor = null;
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

  if (type === 'OFFSCREEN_NEEDS_PAGE') {
    (async () => {
      const t = await biliDB.getTask(data.taskId);
      if (t && t.status === 'downloading') {
        t.offscreenTried = true;
        await notifyTask(t);
        const ok = await dispatchToHostTab(t);
        if (!ok) advanceQueue(data.taskId);
      }
      sendResponse({ status: 'ok' });
    })();
    return true;
  }

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
        if (inflight) await sendAbort(inflight.id);
        inFlightTaskId = null;
        queueBusy = false;
        inFlightExecutor = null;
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
          offscreenTried: false,
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
        offscreenTried: false,
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
      if (inflight) await sendAbort(inflight.id);
      inFlightExecutor = null;
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
          await sendAbort(t.id);
          if (inFlightTaskId === t.id) { inFlightTaskId = null; queueBusy = false; inFlightExecutor = null; }
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
      if (inflight) await sendAbort(inflight.id);
      const all = await biliDB.getTasks();
      await Promise.all(all.map(t => biliDB.deleteTask(t.id)));
      all.forEach(t => notifySidePanel({ type: 'TASK_REMOVED', data: { taskId: t.id } }));
      inFlightTaskId = null;
      queueBusy = false;
      inFlightExecutor = null;
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
    }).catch(() => {});
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

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });

console.log('[Bilibili Downloader] Background loaded');
