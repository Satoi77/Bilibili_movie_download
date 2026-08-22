### Task 2: 注入接线与嗅探重写（manifest + content.js + content-page.js）

**Files:**
- Modify: `manifest.json:36`（web_accessible_resources.resources 数组）
- Modify: `content.js:6-11`（注入块之前插入解析器注入）
- Modify: `content-page.js:20-37`（删 parseInitialState，getVideoInfo 改走解析器）
- Modify: `content-page.js:60-148`（sniffCollection 整体替换）
- Modify: `content-page.js:1028`（showCollectionTab 嗅探调用处适配 + 旧批量处理器多P展开）
- Create: `content-page.js` 内新增 `ensureParser()`、`flattenTreeToLegacyVideos()` 两个函数

**Interfaces:**
- Consumes: Task 1 的 `window.BiliCollectionParser.{extractInitialState, buildCollectionTree}`
- Produces: `sniffCollection(): Promise<{collectionName, groups}|null>`（新形状，DOM 兜底组的 `partsKnown:false`）；`flattenTreeToLegacyVideos(tree): Array<{bvid,aid,cid,title}>`（临时适配层，Task 4 移除）

- [ ] **Step 1: manifest.json 注册可访问资源**

第 36 行 resources 数组加入 `"lib/collection-parser.js"`：

```json
      "resources": ["content-page.js", "lib/collection-parser.js", "lib/ffmpeg.worker.js", "lib/ffmpeg-core.js", "lib/ffmpeg-core.wasm", "lib/ffmpeg-core.worker.js"],
```

- [ ] **Step 2: content.js 注入解析器（先于 content-page.js）**

将原注入块（6-11 行）替换为：

```js
  // 合集解析器（ESM）：以 module 方式注入页面世界，执行后挂 window.BiliCollectionParser。
  // 模块脚本为异步加载，与下方经典脚本的先后顺序不保证，消费方以轮询等待兜底（同 ffmpeg_urls 模式）
  if (!document.getElementById('bilibili-dl-parser')) {
    const p = document.createElement('script');
    p.id = 'bilibili-dl-parser';
    p.type = 'module';
    p.src = chrome.runtime.getURL('lib/collection-parser.js');
    (document.head || document.documentElement).appendChild(p);
  }

  // Always inject page script first (non-blocking)
  if (!document.getElementById('bilibili-downloader-ext')) {
    const s = document.createElement('script');
    s.id = 'bilibili-downloader-ext';
    s.src = chrome.runtime.getURL('content-page.js');
    (document.head || document.documentElement).appendChild(s);
  }
```

- [ ] **Step 3: content-page.js 新增 ensureParser 并改写 getVideoInfo**

在 `notify` 函数（约第 12 行）之后新增：

```js
  // 等待 ESM 解析器就绪（模块脚本异步执行，最长等 5 秒）
  async function ensureParser() {
    if (window.BiliCollectionParser) return window.BiliCollectionParser;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (window.BiliCollectionParser) return window.BiliCollectionParser;
    }
    throw new Error('合集解析器未就绪');
  }
```

删除整个 `parseInitialState` 函数（20-30 行），将 `getVideoInfo` 替换为：

```js
  async function getVideoInfo(url) {
    const html = await fetchPageHTML(url);
    const parser = await ensureParser();
    const st = parser.extractInitialState(html);
    if (!st || !st.videoData) return null;
    const vd = st.videoData;
    return { aid: vd.aid, bvid: vd.bvid, cid: vd.cid, title: vd.title, pages: vd.pages || [] };
  }
```

- [ ] **Step 4: sniffCollection 整体替换**

原 60-148 行整体替换为：

