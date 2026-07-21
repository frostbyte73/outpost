// Skills library — detail pane (header + actions, pending edit/proposal
// review card, denial suggestions, rendered SKILL.md, Permissions + Recent
// runs two-column grid). Registered as the 'skills' surface's renderDetail
// in shell/surfaces.js.

import { actions, editFor } from '../../state/actions.js';
import { actionsApi } from '../../net/actions.js';
import { library } from '../../state/library.js';
import { nav } from '../../state/nav.js';
import { runs } from '../../state/runs.js';
import { escapeHtml } from '../../util.js';
import { relPast } from '../../utils/formatting.js';
import { renderMarkdown } from '../../markdown.js';
import { verdictTone } from '../../vm/runs.js';
import { skillByName, permissionGroupNames, allowlistRuleCount, stripFrontmatter } from '../../vm/library.js';
import { emptyState } from '../shell/placeholder.js';
import { openPalette } from '../palette/index.js';
import { startScheduleDraft } from '../schedules/draft.js';

export function renderDetail(mount, deps) {
  const { selection } = deps ?? {};
  if (mount.__libUnsub) { try { mount.__libUnsub(); } catch { /* ignore */ } mount.__libUnsub = null; }
  if (!selection) {
    emptyState(mount, 'Select a skill to view its details.');
    return undefined;
  }

  mount.textContent = '';
  const view = document.createElement('div');
  view.className = 'lib-detail';
  mount.appendChild(view);

  const paint = () => {
    const state = actions.get();
    const item = skillByName(state, selection);
    const edit = editFor(state, selection);
    if (!item && edit) {
      // Proposal for an action that doesn't exist on disk yet (new-action flow)
      // — the review card is the whole detail.
      view.innerHTML = `
        <header class="lib-detail-hdr">
          <div class="lib-detail-title">
            <span class="lib-detail-name">${escapeHtml(selection)}</span>
            <span class="o-pill lib-cat-pill lib-cat-meta">pending</span>
          </div>
        </header>
        ${editCardHtml(edit, state)}
      `;
      wireEditCard(view, edit);
      return;
    }
    if (!item) {
      view.innerHTML = `<div class="lib-empty-note">Skill not found: ${escapeHtml(selection)}</div>`;
      return;
    }
    view.innerHTML = skillHtml(item, library.get(), state, edit);
    wire(view, item);
    if (edit) wireEditCard(view, edit);
    wireDenials(view, item, state);
  };

  paint();
  library.loadPermissionGroups();
  library.loadJournal(selection);
  if (!actions.get().loaded && !actions.get().loading) actions.load();

  const unsubActions = actions.subscribe(paint);
  const unsubLibrary = library.subscribe(paint);
  mount.__libUnsub = () => { unsubActions(); unsubLibrary(); };
  return mount.__libUnsub;
}

function skillHtml(item, libState, state, edit) {
  return `
    <header class="lib-detail-hdr">
      <div class="lib-detail-title">
        <span class="lib-detail-name">${escapeHtml(item.name)}</span>
        <span class="o-pill lib-cat-pill lib-cat-${escapeHtml(item.category)}">${escapeHtml(item.category)}</span>
        <span class="o-pill code">runner: ${escapeHtml(item.runner)}</span>
      </div>
      <div class="lib-detail-actions">
        ${item.kind === 'skill' ? `<button type="button" class="o-btn ${edit ? 'o-btn--default' : 'o-btn--primary'}" data-action="run-now" title="Open ⌘K prefilled with this skill">Run now</button>` : ''}
        <button type="button" class="o-btn ${item.kind === 'action' && !edit ? 'o-btn--primary' : 'o-btn--default'}" data-action="edit" ${edit ? 'hidden' : ''}>${item.kind === 'action' ? 'Edit ↗ meta.build-action' : 'Edit ↗ skill-creator'}</button>
        ${item.kind === 'skill' ? '<button type="button" class="o-btn o-btn--default" data-action="schedule">Schedule…</button>' : ''}
        ${item.kind === 'action' ? '<button type="button" class="o-btn o-btn--danger" data-action="delete">Delete</button>' : ''}
      </div>
    </header>

    ${edit ? editCardHtml(edit, state) : ''}
    ${denialsSectionHtml(item, state)}

    ${item.description ? `<p class="lib-detail-desc">${escapeHtml(item.description)}</p>` : ''}

    ${item.skillMd ? `<div class="lib-skillmd">${renderMarkdown(stripFrontmatter(item.skillMd))}</div>` : ''}

    <div class="lib-sections">
      ${permissionsSectionHtml(item, libState)}
      ${recentRunsSectionHtml(item, libState)}
    </div>
  `;
}

// ── Pending edit / proposal review ────────────────────────────────────────

