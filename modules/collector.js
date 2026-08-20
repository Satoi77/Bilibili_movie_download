// modules/collector.js

/**
 * 检测页面是否包含合集
 */
export function detectCollection() {
  const collection = {
    isCollection: false,
    id: '',
    title: '',
    videos: []
  };

  // 方法 1: 检测合集容器
  const collectionContainer = document.querySelector('.video-sections-section, .series-list, .list-box');
  if (collectionContainer) {
    collection.isCollection = true;
    collection.title = document.querySelector('.video-sections-section__title, .series-title')?.textContent || '';
  }

  // 方法 2: 检测页面数据中的合集信息
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const content = script.textContent;
    
    // 提取 __INITIAL_STATE__
    const stateMatch = content.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s);
    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1]);
        
        // 检查视频数据
        if (state.videoData) {
          collection.isCollection = true;
          collection.id = state.videoData.bvid || '';
          collection.title = state.videoData.title || '';
          
          // 提取分P信息
          if (state.videoData.pages && Array.isArray(state.videoData.pages)) {
            collection.videos = state.videoData.pages.map(page => ({
              bvid: state.videoData.bvid,
              cid: page.cid,
              title: page.part || `Part ${page.page}`,
              page: page.page,
              duration: page.duration || 0
            }));
          }
        }
      } catch (e) {
        console.warn('[Collector] Failed to parse state:', e);
      }
    }
  }

  // 方法 3: 检测侧边栏合集列表
  const sidebarCollection = document.querySelector('.right-container .video-episode-card');
  if (sidebarCollection) {
    collection.isCollection = true;
    
    const episodeCards = document.querySelectorAll('.video-episode-card');
    episodeCards.forEach((card, index) => {
      const link = card.querySelector('a');
      const title = card.querySelector('.video-episode-card__info-title')?.textContent || '';
      const duration = card.querySelector('.video-episode-card__info-duration')?.textContent || '';
      
      if (link) {
        const href = link.getAttribute('href');
        const bvidMatch = href.match(/\/video\/(BV\w+)/);
        const cidMatch = href.match(/cid=(\d+)/);
        
        if (bvidMatch && cidMatch) {
          collection.videos.push({
            bvid: bvidMatch[1],
            cid: parseInt(cidMatch[1]),
            title,
            page: index + 1,
            duration
          });
        }
      }
    });
  }

  // 去重
  const uniqueVideos = [];
  const seen = new Set();
  
  for (const video of collection.videos) {
    const key = `${video.bvid}_${video.cid}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueVideos.push(video);
    }
  }
  
  collection.videos = uniqueVideos;

  return collection;
}

/**
 * 从 URL 获取 bvid
 */
export function getBvidFromUrl(url = location.href) {
  const match = url.match(/\/video\/(BV\w+)/);
  return match ? match[1] : null;
}

/**
 * 从 URL 获取合集 ID
 */
export function getCollectionIdFromUrl(url = location.href) {
  const match = url.match(/\/list\/(BV\w+)/);
  return match ? match[1] : null;
}

/**
 * 检测当前页面类型
 */
export function detectPageType() {
  const url = location.href;
  
  if (url.includes('/video/')) {
    return 'video';
  }
  
  if (url.includes('/list/') || url.includes('/series/')) {
    return 'collection';
  }
  
  if (url.includes('/bangumi/')) {
    return 'bangumi';
  }
  
  return 'unknown';
}
