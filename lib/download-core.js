// lib/download-core.js - 与上下文无关的下载执行引擎（offscreen 主路径使用）

// B 站视频 CDN 防盗链要求 Referer 为 bilibili.com 域；offscreen 是 chrome-extension:// 页面，
// 且扩展页面默认 Referrer-Policy 为 no-referrer，必须显式 referrer + referrerPolicy: 'unsafe-url'，
// 否则流下载返回 403
const BILI_REFERRER = 'https://www.bilibili.com/';

export const QMAP = {16:'360P',32:'480P',64:'720P',80:'1080P',112:'1080P高码率',120:'4K',125:'HDR'};
export const DOWNLOAD_BASE = 'bilibili_download';

export function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').substring(0, 200);
}

// 输出路径解析（纯函数）：批量任务(dir/baseName)三级目录与单视频平铺两条路径的唯一事实源。
// 有 dir：合并输出 <DOWNLOAD_BASE>/<dir>/<base>_<label>.mp4；
//         分离文件/merge.txt 落 <DOWNLOAD_BASE>/<dir>/<base>/ —— 按 baseName 隔离，
//         否则同一 <dir> 下多个分P任务的 audio.mp4/video.mp4 会互相覆盖
// 无 dir：与历史行为完全一致（合并平铺根目录、分离文件落 <标题>/ 子目录）
export function resolveOutputTargets(videoInfo, label = '') {
  const title = (videoInfo && videoInfo.title) || '';
  const safeTitle = sanitizeFilename(title) || '_';
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

// B 站 playurl 的 dash size 字段已实测返回空值：优先取值，空则按 bandwidth(位/秒)×duration(秒) 估算
function dashSize(entry, durationSec) {
  if (entry?.size) return entry.size;
  if (entry?.bandwidth && durationSec > 0) return Math.round(entry.bandwidth / 8 * durationSec);
  return 0;
}

export async function getPlayUrl(aid, bvid, cid, qn = 80, signal, fetchFn = fetch) {
  const url = `https://api.bilibili.com/x/player/wbi/playurl?qn=${qn}&fnver=0&fnval=4048&fourk=1&avid=${aid}&bvid=${bvid}&cid=${cid}`;
  const r = await fetchFn(url, { credentials: 'include', referrer: BILI_REFERRER, referrerPolicy: 'unsafe-url', signal });
  if (!r.ok) throw new Error('播放地址 HTTP ' + r.status);
  const d = await r.json();
  if (d.code !== 0 || !d.data) throw new Error('播放地址获取失败 code=' + d.code);
  return d.data;
}

// wasm32 的 FFmpeg WASM 堆有约 2GB 硬上限：合并需同时容纳 输入+输出 ≈ 2×总大小。
// 该阈值不是"跳过合并"的一刀切门槛：超过阈值的大文件先落盘分离文件作保底，
// 仍会尝试合并（卡在内存边界附近的文件有机会成功），失败时保底文件直接可用。
export const MERGE_THRESHOLD = 600 * 1024 * 1024;
// 实测（2026-08-22 内存诊断）：官方构建 wasm 堆默认上限 2GB（MAXIMUM_MEMORY 未开启 4GB），
// 合并需 输入+输出 ≈ 2×总大小 同驻堆。总大小 ≥ 此阈值时必然 OOM 且会杀死 FFmpeg worker
// （下一个任务需重新编译 core），因此不再尝试合并，直接落盘分离文件作保底。
// 600MB ~ 900MB 区间仍尝试：卡在内存边界附近的文件有机会成功。
export const MERGE_HARD_LIMIT = 900 * 1024 * 1024;

function fmtBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
  if (n >= 1048576) return Math.round(n / 1048576) + 'MB';
  return n + 'B';
}

function readWithTimeout(reader, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取超时')), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (v) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        else reject(e);
      }
    );
  });
}

// Range 续传决策：仅「206 且 content-range 起点==已有字节数」可续传，其余一律从头（truncate 覆盖）
export function resolveResumePlan(status, contentRange, existingSize) {
  if (status === 206) {
    const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(String(contentRange || ''));
    if (m && Number(m[1]) === existingSize) {
      return { mode: 'resume', offset: existingSize, total: Number(m[2]) };
    }
  }
  return { mode: 'restart' };
}

// 候选地址列表：主链接 + 备用链接（dash 条目 camelCase/snake_case 字段均兼容）
function candidateUrls(entry) {
  return [entry?.baseUrl || entry?.base_url, ...(entry?.backupUrl || entry?.backup_url || [])]
    .filter(u => typeof u === 'string' && u.length > 0);
}

