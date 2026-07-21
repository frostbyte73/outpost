import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ActionsStore } from '../storage/actions-store.js';
import type { ActionRegistry } from '../actions/index.js';

export interface AllowlistConfig {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
  // Path-scoped tool rules. Each entry is `<ToolName>:<path-regex>` — e.g.
  // `Write:^/tmp/` allows Write calls whose `file_path` starts with `/tmp/`,
  // but no other Write calls. Pairs with file-touching tools (Read, Write,
  // Edit, MultiEdit, NotebookEdit, Glob, Grep). Optional for backward compat.
  alwaysAllowPathPatterns?: string[];
}

export type RuleKind = 'tool' | 'bash' | 'mcp' | 'path';
// Session scope is in-memory only: rules live for the daemon's lifetime of that
// session and are never written to disk. Everything else persists.
export type RuleScope = 'global' | { project: string } | { action: string } | { session: string };

interface PathRule {
  tool: string;
  pathRegex: RegExp;
}

interface CompiledRules {
  alwaysAllow: Set<string>;
  bashPatternSources: string[];
  bashPatterns: RegExp[];
  mcpPatternSources: string[];
  mcpPatterns: RegExp[];
  pathPatternSources: string[];
  pathPatterns: PathRule[];
}

// Tools whose input has a file-path-ish field that path rules apply to.
const PATH_INPUT_FIELDS: Record<string, ReadonlyArray<string>> = {
  Read:         ['file_path'],
  Write:        ['file_path'],
  Edit:         ['file_path'],
  MultiEdit:    ['file_path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob:         ['path'],
  Grep:         ['path'],
};

function parsePathRule(value: string): PathRule {
  const idx = value.indexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`path rule must be "<ToolName>:<regex>": ${JSON.stringify(value)}`);
  }
  const tool = value.slice(0, idx);
  const pathRegex = new RegExp(value.slice(idx + 1));
  return { tool, pathRegex };
}

// Prefix check with a trailing-slash boundary so `/foo/bar` matches under `/foo`
// but `/foobar` doesn't. Defends against two escapes:
//   1. `..` traversal — lexical `resolve()` collapses `worktree/../../etc/passwd`
//      to `/etc/passwd` before the prefix compare.
//   2. Symlink escape — realpath the deepest existing ancestor of the target so
//      a symlink already on disk resolves to its real destination. Non-existent
//      leaf segments (Write to a new file) are appended after the ancestor's
//      realpath, so the check is stable whether or not the file exists yet.
function isPathUnder(path: string, prefix: string): boolean {
  const absPath = resolve(path);
  const absPrefix = resolve(prefix);
  const realPath = realpathAncestor(absPath);
  const realPrefix = (() => { try { return realpathSync(absPrefix); } catch { return absPrefix; } })();
  if (realPath === realPrefix) return true;
  const withSlash = realPrefix.endsWith('/') ? realPrefix : `${realPrefix}/`;
  return realPath.startsWith(withSlash);
}

// Walk `p`'s ancestor chain until we find one that exists on disk, realpath it,
// then re-append the non-existent tail. Handles Write targets whose leaf file
// hasn't been created yet without giving up symlink resolution on the existing part.
function realpathAncestor(p: string): string {
  let cur = p;
  while (cur && cur !== '/' && cur !== dirname(cur)) {
    try { return realpathSync(cur) + p.slice(cur.length); }
    catch { cur = dirname(cur); }
  }
  return p;
}

