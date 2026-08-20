// offscreen.js - FFmpeg merge in offscreen document (MV3)
let ffmpegInstance = null;
let loadPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load: ' + url));
    document.head.appendChild(script);
  });
}

async function loadFFmpeg() {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const extUrl = (path) => chrome.runtime.getURL(path);

    console.log('[FFmpeg Offscreen] Loading ffmpeg.js via script tag...');
    await loadScript(extUrl('lib/ffmpeg.js'));

    const FFmpegClass = self.FFmpegWASM?.FFmpeg || self.FFmpegWASM;
    if (!FFmpegClass) {
      throw new Error('FFmpeg constructor not found. self.FFmpegWASM=' + typeof self.FFmpegWASM);
    }

    ffmpegInstance = new FFmpegClass();

    console.log('[FFmpeg Offscreen] Loading wasm core...');
    await ffmpegInstance.load({
      coreURL: extUrl('lib/ffmpeg-core.js'),
      wasmURL: extUrl('lib/ffmpeg-core.wasm'),
      workerURL: extUrl('lib/ffmpeg-core.worker.js')
    });

    console.log('[FFmpeg Offscreen] Loaded successfully');
    return ffmpegInstance;
  })();

  return loadPromise;
}

function openMergeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('BiliMergeData', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readBlobFromDB(key) {
  const db = await openMergeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlobFromDB(key) {
  const db = await openMergeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const req = tx.objectStore('blobs').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function mergeWithFFmpeg(taskId) {
  const ffmpeg = await loadFFmpeg();

  const audioBuf = await readBlobFromDB(taskId + '_audio');
  const videoBuf = await readBlobFromDB(taskId + '_video');
  
  if (!audioBuf || !videoBuf) {
    throw new Error('Audio or video data not found in IndexedDB for task: ' + taskId);
  }

  console.log('[FFmpeg Offscreen] Read from DB, audio:', audioBuf.byteLength, 'video:', videoBuf.byteLength);
  await ffmpeg.writeFile('audio.m4s', new Uint8Array(audioBuf));
  await ffmpeg.writeFile('video.m4s', new Uint8Array(videoBuf));

  console.log('[FFmpeg Offscreen] Running merge...');
  await ffmpeg.exec(['-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4']);

  const result = await ffmpeg.readFile('output.mp4');
  console.log('[FFmpeg Offscreen] Merge done, output size:', result.length);

  await ffmpeg.deleteFile('audio.m4s');
  await ffmpeg.deleteFile('video.m4s');
  await ffmpeg.deleteFile('output.mp4');

  // Cleanup source blobs from DB
  await deleteBlobFromDB(taskId + '_audio');
  await deleteBlobFromDB(taskId + '_video');

  return result.buffer;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreen_merge_request') {
    const { taskId } = message.data;

    console.log('[FFmpeg Offscreen] Merge request for task:', taskId);

    mergeWithFFmpeg(taskId)
      .then(merged => {
        console.log('[FFmpeg Offscreen] Merge success, sending result back');
        chrome.runtime.sendMessage({
          type: 'offscreen_merge_result',
          data: { taskId, success: true, buffer: merged }
        });
      })
      .catch(e => {
        console.error('[FFmpeg Offscreen] Merge failed:', e);
        chrome.runtime.sendMessage({
          type: 'offscreen_merge_result',
          data: { taskId, success: false, error: e.message }
        });
      });

    return false;
  }
});
