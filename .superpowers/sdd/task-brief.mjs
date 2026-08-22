// 复刻 superpowers task-brief 脚本（bash/awk 在 Windows 不可用）：
// 围栏感知地提取计划中 Task N 的完整文本到独立简报文件
import fs from 'node:fs';

const [planFile, nStr, out] = process.argv.slice(2);
const n = parseInt(nStr, 10);
if (!fs.existsSync(planFile) || !Number.isInteger(n)) {
  console.error('usage: node task-brief.mjs PLAN_FILE TASK_NUMBER [OUTFILE]');
  process.exit(2);
}
const lines = fs.readFileSync(planFile, 'utf8').split(/\r?\n/);
const outLines = [];
let infence = false;
let intask = false;
for (const line of lines) {
  if (/^```/.test(line)) infence = !infence;
  if (!infence) {
    const m = line.match(/^#+[ \t]+Task[ \t]+(\d+)/);
    if (m) intask = parseInt(m[1], 10) === n;
  }
  if (intask) outLines.push(line);
}
const text = outLines.join('\n');
if (!text.trim()) {
  console.error(`task ${n} not found in ${planFile}`);
  process.exit(3);
}
const outfile = out || `.superpowers/sdd/task-${n}-brief.md`;
fs.writeFileSync(outfile, text, 'utf8');
console.log(`wrote ${outfile}: ${outLines.length} lines`);
