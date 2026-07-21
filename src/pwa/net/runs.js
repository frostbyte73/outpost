const BASE = '/api/runs';

async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`runs api ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Mirrors src/routes/runs.ts's filtersFromQuery/paginationFromQuery: window is
// "24h"/"7d"/"90m"/a bare ms count/"all" (server-parsed), not a client-computed sinceMs.
function queryString(filters = {}) {
  const params = new URLSearchParams();
  if (filters.window) params.set('window', filters.window);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.repo) params.set('repo', filters.repo);
  if (filters.verdict) params.set('verdict', filters.verdict);
  if (filters.q) params.set('q', filters.q);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.offset != null) params.set('offset', String(filters.offset));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const runsApi = {
  list(filters)          { return request(`${BASE}${queryString(filters)}`); },
  csvUrl(filters)         { return `${BASE}.csv${queryString(filters)}`; },
  usageBreakdown(window)  { return request(`/api/usage/breakdown${window ? `?window=${encodeURIComponent(window)}` : ''}`); },
};
