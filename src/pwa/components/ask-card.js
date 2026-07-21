// Shared inline AskUserQuestion card. Rides the approval-card rail (same banner /
// countdown / accent border as tool approvals) but its body is question(s), option
// buttons, and a free-reply textarea + Send. Used by both the legacy renderSession
// path in app.js and the session-view mount for tabs (mobile + desktop).
//
// The HTML functions are pure. State (in-progress picks + reply draft) is persisted
// on the approvals store — approvals.getAskDraft / setAskReplyDraft / toggleAskPick /
// clearAskDraft — so a full transcript re-render (which fires on every WS event)
// doesn't wipe what the user has typed or selected.
//
// The caller supplies `submitAnswer(approval, picks, replyText)` and
// `formatCountdown(enqueuedAt)`, since the legacy path decorates approvals with its
// own countdown helper and the session-view path uses its own decide bridge.

import { approvals } from '../state/approvals.js';
import { escapeHtml } from '../util.js';

export function askApprovalCardHtml(a, { formatCountdown } = {}) {
  const questions = Array.isArray(a.toolInput?.questions) ? a.toolInput.questions : [];
  const draft = approvals.getAskDraft(a.approvalId);
  const blocks = questions.map((q, qi) => askQuestionBlockHtml(q, qi, draft.picks[qi] || [])).join('');
  const armed = isArmed(draft);
  const enqueuedAt = a.enqueuedAt || 0;
  const countdown = formatCountdown ? formatCountdown(enqueuedAt) : '';
  return (
    `<div class="msg tool_use approval-card approval-card-ask" data-approval-id="${escapeHtml(a.approvalId)}" data-enqueued-at="${enqueuedAt}">` +
      `<div class="approval-banner">` +
        `<span class="approval-banner-label">Question</span>` +
        (countdown ? `<span class="approval-banner-meta" data-countdown>${escapeHtml(countdown)}</span>` : '') +
      `</div>` +
      `<div class="ask-card-body">` +
        blocks +
        `<div class="ask-reply-block">` +
          `<div class="ask-section-label">or write a reply</div>` +
          `<textarea class="ask-reply-field" data-id="${escapeHtml(a.approvalId)}" rows="3" autocapitalize="sentences" placeholder="Type a custom answer…">${escapeHtml(draft.reply || '')}</textarea>` +
        `</div>` +
        `<div class="ask-actions">` +
          `<button class="ask-send${armed ? ' armed' : ''}" data-id="${escapeHtml(a.approvalId)}" type="button">Send →</button>` +
        `</div>` +
      `</div>` +
    `</div>`
  );
}

export function askQuestionBlockHtml(q, qi, selectedOis = []) {
  if (!q || typeof q !== 'object') return '';
  const multi = !!q.multiSelect;
  const header = q.header ? `<div class="ask-q-header">${escapeHtml(String(q.header))}</div>` : '';
  const opts = Array.isArray(q.options) ? q.options : [];
  const selected = new Set(selectedOis);
  const optionsHtml = opts.map((opt, oi) => askOptionHtml(opt, qi, oi, multi, selected.has(oi))).join('');
  return (
    `<section class="ask-question">` +
      header +
      `<div class="ask-q-text">${escapeHtml(String(q.question ?? ''))}</div>` +
      `<div class="ask-section-label">${escapeHtml(multi ? 'select any that apply' : 'choose one')}</div>` +
      `<div class="ask-options">${optionsHtml}</div>` +
    `</section>`
  );
}

export function askOptionHtml(opt, qi, oi, multi, isSelected) {
  const label = String(opt?.label ?? '');
  const desc = String(opt?.description ?? '');
  const mode = multi ? 'data-multi="1"' : 'data-single="1"';
  const selCls = isSelected ? ' selected' : '';
  return (
    `<button type="button" class="ask-option${selCls}" data-qi="${escapeHtml(String(qi))}" data-oi="${escapeHtml(String(oi))}" ${mode}>` +
      `<span class="ask-option-marker" aria-hidden="true"></span>` +
      `<span class="ask-option-body">` +
        `<span class="ask-option-label">${escapeHtml(label)}</span>` +
        (desc ? `<span class="ask-option-desc">${escapeHtml(desc)}</span>` : '') +
      `</span>` +
    `</button>`
  );
}

