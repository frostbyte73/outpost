// Thin fetch wrapper for the small greenfield Settings endpoints (D4.4):
// permission groups, allowlist rules, MCP connection health. All GET-only,
// read-only surfaces — no mutation routes exist for any of these yet.

async function request(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`meta api ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export const metaApi = {
  permissionGroups() { return request('/api/permission-groups'); },
  allowlistRules()   { return request('/api/allowlist/rules'); },
  mcpStatus()        { return request('/api/mcp/status'); },
};
