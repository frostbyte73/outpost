import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AllowlistConfig {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
}

export type RuleKind = 'tool' | 'bash' | 'mcp';
export type RuleScope = 'global' | { project: string };

interface CompiledRules {
  alwaysAllow: Set<string>;
  bashPatternSources: string[];
  bashPatterns: RegExp[];
  mcpPatternSources: string[];
  mcpPatterns: RegExp[];
}

export interface AllowlistOpts {
  // Absolute path to the directory containing per-project allowlist JSON files.
  // Names follow the sanitization "/" → "-" convention. Optional; when absent,
  // project-scoped rules are inert.
  projectAllowlistDir?: string;
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
  };
}

function compileFromConfig(cfg: AllowlistConfig): CompiledRules {
  return {
    alwaysAllow: new Set(cfg.alwaysAllow),
    bashPatternSources: [...cfg.alwaysAllowBashPatterns],
    bashPatterns: cfg.alwaysAllowBashPatterns.map((s) => new RegExp(s)),
    mcpPatternSources: [...cfg.alwaysAllowMcpPatterns],
    mcpPatterns: cfg.alwaysAllowMcpPatterns.map((s) => new RegExp(s)),
  };
}

function rulesAllow(rules: CompiledRules, toolName: string, toolInput: unknown): boolean {
  if (rules.alwaysAllow.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string })?.command;
    if (typeof cmd !== 'string') return false;
    return rules.bashPatterns.some((p) => p.test(cmd));
  }
  if (toolName.startsWith('mcp__')) {
    return rules.mcpPatterns.some((p) => p.test(toolName));
  }
  return false;
}

function toConfigFromRules(rules: CompiledRules): AllowlistConfig {
  return {
    alwaysAllow: [...rules.alwaysAllow],
    alwaysAllowBashPatterns: [...rules.bashPatternSources],
    alwaysAllowMcpPatterns: [...rules.mcpPatternSources],
  };
}

export class Allowlist {
  private readonly global: CompiledRules;
  // Lazy cache: project cwd → compiled rules. Populated on first allows()/addRule()
  // call for that cwd. No fs.watch — survives restart by re-reading the file.
  private readonly projects = new Map<string, CompiledRules>();
  private readonly projectDir: string | undefined;

  constructor(cfg: AllowlistConfig, opts: AllowlistOpts = {}) {
    this.global = compileFromConfig(cfg);
    this.projectDir = opts.projectAllowlistDir;
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

  allows(toolName: string, toolInput: unknown, projectCwd?: string): boolean {
    if (rulesAllow(this.global, toolName, toolInput)) return true;
    if (!projectCwd) return false;
    return rulesAllow(this.loadProject(projectCwd), toolName, toolInput);
  }

  // Returns true if the rule was newly added; false if it duplicated an existing one.
  // Persists project writes via projectDir if set. Global writes are still persisted
  // by the caller (daemon writes config/allowlist.json or its configured override).
  addRule(kind: RuleKind, value: string, scope: RuleScope = 'global'): boolean {
    const target = scope === 'global' ? this.global : this.loadProject(scope.project);
    if (kind === 'tool') {
      if (target.alwaysAllow.has(value)) return false;
      target.alwaysAllow.add(value);
    } else if (kind === 'bash') {
      if (target.bashPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.bashPatternSources.push(value);
      target.bashPatterns.push(compiled);
    } else {
      if (target.mcpPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      target.mcpPatternSources.push(value);
      target.mcpPatterns.push(compiled);
    }

    if (scope !== 'global' && this.projectDir) {
      // 0o700 dir + 0o600 file: these files gate which tool calls auto-execute, so
      // only the daemon's user should be able to read or modify them. Other local
      // users seeing the list (or worse, writing to it) would let them either probe
      // for what's been blessed or grant themselves auto-execution.
      mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
      const path = join(this.projectDir, `${sanitizeCwd(scope.project)}.json`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(toConfigFromRules(target), null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
    }
    return true;
  }

  // Serialize current state back to the on-disk JSON shape. Used by the daemon to persist
  // hot-added rules so they survive a restart.
  toConfig(scope: RuleScope = 'global'): AllowlistConfig {
    return toConfigFromRules(scope === 'global' ? this.global : this.loadProject(scope.project));
  }
}
