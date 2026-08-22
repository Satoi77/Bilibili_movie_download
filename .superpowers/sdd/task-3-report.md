# Task 3 Report: manifest.json CSP + content.js 防广播回声过滤

## Status: DONE

## What I implemented

1. **manifest.json**: 在 `host_permissions` 块之后、`background` 块之前，按 brief 精确插入 `content_security_policy` 块（2 空格缩进，与既有风格一致）：
   - `"extension_pages": "script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'self'"`
   - 使 offscreen 文档内可 `new Worker(blobURL)` 运行 FFmpeg。

2. **content.js**: 将文件末尾「转发其他消息到 background」块替换为带 `OFFSCREEN_*` 过滤的版本：
   - 新增 `if (type.startsWith('OFFSCREEN_')) return;` 守卫，防止 offscreen 上报进度/结果时 content script 广播回声导致 background 重复处理。
   - 注释更新为中文，与项目注释风格一致。

未修改其他任何文件。

## Verification commands and exact output

- `node --check content.js` → 无输出，exit code 0 ✓
- `Get-Content manifest.json -Raw | ConvertFrom-Json | Out-Null; echo "JSON OK"` → **失败**（见下方 Concerns）

补充验证（确认 JSON 实际有效）：
- `Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null; echo "JSON OK (UTF8 read)"` → 输出 `JSON OK (UTF8 read)` ✓
- 以原始字节按 UTF-8 解码后再 `ConvertFrom-Json` → 通过 ✓（BOM: False）

## Files changed

- `manifest.json`（+3 行：content_security_policy 块）
- `content.js`（+2 行：OFFSCREEN_* 守卫 + 注释变更）
- 提交：`4162c12 fix(manifest): 放宽 blob: worker CSP 供 offscreen 使用，content.js 过滤 OFFSCREEN_* 防回声`

## Self-review findings

- 两处改动与 brief 完全一致，diff 审查确认仅这两文件、无多余改动。
- content.js 语法检查通过；JSON 经 UTF-8 显式读取验证合法。
- 提交仅暂存 manifest.json 与 content.js；工作区其余未跟踪项为 `.superpowers/`（任务基础设施目录），未纳入提交。

## Issues / concerns

- **brief 的验证命令在 PowerShell 5.1 中文系统下必然失败**：`Get-Content` 默认按 ANSI(GBK) 读取无 BOM 的 UTF-8 文件，会破坏文件内既有的中文 `description` 字符串，导致 `ConvertFrom-Json` 报错（"应为:...实际为..."，定位到第 142 字符附近的乱码）。这是**文件内容原本就存在的 UTF-8 中文**造成的读取端编码问题，与本次改动无关（改动前该命令同样会失败）。显式加 `-Encoding UTF8` 后验证通过。建议在 plan 中将该验证命令更新为 UTF-8 显式读取版本。
