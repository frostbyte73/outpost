import { escapeHtml } from '../util.js';
import { registerBackHandler } from './mobile-shell/history.js';

let _openSheetCount = 0;
// Parallel stack of unregister fns from registerBackHandler, one slot per
// noteSheetOpen() call (null when the caller didn't pass a closeFn) — popped
// in noteSheetClose() so hardware back stops targeting a sheet the instant it
// closes through any other path (backdrop tap, ✕ button, swipe-dismiss).
const _backUnregisterStack = [];

// `closeFn`, when given, lets hardware back close this sheet instead of
// popping a screen (see mobile-shell/history.js's registerBackHandler).
export function noteSheetOpen(closeFn) {
  _openSheetCount += 1;
  document.body.classList.add('sheet-open');
  _backUnregisterStack.push(typeof closeFn === 'function' ? registerBackHandler(closeFn) : null);
}

export function noteSheetClose() {
  _openSheetCount = Math.max(0, _openSheetCount - 1);
  if (_openSheetCount === 0) document.body.classList.remove('sheet-open');
  const unregister = _backUnregisterStack.pop();
  if (unregister) unregister();
}

// Blur the focused element if it's something that triggers the soft keyboard. Called
// before opening a sheet so iOS Safari closes the keyboard first — otherwise the visual
// viewport stays shrunk and pinSheetBelowHeader sees a header that's been pushed off
// the top of the visible area.
export function dismissSoftKeyboard() {
  const el = document.activeElement;
  if (!el || el === document.body) return;
  const tag = el.tagName;
  const editable = el.getAttribute && el.getAttribute('contenteditable') === 'true';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) el.blur();
}

// Cap a sheet's vertical extent so it never grows tall enough to cover the page
// header. Two modes:
//   - default: set max-height so the sheet sizes naturally to its content but stops
//     at the header's bottom. Used by todos / ask / settings — they're often shorter
//     than the available space and shouldn't push to the top when they don't need to.
//   - fillVertical: set top: <header.bottom> so the sheet pins to that line regardless
//     of content height. Used by the agents sheet, where we want fixed dimensions so
//     swapping between agents with different feeds doesn't change the sheet's outer
//     size — only the inner feed scrolls.
export function pinSheetBelowHeader(sheet, opts) {
  if (!sheet) return;
  const header = document.getElementById('header');
  if (!header) return;
  // When the soft keyboard is closing (callers blur via dismissSoftKeyboard) the visual
  // viewport hasn't yet returned to full height, and getBoundingClientRect().bottom can
  // be near zero or negative — pinning to that would cover the header. Fall back to the
  // header's stable layout height in that case; once the keyboard finishes its close
  // animation, re-pin against the live rect for an exact fit.
  const rectBottom = Math.round(header.getBoundingClientRect().bottom);
  const top = rectBottom > 0 ? rectBottom : header.offsetHeight;
  if (opts && opts.fillVertical) {
    sheet.style.top = `${top}px`;
    sheet.style.maxHeight = '';
  } else {
    sheet.style.maxHeight = `calc(100dvh - ${top}px)`;
    sheet.style.top = '';
  }
  // If the visual viewport is currently shorter than the layout viewport, the soft
  // keyboard is still up or animating closed. Re-pin once it settles so the sheet's top
  // matches the real post-keyboard header position rather than the offsetHeight
  // approximation above.
  const vv = window.visualViewport;
  if (vv && vv.height < window.innerHeight - 50 && !sheet._outpostRepinPending) {
    sheet._outpostRepinPending = true;
    const onResize = () => {
      if (vv.height >= window.innerHeight - 50) {
        vv.removeEventListener('resize', onResize);
        sheet._outpostRepinPending = false;
        if (document.body.contains(sheet)) pinSheetBelowHeader(sheet, opts);
      }
    };
    vv.addEventListener('resize', onResize);
    setTimeout(() => {
      vv.removeEventListener('resize', onResize);
      sheet._outpostRepinPending = false;
    }, 1000);
  }
}

