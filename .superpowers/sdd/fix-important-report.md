# 全分支代码评审三项修复报告

日期：2026-08-21

## 修复内容（按 Fix 编号）

### Fix 1 — 下载进度分相上报（Important）

`lib/download-core.js`：

- `downloadStream` 签名由 `(url, signal, notify, fetchFn = fetch)` 改为 `(url, phase, signal, notify, fetchFn = fetch)`（第 43 行）。
- 循环内进度上报由 `notify({ phase: 'download', percent, label: '下载中' })` 改为 `notify({ phase, percent, label: '下载中' })`（第 60 行），使音/视频流各自上报 `'audio'` / `'video'` 相位。
- `executeTask` 中两处调用分别传入相位：
  - `downloadStream(bestAudio.baseUrl, 'audio', signal, notify, fetchFn)`（第 140 行）
  - `downloadStream(bestVideo.baseUrl, 'video', signal, notify, fetchFn)`（第 141 行）
- `executeTask` 中保留原有 `notify({ phase: 'download', percent: 0, label: '下载中' })`（第 137 行）与 `notify({ phase: 'download', percent: 100, label: '下载完成' })`（第 145 行），未改动。

### Fix 2 — FFmpegBridge worker 崩溃死锁（Important）

`offscreen.js`：

- 在 `FFmpegBridge` 构造函数中 `this.#attachReceiver();` 之后新增 `this.#worker.onerror` 处理器：构造错误、清空并 reject 所有 `#pending`、置 `ready = false`。合并中 worker 崩溃后 `ffmpeg.run()` 不再永久挂起，队列可自愈而非永久死锁（否则 20s 合并心跳会不断刷新 `lastProgressAt`，5 分钟停滞检测永不触发）。

### Fix 3 — offscreen_merge 缺少 .catch（Minor）

`background.js`：

- `offscreen_merge` 处理器的 `ensureOffscreen().then(...)` 追加 `.catch(() => {})`，避免 ~10s 就绪探测超时抛错造成未处理 rejection 与静默丢弃合并请求。

## 验证命令与输出

以下命令均以 UTF-8 方式读取文件后经 `node --input-type=module --check` 校验（PowerShell 5.1 GBK 管道转码防护）：

```
$OutputEncoding = [System.Text.Encoding]::UTF8; [System.IO.File]::ReadAllText('lib/download-core.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
→ download-core.js OK

$OutputEncoding = [System.Text.Encoding]::UTF8; [System.IO.File]::ReadAllText('offscreen.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
→ offscreen.js OK

$OutputEncoding = [System.Text.Encoding]::UTF8; [System.IO.File]::ReadAllText('background.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
→ background.js OK
```

Fix 1 接线 grep 确认：

- `download-core.js:140` → `downloadStream(bestAudio.baseUrl, 'audio', signal, notify, fetchFn)`
- `download-core.js:141` → `downloadStream(bestVideo.baseUrl, 'video', signal, notify, fetchFn)`
- `background.js:242-243` → `OFFSCREEN_PROGRESS` 映射 `data.phase === 'audio'` / `'video'`

## 变更文件

- `lib/download-core.js`（Fix 1）
- `offscreen.js`（Fix 2）
- `background.js`（Fix 3）

## 自审结论

- Fix 1：`downloadStream` 相位参数已贯通两处调用点；循环内无遗留 `notify({ phase: 'download', ...})`（grep 确认仅剩 executeTask 中第 137/145 行 0%/100% 两个 no-op）。
- Fix 2：`worker.onerror` 已存在（offscreen.js:134），reject 全部 pending 并置 `ready = false`。
- Fix 3：`.catch(() => {})` 已追加（background.js:676）。
- 三个文件语法校验全部通过；未改动任何其他文件。

## 提交

- `git add lib/download-core.js offscreen.js background.js`（仅这三个文件）
- commit message：`fix(download): 下载进度按音视频分相上报，FFmpeg worker 崩溃自愈，offscreen_merge 补 catch`