// 单个地址的完整尝试：请求 + 读流。网络错误/非 200/中途断流都抛给调用方，由其决定是否换下一个地址
async function fetchStreamOnce(url, phase, signal, notify, fetchFn) {
  const r = await fetchFn(url, { credentials: 'include', referrer: BILI_REFERRER, referrerPolicy: 'unsafe-url', signal });
  if (!r.ok) {
    const err = new Error('流 HTTP ' + r.status);
    // 403 多为 CDN 防盗链（Referer/cookie 上下文不符），可切宿主 tab（同源必然可下）兜底
    if (r.status === 403) err.code = 'NEEDS_PAGE';
    throw err;
  }
  const total = parseInt(r.headers.get('content-length') || '0');
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  let lastSent = -1;
  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await readWithTimeout(reader, 30000, signal);
    if (res.done) break;
    chunks.push(res.value);
    received += res.value.length;
    const percent = total > 0 ? Math.round(received / total * 100) : -1;
    if (percent !== lastSent) {
      lastSent = percent;
      notify({ phase, percent, label: '下载中' });
    }
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return new Blob(chunks);
}

// 逐个候选地址尝试：B 站 CDN 瞬时抖动（连接重置等表现为 TypeError: Failed to fetch）
// 只影响单个地址，切换备用链接重下即可，不再让整任务失败
export async function downloadStream(urls, phase, signal, notify, fetchFn = fetch) {
  const candidates = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (candidates.length === 0) throw new Error('无可用下载地址');
  let lastErr = null;
  let needsPage = false;
  for (const url of candidates) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fetchStreamOnce(url, phase, signal, notify, fetchFn);
    } catch (e) {
      // 用户中止立即透传，不浪费剩余地址
      if (e.name === 'AbortError' || signal?.aborted) throw e;
      if (e.code === 'NEEDS_PAGE') needsPage = true;
      lastErr = e;
    }
  }
  // 任一地址出现过 403（防盗链）→ 保留切宿主 tab 兜底的语义
  if (needsPage && lastErr) lastErr.code = 'NEEDS_PAGE';
  throw lastErr;
}

// 单个地址流式下载到 OPFS：分块直写磁盘，内存占用与文件大小无关。
// 断点续传：已有半成品(size=N>0)带 Range 请求；206 且起点匹配则 seek(N) 定位续写；
// 其余情况(CDN 忽略 Range/区间不符/416)弃档从头；失败 close 落地半成品供重试续传。
export async function opfsOnce(name, url, phase, signal, notify, fetchFn, getRoot = () => navigator.storage.getDirectory()) {
  const root = await getRoot();
  const fh = await root.getFileHandle(name, { create: true });
  const existingSize = (await fh.getFile()).size;
  const reqOpts = (rangeHeader) => ({ credentials: 'include', referrer: BILI_REFERRER, referrerPolicy: 'unsafe-url', signal, headers: rangeHeader ? { Range: rangeHeader } : {} });
  let r = await fetchFn(url, reqOpts(existingSize > 0 ? 'bytes=' + existingSize + '-' : null));
  if (r.status === 416) {
    // 本地半成品超出远端总长(异常档)：弃档从头重下
    try { await r.body.cancel(); } catch (_) {}
    r = await fetchFn(url, reqOpts(null));
  }
  if (!r.ok) {
    const err = new Error('流 HTTP ' + r.status);
    // 403 多为 CDN 防盗链（Referer/cookie 上下文不符），可切宿主 tab（同源必然可下）兜底
    if (r.status === 403) err.code = 'NEEDS_PAGE';
    throw err;
  }
  let plan = resolveResumePlan(r.status, r.headers.get('content-range'), existingSize);
  if (plan.mode === 'restart' && r.status !== 200) {
    // 带 Range 却拿到非 200/合法 206 的响应(如区间错位)：字节序列不可信，弃响应重发干净全量
    try { await r.body.cancel(); } catch (_) {}
    r = await fetchFn(url, reqOpts(null));
    if (!r.ok) {
      const err = new Error('流 HTTP ' + r.status);
      if (r.status === 403) err.code = 'NEEDS_PAGE';
      throw err;
    }
    plan = resolveResumePlan(r.status, r.headers.get('content-range'), 0);
  }
  const baseOffset = plan.mode === 'resume' ? plan.offset : 0;
  const total = plan.mode === 'resume' ? plan.total : parseInt(r.headers.get('content-length') || '0');
  const writable = plan.mode === 'resume'
    ? await fh.createWritable({ keepExistingData: true })
    : await fh.createWritable();
  if (plan.mode === 'resume') await writable.write({ type: 'seek', position: baseOffset });
  const reader = r.body.getReader();
  let received = 0;
  let lastSent = -1;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const res = await readWithTimeout(reader, 60000, signal);
      if (res.done) break;
      await writable.write(res.value);
      received += res.value.length;
      const percent = total > 0 ? Math.round((baseOffset + received) / total * 100) : -1;
      if (percent !== lastSent) {
        lastSent = percent;
        notify({ phase, percent, label: '下载中' });
      }
    }
    await writable.close();
  } catch (e) {
    // 失败也落地已收字节(半成品)，供下次 Range 续传；不再 abort+removeEntry
    try { await writable.close(); } catch (_) {}
    throw e;
  }
  if (total > 0 && baseOffset + received !== total) {
    throw new Error('流长度不完整(' + (baseOffset + received) + '/' + total + ')');
  }
  const file = await fh.getFile();
  return { file, size: file.size };
}

