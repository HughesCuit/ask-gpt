/** Pure helpers for ChatGPT Think-chip selection state (no DOM). */

export function chipLooksSelected(state) {
  if (!state) return false;
  if (state.pressed === 'true' || state.pressed === 'on' || state.pressed === 'checked') {
    return true;
  }
  if (state.selectedAttr === 'true' || state.selectedAttr === 'ancestor') return true;
  if (state.hasActiveClass) return true;
  return false;
}

export function thinkingMeta(thinking) {
  return {
    thinking_requested: !!thinking?.requested,
    thinking_enabled: !!thinking?.ok && !!thinking?.verified,
    thinking_clicked: !!thinking?.ok,
    thinking_method: thinking?.method || 'not-requested',
    thinking_detail: thinking?.detail || thinking?.buttons || null,
  };
}
