import { escapeHtml } from './util.js';

// Safe-HTML allowlist — GitHub-style rendering of raw tags in markdown
// (Devin/CodeRabbit and other review bots use <details>, <img>, <sub>, <br>, etc.).
// Tag+attribute allowlist; anything unlisted falls back to being escaped as text.
const HTML_ALLOWED = new Set([
  'details', 'summary', 'p', 'blockquote', 'div', 'span',
  'b', 'i', 'em', 'strong', 'code', 'kbd', 'sub', 'sup',
  'del', 'ins', 'mark', 's', 'u', 'small',
  'br', 'hr', 'a', 'img', 'picture', 'source',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'pre',
]);
const HTML_VOID = new Set(['br', 'hr', 'img', 'source']);
const HTML_BLOCK = new Set([
  'details', 'summary', 'blockquote', 'div', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre',
]);
const HTML_ATTRS = {
  a: { href: 'url', title: 'text' },
  img: { src: 'url', alt: 'text', title: 'text', width: 'num', height: 'num' },
  source: { srcset: 'urlset', src: 'url', media: 'text', type: 'text', sizes: 'text' },
  td: { align: 'align', colspan: 'num', rowspan: 'num' },
  th: { align: 'align', colspan: 'num', rowspan: 'num' },
  div: { align: 'align' },
  p: { align: 'align' },
  details: { open: 'bool' },
};

