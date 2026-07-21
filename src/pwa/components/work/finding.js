// Renders an orchestrator Finding (or a resolved read.investigate output of the same
// shape) into the shared .step-findings md-body block used by the step timeline,
// so orchestrator findings and investigate-step output look identical.

import { renderMarkdown } from '../../markdown.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// `collapsible` renders the finding as a <details> whose summary is the label,
// mirroring the per-step findings disclosure (see step-card.js's .tl-findings) —
// used for the plan investigation, which is supporting context below the live
// orchestrator feed. `open` sets its default state.
export function renderFinding(finding, label = 'Investigation', { collapsible = false, open = true } = {}) {
  if (!finding || !finding.findings) return '';
  const evidence = Array.isArray(finding.evidence) && finding.evidence.length
    ? `<ul class="finding-evidence">${finding.evidence.map((e) =>
        `<li><span class="finding-evidence-kind">${escapeHtml(e.kind)}</span> ${escapeHtml(e.summary)}${e.source ? ` <span class="finding-evidence-src">${escapeHtml(e.source)}</span>` : ''}${e.excerpt ? `<div class="finding-evidence-excerpt">${escapeHtml(e.excerpt)}</div>` : ''}</li>`
      ).join('')}</ul>`
    : '';
  const v = finding.verdict;
  const verdict = v
    ? `<div class="finding-verdict"><span class="finding-verdict-kind">${escapeHtml(v.kind)}</span> · confidence ${escapeHtml(v.confidence)}${v.suggested_title ? ` · ${escapeHtml(v.suggested_title)}` : ''}</div>`
    : '';
  const caveats = Array.isArray(finding.caveats) && finding.caveats.length
    ? `<ul class="finding-caveats">${finding.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
    : '';
  const inner = `
      <div class="step-findings md-body">${renderMarkdown(finding.findings)}</div>
      ${verdict}
      ${evidence}
      ${caveats}`;
  if (collapsible) {
    return `
    <details class="plan-findings tl-findings"${open ? ' open' : ''}>
      <summary class="tl-findings-sum"><span class="plan-findings-label o-microhead">${escapeHtml(label)}</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary>
      ${inner}
    </details>
  `;
  }
  return `
    <div class="plan-findings">
      <div class="plan-findings-label o-microhead">${escapeHtml(label)}</div>
      ${inner}
    </div>
  `;
}
