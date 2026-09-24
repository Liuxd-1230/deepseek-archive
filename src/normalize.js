// TIP：回答末尾的固定提示语（"内容由 AI 生成，仅供参考"之类），实测无信息量
export const KNOWN_FRAGMENT_TYPES = new Set(['REQUEST', 'THINK', 'RESPONSE', 'TOOL_SEARCH', 'TOOL_OPEN', 'TIP']);

export function normalizeMessages(sessionId, chatMessages) {
  return chatMessages.map(m => {
    const fragments = (m.fragments || []).map(f => ({
      id: f.id,
      type: f.type,
      content: f.content || '',
      stageId: f.stage_id ?? null,
      elapsedSecs: f.elapsed_secs ?? null,
      references: f.references ?? null,
    }));
    return {
      sessionId,
      messageId: m.message_id,
      parentId: m.parent_id ?? null,
      role: m.role,
      status: m.status ?? null,
      hasPendingFragment: !!m.has_pending_fragment,
      incomplete: m.incomplete_message ?? null,
      thinkingEnabled: !!m.thinking_enabled,
      searchEnabled: !!m.search_enabled,
      searchTriggered: !!m.search_triggered,
      tokenUsage: m.accumulated_token_usage ?? null,
      model: m.model || null,
      feedback: m.feedback ?? null,
      autoContinue: !!m.auto_continue,
      extraSearchProviders: m.extra_search_providers ?? null,
      createdAt: m.inserted_at ?? null,
      fragments,
      unknownFragmentTypes: [...new Set(fragments.map(f => f.type).filter(t => !KNOWN_FRAGMENT_TYPES.has(t)))],
    };
  });
}

export function normalizeSession(sessionId, session) {
  return {
    sessionId,
    title: session?.title || sessionId.slice(0, 8),
    modelType: session?.model_type ?? null,
    pinned: !!session?.pinned,
    updatedAt: session?.updated_at || Date.now() / 1000,
    currentMessageId: session?.current_message_id ?? null,
    url: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
  };
}
