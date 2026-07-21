// Shared wire format for the diff-review bundled message: diff-overlay's
// "Submit review" composes it from drafted per-hunk comments; session-view's
// message-html.js renders it back out as a structured Review tile. Single
// source of truth so the two never drift on what marks a message as a review
// (previously diff-overlay sent a bare human-readable prefix while
// message-html looked for an HTML-comment marker it never received — the
// tile silently fell back to a plain text bubble).
//
// Wire shape (marker line first so the renderer can recognize it unambiguously,
// human-readable prefix kept below so the message still reads sensibly
// wherever the marker gets stripped — Linear comments, plain-text exports):
//
//   <!-- outpost:diff-review -->
//   Code review comments on the diff:
//
//   **file:line** (old|new)
//   > mark quotedline
//
//   note text
//
//   ---
//
//   **file2:line2** ...

export const DIFF_REVIEW_MARKER = '<!-- outpost:diff-review -->';
export const DIFF_REVIEW_PREFIX = 'Code review comments on the diff:';

export function isDiffReviewMessage(text) {
  return typeof text === 'string' && text.startsWith(DIFF_REVIEW_MARKER);
}

// `comments` — array of { file, side: 'old'|'new', line, lineText, content }.
export function formatDiffReviewMessage(comments) {
  const blocks = comments.map((c) => {
    const sideLabel = c.side === 'old' ? ' (old)' : ' (new)';
    const mark = c.side === 'old' ? '-' : '+';
    const quote = c.lineText.length > 240 ? c.lineText.slice(0, 240) + '…' : c.lineText;
    return `**${c.file}:${c.line}**${sideLabel}\n> ${mark} ${quote}\n\n${c.content}`;
  });
  return `${DIFF_REVIEW_MARKER}\n${DIFF_REVIEW_PREFIX}\n\n${blocks.join('\n\n---\n\n')}`;
}

const BLOCK_RE = /^\*\*(.+?):(\d+)\*\*(?: \((old|new)\))?\n> (.) ?([\s\S]*?)\n\n([\s\S]*)$/;

// Parses a message that passed isDiffReviewMessage() back into
// { file, line, side, mark, quote, note }[] for the structured tile. Falls
// back to a single { note: <raw block> } entry for a block that doesn't match
// the expected shape, so a hand-edited or truncated message still renders
// something rather than silently dropping content.
export function parseDiffReviewMessage(text) {
  if (!isDiffReviewMessage(text)) return null;
  let body = text.slice(DIFF_REVIEW_MARKER.length).replace(/^\n/, '');
  if (body.startsWith(DIFF_REVIEW_PREFIX)) body = body.slice(DIFF_REVIEW_PREFIX.length).replace(/^\n+/, '');
  return body.split('\n\n---\n\n').map((block) => {
    const m = BLOCK_RE.exec(block);
    if (!m) return { file: '', line: '', side: 'new', mark: '', quote: '', note: block.trim() };
    const [, file, line, side, mark, quote, note] = m;
    return { file, line, side: side ?? 'new', mark, quote, note: note.trim() };
  });
}
