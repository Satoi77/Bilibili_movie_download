import { biliDB } from '../lib/db.js';

class DownloadManager {
  constructor() {
    this.queue = [];
    this.currentTask = null;
    this.isDownloading = false;
    this.settings = {
      maxConcurrent: 1,
      retryTimes: 3,
      delayMin: 3000,
      delayMax: 12000
    };
  }

  async init() {
    const savedSettings = await chrome.storage.local.get('settings');
    if (savedSettings.settings) {
      this.settings = { ...this.settings, ...savedSettings.settings };
    }
    
    const pendingTasks = await biliDB.getTasks('pending');
    const downloadingTasks = await biliDB.getTasks('downloading');
    
    this.queue = [...pendingTasks, ...downloadingTasks];
    
    if (this.queue.length > 0) {
      this.processQueue();
    }
  }

  async addTask(videoInfo, selectedQuality) {
    console.log('[Downloader] Adding task:', videoInfo.title, selectedQuality?.label);
    
    const task = {
      id: this.generateId(),
      video: {
        aid: videoInfo.aid,
        bvid: videoInfo.bvid,
        cid: videoInfo.cid,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail
      },
      selectedQuality,
      status: 'pending',
      progress: {
        audio: 0,
        video: 0,
        merge: 0
      },
      retryCount: 0,
      createdAt: new Date().toISOString()
    };

    await biliDB.addTask(task);
    this.queue.push(task);
    this.notifyTaskAdded(task);
    
    if (!this.isDownloading) {
      this.processQueue();
    }

    return task;
  }

  async processQueue() {
    if (this.isDownloading || this.queue.length === 0) return;

    this.isDownloading = true;
    
    while (this.queue.length > 0) {
      const task = this.queue[0];
      
      task.status = 'downloading';
      await biliDB.updateTask(task);
      this.notifyTaskUpdated(task);
      
      try {
        await this.downloadTask(task);
        
        task.status = 'completed';
        await biliDB.updateTask(task);
        this.notifyTaskUpdated(task);
        
        this.queue.shift();
        
        // Random delay between tasks
        if (this.queue.length > 0) {
          const delay = this.getRandomDelay();
          console.log(`[Downloader] Waiting ${delay}ms before next task`);
          await this.sleep(delay);
        }
        
      } catch (error) {
        console.error('[Downloader] Download failed:', error.message);
        
        task.retryCount++;
        task.lastError = error.message;
        
        if (task.retryCount >= this.settings.retryTimes) {
          task.status = 'failed';
          await biliDB.updateTask(task);
          this.notifyTaskUpdated(task);
          this.queue.shift();
        } else {
          task.status = 'pending';
          await biliDB.updateTask(task);
          this.notifyTaskUpdated(task);
          // Move to end of queue for retry
          this.queue.push(this.queue.shift());
        }
      }
    }

    this.isDownloading = false;
  }

  async downloadTask(task) {
    const quality = task.selectedQuality;
    console.log('[Downloader] Quality:', quality.label, 'Type:', quality.type);
    
    if (quality.type === 'dash') {
      // DASH: download audio + video separately, then merge
      console.log('[Downloader] Downloading DASH streams...');
      
      const audioBlob = await this.downloadStream(
        quality.audioUrl,
        quality.backupAudioUrls,
        (progress) => {
          task.progress.audio = progress;
          this.notifyTaskUpdated(task);
        },
        'audio'
      );
      
      console.log('[Downloader] Audio downloaded, size:', audioBlob.size);

      const videoBlob = await this.downloadStream(
        quality.videoUrl,
        quality.backupVideoUrls,
        (progress) => {
          task.progress.video = progress;
          this.notifyTaskUpdated(task);
        },
        'video'
      );
      
      console.log('[Downloader] Video downloaded, size:', videoBlob.size);

      // Send merge request
      task.progress.merge = 10;
      this.notifyTaskUpdated(task);
      
      try {
        const result = await this.mergeAudioVideo(audioBlob, videoBlob, task);
        console.log('[Downloader] Merge result:', result);
      } catch (mergeError) {
        console.error('[Downloader] Merge failed, saving files separately:', mergeError);
        // Fall back to saving separately
        await this.saveBlob(audioBlob, `${task.video.title}_音频.m4s`);
        await this.saveBlob(videoBlob, `${task.video.title}_视频.m4s`);
      }
      
    } else if (quality.type === 'durl') {
      // DURL: combined stream, just download
      console.log('[Downloader] Downloading DURL stream...');
      
      const urls = [quality.url, ...(quality.backupUrls || [])].filter(u => u);
      const blob = await this.downloadStream(
        urls[0],
        urls.slice(1),
        (progress) => {
          task.progress.video = progress;
          this.notifyTaskUpdated(task);
        },
        'video'
      );
      
      await this.saveBlob(blob, `${task.video.title}.mp4`);
    }
  }