function isSafeUrl(v) {
  return /^(?:https?:\/\/|mailto:|tel:|#|\/)/i.test(v);
}

function sanitizeAttrs(tag, raw) {
  const allowed = HTML_ATTRS[tag];
  if (!allowed || !raw) return '';
  const out = [];
  const re = /([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    const kind = allowed[name];
    if (!kind) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (kind === 'bool') { out.push(name); continue; }
    if (kind === 'url' && !isSafeUrl(val)) continue;
    if (kind === 'urlset') {
      // srcset is `url descriptor, url descriptor, …` — each URL must be safe
      const urls = val.split(',').map((p) => p.trim().split(/\s+/)[0]);
      if (!urls.every((u) => u && isSafeUrl(u))) continue;
    }
    if (kind === 'num' && !/^\d+$/.test(val)) continue;
    if (kind === 'align' && !/^(left|right|center|justify)$/i.test(val)) continue;
    const extra = tag === 'a' && name === 'href' ? ' target="_blank" rel="noopener noreferrer"' : '';
    out.push(`${name}="${escapeHtml(val)}"${extra}`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

// `allowHtml` opts into GitHub-style raw-HTML rendering (an allowlist of tags —
// <details>, <img>, <sub>, <br>, …). It defaults OFF and should ONLY be enabled
// for trusted, HTML-bearing content — bot PR comments (CodeRabbit/Devin) in
// thread-card. For Claude-authored prose it stays off: a regex can't reliably
// tell code from prose when backticks are odd or nested, and in plain markdown a
// <details> that lands in running text renders as a live disclosure that swallows
// the rest of the message. With HTML off, every `<tag>` is escaped to text — safe
// regardless of how the surrounding backticks pair up.
export function renderMarkdown(src, { allowHtml = false } = {}) {
  // strip ANSI escapes from tool stdout (claude includes them verbatim)
  const stripped = String(src).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // extract fenced blocks first so inline rules never touch their contents
  const codeBlocks = [];
  const withFences = stripped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: String(lang || ''), code: String(code) });
    return `\x00FENCE${codeBlocks.length - 1}\x00`;
  });

  // carve out inline code spans (backtick-run aware: a span of N backticks closes
  // on the next run of N) so their contents survive block-splitting and the HTML
  // pass untouched, then re-inject as escaped <code> at the end.
  const inlineCodes = [];
  const withInlineCode = withFences.replace(/(`+)([^\n]*?)\1/g, (_, _ticks, code) => {
    // CommonMark strips one leading + trailing space when both present and the
    // content isn't all spaces (so `` `<details>` `` renders as `<details>`).
    let c = code;
    if (c.length > 1 && c.startsWith(' ') && c.endsWith(' ') && c.trim() !== '') c = c.slice(1, -1);
    inlineCodes.push(c);
    return `\x00ICODE${inlineCodes.length - 1}\x00`;
  });

  // extract allowlisted HTML tags so escapeHtml doesn't turn them into text.
  // each tag becomes an opaque placeholder that survives block-splitting and
  // inline-escape; sanitized tags get re-injected at the end. Only when the
  // caller opts in — otherwise every raw tag falls through to escapeHtml as text.
  const htmlTags = [];
  const withHtml = !allowHtml ? withInlineCode : withInlineCode.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*?)?)\s*(\/?)>/g,
    (full, closing, tag, attrs, selfClose) => {
      const name = tag.toLowerCase();
      if (!HTML_ALLOWED.has(name)) return full;
      let sanitized;
      if (closing) {
        if (HTML_VOID.has(name)) return full;
        sanitized = `</${name}>`;
      } else {
        sanitized = `<${name}${sanitizeAttrs(name, attrs)}>`;
      }
      htmlTags.push({ html: sanitized, block: HTML_BLOCK.has(name) });
      return `\x00HTML${htmlTags.length - 1}\x00`;
    }
  );

  // split on blank lines, then re-split each chunk so headings and tables always
  // land in their own block — covers Claude writing `### Heading\n| table |` with
  // no blank line between, which otherwise renders with literal `###` artifacts
  const blocks = withHtml.split(/\n{2,}/).flatMap((block) => {
    const lines = block.split('\n');
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(buf.join('\n')); buf = []; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isHeading = /^#{1,6}\s/.test(line);
      const isTableStart =
        i + 1 < lines.length
        && /^\s*\|.*\|\s*$/.test(line)
        && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1]);
      if (isHeading) {
        flush();
        out.push(line);
      } else if (isTableStart && buf.length) {
        flush();
        buf.push(line);
      } else {
        buf.push(line);
      }
    }
    flush();
    return out;
  });
  let html = blocks.map(renderBlock).join('\n');

  html = html.replace(/\x00FENCE(\d+)\x00/g, (_, i) => {
    const cb = codeBlocks[Number(i)];
    if (!cb) return '';
    const langClass = cb.lang ? ` class="lang-${escapeHtml(cb.lang)}"` : '';
    return `<pre class="md-pre"><code${langClass}>${escapeHtml(cb.code.replace(/\n$/, ''))}</code></pre>`;
  });

  html = html.replace(/\x00ICODE(\d+)\x00/g, (_, i) => {
    const code = inlineCodes[Number(i)];
    return code == null ? '' : `<code class="md-code">${escapeHtml(code)}</code>`;
  });

  html = html.replace(/\x00HTML(\d+)\x00/g, (_, i) => htmlTags[Number(i)]?.html ?? '');

  // block-level HTML tags on their own paragraph line got wrapped in <p>…</p>
  // by renderBlock; unwrap when the paragraph is nothing but block tags + whitespace
  const blockRe = new RegExp(
    `<p class="md-p">((?:\\s|<br>|</?(?:${[...HTML_BLOCK].join('|')})\\b[^>]*>)+)</p>`,
    'g'
  );
  html = html.replace(blockRe, '$1');

  return html;
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return '';

  const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (h) {
    const level = h[1].length;
    return `<h${level} class="md-h md-h${level}">${renderInline(h[2])}</h${level}>`;
  }

  if (/^(?:-\s*){3,}$|^(?:_\s*){3,}$|^(?:\*\s*){3,}$/.test(trimmed)) {
    return `<hr class="md-hr">`;
  }

  const lines = trimmed.split('\n');
  if (lines.length >= 2 && /^\s*\|.*\|\s*$/.test(lines[0]) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1])) {
    return renderTable(lines);
  }

  if (lines.every((l) => /^\s*>\s?/.test(l))) {
    const inner = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n');
    return `<blockquote class="md-quote">${renderInline(inner)}</blockquote>`;
  }

  // ordered lists carry `start=` so a list split across blocks doesn't reset to 1, 1, 1
  if (lines.every((l) => /^\s*[-*+]\s+/.test(l)) || lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
    const ordered = /^\s*\d+\.\s+/.test(lines[0]);
    if (ordered) {
      const start = Number(lines[0].match(/^\s*(\d+)\.\s+/)[1]);
      const items = lines.map((l) => l.replace(/^\s*\d+\.\s+/, ''));
      const startAttr = start !== 1 ? ` start="${start}"` : '';
      return `<ol class="md-list"${startAttr}>${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ol>`;
    }
    const items = lines.map((l) => l.replace(/^\s*[-*+]\s+/, ''));
    return `<ul class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</ul>`;
  }

  return `<p class="md-p">${renderInline(trimmed).replace(/\n/g, '<br>')}</p>`;
}

function renderTable(lines) {
  const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

function renderInline(text) {
  // escape first so transforms below can only produce tags from controlled patterns.
  // inline code is already carved out at the top level (renderMarkdown), so the
  // \x00ICODE\x00 placeholders here pass through untouched.
  let s = escapeHtml(text);

  // only http(s) / mailto / tel / root-relative hrefs render as links — anything else
  // falls back to raw text so a malformed href can't smuggle a javascript: URL
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (full, label, href) => {
    if (!/^(?:https?:\/\/|mailto:|tel:|\/)/.test(href)) return full;
    links.push(`<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `\x00LINK${links.length - 1}\x00`;
  });

  // bare URL autolinker. Trailing sentence punctuation is shed so "see https://x.com." doesn't include the period
  s = s.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    let trail = '';
    while (url.length && /[.,;:!?)\]}'"*_]/.test(url.slice(-1))) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    if (!url) return trail;
    links.push(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return `\x00LINK${links.length - 1}\x00${trail}`;
  });

  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s({\[>])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s({\[>])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  s = s.replace(/\x00LINK(\d+)\x00/g, (_, i) => links[Number(i)] ?? '');

  return s;
}
