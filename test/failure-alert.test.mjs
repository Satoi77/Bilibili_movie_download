// 告警文案与生命周期单测:node test/failure-alert.test.mjs
import { friendlyError, buildAlertText, createAlertManager } from '../lib/failure-alert.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}

console.log('friendlyError 映射');
assert(friendlyError('Failed to fetch') === '网络连接中断', 'Failed to fetch→网络连接中断');
assert(friendlyError('TypeError: Failed to fetch') === '网络连接中断', '带前缀也命中');
assert(friendlyError('流 HTTP 403') === 'CDN 防盗链拦截', '403→防盗链');
assert(friendlyError('音频 HTTP 502') === '音频 HTTP 502', '未识别状态码保留原文');
assert(friendlyError('下载超时（长时间无进度），原位重启') === '下载超时（长时间无进度），原位重启', '中文超时原文保留');
assert(friendlyError('') === '未知错误', '空值兜底');

console.log('buildAlertText 两种文案');
const d = { title: '测试视频', error: 'Failed to fetch', attempt: 2, maxRetries: 3 };
assert(buildAlertText({ ...d, retrying: true }) === '《测试视频》下载失败：网络连接中断，正在自动重试（第 2/3 次）', '重试中文案');
assert(buildAlertText({ ...d, retrying: false }) === '《测试视频》下载失败：网络连接中断，已停止重试', '最终失败文案');

console.log('createAlertManager 生命周期（注入假定时器）');
function makeClock() {
  let t = 0, seq = 0;
  const jobs = new Map();
  return {
    now: () => t,
    scheduleTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { at: t + ms, fn }); return id; },
    cancelTimeout: (id) => { jobs.delete(id); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = Math.max(t, due[1].at); jobs.delete(due[0]); due[1].fn();
      }
      t = end;
    }
  };
}
{
  const clock = makeClock();
  const renders = [];
  const m = createAlertManager({
    now: clock.now, scheduleTimeout: clock.scheduleTimeout, cancelTimeout: clock.cancelTimeout,
    onRender: (s) => renders.push(s.map(a => a.state).join(','))
  });
  m.add('第一条', 'retry');
  m.add('第二条', 'final');
  assert(m.size === 2 && m.all()[0].text === '第一条' && m.all()[1].kind === 'final', '堆叠顺序与 kind');
  clock.tick(5999);
  assert(m.size === 2 && m.all().every(a => a.state === 'active'), '未到期仍 active');
  clock.tick(1);
  assert(m.size === 2 && m.all().every(a => a.state === 'leaving'), '6000ms 转 leaving');
  clock.tick(299);
  assert(m.size === 2, '淡出未结束不移除');
  clock.tick(1);
  assert(m.size === 0, '6300ms 全部移除');
  assert(renders.includes('leaving,leaving') && renders[renders.length - 1] === '', '渲染序列包含 leaving 与清空');
}
{
  const clock = makeClock();
  const m = createAlertManager({
    now: clock.now, scheduleTimeout: clock.scheduleTimeout, cancelTimeout: clock.cancelTimeout,
    onRender: () => {}
  });
  const id = m.add('手动关闭', 'final');
  clock.tick(1000);
  assert(m.dismiss(id) === true && m.size === 0, '× 提前移除');
  clock.tick(10000);
  assert(m.size === 0, '移除后定时器已取消,不会复活');
  assert(m.dismiss(id) === false, '重复 dismiss 幂等返回 false');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
