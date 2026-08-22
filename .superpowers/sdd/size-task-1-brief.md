# Task 1 简报：体积异步补全链路（background 处理器 + content-page 补全循环）

## Files
- Modify: `background.js`（在 `if (type === 'STOP_ALL') {` 之前插入新处理器）
- Modify: `content-page.js`（合集批量下载 click 处理器内，`console.log('[B站下载助手] Enqueued', ...)` 之后插入补全循环）

## Interfaces
- Produces: 消息类型 `UPDATE_TASK_SIZE`，payload `{ taskId: string, videoSize: number, audioSize: number }`。background 收到后写回任务的 `videoSize`/`audioSize`/`totalSize` 字段并广播 `TASK_UPDATED`。
- Consumes: content-page.js 现有 `getPlayUrl(avid, bvid, cid, qn, signal)`（返回含 `dash.video[]/.audio[]`，条目带 `.id/.bandwidth/.size`）、`notify(type, data)`（经 content.js 转发所有非 `OFFSCREEN_` 类型到 background）。
- sidepanel.js 无需改动：`getTaskSize()` 已兼容 `totalSize` 与 `videoSize+audioSize` 回退。

## Global Constraints（必须遵守）
- 不修改单视频下载路径、执行期 quality 上报、MERGE_THRESHOLD 行为
- 仅当 `task.totalSize` 为空时才补全体积（防覆盖执行期实际值）
- 提交信息风格：`feat(download): 中文描述`；只精确 add 本任务改动的文件（禁止 git add -A / git add .）

---

## Step 1: background.js 新增 UPDATE_TASK_SIZE 处理器

定位 `background.js` 中 `ENQUEUE_TASK` 处理器结束与 `STOP_ALL` 之间的空行，插入：

```javascript
  if (type === 'UPDATE_TASK_SIZE') {
    biliDB.getTask(data.taskId).then(task => {
      if (!task) { sendResponse({ status: 'ok' }); return; }
      // 仅在体积未知时补全，避免覆盖执行期 quality 阶段上报的实际值
      if (!task.totalSize) {
        const total = ((data.videoSize || 0) + (data.audioSize || 0)) || 0;
        if (total) {
          task.videoSize = data.videoSize || 0;
          task.audioSize = data.audioSize || 0;
          task.totalSize = total;
          biliDB.updateTask(task).then(() => {
            notifySidePanel({ type: 'TASK_UPDATED', data: task });
          });
        }
      }
      sendResponse({ status: 'ok' });
    });
    return true;
  }
```

## Step 2: content-page.js 合集入队后启动补全循环

定位 `showCollectionTab` 内批量下载按钮的 click 处理器中：

```javascript
        // Step 2: Enqueue all tasks to background queue (background dispatches one by one)
        notify('ENQUEUE_TASKS', {
          tasks: taskInfos.map(info => ({
            taskId: info.taskId,
            title: info.title,
            bvid: info.bvid,
            aid: info.aid,
            cid: info.cid,
            quality: '等待中',
            qualityIdx: 0
          }))
        });
        console.log('[B站下载助手] Enqueued', taskInfos.length, 'tasks to background queue');
```

在 `console.log('[B站下载助手] Enqueued', ...)` 之后（仍在同一 click 处理器内）追加：

```javascript
        // 异步补全各任务合计体积：不阻塞入队，单个失败静默跳过（执行期 quality 上报兜底）
        (async () => {
          for (const info of taskInfos) {
            try {
              const d = await getPlayUrl(info.aid, info.bvid, info.cid, 80);
              if (!d?.dash) continue;
              const byQ = {};
              d.dash.video.forEach(v => {
                if (!byQ[v.id]) byQ[v.id] = [];
                byQ[v.id].push(v);
              });
              const topQ = Object.keys(byQ).map(Number).sort((a,b) => b-a)[0];
              const topVideo = byQ[topQ].sort((a,b) => b.bandwidth - a.bandwidth)[0];
              notify('UPDATE_TASK_SIZE', {
                taskId: info.taskId,
                videoSize: topVideo?.size || 0,
                audioSize: d.dash.audio[0]?.size || 0
              });
            } catch(e) {
              console.warn('[B站下载助手] 补全任务体积失败:', info.title, e);
            }
          }
        })();
```

## Step 3: 语法检查

Run（background.js 为 ESM，需以 .mjs 副本检查）：
```powershell
Copy-Item background.js "$env:TEMP\opencode\bg-check.mjs" -Force; node --check "$env:TEMP\opencode\bg-check.mjs"; node --check content-page.js
```
Expected: 无输出（两个检查均通过）

## Step 4: Commit

```powershell
git add background.js content-page.js
git commit -m "feat(download): 合集批量入队后异步补全任务合计体积"
```
