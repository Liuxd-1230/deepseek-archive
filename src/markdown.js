import { KNOWN_FRAGMENT_TYPES } from './normalize.js';

const BRANCH_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function renderReferences(refs) {
  if (!Array.isArray(refs) || !refs.length) return '';
  return refs.map((r, i) => {
    if (typeof r !== 'object' || r === null) return `${i + 1}. ${r}`;
    const title = r.title || r.name || r.url || '';
    const url = r.url || '';
    // 引用对象的字段名还没摸清（实测 title/url 全空），认不出就原样亮出来，别渲染成空行
    if (!title && !url) return `${i + 1}. ${JSON.stringify(r)}`;
    return `${i + 1}. ${title}${url && url !== title ? ` — ${url}` : ''}`;
  }).join('\n');
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

    for (const f of m.fragments) {
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
      } else if (f.type === 'TOOL_SEARCH' || f.type === 'TOOL_OPEN') {
        // 字段结构还没摸清（实测载荷不在 content/references 里），整个 fragment 倒出来
        out.push(rawBlock(`${f.type} #${f.id}`, f));
      } else {
        out.push(rawBlock(`未识别的 fragment 类型 ${f.type}`, { id: f.id, content: f.content, references: f.references }));
      }
      const refs = renderReferences(f.references);
      if (refs && f.type === 'RESPONSE') out.push('### 引用来源', '', refs, '');
    }

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
