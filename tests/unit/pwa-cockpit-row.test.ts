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

  it('a dismissable job shows Dismiss in the archive slot and calls onArchive', () => {
    const job = { ...model, key: 'job:j', kind: 'job', id: 'j', ref: null, dismissable: true, status: { text: 'Done', tone: 'mute' } };
    let archived: any = null;
    const row = createRow(job, { onToggle: noop, onAction: noop, onArchive: (m: any) => { archived = m; }, onOpenFull: noop, onHover: noop, initialView: view });
    const btn = row.el.querySelector('.ckb-archive') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('Dismiss');
    btn.click();
    expect(archived?.key).toBe('job:j');
  });

  it('a live job has no archive slot', () => {
    const job = { ...model, key: 'job:j', kind: 'job', id: 'j', dismissable: false };
    const row = createRow(job, { onToggle: noop, onAction: noop, onArchive: noop, onOpenFull: noop, onHover: noop, initialView: view });
    expect((row.el.querySelector('.ckb-archive') as HTMLButtonElement).hidden).toBe(true);
  });
});

describe('cockpit session menu', () => {
  it('a session row carries promote and delete, and opening it does not expand the row', () => {
    let toggled = false;
    const row = createRow(model, { onToggle: () => { toggled = true; }, onAction: noop, onArchive: noop, onOpenFull: noop, onHover: noop, initialView: view });
    const menu = row.el.querySelector('.ckb-menu') as HTMLElement;
    expect((row.el.querySelector('.ckb-menu-wrap') as HTMLElement).hidden).toBe(false);
    expect(menu.textContent).toContain('Promote to tracked');
    expect(menu.textContent).toContain('Delete');
    expect(menu.textContent).not.toContain('Open diff');
    (row.el.querySelector('.ckb-menu-btn') as HTMLButtonElement).click();
    expect(menu.hidden).toBe(false);
    expect(toggled).toBe(false);
    row.destroy();
  });

  it('a job row has no session menu', () => {
    const job = { ...model, key: 'job:j', kind: 'job', id: 'j', dismissable: false };
    const row = createRow(job, { onToggle: noop, onAction: noop, onArchive: noop, onOpenFull: noop, onHover: noop, initialView: view });
    expect((row.el.querySelector('.ckb-menu-wrap') as HTMLElement).hidden).toBe(true);
    row.destroy();
  });
});
