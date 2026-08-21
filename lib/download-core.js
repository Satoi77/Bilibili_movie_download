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

async function saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir, saveBlob) {
  const safeTitle = sanitizeFilename(title);
  const audioForSave = new Blob([await audioBlob.arrayBuffer()], { type: 'video/mp4' });
  const videoForSave = new Blob([await videoBlob.arrayBuffer()], { type: 'video/mp4' });
  const subdir = baseSubdir ? baseSubdir + '/' + safeTitle : safeTitle;
  await saveBlob(audioForSave, 'audio.m4s', subdir);
  await saveBlob(videoForSave, 'video.m4s', subdir);
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

  notify({ phase: 'quality', percent: 0, label });
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  notify({ phase: 'download', percent: 0, label: '下载中' });

  const [audioBlob, videoBlob] = await Promise.all([
    downloadStream(bestAudio.baseUrl, 'audio', signal, notify, fetchFn),
    downloadStream(bestVideo.baseUrl, 'video', signal, notify, fetchFn)
  ]);

  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  notify({ phase: 'download', percent: 100, label: '下载完成' });

  const safeTitle = sanitizeFilename(title);
  const baseSubdir = DOWNLOAD_BASE;
  let rawSaved = false;

  if (settings.saveRawFiles) {
    try {
      notify({ phase: 'merge', percent: 0, label: '保存原始文件' });
      await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir, saveBlob);
      rawSaved = true;
    } catch(e) {}
  }

  try {
    notify({ phase: 'merge', percent: 50, label: '合并中' });
    const ffmpeg = await getFFmpeg();
    const mergedBlob = await mergeAudioVideo(ffmpeg, audioBlob, videoBlob, notify);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await saveBlob(mergedBlob, `${safeTitle}_${label}.mp4`, baseSubdir);
    notify({ phase: 'merge', percent: 100, label: '合并完成' });
  } catch (mergeError) {
    if (signal?.aborted) throw mergeError;
    if (!rawSaved) {
      try { await saveRawToSubdir(audioBlob, videoBlob, title, baseSubdir, saveBlob); } catch(e) {}
    }
    try {
      const txtContent = [
        '将此目录下的 audio.m4s 和 video.m4s 合并为 mp4 文件。',
        '',
        '方法一：使用 ffmpeg 命令行',
        '  ffmpeg -i video.m4s -i audio.m4s -vcodec copy -acodec copy merged.mp4',
        '',
        '方法二：将本文件重命名为 merge.bat，双击运行',
        '  （需要已安装 ffmpeg 并添加到 PATH 环境变量）'
      ].join('\r\n');
      await saveBlob(new Blob([txtContent], { type: 'text/plain' }), 'merge.txt', baseSubdir + '/' + safeTitle);
    } catch(e) {}
    throw new Error('合并失败: ' + mergeError.message);
  }
}
