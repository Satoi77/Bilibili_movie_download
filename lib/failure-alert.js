// 下载失败告警的纯逻辑:文案映射 + toast 生命周期管理(DOM 由 onRender 注入)

export function friendlyError(raw) {
  const s = String(raw || '');
  if (/Failed to fetch/i.test(s)) return '网络连接中断';
  if (/流 HTTP 403/.test(s)) return 'CDN 防盗链拦截';
  return s || '未知错误';
}

export function buildAlertText(data) {
  const reason = friendlyError(data.error);
  if (data.retrying) {
    return `《${data.title}》下载失败：${reason}，正在自动重试（第 ${data.attempt}/${data.maxRetries} 次）`;
  }
  return `《${data.title}》下载失败：${reason}，已停止重试`;
}

const ALERT_LIFE_MS = 6000;
const ALERT_FADE_MS = 300;

// state: 'active' → 'leaving'(淡出中) → 移除;kind: 'retry' | 'final'
export function createAlertManager({
  now = () => Date.now(),
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  onRender
} = {}) {
  let seq = 0;
  const alerts = [];
  function remove(id) {
    const i = alerts.findIndex(a => a.id === id);
    if (i < 0) return false;
    const a = alerts[i];
    if (a.t1) cancelTimeout(a.t1);
    if (a.t2) cancelTimeout(a.t2);
    alerts.splice(i, 1);
    return true;
  }
  function render() { if (onRender) onRender(all()); }
  function all() { return alerts.map(({ id, text, kind, state }) => ({ id, text, kind, state })); }
  return {
    add(text, kind) {
      const id = ++seq;
      const a = { id, text, kind, state: 'active', t1: null, t2: null };
      alerts.push(a);
      a.t1 = scheduleTimeout(() => {
        a.state = 'leaving';
        render();
        a.t2 = scheduleTimeout(() => { remove(id); render(); }, ALERT_FADE_MS);
      }, ALERT_LIFE_MS);
      render();
      return id;
    },
    dismiss(id) { const ok = remove(id); if (ok) render(); return ok; },
    all,
    get size() { return alerts.length; }
  };
}
