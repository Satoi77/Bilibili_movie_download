# Task 1 报告：解析核心 lib/collection-parser.js（TDD）

**Status: DONE**
**Commit: 16e5700 feat(parser): 合集两级树解析核心与单测——修复 ugc_season 路径错误并展开全部分P**

## 实现内容

按简报逐字创建两个文件：

1. `lib/collection-parser.js` — 纯函数解析模块（无 DOM/chrome 依赖）：
   - `extractInitialState(html)`：正则提取 `window.__INITIAL_STATE__=` 后的 JSON 并剥离尾随 IIFE 脚本；无匹配/坏 JSON/空输入返回 null
   - `buildCollectionTree(state)`：四级数据源优先级 —— ① `videoData.ugc_season.sections[].episodes[]` 合集模式（多 section 平铺、bvid 去重；pages 缺失时依次 availableVideoList 同 bvid 匹配 → 单P降级 cid=ep.cid）② 单视频多P ③ 单P ④ null（调用方 DOM 兜底）
   - `typeof window !== 'undefined'` 时挂载 `window.BiliCollectionParser`（Node 下自动跳过）
2. `test/collection-parser.test.mjs` — 自写 assert/eq helper 的单测，覆盖简报全部断言（24 条）

## TDD Evidence

### RED（先写测试，亲眼看失败）

命令：`node test/collection-parser.test.mjs`

关键输出：
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\satoi\Desktop\Bilibili_movie_download\lib\collection-parser.js'
    ... imported from ...\test\collection-parser.test.mjs
EXIT=1
```

为何是预期失败：实现文件尚不存在，ESM 解析期即报模块找不到（简报 Step 2 预期的"文件尚不存在或无导出"情形之一），退出码 1。此时测试已先行落地，满足 TDD 铁律。

### GREEN（再写实现，全绿）

命令：`node test/collection-parser.test.mjs`

关键输出：
```
extractInitialState
  ✓ 提取 JSON 并剥离尾随脚本 / 无状态脚本返回 null / 坏 JSON 返回 null / 空串返回 null
buildCollectionTree ① 合集模式（真实结构裁剪自 BV1sJwezxEpJ）
  ✓ 10 条全过（含跨 section 平铺去重=4组、availableVideoList 回退、单P降级）
buildCollectionTree ② 单视频多P回退 ✓ 3 条
buildCollectionTree ③ 单P回退 ✓ 3 条
buildCollectionTree 兜底返回 null ✓ 3 条

24 passed, 0 failed
EXIT=0
```

退出码 0，输出干净无警告。

## 变更文件

- 新增 `lib/collection-parser.js`
- 新增 `test/collection-parser.test.mjs`
- 提交仅含上述两文件（`git add` 精确指定，未用 `-A`/`.`）

## Self-Review

- **Completeness**: 简报全部断言逐条落实于测试；接口签名与简报一致（两个导出 + window 挂载副作用）；group 字段结构与简报 §Interfaces 完全一致。
- **Quality**: 与仓库既有 lib/*.js 风格一致（ESM 导出）；注释全部为简报原文的中文"为什么"风格，原样保留。
- **Discipline**: 未添加简报之外的任何功能（YAGNI），代码逐字采用简报版本。
- **Testing**: RED → GREEN 证据齐全如上。

## Concerns

- 无功能性问题。备注两点非阻塞事项：① git 提示 LF→CRLF 换行警告，属 Windows autocrlf 常规行为，不影响内容；② 工作区存在其他会话遗留的未提交变更（`.superpowers/sdd/task-1-brief.md` 修改与 `.superpowers/sdd/task-brief.mjs` 未跟踪），按要求未纳入本次提交，请知悉。

## Fix: 消除 pages→parts 映射重复

**问题**：episodeParts 合集分支与 uildCollectionTree 单视频多P分支各有一份逐字相同的 pages.map(pg => ({ p, cid, title, duration })) lambda。这是分P字段归一化核心规则，两处必须永远一致，逐字重复极易在后续改动中漂移失配。

**修复**：在 lib/collection-parser.js 提取模块私有助手 mapPages(pages)（含中文"为什么"注释），两个分支改为调用 mapPages(ep.pages) / mapPages(vd.pages)。行为、导出接口、其余代码不变；未改动任何测试文件。

**验证**：仓库根目录运行 \
ode test/collection-parser.test.mjs\：

\\\
extractInitialState
  ✓ 提取 JSON 并剥离尾随脚本
  ✓ 无状态脚本返回 null
  ✓ 坏 JSON 返回 null
  ✓ 空串返回 null
buildCollectionTree ① 合集模式（真实结构裁剪自 BV1sJwezxEpJ）
  ✓ 合集名取 ugc_season.title
  ✓ 跨 section 平铺 + bvid 去重 = 4 组
  ✓ g0 标识字段
  ✓ cover 取 arc.pic
  ✓ g0 按 pages 展开三P
  ✓ p 序号来自 page 字段
  ✓ part 字段映射
  ✓ 空 pages 经 availableVideoList 回退
  ✓ 回退条目字段正确
  ✓ 无任何来源降级为单P
  ✓ 单P降级 cid 取 episode 自身
buildCollectionTree ② 单视频多P回退
  ✓ 合集名取视频标题
  ✓ 单一分组
  ✓ 三分P全部展开
buildCollectionTree ③ 单P回退
  ✓ 单组
  ✓ 单P
  ✓ cid 正确
buildCollectionTree 兜底返回 null
  ✓ null state
  ✓ 空 state
  ✓ 无 bvid/cid

24 passed, 0 failed
\\\

退出码 0。

**提交**：9498c83 refactor(parser): 提取 mapPages 助手消除 pages→parts 映射逐字重复（仅 lib/collection-parser.js，1 file changed）
