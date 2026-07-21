// Settings view-model: pure functions deriving the sections-column nav shape
// and each detail card's rows from raw store/API data. No DOM, no layout —
// shared by the desktop Settings surface today and the mobile "More > Settings"
// pushed screens in P3 (D2).

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
      { key: 'permissions', label: 'Permissions', icon: '◉' },
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
];

// `warnFlags` is `{ [sectionKey]: boolean }` — currently only 'mcp' is ever
// true (an unreachable MCP server), computed by the caller from grants store
// state so this stays a pure function of already-derived booleans.
export function settingsSections(warnFlags = {}) {
  return SETTINGS_SECTIONS.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, warn: !!warnFlags[item.key] })),
  }));
}

const GROUP_ORDER = ['core', 'read', 'pull', 'edit', 'push'];
const GROUP_TONE = { core: 'core', read: 'read', pull: 'pull', edit: 'edit', push: 'push' };

export function permissionGroupRows(groups = []) {
  return [...groups]
    .sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name))
    .map((g) => ({
      name: g.name,
      description: g.description ?? '',
      actionCount: g.actionCount ?? 0,
      tone: GROUP_TONE[g.name] ?? 'core',
    }));
}

function basenameOf(p) {
  if (typeof p !== 'string' || !p) return p;
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function scopeLabel(scope) {
  if (scope === 'global') return 'global';
  if (scope && typeof scope === 'object') {
    if (scope.project) return `project · ${basenameOf(scope.project)}`;
    if (scope.action) return `action · ${scope.action}`;
  }
  return 'unknown';
}

// No addedAt/expiry metadata exists on allowlist rules (Allowlist.toConfig()
// returns bare pattern arrays) — lifecycle is always 'permanent' per D4.4;
// don't fabricate timestamps the mockup shows but the backend can't back.
export function allowlistRuleRows(rules = []) {
  return rules.map((r, i) => ({
    id: `${r.kind}:${r.value}:${i}`,
    kind: r.kind,
    pattern: r.value,
    scopeText: scopeLabel(r.scope),
    lifecycle: 'permanent',
  }));
}

const MCP_LABEL = { ok: 'Connected', configured: 'Configured (stdio)', unreachable: 'Unreachable' };
const MCP_TONE = { ok: 'ok', configured: 'ok', unreachable: 'danger' };

export function mcpServerRows(servers = []) {
  return [...servers]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((s) => ({
      name: s.name,
      transport: s.transport,
      status: s.status,
      statusLabel: MCP_LABEL[s.status] ?? s.status,
      tone: MCP_TONE[s.status] ?? 'warn',
    }));
}
