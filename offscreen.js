// offscreen.js - FFmpeg merge in offscreen document (MV3)
let ffmpegInstance = null;

async function loadFFmpeg() {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  const extUrl = (path) => chrome.runtime.getURL(path);

  console.log('[FFmpeg Offscreen] Loading ffmpeg.js...');
  const resp = await fetch(extUrl('lib/ffmpeg.js'));
  const text = await resp.text();
  eval(text);

  const FFmpegClass = self.FFmpegWASM?.FFmpeg || self.FFmpegWASM;
  if (!FFmpegClass) {
    throw new Error('FFmpeg constructor not found after eval');
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
}

async function mergeWithFFmpeg(audioData, videoData) {
  const ffmpeg = await loadFFmpeg();

  console.log('[FFmpeg Offscreen] Writing files, audio:', audioData.byteLength, 'video:', videoData.byteLength);
  await ffmpeg.writeFile('audio.m4s', new Uint8Array(audioData));
  await ffmpeg.writeFile('video.m4s', new Uint8Array(videoData));
  
  console.log('[FFmpeg Offscreen] Running merge...');
  await ffmpeg.exec(['-i', 'video.m4s', '-i', 'audio.m4s', '-c', 'copy', 'output.mp4']);
  
  const result = await ffmpeg.readFile('output.mp4');
  console.log('[FFmpeg Offscreen] Merge done, output size:', result.length);

  await ffmpeg.deleteFile('audio.m4s');
  await ffmpeg.deleteFile('video.m4s');
  await ffmpeg.deleteFile('output.mp4');

  return result.buffer;
}

// Listen for merge requests
let pendingMerge = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreen_merge_request') {
    const { taskId, audio, video } = message.data;
    
    console.log('[FFmpeg Offscreen] Merge request for task:', taskId);
    
    mergeWithFFmpeg(audio, video)
      .then(merged => {
        console.log('[FFmpeg Offscreen] Merge success, sending result back');
        // Send result back via message (not sendResponse, which may be broken through relay)
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
