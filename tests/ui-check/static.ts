import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type ChildNode, type Container } from 'postcss';

export type Category = 'a11y' | 'overflow' | 'off-token' | 'generic-ai' | 'console';

export interface Finding {
  category: Category;
  rule: string;
  where: string;
  locator: string;
  detail: string;
  line?: number;
}

// DESIGN.md §4.1 spacing steps and §5 radius steps — the px values a token already names.
const SPACING_TOKENS = new Set([4, 8, 12, 16, 24, 32, 48]);
const RADIUS_TOKENS = new Set([4, 8, 999]);
const HAIRLINE_PX = new Set([0, 1, 2]);

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const RGB = /\brgba?\([^)]*\)/gi;
const HSL = /\bhsla?\([^)]*\)/gi;
const NAMED = /(?<![\w-])(white|black|red|green|blue|gray|grey|purple|orange|yellow|pink|silver|navy)(?![\w-])/gi;
const COLOR_PROP = /color|background|border|outline|fill|stroke|shadow|caret|^--/;
const SPACING_PROP = /^(padding|margin)(-|$)|^(row-|column-)?gap$|^inset|^(top|right|bottom|left)$/;
const RADIUS_PROP = /^border(-[a-z]+)*-radius$/;
const PX = /(\d+(?:\.\d+)?)px/g;
const VAR_NAME = /var\(\s*(--[\w-]+)/g;
const NEUTRAL_TOKEN = /^--(bg|line|text)/;
const ALLOWED_SHADOW = [
  /^none$/,
  /^var\(--shadow-pop\)$/,
  /^inset\s+(?:0\s+-?\d+px|-?\d+px\s+0)\s+0\s+var\(/,
  /^(inset\s+)?0\s+0\s+0\s+\d+px\s+var\(/,
];

// Quoted strings and url() bodies can hold '#' or px that aren't values.
function stripOpaque(value: string): string {
  return value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/url\([^)]*\)/gi, 'url()');
}

function colorLiterals(value: string, withNamed: boolean): Array<{ rule: string; text: string }> {
  const out: Array<{ rule: string; text: string }> = [];
  for (const m of value.matchAll(HEX)) out.push({ rule: 'hex-color', text: m[0] });
  for (const m of value.matchAll(RGB)) out.push({ rule: 'rgb-color', text: m[0] });
  for (const m of value.matchAll(HSL)) out.push({ rule: 'hsl-color', text: m[0] });
  if (withNamed) for (const m of value.matchAll(NAMED)) out.push({ rule: 'named-color', text: m[0] });
  return out;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function selectorChain(node: ChildNode): string {
  const parts: string[] = [];
  let p: Container | undefined = node.parent as Container | undefined;
  while (p && p.type !== 'root') {
    if (p.type === 'rule') parts.unshift((p as postcss.Rule).selector.replace(/\s+/g, ' '));
    else if (p.type === 'atrule') {
      const at = p as postcss.AtRule;
      parts.unshift(`@${at.name} ${at.params}`.trim());
    }
    p = p.parent as Container | undefined;
  }
  return parts.join(' ');
}

// The token file defines the palette as custom properties; its component rules still count.
const TOKEN_FILE = 'src/pwa/css/base.css';

export function scanCss(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  postcss.parse(text, { from: file }).walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    if (file === TOKEN_FILE && prop.startsWith('--')) return;
    const value = stripOpaque(decl.value);
    const at = { where: file, locator: `${selectorChain(decl)} { ${prop} }`, line: decl.source?.start?.line };
    const push = (category: Category, rule: string, detail: string) => out.push({ category, rule, detail, ...at });

    for (const c of colorLiterals(value, COLOR_PROP.test(prop))) push('off-token', c.rule, c.text);

    if (SPACING_PROP.test(prop)) {
      for (const m of value.matchAll(PX)) {
        const n = Number(m[1]);
        if (HAIRLINE_PX.has(n)) continue;
        push('off-token', SPACING_TOKENS.has(n) ? 'raw-spacing-px' : 'off-grid-px', m[0]);
      }
    }

    if (RADIUS_PROP.test(prop)) {
      for (const m of value.matchAll(PX)) {
        const n = Number(m[1]);
        if (n === 0) continue;
        push('off-token', RADIUS_TOKENS.has(n) ? 'raw-radius-px' : 'off-scale-radius', m[0]);
      }
    }

    if (prop.startsWith('background') && value.includes('-gradient(')) {
      const sources = new Set<string>(colorLiterals(value, true).map((c) => c.text.toLowerCase()));
      for (const [, name = ''] of value.matchAll(VAR_NAME)) if (!NEUTRAL_TOKEN.test(name)) sources.add(name);
      if (sources.size >= 2) push('generic-ai', 'gradient', [...sources].join(' → '));
    }

    if (prop === 'box-shadow' || prop === 'text-shadow') {
      const ok = splitTopLevel(value).every((part) => ALLOWED_SHADOW.some((re) => re.test(part)));
      if (!ok) push('generic-ai', 'shadow', decl.value);
    }

    if ((prop === 'backdrop-filter' || prop === '-webkit-backdrop-filter') && value.trim() !== 'none') {
      push('generic-ai', 'backdrop-filter', decl.value);
    }
  });
  return out;
}

