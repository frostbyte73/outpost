// Where a GitHub credential may be sent from a Bash call: as the `Authorization` header of a
// curl request to https://api.github.com/, and nowhere else.
//
// `GITHUB_TOKEN` reaches every spawned session — `~/.outpost/.env` is loaded into the daemon's
// own env and sessions inherit it — and on a machine without a `gh` binary, `curl -H
// "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/…` is how an action talks to
// GitHub at all. The `pull` curl rule takes any `-H` value and any URL, so without this the
// same spelling with a different host is an ordinary allowed read that ships the token off the
// machine, and a `-d` body that interpolates it posts the token into a public comment. A rule
// can't say "this header only to that host" — it reads text left to right — so this is a
// structural bar, like the file-flag one, that holds whichever rule granted the clause.
//
// It judges the sanctioned spelling, not every route to the value: `printenv` in the `read`
// group prints it, and nothing here follows `${!name}` indirection. What it guarantees is that
// the shape the skills teach, and every edit of it a user could approve on a card, cannot point
// the token anywhere but GitHub's API.

import { clauseArgv } from './shell-safety.js';
import { skipDoubleQuoted, stripLeadingAssignments } from './shell-split.js';

const CREDENTIAL_VARS = new Set(['GITHUB_TOKEN', 'GH_TOKEN']);
const CREDENTIAL_REF_RE = /\$\{?(?:GITHUB_TOKEN|GH_TOKEN)\b\}?/g;
export const GITHUB_API_ROOT = 'https://api.github.com/';

// The one header value the token may appear in. Anchored both ends so nothing else rides in the
// same header (`Authorization: Bearer $GITHUB_TOKEN, X: …` is not a GitHub auth header).
const AUTH_HEADER_RE = /^Authorization:[ \t]*(?:Bearer|token)[ \t]+\$\{?(?:GITHUB_TOKEN|GH_TOKEN)\}?$/i;

// curl's options a GitHub API call needs, split by whether they take a value. Anything else in a
// token-bearing clause refuses: `--proxy`, `--resolve`, `--connect-to`, `-K`, `--next`, `-u`,
// `--location-trusted` each change where the request — header included — actually goes.
const NO_VALUE_LONG = new Set(['--silent', '--show-error', '--fail', '--fail-with-body', '--location', '--compressed']);
const VALUE_LONG = new Set([
  '--header', '--request', '--data', '--data-binary', '--data-raw', '--json', '--max-time', '--connect-timeout',
]);
const VALUE_SHORT = new Set(['-H', '-X', '-d', '-m']);
const HEADER_FLAGS = new Set(['-H', '--header']);

// True when `s` expands a credential variable: `$GITHUB_TOKEN` or `${GITHUB_TOKEN…}`, unquoted
// or inside double quotes. Single quotes are literal, so a commit message that merely names the
// variable is not a use of it.
export function expandsCredential(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') {
      const end = skipDoubleQuoted(s, i);
      if (expansionIn(s.slice(i + 1, end))) return true;
      i = end;
      continue;
    }
    if (c === '$' && credentialAt(s, i)) return true;
    i++;
  }
  return false;
}

function expansionIn(dq: string): boolean {
  for (let i = 0; i < dq.length; i++) {
    if (dq[i] === '\\') { i++; continue; }
    if (dq[i] === '$' && credentialAt(dq, i)) return true;
  }
  return false;
}

function credentialAt(s: string, dollar: number): boolean {
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(dollar));
  return m !== null && CREDENTIAL_VARS.has(m[1]!);
}

// `text` with every credential reference removed — for the opaque-expansion warning, which is
// about operands the user can't see the value of. The token's value is known: it is the token.
export function withoutCredentialRefs(text: string): string {
  return text.replace(CREDENTIAL_REF_RE, '');
}

// Why this clause may not carry a GitHub credential, or null when it may (or carries none).
export function credentialMisuse(clauseText: string): string | null {
  if (!expandsCredential(clauseText)) return null;
  const why = (detail: string) => `$GITHUB_TOKEN may only be sent as \`-H "Authorization: Bearer `
    + `$GITHUB_TOKEN"\` on a curl request to ${GITHUB_API_ROOT} — ${detail}.`;
  // `https_proxy=… curl` re-routes the request without a single curl flag.
  if (stripLeadingAssignments(clauseText) !== clauseText.trimStart()) return why('this clause sets variables for the command');
  const argv = clauseArgv(clauseText);
  if ((argv[0]?.split('/').pop() ?? '') !== 'curl') return why(`this clause runs \`${argv[0] ?? ''}\``);
  const refs = (w: string) => w.search(CREDENTIAL_REF_RE) >= 0;
  let urls = 0;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    let flag: string | undefined;
    let value: string | undefined;
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      flag = eq < 0 ? w : w.slice(0, eq);
      if (NO_VALUE_LONG.has(flag) && eq < 0) continue;
      if (!VALUE_LONG.has(flag)) return why(`\`${flag}\` is not allowed alongside it`);
      value = eq < 0 ? argv[++i] : w.slice(eq + 1);
    } else if (w.startsWith('-') && w.length > 1) {
      if (/^-[sSfL]+$/.test(w)) continue;
      if (!VALUE_SHORT.has(w)) return why(`\`${w}\` is not allowed alongside it`);
      flag = w;
      value = argv[++i];
    }
    if (flag !== undefined) {
      if (value === undefined) return why(`\`${flag}\` has no value`);
      if (!refs(value)) continue;
      if (!HEADER_FLAGS.has(flag) || !AUTH_HEADER_RE.test(value)) return why(`it appears in \`${flag}\` ${JSON.stringify(value)}`);
      continue;
    }
    if (!w.startsWith(GITHUB_API_ROOT)) return why(`the request also goes to ${JSON.stringify(w)}`);
    if (refs(w)) return why('it appears in the URL');
    urls++;
  }
  return urls === 0 ? why('the request names no URL') : null;
}
