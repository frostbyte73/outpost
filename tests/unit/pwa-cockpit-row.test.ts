// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { createRow } from '../../src/pwa/components/cockpit/row.js';

const model = {
  key: 'session:s', kind: 'session', id: 's', ref: 'p/x', refMono: true, kindLabel: null, title: 'chat',
  tone: 'idle', status: { text: 'Idle', tone: 'mute' }, time: 0, actions: [], actionLabel: null, feeds: [],
  engagedAt: 0, createdAt: 0, cwd: '/p/x', inboxItem: null,
};
const view = { mode: null, selected: false, now: 0, hideFeeds: [], mountBody: () => ({ update() {}, unmount() {} }) };
const noop = () => {};

describe('cockpit row archive', () => {
  it('a failed archive keeps its error on the row through later repaints', () => {
    const row = createRow(model, { onToggle: noop, onAction: noop, onArchive: noop, onOpenFull: noop, onHover: noop, initialView: view });
    row.setArchiving(true);
    row.setArchiving(false, 'Archive failed: HTTP 500');
    row.update(model, view);
    expect(row.el.querySelector('.ckb-status')!.textContent).toBe('Archive failed: HTTP 500');
    expect(row.el.querySelector('.ckb-archive')!.textContent).toBe('Archive');
  });
});
