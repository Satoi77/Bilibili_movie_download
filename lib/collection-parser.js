// lib/collection-parser.js - 合集两级树解析核心（纯函数，无 DOM/chrome 依赖）
// 双环境：Node ESM 单测直接 import；页面世界由 content.js 以 <script type="module">
// 注入后挂到 window.BiliCollectionParser，供经典脚本 content-page.js 轮询取用

export function extractInitialState(html) {
  if (!html) return null;
  const m = html.match(/<script>window\.__INITIAL_STATE__=(.+?)<\/script>/);
  if (!m || !m[1]) return null;
  try {
    const s = m[1].replace(/;\(function\(\)\{.*?\}\(\)\);?$/, '');
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// episode.pages 缺失时用 availableVideoList 同 bvid 条目补齐（availableVideoList.list[].p/title 与 pages.page/part 对应）
function partsFromAvailableList(avList, bvid) {
  const hit = (Array.isArray(avList) ? avList : []).find(v => v && v.bvid === bvid);
  if (!hit || !Array.isArray(hit.list) || hit.list.length === 0) return null;
  return hit.list.map(it => ({
    p: it.p || 1,
    cid: it.cid,
    title: it.title || '',
    duration: 0
  }));
}

function episodeParts(ep, avList) {
  if (Array.isArray(ep.pages) && ep.pages.length > 0) {
    return ep.pages.map(pg => ({
      p: pg.page || 1,
      cid: pg.cid,
      title: pg.part || ('P' + (pg.page || 1)),
      duration: pg.duration || 0
    }));
  }
  const alt = partsFromAvailableList(avList, ep.bvid);
  if (alt) return alt;
  // 兜底：仅 P1（cid 取 episode 自身），与旧版"每个合集视频只下 P1"的行为一致
  return [{ p: 1, cid: ep.cid, title: '', duration: 0 }];
}

/**
 * 从 __INITIAL_STATE__ 构建合集两级树
 * @returns {{collectionName: string, groups: Array}|null} null 表示状态数据不可用，调用方走 DOM 兜底
 */
export function buildCollectionTree(state) {
  const st = state || {};
  const vd = st.videoData || {};

  // ① 合集模式：videoData.ugc_season.sections[].episodes[]
  // 多 section 平铺为一层 groups（section 只是"正片/花絮"类分组标签，不作树的第三层级）
  const season = vd.ugc_season;
  if (season && Array.isArray(season.sections) && season.sections.length > 0) {
    const avList = Array.isArray(st.availableVideoList) ? st.availableVideoList : [];
    const groups = [];
    const seen = new Set();
    for (const sec of season.sections) {
      for (const ep of (Array.isArray(sec.episodes) ? sec.episodes : [])) {
        if (!ep || !ep.bvid || seen.has(ep.bvid)) continue;
        seen.add(ep.bvid);
        groups.push({
          title: ep.title || (ep.arc && ep.arc.title) || ep.bvid,
          bvid: ep.bvid,
          aid: (ep.aid != null) ? ep.aid : ((ep.arc && ep.arc.aid != null) ? ep.arc.aid : ''),
          cover: (ep.arc && ep.arc.pic) || '',
          partsKnown: true,
          parts: episodeParts(ep, avList)
        });
      }
    }
    if (groups.length > 0) {
      return { collectionName: season.title || vd.title || '', groups };
    }
  }

  // ② 单视频多P回退：当前视频作为唯一分组，分P全展开
  if (Array.isArray(vd.pages) && vd.pages.length > 1) {
    return {
      collectionName: vd.title || '',
      groups: [{
        title: vd.title || '',
        bvid: vd.bvid || '',
        aid: (vd.aid != null) ? vd.aid : '',
        cover: '',
        partsKnown: true,
        parts: vd.pages.map(pg => ({
          p: pg.page || 1,
          cid: pg.cid,
          title: pg.part || ('P' + (pg.page || 1)),
          duration: pg.duration || 0
        }))
      }]
    };
  }

  // ③ 单P回退：保持旧单视频能力
  if (vd.bvid && vd.cid) {
    return {
      collectionName: vd.title || '',
      groups: [{
        title: vd.title || '',
        bvid: vd.bvid,
        aid: (vd.aid != null) ? vd.aid : '',
        cover: '',
        partsKnown: true,
        parts: [{ p: 1, cid: vd.cid, title: vd.title || '', duration: 0 }]
      }]
    };
  }

  return null;
}

// 页面世界挂载（Node/offscreen/SW 无 window，自动跳过）
if (typeof window !== 'undefined') {
  window.BiliCollectionParser = { extractInitialState, buildCollectionTree };
}
