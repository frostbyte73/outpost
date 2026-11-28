import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CssSyntaxError } from 'postcss';
import { diffBaseline, toBaseline, type Baseline } from './baseline.js';
import { HarnessError, scanRendered } from './rendered.js';
import { scanTree, type Category, type Finding } from './static.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BASELINE_PATH = join(HERE, 'baseline.json');
const CATEGORIES: Category[] = ['a11y', 'overflow', 'off-token', 'generic-ai', 'console'];
const STATIC_CATEGORIES = new Set<string>(['off-token', 'generic-ai']);
const FLAGS = new Set(['--static-only', '--rendered-only', '--update-baseline', '--json', '--verbose']);
const USAGE = `usage: npm run ui:check -- [${[...FLAGS].join('] [')}]`;

function line(tag: string, f: Finding): string {
  const where = f.line ? `${f.where}:${f.line}` : f.where;
  return `  ${tag}  ${where}  ${f.locator}  ${f.rule} — ${f.detail}`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !FLAGS.has(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  const staticOnly = args.includes('--static-only');
  const renderedOnly = args.includes('--rendered-only');
  if (staticOnly && renderedOnly) {
    console.error(`--static-only and --rendered-only are exclusive\n${USAGE}`);
    return 2;
  }

  const findings = [
    ...(renderedOnly ? [] : scanTree(REPO_ROOT)),
    ...(staticOnly ? [] : await scanRendered()),
  ];
  const all: Baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
  const scanned = ([k]: [string, number]) => {
    const isStatic = STATIC_CATEGORIES.has(k.split('|')[0] ?? '');
    return staticOnly ? isStatic : renderedOnly ? !isStatic : true;
  };
  const base: Baseline = Object.fromEntries(Object.entries(all).filter(scanned));

  if (args.includes('--update-baseline')) {
    // A partial run keeps the other half's keys so it can't wipe them.
    const keep = Object.entries(all).filter((e) => !scanned(e));
    const next = toBaseline(findings);
    const merged = Object.fromEntries([...keep, ...Object.entries(next)].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + '\n');
    console.log(`ui:check — baseline written: ${findings.length} findings, ${Object.keys(merged).length} keys`);
    return 0;
  }

  const { fresh, known, stale } = diffBaseline(findings, base);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ fresh, known, stale }, null, 2));
    return fresh.length ? 1 : 0;
  }

  const verbose = args.includes('--verbose');
  const out = [`ui:check — ${fresh.length} new, ${known.length} baselined, ${stale.length} stale`];
  for (const cat of CATEGORIES) {
    const nf = fresh.filter((f) => f.category === cat);
    const nk = known.filter((f) => f.category === cat);
    out.push('', `## ${cat} (${nf.length} new${nk.length ? `, ${nk.length} baselined` : ''})`);
    for (const f of nf) out.push(line('NEW', f));
    if (verbose) for (const f of nk) out.push(line('OK ', f));
  }
  if (stale.length) {
    out.push('', '## stale baseline (run npm run ui:check -- --update-baseline)');
    for (const [k, n] of stale) out.push(`  ${n}×  ${k}`);
  }
  console.log(out.join('\n'));
  return fresh.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    const known = e instanceof HarnessError || e instanceof CssSyntaxError;
    console.error(`ui:check: ${known ? e.message : (e as Error).stack}`);
    process.exit(2);
  },
);
