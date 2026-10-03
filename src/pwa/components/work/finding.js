// Renders an orchestrator Finding (or a resolved read.investigate output of the same
// shape) into the shared .step-findings md-body block used by the step timeline,
// so orchestrator findings and investigate-step output look identical.

import { renderMarkdown } from '../../markdown.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

// Splits the findings markdown into topics at its top heading level — one level deeper when
// that level holds a single heading, which is how a writeup that opens "## What I verified"
// and then runs on in ### sections reads. Text before the first topic heading is `lead`.
export function splitTopics(md) {
  const levels = [...md.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length);
  if (!levels.length) return { lead: md, topics: [] };
  let level = Math.min(...levels);
  const deeper = levels.filter((l) => l > level);
  if (levels.filter((l) => l === level).length === 1 && deeper.length) level = Math.min(...deeper);
  const parts = md.split(new RegExp(`^#{${level}}\\s+(.*)$`, 'm'));
  const topics = [];
  for (let i = 1; i < parts.length; i += 2) topics.push({ title: parts[i].trim(), body: parts[i + 1] ?? '' });
  return { lead: parts[0], topics };
}

// Collapsed by default; the key is what lets detail.js's repaint snapshot reopen exactly the
// topic the user opened instead of every identically classed sibling.
function topic(key, title, html) {
  return `
    <details class="finding-topic tl-findings" data-details-key="finding-topic-${escapeHtml(key)}">
      <summary class="tl-findings-sum"><span class="finding-topic-title">${escapeHtml(title)}</span><span class="tl-findings-caret" aria-hidden="true">▾</span></summary>
      ${html}
    </details>`;
}

// The daemon paints the diagram in these tokens (D2_SLOTS in src/work/plan-diagram.ts), read off
// <html> at paint time, so it matches whichever theme + mode is showing.
export const DIAGRAM_TOKENS = ['bg', 'bg-elev', 'bg-elev-2', 'line', 'line-soft', 'text', 'text-mute', 'text-dim', 'accent', 'accent-2'];
const diagramSrc = (url) => {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const params = new URLSearchParams({ theme: root.dataset.theme ?? '' });
  for (const t of DIAGRAM_TOKENS) params.set(t, css.getPropertyValue(`--${t}`).trim());
  return `${url}?${params}`;
};

// A theme switch repaints nothing on this surface, so each diagram re-points itself instead.
if (typeof MutationObserver === 'function') {
  new MutationObserver(() => {
    for (const img of document.querySelectorAll('img[data-diagram-url]')) {
      img.src = diagramSrc(img.dataset.diagramUrl);
      if (img.parentElement instanceof HTMLAnchorElement) img.parentElement.href = img.src;
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
}

// A tap opens it full size.
function diagram(url) {
  const src = diagramSrc(url);
  return `<a class="plan-diagram" href="${escapeHtml(src)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" data-diagram-url="${escapeHtml(url)}" alt="Plan diagram" loading="lazy"></a>`;
}

// Only the exec summary, the verdict line and the diagram are visible by default. Every markdown
// topic — the text before the first heading included — plus evidence and caveats fold on their own.
// `diagramUrl` is the caller's, since only it knows which job the finding belongs to.
export function renderFinding(finding, label = 'Investigation', diagramUrl) {
  if (!finding || !finding.findings) return '';
  const { lead, topics } = splitTopics(finding.findings);
  if (lead.trim()) topics.unshift({ title: 'Overview', body: lead });
  const v = finding.verdict;
  const verdict = v
    ? `<div class="finding-verdict"><span class="finding-verdict-kind">${escapeHtml(v.kind)}</span> · confidence ${escapeHtml(v.confidence)}${v.suggested_title ? ` · ${escapeHtml(v.suggested_title)}` : ''}</div>`
    : '';
  const sections = topics.map((t, i) =>
    topic(i, t.title.replace(/[`*_]/g, ''), `<div class="step-findings md-body">${renderMarkdown(t.body)}</div>`));
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  if (evidence.length) {
    sections.push(topic('evidence', `Evidence (${evidence.length})`, `<ul class="finding-evidence">${evidence.map((e) =>
      `<li><span class="finding-evidence-kind">${escapeHtml(e.kind)}</span> ${escapeHtml(e.summary)}${e.source ? ` <span class="finding-evidence-src">${escapeHtml(e.source)}</span>` : ''}${e.excerpt ? `<div class="finding-evidence-excerpt">${escapeHtml(e.excerpt)}</div>` : ''}</li>`
    ).join('')}</ul>`));
  }
  const caveats = Array.isArray(finding.caveats) ? finding.caveats : [];
  if (caveats.length) {
    sections.push(topic('caveats', `Caveats (${caveats.length})`,
      `<ul class="finding-caveats">${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`));
  }
  return `
    <div class="plan-findings">
      <div class="plan-findings-label o-microhead">${escapeHtml(label)}</div>
      ${finding.summary ? `<p class="finding-summary">${escapeHtml(finding.summary)}</p>` : ''}
      ${verdict}
      ${finding.diagram && diagramUrl ? diagram(diagramUrl) : ''}
      ${sections.join('')}
    </div>
  `;
}
