import { nav } from '../../state/nav.js';
import { renderPlaceholder } from './placeholder.js';
import { renderDetail as renderCockpitDetail } from '../cockpit/index.js';
import { renderList as renderTrackedList, renderDetail as renderTrackedDetail, renderContext as renderTrackedContext } from '../tracked/index.js';
import { renderList as renderSessionsSurfaceList, renderDetail as renderSessionsSurfaceDetail, renderContext as renderSessionsSurfaceContext } from '../sessions-surface/index.js';
import { renderList as renderSchedulesList, renderDetail as renderSchedulesDetail } from '../schedules/index.js';
import { renderSkillsList, renderSkillsDetail, renderRunsDetail } from '../library/index.js';
import { renderList as renderSettingsList, renderDetail as renderSettingsDetail } from '../settings-surface/index.js';

// Surface registry + frame (D2's "shell" layer for the desktop redesign).
// A registry entry describes one sidebar destination:
//   { key, title, layout: 'main-only'|'list-detail-context'|'list-detail',
//     renderList?(mount, deps), renderDetail?(mount, deps), renderContext?(mount, deps) }
// renderDetail's `deps.selection` is the current nav.selectionBySurface[key].
// Layout column count per surface is fixed by the redesign spec's column
// table, not chosen by the entry itself, so callers can't accidentally
// mismatch chrome vs. content.

const registry = new Map();

export function registerSurface(entry) {
  registry.set(entry.key, entry);
}

function placeholderEntry(key) {
  return {
    key,
    title: key,
    layout: 'main-only',
    renderDetail: (mount) => placeholderMain(mount, key, 'Unknown surface.'),
  };
}

function placeholderMain(mount, title, body) {
  renderPlaceholder(mount, title, body);
}

registerSurface({
  key: 'sessions',
  title: 'Sessions',
  layout: 'list-detail-context',
  renderList: renderSessionsSurfaceList,
  renderDetail: renderSessionsSurfaceDetail,
  renderContext: renderSessionsSurfaceContext,
});

registerSurface({
  key: 'tracked',
  title: 'Tracked',
  layout: 'list-detail-context',
  renderList: renderTrackedList,
  renderDetail: renderTrackedDetail,
  renderContext: renderTrackedContext,
});

registerSurface({
  key: 'skills',
  title: 'Skills',
  layout: 'list-detail',
  renderList: renderSkillsList,
  renderDetail: renderSkillsDetail,
});

registerSurface({
  key: 'cockpit',
  title: 'Cockpit',
  layout: 'main-only',
  renderDetail: renderCockpitDetail,
});

registerSurface({
  key: 'runs',
  title: 'Runs history',
  layout: 'main-only',
  renderDetail: renderRunsDetail,
});

registerSurface({
  key: 'schedules',
  title: 'Schedules',
  layout: 'list-detail',
  renderList: renderSchedulesList,
  renderDetail: renderSchedulesDetail,
});

registerSurface({
  key: 'settings',
  title: 'Settings',
  layout: 'list-detail',
  renderList: renderSettingsList,
  renderDetail: renderSettingsDetail,
});

