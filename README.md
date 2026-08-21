# Bilibili 视频下载助手

一款 Chrome / Edge 浏览器扩展（Manifest V3），用于下载 B站视频。支持单视频画质选择下载、合集/系列批量下载，下载进度实时显示在侧边栏（Side Panel）。

## 功能特性

- **单视频下载**：在 B站播放页弹出画质选择，一键下载合并后的 MP4
- **合集/系列批量下载**：自动识别合集，逐条带随机延时下载，避免触发风控
- **后台下载，不依赖页面**：下载在扩展后台（offscreen）执行，切换/关闭 B 站页面、甚至关掉所有页面，下载照常完成
- **原始文件保存**（可选）：在子目录中保存 `audio.m4s`、`video.m4s` 及合并说明 `merge.txt`
- **实时进度**：侧边栏展示下载 / 合并进度与已完成任务列表
- **固定下载目录**：所有文件保存到浏览器默认下载目录下的 `bilibili_download` 子目录
  - 合并后：`bilibili_download/<标题>_<画质>.mp4`
  - 原始文件：`bilibili_download/<标题>/audio.m4s`、`video.m4s`、`merge.txt`

## 技术架构

```
content.js       桥接层：注入 content-page.js，预取 FFmpeg，转发页面↔background 消息
content-page.js  页面上下文：UI 面板、FFmpeg WASM 合并、下载与保存逻辑（宿主 tab 兜底执行器）
offscreen.js     后台下载执行器：offscreen document 中执行下载/合并，随扩展运行不依赖页面
background.js    统一存储层（Service Worker）：任务/设置读写、下载调度、队列与停滞自愈
sidepanel.js     侧边栏 UI：任务列表、设置、实时进度
lib/db.js         IndexedDB 封装（下载任务）
lib/download-core.js  上下文无关的下载执行引擎（offscreen 主路径使用）
lib/ffmpeg.*      FFmpeg WASM（v0.12.1）合并音频+视频
```

跨上下文通信统一通过消息桥：`页面 postMessage → content.js → chrome.runtime.sendMessage → background.js`；offscreen 路径使用独立 `OFFSCREEN_*` 消息类型，避免广播回声。

下载执行双通道：优先 offscreen document（扩展后台，与页面无关）；若 B 站 API 登录态受限，自动回退到扩展创建的隐藏 B 站宿主 tab（复用页面执行器）兜底。

## 安装（开发者模式）

1. 打开浏览器扩展管理页：`chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录
4. 在 B站视频播放页点击下载按钮即可使用

## 使用说明

- 视频播放页：点击右下角悬浮按钮，选择画质后开始下载
- 合集页：切换到「合集」标签，点击「下载合集」批量下载
- 侧边栏：查看实时进度、清空已完成/失败任务、配置延时与原始文件保存选项
- 下载开始后可任意切换/关闭 B 站页面，任务由后台继续执行；批量下载中关闭全部页面同样不受影响

## 许可证

[MIT](LICENSE) © 猹哥
