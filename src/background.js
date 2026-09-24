import { saveSnapshot, appendRaw, countSessions } from './db.js';
import { normalizeMessages, normalizeSession } from './normalize.js';

const STREAM_URL = /\/api\/v0\/chat\/(completion|regenerate|continue|edit_message|resume_stream)(\?|$)/;
const FILTER = { urls: ['https://chat.deepseek.com/*'] };
const SETTLE_MS = 900;

const inflight = new Map();
const settling = new Map();
const SESSION_KEY = 'inflight';
let hydrated = false;

// 全程加保护：这一行若在顶层同步抛错，下面所有监听都不会注册，表现就是"什么都没录到"
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const stored = await chrome.storage.session.get(SESSION_KEY);
  for (const [tab, ids] of Object.entries(stored[SESSION_KEY] || {})) {
    const set = new Set(ids);
    if (set.size) inflight.set(Number(tab), set);
  }
}

function persist() {
  const snapshot = {};
  for (const [tab, set] of inflight) snapshot[tab] = [...set];
  chrome.storage.session.set({ [SESSION_KEY]: snapshot }).catch(() => {});
}

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text && color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

const DIAG_KEY = 'dsrDiag';
const blankDiag = () => ({ swStartedAt: Date.now(), lastEventAt: null, streamRequests: 0, rawBatches: 0,
  rawEvents: 0, rawChars: 0, streamsSeen: 0, streamsEnded: 0, snapshotsSaved: 0, errors: [] });

async function note(mutate) {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const d = Object.assign(blankDiag(), stored[DIAG_KEY] || {});
    mutate(d);
    d.lastEventAt = Date.now();
    d.errors = d.errors.slice(-6);
    await chrome.storage.local.set({ [DIAG_KEY]: d });
  } catch { /* 自检本身不该拖垮主流程 */ }
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function requestSnapshot(tabId, reason) {
  chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT_REQUEST', reason })
    .catch(() => badge(tabId, '!', '#d33'));
}

function begin(tabId, requestId) {
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
  if (!inflight.has(tabId)) inflight.set(tabId, new Set());
  inflight.get(tabId).add(requestId);
  note(d => { d.streamRequests++; });
  badge(tabId, '●', '#f08c00');
  persist();
}

function end(tabId, requestId) {
  const set = inflight.get(tabId);
  if (!set) return;
  set.delete(requestId);
  if (set.size) { persist(); return; }
  inflight.delete(tabId);
  persist();
  badge(tabId, '···', '#4c9aff');
  settling.set(tabId, setTimeout(() => {
    settling.delete(tabId);
    badge(tabId, '');
    requestSnapshot(tabId, 'stream_end');
  }, SETTLE_MS));
}

chrome.webRequest.onBeforeRequest.addListener(async d => {
  if (d.tabId < 0 || !STREAM_URL.test(d.url)) return;
  await hydrate();
  begin(d.tabId, d.requestId);
}, FILTER);

for (const event of ['onCompleted', 'onErrorOccurred']) {
  chrome.webRequest[event].addListener(async d => {
    await hydrate();
    if (inflight.has(d.tabId)) end(d.tabId, d.requestId);
  }, FILTER);
}

chrome.tabs.onRemoved.addListener(tabId => {
  inflight.delete(tabId);
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
  persist();
});

async function handleSnapshot(msg) {
  const messages = normalizeMessages(msg.sessionId, msg.chatMessages || [])
    .map(m => ({ ...m, archivedAt: Date.now() }));
  const session = { ...normalizeSession(msg.sessionId, msg.session), messageCount: messages.length };
  await saveSnapshot(session, messages);
  note(d => { d.snapshotsSaved++; d.lastSessionId = msg.sessionId; });
  broadcast({ type: 'ARCHIVED', sessionId: msg.sessionId, count: messages.length });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'SNAPSHOT') {
    respond({ ok: true });
    handleSnapshot(msg).catch(err => {
      const message = String(err.message || err);
      note(d => d.errors.push(`取历史失败: ${message}`));
      broadcast({ type: 'ARCHIVE_ERROR', sessionId: msg.sessionId, message });
    });
    return true;
  }

  if (msg.type === 'SNAPSHOT_NOW') {
    chrome.tabs.query({ url: 'https://chat.deepseek.com/*', lastFocusedWindow: true }).then(tabs => {
      if (!tabs.length) { respond({ ok: false, error: '没找到 DeepSeek 标签页' }); return; }
      requestSnapshot(tabs[0].id, 'manual');
      respond({ ok: true });
    }).catch(err => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'RAW_BATCH') {
    const events = msg.batch || [];
    note(d => {
      d.rawBatches++;
      d.rawEvents += events.length;
      for (const e of events) {
        if (e.type === 'start') d.streamsSeen++;
        if (e.type === 'chunk') {
          d.rawChars += (e.text || '').length;
          if (e.done) { d.streamsEnded++; if (e.error) d.errors.push(`流中断: ${e.error}`); }
        }
      }
    });
    appendRaw(events)
      .then(() => respond({ ok: true }))
      .catch(err => {
        note(d => d.errors.push(`写库失败: ${String(err.message || err)}`));
        respond({ ok: false, error: String(err.message || err) });
      });
    for (const e of events) {
      if (e.type === 'chunk' && e.done) broadcast({ type: 'RAW_DONE', streamId: e.streamId, sessionId: e.sessionId });
    }
    return true;
  }

  if (msg.type === 'DIAG_ASK') {
    (async () => {
      const stored = await chrome.storage.local.get(DIAG_KEY);
      const found = [];
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
      } catch (err) {
        found.push({ error: `列标签页就失败了：${String(err.message || err)}` });
      }
      for (const t of tabs) {
        try {
          found.push({ tabId: t.id, title: (t.title || '').slice(0, 24), ok: true, ...(await chrome.tabs.sendMessage(t.id, { type: 'DIAG_PING' })) });
        } catch (err) {
          found.push({ tabId: t.id, title: (t.title || '').slice(0, 24), ok: false, error: String(err.message || err) });
        }
      }
      let dbStats;
      try { dbStats = await countSessions(); } catch (err) { dbStats = { error: String(err.message || err) }; }
      respond({
        sw: Object.assign(blankDiag(), stored[DIAG_KEY] || {}),
        tabs: found,
        manifestVersion: chrome.runtime.getManifest().version,
        dbStats,
      });
    })();
    return true;
  }

  if (msg.type === 'ARCHIVE_ERROR') {
    respond({ ok: true });
    broadcast(msg);
    return true;
  }

  return false;
});
