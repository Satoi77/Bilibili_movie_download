# FFmpeg 内存上限调研结论（feature/ffmpeg-4gb 已合入 master）

> **2026-08-22 实测完成。诊断页已随入口移除删除（git 历史 bb9debd..ba146b9 可找回）；
> `lib/ffmpeg.worker.js` 的 PROBE/MOUNT_WORKERFS 指令保留，供将来自编译升级复用。**

## 背景与调研结论

当前使用 @ffmpeg/core 0.12.x 官方单线程标准构建（`lib/ffmpeg-core.wasm`，30.1MB）：

- **wasm32 理论上限 4GB 需构建期 opt-in**（`-s MAXIMUM_MEMORY=4GB -s ALLOW_MEMORY_GROWTH`），官方构建未开启 → 实际堆约 2GB
- Chrome 对 wasm 堆另有历史约束，但 **wasm 内部堆不受 JS `ArrayBuffer` 2GB 硬顶限制**——4GB 构建在 Chrome 可用
- 社区已验证的突破口：**WORKERFS 挂载输入文件**（pavloshargan/ffmpeg-browser-4gb-plus 用 WORKERFS 成功处理 5GB 输入）——输入数据留在磁盘 backed Blob 中不进堆，堆需求从「2×总大小」降到「≈1×总大小」（仅输出）
- memory64 已标准化但 ffmpeg 官方无 memory64 构建，暂不可行

## 分支改动

| 文件 | 改动 |
|---|---|
| `lib/ffmpeg.worker.js` | 新增 PROBE / MOUNT_WORKERFS / UNMOUNT_WORKERFS 消息指令（纯新增 case，不影响既有消息流） |
| `test/memory-probe.html/.js` | 内存诊断页：探测堆上限、MEMFS 写入阶梯、WORKERFS 挂载通路 |
| `sidepanel.html/.js` | 设置页新增诊断入口链接（分支专用） |

master 分支不受影响。

## 测试步骤

1. 加载本分支版扩展（chrome://extensions → 开发者模式 → 重新加载）
2. 打开侧边栏 → 设置 → 点击底部「FFmpeg 内存诊断（实验功能）」，在新标签页点「开始诊断」
3. 记录四步结果

## 判读标准

| 步骤 | 当前预期结果 | 升级路线成立条件 |
|---|---|---|
| 2. 探测 | 堆 ≈ 2.00 GB；文件系统仅 MEMFS；WORKERFS ✗ | 换 4GB 构建后堆 ≈ 4.00 GB |
| 3. 写入阶梯 | 最大写入 ≈ 768MB~1024MB（堆碎片化导致低于理论值） | 4GB 构建下应翻倍 |
| 4. WORKERFS | 跳过（未打包） | 自编译构建后应显示挂载成功 + ffmpeg 读取痕迹 |

## 若验证通过 → 正式升级路线

自编译 ffmpeg core（Emscripten 环境）：

```bash
# 在 ffmpeg.wasm 构建参数基础上追加：
-s MAXIMUM_MEMORY=4GB \
-l workerfs.js \
# 其余保持与官方 0.12 单线程构建一致
```

产物替换 `lib/ffmpeg-core.js/.wasm/.worker.js`，下载链路增加 WORKERFS 挂载输入（`lib/ffmpeg.worker.js` 的 MOUNT_WORKERFS 已就绪），合并命令改为从 `/mnt/` 读输入。

**自编译升级时的配套改造**（官方构建下收益有限，暂不实施）：

- 输入分块写入：`mergeAudioVideo` 目前 `arrayBuffer()` 整读输入再 transfer——单块 ArrayBuffer ~2GB 上限使 >2GB 输入无法送进 worker。需 worker 增加 APPEND_CHUNK 指令，主线程按块 `file.slice().arrayBuffer()` 循环传输
- 输出分块读出：`readFile(outputPath)` 整读会在堆内产生第二份输出副本；改 `FS.read` 定位循环 + 主线程 Blob chunks 累积，堆峰值进一步从 2T 降到 ≈T+窗口

已基于实测落地的优化（master d74327f）：readFile 前先删输入（堆峰值 3T→2T，可合并体积上限提升约 300MB）；总大小 ≥900MB 跳过合并尝试（确定性失败区不浪费尝试、不杀死 worker）。

---

## 实测结果（2026-08-22，用户浏览器实测）

| 探测项 | 结果 | 判读 |
|---|---|---|
| 加载 | 成功，54ms | 链路正常 |
| 初始堆 | 32MB（0.03GB） | INITIAL_MEMORY 快照；非上限 |
| MEMFS 写入 1024MB / 1536MB | ✓ 235ms / 470ms | ALLOW_MEMORY_GROWTH 开启且工作正常 |
| 页面侧分配 2048MB Uint8Array | ✗ `Array buffer allocation failed` | **Chrome 单块 ArrayBuffer ~2GB 上限**——JS 侧先于 wasm 侧撞墙 |
| WORKERFS | 未打包（仅 MEMFS） | 官方构建预期内 |

**最终结论**：

1. 官方构建存在**双重天花板**：wasm 堆 `MAXIMUM_MEMORY` 默认 2GB + 单块 ArrayBuffer ~2GB（输入 transfer 进 worker 前必须在 JS 侧整块分配）。合并需 ≈2×总大小同驻堆 → **总大小封顶 ~1GB**。
2. 600MB 合并阈值有完整实测背书；3.21GB 视频在官方构建下任何调参都无法合并，"先落盘分离文件保底再尝试合并"策略（master 317c7a5）是官方构建下的最优解。
3. 升级唯一解 = 自编译 4GB 构建 + WORKERFS：WORKERFS 输入以磁盘 backed Blob 直挂，**完全绕开 ArrayBuffer 上限**（比单纯加大堆更本质）；输出 stream-copy 占堆 ≈总大小 ≤4GB → 理论可合并 ~3.5GB 视频。投入成本：Emscripten 编译环境 + 替换 lib/ 三件产物 + 下载链路改挂载读入。
4. 观察备注：写入 1536MB 后 PROBE 的 HEAPU8.length 仍显示 32MB——Module 导出视图在 growth 后未同步（陈旧视图），不影响结论（写入成功本身证明增长），后续探测勿以该指标判断上限。
