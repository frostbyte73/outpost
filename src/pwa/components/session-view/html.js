// HTML-escape utility shared by the session-view renderers. Any string that
// comes from the transcript (user messages, tool inputs, error text, assistant
// output pre-markdown) MUST pass through this before being interpolated into
// innerHTML. Untrusted content includes anything from the daemon's session
// stream — Claude's output, tool JSON, filesystem paths — none of it is
// pre-sanitized.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}
