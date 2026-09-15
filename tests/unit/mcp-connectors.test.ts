import { describe, it, expect } from 'vitest';
import { parseListOutput } from '../../src/integrations/mcp-connectors.js';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { mcpConnectorRows, mcpConnectorsHidden } from '../../src/pwa/vm/settings.js';

// `claude mcp list` is the only enumeration of claude.ai connectors, and its rows are ambiguous
// to split: the NAME holds spaces and dots ("claude.ai DataDog MCP") and a stdio TARGET holds
// spaces too ("/path/uvx mcp-grafana"). Hence last ` - ` for status, first `: ` for name.
const REAL = `Checking MCP server health…

claude.ai DataDog MCP: https://mcp.datadoghq.com/api/unstable/mcp-server/mcp - ✔ Connected
claude.ai Intuit QuickBooks: https://ai-inc.quickbooks.intuit.com/v1/mcp - ✔ Connected
claude.ai Gem: https://mcp.gem.com/mcp - ! Needs authentication
notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected
grafana: /Users/testuser/.local/bin/uvx mcp-grafana - ✔ Connected
posthog: https://mcp-eu.posthog.com/mcp (HTTP) - ! Needs authentication
`;

describe('parseListOutput', () => {
  const rows = parseListOutput(REAL);

  it('skips the header and blank lines', () => {
    expect(rows).toHaveLength(6);
  });

  it('keeps a multi-word, dotted connector name whole', () => {
    expect(rows[0]).toEqual({
      name: 'claude.ai DataDog MCP',
      target: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
      status: 'connected',
    });
    expect(rows[1]!.name).toBe('claude.ai Intuit QuickBooks');
  });

  it('keeps a stdio target with a space whole', () => {
    expect(rows[4]).toEqual({
      name: 'grafana', target: '/Users/testuser/.local/bin/uvx mcp-grafana', status: 'connected',
    });
  });

  it('reads the auth status off the end', () => {
    expect(rows.find((r) => r.name === 'claude.ai Gem')!.status).toBe('needs-auth');
    expect(rows.find((r) => r.name === 'posthog')!.status).toBe('needs-auth');
  });

  it('tolerates the ANSI colour the CLI wraps errors in', () => {
    expect(parseListOutput('\x1b[31mfoo: https://x/mcp - ! Needs authentication\x1b[0m'))
      .toEqual([{ name: 'foo', target: 'https://x/mcp', status: 'needs-auth' }]);
  });
});

describe('mcpConnectorRows', () => {
  const connectors = [
    { name: 'claude.ai Linear', status: 'connected', relevant: true },
    { name: 'claude.ai Vercel', status: 'needs-auth', relevant: true },
    { name: 'claude.ai Gem', status: 'needs-auth', relevant: false },
  ];

  // The default view is the connectors actually in use; ~20 never-touched ones would bury them.
  it('shows only relevant connectors by default', () => {
    expect(mcpConnectorRows(connectors).map((r: { name: string }) => r.name))
      .toEqual(['claude.ai Linear', 'claude.ai Vercel']);
    expect(mcpConnectorRows(connectors, { showAll: true })).toHaveLength(3);
    expect(mcpConnectorsHidden(connectors)).toBe(1);
  });

  it('drops the prefix every row shares from the title', () => {
    expect(mcpConnectorRows(connectors)[0].label).toBe('Linear');
  });

  // A connector the user has never connected isn't "broken" — flagging it would light the nav
  // warn-dot permanently for something nothing depends on.
  it('flags only a relevant connector as needing attention', () => {
    const rows = mcpConnectorRows(connectors, { showAll: true });
    expect(rows.find((r: { name: string }) => r.name === 'claude.ai Vercel').needsAttention).toBe(true);
    expect(rows.find((r: { name: string }) => r.name === 'claude.ai Gem').needsAttention).toBe(false);
    expect(rows.find((r: { name: string }) => r.name === 'claude.ai Linear').needsAttention).toBe(false);
  });
});
