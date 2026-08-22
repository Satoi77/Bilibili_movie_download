// 流下载备用链接兜底测试:复现 "TypeError: Failed to fetch" 单点故障
// 运行:node test/stream-backup.test.mjs
import { downloadStream } from '../lib/download-core.js';

const enc = new TextEncoder();
let passed = 0;
let failed = 0;

function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}

function makeResponse(chunks, { status = 200, headers = {} } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader() {
        return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
      }
    }
  };
}

const notifyCalls = [];
const notify = (p) => notifyCalls.push(p);

console.log('用例 1: 主链接 fetch 网络级失败(TypeError: Failed to fetch),备用链接成功');
{
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url !== 'https://backup-1/cdn') throw new TypeError('Failed to fetch');
    return makeResponse([enc.encode('backup-data')], { headers: { 'content-length': '11' } });
  };
  try {
    const blob = await downloadStream(
      ['https://primary/cdn', 'https://backup-1/cdn'], 'video', undefined, notify, fetchFn
    );
    assert(blob.size === 11, '备用链接下载成功且数据完整', `size=${blob.size}`);
    assert(calls.length === 2 && calls[1] === 'https://backup-1/cdn', '确实尝试了第二个 URL', JSON.stringify(calls));
    assert(notifyCalls.some(p => p.percent === 100), '进度上报到 100%');
  } catch (e) {
    assert(false, '不应抛错', e.message);
  }
}

console.log('用例 2: 主链接响应中途断流(reader.read 抛 Failed to fetch),切换备用链接重新完整下载');
{
  const fetchFn = async (url) => {
    if (url !== 'https://backup-1/cdn') {
      // 主链接:响应头正常返回,但读取中途断流(连接重置)
      return {
        ok: true, status: 200,
        headers: { get: () => '100' },
        body: {
          getReader() {
            let n = 0;
            return { read: async () => (n++ === 0 ? { done: false, value: enc.encode('half') } : Promise.reject(new TypeError('Failed to fetch'))) };
          }
        }
      };
    }
    return makeResponse([enc.encode('whole-backup')], { headers: { 'content-length': '12' } });
  };
  try {
    const blob = await downloadStream(
      ['https://primary/cdn', 'https://backup-1/cdn'], 'audio', undefined, notify, fetchFn
    );
    assert(new Blob([blob]).size === 12 && blob.size === 12, '断流后从备用链接完整重下', `size=${blob.size}`);
  } catch (e) {
    assert(false, '不应抛错', e.message);
  }
}

console.log('用例 3: 全部 URL 均网络失败 → 抛出错误');
{
  const fetchFn = async () => { throw new TypeError('Failed to fetch'); };
  let threw = null;
  try {
    await downloadStream(['https://a/1', 'https://b/2'], 'video', undefined, notify, fetchFn);
  } catch (e) { threw = e; }
  assert(threw instanceof Error && /Failed to fetch/.test(threw.message), '抛出最后一次的网络错误', threw && threw.message);
}

console.log('用例 4: 所有 URL 均 403 → err.code = NEEDS_PAGE(保持既有防盗链语义)');
{
  const fetchFn = async () => makeResponse([], { status: 403 });
  let threw = null;
  try {
    await downloadStream(['https://a/1', 'https://b/2'], 'video', undefined, notify, fetchFn);
  } catch (e) { threw = e; }
  assert(threw && threw.code === 'NEEDS_PAGE', '403 兜底语义保留', threw && `${threw.message} code=${threw.code}`);
}

console.log('用例 5: 外部 AbortError 立即终止,不再尝试下一个 URL');
{
  const ctrl = new AbortController();
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push(url);
    throw new TypeError('Failed to fetch');
  };
  ctrl.abort();
  let threw = null;
  try {
    await downloadStream(['https://a/1', 'https://b/2'], 'video', ctrl.signal, notify, fetchFn);
  } catch (e) { threw = e; }
  assert(threw && threw.name === 'AbortError', '中止以 AbortError 抛出', threw && threw.name);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
