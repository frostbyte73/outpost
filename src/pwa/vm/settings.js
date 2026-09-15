// Settings view-model: pure functions deriving the sections-column nav shape
// and each detail card's rows from raw store/API data. No DOM, no layout —
// shared by the desktop Settings surface today and the mobile "More > Settings"
// pushed screens in P3 (D2).

import { KEYMAP_COMMANDS, DEFAULT_BINDINGS } from '../state/keymap-commands.js';

export const SETTINGS_SECTIONS = [
  {
    label: 'Appearance',
    items: [
      { key: 'theme', label: 'Theme', icon: '◐' },
      { key: 'density', label: 'Density', icon: '▤' },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { key: 'model-defaults', label: 'Model defaults', icon: '◇' },
      { key: 'editor', label: 'External editor', icon: '✎' },
      { key: 'permissions', label: 'Permissions', icon: '◉' },
      { key: 'claude-account', label: 'Claude account', icon: '✦' },
      { key: 'mcp', label: 'MCP connections', icon: '◈' },
      { key: 'notifications', label: 'Notifications', icon: '✉' },
      { key: 'projects', label: 'Projects', icon: '▣' },
    ],
  },
  {
    label: 'Daemon',
    items: [
      { key: 'tailscale', label: 'Tailscale', icon: '⬡' },
      { key: 'health', label: 'Health & logs', icon: '◔' },
      { key: 'advanced', label: 'Advanced', icon: '⚙' },
    ],
  },
  {
    label: 'Hotkeys',
    desktopOnly: true,
    items: [
      { key: 'hotkeys', label: 'Keyboard shortcuts', icon: '⌨' },
    ],
  },
];

// `warnFlags` is `{ [sectionKey]: boolean }` — 'mcp' (an unreachable MCP server) and
// 'permissions' (an unresolved denial waiting on a verdict) today, computed by the caller from
// grants store state so this stays a pure function of already-derived booleans.
export function settingsSections(warnFlags = {}, desktop = true) {
  return SETTINGS_SECTIONS
    .filter((group) => desktop || !group.desktopOnly)
    .map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, warn: !!warnFlags[item.key] })),
    }));
}

const MCP_LABEL = { ok: 'Connected', configured: 'Configured (stdio)', unreachable: 'Unreachable' };
const MCP_TONE = { ok: 'ok', configured: 'ok', unreachable: 'danger' };

// Warn this far ahead of an expiry, so a lapse is something you re-authorize on your own
// schedule rather than discover from a job failing mid-step.
const MCP_EXPIRY_WARN_MS = 2 * 24 * 60 * 60 * 1000;

// A server with no refresh token cannot renew itself, so every expiry is a manual login. One
// WITH a refresh token renews silently and its access-token expiry is not worth a badge.
function credentialNote(cred, now) {
  if (!cred) return null;
  if (!cred.hasAccessToken) return { label: 'Not authorized', tone: 'danger', due: true };
  if (cred.expiresAt === undefined) return null;
  const ms = cred.expiresAt - now;
  if (ms <= 0) return { label: 'Expired', tone: 'danger', due: true };
  if (cred.hasRefreshToken) return null;
  const hours = Math.round(ms / 3600000);
  const label = hours < 48 ? `Expires in ${hours}h` : `Expires in ${Math.round(hours / 24)}d`;
  return { label, tone: ms < MCP_EXPIRY_WARN_MS ? 'warn' : 'ok', due: ms < MCP_EXPIRY_WARN_MS };
}

export function mcpServerRows(servers = [], now = Date.now()) {
  return [...servers]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((s) => {
      const note = credentialNote(s.credential, now);
      return {
        name: s.name,
        transport: s.transport,
        status: s.status,
        statusLabel: MCP_LABEL[s.status] ?? s.status,
        tone: MCP_TONE[s.status] ?? 'warn',
        // Only an OAuth server has a grant to renew: stdio carries creds in its env and a
        // header-authenticated server carries a token, so offering either a login would be a
        // button that cannot help.
        canReauth: s.auth === 'oauth',
        authNote: s.auth === 'header' ? 'token header' : s.auth === 'stdio' ? 'env credentials' : null,
        credentialLabel: note?.label ?? null,
        credentialTone: note?.tone ?? null,
        needsAttention: !!note?.due,
      };
    });
}

