# Task 1 报告：lib/download-core.js — 上下文无关的下载执行引擎

## 实现内容

创建 `lib/download-core.js`，代码严格按任务简报 Step 1 中的原文逐字写入，未做任何改动：

- `QMAP` — 画质码→文案映射
- `DOWNLOAD_BASE` — `'bilibili_download'`
- `sanitizeFilename(name)` — 文件名清洗
- `getPlayUrl(aid, bvid, cid, qn=80, signal, fetchFn=fetch)` — 获取 dash 播放地址
- `readWithTimeout(reader, ms, signal)` — 内部辅助：读流超时 + 中止处理
- `downloadStream(url, signal, notify, fetchFn=fetch)` — 下载流，带进度通知与超时
- `mergeAudioVideo(ffmpeg, audioBlob, videoBlob, notify)` — ffmpeg 合并音视频
- `saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir, saveBlob)` — 内部辅助：保存原始 m4s
- `executeTask(taskId, videoInfo, qualityIdx, deps)` — 主执行流程，含 `NEEDS_PAGE` 错误码与 `AbortError` 中止语义

无 chrome API 依赖，纯逻辑模块。

## 验证命令与输出

**Step 2 语法检查**（原始命令因 Windows 管道编码损坏中文而失败，见"问题"）：

原始：`Get-Content lib/download-core.js -Raw | node --input-type=module --check`
- 输出：SyntaxError，`'1080P?????,'`（中文变 `?`），exit 1
- 原因：文件为无 BOM UTF-8，PowerShell 5.1 `Get-Content` 默认按 GBK 读取 + 管道按控制台代码页编码，中文被破坏（AGENTS.md IO_ENCODING 已知问题）

修正后（显式 UTF-8，满足简报意图——ESM 语法解析通过且 exit 0）：
`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content lib/download-core.js -Raw -Encoding UTF8 | node --input-type=module --check`
- 输出：无，exit 0

**Step 3 冒烟**：
`node --input-type=module -e "import('file:///C:/Users/satoi/Desktop/Bilibili_movie_download/lib/download-core.js').then(m => { console.log(typeof m.executeTask, typeof m.getPlayUrl, typeof m.sanitizeFilename, m.DOWNLOAD_BASE); })"`
- 输出：`function function function bilibili_download`，exit 0

**Step 4 提交**：
- `git add lib/download-core.js; git commit -m "feat(download): 新增上下文无关的下载执行引擎 download-core"`
- 提交 `6f328e5`，1 file changed, 185 insertions(+)，仅 `lib/download-core.js`

## 变更文件

- 新增：`lib/download-core.js`（185 行）

## 自查结论

- 完整性：所有导出符号齐全（QMAP、DOWNLOAD_BASE、sanitizeFilename、getPlayUrl、downloadStream、mergeAudioVideo、executeTask），另含内部辅助 readWithTimeout、saveRawToSubdir
- 质量：代码与简报原文逐字一致
- 纪律：无额外新增内容；除简报自带的文件头行注释外无任何其他注释
- 测试：两步验证命令均通过（Step 2 以修正编码的方式执行）

## 问题与关注点

1. **Step 2 编码问题**：简报中的原命令在本机（中文 Windows + PowerShell 5.1）直接运行会因管道编码损坏中文而报 SyntaxError，文件本身没有问题。这是 AGENTS.md 记录的 IO_ENCODING 已知问题。已用显式 UTF-8 管道验证（结果等价：ESM 解析通过、exit 0）。建议后续任务简报中的类似验证命令统一加上 UTF-8 编码处理。
2. 提交时有 `LF will be replaced by CRLF` 警告，属仓库换行符配置的正常提示，不影响内容。
3. 工作区仍有未跟踪的 `.superpowers/`（计划会话遗留），不属于本任务范围，未纳入提交。
