import { listSessions, getMessages, getSession, deleteSession, deleteRawForSession, listRawStreams, listRawSessions, readRawText, exportAll, importAll } from '../src/db.js';
import { buildMarkdown } from '../src/markdown.js';
import { replayStream } from '../src/rebuild.js';
import { KNOWN_FRAGMENT_TYPES } from '../src/normalize.js';

const $ = id => document.getElementById(id);
let current = null;
let hasSelection = false; // current 可能是 null（未关联会话的孤儿流），单靠 current 判空会误判

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = el('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function say(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
  clearTimeout(say.timer);
  if (text) say.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

async function refreshSessions() {
  const [sessions, rawSessions] = await Promise.all([listSessions(), listRawSessions()]);
  const ul = $('sessions');
  ul.textContent = '';
  const archived = new Set(sessions.map(s => s.sessionId));
  // 只有原始帧、没有正式存档的（快照失败/被过滤的会话会落在这里，不能让用户看不到）
  const rawOnly = rawSessions.filter(r => !r.sessionId || !archived.has(r.sessionId));

  if (!sessions.length && !rawOnly.length) {
    ul.appendChild(el('li', 'empty', '还没有存档。在 DeepSeek 里问一句话，回答流完后会自动存档。'));
    return;
  }
  // 正式存档和纯原始帧按时间混排：刚被过滤的会话往往只有原始帧，沉底就找不到了
  const items = [
    ...sessions.map(s => ({ formal: true, at: (s.updatedAt || 0) * 1000, s })),
    ...rawOnly.map(r => ({ formal: false, at: r.lastAt || 0, r })),
  ].sort((a, b) => b.at - a.at);
  for (const it of items) {
    if (it.formal) {
      const { s } = it;
      const li = el('li', s.sessionId === current ? 'active' : '');
      li.appendChild(el('div', 'title', s.title));
      li.appendChild(el('div', 'meta', `${s.messageCount} 条 · ${new Date((s.updatedAt || 0) * 1000).toLocaleString()}`));
      li.onclick = () => select(s.sessionId);
      ul.appendChild(li);
    } else {
      const { r } = it;
      const li = el('li', (hasSelection && (r.sessionId || null) === current) ? 'active rawonly' : 'rawonly');
      li.appendChild(el('div', 'title', r.sessionId ? `（仅原始帧）${r.sessionId.slice(0, 8)}…` : '（仅原始帧）未关联会话'));
      li.appendChild(el('div', 'meta', `${r.streams} 条流 · ${r.lastAt ? new Date(r.lastAt).toLocaleString() : '时间未知'}${r.streamErrors ? ` · ${r.streamErrors} 条出错` : ''}`));
      li.onclick = () => select(r.sessionId || null);
      ul.appendChild(li);
    }
  }
}

async function select(sessionId) {
  current = sessionId;
  hasSelection = true;
  await refreshSessions();
  const [session, messages] = await Promise.all([
    sessionId ? getSession(sessionId) : null,
    sessionId ? getMessages(sessionId) : [],
  ]);
  $('detailHead').textContent = session ? session.title
    : sessionId ? `（仅原始帧，无正式存档）${sessionId.slice(0, 8)}…` : '（仅原始帧）未关联会话';
  $('detailActions').hidden = false;

  const box = $('detail');
  box.textContent = '';
  for (const m of messages) {
    const card = el('article', `msg ${m.role === 'USER' ? 'user' : 'assistant'}`);
    card.appendChild(el('h3', null, `${m.role === 'USER' ? '提问' : '回答'} #${m.messageId}${m.parentId ? ` ← #${m.parentId}` : ''}`));

    const chips = el('div', 'chips');
    for (const f of m.fragments) {
      if (f.type === 'TIP') continue; // 固定提示语，不值得占一个 chip
      chips.appendChild(el('span', `chip t-${f.type}`, `${f.type} ${f.content.length}`));
    }
    if (m.tokenUsage != null) chips.appendChild(el('span', 'chip meta-chip', `${m.tokenUsage} tok`));
    if (m.searchTriggered) chips.appendChild(el('span', 'chip meta-chip', '联网'));
    card.appendChild(chips);

    for (const f of m.fragments) {
      // TIP 是"内容由 AI 生成"那种固定提示语，压成一行灰字；其余正文照常
      card.appendChild(f.type === 'TIP' ? el('div', 'tip', f.content) : el('pre', 'body', f.content));
    }

    const flags = [];
    if (m.status && m.status !== 'FINISHED') flags.push(`状态 ${m.status}`);
    if (m.hasPendingFragment) flags.push('fragment 未送达完');
    if (m.incomplete) flags.push('被截断');
    // 旧存档的 unknownFragmentTypes 是按当时的名单算的，用现在的名单过滤，免得误报已收编的类型
    for (const t of (m.unknownFragmentTypes || []).filter(t => !KNOWN_FRAGMENT_TYPES.has(t))) flags.push(`未知类型 ${t}`);
    if (flags.length) card.appendChild(el('div', 'warn', '⚠ ' + flags.join(' · ')));

    box.appendChild(card);
  }
  if (!messages.length) {
    box.appendChild(el('div', 'warn', '此会话没有正式存档（快照失败或内容被过滤）。传到过浏览器的内容已在上方直接重建；若重建区也是空的，说明服务端根本没往下发，本地无力回天。'));
  }
  await refreshRawArea(sessionId);
}

// 原始帧列表 + 重建区。select() 首次渲染和流收尾（RAW_DONE）后的增量刷新共用，
// 后者不动正文区，用户读到一半不会被闪回去
async function refreshRawArea(sessionId) {
  const [messages, streams] = await Promise.all([
    sessionId ? getMessages(sessionId) : [],
    listRawStreams(sessionId),
  ]);
  // 每条流只读一次、只回放一次，原始帧列表和重建区共用结果
  const replays = new Map();
  for (const s of streams) {
    try { replays.set(s.streamId, replayStream(await readRawText(s.streamId))); }
    catch { /* 单条流回放失败不影响其他 */ }
  }
  if (sessionId !== current) return; // 等库的时候用户点了别的，别覆盖
  renderRawList(sessionId, streams, replays);
  renderRecovered(sessionId, { onlyFiltered: messages.length > 0, streams, replays });
}

// 选中会话时直接把原始帧重放成可读内容：有正式存档的会话只补被过滤的流
// （正常流和正式消息重复），纯原始帧会话则全部重建。回放结果由 select 统一算好传进来
function renderRecovered(sessionId, { onlyFiltered = false, streams = [], replays = new Map() } = {}) {
  const box = $('recovered');
  box.textContent = '';
  box.hidden = true;
  const cards = [];
  for (const s of streams) {
    const r = replays.get(s.streamId);
    if (!r || (!r.response && !r.think)) continue;
    if (onlyFiltered && !r.filtered) continue;
    cards.push({ s, r, prompt: promptOf(s) });
  }
  if (!cards.length) return;
  box.hidden = false;
  box.appendChild(el('div', 'live-meta',
    onlyFiltered ? `${cards.length} 条回答被过滤，已从原始帧重建如下` : `从原始帧重建 ${cards.length} 条回答`));
  for (const { s, r, prompt } of cards) {
    const card = el('article', `msg assistant${r.filtered ? ' filtered' : ''}`);
    card.appendChild(el('h3', null,
      `${new Date(s.startedAt || 0).toLocaleString()} · ${r.filtered ? '⚠ 被过滤，以下是擦除前原文' : '原始帧重建'}`));

    const chips = el('div', 'chips');
    if (r.think) chips.appendChild(el('span', 'chip t-THINK', `THINK ${r.think.length}`));
    if (r.response) chips.appendChild(el('span', 'chip t-RESPONSE', `RESPONSE ${r.chars}`));
    if (r.filtered) chips.appendChild(el('span', 'chip filtered', 'CONTENT_FILTER'));
    if (r.tokenUsage != null) chips.appendChild(el('span', 'chip meta-chip', `${r.tokenUsage} tok`));
    card.appendChild(chips);

    if (prompt) card.appendChild(el('div', 'meta', `提问：${prompt}`));
    if (r.think) {
      const det = el('details');
      const secs = r.thinkSecs != null ? ` ${(Math.round(r.thinkSecs * 10) / 10)}s` : '';
      det.appendChild(el('summary', null, `思考${secs}`));
      det.appendChild(el('pre', 'body', r.think));
      card.appendChild(det);
    }
    if (r.response) card.appendChild(el('pre', 'body', r.response));
    if (r.filtered && r.template) card.appendChild(el('div', 'warn', `页面上实际显示：「${r.template}」`));
    box.appendChild(card);
  }
}

// 从 requestBody 里抠提问文本（抠不出就空）
function promptOf(s) {
  try { return JSON.parse(s.start?.requestBody || '{}').prompt || ''; } catch { return ''; }
}

// 单条流的重建 Markdown 段，导出正文和附录共用
function recoveredSection(s, r, prompt, { includeThinking = true } = {}) {
  const out = [`## ${new Date(s.startedAt || 0).toLocaleString()} · ${r.filtered ? '⚠ 被过滤（已恢复擦除前原文）' : '原始帧重建'}`,
    `> 流 ${s.streamId.slice(0, 8)} · 状态 ${r.status || '?'} · ${r.frames} 帧${r.tokenUsage != null ? ` · ${r.tokenUsage} tok` : ''}`, ''];
  if (prompt) out.push('**提问：** ' + prompt, '');
  if (includeThinking && r.think) {
    const secs = r.thinkSecs != null ? ` ${(Math.round(r.thinkSecs * 10) / 10)}s` : '';
    out.push(`<details><summary>思考${secs}</summary>`, '', r.think, '', '</details>', '');
  }
  if (r.response) out.push(`### 回答${r.filtered ? '（页面实际未显示）' : ''}`, '', r.response, '');
  if (r.filtered && r.template) out.push(`> 页面上最终被替换成模板话术：「${r.template}」`, '');
  return out;
}

async function exportMd(includeThinking) {
  if (!hasSelection) return;
  const [session, messages, streams] = await Promise.all([
    current ? getSession(current) : null,
    current ? getMessages(current) : [],
    listRawStreams(current),
  ]);
  const replays = new Map();
  for (const s of streams) {
    try { replays.set(s.streamId, replayStream(await readRawText(s.streamId))); } catch { /* 单条流回放失败不影响其他 */ }
  }

  // 没有正式存档（被过滤/快照失败的会话常这样）：直接从原始帧重建导出，
  // 这就是原「重建被过滤内容」按钮干的事，现在并进导出按钮
  if (!session || !messages.length) {
    const label = (session && session.title) || current || '未关联会话';
    const out = [`# ${label} · 原始帧重建`, '',
      `> 此会话没有正式存档，Markdown 从 ${streams.length} 条原始 SSE 帧流重放生成 · ${new Date().toLocaleString()}`,
      '> 被过滤的条目恢复的是"擦除前已到达浏览器"的原文，页面实际显示的是模板话术', ''];
    let total = 0, filtered = 0;
    for (const s of streams) {
      const r = replays.get(s.streamId);
      if (!r || (!r.response && !r.think)) continue;
      total++;
      if (r.filtered) filtered++;
      out.push('---', '', ...recoveredSection(s, r, promptOf(s)));
    }
    if (!total) { say('没有可导出的内容：既无正式存档，原始帧里也没有内容帧', 'err'); return; }
    download(`${label}.md`, out.join('\n'), 'text/markdown');
    say(`已导出重建版：${total} 条流 · ${filtered} 条被过滤已恢复`, 'ok');
    return;
  }

  let md = buildMarkdown(session, messages, { includeThinking });
  // 被 CONTENT_FILTER 擦掉的回答不在正式存档里，作为附录自动补上
  const appendix = [];
  for (const s of streams) {
    const r = replays.get(s.streamId);
    if (r && r.filtered && (r.response || r.think)) appendix.push(...recoveredSection(s, r, promptOf(s), { includeThinking }));
  }
  if (appendix.length) md += ['', '', '---', '', '# 附录：被过滤的回答（从原始帧重建，正式存档里没有）', '', ...appendix].join('\n');
  download(`${session.title || current}.md`, md, 'text/markdown');
  say(appendix.length ? '已导出，附录含被过滤回答的重建' : '已生成 Markdown 文件', 'ok');
}

// 原始帧流列表；点一条下载该条 .sse.txt。回放结果由 select 统一算好传进来，这里不再重复读库
function renderRawList(sessionId, streams, replays) {
  const box = $('rawList');
  box.textContent = '';
  box.hidden = !streams.length;
  if (!streams.length) return;
  // 原始帧是排障手段不是日常界面，默认折叠，省得几十条流把详情区顶没
  const det = el('details');
  det.appendChild(el('summary', null, `原始帧 · ${streams.length} 条流（服务端撤不回；点一条可下载 .sse.txt）`));
  for (const s of streams) {
    const line = el('div', 'rawline');
    const status = s.end?.error ? `出错：${s.end.error}`
      : s.meta ? `HTTP ${s.meta.status}` : s.start ? '未收尾' : '不完整';
    line.appendChild(el('span', null, `${new Date(s.startedAt || 0).toLocaleTimeString()} · ${status}`));
    // 被 CONTENT_FILTER 擦过的流给出徽标，用户一眼看出哪条有救、救回多少字
    const r = replays.get(s.streamId);
    if (r) {
      if (r.filtered && r.response) line.appendChild(el('span', 'chip filtered', `被过滤 · 已恢复 ${r.chars} 字`));
      else if (r.filtered) line.appendChild(el('span', 'chip filtered', '被过滤 · 帧内无正文'));
      else if (r.response) line.appendChild(el('span', 'chip meta-chip', `${r.chars} 字`));
    }
    line.appendChild(el('span', 'rawid', s.streamId.slice(0, 8)));
    line.onclick = async () => {
      const text = await readRawText(s.streamId);
      download(`${s.streamId}.sse.txt`,
        `# endpoint\n${s.start?.url || ''}\n\n# requestBody\n${s.start?.requestBody || ''}\n\n# raw\n${text}`,
        'text/plain');
    };
    det.appendChild(line);
  }
  box.appendChild(det);
}

function chain(state, label, detail) {
  const row = el('div', `drow ${state}`);
  row.appendChild(el('span', 'dot', state === 'ok' ? '✓' : state === 'bad' ? '✗' : '·'));
  row.appendChild(el('span', 'dlabel', label));
  row.appendChild(el('span', 'ddetail', detail || ''));
  return row;
}

// diagBox 是 <details>，清空时要保住 summary，不然折叠开关没了
function clearDiag(box) {
  for (const n of [...box.childNodes]) if (n.tagName !== 'SUMMARY') n.remove();
}

async function runDiag() {
  const box = $('diagBox');
  box.hidden = false;
  box.open = true;
  clearDiag(box);
  box.appendChild(el('div', 'live-meta', '正在自检…'));

  const res = await chrome.runtime.sendMessage({ type: 'DIAG_ASK' });
  clearDiag(box);
  if (!res || !res.sw) {
    box.appendChild(chain('bad', '后台进程没应答', JSON.stringify(res)));
    return;
  }
  const { sw, tabs, dbStats, manifestVersion } = res;
  box.appendChild(chain('ok', '后台进程在跑', `脚本版本 ${manifestVersion} · 启动于 ${new Date(sw.swStartedAt).toLocaleTimeString()}`));

  const list = tabs || [];
  if (!list.length) {
    box.appendChild(chain('bad', '没找到任何 DeepSeek 标签页',
      '地址栏确认是 https://chat.deepseek.com/ 开头；不是的话扩展本来就不该注入'));
    return;
  }

  const live = list.filter(t => t.ok);
  box.appendChild(chain(live.length ? 'ok' : 'bad', `扫了 ${list.length} 个 DeepSeek 标签页`,
    live.length ? `${live.length} 个有应答` : '全部无应答 —— 脚本进不去网页'));
  for (const dead of list.filter(t => !t.ok)) {
    box.appendChild(chain('bad', `标签页「${dead.title || dead.tabId}」没装上脚本`,
      '去扩展详情页把「网站访问权限」改成「在所有网站上」，再刷新该页'));
  }
  if (!live.length) return;

  const tab = live[0];
  const injected = tab.mainHook && tab.bridge;
  box.appendChild(chain(injected ? 'ok' : 'bad', '网页脚本',
    `拦抄的 ${tab.mainHook ? '在' : '不在'} · 转发桥 ${tab.bridge ? '在' : '不在'} · 握手暗号 ${tab.nonce ? '有' : '无'}`));

  const hitsOk = tab.streamHits > 0;
  box.appendChild(chain(hitsOk ? 'ok' : tab.xhrTotal > 0 ? 'bad' : 'wait',
    hitsOk ? '堵到了出数据的请求' : tab.xhrTotal > 0 ? '一个请求都没堵上' : '还没发过提问',
    `网页共 ${tab.xhrTotal} 个请求 · 匹配 ${tab.streamHits} 个 · 会话 ${tab.sessionId || '（新的，还没生成 id）'}`));

  box.appendChild(chain(tab.bridgeRecv > 0 ? 'ok' : 'wait', '页面侧抄到内容',
    `共 ${tab.bridgeRecv} 段，送出 ${tab.batchesSent} 批，失败 ${tab.sendFails} 次`));
  box.appendChild(chain(sw.rawChars > 0 ? 'ok' : 'wait', '后台收到原始文本',
    `${sw.rawChars} 字 · ${sw.streamsSeen} 条流 / 收尾 ${sw.streamsEnded} 条`));
  box.appendChild(chain((dbStats?.rawChunkRows || 0) > 0 ? 'ok' : 'wait', '已写入本地库',
    `原始块 ${dbStats?.rawChunkRows ?? '?'} 行 · 正式存档 ${dbStats?.sessions ?? '?'} 个会话 ${dbStats?.messages ?? '?'} 条消息`));

  try {
    const est = await navigator.storage.estimate();
    const mb = n => (n / 1048576).toFixed(1);
    box.appendChild(chain('ok', '本地占用',
      `${mb(est.usage || 0)} MB${est.quota ? ` · 浏览器配额约 ${mb(est.quota)} MB` : ''} · 可在顶栏「备份全部」导出`));
  } catch { /* 拿不到占用信息就算了 */ }

  if (tab.sendFails > 0 && tab.lastSendError) box.appendChild(chain('bad', '页面投递失败', tab.lastSendError));
  for (const e of sw.errors || []) box.appendChild(chain('bad', '后台报错', e));
  if (!hitsOk) box.appendChild(chain('wait', '下一步', '在这个页面问一句话，等它说完，再点一次自检'));
}

$('diag').onclick = runDiag;
$('snapshot').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SNAPSHOT_NOW' });
  if (res && !res.ok) say(res.error || '存档请求失败', 'err');
  else say('已向页面请求存档…');
};

$('exportAll').onclick = () => exportMd(true);
$('exportLean').onclick = () => exportMd(false);

// 备份/恢复：换浏览器、重装扩展前导出一个 JSON，回头读回来
$('backup').onclick = async () => {
  const data = await exportAll();
  const day = new Date().toISOString().slice(0, 10);
  download(`deepseek-archive-${day}.json`, JSON.stringify(data), 'application/json');
  say(`已备份：${data.sessions.length} 个会话 · ${data.messages.length} 条消息 · ${data.rawChunks.length} 段原始帧`, 'ok');
};
$('restore').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { say('文件不是合法 JSON', 'err'); return; }
  if (data?.app !== 'ds-archive' || !Array.isArray(data.sessions)) { say('不是本扩展的备份文件', 'err'); return; }
  if (!confirm(`恢复备份：${data.sessions.length} 个会话、${(data.rawChunks || []).length} 段原始帧？已有的同键记录会被覆盖。`)) return;
  await importAll(data);
  await refreshSessions();
  say('恢复完成', 'ok');
};
$('drop').onclick = async () => {
  if (!hasSelection) return;
  if (!confirm(current ? '删除这条本地存档？含原始帧，不可恢复。' : '删除这些「未关联会话」的原始帧？不可恢复。')) return;
  if (current) await deleteSession(current);
  else await deleteRawForSession(null);
  current = null;
  hasSelection = false;
  $('detail').textContent = '';
  $('rawList').hidden = true;
  $('recovered').hidden = true;
  $('detailHead').textContent = '选择左侧会话查看';
  $('detailActions').hidden = true;
  await refreshSessions();
};

chrome.runtime.onMessage.addListener(msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ARCHIVED') {
    say(`已存档 ${msg.count} 条消息`, 'ok');
    refreshSessions();
    if (msg.sessionId === current) select(current);
  } else if (msg.type === 'RAW_DONE') {
    if (msg.sessionId && msg.sessionId === current) refreshRawArea(current); // 只重画原始帧区和重建区，别闪正文
  } else if (msg.type === 'ARCHIVE_ERROR') {
    say(`存档失败：${msg.message}`, 'err');
  }
});

refreshSessions();
