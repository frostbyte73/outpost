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
  listRuntimes() { return request('/runtimes'); },
  switchRuntime(id, runtime, expectedVersion) {
    return request(`/${encodeURIComponent(id)}/runtime`, {
      method: 'PUT', body: JSON.stringify({ runtime, expectedVersion }),
    });
  },
  setInteractive(sessionId, on) {
    return request(`/${encodeURIComponent(sessionId)}/interactive`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
  },
};

export async function loadRuntimeOptions(select, selected) {
  const { runtimes } = await sessionsApi.listRuntimes();
  select.replaceChildren(...runtimes.map(({ id, label }) => new Option(label, id)));
  if (!runtimes.some(({ id }) => id === selected)) {
    const current = new Option(`${selected} (unavailable)`, selected);
    current.disabled = true;
    select.prepend(current);
  }
  select.value = selected;
  select.disabled = runtimes.length === 0;
}
