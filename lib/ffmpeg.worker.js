/**
 * FFmpeg WASM Bridge Worker
 *
 * 接收主线程消息，调用 ffmpeg-core WASM 执行音视频操作。
 * 与主线程的 FFmpegBridge 类配对使用。
 */

var Cmd;
(function (e) {
  e.LOAD = 'LOAD';
  e.EXEC = 'EXEC';
  e.WRITE_FILE = 'WRITE_FILE';
  e.READ_FILE = 'READ_FILE';
  e.DELETE_FILE = 'DELETE_FILE';
  e.RENAME = 'RENAME';
  e.CREATE_DIR = 'CREATE_DIR';
  e.LIST_DIR = 'LIST_DIR';
  e.DELETE_DIR = 'DELETE_DIR';
  e.ERROR = 'ERROR';
  e.DOWNLOAD = 'DOWNLOAD';
  e.PROGRESS = 'PROGRESS';
  e.LOG = 'LOG';
})(Cmd || (Cmd = {}));

var mod = null;

function emit(type, id, data, transfer) {
  var msg = { id: id, type: type, data: data };
  if (transfer && transfer.length) {
    self.postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

function emitError(id, err) {
  emit(Cmd.ERROR, id, String(err));
}

// ─── 初始化 FFmpeg Core ───
async function initCore(opts) {
  var wasAlreadyReady = !!mod;
  var baseURL = opts.coreURL;
  var wasmPath = opts.wasmURL || baseURL.replace(/\.js$/, '.wasm');
  var workerPath = opts.workerURL || baseURL.replace(/\.js$/, '.worker.js');

  // 加载 ffmpeg-core.js（优先 importScripts，失败则动态 import）
  try {
    importScripts(baseURL);
  } catch (_) {
    var factory = (await import(baseURL)).default;
    if (!factory) throw new Error('ffmpeg-core 加载失败');
    self.createFFmpegCore = factory;
  }

  // 通过 hash 传递 wasm/worker 的 Blob URL，让 Emscripten locateFile 能找到
  var locatePayload = btoa(JSON.stringify({ wasmURL: wasmPath, workerURL: workerPath }));
  mod = await self.createFFmpegCore({
    mainScriptUrlOrBlob: baseURL + '#' + locatePayload
  });

  mod.setLogger(function (entry) {
    self.postMessage({ type: Cmd.LOG, data: entry });
  });
  mod.setProgress(function (entry) {
    self.postMessage({ type: Cmd.PROGRESS, data: entry });
  });

  return wasAlreadyReady;
}

// ─── 执行 FFmpeg 命令 ───
function runCommand(opts) {
  var args = opts.args;
  var timeout = opts.timeout != null ? opts.timeout : -1;
  mod.setTimeout(timeout);
  mod.exec.apply(mod, args);
  var ret = mod.ret;
  mod.reset();
  return ret;
}

// ─── 虚拟文件系统操作 ───
function writeMemFile(opts) {
  mod.FS.writeFile(opts.path, opts.data);
  return true;
}

function readMemFile(opts) {
  return mod.FS.readFile(opts.path, { encoding: opts.encoding });
}

function removeMemFile(opts) {
  mod.FS.unlink(opts.path);
  return true;
}

function renameMemFile(opts) {
  mod.FS.rename(opts.oldPath, opts.newPath);
  return true;
}

function makeMemDir(opts) {
  mod.FS.mkdir(opts.path);
  return true;
}

function scanMemDir(opts) {
  var entries = mod.FS.readdir(opts.path);
  var result = [];
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    var stat = mod.FS.stat(opts.path + '/' + name);
    result.push({ name: name, isDir: mod.FS.isDir(stat.mode) });
  }
  return result;
}

function removeMemDir(opts) {
  mod.FS.rmdir(opts.path);
  return true;
}

// ─── 消息分发 ───
self.onmessage = async function (event) {
  var id = event.data.id;
  var type = event.data.type;
  var payload = event.data.data;

  try {
    if (type !== Cmd.LOAD && !mod) {
      throw new Error('FFmpeg 尚未初始化，请先调用 load');
    }

    var result;
    switch (type) {
      case Cmd.LOAD:       result = await initCore(payload); break;
      case Cmd.EXEC:       result = runCommand(payload); break;
      case Cmd.WRITE_FILE: result = writeMemFile(payload); break;
      case Cmd.READ_FILE:  result = readMemFile(payload); break;
      case Cmd.DELETE_FILE: result = removeMemFile(payload); break;
      case Cmd.RENAME:     result = renameMemFile(payload); break;
      case Cmd.CREATE_DIR: result = makeMemDir(payload); break;
      case Cmd.LIST_DIR:   result = scanMemDir(payload); break;
      case Cmd.DELETE_DIR: result = removeMemDir(payload); break;
      default:
        throw new Error('未知消息类型: ' + type);
    }

    var transfer = [];
    if (result instanceof Uint8Array) {
      transfer.push(result.buffer);
    }
    emit(type, id, result, transfer);

  } catch (err) {
    emitError(id, err);
  }
};
