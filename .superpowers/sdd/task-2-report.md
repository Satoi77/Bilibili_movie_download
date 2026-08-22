# Task 2 报告：offscreen.html + offscreen.js — offscreen 下载执行器

## 实现内容

1. **offscreen.html**：`<script src="offscreen.js"></script>` → `<script type="module" src="offscreen.js"></script>`
2. **offscreen.js**：按 brief 逐字重写，新增下载执行引擎：
   - 顶部 `import { executeTask } from './lib/download-core.js'`
   - 原 FFmpeg 合并路径（`loadFFmpeg` / `openMergeDB` / `readBlobFromDB` / `deleteBlobFromDB` / `mergeWithFFmpeg`）完整保留
   - 新增 `FFmpegBridge`（Blob URL Worker 通信桥，含 `Op` 协议 / `RESULT_OPS` / 私有字段）与 `createFFmpeg`（fetch→Blob→BlobURL 加载 ffmpeg-core）
   - 新增后台任务执行：`activeTaskControllers` / `sendToBg` / `notify` / `getSettings` / `saveBlob` / `runOffscreenTask`
   - 消息监听：`OFFSCREEN_PING`（返回 `{status:'ok'}`）、`OFFSCREEN_RUN_TASK`、`OFFSCREEN_ABORT_TASK`、`offscreen_merge_request`（一字不改）
   - 回报消息：`OFFSCREEN_PROGRESS` / `OFFSCREEN_TASK_DONE` / `OFFSCREEN_TASK_ERROR` / `OFFSCREEN_TASK_ABORTED` / `OFFSCREEN_NEEDS_PAGE`

## 验证命令与输出

### 1. 语法检查（UTF-8 安全管道）
```powershell
$OutputEncoding = [System.Text.Encoding]::UTF8
[System.IO.File]::ReadAllText('offscreen.js', [System.Text.Encoding]::UTF8) | node --input-type=module --check
```
输出：无输出，`exit=0`（用 `Write-Output "exit=$LASTEXITCODE"` 确认 `exit=0`）

### 2. 保留 handler 比对
用 node 脚本从 HEAD 版本与工作区版本中提取 `offscreen_merge_request` 块（normalize CRLF→LF 后比对）：
```
OLD handler len 716 NEW handler len 716
MERGE_HANDLER_MATCH
```
即旧版 offscreen.js 中 `offscreen_merge_request` handler 与新版逐字节一致（差异仅为行尾符 LF/CRLF，属 git 自动换行处理）。

### 3. 接口一致性核对
- `lib/download-core.js:102` 导出 `export async function executeTask(taskId, videoInfo, qualityIdx, deps)`
- deps 契约 `{ getSettings, getFFmpeg, notify, saveBlob, signal }` 与 offscreen 传入参数完全对应
- `executeTask` 内使用 `ffmpeg.writeFile/run/readFile/deleteFile`，`FFmpegBridge` 均提供
- `e.code === 'NEEDS_PAGE'` 判定在 `download-core.js`（113/118 行设置）与 `runOffscreenTask`（检查）一致

### 4. HTML 改动确认
`offscreen.html` 第 5 行确为 `<script type="module" src="offscreen.js"></script>`

## 变更文件

- `offscreen.html`（1 行改）
- `offscreen.js`（完整重写，201 insertions / 3 deletions，本次提交）

提交：`4d4caa6 feat(download): offscreen 新增后台下载执行器，监听 OFFSCREEN_RUN_TASK`
（仅暂存上述两个文件；`git status --short` 确认仅有未跟踪的 `.superpowers/` 目录，非本任务范围）

## 自审结论

- **完整性**：四个消息处理齐备（OFFSCREEN_PING / OFFSCREEN_RUN_TASK / OFFSCREEN_ABORT_TASK / offscreen_merge_request）；五种回报消息（PROGRESS/DONE/ERROR/ABORTED/NEEDS_PAGE）齐全
- **质量**：代码与 brief 逐字一致（含中文注释与 `console.log` 文案）
- **纪律**：未改动其他任何文件（未触碰 lib/download-core.js、background.js、content.js、manifest.json）
- **测试**：语法检查通过（exit 0）；merge handler 与旧版逐字节一致

## 问题与关注点

- **`lib/ffmpeg.js` 不存在**：遗留的 FFmpeg 合并路径 `loadFFmpeg()` 引用 `lib/ffmpeg.js`（`loadScript(extUrl('lib/ffmpeg.js'))`），但该文件已被此前提交 `1015006 chore: remove unused npm ffmpeg.js bundle` 移除（当前 `lib/` 仅有 ffmpeg-core.js/.wasm/.worker.js 与 ffmpeg.worker.js）。因此若实际调用 `offscreen_merge_request`，`loadScript` 会抛 "Failed to load"。这是**既有状况**，brief 明确要求原样保留该 handler 且不改其他文件，故未处理，仅提示：遗留合并路径当前不可用（下载主路径已切换到新的 FFmpegBridge 方案，不受影响）。
- 提交时 git 提示 LF→CRLF 换行警告，属仓库 autocrlf 常规行为，无影响。
