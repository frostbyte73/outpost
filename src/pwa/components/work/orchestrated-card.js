// The body of an `orchestrated` timeline step — a controller action that owns the step
// and picks one move per turn. step-card.js mounts this inside the step's `.tl-content`
// (both layouts; mobile arranges the same renderer), so the title/description/time header
// and the failure callout stay with the timeline and are not repeated here.
//
// Three bands, in the order a reader walks them: what this step IS → where the work STANDS →
// what is happening and what you'd say about it. The last band ends at the bottom edge of the
// card, and that is the whole point of the arrangement.
//
// 1. IDENTITY — which controller, which repo. One row.
// 2. RECORD (`.orc-record`) — the PR block, settled dispatches, the trail strip. State that
//    accumulates: you scan it, you rarely act in it.
// 3. LIVE — anything holding for your approval → the controller's own feed, which streams
//    while it's working and states its status once it parks → the box you answer it in.
//
// The live band used to sit ABOVE the record, which put a growing feed and its composer on
// the far side of a PR block that is itself hundreds of pixels of threads and checks. Every
// glance at "what is it saying now" and every reply meant scrolling back up past all of it,
// then back down to check CI. Bottom-anchoring the live band means the newest thing to read
// and the only thing to type in are both where the scroll already ends — one destination,
// not two. The card owns the session mount itself (step-card.js renders it only for
// non-orchestrated steps) precisely so the composer can sit directly under the feed.
//
// The trail is the last thing in the record band, so the transition into the live band is one
// quiet strip of chips rather than the tail of a comment thread. Six artifacts used to stack
// as six sibling disclosures, each with its own label row and caret, at ~190px before a
// single one was opened; they're now one strip that opens one body at a time.
//
// Everything is still its own stacked row. Never one crammed eyebrow line.

