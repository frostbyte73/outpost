import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS.
import { createScrollIntent, getIntent } from '../../src/pwa/components/session-view/scroll-intent.js';

const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });
const BOTTOM = 600;

describe('session transcript scroll intent', () => {
  it('ignores the event our own write produced, keeping the user pinned', () => {
    const s = createScrollIntent('own-write');
    s.noteOwnWrite(BOTTOM);
    expect(s.handleScroll(box(BOTTOM))).toBe(false);
    expect(getIntent('own-write').stickyBottom).toBe(true);
  });

  it('lets the user scroll away mid-stream, where a repaint writes every frame', () => {
    const s = createScrollIntent('mid-stream');
    for (let frame = 0; frame < 5; frame++) {
      s.noteOwnWrite(BOTTOM);
      s.handleScroll(box(BOTTOM));
    }
    expect(getIntent('mid-stream').stickyBottom).toBe(true);

    // User wheels up between two of those repaints.
    s.noteOwnWrite(BOTTOM);
    expect(s.handleScroll(box(200))).toBe(true);
    expect(getIntent('mid-stream')).toMatchObject({ stickyBottom: false, savedScrollTop: 200 });

    // The frames that follow restore the saved offset and must not re-pin.
    for (let frame = 0; frame < 5; frame++) {
      s.noteOwnWrite(200);
      expect(s.handleScroll(box(200))).toBe(false);
    }
    expect(getIntent('mid-stream').stickyBottom).toBe(false);
  });

  it('re-pins when the user scrolls back within the bottom threshold', () => {
    const s = createScrollIntent('return');
    s.handleScroll(box(100));
    expect(getIntent('return').stickyBottom).toBe(false);
    s.handleScroll(box(BOTTOM - 10));
    expect(getIntent('return').stickyBottom).toBe(true);
  });

  it('treats a clamped write as our own, not as the user scrolling to the top', () => {
    const s = createScrollIntent('clamped');
    s.handleScroll(box(300));
    // Restore of 300 against content that has not laid out yet lands at 0.
    s.noteOwnWrite(0);
    expect(s.handleScroll({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(false);
    expect(getIntent('clamped').savedScrollTop).toBe(300);
  });
});