function readPathInput(toolName: string, toolInput: unknown): string | undefined {
  const fields = PATH_INPUT_FIELDS[toolName];
  if (!fields) return undefined;
  const input = toolInput as Record<string, unknown> | null;
  if (!input || typeof input !== 'object') return undefined;
  for (const f of fields) {
    const v = input[f];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export interface AllowlistOpts {
  // Absolute path to the directory containing per-project allowlist JSON files.
  // Names follow the sanitization "/" → "-" convention. Optional; when absent,
  // project-scoped rules are inert.
  projectAllowlistDir?: string;
  // Bundled-defaults source for action-name allowlists. Read-only; the colocated
  // <action>/allowlist.json files are checked into the repo.
  actionRegistry?: ActionRegistry;
  // Hot-added override source for action names. Rules added via the API persist here.
  actionsStore?: ActionsStore;
}

// Match claude code's projects-dir sanitization so per-project allowlists key off
// the same path shape the user already sees in `~/.claude/projects/`.
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function emptyCompiled(): CompiledRules {
  return {
    alwaysAllow: new Set(),
    bashPatternSources: [],
    bashPatterns: [],
    mcpPatternSources: [],
    mcpPatterns: [],
    pathPatternSources: [],
    pathPatterns: [],
  };
}

function compileFromConfig(cfg: AllowlistConfig): CompiledRules {
  const pathSources = cfg.alwaysAllowPathPatterns ?? [];
  const pathRules: PathRule[] = [];
  for (const s of pathSources) {
    try { pathRules.push(parsePathRule(s)); }
    catch (e) { /* invalid persisted rule — ignore silently */ }
  }
  return {
    alwaysAllow: new Set(cfg.alwaysAllow),
    bashPatternSources: [...cfg.alwaysAllowBashPatterns],
    bashPatterns: cfg.alwaysAllowBashPatterns.map((s) => new RegExp(s)),
    mcpPatternSources: [...cfg.alwaysAllowMcpPatterns],
    mcpPatterns: cfg.alwaysAllowMcpPatterns.map((s) => new RegExp(s)),
    pathPatternSources: [...pathSources],
    pathPatterns: pathRules,
  };
}

// Split a bash command into the per-clause list an allowlist must independently
// allow: top-level statements + inner commands of $(…), `…`, <(…), >(…). Null
// on unbalanced quotes / parens. Does not understand heredocs, `eval`, or
// `bash -c "…"` — the mitigation is to not allowlist those interpreters.
export function splitShellCommand(cmd: string): string[] | null {
  const clauses: string[] = [];

  function findBalancedParen(s: string, openIdx: number): number {
    let depth = 0;
    let sq = false;
    let dq = false;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (sq) { if (c === "'") sq = false; continue; }
      if (dq) {
        if (c === '\\' && i + 1 < s.length) { i++; continue; }
        if (c === '"') dq = false;
        continue;
      }
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === "'") { sq = true; continue; }
      if (c === '"') { dq = true; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function findBacktickEnd(s: string, openIdx: number): number {
    for (let i = openIdx + 1; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) { i++; continue; }
      if (s[i] === '`') return i;
    }
    return -1;
  }

  function walk(s: string): boolean {
    let buf = '';
    let sq = false;
    let dq = false;
    let i = 0;
    const flush = () => {
      const t = buf.trim();
      if (t) clauses.push(t);
      buf = '';
    };
    while (i < s.length) {
      const c = s[i];
      if (sq) {
        if (c === "'") sq = false;
        buf += c; i++; continue;
      }
      if (dq) {
        if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i += 2; continue; }
        if (c === '"') { dq = false; buf += c; i++; continue; }
        if (c === '`') {
          const end = findBacktickEnd(s, i);
          if (end < 0) return false;
          if (!walk(s.slice(i + 1, end))) return false;
          buf += s.slice(i, end + 1); i = end + 1; continue;
        }
        if (c === '$' && s[i + 1] === '(') {
          const end = findBalancedParen(s, i + 1);
          if (end < 0) return false;
          if (!walk(s.slice(i + 2, end))) return false;
          buf += s.slice(i, end + 1); i = end + 1; continue;
        }
        buf += c; i++; continue;
      }
      if (c === '\\' && i + 1 < s.length) { buf += c + s[i + 1]; i += 2; continue; }
      if (c === "'") { sq = true; buf += c; i++; continue; }
      if (c === '"') { dq = true; buf += c; i++; continue; }
      if (c === '`') {
        const end = findBacktickEnd(s, i);
        if (end < 0) return false;
        if (!walk(s.slice(i + 1, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === '$' && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      if ((c === '<' || c === '>') && s[i + 1] === '(') {
        const end = findBalancedParen(s, i + 1);
        if (end < 0) return false;
        if (!walk(s.slice(i + 2, end))) return false;
        buf += s.slice(i, end + 1); i = end + 1; continue;
      }
      if (c === ';' || c === '\n') { flush(); i++; continue; }
      if (c === '&' && s[i + 1] === '&') { flush(); i += 2; continue; }
      if (c === '|' && s[i + 1] === '|') { flush(); i += 2; continue; }
      if (c === '|') { flush(); i++; continue; }
      // `&` is only a job-control separator when it stands alone. Adjacent to `<`/`>`
      // it's part of an fd redirection (`2>&1`, `>&2`, `&>file`, `&>>file`, `<&3`) —
      // append it to the current clause instead of splitting.
      if (c === '&' && (buf.endsWith('<') || buf.endsWith('>') || s[i + 1] === '>')) {
        buf += c; i++; continue;
      }
      if (c === '&') { flush(); i++; continue; }
      buf += c; i++;
    }
    if (sq || dq) return false;
    flush();
    return true;
  }

  if (!walk(cmd)) return null;
  return clauses;
}

// Peel leading bash NAME=value words off a clause so the allowlist gates on
// the command, not on the assignment prefix. Pure-assignment clauses return ''.
export function stripLeadingAssignments(clause: string): string {
  let i = 0;
  while (i < clause.length) {
    while (i < clause.length && (clause[i] === ' ' || clause[i] === '\t')) i++;
    if (i >= clause.length) break;
    const nameStart = i;
    if (!/[A-Za-z_]/.test(clause.charAt(i))) break;
    i++;
    while (i < clause.length && /[A-Za-z0-9_]/.test(clause.charAt(i))) i++;
    if (clause[i] !== '=') { i = nameStart; break; }
    i++; // consume '='
    // consume one shell word as value: until unquoted whitespace.
    let sq = false;
    let dq = false;
    while (i < clause.length) {
      const c = clause[i];
      if (sq) { if (c === "'") sq = false; i++; continue; }
      if (dq) {
        if (c === '\\' && i + 1 < clause.length) { i += 2; continue; }
        if (c === '"') dq = false;
        i++; continue;
      }
      if (c === ' ' || c === '\t') break;
      if (c === '\\' && i + 1 < clause.length) { i += 2; continue; }
      if (c === "'") { sq = true; i++; continue; }
      if (c === '"') { dq = true; i++; continue; }
      if (c === '$' && clause[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        while (j < clause.length) {
          if (clause[j] === '(') depth++;
          else if (clause[j] === ')') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        i = j; continue;
      }
      if (c === '`') {
        let j = i + 1;
        while (j < clause.length && clause[j] !== '`') {
          if (clause[j] === '\\' && j + 1 < clause.length) j++;
          j++;
        }
        i = j + 1; continue;
      }
      i++;
    }
  }
  return clause.slice(i).trimStart();
}

function rulesAllow(rules: CompiledRules, toolName: string, toolInput: unknown): boolean {
  if (rules.alwaysAllow.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command;
    if (typeof cmd !== 'string') return false;
    const clauses = splitShellCommand(cmd);
    if (clauses === null || clauses.length === 0) return false;
    return clauses.every((c) => {
      const body = stripLeadingAssignments(c);
      if (body === '') return true;
      return rules.bashPatterns.some((p) => p.test(body));
    });
  }
  if (toolName.startsWith('mcp__')) {
    return rules.mcpPatterns.some((p) => p.test(toolName));
  }
  // Path-scoped rule: tool name must match AND the path-shaped input matches the regex.
  if (PATH_INPUT_FIELDS[toolName]) {
    const path = readPathInput(toolName, toolInput);
    if (path !== undefined && rules.pathPatterns.some((r) => r.tool === toolName && r.pathRegex.test(path))) {
      return true;
    }
  }
  return false;
}

function toConfigFromRules(rules: CompiledRules): AllowlistConfig {
  return {
    alwaysAllow: [...rules.alwaysAllow],
    alwaysAllowBashPatterns: [...rules.bashPatternSources],
    alwaysAllowMcpPatterns: [...rules.mcpPatternSources],
    alwaysAllowPathPatterns: [...rules.pathPatternSources],
  };
}

export class Allowlist {
  private readonly global: CompiledRules;
  // Lazy cache: project cwd → compiled rules. Populated on first allows()/addRule()
  // call for that cwd. No fs.watch — survives restart by re-reading the file.
  private readonly projects = new Map<string, CompiledRules>();
  // Session-scoped rules: in-memory only, cleared via clearSession() when the
  // session ends. Never serialized by toConfig().
  private readonly sessionRules = new Map<string, CompiledRules>();
  private readonly projectDir: string | undefined;
  private readonly actionRegistry: ActionRegistry | undefined;
  private readonly actionsStore: ActionsStore | undefined;

  constructor(cfg: AllowlistConfig, opts: AllowlistOpts = {}) {
    this.global = compileFromConfig(cfg);
    this.projectDir = opts.projectAllowlistDir;
    this.actionRegistry = opts.actionRegistry;
    this.actionsStore = opts.actionsStore;
  }

  private loadProject(cwd: string): CompiledRules {
    const cached = this.projects.get(cwd);
    if (cached) return cached;
    if (!this.projectDir) {
      const empty = emptyCompiled();
      this.projects.set(cwd, empty);
      return empty;
    }
    const path = join(this.projectDir, `${sanitizeCwd(cwd)}.json`);
    let rules: CompiledRules;
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        const cfg = JSON.parse(raw) as AllowlistConfig;
        rules = compileFromConfig(cfg);
      } catch {
        rules = emptyCompiled();
      }
    } else {
      rules = emptyCompiled();
    }
    this.projects.set(cwd, rules);
    return rules;
  }

  ruleCount(): number {
    return this.global.alwaysAllow.size
      + this.global.bashPatterns.length
      + this.global.mcpPatterns.length;
  }

  allows(toolName: string, toolInput: unknown, projectCwd?: string, actionName?: string, sessionWorktreePath?: string, sessionId?: string): boolean {
    if (rulesAllow(this.global, toolName, toolInput)) return true;
    if (projectCwd && rulesAllow(this.loadProject(projectCwd), toolName, toolInput)) return true;
    if (sessionId) {
      const rules = this.sessionRules.get(sessionId);
      if (rules && rulesAllow(rules, toolName, toolInput)) return true;
    }
    if (actionName) {
      // Bundled action defaults come first (colocated allowlist.json under actions/).
      if (this.actionRegistry) {
        const action = this.actionRegistry.getAction(actionName);
        if (action && rulesAllow(compileFromConfig(action.allowlist), toolName, toolInput)) return true;
      }
      // Then hot-added user overrides (~/.outpost/actions.json).
      if (this.actionsStore) {
        const cfg = this.actionsStore.get(actionName);
        if (rulesAllow(compileFromConfig(cfg.allowlist), toolName, toolInput)) return true;
      }
    }
    // Session scope: path-shaped tool inputs inside the session's own worktree auto-allow.
    // Applies only when the daemon told us the session has a worktree — action-step sessions
    // provisioned by the orchestrator. Interactive PWA sessions don't have a worktree record
    // and fall through to the interactive approval queue. See worktree-manager.ts: primary
    // adoption is refused, so a WorktreeRecord's path only ever points inside outpost's root.
    if (sessionWorktreePath && PATH_INPUT_FIELDS[toolName]) {
      const path = readPathInput(toolName, toolInput);
      if (path && isPathUnder(path, sessionWorktreePath)) return true;
    }
    return false;
  }

  // Returns true if the rule was newly added; false if it duplicated an existing one.
  // Persists project writes via projectDir if set. Global writes are still persisted
  // by the caller (daemon writes config/allowlist.json or its configured override).
  addRule(kind: RuleKind, value: string, scope: RuleScope = 'global'): boolean {
    if (typeof scope === 'object' && 'action' in scope) {
      if (!this.actionsStore) throw new Error('action scope requires actionsStore');
      return this.actionsStore.addRule(scope.action, kind, value);
    }
    const target = scope === 'global' ? this.global
      : 'session' in scope ? this.loadSession(scope.session)
      : this.loadProject(scope.project);
    if (kind === 'tool') {
      if (target.alwaysAllow.has(value)) return false;
      target.alwaysAllow.add(value);
    } else if (kind === 'bash') {
      if (target.bashPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.bashPatternSources.push(value);
      target.bashPatterns.push(compiled);
    } else if (kind === 'mcp') {
      if (target.mcpPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.mcpPatternSources.push(value);
      target.mcpPatterns.push(compiled);
    } else {
      // path rule: validates shape + regex up front so a bad value rejects loudly.
      if (target.pathPatternSources.includes(value)) return false;
      const compiled = parsePathRule(value);
      target.pathPatternSources.push(value);
      target.pathPatterns.push(compiled);
    }

    if (typeof scope === 'object' && 'project' in scope) this.persistProject(scope.project, target);
    return true;
  }

  // Removes a rule; project scope re-persists the file, session scope is memory-only.
  // Returns false when the rule wasn't present.
  removeRule(kind: RuleKind, value: string, scope: RuleScope = 'global'): boolean {
    if (typeof scope === 'object' && 'action' in scope) {
      // Action-scoped rules persist via ActionsStore, which has no removal API yet —
      // they're managed through the action editor flow instead.
      return false;
    }
    const target = scope === 'global' ? this.global
      : 'session' in scope ? this.sessionRules.get(scope.session)
      : this.loadProject(scope.project);
    if (!target) return false;
    let removed = false;
    if (kind === 'tool') {
      removed = target.alwaysAllow.delete(value);
    } else {
      const [sources, compiled]: [string[], unknown[]] =
        kind === 'bash' ? [target.bashPatternSources, target.bashPatterns]
        : kind === 'mcp' ? [target.mcpPatternSources, target.mcpPatterns]
        : [target.pathPatternSources, target.pathPatterns];
      const i = sources.indexOf(value);
      if (i >= 0) {
        sources.splice(i, 1);
        compiled.splice(i, 1);
        removed = true;
      }
    }
    if (removed && typeof scope === 'object' && 'project' in scope) this.persistProject(scope.project, target);
    return removed;
  }

  // Drops every session-scoped rule for a session. Called when the session ends.
  clearSession(sessionId: string): void {
    this.sessionRules.delete(sessionId);
  }

  private loadSession(sessionId: string): CompiledRules {
    let rules = this.sessionRules.get(sessionId);
    if (!rules) {
      rules = emptyCompiled();
      this.sessionRules.set(sessionId, rules);
    }
    return rules;
  }

  private persistProject(project: string, target: CompiledRules): void {
    if (!this.projectDir) return;
    // 0o700 dir + 0o600 file: these files gate which tool calls auto-execute, so
    // only the daemon's user should be able to read or modify them. Other local
    // users seeing the list (or worse, writing to it) would let them either probe
    // for what's been blessed or grant themselves auto-execution.
    mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
    const path = join(this.projectDir, `${sanitizeCwd(project)}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(toConfigFromRules(target), null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Serialize current state back to the on-disk JSON shape. Used by the daemon to persist
  // hot-added rules so they survive a restart. Action scope persists via ActionsStore;
  // this method only handles global + project.
  toConfig(scope: 'global' | { project: string } = 'global'): AllowlistConfig {
    return toConfigFromRules(scope === 'global' ? this.global : this.loadProject(scope.project));
  }
}