import { work } from '../../state/work.js';
import { settings } from '../../state/settings.js';
import { orchestratedRows } from '../../vm/tracked.js';
import { actionCategory, actionDisplayName, actionIconHtml } from './action-icon.js';
import { hasPrBlock, renderPrBlockHtml, wirePrBlockActions } from './pr-block.js';
import { renderAutoApprovedDraft, renderWriteDraft, wireWriteDraft } from './write-draft-card.js';
import { readPreapprovalsControl, renderPreapprovalsControl, wirePreapprovalsControl, clearPreapprovalsScope } from './preapprovals-control.js';
import { effective, summaryLabel } from '../../vm/preapprovals.js';
import { isReplyDraft } from './reply-draft.js';
import { renderMarkdown } from '../../markdown.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';
import { openSession } from '../../app-bridge.js';
import { shortName } from '../../utils/formatting.js';
import { stepFeedHtml } from './wheel-toggle.js';
import {
  controllerGateHtml, controllerGateActionsHtml, controllerComposerHtml,
  artifactTrailHtml, wireArtifactTrail, wireControllerControls,
} from './controller-controls.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
// The trail's chips carry DOM ids so they can point `aria-controls` at their bodies, and a
// step id is only guaranteed to be a string. Same defence as vm/tracked.js's slugOf.
function domId(s) { return String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_'); }

// pr-block.js reads the flat shape the deleted `open-pr` step had: PR facts at the top
// level and the old state vocabulary. The facts are unchanged — only where they hang —
// so adapt here rather than fork the block. Only the one phase pr-block still branches
// on is mapped; every other phase stays blank (`implement` used to map too, purely to
// retitle the removed review banner). Spec/implPlan deliberately do NOT get mapped: the
// card renders every artifact once, in the trail strip.
const PR_BLOCK_STATE = { merged: 'merged' };
const PRE_PR_PHASES = new Set(['spec', 'plan']);

function prView(s) {
  return {
    ...s,
    ...(s.pr ?? {}),
    state: PR_BLOCK_STATE[s.phase] ?? '',
  };
}

// `phase` is only written once the controller reports its first move, so an unset phase is
// still pre-PR — without that guard a just-created step shows a Discard CTA for work that
// doesn't exist yet.
function orchestratedHasPrBlock(s) {
  if (!s.phase || PRE_PR_PHASES.has(s.phase)) return false;
  return hasPrBlock(prView(s));
}

// Row 1 of the live tier: identity — which controller, which repo — on the `.tl-ident` row
// an `action` step also renders (step-card.js), same position and same category-colored
// chip, so the two step types agree about where a step says what it is. Identity only: state
// belongs to the status line below it and to the PR block. This used to render BELOW the
// transcript tail, so you read what the controller was saying before you knew which
// controller was saying it.
//
// The step's own overflow (Mark resolved) rides on the right of this row rather than as a
// full-width button under the whole card: `.tl-hdr` can't take it — it already reserves
// 110px for the plan editor's ▲▼✎× toolbar. On desktop `.o-menu` is `display: contents`
// (primitives.css), so this is a flat right-aligned ghost button there and a real ⋯
// dropdown on mobile.
function metaRowHtml(s, vm) {
  const bits = [];
  if (s.controller) {
    bits.push(`<span class="type-mono" data-cat="${escapeHtml(actionCategory(s.controller))}">${escapeHtml(actionDisplayName(s.controller))}</span>`);
  }
  // The repo, same as an action step names it. This slot used to hold the phase pill, which
  // restated the PR block one row below — see statusLineOf in vm/tracked.js for where the
  // phase went and why it's still reachable.
  if (s.workspace?.repoCwd) {
    bits.push(`<span class="tl-ident-repo">${escapeHtml(shortName(s.workspace.repoCwd))}</span>`);
  }
  // The PR block carries the branch in its own stats row; only name it here when there
  // isn't one yet (spec/plan phases), so the workspace is never invisible.
  if (!orchestratedHasPrBlock(s) && s.workspace?.branch) {
    bits.push(`<span class="o-pill code">${escapeHtml(s.workspace.branch)}</span>`);
  }
  const menu = overflowHtml(vm);
  if (!bits.length && !menu) return '';
  return `<div class="tl-ident">${bits.join('')}<span class="tl-ident-spacer"></span>${menu}</div>`;
}

function preapprovalsHtml(job, s) {
  if (s.state === 'resolved' || s.state === 'failed' || s.cancelled) return '';
  const value = effective(settings.get().preapprovalDefaults, job?.preapprovals, s.preapprovals);
  return `
    <details class="orc-preapprovals orc-preapprovals-${domId(s.id)}">
      <summary><span class="o-microhead">Pre-approvals</span> <span class="orc-preapprovals-label">${escapeHtml(summaryLabel(value))}</span></summary>
      <div class="orc-preapprovals-body">
        ${renderPreapprovalsControl(value, { name: s.id })}
        <div class="step-actions">
          <button type="button" class="o-btn o-btn--primary" data-orc-preapprovals="save">Save</button>
        </div>
      </div>
    </details>`;
}

// Only the daemon's own approvals: the user already saw every draft they approved by hand.
function autoApprovedHtml(s) {
  const auto = (s.drafts ?? []).filter((d) => d.approvedBy === 'preapproval');
  return auto.map(renderAutoApprovedDraft).join('');
}

function overflowHtml(vm) {
  if (!vm.canMarkResolved) return '';
  const { label, hint } = vm.markResolved;
  return `
    <div class="o-menu">
      <button type="button" class="o-btn o-btn--ghost sm o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
      <div class="o-menu-body" hidden>
        <button class="o-btn o-btn--ghost sm" data-orc-action="mark-resolved"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${escapeHtml(label)}</button>
      </div>
    </div>`;
}

// A running dispatch IS the implementor session, and its row used to offer exactly one way to
// find out what it was doing: "Open ↗". So a controller that had fanned the work out showed a
// static brief written at dispatch time, for however long the child took. The child gets its
// own feed here for the same reason the controller has one — syncInlineMounts keys purely on
// sessionId across the whole rendered tree at any depth, so this needs no new plumbing, only
// the mount. Only while it is running: a settled dispatch's row is record, and mounting a
// finished child would make the daemon respawn its long-reaped subprocess (see the terminal
// guard in mountInlineSession).
function dispatchFeedHtml(d) {
  if (d.status !== 'running' || !d.sessionId) return '';
  return `<div class="orc-dispatch-feed step-inline-session-mount" data-session-id="${escapeHtml(d.sessionId)}"></div>`;
}

// A brief is the child's ENTIRE context — `code.orchestrate-pr`'s SKILL.md tells the
// controller to write one that stands alone, so these run past 10k characters of markdown.
// The row rendered it raw and uncollapsed, which buried the whole card under one dispatch.
//
// The body is filled on open rather than at paint: a collapsed <details> still costs its full
// markup in every repaint's innerHTML, and the drill-in rebuilds several times a minute on a
// live job (same reason the PR-comment hunks render 20 rows and not the rest).
function briefHtml(d) {
  if (!d.brief) return '';
  return `
    <details class="orc-dispatch-brief" data-brief="${escapeHtml(d.id)}" data-details-key="orc-brief-${escapeHtml(d.id)}">
      <summary><span class="orc-dispatch-brief-lead">${escapeHtml(briefLead(d.brief))}</span></summary>
      <div class="orc-dispatch-brief-body md-body" data-brief-body></div>
    </details>`;
}

// Controllers open a brief with a one-sentence statement of the job before the **PR:** /
// **Base branch:** block, so the first non-empty line is the summary line worth showing.
function briefLead(brief) {
  const line = brief.split('\n').find((l) => l.trim()) ?? '';
  const flat = line.replace(/[*_`#>]/g, '').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

function dispatchRowHtml(d) {
  const cat = actionCategory(d.action);
  return `
    <div class="orc-dispatch" data-dispatch-id="${escapeHtml(d.id)}">
      <span class="orc-dispatch-icon" data-cat="${escapeHtml(cat)}">${actionIconHtml(cat)}</span>
      <span class="type-mono" data-cat="${escapeHtml(cat)}">${escapeHtml(actionDisplayName(d.action))}</span>
      <span class="o-pill ${escapeHtml(d.tone)}">${escapeHtml(d.status)}</span>
      ${d.sessionId
        ? `<button type="button" class="o-btn o-btn--ghost sm orc-dispatch-open" data-orc-session="${escapeHtml(d.sessionId)}">Open ↗</button>`
        : ''}
      ${briefHtml(d)}
      ${d.failure ? `<div class="orc-dispatch-failure">${escapeHtml(d.failure)}</div>` : ''}
      ${dispatchFeedHtml(d)}
      ${d.draft ? renderWriteDraft(d.draft) : ''}
    </div>`;
}

function dispatchesHtml(vm) {
  if (!vm.dispatchRows.length) return '';
  return `
    <div class="orc-dispatches">
      <div class="o-microhead">Dispatched</div>
      ${vm.dispatchRows.map(dispatchRowHtml).join('')}
    </div>`;
}

// A dispatch that raised its own write draft is parked on YOU, but the draft renders inside
// the dispatch's row (never hoisted to the controller's gate — see vm/tracked.js). So when
// one is pending, the whole dispatch list moves up into the hold band with the gate; the
// rest of the time it reads as process record and sits below the feed.
function dispatchesAreHolding(vm) {
  return vm.dispatchRows.some((d) => !!d.draft);
}

// A pending `code.reply-pr-comments` draft belongs in the PR block, one field per comment
// thread, not in a generic approval card stacked below it — the threads are the only place the
// replies mean anything. Only when the block is actually rendered: with no PR block there is
// nowhere for the threads to go, and the generic card is still the honest fallback.
function replyDraftFor(step, vm) {
  return orchestratedHasPrBlock(step) && isReplyDraft(vm.controllerDraft) ? vm.controllerDraft : null;
}

// The controller's feed sits second-to-last rather than being left to step-card.js (which still
// owns it for every other step type) so the composer can follow immediately after the tail it
// answers. syncInlineMounts keys purely on sessionId across the whole rendered tree, so the
// mount works identically wherever in the step it lands — it just has to appear exactly once.
export function renderOrchestratedCard(step, { job } = {}) {
  const vm = orchestratedRows(step);
  const replyDraft = replyDraftFor(step, vm);
  const dispatches = dispatchesHtml(vm);
  const holding = dispatchesAreHolding(vm);
  const record = `
    ${orchestratedHasPrBlock(step) ? renderPrBlockHtml(job, prView(step), { replyDraft }) : ''}
    ${holding ? '' : dispatches}
    ${artifactTrailHtml(step, vm)}`;
  return `
    <div class="orc-card">
      ${metaRowHtml(step, vm)}
      ${preapprovalsHtml(job, step)}
      ${record.trim() ? `<div class="orc-record">${record}</div>` : ''}
      ${autoApprovedHtml(step)}
      ${controllerGateHtml(vm)}
      ${controllerGateActionsHtml(vm)}
      ${vm.controllerDraft && !replyDraft ? renderWriteDraft(vm.controllerDraft) : ''}
      ${holding ? dispatches : ''}
      ${stepFeedHtml(job, step)}
      ${controllerComposerHtml(step)}
    </div>`;
}

// restoreUi re-opens a <details> by assigning `open`, which fires `toggle` the same as a
// click, so a brief the user had open refills itself after a repaint.
function wireBriefs(card, vm) {
  vm.dispatchRows.forEach((d) => {
    if (!d.brief) return;
    const el = card.querySelector(`[data-brief="${CSS.escape(d.id)}"]`);
    const body = el?.querySelector('[data-brief-body]');
    if (!body) return;
    el.addEventListener('toggle', () => {
      if (el.open && !body.innerHTML) body.innerHTML = renderMarkdown(d.brief);
    });
  });
}

function wireStepPreapprovals(card, job, step) {
  const scope = `step:${job.id}:${step.id}`;
  wirePreapprovalsControl(card, scope);
  card.querySelector('[data-orc-preapprovals="save"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const fs = card.querySelector('.orc-preapprovals fieldset.o-preapprovals');
    if (!fs) return;
    void work.setStepPreapprovals(job.id, step.id, readPreapprovalsControl(fs))
      .then(() => clearPreapprovalsScope(scope));
  });
}

export function wireOrchestratedCard(el, step, { job } = {}) {
  const card = el.querySelector('.orc-card');
  if (!card) return;
  const vm = orchestratedRows(step);
  if (orchestratedHasPrBlock(step)) {
    wirePrBlockActions(card, job, prView(step), { replyDraft: replyDraftFor(step, vm) });
  }
  wireOverflowMenu(card);
  wireArtifactTrail(card);
  wireControllerControls(card, job, step);
  wireStepPreapprovals(card, job, step);
  wireBriefs(card, vm);

  // The controller's own draft and each dispatch's are self-contained cards (their own
  // Accept/Propose changes/Deny) — wireWriteDraft finds its own markup by draft id inside
  // this card, same as any other draft mount point. That holds for a reply draft too: it
  // renders inside the PR block rather than below it, but it's the same `.wd-card` contract,
  // so nothing here needs to know where the markup ended up.
  if (vm.controllerDraft) wireWriteDraft(card, { jobId: job.id, stepId: step.id, draft: vm.controllerDraft });
  vm.dispatchRows.forEach((d) => {
    if (d.draft) wireWriteDraft(card, { jobId: job.id, stepId: step.id, draft: d.draft });
  });

  card.querySelectorAll('[data-orc-session]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSession({ id: btn.getAttribute('data-orc-session'), fromTicketId: job.id });
    });
  });

  card.querySelectorAll('[data-orc-action="mark-resolved"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void work.markStepResolved(job.id, step.id);
    });
  });
}