// 逐个候选地址尝试写 OPFS，语义与 downloadStream 一致：瞬时网络错误换备用链接，中止立即透传
async function downloadToOPFS(name, urls, phase, signal, notify, fetchFn = fetch, getRoot) {
  const candidates = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (candidates.length === 0) throw new Error('无可用下载地址');
  let lastErr = null;
  let needsPage = false;
  for (const url of candidates) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await opfsOnce(name, url, phase, signal, notify, fetchFn, getRoot);
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e;
      if (e.code === 'NEEDS_PAGE') needsPage = true;
      lastErr = e;
    }
  }
  if (needsPage && lastErr) lastErr.code = 'NEEDS_PAGE';
  throw lastErr;
}

// 清理指定 OPFS 半成品（任务删除时调用；命名约定 {taskId}_audio / {taskId}_video）
export async function cleanupOPFS(names) {
  try {
    const root = await navigator.storage.getDirectory();
    names.forEach(n => { root.removeEntry(n).catch(() => {}); });
  } catch (e) {}
}

// 枚举 OPFS 根目录，清理不属于任何现存任务的半成品（offscreen 就绪后的孤儿对账兜底）
export async function cleanupOrphanOpfsParts(keepPrefixes) {
  try {
    const root = await navigator.storage.getDirectory();
    const iter = root.entries();
    for (;;) {
      const { done, value } = await iter.next();
      if (done) break;
      const [name, handle] = value;
      if (!handle || handle.kind !== 'file') continue;
      const m = /^(.+)_(audio|video)$/.exec(name);
      if (m && !keepPrefixes.has(m[1])) {
        try { await root.removeEntry(name); } catch (e) {}
      }
    }
  } catch (e) {}
}

export async function saveMergeTxt(saveBlob, subdir) {
  const txtContent = [
    '将此目录下的 audio.mp4 和 video.mp4 合并为 mp4 文件。',
    '',
    '方法一：使用 ffmpeg 命令行',
    '  ffmpeg -i video.mp4 -i audio.mp4 -vcodec copy -acodec copy merged.mp4',
    '',
    '方法二：将本文件重命名为 merge.bat，双击运行',
    '  （需要已安装 ffmpeg 并添加到 PATH 环境变量）'
  ].join('\r\n');
  await saveBlob(new Blob([txtContent], { type: 'text/plain' }), 'merge.txt', subdir);
}

export async function mergeAudioVideo(ffmpeg, audioBlob, videoBlob, notify) {
  const tag = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const audioPath = tag + '_audio.m4s';
  const videoPath = tag + '_video.m4s';
  const outputPath = tag + '_merged.mp4';

  await ffmpeg.writeFile(audioPath, new Uint8Array(await audioBlob.arrayBuffer()));
  await ffmpeg.writeFile(videoPath, new Uint8Array(await videoBlob.arrayBuffer()));

  const heartbeat = setInterval(() => {
    notify({ phase: 'merge', percent: 50, label: '合并中' });
  }, 20000);

  try {
    await ffmpeg.run(['-i', videoPath, '-i', audioPath, '-vcodec', 'copy', '-acodec', 'copy', outputPath]);
  } finally {
    clearInterval(heartbeat);
  }

  // 先删输入再读输出：MEMFS 删除后其内存块可被复用，readFile 的输出副本
  // 复用刚释放的输入区，堆峰值从 ≈3×总大小 降到 ≈2×总大小（实测上限 2GB 下
  // 相当于可合并体积上限提升约 300MB）
  ffmpeg.deleteFile(audioPath).catch(() => {});
  ffmpeg.deleteFile(videoPath).catch(() => {});
  const merged = await ffmpeg.readFile(outputPath);
  ffmpeg.deleteFile(outputPath).catch(() => {});
  return new Blob([merged.buffer], { type: 'video/mp4' });
}

