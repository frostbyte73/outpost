import { escapeHtml } from '../../util.js';
import { schedulesApi } from '../../net/schedules.js';
import { schedulesStore } from '../../state/schedules.js';
import { openRunDetail } from '../../app-bridge.js';

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function renderRunsCard(schedule, detail) {
  const card = document.createElement('div');
  card.className = 'o-section sched-card-detail';

  const runsHtml = detail.recentRuns.length
    ? detail.recentRuns.map((r) => `
      <div class="sched-run" data-run-id="${escapeHtml(r.id)}">
        <span class="sched-run-icon o-row-icon ${r.tone}">${r.glyph}</span>
        <div class="sched-run-body">
          <div class="sched-run-title">${escapeHtml(r.title ?? '')}</div>
          <div class="sched-run-sub">${escapeHtml(r.verdictText)}${r.followUp ? ` · <span class="sched-tz">${escapeHtml(r.followUp)}</span>` : ''}</div>
          ${r.canApproveGithub ? '<button type="button" class="o-btn o-btn--default sm sched-approve-github">Approve &amp; post</button>' : ''}
        </div>
        <div class="sched-run-duration">${escapeHtml(fmtDuration(r.durationMs))}</div>
        <div class="sched-run-time">${escapeHtml(r.timeAgo ?? '')}</div>
      </div>
    `).join('')
    : '<div class="o-frame-empty">No runs yet.</div>';

  card.innerHTML = `
    <div class="sched-card-hdr"><h3 class="o-microhead">◐ Recent runs</h3></div>
    <div class="sched-runs">${runsHtml}</div>
  `;

  for (const el of card.querySelectorAll('.sched-run')) {
    const runId = el.dataset.runId;
    const row = detail.recentRuns.find((r) => r.id === runId);
    if (row?.refs?.jobId || row?.refs?.sessionId) {
      el.classList.add('clickable');
      el.addEventListener('click', (e) => {
        if (e.target.closest('.sched-approve-github')) return;
        openRunDetail({ kind: 'sched', title: schedule.name, refs: row.refs });
      });
    }
  }

  for (const btn of card.querySelectorAll('.sched-approve-github')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const runId = e.target.closest('.sched-run').dataset.runId;
      btn.disabled = true;
      try {
        await schedulesApi.approveGithubPost(schedule.id, runId);
        await schedulesStore.loadRuns(schedule.id);
      } catch (err) {
        btn.disabled = false;
        alert(`Failed to post: ${err.message}`);
      }
    });
  }

  return card;
}
