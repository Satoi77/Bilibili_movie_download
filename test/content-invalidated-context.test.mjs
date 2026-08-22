// 回归测试：扩展重载/更新后，残留的旧 content script（孤儿）收到页面消息时
// 不得抛出 "Uncaught Error: Extension context invalidated."，
// 且须按既有响应契约回执失败（save_blob_result / settings_result / delete_blob_result），
// 页面世界据此立即降级（<a download> 等），不必挂到超时。
//
// Chrome 孤儿脚本的两种失效表现均需覆盖：
// A. chrome.runtime.id 仍可读，但调用 runtime API 同步抛错（含守卫后的 TOCTOU 窗口）
// B. 访问 chrome.runtime.id 本身即抛错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const CONTENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'content.js');

// 构造最小浏览器沙箱：content.js 顶层会注入 <script>、预取 ffmpeg、注册监听器
function loadContentScript({ sendMessageThrows = false, idThrows = false } = {}) {
  const listeners = new Map();
  const posted = [];
  const removed = [];
  const sandboxWindow = {};

  let runtime;
  if (idThrows) {
    runtime = {
      get id() { throw new Error('Extension context invalidated.'); },
      getURL: (p) => 'chrome-extension://fake/' + p,
      onMessage: { addListener() {} },
      sendMessage() { throw new Error('Extension context invalidated.'); }
    };
  } else {
    runtime = {
      getURL: (p) => 'chrome-extension://fake/' + p,
      id: 'fakeid',
      onMessage: { addListener() {} },
      sendMessage: (...args) => {
        if (sendMessageThrows) throw new Error('Extension context invalidated.');
        const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (cb) cb(undefined);
        return Promise.resolve(undefined);
      }
    };
  }

  const sandbox = {
    console: { log() {}, warn() {}, debug() {} },
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    fetch: () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
    indexedDB: { open: () => ({}) },
    document: {
      getElementById: () => null,
      createElement: () => ({ type: '', src: '' }),
      head: { appendChild() {} },
      documentElement: null
    },
    Blob: class {},
    chrome: { runtime }
  };
  sandboxWindow.postMessage = (msg) => posted.push(msg);
  sandboxWindow.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandboxWindow.removeEventListener = (type, fn) => {
    removed.push({ type, fn });
    const arr = listeners.get(type) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  sandbox.window = sandboxWindow;
  // content.js 里 event.source !== window 的同一性判断依赖此引用
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(CONTENT_JS, 'utf8'), sandbox, { filename: 'content.js' });
  return { sandboxWindow, listeners, posted, removed };
}

function makeEvent(windowRef, data) {
  return { source: windowRef, data };
}

function getMessageHandlers(listeners) {
  return listeners.get('message') || [];
}
const SAVE_MSG = (requestId) => ({
  source: 'bilibili-downloader',
  type: 'SAVE_BLOB',
  data: { requestId, blob: {}, filename: 'a.mp4' }
});

test('表现A（id 可读但 API 抛错）：SAVE_BLOB 不抛异常且回执 save_blob_result 失败', () => {
  const { sandboxWindow, listeners, posted } = loadContentScript({ sendMessageThrows: true });
  const handlers = getMessageHandlers(listeners);
  assert.equal(handlers.length, 1);

  assert.doesNotThrow(() => handlers[0](makeEvent(sandboxWindow, SAVE_MSG('r1'))));

  const reply = posted.find(m => m.type === 'save_blob_result');
  assert.ok(reply, '应回执 save_blob_result');
  assert.equal(reply.data.requestId, 'r1');
  assert.equal(reply.data.success, false);
});

test('表现A：GET_SETTINGS 回执空设置、DELETE_BLOB_FILE 回执失败', () => {
  const { sandboxWindow, listeners, posted } = loadContentScript({ sendMessageThrows: true });
  const handlers = getMessageHandlers(listeners);

  handlers[0](makeEvent(sandboxWindow, { source: 'bilibili-downloader', type: 'GET_SETTINGS' }));
  const settingsReply = posted.find(m => m.type === 'settings_result');
  assert.equal(Object.keys(Object.assign({}, settingsReply.data)).length, 0, '应回执空设置');

  handlers[0](makeEvent(sandboxWindow, {
    source: 'bilibili-downloader',
    type: 'DELETE_BLOB_FILE',
    data: { requestId: 'd1', downloadId: 42 }
  }));
  const delReply = posted.find(m => m.type === 'delete_blob_result');
  assert.equal(delReply.data.requestId, 'd1');
  assert.equal(delReply.data.success, false);

  // 表现A下监听器保留：后续每条消息仍逐条回执失败（不静默丢弃待处理请求）
  const before = posted.length;
  handlers[0](makeEvent(sandboxWindow, SAVE_MSG('r2')));
  assert.ok(posted.length > before, '后续 SAVE_BLOB 仍应有失败回执');
});

test('表现B（访问 id 即抛错）：入口守卫回执失败并自清理监听器', () => {
  const { sandboxWindow, listeners, posted, removed } = loadContentScript({ idThrows: true });
  const handlers = getMessageHandlers(listeners);
  assert.equal(handlers.length, 1);

  assert.doesNotThrow(() => handlers[0](makeEvent(sandboxWindow, SAVE_MSG('r3'))));
  const reply = posted.find(m => m.type === 'save_blob_result');
  assert.ok(reply && reply.data.success === false);
  assert.equal(removed.length, 1, '守卫路径应移除监听器');
  assert.equal(getMessageHandlers(listeners).length, 0, '清理后不再消费消息');

  // 清理后再派发：无监听器，无任何新回执
  const countAfterFirst = posted.filter(m => m.type === 'save_blob_result').length;
  for (const fn of getMessageHandlers(listeners)) {
    fn(makeEvent(sandboxWindow, SAVE_MSG('r4')));
  }
  assert.equal(posted.filter(m => m.type === 'save_blob_result').length, countAfterFirst);
});

test('扩展上下文正常时行为不变：SAVE_FILE 正常回执', () => {
  const { sandboxWindow, listeners, posted, removed } = loadContentScript({ sendMessageThrows: false });
  const handlers = getMessageHandlers(listeners);

  assert.doesNotThrow(() => handlers[0](makeEvent(sandboxWindow, SAVE_MSG('ok1'))));
  const reply = posted.find(m => m.type === 'save_blob_result');
  assert.ok(reply, '正常路径应有回执');
  assert.equal(removed.length, 0, '正常路径不移除监听器');
});
