### Task 4: 合集 tab 两级树形 UI 重写

**Files:**
- Modify: `content-page.js`（UI 区：新增 `escAttr/fmtDur/padP` 工具；showCollectionTab 整体替换；删除 Task 2 的 flattenTreeToLegacyVideos；删除 currentCollectionVideos 变量的声明与赋值）

**Interfaces:**
- Consumes: sniffCollection（Task 2 树形状）、getVideoInfoByBvid、getPlayUrl、dashSize、QMAP、notify('ENQUEUE_TASKS'/'UPDATE_TASK_SIZE')
- Produces: 入队条目完整形状 `{taskId, aid, bvid, cid, title:'<一级标题> | <P0n_分P名>', qualityIdx, quality, dir:'<合集名>/<一级标题>', baseName:'<P0n_分P名>'}`（Task 3 已打通消费端）

- [ ] **Step 1: UI 工具函数**

在 UI 区（`let currentVideoInfo = null;` 附近）新增：

```js
  function escAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (!sec) return '';
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function padP(n) { return 'P' + String(n).padStart(2, '0'); }
```

同时删除 `currentCollectionVideos` 变量声明（`let currentCollectionVideos = [];`）、其在 showCollectionTab/waitAndInit 中的赋值与清零（变量不再被引用）。

- [ ] **Step 2: showCollectionTab 整体替换**

删除 Task 2 的 `flattenTreeToLegacyVideos`，并将 showCollectionTab 整体替换为：