```js
  async function sniffCollection() {
    try {
      const html = await fetchPageHTML();
      const parser = await ensureParser();
      const state = parser.extractInitialState(html);
      const tree = state && parser.buildCollectionTree(state);
      if (tree) return tree;
    } catch(e) {
      console.warn('[B站下载助手] __INITIAL_STATE__ 解析失败:', e);
    }

    // DOM 兜底（series 页等无状态数据场景）：partsKnown=false 组，入队时经 getVideoInfoByBvid 展开
    const seen = new Set();
    const groups = [];
    document.querySelectorAll('[data-key^="BV"]').forEach(item => {
      const bvid = item.getAttribute('data-key');
      if (!bvid || seen.has(bvid)) return;
      seen.add(bvid);
      const titleEl = item.querySelector('.title-txt') || item.querySelector('[class*="title"]');
      const title = titleEl?.textContent?.trim() || '';
      if (title) {
        groups.push({ title, bvid, aid: '', cover: '', partsKnown: false, parts: [] });
      }
    });
    if (groups.length === 0) return null;
    const collectionName = document.title?.replace(/- Bilibili.*$/, '').replace(/_哔哩哔哩.*$/, '').trim() || '合集下载';
    console.log('[B站下载助手] DOM 兜底嗅探:', groups.length, '个视频');
    return { collectionName, groups };
  }
```

紧随其后新增适配层（供旧版扁平 UI 继续工作，Task 4 移除）：

```js
  // 旧版扁平列表 UI 适配层：树 → 平铺单元（已知 cid 直接给，未知组整视频交给 getVideoInfoByBvid）
  function flattenTreeToLegacyVideos(tree) {
    const videos = [];
    for (const g of tree.groups) {
      if (g.partsKnown && g.parts.length > 0) {
        for (const pt of g.parts) {
          videos.push({
            bvid: g.bvid, aid: g.aid, cid: pt.cid,
            title: g.parts.length > 1 ? `${g.title} P${pt.p} ${pt.title}` : g.title
          });
        }
      } else {
        videos.push({ bvid: g.bvid, aid: g.aid, title: g.title });
      }
    }
    return videos;
  }
```

- [ ] **Step 5: showCollectionTab 适配新嗅探形状 + 旧批量处理器展开多P**

showCollectionTab 开头（原 1028 行附近）：

```js
      const { videos, collectionName } = await sniffCollection();
      currentCollectionVideos = videos;
      
      if (videos.length === 0) {
```

改为：

```js
      const tree = await sniffCollection();
      const videos = tree ? flattenTreeToLegacyVideos(tree) : [];
      currentCollectionVideos = videos;

      if (videos.length === 0) {
```

同一函数内渲染合集名的两处 `collectionName` 改为 `tree.collectionName`（模板中 `${collectionName}` 一处、闭包内 console 一处），并在批量点击处理器的 Step 1 循环里，把单条 push 替换为多P展开：

```js
            if (info) {
              // 多P视频展开为多个任务单元（否则只能下到 P1）
              const pgList = (Array.isArray(info.pages) && info.pages.length > 1) ? info.pages : [null];
              for (const pg of pgList) {
                taskInfos.push({
                  taskId: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2,6),
                  aid: info.aid, bvid: info.bvid,
                  cid: pg ? pg.cid : info.cid,
                  title: pg ? `${info.title} P${pg.page} ${pg.part}` : info.title
                });
              }
            } else {
              console.warn('[B站下载助手] Could not get info for:', v.bvid);
            }
```

- [ ] **Step 6: 语法检查与既有测试回归**

Run: `node --check content-page.js; node --check content.js; node --check background.js; node test/collection-parser.test.mjs; node test/failure-alert.test.mjs`
Expected: --check 全部无输出（语法通过），两个测试全绿退出码 0

- [ ] **Step 7: 手动冒烟（加载扩展）**

chrome://extensions 重新加载扩展 → 打开 https://www.bilibili.com/video/BV1sJwezxEpJ → 控制台应出现 `[B站下载助手] Page script loaded` → 打开下载面板"合集嗅探"tab → 应显示 55 个平铺单元（6 视频全部分P），不再是当前视频的 11 分P。

- [ ] **Step 8: 提交**

```bash
git add manifest.json content.js content-page.js
git commit -m "feat(collection): 页面接入两级树解析器，修复嗅探路径并把合集各视频全部分P纳入批量下载"
```

---
