const BASE = '/api/sessions';

async function request(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sessions api ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const sessionsApi = {
  setInteractive(sessionId, on) {
    return request(`/${encodeURIComponent(sessionId)}/interactive`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
  },
};
