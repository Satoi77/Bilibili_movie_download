// sidepanel.js
// 所有数据读写通过 background.js 消息，不直接访问存储

let tasks = [];

// ─── Icons ───

const ICON_PLAY = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

// ─── Unified Messaging Helpers ───

function msg(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, data }, (result) => {
      if (chrome.runtime.lastError) {
        console.error('[B站下载助手] 消息发送失败:', type, chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(result);
      }
    });
  });
}

// ─── Formatters ───

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes > 1073741824) return (bytes/1073741824).toFixed(2)+'GB';
  if (bytes > 1048576) return (bytes/1048576).toFixed(2)+'MB';
  if (bytes > 1024) return (bytes/1024).toFixed(2)+'KB';
  return bytes+'B';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function getStatusText(task) {
  switch(task.status) {
    case 'downloading': return '下载中';
    case 'pending': return '等待中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    default: return '等待中';
  }
}

function getStatusColor(task) {
  switch(task.status) {
    case 'downloading': return '#00a1d6';
    case 'pending': return '#9e9e9e';
    case 'completed': return '#4caf50';
    case 'failed': return '#f44336';
    case 'paused': return '#ff9800';
    default: return '#999';
  }
}

// ─── Confirm Dialog ───

function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;max-width:320px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <div style="font-size:14px;color:#333;margin-bottom:20px;line-height:1.5;">${msg}</div>
        <div style="display:flex;gap:12px;justify-content:flex-end;">
          <button id="confirm-cancel" style="padding:8px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;cursor:pointer;font-size:13px;">取消</button>
          <button id="confirm-ok" style="padding:8px 20px;border:none;border-radius:6px;background:#f44336;color:#fff;cursor:pointer;font-size:13px;">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
  });
}

// ─── Render ───

// 进度更新很频繁，合并 50ms 内的多次渲染请求
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderTasks(); }, 50);
}

