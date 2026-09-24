const DB_NAME = 'ds-archive';
const DB_VERSION = 2;

let ready;

function connect() {
  if (!ready) {
    ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: ['sessionId', 'messageId'] });
          store.createIndex('bySession', 'sessionId');
        }
        // 原始帧：只追加，永不改写。start/meta/end 三类事件各占一条，避免读-改-写
        if (!db.objectStoreNames.contains('rawEvents')) {
          const store = db.createObjectStore('rawEvents', { keyPath: ['streamId', 'kind'] });
          store.createIndex('byStream', 'streamId');
          store.createIndex('bySession', 'sessionId');
        }
        if (!db.objectStoreNames.contains('rawChunks')) {
          const store = db.createObjectStore('rawChunks', { keyPath: 'seq', autoIncrement: true });
          store.createIndex('byStream', 'streamId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return ready;
}

function whenDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqToPromise = req =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function saveSnapshot(session, messages) {
  const db = await connect();
  const t = db.transaction(['sessions', 'messages'], 'readwrite');
  t.objectStore('sessions').put(session);
  const store = t.objectStore('messages');
  for (const m of messages) store.put(m);
  return whenDone(t);
}

export async function getMessages(sessionId) {
  const db = await connect();
  return reqToPromise(db.transaction('messages').objectStore('messages').index('bySession').getAll(IDBKeyRange.only(sessionId)));
}

export async function getSession(sessionId) {
  const db = await connect();
  return reqToPromise(db.transaction('sessions').objectStore('sessions').get(sessionId));
}

export async function listSessions() {
  const db = await connect();
  const sessions = await reqToPromise(db.transaction('sessions').objectStore('sessions').getAll());
  return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// 删除某会话的全部原始帧。sessionId 可为 null——那批「未关联会话」的孤儿流也能删
export async function deleteRawForSession(sessionId) {
  const db = await connect();
  const streams = await listRawStreams(sessionId);
  const t = db.transaction(['rawEvents', 'rawChunks'], 'readwrite');
  const ev = t.objectStore('rawEvents');
  const ch = t.objectStore('rawChunks');
  for (const s of streams) {
    for (const k of await reqToPromise(ev.index('byStream').getAllKeys(IDBKeyRange.only(s.streamId)))) ev.delete(k);
    for (const k of await reqToPromise(ch.index('byStream').getAllKeys(IDBKeyRange.only(s.streamId)))) ch.delete(k);
  }
  return whenDone(t);
}

export async function deleteSession(sessionId) {
  const db = await connect();
  const t = db.transaction(['sessions', 'messages'], 'readwrite');
  t.objectStore('sessions').delete(sessionId);
  const store = t.objectStore('messages');
  const keys = await reqToPromise(store.index('bySession').getAllKeys(IDBKeyRange.only(sessionId)));
  for (const k of keys) store.delete(k);
  await whenDone(t);
  await deleteRawForSession(sessionId);
}

// 全量备份/恢复：换浏览器、重装扩展时救数据用。
// rawChunks 主键 seq 是自增的，导入时剥掉 seq 让库重新发号，
// 免得覆盖库里已有行；getAll 的顺序就是写入顺序，逐条重放不受影响。
export async function exportAll() {
  const db = await connect();
  const t = db.transaction(['sessions', 'messages', 'rawEvents', 'rawChunks'], 'readonly');
  const [sessions, messages, rawEvents, rawChunks] = await Promise.all(
    ['sessions', 'messages', 'rawEvents', 'rawChunks'].map(n => reqToPromise(t.objectStore(n).getAll())));
  await whenDone(t);
  return { app: 'ds-archive', dbVersion: DB_VERSION, exportedAt: Date.now(), sessions, messages, rawEvents, rawChunks };
}

export async function importAll(data) {
  const db = await connect();
  const t = db.transaction(['sessions', 'messages', 'rawEvents', 'rawChunks'], 'readwrite');
  for (const s of data.sessions || []) t.objectStore('sessions').put(s);
  for (const m of data.messages || []) t.objectStore('messages').put(m);
  for (const e of data.rawEvents || []) t.objectStore('rawEvents').put(e);
  for (const c of data.rawChunks || []) {
    const { seq, ...rest } = c;
    t.objectStore('rawChunks').put(rest);
  }
  return whenDone(t);
}

export async function appendRaw(events) {
  const db = await connect();
  const t = db.transaction(['rawEvents', 'rawChunks'], 'readwrite');
  const ev = t.objectStore('rawEvents');
  const ch = t.objectStore('rawChunks');
  for (const e of events) {
    if (e.type === 'start') {
      ev.put({ streamId: e.streamId, kind: 'start', sessionId: e.sessionId || null, pageUrl: e.pageUrl || null,
        url: e.url, requestBody: e.requestBody, startedAt: e.startedAt });
    } else if (e.type === 'meta') {
      ev.put({ streamId: e.streamId, kind: 'meta', sessionId: e.sessionId || null,
        status: e.status, contentType: e.contentType });
    } else if (e.type === 'chunk') {
      if (e.text) ch.put({ streamId: e.streamId, text: e.text, at: e.at });
      if (e.done) ev.put({ streamId: e.streamId, kind: 'end', sessionId: e.sessionId || null,
        doneAt: e.at, error: e.error || null });
    }
  }
  return whenDone(t);
}

export async function listRawStreams(sessionId) {
  const db = await connect();
  // 用 getAll 而不是 bySession 索引：sessionId 为 null 的记录根本进不了索引，索引查询会静默漏掉它们
  const events = await reqToPromise(db.transaction('rawEvents').objectStore('rawEvents').getAll());
  const filtered = events.filter(e => (e.sessionId || null) === (sessionId || null));
  const byId = new Map();
  for (const e of filtered) {
    const rec = byId.get(e.streamId) || { streamId: e.streamId };
    rec[e.kind === 'start' ? 'start' : e.kind] = e;
    if (e.kind === 'start') { rec.startedAt = e.startedAt; }
    byId.set(e.streamId, rec);
  }
  return [...byId.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// 侧栏用：找出只有原始帧、没有正式存档的会话（含 sessionId 为 null 的孤儿流），
// 否则快照失败时原始数据录了却在界面上没有任何入口
export async function listRawSessions() {
  const db = await connect();
  const events = await reqToPromise(db.transaction('rawEvents').objectStore('rawEvents').getAll());
  const byId = new Map();
  for (const e of events) {
    const key = e.sessionId || null;
    const rec = byId.get(key) || { sessionId: key, streams: 0, lastAt: 0, streamErrors: 0 };
    if (e.kind === 'start') { rec.streams++; rec.lastAt = Math.max(rec.lastAt, e.startedAt || 0); }
    if (e.kind === 'end' && e.error) rec.streamErrors++;
    byId.set(key, rec);
  }
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export async function countSessions() {
  const db = await connect();
  const t = db.transaction(['sessions', 'messages', 'rawEvents', 'rawChunks']);
  const [sessions, messages, streams, chunks] = await Promise.all([
    reqToPromise(t.objectStore('sessions').count()),
    reqToPromise(t.objectStore('messages').count()),
    reqToPromise(t.objectStore('rawEvents').count()),
    reqToPromise(t.objectStore('rawChunks').count()),
  ]);
  return { sessions, messages, rawEventRows: streams, rawChunkRows: chunks };
}

export async function readRawText(streamId) {
  const db = await connect();
  const chunks = await reqToPromise(
    db.transaction('rawChunks').objectStore('rawChunks').index('byStream').getAll(IDBKeyRange.only(streamId)));
  return chunks.map(c => c.text).join('');
}
