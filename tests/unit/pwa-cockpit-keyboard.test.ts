// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { installBoardKeys } from '../../src/pwa/components/cockpit/keyboard.js';

function fakeBoard() {
  return {
    rowKeys: () => ['job:a', 'session:b'],
    row: () => ({ model: { actions: [] }, el: document.createElement('div') }),
    selected: () => 'job:a',
    select: vi.fn(), toggle: vi.fn(), collapse: vi.fn(), runAction: vi.fn(),
    archive: vi.fn(), openFull: vi.fn(),
  };
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('cockpit board keys', () => {
  let root: HTMLElement;
  let board: ReturnType<typeof fakeBoard>;
  let uninstall: () => void;

  beforeEach(() => {
    document.documentElement.dataset.layout = 'desktop';
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.innerHTML = '<div class="ckb-item"><div class="ckb-body"><button id="approve">Approve</button></div></div>';
    document.body.appendChild(root);
    board = fakeBoard();
    uninstall = installBoardKeys(root, board);
  });
  afterEach(() => uninstall());

  it('drives the board from the page', () => {
    press(document.body, 'j');
    expect(board.select).toHaveBeenCalled();
  });

  it('Enter on a focused button presses the button, not the board', () => {
    press(root.querySelector('#approve')!, 'Enter');
    expect(board.openFull).not.toHaveBeenCalled();
  });

  it('Space on a focused button inside a body does not collapse the row', () => {
    press(root.querySelector('#approve')!, ' ');
    expect(board.toggle).not.toHaveBeenCalled();
  });

  it('stays out of the way while a modal overlay is open', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlay);
    press(document.body, 'e');
    expect(board.archive).not.toHaveBeenCalled();
  });

  it('ignores keys aimed at something outside the board', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    press(outside, 'j');
    expect(board.select).not.toHaveBeenCalled();
  });
});
