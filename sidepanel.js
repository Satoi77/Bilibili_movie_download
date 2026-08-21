// sidepanel.js
let tasks = [];

// 监听目录选择结果
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DIR_PICKER_RESULT' && message.data?.name) {
    document.getElementById('download-dir').value = message.data.name;
  }
});

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
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    default: return '等待中';
  }
}

function getStatusColor(task) {
  switch(task.status) {
    case 'downloading': return '#00a1d6';
    case 'completed': return '#4caf50';
    case 'failed': return '#f44336';
    case 'paused': return '#ff9800';
    default: return '#999';
  }
}

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

async function loadTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_TASKS' }, (response) => {
      if (response?.tasks) tasks = response.tasks;
      resolve();
    });
  });
}

function renderTasks() {
  const downloading = tasks.filter(t => t.status === 'downloading');
  const completed = tasks.filter(t => t.status === 'completed').sort((a, b) => (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || ''));
  const failed = tasks.filter(t => t.status === 'failed');
  
  document.getElementById('downloading-count').textContent = downloading.length + failed.length;
  document.getElementById('completed-count').textContent = completed.length;
  
  // Downloading/failed list
  const dlList = document.getElementById('downloading-list');
  const activeTasks = [...downloading, ...failed];
  
  if (activeTasks.length === 0) {
    dlList.innerHTML = '<div class="empty-state">暂无下载任务<br><span style="font-size:12px;color:#bbb;">在视频页面点击下载按钮开始</span></div>';
  } else {
    dlList.innerHTML = activeTasks.map(t => {
      const downloadP = t.progress?.download || 0;
      const mergeP = t.progress?.merge || 0;
      const overall = t.status === 'completed' ? 100 : 
                      t.status === 'failed' ? 0 : 
                      mergeP > 0 ? Math.round(90 + mergeP * 0.1) :
                      downloadP;
      const phaseLabel = mergeP > 0 ? '合并中' : '下载中';
      
      return `
        <div class="task-card ${t.status}">
          <div class="task-header-row">
            <div class="task-title" title="${t.title}">${t.title}</div>
            <button class="btn-delete-task" data-id="${t.id}" title="删除">&times;</button>
          </div>
          <div class="task-meta">
            <span class="task-quality">${t.quality || ''}</span>
            <span class="task-status" style="color:${getStatusColor(t)}">${getStatusText(t)}</span>
            ${t.delayMessage ? `<span class="task-delay" style="color:#ff9800;margin-left:8px;font-size:12px;">${t.delayMessage}</span>` : ''}
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
    
    dlList.querySelectorAll('.btn-delete-task').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const task = tasks.find(t => t.id === id);
        const msg = task ? `确定删除「${task.title}」的任务记录？` : '确定删除？';
        if (await showConfirm(msg)) {
          chrome.runtime.sendMessage({ type: 'DELETE_TASK', data: { taskId: id } });
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
        for (const t of completed) {
          const id = t.id;
          if (!id) continue;
          chrome.runtime.sendMessage({ type: 'DELETE_TASK', data: { taskId: id } });
          tasks = tasks.filter(task => task.id !== id);
        }
        renderTasks();
      }
    });
    
    cmList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const task = tasks.find(t => t.id === id);
        const msg = task ? `确定删除「${task.title}」的任务记录？` : '确定删除？';
        if (await showConfirm(msg)) {
          chrome.runtime.sendMessage({ type: 'DELETE_TASK', data: { taskId: id } });
          tasks = tasks.filter(t => t.id !== id);
          renderTasks();
        }
      };
    });
  }
}

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// Listen for real-time updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TASK_ADDED') {
    if (!tasks.find(t => t.id === message.data.id)) {
      tasks.push(message.data);
    }
    renderTasks();
  }
  
  if (message.type === 'TASK_UPDATED') {
    const idx = tasks.findIndex(t => t.id === message.data.id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...message.data };
    } else {
      tasks.push(message.data);
    }
    renderTasks();
  }
  
  if (message.type === 'TASK_REMOVED') {
    tasks = tasks.filter(t => t.id !== message.data.taskId);
    renderTasks();
  }
});

// Clear failed tasks
document.getElementById('clear-failed')?.addEventListener('click', async () => {
  const failedIds = tasks.filter(t => t.status === 'failed' && t.id).map(t => t.id);
  if (failedIds.length === 0) return;
  if (await showConfirm(`确定清理 ${failedIds.length} 个失败任务？`)) {
    failedIds.forEach(id => {
      chrome.runtime.sendMessage({ type: 'DELETE_TASK', data: { taskId: id } });
    });
    tasks = tasks.filter(t => t.status !== 'failed');
    renderTasks();
  }
});

// Settings - 互斥逻辑
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

// 浏览按钮 - 触发 content-page 的 showDirectoryPicker
document.getElementById('browse-dir')?.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SHOW_DIR_PICKER' });
    }
  });
});

document.getElementById('save-settings')?.addEventListener('click', () => {
  const settings = {
    delayMin: parseInt(document.getElementById('delay-min').value),
    delayMax: parseInt(document.getElementById('delay-max').value),
    retryTimes: parseInt(document.getElementById('retry-times').value),
    deleteRawAfterMerge: document.getElementById('delete-raw-after-merge').checked,
    saveRawFiles: document.getElementById('save-raw-files').checked,
    downloadDir: document.getElementById('download-dir').value.trim()
  };
  chrome.storage.local.set({ settings }, () => {
    const btn = document.getElementById('save-settings');
    btn.textContent = '已保存!';
    setTimeout(() => btn.textContent = '保存设置', 2000);
  });
});

chrome.storage.local.get('settings', (result) => {
  if (result.settings) {
    const s = result.settings;
    if (s.delayMin) document.getElementById('delay-min').value = s.delayMin;
    if (s.delayMax) document.getElementById('delay-max').value = s.delayMax;
    if (s.retryTimes) document.getElementById('retry-times').value = s.retryTimes;
    if (s.downloadDir) document.getElementById('download-dir').value = s.downloadDir;
    if (s.saveRawFiles) {
      document.getElementById('save-raw-files').checked = true;
    } else if (s.deleteRawAfterMerge) {
      document.getElementById('delete-raw-after-merge').checked = true;
    }
  }
});

// Init
loadTasks().then(renderTasks);
