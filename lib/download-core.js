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

export async function getPlayUrl(aid, bvid, cid, qn = 80, signal, fetchFn = fetch) {
  const url = `https://api.bilibili.com/x/player/wbi/playurl?qn=${qn}&fnver=0&fnval=4048&fourk=1&avid=${aid}&bvid=${bvid}&cid=${cid}`;
  const r = await fetchFn(url, { credentials: 'include', referrer: BILI_REFERRER, referrerPolicy: 'unsafe-url', signal });
  if (!r.ok) throw new Error('播放地址 HTTP ' + r.status);
  const d = await r.json();
  if (d.code !== 0 || !d.data) throw new Error('播放地址获取失败 code=' + d.code);
  return d.data;
}

// wasm32 的 FFmpeg WASM 堆有约 2GB 硬上限：合并需同时容纳 输入+输出 ≈ 2×总大小，
// 超过该阈值必然 OOM 中止（表现为只剩 merge.txt）。大文件直接走分离保存。
export const MERGE_THRESHOLD = 600 * 1024 * 1024;

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

export async function downloadStream(url, phase, signal, notify, fetchFn = fetch) {
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

// 流式下载到 OPFS：分块直写磁盘，内存占用与文件大小无关（替代全量 chunks 累积在 RAM）
async function downloadToOPFS(name, url, phase, signal, notify, fetchFn = fetch) {
  const r = await fetchFn(url, { credentials: 'include', referrer: BILI_REFERRER, referrerPolicy: 'unsafe-url', signal });
  if (!r.ok) {
    const err = new Error('流 HTTP ' + r.status);
    // 403 多为 CDN 防盗链（Referer/cookie 上下文不符），可切宿主 tab（同源必然可下）兜底
    if (r.status === 403) err.code = 'NEEDS_PAGE';
    throw err;
  }
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  const total = parseInt(r.headers.get('content-length') || '0');
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
      const percent = total > 0 ? Math.round(received / total * 100) : -1;
      if (percent !== lastSent) {
        lastSent = percent;
        notify({ phase, percent, label: '下载中' });
      }
    }
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch (_) {}
    try { await root.removeEntry(name); } catch (_) {}
    throw e;
  }
  const file = await fh.getFile();
  return { file, size: received };
}

async function cleanupOPFS(names) {
  try {
    const root = await navigator.storage.getDirectory();
    names.forEach(n => { root.removeEntry(n).catch(() => {}); });
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

  const merged = await ffmpeg.readFile(outputPath);
  ffmpeg.deleteFile(audioPath).catch(() => {});
  ffmpeg.deleteFile(videoPath).catch(() => {});
  ffmpeg.deleteFile(outputPath).catch(() => {});
  return new Blob([merged.buffer], { type: 'video/mp4' });
}

export async function executeTask(taskId, videoInfo, qualityIdx, deps) {
  const { getSettings, getFFmpeg, notify, saveBlob, signal, fetchFn } = deps;
  const settings = (await getSettings()) || {};
  const title = videoInfo.title;

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
  // B 站 playurl 的 dash 条目带精确字节数，上报给任务卡片展示
  const totalSize = (bestVideo.size || 0) + (bestAudio.size || 0);

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
      downloadToOPFS(taskId + '_audio', bestAudio.baseUrl, 'audio', dlCtrl.signal, notify, fetchFn),
      downloadToOPFS(taskId + '_video', bestVideo.baseUrl, 'video', dlCtrl.signal, notify, fetchFn)
    ]);
  } catch (e) {
    dlCtrl.abort();
    await cleanupOPFS([taskId + '_audio', taskId + '_video']);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }

  if (signal?.aborted) {
    await cleanupOPFS([taskId + '_audio', taskId + '_video']);
    throw new DOMException('aborted', 'AbortError');
  }
  notify({ phase: 'download', percent: 100, label: '下载完成' });

  const safeTitle = sanitizeFilename(title);
  const subdir = DOWNLOAD_BASE + '/' + safeTitle;
  const actualTotal = audioDl.size + videoDl.size;
  let rawSaved = false;

  // Blob 构造引用 OPFS 文件快照，不产生整文件的内存拷贝
  // MIME 用 video/mp4 且文件名用 .mp4：B 站 dash 流本身是 fMP4 容器，
  // 若命名为 .m4s，Chrome 会按内容类型把扩展名改写成 .mp4
  const saveRawFiles = async () => {
    await saveBlob(new Blob([audioDl.file], { type: 'video/mp4' }), 'audio.mp4', subdir);
    await saveBlob(new Blob([videoDl.file], { type: 'video/mp4' }), 'video.mp4', subdir);
  };

  if (settings.saveRawFiles) {
    try {
      notify({ phase: 'merge', percent: 0, label: '保存原始文件' });
      await saveRawFiles();
      rawSaved = true;
    } catch (e) {}
  }

  const skipMerge = actualTotal > MERGE_THRESHOLD;
  let note = '';

  if (!skipMerge) {
    try {
      notify({ phase: 'merge', percent: 50, label: '合并中' });
      const ffmpeg = await getFFmpeg();
      const mergedBlob = await mergeAudioVideo(ffmpeg, audioDl.file, videoDl.file, notify);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      await saveBlob(mergedBlob, `${safeTitle}_${label}.mp4`, DOWNLOAD_BASE);
      notify({ phase: 'merge', percent: 100, label: '合并完成' });
    } catch (mergeError) {
      if (signal?.aborted || mergeError.name === 'AbortError') {
        await cleanupOPFS([taskId + '_audio', taskId + '_video']);
        throw mergeError;
      }
      // 合并执行失败（大文件多为 OOM，重试无法解决）：降级为分离保存，任务正常完成
      if (!rawSaved) {
        try { await saveRawFiles(); rawSaved = true; } catch (e) {}
      }
      try { await saveMergeTxt(saveBlob, subdir); } catch (e) {}
      await cleanupOPFS([taskId + '_audio', taskId + '_video']);
      if (!rawSaved) {
        throw new Error('合并失败且分离文件保存失败: ' + mergeError.message);
      }
      note = `合并失败（${mergeError.message}），已保存分离音视频，请按 merge.txt 说明本地合并`;
      notify({ phase: 'merge', percent: 100, label: '已保存分离文件' });
    }
  } else {
    if (!rawSaved) {
      try {
        notify({ phase: 'merge', percent: 0, label: '保存原始文件' });
        await saveRawFiles();
        rawSaved = true;
      } catch (e) {}
    }
    try { await saveMergeTxt(saveBlob, subdir); } catch (e) {}
    await cleanupOPFS([taskId + '_audio', taskId + '_video']);
    if (!rawSaved) {
      throw new Error(`分离文件保存失败（文件 ${fmtBytes(actualTotal)}）`);
    }
    note = `文件较大（${fmtBytes(actualTotal)}），已保存分离音视频，请按 merge.txt 说明本地合并`;
    notify({ phase: 'merge', percent: 100, label: '已保存分离文件' });
  }

  await cleanupOPFS([taskId + '_audio', taskId + '_video']);
  return { note };
}
