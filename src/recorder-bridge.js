// 注意：同一扩展的多个 content script 共享同一个隔离世界的全局作用域，
// 必须包 IIFE，否则顶层标识符会和其他脚本撞名（本项目实测 content.js 因此整体解析失败）
(() => {
  if (window.__dsrBridgeInstalled) return;
  window.__dsrBridgeInstalled = true;

  const NONCE = crypto.randomUUID();
const root = document.documentElement;
root.dataset.dsrNonce = NONCE;
root.dataset.dsrBridge = 'ok';

const SESSION_RE = /\/a\/chat\/s\/([0-9a-f-]{36})/;
const sessionId = () => (location.pathname.match(SESSION_RE) || [])[1] || null;
const bump = key => { root.dataset[key] = String(Number(root.dataset[key] || 0) + 1); };

let queue = [];
let timer = null;

function deliver(attempt) {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  chrome.runtime
    .sendMessage({ type: 'RAW_BATCH', sessionId: sessionId(), batch })
    .then(() => bump('dsrSent'))
    .catch(err => {
      root.dataset.dsrLastErr = String((err && err.message) || err).slice(0, 120);
      bump('dsrFail');
      queue = batch.concat(queue);
      if (attempt < 6) setTimeout(() => deliver(attempt + 1), 200 * (attempt + 1));
    });
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; deliver(0); }, 250);
}

window.addEventListener('message', event => {
  const d = event.data;
  if (!d || event.source !== window) return;
  if (d.source !== 'dsr-main' || d.nonce !== NONCE) return;

  bump('dsrRecv');
  queue.push({ ...d, sessionId: sessionId(), pageUrl: location.href });
  if (queue.length > 40 || (d.type === 'chunk' && d.done)) deliver(0);
  else schedule();
});
})();
