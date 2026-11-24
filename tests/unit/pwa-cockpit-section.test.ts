// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { createSection } from '../../src/pwa/components/cockpit/section.js';

const row = (key: string, over: Record<string, unknown> = {}) => ({ key, kind: key.split(':')[0], actions: [], tone: 'idle', title: key, ...over });
const pinned = (over: Record<string, unknown> = {}) => ({
  id: 'pin:p1', kind: 'pinned', pinId: 'p1', title: 'Pinned', needYou: 0, rows: [row('job:a')], ...over,
});
const ctx = () => ({ onRename: vi.fn(), onRemove: vi.fn(), onNew: vi.fn(), onChip: vi.fn() });

function mount(resolved: any, c = ctx()) {
  const s = createSection(resolved, c);
  document.body.innerHTML = '';
  document.body.appendChild(s.el);
  return { s, c };
}
const titleBtn = () => document.querySelector('.ckb-pin-title') as HTMLButtonElement;
const input = () => document.querySelector('.ckb-pin-rename') as HTMLInputElement;
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('cockpit section', () => {
  it('marks built-ins and pins with data-section', () => {
    expect(mount({ id: 'sessions', kind: 'sessions', title: 'Sessions', needYou: 0, rows: [] }).s.el.dataset.section).toBe('sessions');
    expect(mount(pinned()).s.el.dataset.section).toBe('pin:p1');
  });

  it('rename commits on Enter', () => {
    const { c } = mount(pinned());
    titleBtn().click();
    input().value = '  Replay  ';
    key(input(), 'Enter');
    expect(c.onRename).toHaveBeenCalledTimes(1);
    expect(c.onRename).toHaveBeenCalledWith('p1', '  Replay  ');
    expect(input()).toBeNull();
  });

  it('rename cancels on Escape and does not commit on the blur that follows', () => {
    const { c } = mount(pinned());
    titleBtn().click();
    input().value = 'nope';
    key(input(), 'Escape');
    expect(c.onRename).not.toHaveBeenCalled();
    expect(titleBtn().textContent).toBe('Pinned');
  });

  it('rename commits on blur', () => {
    const { c } = mount(pinned());
    titleBtn().click();
    input().value = 'Replay';
    input().blur();
    expect(c.onRename).toHaveBeenCalledWith('p1', 'Replay');
  });

  it('focus returns to the title button after rename', () => {
    mount(pinned());
    titleBtn().click();
    key(input(), 'Enter');
    expect(document.activeElement).toBe(titleBtn());
  });

  it('caps the rename input at 40 and renders the title as text', () => {
    const { s } = mount(pinned({ title: '<b>x</b>' }));
    expect(titleBtn().textContent).toBe('<b>x</b>');
    expect(s.el.querySelector('b')).toBeNull();
    titleBtn().click();
    expect(input().maxLength).toBe(40);
  });

  it('header shows the needYou count only when something needs you', () => {
    const { s } = mount(pinned({ needYou: 2, rows: [row('job:a'), row('job:b'), row('job:c')] }));
    expect(s.el.querySelector('.ckb-need')!.textContent).toContain('2');
    expect(s.el.querySelector('.o-group-count')!.textContent).toBe('3');
    s.update(pinned({ needYou: 0 }));
    expect((s.el.querySelector('.ckb-need') as HTMLElement).hidden).toBe(true);
  });

  it('the remove button shows only while the pin is empty', () => {
    const { s, c } = mount(pinned({ title: 'Replay' }));
    const remove = s.el.querySelector('.ckb-pin-remove') as HTMLButtonElement;
    expect(remove.hidden).toBe(true);
    s.update(pinned({ title: 'Replay', rows: [] }));
    expect(remove.hidden).toBe(false);
    remove.click();
    expect(c.onRemove).toHaveBeenCalledWith('p1');
  });

  it('the grip is a labelled button', () => {
    const { s } = mount(pinned({ title: 'Replay' }));
    expect(s.el.querySelector('button.o-grip')!.getAttribute('aria-label')).toBe('Move Replay');
  });

  it('Other renders chips, or Nothing waiting when empty', () => {
    const other = { id: 'other', kind: 'other', title: 'Other', needYou: 1, rows: [
      row('other:a', { kindLabel: 'skill', title: 'code.fix-ci revision', tone: 'you' }),
    ] };
    const { s, c } = mount(other);
    const chip = s.el.querySelector('.ckb-chip') as HTMLButtonElement;
    expect(chip.dataset.rowKey).toBe('other:a');
    expect(chip.title).toBe('code.fix-ci revision');
    chip.click();
    expect(c.onChip).toHaveBeenCalledWith('other:a');
    s.update({ ...other, needYou: 0, rows: [] });
    expect(s.el.querySelector('.ckb-chip')).toBeNull();
    expect(s.el.querySelector('.ckb-none')!.textContent).toBe('Nothing waiting');
  });

  it('a skill chip names the action, with the detail in its tooltip', () => {
    const other = { id: 'other', kind: 'other', title: 'Other', needYou: 1, rows: [
      row('other:p', { kindLabel: 'skill', ref: 'code.implement', title: 'Proposal ready for review', tone: 'you' }),
    ] };
    const chip = mount(other).s.el.querySelector('.ckb-chip') as HTMLButtonElement;
    expect(chip.textContent).toBe('skillcode.implement');
    expect(chip.title).toBe('code.implement — Proposal ready for review');
  });

  it('Jobs exposes its two row groups, Pinned exposes one', () => {
    const jobs = { id: 'jobs', kind: 'jobs', title: 'Jobs', needYou: 0, groups: { started: [row('job:a')], notStarted: [row('job:z')] } };
    expect(mount(jobs).s.rowGroups().map((g: any) => g.id)).toEqual(['jobs:started', 'jobs:notStarted']);
    expect(mount(pinned()).s.rowGroups().map((g: any) => [g.id, g.rows.length])).toEqual([['pin:p1', 1]]);
  });
});
