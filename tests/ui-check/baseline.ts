import type { Finding } from './static.js';

export type Baseline = Record<string, number>;

// Rendered details carry ports, ids and counts that change run to run; static details
// (`12px` vs `16px`) are the point of the key, so they're kept verbatim.
export function normalize(detail: string): string {
  return detail
    .replace(/https?:\/\/[^\s'")]+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>');
}

export function keyOf(f: Finding): string {
  const rendered = f.category === 'a11y' || f.category === 'overflow' || f.category === 'console';
  return [f.category, f.rule, f.where, f.locator, rendered ? normalize(f.detail) : f.detail].join('|');
}

export function toBaseline(findings: Finding[]): Baseline {
  const counts: Baseline = {};
  for (const f of findings) counts[keyOf(f)] = (counts[keyOf(f)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function diffBaseline(findings: Finding[], base: Baseline) {
  const seen: Record<string, number> = {};
  const fresh: Finding[] = [];
  const known: Finding[] = [];
  for (const f of findings) {
    const k = keyOf(f);
    seen[k] = (seen[k] ?? 0) + 1;
    (seen[k] <= (base[k] ?? 0) ? known : fresh).push(f);
  }
  const stale = Object.entries(base)
    .filter(([k, n]) => n > (seen[k] ?? 0))
    .map(([k, n]): [string, number] => [k, n - (seen[k] ?? 0)]);
  return { fresh, known, stale };
}
