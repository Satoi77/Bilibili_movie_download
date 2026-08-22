### Task 3: 任务模型 dir/baseName 贯穿（输出路径规则 + 队列透传 + 双执行器）

**Files:**
- Modify: `lib/download-core.js`（sanitizeFilename 之后新增 resolveOutputTargets 导出；executeTask 内 361-362、373-374、399、409、441、449、456 行接线）
- Create: `test/output-paths.test.mjs`
- Modify: `background.js:586`（ENQUEUE_TASKS videoInfo 构造）
- Modify: `background.js:617`（ENQUEUE_TASK videoInfo 构造）
- Modify: `content-page.js`（常量区附近镜像 resolveOutputTargets；saveRawToSubdir/saveMergeTxt 签名改为收最终子目录；executeDownload 各保存点接线）

**Interfaces:**
- Consumes: Task 2 的 sniffCollection（不变）
- Produces: `resolveOutputTargets(videoInfo, label): {mergedDir, mergedName, rawSubdir}` —— download-core.js 导出版（单测覆盖）+ content-page.js 镜像版（经典脚本无法 import，与 QMAP/dashSize 既有跨世界复制先例一致）。入队条目新增可选字段 `dir`（如 `"合集名/一级标题"`）、`baseName`（如 `"P03_分P名"`），经 background 透传进 `task.videoInfo` 到达双执行器。

路径规则（spec §6.3）：
- 有 dir：合并 → `<DOWNLOAD_BASE>/<safeDir>/<safeBase>_<label>.mp4`；分离文件/merge.txt → `<DOWNLOAD_BASE>/<safeDir>/<safeBase>/`（按 baseName 隔离，防同目录多P互覆）
- 无 dir：合并 → `<DOWNLOAD_BASE>/<safeTitle>_<label>.mp4`；分离 → `<DOWNLOAD_BASE>/<safeTitle>/`（与现状完全一致）

- [ ] **Step 1: 写失败测试**

创建 `test/output-paths.test.mjs`：

```js
// 输出路径规则单测: node test/output-paths.test.mjs
import { resolveOutputTargets, DOWNLOAD_BASE } from '../lib/download-core.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}

console.log('单视频路径（无 dir）—— 必须与历史行为一致');
{
  const t = resolveOutputTargets({ title: '我的视频' }, '1080P');
  assert(t.mergedDir === DOWNLOAD_BASE, '合并输出在根目录');
  assert(t.mergedName === '我的视频_1080P.mp4', '合并文件名=标题_画质');
  assert(t.rawSubdir === DOWNLOAD_BASE + '/我的视频', '分离文件落标题子目录');
}

console.log('批量路径（有 dir/baseName）—— 三级目录');
{
  const t = resolveOutputTargets(
    { title: '一级标题', dir: 'ESP32合集/一级标题', baseName: 'P03_启动流程' }, '720P');
  assert(t.mergedDir === DOWNLOAD_BASE + '/ESP32合集/一级标题', '合并输出进三级目录');
  assert(t.mergedName === 'P03_启动流程_720P.mp4', '合并文件名=baseName_画质');
  assert(t.rawSubdir === DOWNLOAD_BASE + '/ESP32合集/一级标题/P03_启动流程', '分离文件按 baseName 隔离子目录');
}

console.log('非法字符清洗发生在输出边界');
{
  const t = resolveOutputTargets({ dir: 'a<b>c/d:e', baseName: 'x*y?"z' }, '4K');
  assert(t.mergedDir === DOWNLOAD_BASE + '/a_b_c/d_e', '目录段逐段清洗');
  assert(t.mergedName === 'x_y__z_4K.mp4', '文件名非法字符替换');
}

console.log('边界入参不抛错');
{
  const t = resolveOutputTargets(null, '');
  assert(t.mergedDir === DOWNLOAD_BASE && t.rawSubdir === DOWNLOAD_BASE + '/_' , '空对象退化为占位名');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/output-paths.test.mjs`
Expected: FAIL —— `does not provide an export named 'resolveOutputTargets'`

- [ ] **Step 3: download-core.js 实现 resolveOutputTargets**

