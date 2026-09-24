// 原始帧回放器：把录到的 SSE 文本重新应用一遍 {p, o, v} 操作，重建出回答全文。
// 关键用途：DeepSeek 的内容审核是"先发送、后擦除"——正文完整推到浏览器后，
// 最后一帧 BATCH 把 status 改成 CONTENT_FILTER 并用 TEMPLATE_RESPONSE 覆盖 fragments。
// 回放时旧 fragment 内容留在我们手里，因此被擦掉的原文可以完整恢复。
// 纯函数、无 Chrome 依赖：侧栏用它导出，Node 测试也用它验证。

// 把 SSE 文本切成事件块：[{ event, dataText }]。data 多行按 SSE 规范用 \n 拼接。
export function parseSse(rawText) {
  const events = [];
  let cur = null;
  for (const line of String(rawText).split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      cur = cur || { event: null, data: [] };
      cur.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      cur = cur || { event: null, data: [] };
      cur.data.push(line.slice(5).replace(/^ /, ''));
    } else if (line.trim() === '') {
      if (cur) { events.push({ event: cur.event, dataText: cur.data.join('\n') }); cur = null; }
    }
  }
  if (cur) events.push({ event: cur.event, dataText: cur.data.join('\n') });
  return events;
}

function addFragment(st, f) {
  if (!f || typeof f !== 'object' || f.id == null) return;
  const prev = st.fragments.get(f.id);
  st.fragments.set(f.id, {
    id: f.id,
    type: f.type || (prev && prev.type) || 'UNKNOWN',
    // 覆盖式替换（CONTENT_FILTER）时新 fragment 可能带模板内容；旧内容已在 prev 里，不动它
    content: typeof f.content === 'string' ? f.content : (prev ? prev.content : ''),
    elapsedSecs: typeof f.elapsed_secs === 'number' ? f.elapsed_secs : (prev ? prev.elapsedSecs : null),
  });
  st.lastFragId = f.id;
}

function applyBatch(st, ops) {
  for (const sub of ops || []) {
    if (!sub || typeof sub !== 'object') continue;
    if (sub.p === 'status') {
      st.status = sub.v;
      if (sub.v === 'CONTENT_FILTER') st.filtered = true;
    } else if (sub.p === 'quasi_status') {
      st.quasiStatus = sub.v;
      if (sub.v === 'CONTENT_FILTER') st.filtered = true;
    } else if (sub.p === 'fragments' && Array.isArray(sub.v)) {
      // 服务端撤回：fragments 数组被整体换掉。旧内容保留在 st.fragments 里，不删。
      st.fragmentsReplaced = true;
      for (const f of sub.v) {
        addFragment(st, f);
        if (f && f.type === 'TEMPLATE_RESPONSE') {
          st.filtered = true;
          st.template = f.content || '';
        }
      }
    } else if (sub.p === 'accumulated_token_usage') {
      st.tokenUsage = sub.v;
    } else if (sub.p === 'ban_regenerate') {
      st.banRegenerate = sub.v;
    }
  }
}

// 回放一条流的原始文本，返回重建结果：
// { responseMessageId, think, thinkSecs, response, filtered, template, status, quasiStatus,
//   tokenUsage, chars, frames }
export function replayStream(rawText) {
  const st = {
    requestMessageId: null,
    responseMessageId: null,
    fragments: new Map(),
    lastFragId: null,
    lastPath: null,
    status: null,
    quasiStatus: null,
    tokenUsage: null,
    banRegenerate: null,
    filtered: false,
    fragmentsReplaced: false,
    template: null,
    frames: 0,
  };

  for (const ev of parseSse(rawText)) {
    if (!ev.dataText) continue;
    let frame;
    try { frame = JSON.parse(ev.dataText); } catch { continue; }
    if (!frame || typeof frame !== 'object') continue;
    st.frames++;

    if (ev.event === 'ready') {
      st.requestMessageId = frame.request_message_id ?? null;
      st.responseMessageId = frame.response_message_id ?? null;
      continue;
    }

    // 初始全量帧：{"v":{"response":{...fragments:[...]}}}，无 p 无 o
    if (!frame.p && frame.v && typeof frame.v === 'object' && frame.v.response) {
      const r = frame.v.response;
      if (r.status) st.status = r.status;
      if (typeof r.accumulated_token_usage === 'number') st.tokenUsage = r.accumulated_token_usage;
      for (const f of r.fragments || []) addFragment(st, f);
      continue;
    }

    // 省略 p 的帧是"上一路径的续传"，按上一路径 + 值类型分派：
    //   字符串 + content 路径 → 继续追加文本
    //   数组 + response 路径 → BATCH 的续传（实测 CONTENT_FILTER 覆盖帧就长这样：{"v":[...子操作...]}）
    //   数组 + fragments 路径 → 继续追加 fragment
    // 其余（update_session 的对象、close 的空帧等）必须跳过——否则会沿用上一路径
    // 把 undefined 写进字段（实测把 response/status 的 FINISHED 冲成 undefined）
    if (!frame.p) {
      if (typeof frame.v === 'string' && st.lastPath && st.lastPath.endsWith('/content')) {
        const f = st.fragments.get(st.lastFragId);
        if (f) f.content += frame.v;
      } else if (Array.isArray(frame.v) && st.lastPath === 'response') {
        applyBatch(st, frame.v);
      } else if (Array.isArray(frame.v) && st.lastPath === 'response/fragments') {
        for (const f of frame.v) addFragment(st, f);
      }
      continue;
    }

    const path = frame.p;
    st.lastPath = frame.p;

    if (path === 'response' && Array.isArray(frame.v)) {
      // {"p":"response","o":"BATCH","v":[...子操作...]}
      applyBatch(st, frame.v);
    } else if (path === 'response/fragments' && Array.isArray(frame.v)) {
      // 顶层 fragments 数组帧是追加新 fragment（RESPONSE / TIP 等）
      for (const f of frame.v) addFragment(st, f);
    } else if (path.endsWith('/content')) {
      // 省略 p 的 {"v":"..."} 帧沿用上一个路径继续追加
      if (typeof frame.v === 'string') {
        const f = st.fragments.get(st.lastFragId);
        if (f) f.content += frame.v;
      }
    } else if (path.endsWith('/elapsed_secs')) {
      const f = st.fragments.get(st.lastFragId);
      if (f && typeof frame.v === 'number') f.elapsedSecs = frame.v;
    } else if (path === 'response/status') {
      st.status = frame.v;
      if (frame.v === 'CONTENT_FILTER') st.filtered = true;
    }
    // 其余路径（response/ban_edit 之类）与内容无关，忽略
  }

  const frags = [...st.fragments.values()].sort((a, b) => a.id - b.id);
  const thinkFrags = frags.filter(f => f.type === 'THINK');
  const think = thinkFrags.map(f => f.content).join('\n');
  // 只取 RESPONSE；被过滤后补进来的 TEMPLATE_RESPONSE 是模板话术，单独放 template
  const response = frags.filter(f => f.type === 'RESPONSE').map(f => f.content).join('');
  const thinkSecs = thinkFrags.length ? thinkFrags[thinkFrags.length - 1].elapsedSecs : null;

  return {
    requestMessageId: st.requestMessageId,
    responseMessageId: st.responseMessageId,
    think,
    thinkSecs,
    response,
    filtered: st.filtered,
    fragmentsReplaced: st.fragmentsReplaced,
    template: st.template,
    status: st.status,
    quasiStatus: st.quasiStatus,
    tokenUsage: st.tokenUsage,
    chars: response.length,
    frames: st.frames,
  };
}
