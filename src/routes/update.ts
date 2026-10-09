import type { Server } from '../server.js';
import type { Updater, UpdateStatus } from '../update/updater.js';
import { readJsonBody } from './util.js';

export interface UpdateRoutesDeps {
  updater: Updater;
}

export function registerUpdateRoutes(server: Server, deps: UpdateRoutesDeps): void {
  const { updater } = deps;
  const send = (res: import('node:http').ServerResponse, s: UpdateStatus): void => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(s));
  };

  server.route('GET', '/api/update', async (_req, res) => send(res, updater.status()));
  server.route('POST', '/api/update/check', async (_req, res) => send(res, await updater.check()));
  server.route('POST', '/api/update/apply', async (_req, res) => send(res, await updater.apply()));

  server.route('PUT', '/api/update/auto', async (req, res) => {
    const body = await readJsonBody<{ enabled?: unknown }>(req);
    if (typeof body?.enabled !== 'boolean') {
      res.statusCode = 400;
      res.end('enabled must be a boolean');
      return;
    }
    send(res, await updater.setAuto(body.enabled));
  });
}
