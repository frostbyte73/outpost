// AskUserQuestion flow for the mobile shell. Ask entries live in the session's
// transcript with role='ask' and either an inline approval card (while pending)
// or an editorial "answered" tile (once submitted). This module owns:
//   - ensureAskInlineTile: idempotently plants/updates the pending entry
//   - submitAskAnswer:     resolves the ask and routes the answer through decideApproval
//   - askApprovalCardHtml: pending-state card (uses the shared ask-card renderer)
//   - askMsgHtml + askAnsweredHtml + parseAskAnswer: answered-state renderers
//   - applyAskTranscriptMessage: disk-replay adapter — pushes ask entries into a sink
//
// The approvals-mobile module owns formatApprovalCountdown and decideApproval;
// those come in via init.

import { sessions } from '../state/sessions.js';
import { approvals } from '../state/approvals.js';
import { escapeHtml } from '../util.js';
import { compactWs } from './tool-use-tile.js';
import { askApprovalCardHtml as sharedAskApprovalCardHtml, buildAskAnswerWire } from './ask-card.js';

let _deps = {
  formatApprovalCountdown: () => '',
  decideApproval: () => {},
};

export function initAskFlow(deps) {
  _deps = { ..._deps, ...deps };
}

// idempotent — notification WS and session WS seed Ask tiles in either order.
// sessionId scopes the transcript scan + append to the correct session's slice
// (multi-live: background sessions can seed their own ask tiles).
export function ensureAskInlineTile({ toolInput, msgId, toolUseId }, sessionId) {
  const sid = sessionId ?? sessions.get().currentSessionId;
  if (!sid) return null;
  const slice = sessions.getSlice(sid);
  let entry = slice?.transcript.find((m) => m.role === 'ask' && m.answer == null);
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (entry) {
    if (toolUseId && !entry.toolUseId) {
      entry.toolUseId = toolUseId;
      approvals.registerPendingAsk(toolUseId, entry);
    }
    if (msgId && !entry.msgId) entry.msgId = msgId;
    if (qs.length > 0 && entry.questions.length === 0) entry.questions = qs;
    return entry;
  }
  entry = {
    role: 'ask',
    text: '',
    msgId,
    toolUseId,
    questions: qs,
    answer: null,
  };
  sessions.for(sid).appendTranscript(entry);
  if (toolUseId) approvals.registerPendingAsk(toolUseId, entry);
  return entry;
}

// The single submit path for both layouts (session-view passes its mount's
// sessionId explicitly; the approval's own sessionId covers every other
// caller) — scoping by session id rather than the mobile-only forCurrent()
// pointer so a background/cross-session ask resolves the right slice.
export function submitAskAnswer(approval, picks, replyText, sessionId = null) {
  const wire = buildAskAnswerWire(approval, picks, replyText);
  const sid = sessionId ?? approval.sessionId ?? sessions.get().currentSessionId;
  if (sid) {
    sessions.for(sid).mapTranscript((entry) =>
      entry.role === 'ask' && entry.answer == null ? { ...entry, answer: wire } : entry,
    );
  }
  if (approval.toolUseId) approvals.markTaskResultConsumed(approval.toolUseId);
  approvals.set((s) => ({ ...s, pendingAsks: new Map() }));
  _deps.decideApproval(approval.approvalId, 'deny', wire);
}

export function askApprovalCardHtml(a) {
  return sharedAskApprovalCardHtml(a, { formatCountdown: _deps.formatApprovalCountdown });
}

// Disk-replay path: convert a persisted `ask` message into an inline ask entry
// registered on the approvals store. `sink` is the caller's in-progress
// transcript array — we push into it rather than into the slice directly so
// the reconstructor can interleave with other transcript rebuild logic.
export function applyAskTranscriptMessage(m, sink) {
  if (m.role === 'tool_use' && m.toolName === 'AskUserQuestion') {
    const questions = Array.isArray(m.toolInput?.questions) ? m.toolInput.questions : [];
    const entry = {
      role: 'ask',
      text: '',
      msgId: m.msgId,
      toolUseId: m.toolUseId,
      questions,
      answer: null,
    };
    sink.push(entry);
    if (m.toolUseId) approvals.registerPendingAsk(m.toolUseId, entry);
    return true;
  }
  if (m.role === 'tool_result' && m.toolUseId && approvals.get().pendingAsks.has(m.toolUseId)) {
    const entry = approvals.get().pendingAsks.get(m.toolUseId);
    entry.answer = String(m.text ?? '');
    approvals.resolvePendingAsk(m.toolUseId);
    // without this, every visibilitychange replays already-answered Asks as raw tiles
    approvals.markTaskResultConsumed(m.toolUseId);
    return true;
  }
  return false;
}

