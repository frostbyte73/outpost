// One delegated listener on document, so no surface wires a screenshot and no repaint can drop one.
import { noteSheetClose, noteSheetOpen } from '../sheet-utils.js';

let dialog = null;

function build() {
  const el = document.createElement('dialog');
  el.className = 'shot-viewer';
  el.setAttribute('aria-label', 'Screenshot');
  el.innerHTML = `
    <div class="shot-viewer-head">
      <span class="shot-viewer-label"></span>
      <button type="button" class="o-btn o-btn--ghost sm" data-shot-close aria-label="Close">✕</button>
    </div>
    <div class="shot-viewer-frame">
      <img alt="">
      <p class="shot-viewer-error" hidden>Couldn't load this screenshot</p>
    </div>`;
  const frame = el.querySelector('.shot-viewer-frame');
  const img = el.querySelector('img');
  const error = el.querySelector('.shot-viewer-error');
  el.querySelector('[data-shot-close]').addEventListener('click', () => el.close());
  // A click on the dialog element itself, not its content, is a click on the backdrop.
  el.addEventListener('click', (e) => { if (e.target === el) el.close(); });
  el.addEventListener('close', noteSheetClose);
  img.addEventListener('click', () => frame.classList.toggle('is-actual'));
  img.addEventListener('load', () => { img.hidden = false; error.hidden = true; });
  img.addEventListener('error', () => { img.hidden = true; error.hidden = false; });
  document.body.appendChild(el);
  return el;
}

function open(src, label) {
  dialog ??= build();
  dialog.querySelector('.shot-viewer-label').textContent = label;
  dialog.querySelector('.shot-viewer-frame').classList.remove('is-actual');
  const img = dialog.querySelector('img');
  img.hidden = true;
  dialog.querySelector('.shot-viewer-error').hidden = true;
  img.removeAttribute('src');
  img.alt = label;
  img.src = src;
  dialog.showModal();
  noteSheetOpen(() => dialog.close());
}

export function installShotViewer() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-shot]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    // Capture phase, so a card's own row-click handler never sees this click.
    e.stopPropagation();
    const label = a.closest('figure')?.querySelector('figcaption')?.textContent ?? a.querySelector('img')?.getAttribute('alt') ?? '';
    open(a.getAttribute('href'), label);
  }, true);
}
