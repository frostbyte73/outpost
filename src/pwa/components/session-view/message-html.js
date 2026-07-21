// Real tool tiles (via components/tool-use-tile.js), markdown-rendered
// assistant output, and the editorial Q/A card for answered asks (ask-flow's
// askMsgHtml — shared with the legacy path so both render the same shape).
//
// XSS discipline: every value that lands in innerHTML goes through escapeHtml.
// renderMarkdown does its own sanitisation for the assistant path.
import { escapeHtml } from '../../util.js';
import { renderMarkdown } from '../../markdown.js';
import {
  toolUseHtml,
  shellLineHtml,
  readLineHtml,
  editWriteTileHtml,
} from '../tool-use-tile.js';
import { askMsgHtml } from '../ask-flow.js';
import { isDiffReviewMessage, parseDiffReviewMessage } from '../diff-review-format.js';

const ROLE_LABELS = { user: 'You', assistant: 'Assistant', error: 'Error', archived: 'Archived' };
const SHELL_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch']);

function stripCommandScaffolding(text) {
  return text
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>\s*/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>\s*/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>\s*/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>\s*/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>\s*/g, '')
    .trim();
}

// Real tool tile renderer, mirroring app.js's msgHtml tool_use branch. The
// wrapping logic for rejected tiles is the same — a rejected tool call renders
// its normal tile inside a rejection frame with the user's note. expandedTools
// is the per-session Set so multi-live views don't share expansion state.
function toolTileHtml(m, expandedTools, ctx) {
  let tile;
  if (m.toolName === 'Read') tile = readLineHtml(m.toolInput, ctx);
  else if (SHELL_TOOLS.has(m.toolName)) tile = shellLineHtml(m.toolName, m.toolInput, ctx);
  else if (m.toolName === 'Edit' || m.toolName === 'Write') tile = editWriteTileHtml(m, { expandedTools, ctx });
  else tile = toolUseHtml(m, { expandedTools, ctx });
  if (m.decision !== 'deny') return tile;
  const reasonHtml = m.rejectReason
    ? `<div class="tool-reject-reason">${escapeHtml(m.rejectReason)}</div>`
    : '';
  return `<div class="tool-rejected"><span class="tool-reject-tag">Rejected</span>${tile}${reasonHtml}</div>`;
}

// Pending-ask fallback tile. Pending asks are normally filtered out of the
// feed in favor of the inline approval card (renderTranscript's pendingIds
// set); this only shows for e.g. a disk-replayed pending ask whose approval
// is no longer live. Answered asks route through askMsgHtml instead.
function askPendingHtml(m) {
  const qs = Array.isArray(m.questions) ? m.questions : [];
  const questionText = qs.length ? escapeHtml(qs[0]?.question ?? '') : escapeHtml(m.text ?? '');
  return `<div class="msg ask-msg"><span class="role">Ask</span><div class="body-text"><div class="ask-msg-q">${questionText}</div><div class="ask-msg-pending">waiting for reply…</div></div></div>`;
}

// Structured review-memo tile for a bundled diff-review submission (diff-
// overlay's "Submit review") — an editorial ledger of citation + quoted line
// + note per comment, matching the pre-existing .diff-review-msg CSS.
function diffReviewTileHtml(text) {
  const comments = parseDiffReviewMessage(text) ?? [];
  const count = comments.length;
  const items = comments.map((c) => {
    const cite = c.file
      ? `<div class="dr-cite"><span class="dr-cite-mark">§</span><span class="dr-cite-file">${escapeHtml(c.file)}</span><span class="dr-cite-sep">→</span><span class="dr-cite-line">L${escapeHtml(c.line)}</span></div>`
      : '';
    const lineCls = c.mark === '-' ? 'diff-del' : 'diff-add';
    const line = c.quote
      ? `<div class="dr-line diff-line ${lineCls}"><span class="diff-mark">${escapeHtml(c.mark || '+')}</span><span class="diff-text">${escapeHtml(c.quote)}</span></div>`
      : '';
    const note = c.note ? `<div class="dr-note">${escapeHtml(c.note)}</div>` : '';
    return `<li class="dr-item">${cite}${line}${note}</li>`;
  }).join('');
  return `<div class="msg user diff-review-msg">
    <div class="dr-head"><span class="dr-eyebrow">Review</span><span class="dr-meta">${count} comment${count === 1 ? '' : 's'}</span></div>
    <ol class="dr-list">${items}</ol>
  </div>`;
}