function renderTasks() {
  const downloading = tasks.filter(t => t.status === 'downloading');
  const active = tasks.filter(t => ['pending', 'downloading', 'paused', 'failed'].includes(t.status));
  const completed = tasks.filter(t => t.status === 'completed').sort((a, b) => (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || ''));
  const failed = tasks.filter(t => t.status === 'failed');
  
  document.getElementById('downloading-count').textContent = active.length;
  document.getElementById('completed-count').textContent = completed.length;
  
  // 全部停止/继续按钮状态
  const toggleBtn = document.getElementById('toggle-all');
  if (toggleBtn) {
    const hasRunning = downloading.length > 0 || tasks.some(t => t.status === 'pending');
    const hasPaused = tasks.some(t => t.status === 'paused');
    if (hasRunning) {
      toggleBtn.textContent = '全部停止';
      toggleBtn.dataset.action = 'stop';
      toggleBtn.disabled = false;
    } else if (hasPaused) {
      toggleBtn.textContent = '全部继续';
      toggleBtn.dataset.action = 'start';
      toggleBtn.disabled = false;
    } else {
      toggleBtn.textContent = '全部停止';
      toggleBtn.dataset.action = 'stop';
      toggleBtn.disabled = true;
    }
  }
  
  // Downloading/pending/paused/failed list
  const dlList = document.getElementById('downloading-list');
  
  if (active.length === 0) {
    dlList.innerHTML = '<div class="empty-state">暂无下载任务<br><span style="font-size:12px;color:#bbb;">在视频页面点击下载按钮开始</span></div>';
  } else {
    dlList.innerHTML = active.map(t => {
      const audioP = t.progress?.audio || 0;
      const videoP = t.progress?.video || 0;
      const mergeP = t.progress?.merge || 0;
      const overall = t.status === 'completed' ? 100 : 
                      t.status === 'failed' ? 0 : 
                      mergeP > 0 ? Math.round(90 + mergeP * 0.1) :
                      Math.round((audioP + videoP) / 2);
      let phaseLabel = '下载中';
      if (t.status === 'pending') phaseLabel = '等待中';
      else if (t.status === 'paused') phaseLabel = '已暂停';
      else if (t.status === 'failed') phaseLabel = '—';
      else if (mergeP > 0) phaseLabel = '合并中';
      
      const isStop = t.status === 'downloading';
      const controlIcon = isStop ? ICON_PAUSE : ICON_PLAY;
      
      return `
        <div class="task-card ${t.status}">
          <div class="task-header-row">
            <div class="task-title" title="${t.title}">${t.title}</div>
            <button class="btn-task-control ${isStop ? 'stop' : 'start'}" data-id="${t.id}" data-action="${isStop ? 'stop' : 'start'}" title="${isStop ? '停止' : '开始'}">${controlIcon}</button>
            <button class="btn-delete-task" data-id="${t.id}" title="删除">&times;</button>
          </div>
          <div class="task-meta">
            <span class="task-quality">${t.quality || ''}</span>
            <span class="task-status" style="color:${getStatusColor(t)}">${getStatusText(t)}</span>
            ${t.error ? `<span class="task-error" title="${t.error}">(${t.error})</span>` : ''}
          </div>
          <div class="task-progress-section">
            <div class="progress-row">
              <span class="progress-label">${phaseLabel}</span>
              <div class="progress-bar">
                <div class="progress-fill" style="width:${overall}%;background:${getStatusColor(t)}"></div>
              </div>
              <span class="progress-pct">${overall}%</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    
    dlList.querySelectorAll('.btn-task-control').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const action = btn.getAttribute('data-action');
        if (action === 'stop') {
          await msg('STOP_TASK', { taskId: id });
        } else {
          await msg('RESUME_TASK', { taskId: id });
        }
      };
    });
    
    dlList.querySelectorAll('.btn-delete-task').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const task = tasks.find(t => t.id === id);
        const msgText = task ? `确定删除「${task.title}」的任务记录？` : '确定删除？';
        if (await showConfirm(msgText)) {
          await msg('DELETE_TASK', { taskId: id });
          tasks = tasks.filter(t => t.id !== id);
          renderTasks();
        }
      };
    });
  }
  
  // Completed list
  const cmList = document.getElementById('completed-list');
  if (completed.length === 0) {
    cmList.innerHTML = '<div class="empty-state">暂无已完成任务</div>';
  } else {
    cmList.innerHTML = `<div class="clear-all-btn" id="clear-completed" style="text-align:right;margin-bottom:8px;">
      <button class="btn-delete" style="background:transparent;border:1px solid #ff6699;color:#ff6699;padding:3px 12px;border-radius:4px;cursor:pointer;font-size:12px;">清空已完成</button>
    </div>` + completed.map(t => `
      <div class="task-card completed">
        <div class="task-title" title="${t.title}">${t.title}</div>
        <div class="task-meta">
          <span class="task-quality">${t.quality || ''}</span>
          <span class="task-time">${fmtTime(t.completedAt)}</span>
        </div>
        <div class="task-actions">
          <button class="btn-delete" data-id="${t.id}">删除</button>
        </div>
      </div>
    `).join('');
    
    document.getElementById('clear-completed')?.addEventListener('click', async () => {
      if (await showConfirm(`确定清空 ${completed.length} 个已完成任务的记录？`)) {
        await msg('CLEAR_COMPLETED');
        const result = await msg('GET_TASKS');
        tasks = result?.tasks || [];
        renderTasks();
      }
    });
    
    cmList.querySelectorAll('.btn-delete[data-id]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const task = tasks.find(t => t.id === id);
        const msgText = task ? `确定删除「${task.title}」的任务记录？` : '确定删除？';
        if (await showConfirm(msgText)) {
          await msg('DELETE_TASK', { taskId: id });
          const result = await msg('GET_TASKS');
          tasks = result?.tasks || [];
          renderTasks();
        }
      };
    });
  }
}

// ─── Tabs ───

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── Real-time Updates from Background ───

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TASK_ADDED') {
    if (!tasks.find(t => t.id === message.data.id)) {
      tasks.push(message.data);
    }
    scheduleRender();
  }
  
  if (message.type === 'TASK_UPDATED') {
    const idx = tasks.findIndex(t => t.id === message.data.id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...message.data };
    } else {
      tasks.push(message.data);
    }
    scheduleRender();
  }
  
  if (message.type === 'TASK_REMOVED') {
    tasks = tasks.filter(t => t.id !== message.data.taskId);
    scheduleRender();
  }
});

// ─── Batch Controls ───

document.getElementById('toggle-all')?.addEventListener('click', async () => {
  const btn = document.getElementById('toggle-all');
  const action = btn?.dataset.action;
  if (action === 'stop') {
    await msg('STOP_ALL');
  } else {
    await msg('RESUME_ALL');
  }
  const result = await msg('GET_TASKS');
  tasks = result?.tasks || [];
  renderTasks();
});

document.getElementById('delete-all')?.addEventListener('click', async () => {
  if (tasks.length === 0) return;
  if (await showConfirm(`确定删除全部 ${tasks.length} 个任务？此操作不可撤销。`)) {
    await msg('DELETE_ALL');
    const result = await msg('GET_TASKS');
    tasks = result?.tasks || [];
    renderTasks();
  }
});

// ─── Clear Failed Tasks ───

document.getElementById('clear-failed')?.addEventListener('click', async () => {
  const failedIds = tasks.filter(t => t.status === 'failed' && t.id).map(t => t.id);
  if (failedIds.length === 0) return;
  if (await showConfirm(`确定清理 ${failedIds.length} 个失败任务？`)) {
    for (const id of failedIds) {
      await msg('DELETE_TASK', { taskId: id });
    }
    tasks = tasks.filter(t => t.status !== 'failed');
    renderTasks();
  }
});

// ─── Settings: Mutual Exclusion ───

document.getElementById('save-raw-files')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    document.getElementById('delete-raw-after-merge').checked = false;
  }
});

document.getElementById('delete-raw-after-merge')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    document.getElementById('save-raw-files').checked = false;
  }
});

// ─── Save Settings ───

document.getElementById('save-settings')?.addEventListener('click', async () => {
  const settings = {
    delayMin: parseInt(document.getElementById('delay-min').value),
    delayMax: parseInt(document.getElementById('delay-max').value),
    retryTimes: parseInt(document.getElementById('retry-times').value),
    deleteRawAfterMerge: document.getElementById('delete-raw-after-merge').checked,
    saveRawFiles: document.getElementById('save-raw-files').checked
  };
  await msg('SAVE_SETTINGS', { settings });
  const btn = document.getElementById('save-settings');
  btn.textContent = '已保存!';
  setTimeout(() => btn.textContent = '保存设置', 2000);
});

// ─── Init ───

(async () => {
  // Load tasks
  const result = await msg('GET_TASKS');
  tasks = result?.tasks || [];
  renderTasks();

  // Load settings
  const settings = await msg('GET_SETTINGS');
  if (settings) {
    if (settings.delayMin) document.getElementById('delay-min').value = settings.delayMin;
    if (settings.delayMax) document.getElementById('delay-max').value = settings.delayMax;
    if (settings.retryTimes) document.getElementById('retry-times').value = settings.retryTimes;
    if (settings.saveRawFiles) {
      document.getElementById('save-raw-files').checked = true;
    } else if (settings.deleteRawAfterMerge) {
      document.getElementById('delete-raw-after-merge').checked = true;
    }
  }
})();
