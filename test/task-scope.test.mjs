// 「删除全部」作用域单测:node test/task-scope.test.mjs
// 回归背景:「删除全部」按钮位于「下载中」tab,曾因未过滤状态连「已完成」记录一并删除(越界)
import { ACTIVE_TASK_STATUSES, isActiveTask } from '../lib/db.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}

console.log('ACTIVE_TASK_STATUSES 与「下载中」页面范围一致');
{
  assert(
    JSON.stringify([...ACTIVE_TASK_STATUSES].sort()) === JSON.stringify(['downloading', 'failed', 'paused', 'pending']),
    '仅含 pending/downloading/paused/failed',
    JSON.stringify(ACTIVE_TASK_STATUSES)
  );
}

console.log('isActiveTask 判定');
{
  assert(isActiveTask({ id: '1', status: 'pending' }), 'pending → 活动');
  assert(isActiveTask({ id: '1', status: 'downloading' }), 'downloading → 活动');
  assert(isActiveTask({ id: '1', status: 'paused' }), 'paused → 活动');
  assert(isActiveTask({ id: '1', status: 'failed' }), 'failed → 活动');
  assert(!isActiveTask({ id: '1', status: 'completed' }), 'completed → 非活动(不得被「删除全部」波及)');
  assert(!isActiveTask({ id: '1' }), '无 status → 非活动');
  assert(!isActiveTask(null), 'null → 非活动');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