function editCardHtml(edit, state) {
  const activity = state.activity?.get?.(edit.sessionId);
  if (!edit.proposal) {
    return `
      <div class="o-section lib-section lib-edit-card">
        <h4 class="lib-section-hdr o-microhead">Edit in progress</h4>
        <div class="lib-edit-status">meta.build-action is ${escapeHtml(activity?.verb ?? 'drafting')}… it posts a proposal here when ready.</div>
        <div class="lib-edit-actions">
          <button type="button" class="o-btn o-btn--default" data-edit-action="open-session">Open session</button>
          <button type="button" class="o-btn o-btn--danger" data-edit-action="cancel">Cancel edit</button>
        </div>
        <div class="lib-edit-error" hidden></div>
      </div>
    `;
  }
  const p = edit.proposal;
  const rules = (p.allowlistAdds ?? []).map((r) => `<span class="o-pill code">${escapeHtml(r.kind)}: ${escapeHtml(r.value)}</span>`).join(' ');
  return `
    <div class="o-section lib-section lib-edit-card">
      <h4 class="lib-section-hdr o-microhead">Proposal ready</h4>
      ${p.summary ? `<div class="lib-edit-summary">${escapeHtml(p.summary)}</div>` : ''}
      <details class="lib-edit-diff">
        <summary>Proposed SKILL.md (${p.skillMdAfter.length} bytes)</summary>
        <pre class="lib-edit-md">${escapeHtml(p.skillMdAfter)}</pre>
      </details>
      ${rules ? `<div class="lib-edit-rules">Allowlist additions: ${rules}</div>` : ''}
      <textarea class="lib-edit-feedback" rows="2" placeholder="Feedback for another draft (optional)…"></textarea>
      <div class="lib-edit-actions">
        <button type="button" class="o-btn o-btn--primary" data-edit-action="approve">Approve &amp; apply</button>
        <button type="button" class="o-btn o-btn--default" data-edit-action="feedback">Send feedback</button>
        <button type="button" class="o-btn o-btn--danger" data-edit-action="cancel">Cancel edit</button>
      </div>
      <div class="lib-edit-error" hidden></div>
    </div>
  `;
}

function wireEditCard(view, edit) {
  const card = view.querySelector('.lib-edit-card');
  if (!card) return;
  const errEl = card.querySelector('.lib-edit-error');
  const fail = (e) => { errEl.textContent = e.message; errEl.hidden = false; };
  card.querySelector('[data-edit-action="open-session"]')?.addEventListener('click', () => {
    nav.select('sessions', edit.sessionId);
  });
  card.querySelector('[data-edit-action="approve"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await actionsApi.approveProposal(edit.sessionId); }
    catch (err) { fail(err); e.target.disabled = false; }
  });
  card.querySelector('[data-edit-action="feedback"]')?.addEventListener('click', async (e) => {
    const text = card.querySelector('.lib-edit-feedback')?.value.trim();
    if (!text) { fail(new Error('Write the feedback first.')); return; }
    e.target.disabled = true;
    try { await actionsApi.feedbackProposal(edit.sessionId, text); }
    catch (err) { fail(err); }
    finally { e.target.disabled = false; }
  });
  card.querySelector('[data-edit-action="cancel"]')?.addEventListener('click', async (e) => {
    if (!confirm('Cancel this edit and discard the draft?')) return;
    e.target.disabled = true;
    try { await actionsApi.cancelEdit(edit.sessionId); }
    catch (err) { fail(err); e.target.disabled = false; }
  });
}

// ── Denials ("the action tried this and was blocked") ────────────────────

function denialsSectionHtml(item, state) {
  const list = state.denials?.[item.name] ?? [];
  if (list.length === 0) return '';
  const rows = list.map((d) => `
    <div class="lib-denial-row" data-denial-id="${escapeHtml(d.id)}">
      <div class="lib-denial-desc">
        <span class="lib-denial-tool">${escapeHtml(d.toolName)}</span>
        <span class="o-pill code">${escapeHtml(d.suggested.kind)}: ${escapeHtml(d.suggested.value)}</span>
        ${d.count > 1 ? `<span class="lib-denial-count">×${d.count}</span>` : ''}
      </div>
      <button type="button" class="o-btn o-btn--ghost" data-denial="allow">Allow</button>
      <button type="button" class="o-btn o-btn--ghost" data-denial="dismiss">Dismiss</button>
    </div>
  `).join('');
  return `
    <div class="o-section lib-section lib-denials">
      <h4 class="lib-section-hdr o-microhead">Blocked calls · ${list.length}</h4>
      <div class="lib-denials-note">Tool calls this action attempted that the allowlist blocked — allow to add the suggested rule, dismiss to ignore.</div>
      ${rows}
    </div>
  `;
}

