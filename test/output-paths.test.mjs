// 输出路径规则单测: node test/output-paths.test.mjs
import { resolveOutputTargets, DOWNLOAD_BASE } from '../lib/download-core.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}

console.log('单视频路径（无 dir）—— 必须与历史行为一致');
{
  const t = resolveOutputTargets({ title: '我的视频' }, '1080P');
  assert(t.mergedDir === DOWNLOAD_BASE, '合并输出在根目录');
  assert(t.mergedName === '我的视频_1080P.mp4', '合并文件名=标题_画质');
  assert(t.rawSubdir === DOWNLOAD_BASE + '/我的视频', '分离文件落标题子目录');
}

console.log('批量路径（有 dir/baseName）—— 三级目录');
{
  const t = resolveOutputTargets(
    { title: '一级标题', dir: 'ESP32合集/一级标题', baseName: 'P03_启动流程' }, '720P');
  assert(t.mergedDir === DOWNLOAD_BASE + '/ESP32合集/一级标题', '合并输出进三级目录');
  assert(t.mergedName === 'P03_启动流程_720P.mp4', '合并文件名=baseName_画质');
  assert(t.rawSubdir === DOWNLOAD_BASE + '/ESP32合集/一级标题/P03_启动流程', '分离文件按 baseName 隔离子目录');
}

console.log('非法字符清洗发生在输出边界');
{
  const t = resolveOutputTargets({ dir: 'a<b>c/d:e', baseName: 'x*y?"z' }, '4K');
  assert(t.mergedDir === DOWNLOAD_BASE + '/a_b_c/d_e', '目录段逐段清洗');
  assert(t.mergedName === 'x_y__z_4K.mp4', '文件名非法字符替换');
}

console.log('边界入参不抛错');
{
  const t = resolveOutputTargets(null, '');
  assert(t.mergedDir === DOWNLOAD_BASE && t.rawSubdir === DOWNLOAD_BASE + '/_' , '空对象退化为占位名');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