function isArmed(draft) {
  return (draft.reply || '').trim().length > 0
    || Object.values(draft.picks).some((arr) => Array.isArray(arr) && arr.length > 0);
}

function updateArmed(card) {
  if (!card) return;
  const id = card.dataset.approvalId;
  const draft = approvals.getAskDraft(id);
  const send = card.querySelector('.ask-send');
  send?.classList.toggle('armed', isArmed(draft));
}

// Wire the option / reply / send handlers via event delegation on `scope`. Delegated so
// a full transcript re-render (which replaces the descendant DOM) doesn't lose bindings;
// the caller only needs to invoke this once at mount. Guarded by a per-scope WeakSet
// so re-invoking is a no-op — legacy app.js re-binds after each render (scope=document),
// session-view binds once at mount (scope=transcript-inner), both call sites converge
// here safely.
// submitAnswer(approval, picks, replyText) is called on Send — the caller is responsible
// for the deny-decision round-trip and the transcript-entry flip.
const boundScopes = new WeakSet();
export function bindAskCardHandlers(scope, { submitAnswer }) {
  if (boundScopes.has(scope)) return;
  boundScopes.add(scope);

  scope.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const optionBtn = target.closest('.approval-card-ask .ask-option');
    if (optionBtn) {
      e.stopPropagation();
      const card = optionBtn.closest('.approval-card-ask');
      const id = card?.dataset.approvalId;
      if (!id) return;
      const qi = Number(optionBtn.dataset.qi);
      const oi = Number(optionBtn.dataset.oi);
      const multi = optionBtn.dataset.multi === '1';
      approvals.toggleAskPick(id, qi, oi, multi);
      if (!multi) {
        for (const sib of card.querySelectorAll(`.ask-option[data-qi="${qi}"][data-single]`)) {
          sib.classList.remove('selected');
        }
      }
      optionBtn.classList.toggle('selected');
      updateArmed(card);
      return;
    }
    const sendBtn = target.closest('.approval-card-ask .ask-send');
    if (sendBtn) {
      e.stopPropagation();
      const id = sendBtn.dataset.id;
      const approval = approvals.get().pending.find((a) => a.approvalId === id);
      if (!approval) return;
      const draft = approvals.getAskDraft(id);
      const picks = Object.keys(draft.picks)
        .map((qi) => ({ qi: Number(qi), choices: draft.picks[qi] || [] }))
        .filter((p) => p.choices.length > 0);
      const text = (draft.reply || '').trim();
      if (picks.length === 0 && !text) return;
      approvals.clearAskDraft(id);
      submitAnswer(approval, picks, text || null);
    }
  });

  scope.addEventListener('input', (e) => {
    const ta = e.target instanceof Element ? e.target.closest('.approval-card-ask .ask-reply-field') : null;
    if (!ta) return;
    const id = ta.dataset.id;
    if (!id) return;
    approvals.setAskReplyDraft(id, ta.value);
    updateArmed(ta.closest('.approval-card-ask'));
  });

  scope.addEventListener('keydown', (e) => {
    const ta = e.target instanceof Element ? e.target.closest('.approval-card-ask .ask-reply-field') : null;
    if (!ta) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const send = ta.closest('.approval-card-ask')?.querySelector('.ask-send');
      send?.click();
    }
  });
}

// Compose the deny-reason text that Claude will see. Same wire format as the native
// AskUserQuestion tool_result — that way our hook denial reads to Claude as "the user
// said X" rather than "the tool failed."
export function buildAskAnswerWire(approval, picks, replyText) {
  const questions = Array.isArray(approval.toolInput?.questions) ? approval.toolInput.questions : [];
  const pairs = [];
  for (const { qi, choices } of picks) {
    const q = questions[qi];
    if (!q) continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    const labels = choices.map((oi) => opts[oi]?.label).filter(Boolean);
    if (!labels.length) continue;
    pairs.push({ question: String(q.question ?? ''), answer: labels.join(', ') });
  }
  let wire = '';
  if (pairs.length > 0) {
    const quoted = pairs.map(({ question, answer }) => `"${question}"="${answer}"`).join(', ');
    wire = `Your questions have been answered: ${quoted}`;
  }
  if (replyText) {
    wire = wire ? `${wire}. User also added: ${replyText}` : `User replied: ${replyText}`;
  }
  if (!wire) wire = 'User dismissed the question without answering.';
  return wire;
}
