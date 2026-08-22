# FFmpeg 4GB 内存方案验证（feature/ffmpeg-4gb 分支）

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