// ── Frame: mounts sidebar-adjacent list/detail/context columns per the active
// surface's layout, and reacts to nav changes without tearing down live
// content unnecessarily (a surface switch rebuilds; a selection change within
// the same surface only re-invokes renderDetail).
export function mountSurfaceFrame(root) {
  root.classList.add('o-frame');

  let builtSurface = null;
  let lastSelection;
  let listEl = null; let detailEl = null; let contextEl = null;
  let listUnmount = null; let detailUnmount = null; let contextUnmount = null;
  // Generation counter for async renderDetail results: a promise resolving
  // after the selection (or surface) has moved on must not install its unmount
  // over the newer render's — it gets invoked immediately instead.
  let detailGen = 0;

  // Safety net: anything carrying __svHandle that leaves the frame's DOM tree
  // by a path other than our own teardown() (shouldn't happen, but matches the
  // hygiene shell/workspace.js established for the pane system) gets unmounted
  // so session-view WS refcounts can't leak.
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const removed of rec.removedNodes) {
        if (!(removed instanceof HTMLElement)) continue;
        unmountHandlesInTree(removed);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  function teardown() {
    detailGen++;
    try { listUnmount?.(); } catch { /* ignore */ }
    try { detailUnmount?.(); } catch { /* ignore */ }
    try { contextUnmount?.(); } catch { /* ignore */ }
    listUnmount = null; detailUnmount = null; contextUnmount = null;
    root.textContent = '';
    listEl = null; detailEl = null; contextEl = null;
  }

  function build(layout, entry) {
    root.dataset.surfaceLayout = layout;
    if (layout !== 'main-only') {
      listEl = document.createElement('section');
      listEl.className = 'o-frame-list';
      // Consumed by list chrome helpers (shell/list-filter.js's header) so a
      // generic list column can label itself without importing this registry
      // back (would be circular).
      listEl.dataset.surfaceTitle = entry.title ?? '';
      root.appendChild(listEl);
      installListResize(listEl);
    }
    detailEl = document.createElement('main');
    detailEl.className = 'o-frame-detail';
    root.appendChild(detailEl);
    if (layout === 'list-detail-context') {
      contextEl = document.createElement('aside');
      contextEl.className = 'o-frame-context';
      root.appendChild(contextEl);
    }
  }

  // The handle lives on the frame root, absolutely positioned over the
  // list/detail boundary — NOT inside the list mount, where every surface's
  // renderList would wipe it on its first innerHTML/textContent reset.
  function installListResize(el) {
    document.documentElement.style.setProperty('--nav-list-w', `${nav.get().listWidth}px`);
    const handle = document.createElement('div');
    handle.className = 'o-frame-list-resize';
    handle.setAttribute('aria-hidden', 'true');
    root.appendChild(handle);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      const onMove = (ev) => nav.setListWidth(startW + (ev.clientX - startX));
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function paint() {
    const { surface, selectionBySurface } = nav.get();
    const entry = registry.get(surface) ?? placeholderEntry(surface);
    const sel = selectionBySurface[surface] ?? null;

    if (builtSurface !== surface) {
      teardown();
      build(entry.layout, entry);
      builtSurface = surface;
      lastSelection = undefined;
      if (entry.renderList && listEl) {
        const ret = entry.renderList(listEl, {});
        listUnmount = typeof ret === 'function' ? ret : null;
      }
      if (entry.renderContext && contextEl) {
        const ret = entry.renderContext(contextEl, {});
        contextUnmount = typeof ret === 'function' ? ret : null;
      }
    }
    document.documentElement.style.setProperty('--nav-list-w', `${nav.get().listWidth}px`);
    root.classList.toggle('context-collapsed', !!nav.get().contextCollapsed);

    if (entry.renderDetail && detailEl && sel !== lastSelection) {
      lastSelection = sel;
      // Contract: each renderDetail's returned unmount runs before the next
      // renderDetail for the same surface — surfaces don't need to hand-roll
      // mount-attached cleanup for the selection-change case.
      try { detailUnmount?.(); } catch { /* ignore */ }
      detailUnmount = null;
      const gen = ++detailGen;
      const ret = entry.renderDetail(detailEl, { selection: sel });
      if (ret && typeof ret.then === 'function') {
        ret.then((unmountFn) => {
          if (typeof unmountFn !== 'function') return;
          if (gen !== detailGen) { try { unmountFn(); } catch { /* ignore */ } return; }
          detailUnmount = unmountFn;
        });
      } else if (typeof ret === 'function') {
        detailUnmount = ret;
      }
    }
  }

  paint();
  const unsubNav = nav.subscribe(paint);
  return () => { unsubNav(); teardown(); observer.disconnect(); };
}

function unmountHandlesInTree(node) {
  if (node.__svHandle) { try { node.__svHandle.unmount(); } catch { /* ignore */ } node.__svHandle = null; }
  for (const child of node.children ?? []) unmountHandlesInTree(child);
}
