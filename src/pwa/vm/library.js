// Skills-library view-model (D2): pure derivation over state/actions.js's
// three raw lists — `actions` (on-disk Outpost actions: description/category/
// skillMd/merged allowlist), `catalog` (registry view: runner/permissions/
// schema/base allowlist), and `skills` (non-Outpost skills discovered under
// ~/.claude/skills, category 'custom' by convention). Zero DOM.

function catalogByName(state) {
  const map = new Map();
  for (const a of state.catalog ?? []) map.set(a.name, a);
  return map;
}

// One row shape for both Outpost actions and external skills so the list/
// detail renderers don't need to branch on origin.
export function skillCatalog(state) {
  const byName = catalogByName(state);
  const fromActions = (state.actions ?? []).map((a) => {
    const cat = byName.get(a.name);
    return {
      name: a.name,
      category: a.category,
      description: a.description ?? '',
      skillMd: a.skillMd ?? '',
      allowlist: a.allowlist ?? cat?.allowlist ?? {},
      runner: cat?.runner ?? 'claude',
      permissions: cat?.permissions ?? [],
      humanGate: cat?.human_gate ?? false,
      sideEffects: cat?.side_effects ?? 'none',
      kind: 'action',
    };
  });
  const fromSkills = (state.skills ?? []).map((s) => ({
    name: s.name,
    category: 'custom',
    description: s.description ?? '',
    skillMd: s.skillMd ?? '',
    allowlist: {},
    runner: 'claude',
    permissions: [],
    humanGate: false,
    sideEffects: 'none',
    kind: 'skill',
  }));
  return [...fromActions, ...fromSkills].sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSkills(items, { q, category, kind } = {}) {
  const needle = (q ?? '').trim().toLowerCase();
  return items.filter((it) => {
    if (kind && it.kind !== kind) return false;
    if (category && category !== 'all' && it.category !== category) return false;
    if (!needle) return true;
    return it.name.toLowerCase().includes(needle) || it.description.toLowerCase().includes(needle);
  });
}

export function skillByName(state, name) {
  return skillCatalog(state).find((it) => it.name === name) ?? null;
}

// Ordered group names an item inherits — 'core' implicit for claude runners.
// Mirrors src/routes/meta.ts's groupNamesForAction; duplicated client-side
// since the server only exposes per-group action *counts*, not the reverse
// per-action group list.
export function permissionGroupNames(item) {
  const names = [];
  if (item.runner === 'claude') names.push('core');
  for (const g of item.permissions ?? []) if (g !== 'core') names.push(g);
  return names;
}

export function allowlistRuleCount(allowlist) {
  if (!allowlist) return 0;
  return (allowlist.alwaysAllow?.length ?? 0)
    + (allowlist.alwaysAllowBashPatterns?.length ?? 0)
    + (allowlist.alwaysAllowMcpPatterns?.length ?? 0)
    + (allowlist.alwaysAllowPathPatterns?.length ?? 0);
}

// Strips a leading `---\n...\n---\n` YAML frontmatter block before
// markdown-rendering a SKILL.md body (name/description are already surfaced
// by the header — same transform as the legacy work/actions-list.js editor).
export function stripFrontmatter(md) {
  const m = String(md ?? '').match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
