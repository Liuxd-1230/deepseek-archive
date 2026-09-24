// 包 IIFE：content script 之间共享全局作用域，顶层 sessionId 曾和 recorder-bridge.js 撞名导致本文件整体解析失败
(() => {
  if (window.__dsrContentInstalled) return;
  window.__dsrContentInstalled = true;

  const SESSION_PATH = /\/a\/chat\/s\/([0-9a-f-]{36})/;

function sessionId() {
  const m = location.pathname.match(SESSION_PATH);
  return m ? m[1] : null;
}

function bearer() {
  const raw = localStorage.getItem('userToken');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' ? v : v.value || v.token || null;
  } catch {
    return /^eyJ/.test(raw) ? raw : null;
  }
}

async function pullSession(id) {
  const token = bearer();
  if (!token) throw new Error('未找到 userToken，可能未登录');
  const res = await fetch(`/api/v0/chat/history_messages?chat_session_id=${id}`, {
    headers: token.startsWith('Bearer ') ? { Authorization: token } : { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  const body = await res.json();
  const data = body && body.data;
  if (!data || data.biz_code !== 0) throw new Error(`接口返回异常 code=${body && body.code} msg=${body && body.msg}`);
  return data.biz_data;
}

const send = (msg, attempt = 0) =>
  chrome.runtime.sendMessage(msg).catch(async err => {
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 300));
      return send(msg, 1);
    }
    throw err;
  });

async function snapshot(reason) {
  const id = sessionId();
  if (!id) return;
  try {
    const biz = await pullSession(id);
    await send({ type: 'SNAPSHOT', sessionId: id, reason, session: biz.chat_session, chatMessages: biz.chat_messages });
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'ARCHIVE_ERROR', sessionId: id, message: String(err && err.message || err) }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return false;
  document.documentElement.dataset.dsrContent = 'ok';

  if (msg.type === 'SNAPSHOT_REQUEST') {
    snapshot(msg.reason);
    return false;
  }

  if (msg.type === 'DIAG_PING') {
    const d = document.documentElement.dataset;
    respond({
      ok: true,
      pageUrl: location.href,
      sessionId: sessionId(),
      mainHook: d.dsrMain === 'ok',
      bridge: d.dsrBridge === 'ok',
      nonce: !!d.dsrNonce,
      xhrTotal: Number(d.dsrXhr || 0),
      fetchStream: Number(d.dsrFetch || 0),
      streamHits: Number(d.dsrHits || 0),
      bridgeRecv: Number(d.dsrRecv || 0),
      batchesSent: Number(d.dsrSent || 0),
      sendFails: Number(d.dsrFail || 0),
      lastSendError: d.dsrLastErr || null,
    });
    return true;
  }

  return false;
});
})();