在 `sanitizeFilename`（第 13 行）之后插入：

```js
// 输出路径解析（纯函数）：批量任务(dir/baseName)三级目录与单视频平铺两条路径的唯一事实源。
// 有 dir：合并输出 <DOWNLOAD_BASE>/<dir>/<base>_<label>.mp4；
//         分离文件/merge.txt 落 <DOWNLOAD_BASE>/<dir>/<base>/ —— 按 baseName 隔离，
//         否则同一 <dir> 下多个分P任务的 audio.mp4/video.mp4 会互相覆盖
// 无 dir：与历史行为完全一致（合并平铺根目录、分离文件落 <标题>/ 子目录）
export function resolveOutputTargets(videoInfo, label = '') {
  const title = (videoInfo && videoInfo.title) || '';
  const safeTitle = sanitizeFilename(title);
  if (videoInfo && videoInfo.dir) {
    const safeDir = String(videoInfo.dir).split('/').map(sanitizeFilename).join('/');
    const safeBase = sanitizeFilename(videoInfo.baseName || safeTitle);
    return {
      mergedDir: DOWNLOAD_BASE + '/' + safeDir,
      mergedName: `${safeBase}${label ? '_' + label : ''}.mp4`,
      rawSubdir: DOWNLOAD_BASE + '/' + safeDir + '/' + safeBase
    };
  }
  return {
    mergedDir: DOWNLOAD_BASE,
    mergedName: `${safeTitle}${label ? '_' + label : ''}.mp4`,
    rawSubdir: DOWNLOAD_BASE + '/' + safeTitle
  };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `node test/output-paths.test.mjs`
Expected: 全部 ✓，`XX passed, 0 failed`，退出码 0

- [ ] **Step 5: executeTask 接线（download-core.js）**

executeTask 内，将（原 361-362 行）：

```js
  const safeTitle = sanitizeFilename(title);
  const subdir = DOWNLOAD_BASE + '/' + safeTitle;
```

替换为：

```js
  const targets = resolveOutputTargets(videoInfo, label);
