// modules/parser.js

/**
 * 解析播放地址 API 响应
 */
export function parsePlayUrlResponse(response) {
  if (response.code !== 0) {
    throw new Error(`API error: ${response.message}`);
  }

  const { dash } = response.data;
  if (!dash) {
    throw new Error('No DASH data found');
  }

  const qualities = [];

  // 提取视频流
  const videoStreams = dash.video || [];
  const audioStreams = dash.audio || [];

  // 按质量分组视频流
  const videoByQuality = {};
  videoStreams.forEach(video => {
    const quality = video.id;
    if (!videoByQuality[quality]) {
      videoByQuality[quality] = [];
    }
    videoByQuality[quality].push(video);
  });

  // 为每个质量创建完整信息
  Object.entries(videoByQuality).forEach(([quality, videos]) => {
    // 选择最佳编码的视频
    const bestVideo = videos[0];
    // 选择最佳音频
    const bestAudio = audioStreams[0] || {};

    qualities.push({
      quality: parseInt(quality),
      label: getQualityLabel(quality),
      videoUrl: bestVideo.baseUrl,
      audioUrl: bestAudio.baseUrl || '',
      backupVideoUrls: bestVideo.backupUrl || [],
      backupAudioUrls: bestAudio.backupUrl || [],
      videoCodecs: bestVideo.codecs,
      audioCodecs: bestAudio.codecs
    });
  });

  // 按质量排序（高到低）
  qualities.sort((a, b) => b.quality - a.quality);

  return qualities;
}

/**
 * 获取质量标签
 */
function getQualityLabel(quality) {
  const labels = {
    '16': '360P',
    '32': '480P',
    '64': '720P',
    '80': '1080P',
    '112': '1080P+',
    '116': '1080P60',
    '120': '4K',
    '125': 'HDR',
    '126': 'Dolby Vision',
    '127': '8K'
  };
  return labels[quality] || `${quality}P`;
}

/**
 * 从页面数据提取视频信息
 */
export function extractVideoInfo(bvid, cid, pageTitle, thumbnail) {
  return {
    bvid,
    cid: parseInt(cid),
    title: pageTitle || 'Unknown',
    thumbnail: thumbnail || '',
    duration: 0,
    qualities: []
  };
}

/**
 * 解析合集页面数据
 */
export function parseCollectionData(pageData) {
  const collection = {
    id: '',
    title: '',
    videos: []
  };

  // 从页面数据中提取合集信息
  if (pageData) {
    collection.id = pageData.bvid || '';
    collection.title = pageData.title || '';
    
    if (pageData.pages && Array.isArray(pageData.pages)) {
      collection.videos = pageData.pages.map(page => ({
        bvid: pageData.bvid,
        cid: page.cid,
        title: page.part || `Part ${page.page}`,
        thumbnail: '',
        duration: page.duration || 0,
        qualities: []
      }));
    }
  }

  return collection;
}
