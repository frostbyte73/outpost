export interface AllowlistConfig {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
}

export type RuleKind = 'tool' | 'bash' | 'mcp';

export class Allowlist {
  private readonly alwaysAllow: Set<string>;
  // Keep the raw source strings alongside the compiled RegExp so addRule can dedupe by
  // string identity and serialize back to JSON faithfully. The two arrays move in lockstep.
  private readonly bashPatternSources: string[];
  private readonly bashPatterns: RegExp[];
  private readonly mcpPatternSources: string[];
  private readonly mcpPatterns: RegExp[];

  constructor(cfg: AllowlistConfig) {
    this.alwaysAllow = new Set(cfg.alwaysAllow);
    this.bashPatternSources = [...cfg.alwaysAllowBashPatterns];
    this.bashPatterns = this.bashPatternSources.map((s) => new RegExp(s));
    this.mcpPatternSources = [...cfg.alwaysAllowMcpPatterns];
    this.mcpPatterns = this.mcpPatternSources.map((s) => new RegExp(s));
  }

  ruleCount(): number {
    return this.alwaysAllow.size + this.bashPatterns.length + this.mcpPatterns.length;
  }

  allows(toolName: string, toolInput: unknown): boolean {
    if (this.alwaysAllow.has(toolName)) return true;

    if (toolName === 'Bash') {
      const cmd = (toolInput as { command?: string })?.command;
      if (typeof cmd !== 'string') return false;
      return this.bashPatterns.some((p) => p.test(cmd));
    }

    if (toolName.startsWith('mcp__')) {
      return this.mcpPatterns.some((p) => p.test(toolName));
    }

    return false;
  }

  // Hot-add a rule. Validates regex compilation for pattern kinds, dedupes against
  // existing rules, and returns whether the rule was actually added (false = duplicate).
  addRule(kind: RuleKind, value: string): boolean {
    if (kind === 'tool') {
      if (this.alwaysAllow.has(value)) return false;
      this.alwaysAllow.add(value);
      return true;
    }
    if (kind === 'bash') {
      if (this.bashPatternSources.includes(value)) return false;
      const compiled = new RegExp(value); // throws if invalid; daemon route catches
      this.bashPatternSources.push(value);
      this.bashPatterns.push(compiled);
      return true;
    }
    if (kind === 'mcp') {
      if (this.mcpPatternSources.includes(value)) return false;
      const compiled = new RegExp(value);
      this.mcpPatternSources.push(value);
      this.mcpPatterns.push(compiled);
      return true;
    }
    return false;
  }

  // Serialize current state back to the on-disk JSON shape. Used by the daemon to persist
  // hot-added rules so they survive a restart.
  toConfig(): AllowlistConfig {
    return {
      alwaysAllow: [...this.alwaysAllow],
      alwaysAllowBashPatterns: [...this.bashPatternSources],
      alwaysAllowMcpPatterns: [...this.mcpPatternSources],
    };
  }
}
