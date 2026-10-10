import { keymap } from '../../state/keymap.js';
import { isDesktop } from '../../layout/index.js';
import { isPaletteOpen } from '../palette/index.js';
import { expansion } from './expansion.js';

function isTyping(target) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}

export function installBoardKeys(root, board) {
  const step = (dir) => {
    const keys = board.rowKeys();
    if (!keys.length) return;
    const i = keys.indexOf(board.selected());
    const next = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, i + dir));
    board.select(keys[next]);
  };

  const nextNeedsYou = () => {
    const keys = board.rowKeys();
    const start = keys.indexOf(board.selected());
    for (let n = 1; n <= keys.length; n++) {
      const key = keys[(start + n + keys.length) % keys.length];
      if (board.row(key)?.model.actions.length) { board.select(key); return; }
    }
  };

  const reply = (key) => {
    if (!expansion.get().has(key)) board.toggle(key, 'caret');
    requestAnimationFrame(() => {
      board.row(key)?.el.querySelector('.ckb-body .sv-composer, .ckb-body textarea')?.focus();
    });
  };

  const onKey = (e) => {
    if (!isDesktop() || !root.isConnected || isPaletteOpen()) return;
    if (isTyping(e.target)) {
      if (keymap.matches(e, 'cockpit.collapse')) { e.target.blur(); e.preventDefault(); }
      return;
    }
    const key = board.selected();
    const handled = (id, fn) => {
      if (!keymap.matches(e, id)) return false;
      e.preventDefault();
      fn();
      return true;
    };
    if (handled('cockpit.next', () => step(1))) return;
    if (handled('cockpit.prev', () => step(-1))) return;
    if (handled('cockpit.nextNeedsYou', nextNeedsYou)) return;
    if (!key) return;
    if (handled('cockpit.toggle', () => board.toggle(key, 'caret'))) return;
    if (handled('cockpit.action', () => board.runAction(key))) return;
    if (handled('cockpit.archive', () => board.archive(key))) return;
    if (handled('cockpit.open', () => board.openFull(key))) return;
    if (handled('cockpit.collapse', () => board.collapse(key))) return;
    handled('cockpit.reply', () => reply(key));
  };

  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