  async downloadStream(url, backupUrls, onProgress, label) {
    const urls = [url, ...(backupUrls || [])].filter(u => u && u.length > 0);
    
    console.log(`[Downloader] ${label} - ${urls.length} URLs to try`);
    
    if (urls.length === 0) {
      throw new Error(`No ${label} download URLs`);
    }
    
    for (const currentUrl of urls) {
      try {
        console.log(`[Downloader] ${label} trying:`, currentUrl.substring(0, 80) + '...');
        
        const response = await fetch(currentUrl, {
          headers: {
            'Referer': 'https://www.bilibili.com',
            'Origin': 'https://www.bilibili.com'
          }
        });
        
        if (!response.ok) {
          console.warn(`[Downloader] ${label} response not ok:`, response.status);
          continue;
        }
        
        const contentLength = parseInt(response.headers.get('content-length') || '0');
        console.log(`[Downloader] ${label} content-length:`, contentLength);
        
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          chunks.push(value);
          receivedLength += value.length;
          
          if (onProgress && contentLength > 0) {
            onProgress(Math.round((receivedLength / contentLength) * 100));
          }
        }

        console.log(`[Downloader] ${label} downloaded:`, receivedLength, 'bytes');
        return new Blob(chunks);
        
      } catch (error) {
        console.warn(`[Downloader] ${label} failed:`, error.message);
        continue;
      }
    }

    throw new Error(`All ${label} download URLs failed`);
  }

  async mergeAudioVideo(audioBlob, videoBlob, task) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Merge timeout'));
      }, 120000);
      
      const listener = (message) => {
        if (message.type === 'MERGE_RESULT') {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          
          if (message.data.success) {
            this.saveBase64(message.data.data, `${task.video.title}.mp4`)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error(message.data.error || 'Merge failed'));
          }
        }
      };
      
      chrome.runtime.onMessage.addListener(listener);
      
      // Convert blobs to base64 and send to merger
      Promise.all([
        this.blobToBase64(audioBlob),
        this.blobToBase64(videoBlob)
      ]).then(([audioBase64, videoBase64]) => {
        task.progress.merge = 50;
        this.notifyTaskUpdated(task);
        
        chrome.runtime.sendMessage({
          type: 'MERGE_FILES',
          data: {
            taskId: task.id,
            audioData: audioBase64,
            videoData: videoBase64,
            filename: task.video.title
          }
        });
      }).catch(reject);
    });
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async saveBase64(dataUrl, filename) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return this.saveBlob(blob, filename);
  }

  async saveBlob(blob, filename) {
    const safeName = filename.replace(/[<>:"/\\|?*]/g, '_');
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        
        chrome.downloads.download({
          url: `data:application/octet-stream;base64,${base64}`,
          filename: safeName,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            console.log('[Downloader] Saved:', safeName, 'downloadId:', downloadId);
            resolve(downloadId);
          }
        });
      };
      reader.onerror = () => reject(new Error('Failed to read blob'));
      reader.readAsDataURL(blob);
    });
  }

  async pauseTask(taskId) {
    const task = await biliDB.getTask(taskId);
    if (task) {
      task.status = 'paused';
      await biliDB.updateTask(task);
      this.queue = this.queue.filter(t => t.id !== taskId);
      this.notifyTaskUpdated(task);
    }
  }

  async resumeTask(taskId) {
    const task = await biliDB.getTask(taskId);
    if (task && task.status === 'paused') {
      task.status = 'pending';
      await biliDB.updateTask(task);
      this.queue.push(task);
      this.notifyTaskUpdated(task);
      
      if (!this.isDownloading) {
        this.processQueue();
      }
    }
  }

  async cancelTask(taskId) {
    await biliDB.deleteTask(taskId);
    this.queue = this.queue.filter(t => t.id !== taskId);
    this.notifyTaskRemoved(taskId);
  }

  getRandomDelay() {
    const { delayMin, delayMax } = this.settings;
    return Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  generateId() {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  notifyTaskAdded(task) {
    try {
      chrome.runtime.sendMessage({ type: 'TASK_ADDED', data: task }).catch(() => {});
    } catch (e) {}
  }

  notifyTaskUpdated(task) {
    try {
      chrome.runtime.sendMessage({ type: 'TASK_UPDATED', data: task }).catch(() => {});
    } catch (e) {}
  }

  notifyTaskRemoved(taskId) {
    try {
      chrome.runtime.sendMessage({ type: 'TASK_REMOVED', data: { taskId } }).catch(() => {});
    } catch (e) {}
  }
}

export const downloadManager = new DownloadManager();
