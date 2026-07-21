import { work } from '../../state/work.js';
import { renderMarkdown } from '../../markdown.js';
import { wireOverflowMenu } from '../../utils/overflow-menu.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function initials(name) {
  const s = String(name ?? '').trim();
  if (!s) return '?';
  const parts = s.split(/[-_\s]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function relTime(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderDiffHunk(hunk) {
  return String(hunk).split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'hunk-add'
      : line.startsWith('-') ? 'hunk-del'
      : line.startsWith('@@') ? 'hunk-hdr'
      : 'hunk-ctx';
    return `<span class="${cls}">${escapeHtml(line) || ' '}</span>`;
  }).join('');
}

function stripHtmlComments(body) {
  return String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function groupThreads(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = [];
  const childrenOf = new Map();
  for (const c of comments) {
    if (c.inReplyTo && byId.has(c.inReplyTo)) {
      const arr = childrenOf.get(c.inReplyTo) ?? [];
      arr.push(c);
      childrenOf.set(c.inReplyTo, arr);
    } else {
      roots.push(c);
    }
  }
  const out = [];
  for (const root of roots) {
    const chain = [root];
    const queue = [...(childrenOf.get(root.id) ?? [])];
    while (queue.length) {
      const next = queue.shift();
      chain.push(next);
      queue.push(...(childrenOf.get(next.id) ?? []));
    }
    chain.sort((a, b) => a.createdAt - b.createdAt);
    out.push(chain);
  }
  return out;
}

const REACTIONS = [
  ['THUMBS_UP', '👍'],
  ['THUMBS_DOWN', '👎'],
  ['LAUGH', '😄'],
  ['HOORAY', '🎉'],
  ['CONFUSED', '😕'],
  ['HEART', '❤️'],
  ['ROCKET', '🚀'],
  ['EYES', '👀'],
];
const REACTION_EMOJI = Object.fromEntries(REACTIONS);

function reactionsStrip(chain) {
  const root = chain[0];
  const have = root.userReactions ?? [];
  const chips = have.map((c) => `<span class="thread-reaction-chip" title="${escapeHtml(c)}">${REACTION_EMOJI[c] ?? '?'}</span>`).join('');
  const picker = REACTIONS.map(([code, emoji]) => `
    <button class="thread-reaction-pick" type="button" data-react="${code}" aria-label="React ${escapeHtml(code)}">${emoji}</button>
  `).join('');
  return `
    <div class="thread-reactions" data-root-id="${escapeHtml(root.id)}">
      <div class="thread-reaction-chips">${chips}</div>
      <button class="thread-reaction-add" type="button" data-action="toggle-react-picker" aria-label="Add reaction">+</button>
      <div class="thread-reaction-picker" hidden>${picker}</div>
    </div>
  `;
}

function recPill(rec) {
  if (!rec) return '';
  const labels = { reply: 'Reply', edit: 'Edit', ignore: 'Ignore' };
  return `<span class="thread-rec thread-rec-${rec}">${labels[rec]}</span>`;
}

function confidencePill(confidence) {
  if (!confidence) return '';
  return `<span class="thread-confidence thread-confidence-${confidence}">confidence: ${escapeHtml(confidence)}</span>`;
}

// Mobile collapses to 3 primary actions (Reply / Edit / Ignore — every real
// resolution stays one tap away, so an 'ignore' recommendation's highlight is
// always visible) + a ⋯ overflow holding Regenerate. Desktop is unaffected:
// `.o-menu`'s `display: contents` (primitives.css) keeps Regenerate inline in
// the same flat row — same DOM, chrome-only divergence (D2).
function actionRow(draft, resolved, canReopen) {
  // A resolved thread's draft was dropped on resolution, so there's nothing to
  // Reply/Edit/Ignore — the one useful action is pulling it back for another
  // pass, which reuses the regenerate path (reopens the comment + re-triages).
  if (resolved) {
    const disabled = canReopen ? '' : 'disabled';
    return `
    <div class="thread-actions thread-actions-resolved">
      <button class="o-btn o-btn--default thread-action-reopen" data-thread-action="regenerate" ${disabled}>Reopen</button>
    </div>
  `;
  }
  const rec = draft?.recommendation;
  const cls = (k) => `o-btn ${rec === k ? 'o-btn--primary' : 'o-btn--default'} thread-action-${k}`;
  const disabled = draft ? '' : 'disabled';
  return `
    <div class="thread-actions">
      <button class="${cls('reply')}" data-thread-action="open-reply" ${disabled}>Reply</button>
      <button class="${cls('edit')}"  data-thread-action="open-edit"  ${disabled}>Edit</button>
      <button class="${cls('ignore')}" data-thread-action="open-ignore" ${disabled}>Ignore</button>
      <div class="o-menu">
        <button type="button" class="o-btn o-btn--ghost o-menu-toggle" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
        <div class="o-menu-body" hidden>
          <button class="o-btn o-btn--ghost thread-action-regenerate" data-thread-action="regenerate" ${disabled}
            data-draft-comment-id="${escapeHtml(draft?.commentId ?? '')}">Regenerate</button>
        </div>
      </div>
    </div>
  `;
}

function replyComposer(draft) {
  return `
    <div class="thread-composer thread-composer-reply" data-composer="reply" hidden>
      <textarea class="thread-compose-input" data-autogrow placeholder="Reply…">${escapeHtml(draft?.draftReply ?? '')}</textarea>
      <div class="thread-composer-row">
        <button class="o-btn o-btn--primary" data-thread-action="post-reply">Post reply</button>
      </div>
    </div>
  `;
}

function editComposer(activeJob) {
  if (activeJob) {
    // Running with a spawned session → live tail. Queued (pre-spawn) or a stray
    // running row without a sessionId → keep the pulsing status chip.
    const inner = activeJob.sessionId && activeJob.status === 'running'
      ? `<div class="step-inline-session-mount" data-session-id="${escapeHtml(activeJob.sessionId)}" data-edit-id="${escapeHtml(activeJob.id)}"></div>`
      : `<span class="thread-edit-status">${activeJob.status === 'queued' ? 'queued' : 'editing…'}</span>`;
    return `
      <div class="thread-composer thread-composer-edit thread-composer-status" data-composer="edit">
        ${inner}
        ${activeJob.failure ? `<span class="thread-edit-failure">${escapeHtml(activeJob.failure)}</span>` : ''}
      </div>
    `;
  }
  return `
    <div class="thread-composer thread-composer-edit" data-composer="edit" hidden>
      <textarea class="thread-compose-input" data-autogrow placeholder="Optional note for the implementer…"></textarea>
      <div class="thread-composer-row">
        <button class="o-btn o-btn--primary" data-thread-action="run-edit">Run edit</button>
      </div>
    </div>
  `;
}

function ignoreComposer() {
  return `
    <div class="thread-composer thread-composer-ignore" data-composer="ignore" hidden>
      <p class="thread-ignore-note">Mark resolved internally — no GitHub change.</p>
      <button class="o-btn o-btn--primary" data-thread-action="confirm-ignore">Confirm</button>
    </div>
  `;
}

export function renderThreadCard(chain, draft, sub) {
  const root = chain[0];
  const leaf = chain[chain.length - 1];
  const loc = root.file ? (root.line ? `${root.file}:${root.line}` : root.file) : 'general comment';
  const chainIds = new Set(chain.map((c) => c.id));
  const activeJob = (sub.editQueue ?? []).find((j) =>
    chainIds.has(j.commentId) && (j.status === 'queued' || j.status === 'running'),
  );
  const reopened = root.reopenedAt && !root.respondedAt;
  const resolved = !!leaf.respondedAt;
  const canReopen = !(sub.state === 'merged' || sub.prState === 'merged');
  const userLocked = draft?.userEdited;
  const recClass = draft?.recommendation ? ` thread-has-${draft.recommendation}` : ' thread-has-pending';
  return `
    <li class="thread${recClass}" data-comment-id="${escapeHtml(leaf.id)}">
      <article class="thread-card">
        <header class="thread-header">
          <span class="thread-loc">${escapeHtml(loc)}</span>
          <span class="thread-author">${escapeHtml(root.author ?? 'unknown')}</span>
          <span class="thread-time">${escapeHtml(relTime(root.createdAt))}</span>
          ${recPill(draft?.recommendation)}
          ${confidencePill(draft?.confidence)}
        </header>
        ${root.diffHunk ? `<pre class="thread-hunk">${renderDiffHunk(root.diffHunk)}</pre>` : ''}
        ${chain.map((c) => `
          <div class="thread-msg">
            <div class="thread-msg-head">
              <span class="thread-avatar">${escapeHtml(initials(c.author))}</span>
              <span class="thread-author">${escapeHtml(c.author ?? 'unknown')}</span>
              <span class="thread-msg-meta">${escapeHtml(relTime(c.createdAt))}</span>
            </div>
            <div class="thread-msg-body markdown">${renderMarkdown(stripHtmlComments(c.body), { allowHtml: true })}</div>
          </div>
        `).join('')}
        ${reactionsStrip(chain)}
        ${draft
          ? `<p class="thread-rationale">${escapeHtml(draft.rationale || '')}</p>`
          : resolved ? '' : `<p class="thread-rationale thread-rationale-pending">Claude is deciding…</p>`}
        ${reopened ? `<p class="thread-banner thread-banner-reopened">New reply after you marked this resolved — re-evaluated.</p>` : ''}
        ${userLocked ? `<p class="thread-banner thread-banner-locked">New activity — discard your draft to re-evaluate.</p>` : ''}
        ${actionRow(draft, resolved, canReopen)}
        ${replyComposer(draft)}
        ${editComposer(activeJob)}
        ${ignoreComposer()}
      </article>
    </li>
  `;
}

export function wireThreadCard(el, ticket, sub) {
  const commentId = el.getAttribute('data-comment-id');
  const replyTa = el.querySelector('.thread-composer-reply textarea');
  const editTa = el.querySelector('.thread-composer-edit textarea');
  const showComposer = (kind) => {
    el.querySelectorAll('[data-composer]').forEach((c) => {
      if (c.classList.contains('thread-composer-status')) return;
      c.toggleAttribute('hidden', c.getAttribute('data-composer') !== kind);
    });
  };
  el.querySelector('[data-thread-action="open-reply"]')?.addEventListener('click', () => showComposer('reply'));
  el.querySelector('[data-thread-action="open-edit"]')?.addEventListener('click', () => showComposer('edit'));
  el.querySelector('[data-thread-action="open-ignore"]')?.addEventListener('click', () => showComposer('ignore'));
  // Shared by the open thread's Regenerate (overflow menu) and the resolved
  // thread's Reopen — both re-draft via regenerateReply; only the label differs.
  el.querySelector('[data-thread-action="regenerate"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = label === 'Reopen' ? 'Reopening…' : 'Regenerating…';
    const targetId = btn.getAttribute('data-draft-comment-id') || commentId;
    try {
      await work.regenerateReply(ticket.id, sub.id, { commentId: targetId });
      // Redrafted reply arrives via the work WS snapshot; the repaint replaces
      // this card (its pending row shows "Claude is deciding…" meanwhile).
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      alert(`${label} failed: ${err?.message ?? err}`);
    }
  });
  wireOverflowMenu(el);

  if (replyTa) {
    let locked = false;
    replyTa.addEventListener('input', () => {
      if (locked) return;
      locked = true;
      void work.lockReply(ticket.id, sub.id, { commentId, edited: true });
    });
  }

  el.querySelector('[data-thread-action="post-reply"]')?.addEventListener('click', () => {
    const body = (replyTa?.value ?? '').trim();
    if (!body) { replyTa?.focus(); return; }
    void work.resolveReply(ticket.id, sub.id, { commentId, action: 'approve', body });
  });
  el.querySelector('[data-thread-action="run-edit"]')?.addEventListener('click', () => {
    const userNote = (editTa?.value ?? '').trim();
    void work.enqueueEdit(ticket.id, sub.id, { commentId, userNote: userNote || undefined });
  });
  el.querySelector('[data-thread-action="confirm-ignore"]')?.addEventListener('click', () => {
    void work.resolveReply(ticket.id, sub.id, { commentId, action: 'ignore' });
  });

  const reactWrap = el.querySelector('.thread-reactions');
  const rootCommentId = reactWrap?.getAttribute('data-root-id');
  reactWrap?.querySelector('[data-action="toggle-react-picker"]')?.addEventListener('click', () => {
    const picker = reactWrap.querySelector('.thread-reaction-picker');
    if (picker) picker.toggleAttribute('hidden');
  });
  reactWrap?.querySelectorAll('[data-react]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const content = btn.getAttribute('data-react');
      if (!content || !rootCommentId) return;
      btn.disabled = true;
      const picker = reactWrap.querySelector('.thread-reaction-picker');
      if (picker) picker.setAttribute('hidden', '');
      void work.react(ticket.id, sub.id, { commentId: rootCommentId, content })
        .catch(() => { btn.disabled = false; });
    });
  });

  const autogrow = (ta) => {
    if (!ta) return;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
    ta.addEventListener('input', grow);
    requestAnimationFrame(grow);
  };
  autogrow(replyTa);
  autogrow(editTa);
}
