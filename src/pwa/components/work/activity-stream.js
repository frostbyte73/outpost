function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function ago(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const WHO_CLASS = {
  orchestrator: 'work-evt-orch',
  user: 'work-evt-user',
  session: 'work-evt-claude',
  investigator: 'work-evt-claude',
  implementer: 'work-evt-claude',
  responder: 'work-evt-claude',
  'linear-poller': 'work-evt-system',
  'linear-writer': 'work-evt-system',
  'pr-watcher': 'work-evt-system',
  system: 'work-evt-system',
};

export function renderActivityStream(ticket) {
  const events = Array.isArray(ticket?.events) ? [...ticket.events].reverse() : [];
  const body = events.length === 0
    ? '<p class="work-empty">No activity yet.</p>'
    : `
      <ol class="work-activity-list">
        ${events.map((e) => `
          <li class="work-activity-item ${WHO_CLASS[e.who] ?? 'work-evt-system'}">
            <span class="work-evt-who">${escapeHtml(e.who ?? '')}</span>
            <span class="work-evt-kind">${escapeHtml(e.kind)}</span>
            ${e.body ? `<span class="work-evt-body">${escapeHtml(e.body)}</span>` : ''}
            <span class="work-evt-when">${ago(e.at)}</span>
          </li>
        `).join('')}
      </ol>
    `;
  return `
    <h2 class="plan-heading">
      <span class="plan-heading-label">Activity</span>
    </h2>
    <section class="work-section work-section-static work-section-activity">
      <div class="work-section-body">${body}</div>
    </section>
  `;
}
