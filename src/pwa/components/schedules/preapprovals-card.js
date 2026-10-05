import { escapeHtml } from '../../util.js';
import { summaryLabel } from '../../vm/preapprovals.js';
import { clearPreapprovalsScope, readPreapprovalsControl, renderPreapprovalsControl, wirePreapprovalsControl } from '../work/preapprovals-control.js';

// Copied onto every job this schedule spawns — the user's one approval for runs nobody watches.
export function renderPreapprovalsCard(schedule, editState, repaint, onSave) {
  const card = document.createElement('div');
  card.className = 'o-section sched-card-detail';
  const planReview = schedule.planReview ?? 'gate';

  if (!editState.preapprovals) {
    card.innerHTML = `
      <div class="sched-card-hdr">
        <h3 class="o-microhead">▲ Pre-approvals</h3>
        <button type="button" class="sched-edit-link">Edit</button>
      </div>
      <div class="sched-form">
        <div class="sched-form-row"><span class="k">Writes</span><span>${escapeHtml(summaryLabel(schedule.preapprovals))}</span></div>
        <div class="sched-form-row"><span class="k">Plan review</span><span>${planReview === 'auto' ? 'Pre-approved — runs without you' : 'Asks you to approve each plan'}</span></div>
      </div>`;
    card.querySelector('.sched-edit-link').addEventListener('click', () => { editState.preapprovals = true; repaint(); });
    return card;
  }

  card.innerHTML = `
    <div class="sched-card-hdr"><h3 class="o-microhead">▲ Pre-approvals</h3></div>
    <div class="sched-form">
      ${renderPreapprovalsControl(schedule.preapprovals, { name: schedule.id })}
      <label class="sched-form-row"><span class="k">Plan review</span>
        <select class="p-plan-review">
          <option value="gate"${planReview === 'gate' ? ' selected' : ''}>Ask me to approve the plan</option>
          <option value="auto"${planReview === 'auto' ? ' selected' : ''}>Pre-approved — run it</option>
        </select>
      </label>
      <div class="sched-form-error" hidden></div>
      <div class="sched-form-actions">
        <button type="button" class="o-btn o-btn--default sched-cancel">Cancel</button>
        <button type="button" class="o-btn o-btn--primary sched-save">Save</button>
      </div>
    </div>`;
  const scope = `schedule:${schedule.id}`;
  wirePreapprovalsControl(card, scope);

  card.querySelector('.sched-cancel').addEventListener('click', () => {
    clearPreapprovalsScope(scope);
    editState.preapprovals = false;
    repaint();
  });
  card.querySelector('.sched-save').addEventListener('click', async () => {
    const err = card.querySelector('.sched-form-error');
    try {
      await onSave({
        preapprovals: readPreapprovalsControl(card.querySelector('fieldset.o-preapprovals')),
        planReview: card.querySelector('.p-plan-review').value,
      });
      clearPreapprovalsScope(scope);
      editState.preapprovals = false;
      repaint();
    } catch (e) {
      err.textContent = `Failed to save: ${e.message}`;
      err.hidden = false;
    }
  });
  return card;
}
