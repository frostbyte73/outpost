const ACTION_TURN = /^\/([a-z]+\.[a-z0-9-]+)(\s[\s\S]*)?$/;

// A daemon-spawned turn names an action as `/<name>`; a runtime without Claude's skills gets the SKILL.md body.
export function expandActionTurn(text: string, actionBody: (name: string) => string | undefined): string {
  const m = ACTION_TURN.exec(text);
  const body = m ? actionBody(m[1]!) : undefined;
  if (!m || body === undefined) return text;
  return `Run the Outpost action \`${m[1]}\`. Its instructions follow. The \`mcp__outpost__*\` tools are already `
    + 'available in this session, so skip any step that loads them through ToolSearch or a deferred-tool lookup.'
    + `\n\n${body.trim()}${m[2] ? `\n\n${m[2].trim()}` : ''}`;
}
