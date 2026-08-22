# Task 4: background.js — 队列派发改 offscreen 优先 + 宿主 tab 兜底

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes:
  - offscreen 消息：`OFFSCREEN_PING` / `OFFSCREEN_RUN_TASK` / `OFFSCREEN_ABORT_TASK`（发出）
  - offscreen 回报：`OFFSCREEN_PROGRESS` / `OFFSCREEN_TASK_DONE` / `OFFSCREEN_TASK_ERROR` / `OFFSCREEN_TASK_ABORTED` / `OFFSCREEN_NEEDS_PAGE`（接收）
  - 宿主 tab：`RUN_TASK` / `ABORT_TASK`（tabs.sendMessage 发出）；回报沿用 `download_progress` / `TASK_DONE` / `TASK_ERROR` / `TASK_ABORTED`
- Produces:
  - 模块级状态：`let inFlightExecutor = null`（`'offscreen'` | `'hostTab'`）、`let hostTabId = null`
  - `ensureOffscreen()`（增强：创建后等待就绪）
  - `dispatchToHostTab(task)` / `ensureHostTab()` / `waitHostTabReady(tabId)`
  - `sendAbort(taskId)`（按 inFlightExecutor 分发）
  - `maybeCloseHostTab()`

- [ ] **Step 1: 修改 `background.js` 头部状态与辅助函数**

将第 12-15 行区域替换为：

```js
let queuePaused = false;
let queueBusy = false;       // 当前是否有任务在派发/执行中
let inFlightTaskId = null;   // 正在执行的任务 id
let nextDispatchAt = 0;      // 下一次允许派发的时间戳（保证任务间延时）
let inFlightExecutor = null; // 'offscreen' | 'hostTab' | null
let hostTabId = null;        // 宿主 B 站 tab id（兜底执行用）
```

将第 33-38 行 `sendAbort` 函数替换为：

```js
async function sendAbort(taskId) {
  if (inFlightExecutor === 'offscreen') {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_ABORT_TASK', data: { taskId } }); } catch (e) {}
  } else if (inFlightExecutor === 'hostTab' && hostTabId) {
    try { await chrome.tabs.sendMessage(hostTabId, { type: 'ABORT_TASK', data: { taskId } }); } catch (e) {}
  }
}
```

- [ ] **Step 2: 新增 offscreen 与宿主 tab 工具函数**

在 `sendAbort` 之后插入：

```js
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
          await chrome.tabs.sendMessage(tabId, { type: 'HOST_PING' });
          return;
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
```

- [ ] **Step 3: 修改 `pumpQueue` 派发逻辑**

将 `pumpQueue` 中从 `if (!task.hostTabId) {` 到 `return true;` 的整段（第 79-99 行）替换为：

```js
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
```

注意：`pumpQueue` 开头仍保留 `checkStalledTasks()`；`queuePaused/queueBusy/nextDispatchAt` 判断不变。

- [ ] **Step 4: 修改 `advanceQueue` 释放执行者**

将 `advanceQueue` 函数体（第 124-135 行）改为：

```js
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
```

- [ ] **Step 5: 新增 `OFFSCREEN_*` 消息处理**

在 `chrome.runtime.onMessage.addListener` 中、`// ─── Settings ───` 之前插入：

```js
  // ─── Offscreen 后台下载 ───
  if (type === 'OFFSCREEN_PING') {
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
```

- [ ] **Step 6: 更新入队任务字段**

`ENQUEUE_TASKS`（第 302-333 行）与 `ENQUEUE_TASK`（第 335-361 行）中创建的任务对象，在 `lastProgressAt: 0` 后各追加一行 `offscreenTried: false`，并保留 `hostTabId`（仍用于 `chrome.sidePanel.open`）。

- [ ] **Step 7: 更新停止/删除的 abort 调用**

将以下 4 处的 `sendAbort(inflight)` / `sendAbort(t)` 调用改为传 `taskId`：
- `DELETE_TASK` 内：`await sendAbort(inflight.id);`
- `STOP_ALL` 内：`await sendAbort(inflight.id);`
- `STOP_TASK` 内：`await sendAbort(t.id);`
- `DELETE_ALL` 内：`await sendAbort(inflight.id);`

并在 `STOP_ALL` 的 `if (inflight) await sendAbort(inflight);` 之后、`inFlightTaskId = null;` 之前增加 `inFlightExecutor = null;`；`DELETE_TASK`、`STOP_TASK`、`DELETE_ALL` 中清空 `inFlightTaskId` 处同样追加 `inFlightExecutor = null;`。

- [ ] **Step 8: 语法检查**

因 PowerShell 5.1 管道 GBK 编码问题，使用 UTF-8 安全管道：

```powershell
$OutputEncoding = [System.Text.Encoding]::UTF8
[System.IO.File]::ReadAllText('background.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
```

Expected: 无输出，exit code 0

- [ ] **Step 9: Commit**

```bash
git add background.js
git commit -m "feat(download): 队列派发改 offscreen 优先，失败自动切隐藏宿主 tab 兜底"
```