export async function executeTask(taskId, videoInfo, qualityIdx, deps) {
  const { getSettings, getFFmpeg, notify, saveBlob, removeSavedFile, signal, fetchFn } = deps;
  const settings = (await getSettings()) || {};

  let data;
  try {
    data = await getPlayUrl(videoInfo.aid, videoInfo.bvid, videoInfo.cid, 80, signal, fetchFn);
  } catch (e) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const err = new Error(e.message || '获取播放地址失败');
    err.code = 'NEEDS_PAGE';
    throw err;
  }
  if (!data?.dash) {
    const err = new Error('获取播放地址失败');
    err.code = 'NEEDS_PAGE';
    throw err;
  }

  const videoByQ = {};
  data.dash.video.forEach(v => {
    if (!videoByQ[v.id]) videoByQ[v.id] = [];
    videoByQ[v.id].push(v);
  });

  const options = Object.keys(videoByQ).map(Number).sort((a, b) => b - a);
  const q = options[qualityIdx] || options[0];
  const streams = videoByQ[q].sort((a, b) => b.bandwidth - a.bandwidth);
  const bestVideo = streams[0];
  const bestAudio = data.dash.audio[0];
  const label = QMAP[q] || q + 'P';
  // B 站 playurl 的 dash 条目带精确字节数（size 为空时按码率估算），上报给任务卡片展示
  const dur = data.dash.duration || Math.round((data.timelength || 0) / 1000);
  const totalSize = dashSize(bestVideo, dur) + dashSize(bestAudio, dur);

  notify({ phase: 'quality', percent: 0, label, totalSize });
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  notify({ phase: 'download', percent: 0, label: '下载中' });

  // 流式写入 OPFS：内存占用与文件大小无关；任一路失败时中止另一路并清理残留
  let audioDl = null;
  let videoDl = null;
  const dlCtrl = new AbortController();
  const onOuterAbort = () => dlCtrl.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    [audioDl, videoDl] = await Promise.all([
      downloadToOPFS(taskId + '_audio', candidateUrls(bestAudio), 'audio', dlCtrl.signal, notify, fetchFn),
      downloadToOPFS(taskId + '_video', candidateUrls(bestVideo), 'video', dlCtrl.signal, notify, fetchFn)
    ]);
  } catch (e) {
    dlCtrl.abort();
    // 半成品保留：失败重试/暂停后从断点续传；清理只属于任务成功与任务被删除
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }

  if (signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  notify({ phase: 'download', percent: 100, label: '下载完成' });

  const targets = resolveOutputTargets(videoInfo, label);
  const actualTotal = audioDl.size + videoDl.size;
  // 用真实字节数修正任务卡片的合计容量（入队时的值为估算）
  notify({ phase: 'quality', percent: 0, totalSize: actualTotal });
  let rawSaved = false;
  let audioFileId = null;
  let videoFileId = null;

  // Blob 构造引用 OPFS 文件快照，不产生整文件的内存拷贝
  // MIME 用 video/mp4 且文件名用 .mp4：B 站 dash 流本身是 fMP4 容器，
  // 若命名为 .m4s，Chrome 会按内容类型把扩展名改写成 .mp4
  const saveAudioRaw = () => saveBlob(new Blob([audioDl.file], { type: 'video/mp4' }), 'audio.mp4', targets.rawSubdir);
  const saveVideoRaw = () => saveBlob(new Blob([videoDl.file], { type: 'video/mp4' }), 'video.mp4', targets.rawSubdir);
  // 记录 downloadId，合并成功后可按设置删除原始文件（chrome.downloads.removeFile）
  const saveRawFiles = async () => {
    audioFileId = await saveAudioRaw();
    videoFileId = await saveVideoRaw();
  };

  if (settings.saveRawFiles) {
    try {
      notify({ phase: 'merge', percent: 0, label: '保存原始文件' });
      await saveRawFiles();
      rawSaved = true;
    } catch (e) {}
  }

  const bigFile = actualTotal > MERGE_THRESHOLD;
  let note = '';

  if (!bigFile) {
    // 小文件：直接合并（成功率接近 100%），失败才降级落盘——避免多余磁盘写与删除痕迹
    try {
      notify({ phase: 'merge', percent: 50, label: '合并中' });
      const ffmpeg = await getFFmpeg();
      const mergedBlob = await mergeAudioVideo(ffmpeg, audioDl.file, videoDl.file, notify);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      await saveBlob(mergedBlob, targets.mergedName, targets.mergedDir);
      notify({ phase: 'merge', percent: 100, label: '合并完成' });
    } catch (mergeError) {
      if (signal?.aborted || mergeError.name === 'AbortError') {
        throw mergeError;
      }
      // 合并执行失败（多为 OOM）：降级为分离保存，任务正常完成
      if (!rawSaved) {
        try { await saveRawFiles(); rawSaved = true; } catch (e) {}
      }
      try { await saveMergeTxt(saveBlob, targets.rawSubdir); } catch (e) {}
      await cleanupOPFS([taskId + '_audio', taskId + '_video']);
      if (!rawSaved) {
        throw new Error('合并失败且分离文件保存失败: ' + mergeError.message);
      }
      note = `合并失败（${mergeError.message}），已保存分离音视频，请按 merge.txt 说明本地合并`;
      notify({ phase: 'merge', percent: 100, label: '已保存分离文件' });
    }
  } else {
    // 大文件：先落盘分离文件作保底（用户指定的顺序），再尝试合并——不再一刀切跳过。
    // 卡在 wasm 内存边界附近的文件有机会合并成功；失败时保底文件直接可用。
    // 注意不能在此处提前清理 OPFS：合并仍需读取 audioDl.file/videoDl.file 快照。
    if (!rawSaved) {
      try {
        notify({ phase: 'merge', percent: 0, label: '保存原始文件' });
        await saveRawFiles();
        rawSaved = true;
      } catch (e) {}
    }
    if (!rawSaved) {
      throw new Error(`分离文件保存失败（文件 ${fmtBytes(actualTotal)}）`);
    }
    // 实测 wasm 堆上限 2GB：总大小 ≥900MB 时合并必然 OOM（还会杀死 worker 连累后续任务），
    // 直接跳过尝试；600MB~900MB 的边界区间仍给合并机会
    const worthMerging = actualTotal < MERGE_HARD_LIMIT;
    let mergedOk = false;
    if (worthMerging) {
      try {
        notify({ phase: 'merge', percent: 50, label: '尝试合并' });
        const ffmpeg = await getFFmpeg();
        const mergedBlob = await mergeAudioVideo(ffmpeg, audioDl.file, videoDl.file, notify);
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await saveBlob(mergedBlob, targets.mergedName, targets.mergedDir);
        mergedOk = true;
        notify({ phase: 'merge', percent: 100, label: '合并完成' });
      } catch (mergeError) {
        if (signal?.aborted || mergeError.name === 'AbortError') {
          throw mergeError;
        }
        // 合并失败（边界区间 OOM）：保底分离文件已在磁盘上，补 merge.txt 即完成任务
        try { await saveMergeTxt(saveBlob, targets.rawSubdir); } catch (e) {}
        note = `内存不足未能自动合并，分离音视频已就绪，请按 merge.txt 说明本地合并`;
        notify({ phase: 'merge', percent: 100, label: '已保存分离文件' });
      }
    }
    if (!mergedOk && !worthMerging) {
      // 确定性失败区：不浪费一次注定失败的合并尝试，保底文件即最终交付
      try { await saveMergeTxt(saveBlob, targets.rawSubdir); } catch (e) {}
      note = `文件较大（${fmtBytes(actualTotal)}），已保存分离音视频，请按 merge.txt 说明本地合并`;
      notify({ phase: 'merge', percent: 100, label: '已保存分离文件' });
    }
    if (mergedOk && !settings.saveRawFiles) {
      // 合并成功且未开启"保存原始音频和视频文件"→ 删除刚落盘的保底文件
      try {
        if (audioFileId) await removeSavedFile(audioFileId);
        if (videoFileId) await removeSavedFile(videoFileId);
      } catch (e) {}
    }
  }

  await cleanupOPFS([taskId + '_audio', taskId + '_video']);
  return { note };
}
