import type { Server } from '../server.js';
import type { PreferencesStore } from '../storage/preferences-store.js';
import { readJsonBody } from './util.js';

export interface PreferencesRoutesDeps {
  preferencesStore: PreferencesStore;
}

export function registerPreferencesRoutes(server: Server, deps: PreferencesRoutesDeps): void {
  const { preferencesStore } = deps;

  server.route('GET', '/api/preferences', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(preferencesStore.get()));
  });

  server.route('PATCH', '/api/preferences', async (req, res) => {
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.statusCode = 400;
      res.end('expected a JSON object');
      return;
    }
    const merged = preferencesStore.merge(body);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(merged));
  });
}