// Answered-state transcript renderer. While pending, the ask lives in the
// inline approval card at the bottom of the transcript (askApprovalCardHtml);
// the ask transcript entry is filtered out by updateTranscriptRegion. Once
// the user submits, the approval drops off and this renders the answered card
// as a quiet editorial record.
export function askMsgHtml(m) {
  const questions = Array.isArray(m.questions) ? m.questions : [];
  const parsed = parseAskAnswer(m.answer, questions);
  return askAnsweredHtml(questions, parsed);
}

// Editorial pull-quote shape. The chosen answer is the visual hero (large,
// italic) with the question sitting above as a small mono kicker. No header
// label, no status badge, no arrow gutter: the layout itself signals "this
// is a resolved decision" without restating it in chrome.
function askAnsweredHtml(questions, parsed) {
  const multi = questions.length > 1;
  const rows = questions.map((q, i) => {
    const qText = compactWs(String(q?.question ?? ''));
    const a = parsed.answers[i] || '';
    const skipped = !a;
    const num = multi
      ? `<span class="ask-kicker-num">Q${i + 1}</span>`
      : '';
    const answerHtml = a
      ? escapeHtml(a)
      : `<span class="ask-msg-answer-empty">— no answer</span>`;
    return (
      `<div class="ask-msg-pair-answered${skipped ? ' ask-msg-pair-skipped' : ''}">` +
        `<div class="ask-msg-kicker">${num}${escapeHtml(qText)}</div>` +
        `<div class="ask-msg-answer-text">${answerHtml}</div>` +
      `</div>`
    );
  }).join('');

  const replyBlock = parsed.reply
    ? `<div class="ask-msg-reply"><div class="ask-msg-reply-label">Also added</div><div class="ask-msg-reply-text">${escapeHtml(parsed.reply)}</div></div>`
    : '';

  return (
    `<div class="msg ask ask-answered">` +
      `<div class="ask-msg-pairs">${rows}</div>` +
      replyBlock +
    `</div>`
  );
}

// Parse the various shapes that end up in entry.answer back into structured
// pairs + optional free-text reply. The pairs are matched onto the original
// questions array by text, so what shows up in the card lines up with the
// question it actually answers.
//
// Recognized inputs:
//   1. Canonical wire format ("Your questions have been answered: \"Q\"=\"A\", …
//      [. User also added: …]"). Native AskUserQuestion + new submitAskAnswer.
//   2. Legacy prefix ("[AskUserQuestion answer]\n…"). Pre-canonical
//      submitAskAnswer. Inside it we still parse "Q: …\nA: …" pairs and
//      "User reply: …" / "User chose: …".
//   3. Reply-only ("User replied: …"). Dismissed-via-text path.
//   4. Anything else — treat as a free-form reply.
function parseAskAnswer(answer, questions) {
  if (!answer) return { answers: new Array(questions.length).fill(''), reply: '' };
  const raw = String(answer).trim();

  const placeAnswers = (pairs) => {
    const out = new Array(questions.length).fill('');
    for (const { q, a } of pairs) {
      const idx = questions.findIndex((qq) => String(qq?.question ?? '') === q);
      if (idx >= 0) out[idx] = a;
      else if (questions.length === 1 && out[0] === '') out[0] = a;
    }
    return out;
  };

  const canonical = /^Your questions have been answered:\s*(.+?)(?:\.\s*User also added:\s*([\s\S]+))?$/.exec(raw);
  if (canonical) {
    const pairs = [];
    const re = /"([^"]*)"="([^"]*)"/g;
    let p;
    while ((p = re.exec(canonical[1])) !== null) pairs.push({ q: p[1], a: p[2] });
    return { answers: placeAnswers(pairs), reply: (canonical[2] ?? '').trim() };
  }

  const legacy = /^\[AskUserQuestion answer\]\s*\n?([\s\S]*)$/.exec(raw);
  if (legacy) {
    const body = legacy[1].trim();
    const blocks = body.split(/\n\s*\n/);
    const pairs = [];
    let reply = '';
    for (const block of blocks) {
      const trimmed = block.trim();
      const qa = /^Q:\s*([\s\S]+?)\nA:\s*([\s\S]+)$/.exec(trimmed);
      if (qa) { pairs.push({ q: qa[1].trim(), a: qa[2].trim() }); continue; }
      const chose = /^User chose:\s*([\s\S]+)$/.exec(trimmed);
      if (chose && questions.length === 1) {
        pairs.push({ q: String(questions[0]?.question ?? ''), a: chose[1].trim() });
        continue;
      }
      const rep = /^User repl(?:y|ied):\s*([\s\S]+)$/.exec(trimmed);
      if (rep) { reply = rep[1].trim(); continue; }
    }
    return { answers: placeAnswers(pairs), reply };
  }

  const replyOnly = /^User repl(?:y|ied):\s*([\s\S]+)$/.exec(raw);
  if (replyOnly) {
    return { answers: new Array(questions.length).fill(''), reply: replyOnly[1].trim() };
  }

  return { answers: new Array(questions.length).fill(''), reply: raw };
}
