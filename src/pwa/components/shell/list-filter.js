// Wraps a raw list renderer (takes a body element and renders `.lr-row`s into
// it) with list-column chrome: a title header (from the frame's
// data-surface-title stamp, so this stays registry-agnostic), a row count, and
// a generic client-side text filter (⌘F focuses `.o-list-filter`). The filter
// is re-applied after every repaint the wrapped renderer performs — store
// ticks rewrite the body's rows, which would otherwise silently un-hide
// everything while the query text still sits in the input.
export function mountFilterableList(mount, renderFn) {
  mount.textContent = '';
  let query = '';

  const title = mount.dataset?.surfaceTitle ?? mount.closest?.('.o-frame-list')?.dataset.surfaceTitle ?? '';
  let countEl = null;
  if (title) {
    const hdr = document.createElement('div');
    hdr.className = 'o-list-hdr';
    hdr.innerHTML = `<h2></h2><span class="o-list-count"></span>`;
    hdr.querySelector('h2').textContent = title;
    countEl = hdr.querySelector('.o-list-count');
    mount.appendChild(hdr);
  }

  const bar = document.createElement('div');
  bar.className = 'o-list-filterbar';
  bar.innerHTML = '<input type="search" class="o-list-filter" placeholder="Filter…" aria-label="Filter list"><span class="o-kbd">⌘F</span>';
  const body = document.createElement('div');
  body.className = 'o-list-body';
  mount.appendChild(bar);
  mount.appendChild(body);

  function applyFilter() {
    const rows = body.querySelectorAll('.lr-row');
    let visible = 0;
    for (const row of rows) {
      const hide = query.length > 0 && !row.textContent.toLowerCase().includes(query);
      row.hidden = hide;
      if (!hide) visible++;
    }
    if (countEl) countEl.textContent = rows.length ? String(visible) : '';
  }

  // childList-only: applyFilter mutates the `hidden` attribute, which never
  // re-triggers a childList observation, so no feedback loop.
  const observer = new MutationObserver(applyFilter);
  observer.observe(body, { childList: true, subtree: true });

  const unmount = renderFn(body);
  applyFilter();
  bar.querySelector('.o-list-filter').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    applyFilter();
  });
  return () => {
    observer.disconnect();
    try { unmount?.(); } catch { /* ignore */ }
  };
}
