# Task 3: manifest.json CSP + content.js 防广播回声过滤

**Files:**
- Modify: `manifest.json`（新增 content_security_policy）
- Modify: `content.js`（转发过滤 `OFFSCREEN_*`）

**Interfaces:**
- Consumes: 无
- Produces: offscreen 内可 `new Worker(blobURL)`（CSP 放宽）；content.js 不再把 `OFFSCREEN_*` 消息转发到 background（防止 chrome.runtime.sendMessage 广播回声）

- [ ] **Step 1: 修改 `manifest.json`**

在 `"host_permissions"` 之后、`"background"` 之前插入：

```json
  "content_security_policy": {
    "extension_pages": "script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'self'"
  },
```

- [ ] **Step 2: 修改 `content.js`**

将文件末尾"转发其他消息到 background"逻辑（第 190-195 行）替换为：

```js
    // Forward other messages to background（跳过 OFFSCREEN_*，防 chrome.runtime.sendMessage 广播回声）
    try {
      if (type.startsWith('OFFSCREEN_')) return;
      chrome.runtime.sendMessage({ type, data }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch(e) {}
```

- [ ] **Step 3: 语法检查**

Run: `node --check content.js`
Expected: 无输出，exit code 0（content.js 为普通脚本）

- [ ] **Step 4: 验证 manifest 仍为合法 JSON**

Run: `Get-Content manifest.json -Raw | ConvertFrom-Json | Out-Null; echo "JSON OK"`
Expected: 输出 `JSON OK`

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js
git commit -m "fix(manifest): 放宽 blob: worker CSP 供 offscreen 使用，content.js 过滤 OFFSCREEN_* 防回声"
```
