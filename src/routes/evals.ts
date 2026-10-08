import type { Server } from '../server.js';
import { evalAgreement } from '../eval/eval-agreement.js';
import type { EvalStore } from '../eval/eval-store.js';

export interface EvalsRoutesDeps {
  evalStore: EvalStore;
}

export function registerEvalsRoutes(server: Server, deps: EvalsRoutesDeps): void {
  server.route('GET', '/api/evals/agreement', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(evalAgreement(deps.evalStore.all())));
  });
}
