import { escapeHtml } from '../../util.js';
import { createSwitch } from './switch.js';

// Best-effort read of the most recent run's Slack delivery outcome, purely to
// give an honest "configured or not" hint — there's no client-visible config
// endpoint for OUTPOST_SLACK_WEBHOOK_URL (secret, daemon-side .env only), so
// we can only infer from what a run actually observed.
function slackAvailabilityHint(recentRuns) {
  const withSlack = recentRuns.find((r) => r.followUp?.includes('Slack') || r.followUp?.includes('slack'));
  if (!withSlack) return 'Status unknown until the next run.';
  if (withSlack.followUp.includes('sent to Slack')) return 'Delivering — last run sent successfully.';
  if (withSlack.followUp.toLowerCase().includes('not configured')) return 'Not configured on this daemon (~/.outpost/.env OUTPOST_SLACK_WEBHOOK_URL).';
  if (withSlack.followUp.toLowerCase().includes('slack failed')) return 'Last delivery failed — check the daemon logs.';
  return 'Status unknown until the next run.';
}

export function renderRoutingCard(schedule, detail, editState, repaint, onSave) {
  const card = document.createElement('div');
  card.className = 'o-section sched-card-detail';
  const { routing } = detail;

  if (!editState.routing) {
    const repo = detail.whatToRun.repos[0] ?? detail.whatToRun.cwd;
    card.innerHTML = `
      <div class="sched-card-hdr">
        <h3 class="o-microhead">▲ Where findings go</h3>
        <button type="button" class="sched-edit-link">Edit</button>
      </div>
      <div class="sched-route-list">
        <div class="sched-route">
          <span class="sched-route-icon">◈</span>
          <div class="sched-route-desc">
            <div><strong>Cockpit</strong> — findings surface in the run queue</div>
            <div class="sub">Confidence threshold: ${routing.cockpit?.confidenceThreshold != null ? `<code>${Math.round(routing.cockpit.confidenceThreshold * 100)}%</code>` : '<code>any</code>'}</div>
          </div>
        </div>
        <div class="sched-route${routing.slack ? '' : ' unavailable'}">
          <span class="sched-route-icon">✉</span>
          <div class="sched-route-desc">
            <div><strong>Slack</strong>${routing.slack ? ` — ${routing.slack.summaryShape === 'per-finding' ? 'one message per finding' : 'digest summary'}` : ' — not routed'}</div>
            <div class="sub">${routing.slack ? escapeHtml(slackAvailabilityHint(detail.recentRuns)) : 'Enable in Edit to route run summaries to a webhook.'}</div>
          </div>
        </div>
        <div class="sched-route${routing.github ? '' : ' unavailable'}">
          <span class="sched-route-icon">↗</span>
          <div class="sched-route-desc">
            <div><strong>GitHub</strong>${routing.github ? (repo ? ` — posts to ${escapeHtml(repo)}` : ' — no repo configured, nothing will post') : ' — not routed'}</div>
            <div class="sub">${routing.github ? (routing.github.approvalBeforePosting ? 'Requires approval before posting' : 'Posts automatically') : 'Enable in Edit to attach findings as a PR/issue comment.'}</div>
          </div>
        </div>
      </div>
    `;
    card.querySelector('.sched-edit-link').addEventListener('click', () => { editState.routing = true; repaint(); });
    return card;
  }

  // ── Edit mode ──
  const thresholdPct = routing.cockpit?.confidenceThreshold != null ? Math.round(routing.cockpit.confidenceThreshold * 100) : '';
  card.innerHTML = `
    <div class="sched-card-hdr"><h3 class="o-microhead">▲ Where findings go</h3></div>
    <div class="sched-form">
      <div class="sched-route-edit">
        <div class="sched-route-edit-hdr"><span class="sched-route-icon">◈</span><strong>Cockpit</strong></div>
        <label class="sched-form-row"><span class="k">Confidence ≥</span><input class="r-cockpit-threshold" type="number" min="0" max="100" placeholder="any" value="${escapeHtml(String(thresholdPct))}" /><span class="sched-form-unit">%</span></label>
      </div>
      <div class="sched-route-edit">
        <div class="sched-route-edit-hdr"><span class="sched-route-icon">✉</span><strong>Slack</strong><span class="r-slack-switch-slot"></span></div>
        <label class="sched-form-row r-slack-fields" ${routing.slack ? '' : 'hidden'}><span class="k">Summary shape</span>
          <select class="r-slack-shape">
            <option value="digest"${(routing.slack?.summaryShape ?? 'digest') === 'digest' ? ' selected' : ''}>Digest</option>
            <option value="per-finding"${routing.slack?.summaryShape === 'per-finding' ? ' selected' : ''}>Per-finding</option>
          </select>
        </label>
      </div>
      <div class="sched-route-edit">
        <div class="sched-route-edit-hdr"><span class="sched-route-icon">↗</span><strong>GitHub</strong><span class="r-github-switch-slot"></span></div>
        <label class="sched-form-row r-github-fields" ${routing.github ? '' : 'hidden'}>
          <span class="k">Approval before posting</span><span class="r-github-approval-slot"></span>
        </label>
      </div>
      <div class="sched-form-error" hidden></div>
      <div class="sched-form-actions">
        <button type="button" class="o-btn o-btn--default sched-cancel">Cancel</button>
        <button type="button" class="o-btn o-btn--primary sched-save">Save</button>
      </div>
    </div>
  `;

  let slackEnabled = !!routing.slack;
  let githubEnabled = !!routing.github;
  let githubApproval = routing.github?.approvalBeforePosting ?? true;

  const slackSwitch = createSwitch(slackEnabled, (next) => {
    slackEnabled = next;
    card.querySelector('.r-slack-fields').hidden = !next;
  }, 'Route findings to Slack');
  card.querySelector('.r-slack-switch-slot').appendChild(slackSwitch);

  const githubSwitch = createSwitch(githubEnabled, (next) => {
    githubEnabled = next;
    card.querySelector('.r-github-fields').hidden = !next;
  }, 'Route findings to GitHub');
  card.querySelector('.r-github-switch-slot').appendChild(githubSwitch);

  const approvalSwitch = createSwitch(githubApproval, (next) => { githubApproval = next; }, 'Require approval before posting');
  card.querySelector('.r-github-approval-slot').appendChild(approvalSwitch);

  card.querySelector('.sched-cancel').addEventListener('click', () => { editState.routing = false; repaint(); });
  card.querySelector('.sched-save').addEventListener('click', async () => {
    const rawThreshold = card.querySelector('.r-cockpit-threshold').value.trim();
    const nextRouting = {};
    if (rawThreshold !== '') nextRouting.cockpit = { confidenceThreshold: Math.max(0, Math.min(100, Number(rawThreshold))) / 100 };
    else nextRouting.cockpit = {};
    if (slackEnabled) nextRouting.slack = { summaryShape: card.querySelector('.r-slack-shape').value };
    if (githubEnabled) nextRouting.github = { approvalBeforePosting: githubApproval };
    const err = card.querySelector('.sched-form-error');
    try {
      await onSave({ routing: nextRouting });
      editState.routing = false;
      repaint();
    } catch (e) {
      err.textContent = `Failed to save: ${e.message}`;
      err.hidden = false;
    }
  });

  return card;
}
