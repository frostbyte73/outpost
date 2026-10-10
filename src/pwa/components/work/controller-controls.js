// The controller-facing controls of an orchestrated step — its voluntary gate, the "message the
// controller" box, and the artifact trail — shared by the Tracked step card and the cockpit board.

import { work } from '../../state/work.js';
import { renderMarkdown } from '../../markdown.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
// The trail's chips carry DOM ids so they can point `aria-controls` at their bodies, and a
// step id is only guaranteed to be a string. Same defence as vm/tracked.js's slugOf.
function domId(s) { return String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_'); }

// The controller parked its move behind an approval: the exact payload it will run
// verbatim on approval, the question it asked, and any feedback already sent this round.
export function controllerGateHtml(vm) {
  if (!vm.gate) return '';
  const feedback = vm.gate.feedback
    .map((f) => `<div class="tl-gate-feedback">↩ ${escapeHtml(f)}</div>`)
    .join('');
  return `
    <div class="tl-gate">
      <div class="tl-gate-head">⚠ ${escapeHtml(vm.gate.question || 'Approve before this move runs')}</div>
      ${vm.gate.draft
        ? `<div class="tl-gate-body md-body">${renderMarkdown(vm.gate.draft)}</div>`
        : '<div class="tl-gate-body muted">Drafting…</div>'}
      ${feedback ? `<div class="tl-gate-feedbacks">${feedback}</div>` : ''}
    </div>`;
}

export function controllerGateActionsHtml(vm) {
  if (!vm.gate) return '';
  // The verdict is picked at SUBMIT, never inferred from which box you typed in. The composer
  // used to have one Submit that always sent `approved: false`, so it was the only way to
  // answer a gate in words at all — a user typing "go ahead and run it" into it recorded a
  // decline, and the controller had to guess which half to believe (it guessed right, then
  // journalled the contradiction). Two submits, one textarea: an approval with a note is now
  // sayable, and a decline can't be typed by accident.
  return `
    <div class="step-actions">
      <button class="o-btn o-btn--primary" data-orc-action="approve-gate">Approve</button>
      <button class="o-btn o-btn--default" data-orc-action="toggle-gate-feedback">Respond…</button>
      <div class="thread-composer" data-composer="orc-gate-feedback" hidden>
        <textarea class="thread-compose-input" data-autogrow placeholder="A note for the controller — then pick a verdict below."></textarea>
        <div class="thread-composer-row">
          <button class="o-btn o-btn--primary" data-orc-action="approve-gate-note" disabled>Approve with this note</button>
          <button class="o-btn o-btn--default" data-orc-action="submit-gate-feedback" disabled>Request changes</button>
        </div>
      </div>
    </div>`;
}

// Steering a live controller: the message lands in its inbox and wakes it on the next
// tick, so it's the lever for a step that's waiting rather than gated. A settled step
// has nothing to wake.
//
// One line tall at rest, growing with what's typed (utils/autogrow.js), and the Send row
// only appears once there's something to send. The box was previously a permanently-open
// 76px textarea plus a button row on every live orchestrated step in the timeline.
export function controllerComposerHtml(s) {
  if (s.cancelled || s.state === 'resolved' || s.state === 'failed') return '';
  return `
    <div class="thread-composer orc-msg" data-composer="orc-message">
      <textarea class="thread-compose-input" rows="1" data-autogrow placeholder="Message the controller…"></textarea>
      <div class="thread-composer-row">
        <button class="o-btn o-btn--default" data-orc-action="send-message">Send</button>
      </div>
    </div>`;
}

// The record tier's signature: the controller's memo and every artifact it has reported, as
// one strip of chips in the order they were produced, with one body open at a time. Reading
// two artifacts side by side was never possible anyway (they're full-width prose), so
// exclusivity costs nothing and buys back the five stacked label rows.
//
// Plain buttons rather than <details>: an exclusive native accordion needs `<details name>`,
// and detail.js's repaint-survival snapshot only knows about `<details>` and `[data-composer]`
// — the open chip is carried across repaints explicitly instead (snapshotUi/restoreUi).
export function artifactTrailHtml(step, vm) {
  if (!vm.artifactRows.length) return '';
  const base = `orc-trail-${domId(step.id)}`;
  const chips = vm.artifactRows.map((a) => `
    <button type="button" class="orc-trail-chip" data-trail-chip="${escapeHtml(a.slug)}"
            aria-expanded="false" aria-controls="${base}-${escapeHtml(a.slug)}">
      ${escapeHtml(a.label)}${a.latest ? '<span class="orc-trail-dot" aria-hidden="true"></span>' : ''}
    </button>`).join('');
  const bodies = vm.artifactRows.map((a) => `
    <div class="orc-trail-body" id="${base}-${escapeHtml(a.slug)}" data-trail-body="${escapeHtml(a.slug)}" hidden>
      <div class="step-findings md-body">${renderMarkdown(a.body)}</div>
    </div>`).join('');
  return `
    <div class="orc-trail" data-trail>
      <span class="orc-trail-caret" aria-hidden="true">▸</span>
      ${chips}
      ${bodies}
    </div>`;
}

// One artifact body open at a time. `slug` of null closes everything (re-clicking the open
// chip), which is also the state every repaint starts in — restoreUi re-clicks the chip the
// user had open.
function openTrail(trail, slug) {
  trail.querySelectorAll('[data-trail-chip]').forEach((c) => {
    const on = c.getAttribute('data-trail-chip') === slug;
    c.classList.toggle('is-open', on);
    c.setAttribute('aria-expanded', String(on));
  });
  trail.querySelectorAll('[data-trail-body]').forEach((b) => {
    b.toggleAttribute('hidden', b.getAttribute('data-trail-body') !== slug);
  });
  trail.classList.toggle('is-open', slug != null);
}

export function wireArtifactTrail(root) {
  const trail = root.querySelector('[data-trail]');
  if (!trail) return;
  trail.querySelectorAll('[data-trail-chip]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrail(trail, chip.classList.contains('is-open') ? null : chip.getAttribute('data-trail-chip'));
    });
  });
}

