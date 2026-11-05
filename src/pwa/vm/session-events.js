// Canonical session items (src/runtime/types.ts) → transcript entries; history and live events share it.

export function toolUseEntry(item) {
  return {
    role: 'tool_use',
    text: `${item.rawName}(${JSON.stringify(item.input).slice(0, 200)})`,
    tool: item.tool,
    toolName: item.rawName,
    toolInput: item.input,
    toolUseId: item.id,
    ...(item.messageId ? { msgId: item.messageId } : {}),
    ...(item.status === 'declined' ? { decision: 'deny', ...(item.declineReason ? { rejectReason: item.declineReason } : {}) } : {}),
  };
}

export function itemToEntries(item) {
  switch (item?.type) {
    case 'user_message':
      return [{ role: 'user', text: item.text, ...(item.images ? { images: item.images } : {}) }];
    case 'assistant_message':
      return [{ role: 'assistant', text: item.text, ...(item.messageId ? { msgId: item.messageId } : {}) }];
    case 'user_shell':
      return [{ role: 'shell', text: item.command, stdout: item.stdout, stderr: item.stderr }];
    case 'tool_call':
      return [
        toolUseEntry(item),
        ...(item.resultText ? [{ role: 'tool_result', text: item.resultText, toolUseId: item.id }] : []),
      ];
    default:
      return [];
  }
}

// An agent's reply leads its result text; the `agentId: …` metadata block follows it.
export function agentResultSummary(resultText) {
  const summary = String(resultText ?? '').split(/^agentId:/m)[0].trim();
  return summary || null;
}