```js
  async function showCollectionTab() {
    const body = document.getElementById('bili-dl-body');
    body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;margin:0;';
    body.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">正在嗅探合集视频...</div>';

    const tree = await sniffCollection();
    if (!tree || tree.groups.length === 0) {
      body.style.cssText = '';
      body.innerHTML = `<div style="text-align:center;color:#999;padding:20px;">
        <div style="margin-bottom:8px;">未检测到合集/系列视频</div>
        <div style="font-size:12px;color:#bbb;">提示：请在以下页面使用此功能</div>
        <div style="font-size:12px;color:#bbb;">· UP主合集页面（视频右侧有合集列表）</div>
        <div style="font-size:12px;color:#bbb;">· 系列视频页面</div>
        <div style="font-size:12px;color:#bbb;">· 多P视频页面</div>
      </div>`;
      return;
    }

    // 选择状态：每 group 一个槽位；partsKnown=false 组用 checked 表示整视频勾选
    const sel = tree.groups.map(g => ({
      open: false,
      checked: true,
      parts: g.partsKnown ? g.parts.map(() => true) : []
    }));
    const totalParts = tree.groups.reduce((n, g) => n + g.parts.length, 0);

    // 画质档位探测：对第一个可用分P枚举一次，全批统一使用该档位序号
    let options = [];
    probeLoop:
    for (const g of tree.groups) {
      if (!g.partsKnown) continue;
      for (const pt of g.parts) {
        if (!pt.cid) continue;
        try {
          const data = await getPlayUrl(g.aid, g.bvid, pt.cid, 80);
          if (data?.dash) {
            const byQ = {};
            data.dash.video.forEach(v => { (byQ[v.id] = byQ[v.id] || []).push(v); });
            options = Object.keys(byQ).map(Number).sort((a, b) => b - a).map(q => ({
              q, label: QMAP[q] || q + 'P'
            }));
          }
        } catch (e) {}
        break probeLoop;
      }
    }

    const listElRef = () => document.getElementById('bili-dl-video-list');

    function optionsBlock() {
      if (!options.length) return '<span style="font-size:12px;color:#999;">画质：默认最高</span>';
      return '<span style="display:inline-flex;gap:10px;align-items:center;">' + options.map((o, i) =>
        `<label style="cursor:pointer;font-size:12px;color:#333;"><input type="radio" name="bili-dl-q" value="${i}" ${i === 0 ? 'checked' : ''} style="accent-color:#00a1d6;">${o.label}</label>`
      ).join('') + '</span>';
    }

    body.innerHTML = `
      <div style="flex-shrink:0;padding:14px 16px 0 16px;">
        <div style="margin-bottom:10px;font-weight:600;font-size:14px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(tree.collectionName)}">${escAttr(tree.collectionName)}</div>
        <div style="margin-bottom:10px;padding:8px 12px;background:#f5f5f5;border-radius:6px;font-size:12px;color:#666;">
          共 ${tree.groups.length} 个视频 / ${totalParts} 个分P · 已选 <span id="bili-dl-sel-count">-</span> 个分P
        </div>
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label style="cursor:pointer;font-size:12px;color:#00a1d6;white-space:nowrap;">
            <input type="checkbox" id="bili-dl-select-all" checked style="accent-color:#00a1d6;"> 全选
          </label>
          ${optionsBlock()}
        </div>
      </div>
      <div id="bili-dl-video-list" style="flex:1;overflow-y:auto;padding:4px 16px;"></div>
      <div style="flex-shrink:0;padding:12px 16px;border-top:1px solid #f0f0f0;background:#fff;">
        <button id="bili-dl-batch-go" style="width:100%;padding:12px;background:linear-gradient(135deg,#00a1d6,#fb7299);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">批量下载</button>
      </div>`;

    function groupBadge(g) {
      return g.partsKnown ? (g.parts.length + 'P') : '整视频';
    }

    function renderTree() {
      listElRef().innerHTML = tree.groups.map((g, gi) => {
        const st = sel[gi];
        const partsWrap = g.partsKnown ? `
          <div class="bili-p-wrap" data-gi="${gi}" style="${st.open ? '' : 'display:none;'}margin-top:3px;padding-left:18px;">
            ${g.parts.length ? g.parts.map((pt, pi) => `
              <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px;border:1px solid #f0f0f0;">
                <input type="checkbox" class="bili-p-check" data-gi="${gi}" data-pi="${pi}" ${st.parts[pi] ? 'checked' : ''} style="accent-color:#00a1d6;">
                <span style="color:#00a1d6;font-size:12px;width:36px;flex-shrink:0;">${padP(pt.p)}</span>
                <span style="flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(pt.title)}">${escAttr(pt.title)}</span>
                ${pt.duration ? `<span style="font-size:11px;color:#bbb;flex-shrink:0;">${fmtDur(pt.duration)}</span>` : ''}
              </label>`).join('') : '<div style="font-size:11px;color:#bbb;padding:4px 12px;">无分P信息</div>'}
          </div>` : '';
        return `
          <div style="margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid #e0e0e0;border-radius:6px;">
              <input type="checkbox" class="bili-g-check" data-gi="${gi}" style="accent-color:#00a1d6;">
              <span class="bili-g-title" data-gi="${gi}" style="flex:1;font-size:13px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(g.title)}">${escAttr(g.title)}</span>
              <span style="font-size:11px;color:#999;flex-shrink:0;">${groupBadge(g)}</span>
              ${g.partsKnown ? `<span class="bili-g-arrow" data-gi="${gi}" style="cursor:pointer;color:#00a1d6;font-size:11px;width:14px;text-align:center;flex-shrink:0;transition:transform 0.15s;">▶</span>` : ''}
            </div>
            ${partsWrap}
          </div>`;
      }).join('');
      bindTreeEvents();
      updateCounts();
    }

    // 父级复选框视觉三态同步（indeterminate 无法用 HTML 表达，须设 property）
    function syncGroupVisual(gi) {
      const cb = listElRef().querySelector(`.bili-g-check[data-gi="${gi}"]`);
      if (!cb) return;
      const st = sel[gi];
      if (!st.parts.length) { cb.checked = st.checked; cb.indeterminate = false; return; }
      const someOn = st.parts.some(Boolean);
      cb.checked = st.parts.every(Boolean);
      cb.indeterminate = someOn && !cb.checked;
    }

    function countSelected() {
      let n = 0;
      tree.groups.forEach((g, gi) => {
        if (!g.partsKnown) { if (sel[gi].checked) n += 1; return; }
        n += sel[gi].parts.filter(Boolean).length;
      });
      return n;
    }

    function updateCounts() {
      const n = countSelected();
      const cnt = document.getElementById('bili-dl-sel-count');
      if (cnt) cnt.textContent = String(n);
      const go = document.getElementById('bili-dl-batch-go');
      go.textContent = n > 0 ? `批量下载 ${n} 个分P` : '请至少选择一个分P';
      go.style.opacity = n > 0 ? '1' : '0.5';
      go.style.pointerEvents = n > 0 ? 'auto' : 'none';
    }

    function toggleOpen(gi) {
      sel[gi].open = !sel[gi].open;
      const wrap = listElRef().querySelector(`.bili-p-wrap[data-gi="${gi}"]`);
      if (wrap) wrap.style.display = sel[gi].open ? '' : 'none';
      const ar = listElRef().querySelector(`.bili-g-arrow[data-gi="${gi}"]`);
      if (ar) ar.style.transform = sel[gi].open ? 'rotate(90deg)' : '';
    }

    function bindTreeEvents() {
      document.getElementById('bili-dl-select-all').onchange = (e) => {
        sel.forEach(s => {
          s.checked = e.target.checked;
          if (s.parts.length) s.parts = s.parts.map(() => e.target.checked);
        });
        renderTree();
      };
      listElRef().querySelectorAll('.bili-g-check').forEach(cb => {
        const gi = +cb.dataset.gi;
        syncGroupVisual(gi);
        cb.onchange = () => {
          sel[gi].checked = cb.checked;
          sel[gi].parts = sel[gi].parts.map(() => cb.checked);
          updateCounts();
        };
      });
      listElRef().querySelectorAll('.bili-p-check').forEach(cb => {
        cb.onchange = () => {
          sel[+cb.dataset.gi].parts[+cb.dataset.pi] = cb.checked;
          syncGroupVisual(+cb.dataset.gi);
          updateCounts();
        };
      });
      listElRef().querySelectorAll('.bili-g-title,.bili-g-arrow').forEach(el => {
        el.onclick = () => toggleOpen(+el.dataset.gi);
      });
      document.getElementById('bili-dl-batch-go').onclick = onBatchGo;
    }

    async function onBatchGo() {
      const qIdx = parseInt(document.querySelector('input[name="bili-dl-q"]:checked')?.value || '0');
      const qualityLabel = options[qIdx]?.label || '';

      const directUnits = [];
      const expandGroups = [];
      tree.groups.forEach((g, gi) => {
        if (!g.partsKnown) {
          if (sel[gi].checked) expandGroups.push(g);
          return;
        }
        g.parts.forEach((pt, pi) => {
          if (sel[gi].parts[pi] && pt.cid) directUnits.push({ g, pt });
        });
      });

      hidePanel();

      const mkTask = (g, aid, cid, partTitle, pn) => ({
        taskId: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        aid, bvid: g.bvid, cid,
        title: `${g.title} | ${pn} ${partTitle}`,
        qualityIdx: qIdx,
        quality: qualityLabel,
        dir: `${tree.collectionName}/${g.title}`,
        baseName: `${pn}_${partTitle}`
      });

      const taskItems = directUnits.map(u => mkTask(u.g, u.g.aid, u.pt.cid, u.pt.title, padP(u.pt.p)));

      // DOM 兜底组：入队前拉取视频详情展开其全部分P（spec §4.1 第 4 优先级）
      for (const g of expandGroups) {
        try {
          const info = await getVideoInfoByBvid(g.bvid);
          if (!info) continue;
          const pages = (Array.isArray(info.pages) && info.pages.length > 0)
            ? info.pages
            : [{ page: 1, part: '', cid: info.cid }];
          for (const pg of pages) {
            taskItems.push(mkTask(g, info.aid, pg.cid, pg.part || '', padP(pg.page || 1)));
          }
        } catch (e) {
          console.warn('[B站下载助手] 兜底组解析失败:', g.bvid, e);
        }
      }

      if (taskItems.length === 0) {
        alert('无法获取所选内容的下载信息');
        return;
      }

      notify('ENQUEUE_TASKS', { tasks: taskItems });

      // 异步补全各分P体积（沿用 UPDATE_TASK_SIZE 既有链路；单个失败静默跳过，执行期 quality 上报兜底）
      (async () => {
        for (const it of taskItems) {
          try {
            const d = await getPlayUrl(it.aid, it.bvid, it.cid, 80);
            if (!d?.dash) continue;
            const byQ = {};
            d.dash.video.forEach(v => { (byQ[v.id] = byQ[v.id] || []).push(v); });
            const topQ = Object.keys(byQ).map(Number).sort((a, b) => b - a)[0];
            const topVideo = byQ[topQ].sort((a, b) => b.bandwidth - a.bandwidth)[0];
            const dur = d.dash.duration || Math.round((d.timelength || 0) / 1000);
            notify('UPDATE_TASK_SIZE', {
              taskId: it.taskId,
              videoSize: dashSize(topVideo, dur),
              audioSize: dashSize(d.dash.audio[0], dur)
            });
          } catch (e) {
            console.warn('[B站下载助手] 补全任务体积失败:', it.title, e);
          }
        }
      })();
    }

    renderTree();
  }
```

- [ ] **Step 5: 语法与回归检查**

Run: `node --check content-page.js; node test/collection-parser.test.mjs; node test/output-paths.test.mjs`
Expected: 语法通过，两个测试全绿

- [ ] **Step 6: 提交**

```bash
git add content-page.js
git commit -m "feat(ui): 合集tab两级树形勾选——父子三态联动+统一画质选择+按分P批量入队"
```

---
