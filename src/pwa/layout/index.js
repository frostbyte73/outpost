// Layout state helpers. The initial `data-layout` attribute is set inline in
// index.html before first paint (see the boot script there). This module wraps
// the same media query so JS can read the layout and subscribe to changes
// without racing the inline script.

const DESKTOP_QUERY = '(min-width: 1024px)';

let _mql = null;
function mql() {
  if (_mql === null) _mql = window.matchMedia(DESKTOP_QUERY);
  return _mql;
}

export function isDesktop() {
  return document.documentElement.dataset.layout === 'desktop';
}

export function isMobile() {
  return !isDesktop();
}

export function getLayout() {
  return isDesktop() ? 'desktop' : 'mobile';
}

// Fires whenever the layout crosses the desktop/mobile threshold. Matches the
// debounced behavior of the inline boot script so subscribers see the same
// transitions as the CSS.
export function onLayoutChange(fn) {
  const m = mql();
  let t = null;
  const handler = () => {
    clearTimeout(t);
    t = setTimeout(() => fn(getLayout()), 200);
  };
  if (m.addEventListener) m.addEventListener('change', handler);
  else m.addListener(handler);
  return () => {
    if (m.removeEventListener) m.removeEventListener('change', handler);
    else m.removeListener(handler);
    clearTimeout(t);
  };
}