// Themed replacement for window.confirm() — opens a small bottom sheet matching the
// rest of the PWA chrome. Returns a Promise<boolean>: true for confirm, false for cancel
// or dismiss (backdrop tap, swipe-down, Escape key). One confirm sheet at a time; if
// another opens while one is up, the first resolves false.
export function confirmInSheet({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('confirm-sheet');
    if (existing) existing.dispatchEvent(new CustomEvent('outpost-confirm-cancel'));

    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop confirm-sheet-backdrop';
    backdrop.id = 'confirm-sheet-backdrop';
    const sheet = document.createElement('aside');
    sheet.className = 'sheet confirm-sheet';
    sheet.id = 'confirm-sheet';
    sheet.setAttribute('role', 'alertdialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', title);
    sheet.innerHTML = `
      <div class="grabber"></div>
      <div class="header-row">
        <span class="sheet-title">${escapeHtml(title)}</span>
        <button class="sheet-close" id="confirm-sheet-close" aria-label="Cancel">✕</button>
      </div>
      <div class="confirm-body">${escapeHtml(body)}</div>
      <div class="confirm-actions">
        <button class="cancel" type="button">Cancel</button>
        <button class="${danger ? 'confirm-danger' : 'confirm-primary'}" type="button">${escapeHtml(confirmLabel || 'Confirm')}</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      sheet.classList.add('open');
    });
    pinSheetBelowHeader(sheet);
    noteSheetOpen(() => finish(false));

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      sheet.classList.remove('open');
      noteSheetClose();
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        backdrop.remove();
        sheet.remove();
      }, 380);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);

    sheet.addEventListener('outpost-confirm-cancel', () => finish(false));
    backdrop.onclick = () => finish(false);
    sheet.querySelector('#confirm-sheet-close').onclick = () => finish(false);
    sheet.querySelector('.cancel').onclick = () => finish(false);
    sheet.querySelector('.confirm-danger, .confirm-primary').onclick = () => finish(true);
    makeSheetDismissible(sheet, () => finish(false));
  });
}

// Wire drag-to-dismiss on a sheet's grabber. Re-callable: rebinding a fresh handle
// after a sheet's inner HTML is rebuilt (refreshAgentsSheet, etc.) is safe — we
// replace any prior _outpostDismissBound flag and let the old listeners drop with
// the discarded node. Dismiss fires either on a sufficient downward drag distance
// (~25% of viewport) or on a strong downward flick (so a quick swipe works even
// without crossing the distance threshold).
export function makeSheetDismissible(sheetEl, closeFn) {
  if (!sheetEl) return;
  const handles = [...sheetEl.querySelectorAll(':scope > .grabber, :scope > .header-row')];
  if (handles.length === 0) return;
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let active = false;
  let activeHandle = null;
  const isInteractive = (target) =>
    !!target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]');
  const onDown = (e) => {
    if (isInteractive(e.target)) return;
    active = true;
    activeHandle = e.currentTarget;
    startY = e.clientY;
    lastY = startY;
    lastT = e.timeStamp;
    sheetEl.classList.add('sheet-dragging');
    try { activeHandle.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  };
  const onMove = (e) => {
    if (!active) return;
    const dy = Math.max(0, e.clientY - startY);
    sheetEl.style.transform = `translateY(${dy}px)`;
    lastY = e.clientY;
    lastT = e.timeStamp;
  };
  const onUp = (e) => {
    if (!active) return;
    active = false;
    sheetEl.classList.remove('sheet-dragging');
    sheetEl.style.transform = '';
    const dy = Math.max(0, e.clientY - startY);
    const dt = Math.max(1, e.timeStamp - lastT);
    const flickVelocity = (e.clientY - lastY) / dt;
    const threshold = Math.min(window.innerHeight * 0.25, 220);
    if (dy > threshold || flickVelocity > 0.6) closeFn();
    try { activeHandle?.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    activeHandle = null;
  };
  for (const handle of handles) {
    if (handle._outpostDismissBound) continue;
    handle._outpostDismissBound = true;
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }
}