const INLINE_STYLE = [
  /style\s*=\s*"([^"]*)"/g,
  /style\s*=\s*'([^']*)'/g,
  /\.style\.\w+\s*=\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g,
  /\.style\.setProperty\([^,]+,\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g,
];
// Only what renders as colour emoji by default (or forced with VS16): text-presentation
// pictographs like ↗ ⚠ ✎ ⏸ are typographic glyphs here.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/gu;
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const FN_DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\b|function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/;

function decodeEntities(line: string): string {
  return line.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) =>
    String.fromCodePoint(/^x/i.test(n) ? parseInt(n.slice(1), 16) : Number(n)));
}

function enclosingName(lines: string[], i: number): string {
  for (let j = i; j >= 0; j--) {
    const m = FN_DECL.exec(lines[j] ?? '');
    if (m) return m[1] ?? m[2] ?? '';
  }
  return (lines[i] ?? '').trim().slice(0, 40);
}

export function scanSource(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  const isHtml = file.endsWith('.html');
  lines.forEach((raw, i) => {
    if (!isHtml && COMMENT_LINE.test(raw)) return;
    const at = () => ({ where: file, locator: isHtml ? raw.trim().slice(0, 40) : enclosingName(lines, i), line: i + 1 });

    for (const m of decodeEntities(raw).matchAll(EMOJI)) {
      out.push({ category: 'generic-ai', rule: 'emoji-icon', detail: m[0], ...at() });
    }

    for (const re of INLINE_STYLE) {
      for (const m of raw.matchAll(re)) {
        const css = m.slice(1).find((g) => g !== undefined) ?? '';
        for (const c of colorLiterals(stripOpaque(css), true)) {
          out.push({ category: 'off-token', rule: c.rule, detail: c.text, ...at() });
        }
      }
    }
  });
  return out;
}

export function scanTree(repoRoot: string): Finding[] {
  const pwa = join(repoRoot, 'src', 'pwa');
  const out: Finding[] = [];
  for (const rel of readdirSync(pwa, { recursive: true, encoding: 'utf8' }).sort()) {
    const path = rel.split('\\').join('/');
    if (path === 'sw.js' || path.endsWith('.d.ts')) continue;
    const file = `src/pwa/${path}`;
    if (path.endsWith('.css')) out.push(...scanCss(file, readFileSync(join(pwa, rel), 'utf8')));
    else if (path.endsWith('.js') || path.endsWith('.html')) out.push(...scanSource(file, readFileSync(join(pwa, rel), 'utf8')));
  }
  return out;
}
