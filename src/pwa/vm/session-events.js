// Canonical session items (src/runtime/types.ts) → transcript entries; history and live events share it.

export function toolUseEntry(item) {
  return {
    role: 'tool_use',
    text: `${item.rawName}(${JSON.stringify(item.input).slice(0, 200)})`,
    tool: item.tool,
    toolName: item.rawName,
    toolInput: item.input,
    toolUseId: item.id,
    ...(item.commandActions ? { commandActions: item.commandActions } : {}),
    ...(item.messageId ? { msgId: item.messageId } : {}),
    ...(item.status === 'declined' ? { decision: 'deny', ...(item.declineReason ? { rejectReason: item.declineReason } : {}) } : {}),
  };
}

export function itemToEntries(item) {
  switch (item?.type) {
    case 'user_message':
      return [{ role: 'user', itemId: item.id, text: item.text, ...(item.images ? { images: item.images } : {}) }];
    case 'assistant_message':
      return [{ role: 'assistant', itemId: item.id, text: item.text, ...(item.messageId ? { msgId: item.messageId } : {}) }];
    case 'user_shell':
      return [{ role: 'shell', itemId: item.id, text: item.command, stdout: item.stdout, stderr: item.stderr }];
    case 'tool_call': {
      const result = shownResult(item.resultText);
      return [
        toolUseEntry(item),
        // Older Codex transcripts repeat apply_patch's diff as its result.
        ...(result && item.rawName !== 'apply_patch' ? [{ role: 'tool_result', text: result, toolUseId: item.id }] : []),
      ];
    }
    default:
      return [];
  }
}

// Cursor's shell tool reports this when its allowlist is empty. Outpost clears that list, so the
// notice is already on disk for older calls and is not the command's output.
const SHELL_ALLOWLIST_NOTE = 'Shell allowlist is empty';

function shownResult(text) {
  if (typeof text !== 'string') return '';
  return text.split('\n').filter((line) => line.trim() !== SHELL_ALLOWLIST_NOTE).join('\n').trim();
}

// An agent's reply leads its result text; the `agentId: …` metadata block follows it.
export function agentResultSummary(resultText) {
  const summary = String(resultText ?? '').split(/^agentId:/m)[0].trim();
  return summary || null;
}
