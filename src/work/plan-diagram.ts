import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every colour slot d2 has, painted from the PWA theme token named beside it (base.css), so a
// diagram uses exactly the user's palette: text and lines from the text/line ladder, containers and
// shapes on the elevation surfaces, strokes in the accent. With all 18 slots overridden the d2
// base theme carries no colour at all — only Terminal (300) still differs, in its mono caps and
// pattern fill, which is why it's the one theme that picks a base.
export const D2_SLOTS: Record<string, string> = {
  N1: 'text', N2: 'text-mute', N3: 'text-dim', N4: 'line', N5: 'line-soft', N6: 'bg-elev', N7: 'bg',
  B1: 'accent', B2: 'accent', B3: 'bg-elev-2', B4: 'bg-elev-2', B5: 'line-soft', B6: 'bg-elev',
  AA2: 'accent-2', AA4: 'bg-elev-2', AA5: 'bg-elev', AB4: 'bg-elev-2', AB5: 'bg-elev',
};

export const d2ThemeFor = (theme: string | null): number => (theme === 'terminal' ? 300 : 0);

// The token values come off a query string, so anything but `#rrggbb` leaves that slot to the base.
export function themeOverrides(token: (name: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, name] of Object.entries(D2_SLOTS)) {
    const v = token(name);
    if (v && /^#[0-9a-f]{6}$/i.test(v)) out[slot] = v;
  }
  return out;
}

const MAX_SOURCE = 20_000;
const CACHE_MAX = 50;

// The source is model-written and d2 runs on the daemon's host, so two d2 features are refused
// before it ever runs. An import (`x: @f`, `...@f`) reads a .d2 file from disk and `..` walks
// out of any cwd, so a diagram label could carry a local file into the PWA. An `icon:` is a URL
// d2 fetches at render time — a network request whose target the model picks. The empty cwd
// below is the second layer, not the first: it does nothing against `@../../`.
export function diagramRefusal(src: string): string | null {
  if (src.length > MAX_SOURCE) return `findings.diagram is ${src.length} characters; the cap is ${MAX_SOURCE}. Draw only the flow the change touches.`;
  if (/(?:^|[:{;[]|\.\.\.)\s*@/m.test(src)) return 'findings.diagram may not use d2 imports (`@file`, `...@file`): write the whole diagram inline.';
  if (/\bicon\s*:/.test(src)) return 'findings.diagram may not use `icon:` (d2 fetches it over the network): use a plain shape and a label.';
  return null;
}

let emptyCwd: string | undefined;
const cache = new Map<string, Promise<string>>();

// Throws on a refusal, a compile error (message is d2's own, line:col included), or a missing
// binary (`code === 'ENOENT'` — callers treat that as "no diagrams on this host", not a bad plan).
// `overrides` (from themeOverrides — validated hex only) are appended rather than prepended: d2
// merges a repeated `vars` map and the last one wins, so the model's own `theme-overrides` can't
// undo them, and its line numbers in errors stay put.
export function renderDiagram(src: string, themeId: number, overrides: Record<string, string> = {}): Promise<string> {
  const refusal = diagramRefusal(src);
  if (refusal) return Promise.reject(new Error(refusal));
  const slots = Object.entries(overrides).map(([k, v]) => `${k}: "${v}"`).join('; ');
  if (slots) src += `\nvars: {d2-config: {theme-overrides: {${slots}}}}\n`;
  const key = `${themeId}\0${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  emptyCwd ??= mkdtempSync(join(tmpdir(), 'outpost-d2-'));
  const p = new Promise<string>((resolve, reject) => {
    const child = execFile('d2', ['--layout', 'tala', '--theme', String(themeId), '--pad', '16', '--omit-version', '--no-xml-tag', '-', '-'],
      { cwd: emptyCwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = String(stderr).split('\n').find((l) => l.startsWith('err:'))?.replace(/^err:\s*/, '');
        reject(Object.assign(new Error(msg ?? err.message), { code: (err as NodeJS.ErrnoException).code }));
      });
    child.stdin?.end(src);
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

// submit_plan's check: a diagram that won't compile is the model's to fix, so it comes back as the
// tool error. A host without d2 drops the diagram instead — planning must not hinge on an extra.
export async function checkPlanDiagram(findings: { diagram?: unknown } | undefined): Promise<void> {
  if (!findings || findings.diagram === undefined) return;
  if (typeof findings.diagram !== 'string' || !findings.diagram.trim()) { delete findings.diagram; return; }
  try {
    await renderDiagram(findings.diagram, d2ThemeFor(null));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[plan-diagram] d2 is not installed; dropping findings.diagram (brew install d2)');
      delete findings.diagram;
      return;
    }
    throw new Error(`findings.diagram did not compile: ${(err as Error).message}. Fix the d2 source and submit the plan again.`);
  }
}
