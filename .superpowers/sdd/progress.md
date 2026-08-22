# Subagent-Driven Development 进度台账
# 项目：Bilibili_movie_download — offscreen 后台下载改造
# 计划：docs/superpowers/plans/2026-08-21-offscreen-background-download.md
# 分支：master（用户同意直接实施）
# BASE commit: 9da799e

- [x] Task 1: lib/download-core.js 执行引擎 (commits 9da799e..6f328e5, review clean)
- [x] Task 2: offscreen.html + offscreen.js 下载执行器 (commits 6f328e5..4d4caa6, review clean)
- [x] Task 3: manifest CSP + content.js 过滤 (commits 4d4caa6..4162c12, review clean)
- [x] Task 4: background.js 队列派发改造 (commits 4162c12..1adfc9d, review clean)
- [x] 终审 (9da799e..1adfc9d): With fixes → 2 Important + 1 Minor
- [x] Fix: 下载进度 audio/video 分相 + FFmpegBridge worker.onerror 自愈 + offscreen_merge .catch (commit 5bbc6fa, re-review ✅)
- [x] CSP 热修复1: blob: 从 script-src 移至 worker-src（Chrome 拒绝，扩展无法加载）(commit e8c91e4)
- [x] CSP 热修复2: offscreen 改用扩展 URL 创建 FFmpeg Worker，CSP 移除全部 blob:（Chrome 同样拒绝 worker-src 的 blob:）(commit e06d534)
- [x] 403 热修复1: offscreen 流下载显式设置 bilibili Referer (commit dbfb6d4)
- [x] 403 热修复2: referrer 加 unsafe-url 策略确保生效 + 流 403 兜底切宿主 tab (commit b66a7b0)
- [x] 队列卡死修复: offscreen 假死自动探测重派发 + 任务 30min 时长上限兜底 (commit 0b33637)
- [x] 保活心跳 + 宿主 tab 就绪判定: offscreen 15s 心跳防 SW 休眠销毁，content-page.js 就绪才派发 RUN_TASK (commit 09248c0)
- [x] 原位重启: 停滞任务保持原位重启优先恢复，不再跳到下一个任务 (commit b3582cb)
- [x] Task 5: 端到端验证 — 全部场景 ✅（核心下载+合并 / 场景1 切走页面继续 / 场景2 批量关闭页面继续+停滞原位重启，用户实测确认）

## 审查发现（Minor 积累，终审前处理）
- Task 1 (download-core.js): 并行流下载一个失败不取消另一个（:151-154）；dash 空守卫（:144,154-155）；readWithTimeout abort 监听器可能泄漏（:42-63）；无 content-length 时 percent=-1 且从不通知（:69,81）；merged.buffer 尺寸假设（:102）。均为计划自带设计。
- Task 2 (offscreen.js): createFFmpeg 无并发初始化守卫（:210-229，因队列 queueBusy 单任务派发，实际不并发触发）；#pending 悬挂（:124-198）；writeFile 转移 buffer 边界（:179-182）；sendToBg 静默吞错（:234-236）。plan-mandated。
- Task 3: 无缺陷。流程建议：plan 验证命令 `Get-Content` 应加 `-Encoding UTF8`（PS 5.1 GBK 读取问题）。
- Task 4 (background.js): offscreen_merge handler 无 .catch 且新版 ensureOffscreen 可能 throw（:674，低概率 + legacy 路径）；TASK_ABORTED（宿主 tab）未清 inFlightExecutor（:632-646，自愈型陈旧值）；checkStalledTasks 未复位 inFlightExecutor（:137-140，brief 指定不改）。

