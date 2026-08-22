# Task 2 简报：>600MB 大文件警示（sidepanel 常量 + 卡片渲染 + 样式）

## Files
- Modify: `sidepanel.js`（常量加在 `getTaskSize` 之前的注释处；渲染改动在 `renderTasks` 活动任务卡片模板）
- Modify: `sidepanel.css`（`.task-note` 规则的选择器扩展为 `.task-note, .task-warn`）

## Interfaces
- Consumes: `getTaskSize(task)`（sidepanel.js 已有，返回字节数 number，无体积时为 0）
- Produces: 活动任务卡片上的 `.task-warn` 警示行

## Global Constraints（必须遵守）
- 警示文案（逐字）：`⚠ 超过600MB，可能无法自动合并为单一视频，完成后需按 merge.txt 手动合并`
- 已完成列表不加大文件警示（只改活动任务卡片模板）
- 阈值常量名必须是 `MERGE_SIZE_WARN`
- 提交信息风格：`feat(download): 中文描述`；只精确 add 本任务改动的文件

---

## Step 1: sidepanel.js 新增阈值常量

在 sidepanel.js 中定位注释与函数：

```javascript
// 任务总体积：优先用执行期上报的 totalSize，回退到入队时携带的音视频分项
function getTaskSize(task) {
```

在该注释之前插入：

```javascript
// 与 lib/download-core.js 的 MERGE_THRESHOLD 一致：超过此大小跳过 FFmpeg 自动合并，
// 保存分离音视频 + merge.txt，故提前在卡片上提醒用户
const MERGE_SIZE_WARN = 600 * 1024 * 1024;
```

## Step 2: sidepanel.js 活动任务卡片渲染警示

在 `renderTasks` 的 `active.map(t => {...})` 内，定位：

```javascript
      const isStop = t.status === 'downloading';
      const controlIcon = isStop ? ICON_PAUSE : ICON_PLAY;
      const sizeText = fmtSize(getTaskSize(t));
```

在 `sizeText` 行之后追加一行：

```javascript
      const sizeWarn = getTaskSize(t) > MERGE_SIZE_WARN;
```

然后在模板字符串中，定位**活动任务卡片**的进度区结尾（注意：已完成卡片也有相似的 note 行但缩进不同——已完成卡片 note 行前是 8 个空格，活动卡片是 12 个空格；以下锚点为活动卡片专属）：

```javascript
            ${t.note ? `<div class="task-note" title="${t.note}">${t.note}</div>` : ''}
          </div>
        </div>
      `;
```

改为：

```javascript
            ${t.note ? `<div class="task-note" title="${t.note}">${t.note}</div>` : ''}
            ${sizeWarn ? '<div class="task-warn" title="超过600MB的文件合并时可能内存不足，将保存分离音视频">⚠ 超过600MB，可能无法自动合并为单一视频，完成后需按 merge.txt 手动合并</div>' : ''}
          </div>
        </div>
      `;
```

## Step 3: sidepanel.css 复用警示样式

定位 `.task-note` 规则（约 176 行起）：

```css
.task-note {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: #ff9800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

把选择器改为共享（规则体不变）：

```css
.task-note,
.task-warn {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: #ff9800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

## Step 4: 语法检查

Run:
```powershell
node --check sidepanel.js
```
Expected: 无输出

## Step 5: Commit

```powershell
git add sidepanel.js sidepanel.css
git commit -m "feat(download): 任务卡片>600MB大文件提示需手动合并"
```
