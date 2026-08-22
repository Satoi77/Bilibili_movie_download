# Task 4 报告：合集 tab 两级树形 UI 重写

**Status: DONE**
**Commit: e008e8f `feat(ui): 合集tab两级树形勾选——父子三态联动+统一画质选择+按分P批量入队`（仅含 content-page.js，1 file changed, +249/-147）**

## 实现内容

1. **UI 工具函数新增（content-page.js:783-793）**：在 `let currentVideoInfo = null;` 之后按简报逐字新增 `escAttr` / `fmtDur` / `padP` 三个函数。
2. **删除 `currentCollectionVideos` 全部引用点（零残留）**：
   - 声明 `let currentCollectionVideos = [];`（原 :800）— 已删
   - showCollectionTab 内赋值 `currentCollectionVideos = videos;` — 随函数整体替换删除
   - waitAndInit 内清零 `currentCollectionVideos = [];`（原 :1150）— 已删；`currentVideoInfo = null;` 按要求保留
3. **删除 Task 2 临时适配层 `flattenTreeToLegacyVideos`**：连同其注释「旧版扁平列表 UI 适配层…」一并移除。
4. **showCollectionTab 整体替换（content-page.js:981-1232，252 行）**：简报 Step 2 代码逐字落地（程序化校验 252 行逐行 identical），包含：两级树渲染（renderTree/groupBadge）、父子三态联动（syncGroupVisual 的 checked/indeterminate）、全选、展开/收起箭头旋转、已选分P计数与按钮态（updateCounts）、统一画质 radio（probeLoop 对首个可用分P枚举一次）、onBatchGo 按 `directUnits + expandGroups(DOM兜底 getVideoInfoByBvid 展开)` 入队，条目形状 `{taskId, aid, bvid, cid, title:'<一级标题> | <P0n_分P名>', qualityIdx, quality, dir:'<合集名>/<一级标题>', baseName:'<P0n_分P名>'}`，入队后异步 UPDATE_TASK_SIZE 补体积。

## 验证命令与实际输出

| 命令 | 结果 |
|---|---|
| `node --check content-page.js` | 通过（无输出，脚本打印 syntax OK） |
| `node test/collection-parser.test.mjs` | **24 passed, 0 failed** |
| `node test/output-paths.test.mjs` | **9 passed, 0 failed** |

## 文件改动区间

- content-page.js:
  - :783-793 新增 escAttr/fmtDur/padP
  - :90-106 删除 flattenTreeToLegacyVideos 及注释（改造前位置）
  - :981-1232 showCollectionTab 整体替换（142 行 → 252 行）
  - waitAndInit 内清零行删除（现 :1252 仅剩 currentVideoInfo 清零）

## Self-Review 发现

- **Completeness**：grep 复核证据 —— content-page.js 中 `currentCollectionVideos` 与 `flattenTreeToLegacyVideos` 命中数为 **0**（仅 .superpowers/sdd/ 下历史文档有命中，非代码）；escAttr/fmtDur/padP 定义各 1 处、调用点齐全。新函数体与简报代码 **252 行逐字一致**（node 程序化比对输出 VERBATIM MATCH）。
- **Quality**：XSS 覆盖 —— 所有用户数据插值点（collectionName/g.title/pt.title）均经 escAttr 双重转义（title 属性 + 文本内容）；三态联动逻辑：父勾选→parts 全映射、子勾选→syncGroupVisual 设 indeterminate、无 parts 组直接用 checked；画质 radio 取值带 `?.value || '0'` 兜底。
- **Discipline**：未触碰本任务外区域；git 提交仅暂存 content-page.js（未用 git add -A）。工作区中 .superpowers/sdd/*.md 等改动为其他会话遗留，未纳入提交。

## 过程说明（一处执行方式偏差）

首次尝试用 Edit 工具整体替换失败：文件空白行含尾随空格且不可见，无法精确复现 oldString。改用 Node 脚本按语义标记定位函数边界（`async function showCollectionTab() {` 起、`// ─── Init ───` 前的 `}` 止，并校验中间无其他内容）做行区间拼接，保持 CRLF/UTF-8 无 BOM 不变，拼接后经 node --check、双测试套件与逐字比对三重验证。

## Concerns

- 无阻塞项。
