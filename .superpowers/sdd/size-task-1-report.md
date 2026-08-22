# Task 1 报告：体积异步补全链路

**状态：DONE**

## 实现内容

### 1. background.js — 新增 `UPDATE_TASK_SIZE` 处理器
- 位置：`ENQUEUE_TASK` 处理器结束（原 580 行 `}`）与 `if (type === 'STOP_ALL') {` 之间（现位于 background.js:582-600）
- 逻辑：`biliDB.getTask(data.taskId)` 查任务 → 仅当 `task.totalSize` 为空时用 `videoSize + audioSize` 补全三字段 → `updateTask` 落库后 `notifySidePanel({ type: 'TASK_UPDATED', data: task })` 广播 → `return true` 保持消息通道开放
- 代码与简报 Step 1 逐字一致（含注释）

### 2. content-page.js — 合集入队后启动补全循环
- 位置：`showCollectionTab` 批量下载 click 处理器内，`console.log('[B站下载助手] Enqueued', ...)` 之后、处理器闭合之前（现位于 content-page.js:1003-1025）
- 逻辑：不阻塞入队，IIFE 内逐个 `await getPlayUrl(aid, bvid, cid, 80)`，取最高清晰度中最高码率的视频条目 `.size` 与首条音频 `.size`，经 `notify('UPDATE_TASK_SIZE', ...)` 发给 background；单条失败仅 `console.warn` 静默跳过
- 代码与简报 Step 2 逐字一致（含注释）

## 接口验证
- `notifySidePanel(message)` 存在于 background.js:775 ✓
- `getPlayUrl(avid, bvid, cid, qn=80, signal)` 存在于 content-page.js:52；新调用 `getPlayUrl(info.aid, info.bvid, info.cid, 80)` 与既有 line 832 用法完全同型 ✓
- sidepanel.js 未改动（简报确认 `getTaskSize()` 已兼容回退）✓

## 验证命令与输出

```
> Copy-Item background.js "$env:TEMP\opencode\bg-check.mjs" -Force; node --check "$env:TEMP\opencode\bg-check.mjs"; node --check content-page.js
SYNTAX_OK   （node --check 两项均零输出通过）

> git diff --stat（提交前）
 background.js   | 20 ++++++++++++++++++++
 content-page.js | 24 ++++++++++++++++++++++++
 2 files changed, 44 insertions(+)

> git commit -m "feat(download): 合集批量入队后异步补全任务合计体积"
[master d5aaa16] feat(download): 合集批量入队后异步补全任务合计体积
 2 files changed, 44 insertions(+)

> git status --short（提交后）
?? .superpowers/   （仅报告目录未跟踪，符合预期）
```

## 文件变更
- `background.js`：+20 行（0 删除）
- `content-page.js`：+24 行（0 删除）
- 提交：`d5aaa16` feat(download): 合集批量入队后异步补全任务合计体积（仅含上述两文件）

## 自审结论
- 完整性：两处插入点均按简报锚点精确定位并逐字转录；语法检查通过
- 质量：代码逻辑与简报逐字一致；diff 仅 +44/-0，无重排、无重构、无简报之外的注释
- 纪律：commit 只含指定的两个文件；未触碰单视频下载路径、quality 上报、MERGE_THRESHOLD；docs/ 未动

## 顾虑
- 无。唯一备注：全局约束"仅当 task.totalSize 为空才补全"由处理器内 `if (!task.totalSize)` 保证，执行期 quality 上报的实际值不会被覆盖。