const CONTROL_ACTIONS = new Set(['approve-gate', 'toggle-gate-feedback', 'approve-gate-note', 'submit-gate-feedback', 'send-message']);

export function wireControllerControls(root, job, step) {
  root.querySelectorAll('[data-orc-action]').forEach((btn) => {
    const kind = btn.getAttribute('data-orc-action');
    if (!CONTROL_ACTIONS.has(kind)) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (kind === 'approve-gate') {
        void work.resolveStepGate(job.id, step.id, true);
      } else if (kind === 'toggle-gate-feedback') {
        root.querySelector('[data-composer="orc-gate-feedback"]')?.toggleAttribute('hidden');
      } else if (kind === 'approve-gate-note' || kind === 'submit-gate-feedback') {
        const ta = root.querySelector('[data-composer="orc-gate-feedback"] textarea');
        const feedback = (ta?.value ?? '').trim();
        if (!feedback) { ta?.focus(); return; }
        void work.resolveStepGate(job.id, step.id, kind === 'approve-gate-note', feedback);
      } else {
        const ta = root.querySelector('[data-composer="orc-message"] textarea');
        const body = (ta?.value ?? '').trim();
        if (!body) { ta?.focus(); return; }
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        void work.messageStep(job.id, step.id, body);
      }
    });
  });

  // The message composer's Send row is revealed by `:focus-within` while you're in the box;
  // `is-open` is what keeps it reachable once focus leaves with text still in there.
  const msg = root.querySelector('[data-composer="orc-message"]');
  const msgInput = msg?.querySelector('textarea');
  if (msg && msgInput) {
    const sync = () => msg.classList.toggle('is-open', !!msgInput.value.trim());
    msgInput.addEventListener('input', sync);
    sync();
  }

  // Both gate verdicts need a note, so neither is clickable until there is one — same rule the
  // write-draft card's revise/deny composers use.
  const gateNote = root.querySelector('[data-composer="orc-gate-feedback"] textarea');
  if (gateNote) {
    const verdicts = root.querySelectorAll('[data-orc-action="approve-gate-note"], [data-orc-action="submit-gate-feedback"]');
    const sync = () => verdicts.forEach((b) => { b.disabled = !gateNote.value.trim(); });
    gateNote.addEventListener('input', sync);
    sync();
  }
}
