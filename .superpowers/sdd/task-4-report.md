# Task 4 Report: background.js — 队列派发改 offscreen 优先 + 宿主 tab 兜底

**Status:** DONE_WITH_CONCERNS
**Commit:** `1adfc9d feat(download): 队列派发改 offscreen 优先，失败自动切隐藏宿主 tab 兜底`

## What was implemented

按 task-4-brief 的 Step 1-7 逐条应用，仅修改 `background.js`：

- **Step 1a**：模块级状态新增 `let inFlightExecutor = null` 与 `let hostTabId = null`。
- **Step 1b**：`sendAbort(task)` → `sendAbort(taskId)`，按 `inFlightExecutor` 分发到 `OFFSCREEN_ABORT_TASK`（offscreen）或 `ABORT_TASK`（hostTab）。
- **Step 2**：在 `sendAbort` 之后新增 `ensureOffscreen()`（增强版：创建后 50×200ms OFFSCREEN_PING 就绪探测）、`ensureHostTab()`、`waitHostTabReady()`（15s 超时，HOST_PING 探测）、`dispatchToHostTab()`（成功置 `inFlightExecutor='hostTab'`；失败 `failTask(id,'下载页面不可用',false)` + 释放队列状态并返回 false）、`maybeCloseHostTab()`（无 pending/downloading 任务时移除宿主 tab）。
- **Step 3**：`pumpQueue` 派发改为 offscreen 优先（`ensureOffscreen()` → 置 `inFlightExecutor='offscreen'` → `OFFSCREEN_RUN_TASK`），异常时 `dispatchToHostTab` 兜底，兜底失败 `return pumpQueue()`。
- **Step 4**：`advanceQueue` 释放 `inFlightExecutor`，并新增 `maybeCloseHostTab()` 调用。
- **Step 5**：`chrome.runtime.onMessage.addListener` 内、`// ─── Settings ───` 之前插入 `OFFSCREEN_PING / OFFSCREEN_PROGRESS / OFFSCREEN_TASK_DONE / OFFSCREEN_TASK_ERROR / OFFSCREEN_TASK_ABORTED / OFFSCREEN_NEEDS_PAGE` 六个 handler（`OFFSCREEN_NEEDS_PAGE` 置 `offscreenTried=true` 后转 `dispatchToHostTab`，失败 `advanceQueue`）。
- **Step 6**：`ENQUEUE_TASKS` 与 `ENQUEUE_TASK` 任务对象在 `lastProgressAt: 0` 后追加 `offscreenTried: false`，保留 `hostTabId`（仍用于 `chrome.sidePanel.open`）。
- **Step 7**：4 处 abort 调用改为传 id（DELETE_TASK / STOP_ALL / STOP_TASK / DELETE_ALL），并在各自清空 `inFlightTaskId` 处追加 `inFlightExecutor = null`（STOP_ALL 按 brief 放在 `sendAbort` 之后、`inFlightTaskId = null` 之前）。

## Deviation from literal brief（必要修正）

**删除了文件底部旧版 `ensureOffscreen()`（原 539-549 行）。** 原因：

- brief Step 2 要求在 `sendAbort` 之后**插入**新版 `ensureOffscreen`，但文件底部已存在旧版同名顶层函数声明。
- 已用 node 验证：ES module 中同作用域重复顶层函数声明为 **SyntaxError**（`Identifier 'ensureOffscreen' has already been declared`），Step 8 语法检查必然失败。
- brief 自身的描述也印证"新版替换旧版"：`ensureOffscreen()`（增强：创建后等待就绪）即对既有 pattern 的升级。
- 删除后 `offscreen_merge` handler（现 674 行）自动使用新版 `ensureOffscreen`（行为上是旧版的超集，对合并路径兼容）。这是唯一超出 brief 字面操作的改动，且为通过 Step 8 的必要条件。

## Verification commands and exact output

1. 语法检查（brief Step 8，UTF-8 安全管道）：
   ```powershell
   $OutputEncoding = [System.Text.Encoding]::UTF8
   [System.IO.File]::ReadAllText('background.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
   ```
   → 无输出，`exit=0`（第二次复跑确认 `syntax_exit=0`）。
2. `git diff --stat` → 仅 `background.js`，`1 file changed, 184 insertions(+), 36 deletions(-)`。
3. `git status --short` → 仅遗留 `.superpowers/`（未跟踪，属其他会话产物，未纳入提交）。

## Files changed

- `background.js`（唯一改动文件；`git add background.js` 精确暂存后提交）

## Self-review findings

- `sendAbort(` 仅定义处（35 行）带 `taskId` 参数，4 个调用点（340/532/566/596）全部传 id，无残留传 task 对象。
- `inFlightExecutor = null` 齐备：dispatchToHostTab 失败分支（108）、advanceQueue（203）、OFFSCREEN_TASK_ABORTED（290）、DELETE_TASK（343）、STOP_ALL（533）、STOP_TASK（567）、DELETE_ALL（602）。
- `inFlightExecutor` 置位：pumpQueue='offscreen'（165）、dispatchToHostTab='hostTab'（98）。
- `offscreenTried: false` 在 ENQUEUE_TASKS（477）与 ENQUEUE_TASK（507）两处均存在；OFFSCREEN_NEEDS_PAGE（301）置 true。
- `ensureOffscreen` 全文件仅一处定义（44 行），被 pumpQueue（164）与 offscreen_merge（674）使用。
- 各替换区域与 brief 代码逐字核对一致。

## Issues / concerns

1. **brief 未提及旧版 `ensureOffscreen` 的删除**（见上，已按必须修正处理）。若或chestrator 期望严格零改动，请知悉此项。
2. **次要观察（未改动，遵循 brief）**：`checkStalledTasks()` 停滞清场时未复位 `inFlightExecutor`（仅清 `inFlightTaskId`/`queueBusy`）。影响有限——下一任务派发时会重新置位，且停滞场景下 `inFlightTaskId` 已为 null，STOP_ALL 不会误发 abort；属自愈性陈旧值。brief 明确要求该函数不改动，故保留。
3. 遗留提示（非本任务引入）：offscreen 旧 FFmpeg 合并路径 `offscreen_merge_request` 依赖已移除的 `lib/ffmpeg.js`，task-2 已记录该既有状况。
