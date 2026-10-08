import { createStore } from './create-store.js';
import { register, push } from './preferences.js';

export const VALID_THEMES = ['halcyon', 'almanac', 'terminal', 'nordic', 'ink', 'botanical', 'plasma', 'atlas', 'library'];
export const VALID_MODES = ['light', 'dark', 'system'];
// 'system' is stored as-is but never reaches <html data-mode>: CSS only knows
// light/dark, so it's resolved here and re-resolved when the OS flips.
const lightQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
function resolveMode(mode) {
  if (mode !== 'system') return mode;
  return lightQuery?.matches ? 'light' : 'dark';
}

// Keep <meta name="theme-color"> in sync with the active theme's --bg so the iOS
// Safari address bar / PWA status bar tint matches when the user switches palette.
export function syncThemeColorMeta() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}
// 'default' defers to whatever the `claude` binary picks (today's behavior —
// the daemon passes no --model flag). Named options let a session-spawn path
// that reads this later (⌘K palette, D5) pin a family without duplicating
// the exact model-id string this file has no authority over.
export const VALID_DEFAULT_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
// The command the DAEMON runs to open a checkout — it's the host that has the files, so
// this is a binary on that machine, not a URL scheme this browser can handle. Kept in sync
// with DEFAULT_EDITOR_COMMAND in src/git/open-in-editor.ts (the daemon's own fallback,
// used until the client seeds this key).
export const DEFAULT_EDITOR_COMMAND = 'code';

function loadTheme() {
  const v = localStorage.getItem('cr:theme');
  return VALID_THEMES.includes(v) ? v : 'halcyon';
}
function loadMode() {
  const v = localStorage.getItem('cr:mode');
  return VALID_MODES.includes(v) ? v : 'dark';
}
function loadDefaultApprovalMode() {
  const v = localStorage.getItem('cr:defaultApprovalMode');
  if (v === 'ask' || v === 'accept-edits' || v === 'plan' || v === 'bypass') return v;
  if (localStorage.getItem('cr:acceptEdits') === 'true') {
    localStorage.removeItem('cr:acceptEdits');
    localStorage.setItem('cr:defaultApprovalMode', 'accept-edits');
    return 'accept-edits';
  }
  return 'ask';
}
function loadDefaultModel() {
  const v = localStorage.getItem('cr:defaultModel');
  return VALID_DEFAULT_MODELS.includes(v) ? v : 'default';
}
function loadEditorCommand() {
  const v = localStorage.getItem('cr:editorCommand');
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_EDITOR_COMMAND;
}
function loadLaunchConcurrency() {
  const v = Number(localStorage.getItem('cr:launchConcurrency'));
  return Number.isInteger(v) && v >= 1 ? v : 1;
}
// Mirrors the daemon's own default (preferences-store.ts) — off until turned on. The mirror
// only decides whether the composer treats `!` as a command; the daemon enforces it either way.
function loadShellCommands() {
  return localStorage.getItem('cr:shellCommands') === 'true';
}
function loadImproverAutoApply() {
  return localStorage.getItem('cr:improverAutoApply') === 'true';
}
const DEFAULT_PR_REVIEW_INTAKE = { repos: [], reviewRequested: false };
function validPrReviewIntake(v) {
  return v && typeof v === 'object' && Array.isArray(v.repos)
    && v.repos.every((r) => typeof r === 'string') && typeof v.reviewRequested === 'boolean';
}
function loadPrReviewIntake() {
  try {
    const v = JSON.parse(localStorage.getItem('cr:prReviewIntake') ?? 'null');
    return validPrReviewIntake(v) ? v : DEFAULT_PR_REVIEW_INTAKE;
  } catch { return DEFAULT_PR_REVIEW_INTAKE; }
}

