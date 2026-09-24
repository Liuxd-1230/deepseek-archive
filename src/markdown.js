import { KNOWN_FRAGMENT_TYPES } from './normalize.js';

const BRANCH_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 实测（0.2.3）：引用是 {id,type} 指针，指向同一条消息里的工具 fragment——
// 指 TOOL_OPEN 时它的 result 就是真实来源；指 TOOL_SEARCH 时只定位到整组搜索结果
function renderReferences(refs, byId) {
  if (!Array.isArray(refs) || !refs.length) return '';
  return refs.map((r, i) => {
    if (r && typeof r === 'object' && r.id != null && byId) {
      const f = byId.get(r.id);
      const res = f && f.result;
      if (res && (res.title || res.url)) {
        return `${i + 1}. [${res.title || res.url}](${res.url})${res.site_name ? ` — ${res.site_name}` : ''}`;
      }
      if (f && f.type === 'TOOL_SEARCH') {
        return `${i + 1}. 联网搜索结果（${(f.results || []).length} 条）`;
      }
    }
    if (typeof r !== 'object' || r === null) return `${i + 1}. ${r}`;
    const title = r.title || r.name || r.url || '';
    const url = r.url || '';
    if (!title && !url) return `${i + 1}. ${JSON.stringify(r)}`; // 还没见过的形状，原样亮出来
    return `${i + 1}. ${title}${url && url !== title ? ` — ${url}` : ''}`;
  }).join('\n');
}

const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString('zh-CN') : '';

// 一条搜索结果/打开网页 → markdown 列表行（标题链接 + 来源 + 日期 + 摘要引用）
function resultLine(r) {
  const date = fmtDate(r.published_at);
  const lines = [`- [${r.title || r.url}](${r.url})${r.site_name ? ` — ${r.site_name}` : ''}${date ? ` · ${date}` : ''}`];
  if (r.snippet) lines.push(`  > ${r.snippet}`);
  return lines;
}

// TOOL_SEARCH / TOOL_OPEN 的字段结构尚未实测，原样落成 json 块，避免静默丢数据
function rawBlock(label, value) {
  return `### ${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

export function buildMarkdown(session, messages, { includeThinking = true } = {}) {
  const sorted = [...messages].sort((a, b) => a.messageId - b.messageId);
  const siblings = new Map();
  for (const m of sorted) {
    const key = m.parentId ?? 0;
    siblings.set(key, (siblings.get(key) || 0) + 1);
  }
  const seenBranch = new Map();

  const out = [`# ${session.title || session.sessionId}`, ''];
  out.push(`> 会话 \`${session.sessionId}\` · 共 ${sorted.length} 条消息 · 导出于 ${new Date().toLocaleString()}`, '');

  for (const m of sorted) {
    const key = m.parentId ?? 0;
    if (siblings.get(key) > 1) {
      const n = seenBranch.get(key) || 0;
      seenBranch.set(key, n + 1);
      out.push(`---`, '', `## 分支 ${BRANCH_LABELS[n] || n}（父消息 #${m.parentId}）`, '');
    }

    const byId = new Map(m.fragments.map(f => [f.id, f]));
    // TOOL_OPEN 往往一连好几个（模型批量开网页），攒起来合成一个列表，别一个一块
    let pendingOpens = [];
    const flushOpens = () => {
      if (!pendingOpens.length) return;
      out.push(`### 📄 打开网页 ${pendingOpens.length} 个`, '');
      for (const o of pendingOpens) out.push(...resultLine(o.result || {}));
      out.push('');
      pendingOpens = [];
    };

    for (const f of m.fragments) {
      if (f.type !== 'TOOL_OPEN') flushOpens();
      if (f.type === 'REQUEST') {
        out.push('## 提问', '', f.content, '');
      } else if (f.type === 'THINK') {
        if (!includeThinking) continue;
        const secs = f.elapsedSecs != null ? ` ${(Math.round(f.elapsedSecs * 10) / 10)}s` : '';
        out.push(`<details><summary>思考${secs}</summary>`, '', f.content, '', '</details>', '');
      } else if (f.type === 'RESPONSE') {
        out.push('## 回答', '', f.content, '');
      } else if (f.type === 'TIP') {
        continue; // 固定提示语（"内容由 AI 生成…"），库里和原始帧里都留着，导出就不带噪音了
      } else if (f.type === 'TOOL_SEARCH') {
        const qs = (f.queries || []).map(q => q.query).filter(Boolean);
        const results = Array.isArray(f.results) ? f.results : [];
        out.push('### 🔍 联网搜索', '');
        if (qs.length) out.push(`查询：${qs.map(q => `「${q}」`).join(' ')}`, '');
        if (results.length) {
          out.push(`<details><summary>搜索结果 ${results.length} 条</summary>`, '');
          for (const r of results) out.push(...resultLine(r));
          out.push('', '</details>', '');
        }
      } else if (f.type === 'TOOL_OPEN') {
        pendingOpens.push(f);
      } else {
        out.push(rawBlock(`未识别的 fragment 类型 ${f.type}`, { id: f.id, content: f.content, references: f.references }));
      }
      const refs = renderReferences(f.references, byId);
      if (refs && f.type === 'RESPONSE') out.push('### 引用来源', '', refs, '');
    }
    flushOpens();

    const flags = [];
    if (m.status && m.status !== 'FINISHED') flags.push(`状态 \`${m.status}\``);
    if (m.hasPendingFragment) flags.push('仍有未送达的 fragment');
    if (m.incomplete) flags.push('内容被截断');
    // 旧版本存档时 TIP 还没被收编，unknownFragmentTypes 里留着它；按现在的名单过滤再报
    const unknown = (m.unknownFragmentTypes || []).filter(t => !KNOWN_FRAGMENT_TYPES.has(t));
    if (unknown.length) flags.push(`未识别 fragment: ${unknown.join(', ')}`);
    if (flags.length) out.push(`> ⚠ ${flags.join(' · ')}`, '');
  }

  return out.join('\n');
}
