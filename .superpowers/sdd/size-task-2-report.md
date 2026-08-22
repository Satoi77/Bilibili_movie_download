# Task 2 报告：>600MB 大文件警示（sidepanel 常量 + 卡片渲染 + 样式）

## Status: DONE

## 实现内容

### Step 1 — sidepanel.js 新增阈值常量
在 `getTaskSize` 之前的注释处插入（逐字按简报）：
```javascript
// 与 lib/download-core.js 的 MERGE_THRESHOLD 一致：超过此大小跳过 FFmpeg 自动合并，
// 保存分离音视频 + merge.txt，故提前在卡片上提醒用户
const MERGE_SIZE_WARN = 600 * 1024 * 1024;
```

### Step 2 — sidepanel.js 活动任务卡片渲染警示
- 在 `renderTasks` 的 `active.map(t => {...})` 内，`const sizeText = fmtSize(getTaskSize(t));` 之后追加：
  `const sizeWarn = getTaskSize(t) > MERGE_SIZE_WARN;`
- 在活动卡片模板 note 行之后追加 `${sizeWarn ? '<div class="task-warn" title="超过600MB的文件合并时可能内存不足，将保存分离音视频">⚠ 超过600MB，可能无法自动合并为单一视频，完成后需按 merge.txt 手动合并</div>' : ''}`

锚点确认：活动卡片 note 行为 12 空格缩进且后跟 `</div></div>` 反引号结构；已完成卡片（原 225 行）note 行为 8 空格缩进且后跟 `<div class="task-actions">`，两者不混淆。

### Step 3 — sidepanel.css 复用警示样式
`.task-note {` 选择器改为 `.task-note,\n.task-warn {`，规则体不变（margin-top/font-size/line-height/color #ff9800/nowrap/ellipsis）。

## 验证

| 命令 | 结果 |
|---|---|
| `node --check sidepanel.js` | 无输出（通过），随后输出 `SYNTAX_OK` 确认 |
| `git diff --stat` | 仅 `sidepanel.css`（3 ++--）、`sidepanel.js`（6 ++），共 8 insertions / 1 deletion |

## 提交

```
9560a18 feat(download): 任务卡片>600MB大文件提示需手动合并
 2 files changed, 8 insertions(+), 1 deletion(-)
```
只 add 了 `sidepanel.js` 与 `sidepanel.css`；commit 后 `git status --short` 显示两文件已入库，工作区剩余 `?? .superpowers/`（会话工件目录，非本任务改动，未纳入提交）。

## 自审结论

- **Completeness**: 三处编辑全部完成，语法检查通过。
- **Quality**: 警示文案与 title 属性和简报逐字一致（含全角标点、⚠ 符号、merge.txt）；阈值常量名 `MERGE_SIZE_WARN`；锚点确认落在活动卡片模板（`isStop` 上下文 + 12 空格缩进结构唯一匹配）。
- **Discipline**: 已完成列表（completed.map 区域）零改动；commit 只含两个指定文件；未添加简报之外的注释或重构。

## 关注点 / Concerns

无阻塞性问题。两点备注：
1. 警示行复用 `.task-note` 的 nowrap+ellipsis 样式，长文案在窄面板下会截断显示（title 悬停可看全文）——符合简报"规则体不变"的要求，属预期行为。
2. `sizeWarn` 判断基于 `getTaskSize(t)`，依赖前一任务已完成的 totalSize 异步补全；体积未知（0）时不误报。
