// 断点续传单测:node test/resume.test.mjs
import { resolveResumePlan, opfsOnce } from '../lib/download-core.js';

let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail ? '— ' + detail : ''); }
}
const U8 = (s) => new TextEncoder().encode(s);
const DEC = new TextDecoder();

console.log('resolveResumePlan 纯函数');
{
  const r1 = resolveResumePlan(206, 'bytes 5-7/8', 5);
  assert(r1.mode === 'resume' && r1.offset === 5 && r1.total === 8, '206 起点匹配→resume');
  const r2 = resolveResumePlan(206, 'bytes 3-7/8', 5);
  assert(r2.mode === 'restart', '206 起点不符→restart');
  const r3 = resolveResumePlan(206, '', 5);
  const r4 = resolveResumePlan(206, 'bytes */8', 5);
  assert(r3.mode === 'restart' && r4.mode === 'restart', 'content-range 缺失/畸形→restart');
  const r5 = resolveResumePlan(200, null, 5);
  assert(r5.mode === 'restart', '200→restart');
}

// ─── 内存 OPFS stub:游标语义与真实一致(createWritable 初始游标 0,未 seek 的写会覆盖头部)───
function makeMemOPFS() {
  const files = new Map();
  function handle(name) {
    return {
      async getFile() { return { size: files.get(name)?.length || 0 }; },
      async createWritable(opts = {}) {
        let buf = opts.keepExistingData ? (files.get(name) || U8('')).slice() : U8('');
        let pos = 0;
        let closed = false;
        return {
          async write(data) {
            if (closed) throw new Error('writable closed');
            if (data && typeof data === 'object' && data.type === 'seek') { pos = data.position; return; }
            if (data && typeof data === 'object' && data.type === 'write') { pos = data.position; data = data.data; }
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (pos + u8.length > buf.length) { const nb = new Uint8Array(pos + u8.length); nb.set(buf); buf = nb; }
            buf.set(u8, pos); pos += u8.length;
          },
          async close() { closed = true; files.set(name, buf); },
          async abort() { closed = true; }
        };
      }
    };
  }
  return {
    root: {
      async getFileHandle(name, o = {}) { if (!files.has(name)) files.set(name, U8('')); return handle(name); },
      async removeEntry(name) { if (!files.delete(name)) throw new Error('NotFound'); }
    },
    files
  };
}
function readerOf(parts) {
  let i = 0;
  return {
    read: async () => {
      if (i >= parts.length) return { done: true };
      const p = parts[i++];
      if (p instanceof Error) throw p;
      return { done: false, value: p };
    },
    cancel: async () => {}
  };
}
function resp({ status = 200, body = [], headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: { getReader: () => readerOf(body), cancel: async () => {} }
  };
}
const noopNotify = () => {};

console.log('opfsOnce 断点续传');
{
  // A: 206 续传——半成品 abcde + Range 增量 XYZ
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  const reqHeaders = [];
  const percents = [];
  const out = await opfsOnce('p', 'u', 'video', null, (n) => percents.push(n.percent),
    async (url, o = {}) => { reqHeaders.push(o.headers || {}); return resp({ status: 206, body: [U8('XY'), U8('Z')], headers: { 'content-range': 'bytes 5-7/8' } }); },
    () => root);
  assert(reqHeaders[0]?.Range === 'bytes=5-', '请求带 Range: bytes=5-', JSON.stringify(reqHeaders[0]));
  assert(DEC.decode(files.get('p')) === 'abcdeXYZ', '半成品+增量拼接正确', DEC.decode(files.get('p')));
  assert(out.size === 8, '返回总长 8', String(out.size));
  assert(percents[percents.length - 1] === 100, '进度终值 100(基于 TOTAL)', JSON.stringify(percents));
}
{
  // B: CDN 忽略 Range 返回 200 全量 → truncate 从头
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  const percents = [];
  const out = await opfsOnce('p', 'u', 'video', null, (n) => percents.push(n.percent),
    async () => resp({ status: 200, body: [U8('WXYZ')] }), () => root);
  assert(DEC.decode(files.get('p')) === 'WXYZ', '从头覆盖为全量', DEC.decode(files.get('p')));
  assert(out.size === 4, '返回新总长 4', String(out.size));
}
{
  // C: 206 但区间不符 → 弃响应重发无 Range 请求
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  const ranges = [];
  const fetchFn = async (url, o = {}) => {
    ranges.push(o.headers?.Range || null);
    return ranges.length === 1
      ? resp({ status: 206, body: [], headers: { 'content-range': 'bytes 9-9/10' } })
      : resp({ status: 200, body: [U8('full')] });
  };
  await opfsOnce('p', 'u', 'video', null, noopNotify, fetchFn, () => root);
  assert(ranges[0] === 'bytes=5-' && ranges[1] === null, '第二次请求不带 Range', JSON.stringify(ranges));
  assert(DEC.decode(files.get('p')) === 'full', '从头下载结果', DEC.decode(files.get('p')));
}
{
  // D: 416 → 弃档重发无 Range
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  const ranges = [];
  const fetchFn = async (url, o = {}) => {
    ranges.push(o.headers?.Range || null);
    return ranges.length === 1 ? resp({ status: 416, body: [] }) : resp({ status: 200, body: [U8('ok!')] });
  };
  const out = await opfsOnce('p', 'u', 'video', null, noopNotify, fetchFn, () => root);
  assert(ranges[0] === 'bytes=5-' && ranges[1] === null, '416 后重发无 Range', JSON.stringify(ranges));
  assert(out.size === 3 && DEC.decode(files.get('p')) === 'ok!', '从头下载成功');
}
{
  // E: 中途网络错误 → 半成品保留已落地字节
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  let threw = null;
  try {
    await opfsOnce('p', 'u', 'video', null, noopNotify,
      async () => resp({ status: 206, body: [U8('xy'), new Error('Failed to fetch')], headers: { 'content-range': 'bytes 5-9/10' } }),
      () => root);
  } catch (e) { threw = e.message; }
  assert(threw === 'Failed to fetch', '网络错误上抛', String(threw));
  assert(DEC.decode(files.get('p')) === 'abcdexy', '半成品保留(close 落地)', DEC.decode(files.get('p')));
}
{
  // F: AbortError → 透传且半成品保留
  const { root, files } = makeMemOPFS();
  files.set('p', U8('abcde'));
  const ctrl = new AbortController();
  let sawAbort = null;
  try {
    await opfsOnce('p', 'u', 'video', ctrl.signal, noopNotify,
      async () => resp({ status: 206, body: [new DOMException('aborted', 'AbortError')], headers: { 'content-range': 'bytes 5-9/10' } }),
      () => root);
  } catch (e) { sawAbort = e.name; }
  assert(sawAbort === 'AbortError', '中止立即透传', String(sawAbort));
  assert((files.get('p')?.length || 0) >= 5, '半成品未被删除');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
