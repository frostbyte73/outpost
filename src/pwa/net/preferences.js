// Thin fetch wrapper for the daemon-backed preferences blob (Spec A).
async function request(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`preferences api ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export const preferencesApi = {
  get() { return request('/api/preferences'); },
  patch(patch) {
    return request('/api/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
};
