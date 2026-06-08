export interface AllowlistConfig {
  alwaysAllow: string[];
  alwaysAllowBashPatterns: string[];
  alwaysAllowMcpPatterns: string[];
}

export class Allowlist {
  private readonly alwaysAllow: Set<string>;
  private readonly bashPatterns: RegExp[];
  private readonly mcpPatterns: RegExp[];

  constructor(cfg: AllowlistConfig) {
    this.alwaysAllow = new Set(cfg.alwaysAllow);
    this.bashPatterns = cfg.alwaysAllowBashPatterns.map((s) => new RegExp(s));
    this.mcpPatterns = cfg.alwaysAllowMcpPatterns.map((s) => new RegExp(s));
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
}
