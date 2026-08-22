// 复刻 superpowers review-package 脚本：提交列表 + stat + 全量 diff(-U10) 写入单文件
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const [base, head, out] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: node review-package.mjs BASE HEAD [OUTFILE]');
  process.exit(2);
}
const g = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const outfile = out || `.superpowers/sdd/review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`;
const content = [
  `# Review package: ${base}..${head}`,
  '',
  '## Commits',
  g(`log --oneline "${base}..${head}"`).trimEnd(),
  '',
  '## Files changed',
  g(`diff --stat "${base}..${head}"`).trimEnd(),
  '',
  '## Diff',
  g(`diff -U10 "${base}..${head}"`).trimEnd(),
  '',
].join('\n');
fs.writeFileSync(outfile, content, 'utf8');
const commits = g(`rev-list --count "${base}..${head}"`).trim();
console.log(`wrote ${outfile}: ${commits} commit(s), ${Buffer.byteLength(content)} bytes`);
