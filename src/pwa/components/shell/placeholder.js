// Shared "not built yet" body for main-only / list-detail surfaces. Extracted
// from surfaces.js so P2 pre-stub components (cockpit/schedules/library/
// settings-surface) can render the same look without importing surfaces.js
// (which would pull in every other surface's renderer via its top-level
// imports).

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  ));
}

export function renderPlaceholder(mount, eyebrow, body) {
  mount.textContent = '';
  const section = document.createElement('div');
  section.className = 'o-section o-surface-placeholder';
  section.innerHTML = `
    <div class="o-surface-placeholder-eyebrow o-microhead">${escapeHtml(eyebrow)}</div>
    <p class="o-surface-placeholder-body">${escapeHtml(body)}</p>
  `;
  mount.appendChild(section);
}

// "Nothing selected yet" body for list-detail(-context) surfaces — deliberately
// plainer than renderPlaceholder's eyebrow+card (this isn't "not built", it's
// "pick something"). Shared by tracked/index.js and sessions-surface/index.js
// (moved out of shell/surfaces.js along with their renderDetail wiring).
export function emptyState(mount, text) {
  mount.textContent = '';
  const el = document.createElement('div');
  el.className = 'o-frame-empty';
  el.textContent = text;
  mount.appendChild(el);
}
