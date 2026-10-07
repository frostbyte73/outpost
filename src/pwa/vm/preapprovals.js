// Mirrors src/work/preapprovals.ts; the daemon re-validates everything this produces.

const GATED = { spec: 'gate', push: false, openPr: false, replies: false, merge: false, syncBase: false, landing: 'merged' };
const KEYS = ['spec', 'push', 'openPr', 'replies', 'merge', 'syncBase', 'landing'];
const SPEC_ORDER = ['gate', 'auto', 'skip'];
const LANDING_ORDER = ['merged', 'approved', 'direct'];
const LABELS = { push: 'push', openPr: 'open PR', replies: 'replies', merge: 'merge', syncBase: 'merge base in' };

export const PRESETS = {
  gated: { ...GATED },
  routine: { spec: 'skip', push: true, openPr: true, replies: true, merge: false, syncBase: false, landing: 'approved' },
  personal: { spec: 'auto', push: true, openPr: false, replies: false, merge: false, syncBase: false, landing: 'direct' },
};

function defined(p) {
  return Object.fromEntries(KEYS.filter((k) => p?.[k] !== undefined).map((k) => [k, p[k]]));
}

// Later layers win: Settings default, then job, then step.
export function effective(...layers) {
  return Object.assign({ ...GATED }, ...layers.map(defined));
}

export function presetOf(p) {
  const e = effective(p);
  const hit = Object.entries(PRESETS).find(([, v]) => KEYS.every((k) => v[k] === e[k]));
  return hit ? hit[0] : 'custom';
}

export function loosened(proposed, ...ceiling) {
  const c = effective(...ceiling);
  return KEYS.filter((k) => {
    const v = proposed?.[k];
    if (v === undefined) return false;
    if (k === 'spec') return SPEC_ORDER.indexOf(v) > SPEC_ORDER.indexOf(c.spec);
    if (k === 'landing') return LANDING_ORDER.indexOf(v) > LANDING_ORDER.indexOf(c.landing);
    return v === true && !c[k];
  });
}

export function summaryLabel(p) {
  const preset = presetOf(p);
  if (preset !== 'custom') return preset[0].toUpperCase() + preset.slice(1);
  const e = effective(p);
  const parts = [];
  if (e.spec !== 'gate') parts.push(`spec ${e.spec}`);
  for (const k of ['push', 'openPr', 'replies', 'merge', 'syncBase']) if (e[k]) parts.push(LABELS[k]);
  if (e.landing !== 'merged') parts.push(e.landing);
  return parts.join(' · ');
}