# ===== 新计划：任务卡片合计体积 + >600MB 提醒 =====
# 计划：docs/superpowers/plans/2026-08-21-task-card-size-and-large-file-warning.md
# 分支：master（沿用本仓库直接实施惯例）
# BASE commit: 80a3899
- [x] Task 1: 体积异步补全链路 (commits 80a3899..d5aaa16, review clean; Minor[plan-mandated]: UPDATE_TASK_SIZE .then 链无 .catch，优雅降级，留终审 triage)
- [x] Task 2: >600MB大文件警示 (commits d5aaa16..9560a18, review clean; Minor[plan-mandated]: sizeWarn 也显示在 pending/paused/failed 卡片=设计既定; getTaskSize 重复调用可忽略)
- [x] 终审 (80a3899..9560a18): Ready to merge=Yes，零 Critical/Important
  - Minor 延后: background.js UPDATE_TASK_SIZE .then 无 .catch（仓库既有模式）; getTaskSize 双调用; 读改写竞态窗口（毫秒级自愈）
  - 已办: 规格 4.3 竞态语义描述修正（估算填空隙、实际值无条件覆盖）
  - 待办: Task 3 手动实测（用户执行：合集体积填充 / >600MB 警示 / 删除竞态 / test-merge 回归）
- [x] 缺陷修复: 用户实测容量不显示 → 实证 B站 playurl dash size 字段返回空（根因=上游数据契约变更，非 UI 问题），三路体积来源全为 0。修复: dashSize 两级兜底(size→bandwidth×duration 估算)+下载后真实字节回写修正，8 处编辑 (commit 5a3d647)。待用户复测
- [x] 缺陷修复: 用户实测 3.21GB 大视频保存失败只剩 merge.txt。根因=SAVE_FILE 协议在下载条目创建时即应答成功,offscreen/content 两处调用方 5 秒后 revokeObjectURL,GB 级文件尚未从 blob URL 拷完即被中断;content-page 兜底路径另有 arrayBuffer 多重拷贝 OOM 隐患。修复: SAVE_FILE 改为 onChanged 终态确认(complete/interrupted 才响应+30min 超时兜底),调用方收到响应立即 revoke;Blob 引用直传替代 buffer 拷贝 (commit 014d605)。待用户复测大文件
- [x] 缺陷修复: 用户报告每次入队任务都会自动打开 B 站首页 tab(兜底变默认)。根因=offscreen.js OFFSCREEN_RUN_TASK 分支启动任务后不 sendResponse,pumpQueue await sendMessage 在 MV3 下必然 reject('message port closed'),误入 dispatchToHostTab 开兜底 tab;任务本身在 offscreen 正常执行故下载不受影响。content.js RUN_TASK 转发分支同款缺陷(dispatchToHostTab 会把执行中任务误标失败)。修复: 两处补 sendResponse({status:'ok'}) 受理应答 (commit 1cfa331)。待用户复测入队不开新 tab
- [x] 缺陷修复: 用户反馈仍弹 B 站首页且发起视频页一直开着。根因=ensureHostTab 只认内存变量 hostTabId(SW 重启即丢),从不查找已存在的 B 站页面,永远 tabs.create 新开首页;入队时记录的 task.hostTabId(发起页 tab id)只用于开侧边栏从未被执行器消费。另确认 offscreen 主通道因 B 站 wbi playurl 风控收紧真实返回 NEEDS_PAGE,兜底成为常态路径。修复: ensureHostTab 四级优先级(内存记录→任务发起页→任意就绪B站页→新建首页)+hostTabAutoCreated 所有权标记(仅自动新建的 tab 允许 maybeCloseHostTab 回收) (commit 3a2b8a7)。待用户复测:开着视频页入队不再新开首页
- [x] 功能: 设置页新增「使用说明」手风琴(原生 details/summary,零JS,键盘可达)。四条目: 如何下载视频/大视频超过600MB怎么办(分离文件观看与本地合并方法)/要不要关闭B站页面(后台通道vs页面通道分情况)/文件保存在哪里。内容全部依据真实代码行为撰写(saveRawFiles/MERGE_THRESHOLD/merge.txt命令/宿主tab复用策略)。slop检测范围内清零(修复步骤编号对比度#0095c8→#00698f) (commit 26dd776)。HelpAccordion.preview.html 为临时预览页,用户确认后删除
- [x] 功能: 大视频合并策略改造——取消 >600MB 一刀切跳过合并。新流程: 先落盘分离文件作保底 → 仍尝试合并(内存边界处有机会成功) → 成功且未开 saveRawFiles 时经 downloadId 链路(chrome.downloads.removeFile)删除保底文件 / 失败则保底文件直接可用+merge.txt。MERGE_THRESHOLD 语义从"跳过合并门槛"变为"先落盘保险门槛"。offscreen/content-page 双通道平行改造, SAVE_BLOB 协议透传 downloadId, background 新增 DELETE_SAVED_FILE (commit 317c7a5)。待用户复测: 大文件先出分离文件再尝试合并
- [x] 调研+实验分支: ffmpeg.wasm 内存上限方案。结论: wasm32 4GB 需构建期 opt-in(MAXIMUM_MEMORY=4GB), 官方0.12单线程构建堆~2GB; WORKERFS 挂载输入不占堆是社区验证突破口(ffmpeg-browser-4gb-plus 处理5GB输入成功); memory64 无官方 ffmpeg 构建暂不可行。已建 feature/ffmpeg-4gb 分支: worker 加 PROBE/MOUNT_WORKERFS 指令 + test/memory-probe 诊断页 + sidepanel 入口 (commit bb9debd)。用户实测诊断页后决定是否自编译 4GB 构建
- [x] 实验: feature/ffmpeg-4gb 分支内存诊断三轮迭代并出最终结论。过程修两个自研 bug: ①诊断页 updateStep 假设 .detail 元素存在而 addStep 按条件创建, 展示路径自身崩溃吞掉真实错误(用户看到的"加载失败"全是伪装), 修复 aac154c, 沉淀 debug-patterns 模式145(错误呈现路径健壮性必须高于被呈现的错误); ②堆探测判读修正——PROBE 读的是 INITIAL_MEMORY 快照(32MB)非上限, 写入阶梯证明 ALLOW_MEMORY_GROWTH 正常(1536MB 实证)。最终实测: 页面侧 2048MB ArrayBuffer 分配失败(Chrome 单块 ~2GB 上限)+wasm 默认 MAXIMUM_MEMORY 2GB = 官方构建双重天花板, 合并总大小封顶 ~1GB; WORKERFS 未打包。600MB 阈值获实测背书; 升级唯一解=自编译 4GB 构建+WORKERFS 输入挂载(绕开 ArrayBuffer 上限), 理论可合并 ~3.5GB (commits bb9debd..1d6186e)。待用户决策是否投入自编译
- [x] 合并: 用户决策暂不自编译 4GB 构建, feature/ffmpeg-4gb 全部合入 master(fast-forward 317c7a5→ba146b9)。master 现含: 大文件保底合并策略(317c7a5) + 内存诊断工具链(bb9debd..1d6186e) + 外来会话的 CDN 兜底与失败告警条(5c5a5be/01695a1)。全量 node --check 通过。诊断页保留于 test/memory-probe.html(设置页入口), 未来若启动自编译可直接复用
- [x] 清理: 诊断页从设置页移除并删除 test/memory-probe.* (d785124), worker 的 PROBE/MOUNT_WORKERFS 指令保留供自编译复用, 结论固化于 README-TEST.md
- [x] 优化: 基于实测内存数据的大文件处理审计与改造 (d74327f)。内存轨迹分析发现合并链路峰值实为 ≈3×总大小(输入2T+输出T+readFile再拷T), 实测 wasm 上限 2GB 下实际只能合并 ≤650MB。落地两项: ① mergeAudioVideo/mergeWithFFmpeg 先删输入再 readFile(峰值 3T→2T, 可合并上限提升至 ~950MB); ② 新增 MERGE_HARD_LIMIT=900MB 确定性失败区直接跳过合并尝试(省白等时间+避免 OOM 杀死 worker 连累后续任务重建 core), 双通道(download-core/content-page)同构。分块读写列为自编译升级配套改造记录于 README (暂不实施)