function loadPreapprovalDefaults() {
  try {
    const v = JSON.parse(localStorage.getItem('cr:preapprovalDefaults') ?? 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

const store = createStore({
  theme: loadTheme(),
  mode: loadMode(),
  defaultApprovalMode: loadDefaultApprovalMode(),
  defaultModel: loadDefaultModel(),
  editorCommand: loadEditorCommand(),
  launchConcurrency: loadLaunchConcurrency(),
  shellCommands: loadShellCommands(),
  improverAutoApply: loadImproverAutoApply(),
  prReviewIntake: loadPrReviewIntake(),
  preapprovalDefaults: loadPreapprovalDefaults(),
  acceptEdits: false,
  modePopoverOpen: false,
  pushPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  pushSubscribed: false,
  pushBusy: false,
  pushLastStatus: '',
});

// pre-paint script in index.html applies these on <html>; mirror so subscribers
// see the same source-of-truth from first read
document.documentElement.setAttribute('data-theme', store.get().theme);
document.documentElement.setAttribute('data-mode', resolveMode(store.get().mode));
lightQuery?.addEventListener?.('change', () => {
  if (store.get().mode !== 'system') return;
  document.documentElement.setAttribute('data-mode', resolveMode('system'));
  syncThemeColorMeta();
});

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('cr:theme', theme); } catch {}
  store.set((s) => (s.theme === theme ? s : { ...s, theme }));
}
function applyMode(mode) {
  if (!VALID_MODES.includes(mode)) return;
  document.documentElement.setAttribute('data-mode', resolveMode(mode));
  try { localStorage.setItem('cr:mode', mode); } catch {}
  store.set((s) => (s.mode === mode ? s : { ...s, mode }));
}
function applyDefaultApprovalMode(mode) {
  if (mode !== 'ask' && mode !== 'accept-edits' && mode !== 'plan' && mode !== 'bypass') return;
  try { localStorage.setItem('cr:defaultApprovalMode', mode); } catch {}
  store.set((s) => (s.defaultApprovalMode === mode ? s : { ...s, defaultApprovalMode: mode }));
}
function applyDefaultModel(model) {
  if (!VALID_DEFAULT_MODELS.includes(model)) return;
  try { localStorage.setItem('cr:defaultModel', model); } catch {}
  store.set((s) => (s.defaultModel === model ? s : { ...s, defaultModel: model }));
}
function applyEditorCommand(cmd) {
  if (typeof cmd !== 'string') return;
  const v = cmd.trim() || DEFAULT_EDITOR_COMMAND;
  try { localStorage.setItem('cr:editorCommand', v); } catch {}
  store.set((s) => (s.editorCommand === v ? s : { ...s, editorCommand: v }));
}
function applyLaunchConcurrency(n) {
  if (!Number.isInteger(n) || n < 1) return;
  try { localStorage.setItem('cr:launchConcurrency', String(n)); } catch {}
  store.set((s) => (s.launchConcurrency === n ? s : { ...s, launchConcurrency: n }));
}

function applyShellCommands(v) {
  if (typeof v !== 'boolean') return;
  try { localStorage.setItem('cr:shellCommands', String(v)); } catch {}
  store.set((s) => (s.shellCommands === v ? s : { ...s, shellCommands: v }));
}

function applyImproverAutoApply(v) {
  if (typeof v !== 'boolean') return;
  try { localStorage.setItem('cr:improverAutoApply', String(v)); } catch {}
  store.set((s) => (s.improverAutoApply === v ? s : { ...s, improverAutoApply: v }));
}

function applyPrReviewIntake(v) {
  if (!validPrReviewIntake(v)) return;
  try { localStorage.setItem('cr:prReviewIntake', JSON.stringify(v)); } catch {}
  store.set((s) => ({ ...s, prReviewIntake: v }));
}

// The daemon validates and enforces these; the mirror only seeds the Settings form and step cards.
function applyPreapprovalDefaults(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return;
  try { localStorage.setItem('cr:preapprovalDefaults', JSON.stringify(v)); } catch {}
  store.set((s) => ({ ...s, preapprovalDefaults: v }));
}

register({ key: 'theme', apply: applyTheme, current: () => store.get().theme });
register({ key: 'mode', apply: applyMode, current: () => store.get().mode });
register({ key: 'defaultApprovalMode', apply: applyDefaultApprovalMode, current: () => store.get().defaultApprovalMode });
register({ key: 'defaultModel', apply: applyDefaultModel, current: () => store.get().defaultModel });
register({ key: 'editorCommand', apply: applyEditorCommand, current: () => store.get().editorCommand });
register({ key: 'launchConcurrency', apply: applyLaunchConcurrency, current: () => store.get().launchConcurrency });
register({ key: 'shellCommands', apply: applyShellCommands, current: () => store.get().shellCommands });
register({ key: 'improverAutoApply', apply: applyImproverAutoApply, current: () => store.get().improverAutoApply });
register({ key: 'prReviewIntake', apply: applyPrReviewIntake, current: () => store.get().prReviewIntake });
register({ key: 'preapprovalDefaults', apply: applyPreapprovalDefaults, current: () => store.get().preapprovalDefaults });

export const settings = {
  get: store.get,
  set: store.set,
  subscribe: store.subscribe,

  setTheme(theme) {
    applyTheme(theme);
    push('theme', store.get().theme);
  },
  setMode(mode) {
    applyMode(mode);
    push('mode', store.get().mode);
  },
  setDefaultApprovalMode(mode) {
    applyDefaultApprovalMode(mode);
    push('defaultApprovalMode', store.get().defaultApprovalMode);
  },
  setDefaultModel(model) {
    applyDefaultModel(model);
    push('defaultModel', store.get().defaultModel);
  },
  setEditorCommand(cmd) {
    applyEditorCommand(cmd);
    push('editorCommand', store.get().editorCommand);
  },
  setLaunchConcurrency(n) {
    applyLaunchConcurrency(n);
    push('launchConcurrency', store.get().launchConcurrency);
  },
  setShellCommands(v) {
    applyShellCommands(!!v);
    push('shellCommands', store.get().shellCommands);
  },
  setImproverAutoApply(v) {
    applyImproverAutoApply(!!v);
    push('improverAutoApply', store.get().improverAutoApply);
  },
  setPrReviewIntake(v) {
    applyPrReviewIntake(v);
    push('prReviewIntake', store.get().prReviewIntake);
  },
  // The daemon enforces these, so a value it refused must not linger locally looking saved.
  async setPreapprovalDefaults(v) {
    const prev = store.get().preapprovalDefaults;
    applyPreapprovalDefaults(v);
    const ok = await push('preapprovalDefaults', v);
    if (!ok) applyPreapprovalDefaults(prev);
    return ok;
  },
  applyLaunchConcurrency,
  setAcceptEdits(v) {
    store.set((s) => ({ ...s, acceptEdits: !!v }));
  },
  setModePopoverOpen(v) {
    store.set((s) => ({ ...s, modePopoverOpen: !!v }));
  },
  setPushState(patch) {
    store.set((s) => ({ ...s, ...patch }));
  },
};
