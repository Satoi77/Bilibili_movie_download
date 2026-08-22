# Task 2 报告：注入接线与嗅探重写（manifest + content.js + content-page.js）

**Status: DONE_WITH_CONCERNS（唯一 concern：Step 7 手动冒烟待用户验收）**

## 实现内容

严格按简报 Step 1→8 顺序执行，代码逐字采用简报给定版本：

1. **manifest.json:36** — `web_accessible_resources.resources` 加入 `"lib/collection-parser.js"`。
2. **content.js:5-16** — 原注入块之前插入解析器注入块：`<script type="module">` 方式加载 `lib/collection-parser.js`（id `bilibili-dl-parser`），先于 content-page.js 注入；保留原"先后顺序不保证、轮询兜底"注释。
3. **content-page.js:14-22** — `notify` 之后新增 `ensureParser()`：轮询 `window.BiliCollectionParser`（50×100ms = 5 秒上限），超时抛 `'合集解析器未就绪'`。
4. **content-page.js:29-37** — 删除整个旧 `parseInitialState`（已 grep 确认全仓无其他调用方）；`getVideoInfo` 改为 `fetchPageHTML → ensureParser → parser.extractInitialState(html)`，返回形状 `{aid,bvid,cid,title,pages}` 完全不变（单视频下载路径向后兼容）。
5. **content-page.js:60-89** — `sniffCollection()` 整体替换：先走解析器 `buildCollectionTree` 返回两级树；失败/无树时 DOM 兜底产出 `{collectionName, groups}`，兜底组形状 `{title, bvid, aid:'', cover:'', partsKnown:false, parts:[]}`。返回 null 当且仅当兜底也无视频。
6. **content-page.js:91-107** — 新增临时适配层 `flattenTreeToLegacyVideos(tree)`：`partsKnown && parts.length>0` 的组按 parts 展开为 `{bvid, aid, cid, title}`（多P时标题拼 `P{n} {part.title}`）；否则整组输出 `{bvid, aid, title}`（无 cid → 入队时经 getVideoInfoByBvid 展开）。Task 4 移除。
7. **content-page.js:986-987 / 1005 / 1042 / 批量处理器 Step 1 循环** — showCollectionTab 适配：解构改为 `tree + flattenTreeToLegacyVideos`；模板与闭包 console 两处 `collectionName` → `tree.collectionName`；批量点击处理器把单条 push 替换为多P展开（`info.pages.length > 1` 时每P一个任务单元，cid/title 按 page 取，否则维持单任务）。

未改动任何其他文件、任何输出路径逻辑、UI 其他区域。

## 验证命令与实际输出

```
node --check content-page.js   → 无输出（通过）
node --check content.js        → 无输出（通过）
node --check background.js     → 无输出（通过）
node test/collection-parser.test.mjs → 24 passed, 0 failed
node test/failure-alert.test.mjs     → 结果: 17 通过, 0 失败
```
链尾探针 `ALL_TESTS_EXIT_0` 打印，整体退出码 0。

补充静态自检：
- `parseInitialState` 在源码中零残留（仅历史简报/diff 归档文件中出现）；
- content-page.js 中剩余 `collectionName` 引用全部合法（sniffCollection 内局部变量两处、showCollectionTab 的 `tree.collectionName` 两处）；
- `sniffCollection` 仅 showCollectionTab 一处调用方，旧形状 `{videos, collectionName}` 解构已不存在。

## 文件变更（实际行号，改造后）

| 文件 | 变更 |
|---|---|
| manifest.json | :36 |
| content.js | :5-16（新增解析器注入块） |
| content-page.js | :14-22 ensureParser；:29-37 getVideoInfo 重写+删 parseInitialState；:60-107 sniffCollection 替换+flattenTreeToLegacyVideos；:986-987/:1005/:1042/:1058-1073 showCollectionTab 适配 |

## 提交

- d6e4ef1 `feat(collection): 页面接入两级树解析器，修复嗅探路径并把合集各视频全部分P纳入批量下载`（3 files changed, 79 insertions(+), 102 deletions(-)）

工作区另有 `.superpowers/sdd/` 下其他会话遗留变更（progress.md、task-1-*、task-2-brief.md 及未跟踪脚本/diff），按纪律未纳入本次提交。

## 自检发现

- Completeness：8 个 Step 全部处理；flattenTreeToLegacyVideos 对 partsKnown=false 组输出 `{bvid, aid, title}` 无 cid，正确触发批量处理器的 getVideoInfoByBvid 分支（DOM 兜底组 aid='' 为 falsy 同样命中该分支）。
- Quality：旧 parseInitialState 删净；全部中文"为什么"注释随代码逐字带入。
- Discipline：未动输出路径/UI 其他区域；多P展开仅替换了简报指定的 push 块。

## Concerns

1. **Step 7 手动冒烟待用户手动验收**（需 chrome://extensions 加载扩展）：打开 https://www.bilibili.com/video/BV1sJwezxEpJ → 控制台应出现 `[B站下载助手] Page script loaded` → 合集嗅探 tab 应显示 55 个平铺单元（6 视频全部分P），而非当前视频的 11 分P。
2. 多P展开的 taskId 由 `Date.now()+Math.random()` 生成，同一循环内毫秒碰撞理论可能但随机后缀使其概率可忽略（简报原文如此，未偏离）。