export function mcpNeedsAttention(servers = [], now = Date.now()) {
  return mcpServerRows(servers, now).some((r) => r.needsAttention);
}

// Claude Code's own sign-in. A recorded failure outranks a `loggedIn` of true, because that
// flag reports only that a credential is stored — the case this whole panel exists for is a
// stored credential the server has stopped honouring.
export function claudeAccountRow(auth) {
  if (!auth) return null;
  const account = auth.account ?? {};
  const failed = !!auth.failedSince;
  const title = account.email || (account.loggedIn ? 'Signed in' : 'Not signed in');
  const sub = [account.orgName, account.subscriptionType, account.authMethod].filter(Boolean).join(' · ');
  if (failed) {
    return {
      title, sub: sub || null, tone: 'danger', statusLabel: 'Needs re-authorizing',
      needsAttention: true, failedSince: auth.failedSince,
      note: 'A session failed to authenticate. Sessions will keep failing until you sign in again.',
    };
  }
  // A probe that couldn't run says nothing about the account, so it must not read as a lapse.
  if (account.error) {
    return {
      title: 'Account state unknown', sub: null, tone: 'warn', statusLabel: 'Unknown',
      needsAttention: false, failedSince: null,
      note: `Could not read it from the CLI: ${account.error}`,
    };
  }
  if (!account.loggedIn) {
    return {
      title, sub: sub || null, tone: 'danger', statusLabel: 'Signed out',
      needsAttention: true, failedSince: null,
      note: 'No usable credential — nothing can spawn a session until you sign in.',
    };
  }
  return { title, sub: sub || null, tone: 'ok', statusLabel: 'Signed in', needsAttention: false, failedSince: null, note: null };
}

const CONNECTOR_LABEL = {
  connected: 'Connected',
  'needs-auth': 'Needs authorization',
  pending: 'Pending approval',
  error: 'Unreachable',
};
const CONNECTOR_TONE = { connected: 'ok', 'needs-auth': 'danger', pending: 'warn', error: 'danger' };

// claude.ai connectors. `relevant` is the ones connected now or previously — the default view,
// because the ~20 never touched are noise next to the handful actions actually depend on.
export function mcpConnectorRows(connectors = [], { showAll = false } = {}) {
  const rows = connectors.map((c) => ({
    name: c.name,
    // The "claude.ai " prefix is on every row; repeating it in each title is pure noise.
    label: c.name.startsWith('claude.ai ') ? c.name.slice('claude.ai '.length) : c.name,
    status: c.status,
    statusLabel: CONNECTOR_LABEL[c.status] ?? c.status,
    tone: CONNECTOR_TONE[c.status] ?? 'warn',
    relevant: !!c.relevant,
    needsAttention: c.status === 'needs-auth' && !!c.relevant,
  }));
  return showAll ? rows : rows.filter((r) => r.relevant);
}

export function mcpConnectorsHidden(connectors = []) {
  return connectors.filter((c) => !c.relevant).length;
}

const HOTKEY_SURFACE_ORDER = ['shell', 'session', 'palette', 'diff'];
const HOTKEY_SURFACE_LABELS = { shell: 'Shell', session: 'Session', palette: 'Palette', diff: 'Diff review' };

// Pure grouping of the command catalog + user overrides into per-surface row
// groups for the Hotkeys settings page. No DOM.
export function hotkeyRows(overrides = {}) {
  return HOTKEY_SURFACE_ORDER.map((surface) => ({
    surface,
    surfaceLabel: HOTKEY_SURFACE_LABELS[surface] ?? surface,
    rows: KEYMAP_COMMANDS
      .filter((c) => c.surface === surface)
      .map((c) => {
        const binding = overrides[c.id] ?? DEFAULT_BINDINGS[c.id];
        return {
          id: c.id,
          label: c.label,
          description: c.description,
          binding,
          isDefault: binding === DEFAULT_BINDINGS[c.id],
        };
      }),
  }));
}