function wireDenials(view, item, state) {
  const section = view.querySelector('.lib-denials');
  if (!section) return;
  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-denial]');
    if (!btn) return;
    const row = btn.closest('.lib-denial-row');
    const denial = (state.denials?.[item.name] ?? []).find((d) => d.id === row?.dataset.denialId);
    if (!denial) return;
    btn.disabled = true;
    try {
      if (btn.dataset.denial === 'allow') {
        await actionsApi.addAllowlistRule(item.name, denial.suggested.kind, denial.suggested.value);
      }
      await actionsApi.dismissDenial(item.name, denial.id);
    } catch (err) {
      window.alert(`Failed: ${err.message}`);
      btn.disabled = false;
    }
  });
}

// ── Permissions / recent runs ─────────────────────────────────────────────

function permissionsSectionHtml(item, libState) {
  const names = permissionGroupNames(item);
  const groups = libState.permissionGroups ?? [];
  const rows = names.map((n) => {
    const g = groups.find((x) => x.name === n);
    return `
      <div class="lib-perm-row">
        <span class="o-pill code lib-perm-pill">${escapeHtml(n)}</span>
        <span class="lib-perm-desc">${escapeHtml(g?.description ?? '')}</span>
      </div>
    `;
  }).join('');
  const extras = allowlistRuleCount(item.allowlist);
  return `
    <div class="o-section lib-section">
      <h4 class="lib-section-hdr o-microhead">Permissions</h4>
      ${rows || '<div class="lib-empty-note">No permission groups (builtin runner).</div>'}
      ${extras > 0 ? `<div class="lib-perm-extra">Plus ${extras} action-specific rule${extras === 1 ? '' : 's'} narrower than these groups.</div>` : ''}
    </div>
  `;
}

function recentRunsSectionHtml(item, libState) {
  const loading = libState.journalLoading?.has?.(item.name);
  const entries = libState.journalByAction?.get?.(item.name);
  let body;
  if (loading && !entries) {
    body = '<div class="lib-empty-note">Loading…</div>';
  } else if (!entries || entries.length === 0) {
    body = '<div class="lib-empty-note">No runs logged yet.</div>';
  } else {
    body = entries.slice().reverse().map(journalRowHtml).join('')
      + `<button type="button" class="lib-view-all" data-action="view-all-runs">View all runs →</button>`;
  }
  return `
    <div class="o-section lib-section">
      <h4 class="lib-section-hdr o-microhead">Recent runs${entries?.length ? ` · ${entries.length}` : ''}</h4>
      <div class="lib-runs-list">${body}</div>
    </div>
  `;
}

function journalRowHtml(e) {
  const tone = verdictTone(e.outcome);
  const icon = tone === 'ok' ? '✓' : tone === 'hot' ? '✕' : '◆';
  const inner = `
    <span class="o-row-icon ${tone}">${icon}</span>
    <span class="lib-run-lbl">
      <span class="lib-run-outcome">${escapeHtml(e.outcome)}</span>
      <span class="lib-run-lesson">${escapeHtml(e.lesson ?? '')}</span>
    </span>
    <span class="lib-run-when">${relPast(e.at)}</span>
  `;
  // Entries without a jobId have nowhere to link — render them inert instead
  // of as a button that looks clickable but no-ops.
  return e.jobId
    ? `<button type="button" class="lib-run-item" data-job-id="${escapeHtml(e.jobId)}">${inner}</button>`
    : `<div class="lib-run-item lib-run-item-static">${inner}</div>`;
}

function wire(view, item) {
  view.querySelector('[data-action="run-now"]')?.addEventListener('click', () => {
    openPalette({ prompt: `/${item.name.replace(/^\//, '')} ` });
  });

  view.querySelector('[data-action="edit"]')?.addEventListener('click', async () => {
    const feedback = window.prompt(`What should change about ${item.name}? (optional)`) ?? '';
    try {
      const res = item.kind === 'action'
        ? await actionsApi.edit(item.name, feedback)
        : await actionsApi.editSkill(item.name, feedback);
      if (res?.sessionId) nav.select('sessions', res.sessionId);
    } catch (e) {
      window.alert(`Edit failed: ${e.message}`);
    }
  });

  view.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${item.name}? Its SKILL.md, schemas, and allowlist are removed from disk.`)) return;
    try {
      await actionsApi.remove(item.name);
      nav.select('skills', null);
    } catch (e) {
      window.alert(`Delete failed: ${e.message}`);
    }
  });

  view.querySelector('[data-action="schedule"]')?.addEventListener('click', () => {
    nav.setSurface('schedules');
    startScheduleDraft({ skill: item.name.replace(/^\//, '') });
  });

  view.querySelectorAll('[data-action="view-all-runs"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      runs.setPendingFilter({ skill: item.name.replace(/^\//, '') });
      nav.setSurface('runs');
    });
  });

  view.querySelectorAll('.lib-run-item[data-job-id]').forEach((btn) => {
    btn.addEventListener('click', () => nav.select('tracked', btn.dataset.jobId));
  });
}
