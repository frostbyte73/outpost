// Fetch wrappers for the Settings/Permissions endpoints: permission groups (and their
// revision history), allowlist rules, pending classifications, MCP connection health.
//
// The mutating half — PUT /api/permission-groups/:name above all — answers a refused edit
// with 400 and the lint's own plain-text explanation of WHY the rule is unsafe. That text is
// the only explanation a user ever gets, so MetaApiError carries the response body through
// verbatim: callers render `err.body`, never a message of their own invention.

export class MetaApiError extends Error {
  constructor(status, body) {
    super(body || `meta api ${status}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new MetaApiError(res.status, text.trim());
  }
  return res.status === 204 ? null : res.json();
}

function jsonBody(body) {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function postJson(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const metaApi = {
  permissionGroups() { return request('/api/permission-groups'); },
  allowlistRules()   { return request('/api/allowlist/rules'); },
  mcpStatus()        { return request('/api/mcp/status'); },
  // Live per-server tools/list probe — slower than mcpStatus, called on its own schedule by
  // the Pending classifications panel so a hung server delays only that sub-panel.
  mcpCatalog()       { return request('/api/mcp/catalog'); },
  pending()          { return request('/api/permissions/pending'); },

  // Cross-device MCP OAuth. `start` blocks until the CLI has printed its authorization URL,
  // `submit` until the token exchange settles, so both are slower than a normal GET.
  mcpAuthFlows()               { return request('/api/mcp/auth/flows'); },
  // Health-checks every server (~11s) and is cached server-side; `refresh` pays it again.
  mcpConnectors(refresh)       { return request(`/api/mcp/connectors${refresh ? '?refresh=1' : ''}`); },
  mcpAuthStart(server)         { return request('/api/mcp/auth/start', postJson({ server })); },
  mcpAuthSubmit(flowId, redirectUrl) {
    return request('/api/mcp/auth/submit', postJson({ flowId, redirectUrl }));
  },
  mcpAuthCancel(flowId)        { return request('/api/mcp/auth/cancel', postJson({ flowId })); },
  // Connectors only — the tap that says "I authorized on claude.ai", which is also what
  // reloads live sessions onto the new grant.
  mcpAuthDone(flowId)          { return request('/api/mcp/auth/done', postJson({ flowId })); },

  // Claude Code's own account, same shape one level up. Worth remembering while debugging it:
  // if this is what's broken, no session can run — the daemon drives the CLI itself.
  claudeAuth()                 { return request('/api/claude/auth'); },
  claudeAuthStart()            { return request('/api/claude/auth/start', postJson({})); },
  claudeAuthSubmit(flowId, code) {
    return request('/api/claude/auth/submit', postJson({ flowId, code }));
  },
  claudeAuthCancel(flowId)     { return request('/api/claude/auth/cancel', postJson({ flowId })); },

  denialVerdict(actionName, denialId, body) {
    return request(
      `/api/actions/${encodeURIComponent(actionName)}/denials/${encodeURIComponent(denialId)}/verdict`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
  },

  // Replaces the WHOLE group — the caller rebuilds all four pattern arrays.
  putPermissionGroup(name, group, rationale) {
    return request(`/api/permission-groups/${encodeURIComponent(name)}`,
      jsonBody(rationale ? { group, rationale } : { group }));
  },
  groupRevisions(name) {
    return request(`/api/permission-groups/${encodeURIComponent(name)}/revisions`);
  },
  revertGroup(name, revisionId) {
    return request(
      `/api/permission-groups/${encodeURIComponent(name)}/revert/${encodeURIComponent(revisionId)}`,
      { method: 'POST' },
    );
  },

  putAllowlistRule(id, value) {
    return request(`/api/allowlist/rules/${encodeURIComponent(id)}`, jsonBody({ value }));
  },
  deleteAllowlistRule(id) {
    return request(`/api/allowlist/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
