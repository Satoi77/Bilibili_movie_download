# Task 3 报告：任务模型 dir/baseName 贯穿（输出路径规则 + 队列透传 + 双执行器）

**Status:** DONE_WITH_CONCERNS
**Commit:** `3582c16` feat(download): 批量任务三级目录输出——dir/baseName 贯穿队列入参到双执行器，路径规则收敛 resolveOutputTargets（4 files changed, +112/-42）

## 一、实现内容

严格按简报 Step 1→9 执行，TDD 流程完整：

1. **resolveOutputTargets 唯一事实源**：lib/download-core.js 新增导出版（纯函数，单测覆盖）；content-page.js 在 MERGE_HARD_LIMIT 之后新增镜像版（经典脚本无法 import ESM，沿用 QMAP/dashSize 跨世界复制先例）。路径规则：有 dir → 合并 `<DOWNLOAD_BASE>/<safeDir>/<safeBase>_<label>.mp4`、分离文件与 merge.txt 落 `<DOWNLOAD_BASE>/<safeDir>/<safeBase>/`（按 baseName 隔离防多P互覆）；无 dir → 与历史行为逐字段一致。
2. **executeTask 接线**（download-core.js）：`safeTitle/subdir` 二行替换为 `const targets = resolveOutputTargets(videoInfo, label)`，7 处引用全部改接 targets。
3. **background.js 透传**：ENQUEUE_TASKS(586)/ENQUEUE_TASK(617) 两处 videoInfo 构造各加 `dir: it.dir || '', baseName: it.baseName || ''`（保持各自原缩进）。
4. **content-page.js 双执行器同构接线**：saveRawToSubdir/saveMergeTxt 签名改为收最终子目录 finalSubdir；executeDownload 内 `safeTitle/baseSubdir` 替换为 targets，实际存在的全部调用点改接完毕。

## 二、TDD 证据

### RED（Step 1→2）
```
$ node test/output-paths.test.mjs
SyntaxError: The requested module '../lib/download-core.js'
does not provide an export named 'resolveOutputTargets'
```
失败原因与简报预期完全一致（导出不存在）。

### GREEN（Step 3→4）
首次按简报代码**逐字**实现后运行：
```
8 passed, 1 failed
✗ 空对象退化为占位名
```
暴露简报自身缺陷（详见关注点①）：`sanitizeFilename('')` 得空串，逐字实现产生 `rawSubdir === 'bilibili_download/'`，而简报自带的测试用例要求退化到占位名 `'bilibili_download/_'`。以测试为可执行规格、按自动修复规则做最小修正——空清洗结果回退 `_` 占位（导出版与镜像版同步加 `|| '_'`）后：
```
$ node test/output-paths.test.mjs
9 passed, 0 failed
```

## 三、验证命令与输出（Step 8 全量回归）

```
$ node test/output-paths.test.mjs      → 9 passed, 0 failed
$ node test/collection-parser.test.mjs → 24 passed, 0 failed   （Task 1 回归无破坏）
$ node test/failure-alert.test.mjs     → 17 通过, 0 失败        （既有回归无破坏）
$ node --check background.js           → 无输出
$ node --check content-page.js         → 无输出
$ node --check lib/download-core.js    → 无输出
EXIT=0
```
迭代过程中每次改动后均单独跑过 focus 测试（output-paths）确认即时反馈。

## 四、改动明细（提交后实际行号）

| 文件 | 位置 | 内容 |
|---|---|---|
| lib/download-core.js | :15-38 | 新增中文"为什么"注释块 + `resolveOutputTargets` 导出版（含 `\|\| '_'` 占位回退） |
| lib/download-core.js | :320 | 删除因此次改造而死的 `const title = videoInfo.title;` |
| lib/download-core.js | :384 | `targets = resolveOutputTargets(videoInfo, label)` |
| lib/download-core.js | :395-396 / :421,:463 / :431,:471,:478 | 7 处引用 → targets.rawSubdir ×5、targets.mergedName+mergedDir ×2 |
| background.js | :586, :617 | 两处 videoInfo 增加 dir/baseName 透传 |
| content-page.js | :290-308 | 镜像版 resolveOutputTargets（含相同 `\|\| '_'` 回退） |
| content-page.js | :367-381, :383-400 | saveRawToSubdir(audioBlob, videoBlob, finalSubdir)、saveMergeTxt(finalSubdir) 新签名；txt 内容未动 |
| content-page.js | :654, :700 | 删除死变量 title；targets 接线（label 于 ：677 先算完，顺序安全） |
| content-page.js | :708,:733,:752 / :725,:768 / :739,:774,:781 | 实际全部 8 个调用点改接 |
| test/output-paths.test.mjs | 新建 | 简报原文逐字 |

## 五、自查结论

- **完整性**：executeTask 7 处 ✓；executeDownload 简报称"6 类共 9 处"，实际文件仅存在 8 个调用点（saveRawToSubdir×3 + downloadFile×2 + saveMergeTxt×3，简报把 saveMergeTxt 多计为 4 处），现存调用点已 100% 改接，无遗漏（grep 验证零残留 baseSubdir/safeTitle/title 引用，78/79 行 title 属无关 UI 函数未触碰）。
- **向后兼容**：无 dir 时三返回值与历史产物名/位置逐字段对照一致（mergedDir=DOWNLOAD_BASE、mergedName=`标题_画质.mp4`、rawSubdir=`DOWNLOAD_BASE/标题`）；background 缺省 `''` 恒走 falsy 分支；download-core 的 saveMergeTxt(saveBlob, subdir) 导出签名未动；三个既有测试全绿佐证。
- **镜像一致性**：除注释外与导出版仅两处写法差异，均为简报原文自带且语义等价——null 守卫风格（页面世界调用点 videoInfo 必非空）、label 无默认参（调用处必传）。
- **验证**：上表命令全部实跑、干净。

## 六、关注点

1. **简报自身不一致（已修）**：简报 Step 3 逐字实现无法通过其 Step 1 用例④。已按测试意图最小修正为 `sanitizeFilename(...) || '_'`，双版本同步。若编排者希望维持逐字实现，则需反向修改测试用例④——二者只能取一，当前取测试侧。
2. **超出简报的两处微清理**：删除了双执行器内因本次改造而失去全部引用的 `const title` 局部变量（零死代码标准；纯局部变量，无行为影响）。
3. **计数偏差**：简报"四处 saveMergeTxt"与实际 3 处不符，属简报统计误差，不影响语义完整性。
4. **工作区遗留**：`.superpowers/sdd/*` 下有其他会话的未提交变更（progress.md、task-1/2 报告简报、review-*.diff 等），按规约未纳入本次提交，提请编排者知悉。