function truncate(s, max) {
  const collapsed = String(s ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : (collapsed.slice(0, max) + '…');
}

function toolArgSummary(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return truncate(input.file_path || input.path || '', 100);
  }
  return truncate(JSON.stringify(input), 100);
}

function wrapOneLine(role, body) {
  return `<div class="inline-line" data-role="${escapeHtml(role)}"><span class="inline-line-body">${body}</span></div>`;
}

// Single-line summary of a transcript entry — used by the inline session preview
// in the job view. Truncates aggressively; returns '' for entries that shouldn't
// appear in the tail (tool_result — the tool_use above it already speaks for it).
// Tool_use entries render via the same shell/read tiles as the main feed so
// Bash/Grep/Glob/Read/WebFetch/WebSearch/Skill/ToolSearch match the transcript's
// prompt-style formatting; CSS scoped to .inline-session-body squashes their
// margins and clips overflow so they still fit the preview's 2-line budget.
export function oneLineMsgHtml(m, ctx) {
  if (!m || !m.role) return '';
  if (m.role === 'tool_result') return '';
  if (m.role === 'tool_use') {
    if (m.toolName === 'Read') return readLineHtml(m.toolInput, ctx);
    if (SHELL_TOOLS.has(m.toolName)) return shellLineHtml(m.toolName, m.toolInput, ctx);
    const summary = toolArgSummary(m.toolName, m.toolInput);
    return wrapOneLine('tool_use', escapeHtml(`→ ${m.toolName ?? 'tool'}${summary ? ' ' + summary : ''}`));
  }
  if (m.role === 'ask') {
    const q = Array.isArray(m.questions) && m.questions[0]?.question
      ? m.questions[0].question
      : (m.text ?? '');
    return wrapOneLine('ask', escapeHtml(`? ${truncate(q, 120)}`));
  }
  if (m.role === 'error') return wrapOneLine('error', escapeHtml(`! ${truncate(m.text ?? '', 120)}`));
  if (m.role === 'user') {
    const stripped = stripCommandScaffolding(m.text ?? '');
    if (!stripped) return '';
    return wrapOneLine('user', escapeHtml(`» ${truncate(stripped, 120)}`));
  }
  if (m.role === 'assistant') {
    if (!m.text) return '';
    return wrapOneLine('assistant', escapeHtml(truncate(m.text, 120)));
  }
  return wrapOneLine(m.role, escapeHtml(truncate(m.text ?? '', 120)));
}

// Public entry point — turns a transcript entry into HTML for the session-view.
// Kept name-compatible with the C.1 shim (session-view/index.js imports it as
// `minimalMsgHtml`). `expandedTools` is a Set<toolUseId> from the caller's
// session slice; when omitted, tool tiles fall back to the singleton mirror.
export function minimalMsgHtml(m, expandedTools, ctx) {
  if (m.role === 'tool_use') return toolTileHtml(m, expandedTools, ctx);
  if (m.role === 'ask') return m.answer == null ? askPendingHtml(m) : askMsgHtml(m);
  if (m.role === 'tool_result') {
    const preview = typeof m.text === 'string' ? escapeHtml(m.text.slice(0, 400)) : '';
    return `<div class="msg tool_result"><span class="role">Result</span><span class="body-text">${preview}</span></div>`;
  }

  let text = m.text ?? '';
  if (m.role === 'user' && typeof text === 'string') {
    text = stripCommandScaffolding(text);
    if (!text) return '';
    if (isDiffReviewMessage(text)) return diffReviewTileHtml(text);
  }

  const label = ROLE_LABELS[m.role] ?? String(m.role ?? '');
  const body = m.role === 'assistant' ? renderMarkdown(text) : escapeHtml(text);
  const action = m.action === 'reopen'
    ? `<button class="msg-action" type="button" data-msg-action="reopen">Reopen</button>`
    : '';
  const pending = m.__pending ? ' is-pending' : '';
  return `<div class="msg ${escapeHtml(m.role)}${pending}"><span class="role">${escapeHtml(label)}</span><span class="body-text">${body}</span>${action}</div>`;
}