```

然后逐一替换引用（共 7 处）：
- `saveAudioRaw`/`saveVideoRaw` 中的 `'audio.mp4', subdir` / `'video.mp4', subdir` → `'audio.mp4', targets.rawSubdir` / `'video.mp4', targets.rawSubdir`
- 两处 `await saveBlob(mergedBlob, \`${safeTitle}_${label}.mp4\`, DOWNLOAD_BASE)` → `await saveBlob(mergedBlob, targets.mergedName, targets.mergedDir)`
- 三处 `saveMergeTxt(saveBlob, subdir)` → `saveMergeTxt(saveBlob, targets.rawSubdir)`

- [ ] **Step 6: background.js 透传（两处相同修改）**

ENQUEUE_TASKS（586 行）与 ENQUEUE_TASK（617 行）中的：

```js
          videoInfo: { aid: it.aid, bvid: it.bvid, cid: it.cid, title: it.title || '' },
```

均改为（注意两处缩进不同，ENQUEUE_TASK 处少一层缩进）：

```js
          videoInfo: { aid: it.aid, bvid: it.bvid, cid: it.cid, title: it.title || '', dir: it.dir || '', baseName: it.baseName || '' },
```

- [ ] **Step 7: content-page.js 镜像接线**

7a. 在 `MERGE_HARD_LIMIT` 常量（约 330 行）之后新增镜像版（页面世界无法 import ESM，与 QMAP/dashSize 跨世界复制先例一致）：

```js
  // 输出路径解析（与 lib/download-core.js 的导出版保持一致；页面世界经典脚本无法 import）
  function resolveOutputTargets(videoInfo, label) {
    const safeTitle = sanitizeFilename(videoInfo.title || '');
    if (videoInfo.dir) {
      const safeDir = String(videoInfo.dir).split('/').map(sanitizeFilename).join('/');
      const safeBase = sanitizeFilename(videoInfo.baseName || safeTitle);
      return {
        mergedDir: DOWNLOAD_BASE + '/' + safeDir,
        mergedName: `${safeBase}${label ? '_' + label : ''}.mp4`,
        rawSubdir: DOWNLOAD_BASE + '/' + safeDir + '/' + safeBase
      };
    }
    return {
      mergedDir: DOWNLOAD_BASE,
      mergedName: `${safeTitle}${label ? '_' + label : ''}.mp4`,
      rawSubdir: DOWNLOAD_BASE + '/' + safeTitle
    };
  }
```

7b. `saveRawToSubdir`（397-410 行）签名改为收最终子目录：

```js
  /**
   * 保存原始音频/视频文件到最终子目录（目录已含 baseName 隔离层）
   */
  async function saveRawToSubdir(audioBlob, videoBlob, finalSubdir) {
    // MIME 用 video/mp4 且文件名用 .mp4：B 站 dash 流本身是 fMP4 容器，
    // 若命名为 .m4s，Chrome 会按内容类型把扩展名改写成 .mp4
    // 用 slice 改 MIME（引用共享零拷贝）；禁止 arrayBuffer() 全量拷贝（大文件 OOM）
    const audioForSave = audioBlob.slice(0, audioBlob.size, 'video/mp4');
    const videoForSave = videoBlob.slice(0, videoBlob.size, 'video/mp4');
    const audioId = await saveBlobViaDownloads(audioForSave, 'audio.mp4', finalSubdir);
    const videoId = await saveBlobViaDownloads(videoForSave, 'video.mp4', finalSubdir);
    console.log('[B站下载助手] 原始文件已保存到子目录:', finalSubdir);
    return [audioId, videoId]; // downloadId 列表，供合并成功后按设置删除
  }
```

`saveMergeTxt`（417-432 行）同样改签名（保留 txt 内容不变）：

```js
  /**
   * 保存 merge.txt 合并说明到最终子目录（仅在 FFmpeg 合并失败时调用）
   */
  async function saveMergeTxt(finalSubdir) {
    const txtContent = [
      '将此目录下的 audio.mp4 和 video.mp4 合并为 mp4 文件。',
      '',
      '方法一：使用 ffmpeg 命令行',
      '  ffmpeg -i video.mp4 -i audio.mp4 -vcodec copy -acodec copy merged.mp4',
      '',
      '方法二：将本文件重命名为 merge.bat，双击运行',
      '  （需要已安装 ffmpeg 并添加到 PATH 环境变量）'
    ].join('\r\n');
    const blob = new Blob([txtContent], { type: 'text/plain' });
    await saveBlobViaDownloads(blob, 'merge.txt', finalSubdir);
    console.log('[B站下载助手] merge.txt 已保存到子目录:', finalSubdir);
  }
```

7c. executeDownload 内（原 734-735 行）：

```js
    const safeTitle = sanitizeFilename(title);
    const baseSubdir = DOWNLOAD_BASE;
```

替换为（此时 label 已在前文计算完成）：

```js
    const targets = resolveOutputTargets(videoInfo, label);
```

然后替换全部调用点（6 类共 9 处）：
- 三处 `await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir)` → `await saveRawToSubdir(audioBlob, videoBlob, targets.rawSubdir)`
- 两处 `await downloadFile(mergedBlob, \`${safeTitle}_${label}.mp4\`, baseSubdir)` → `await downloadFile(mergedBlob, targets.mergedName, targets.mergedDir)`
- 四处 `await saveMergeTxt(title, baseSubdir)` / `try { await saveMergeTxt(...) }` → `saveMergeTxt(targets.rawSubdir)`

- [ ] **Step 8: 回归验证**

Run: `node test/output-paths.test.mjs; node test/collection-parser.test.mjs; node test/failure-alert.test.mjs; node --check background.js; node --check content-page.js; node --check lib/download-core.js`
Expected: 三个测试全绿，--check 无输出

- [ ] **Step 9: 提交**

```bash
git add lib/download-core.js test/output-paths.test.mjs background.js content-page.js
git commit -m "feat(download): 批量任务三级目录输出——dir/baseName 贯穿队列入参到双执行器，路径规则收敛 resolveOutputTargets"
```

---
