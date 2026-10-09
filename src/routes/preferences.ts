import type { Server } from '../server.js';
import type { PreferencesStore } from '../storage/preferences-store.js';
import { readJsonBody } from './util.js';
import { parsePreapprovals } from '../work/preapprovals.js';
import { isReviewerEntry } from '../git/pr-reviewers.js';

export interface PreferencesRoutesDeps {
  preferencesStore: PreferencesStore;
  notify: (msg: unknown) => void;
}

export function registerPreferencesRoutes(server: Server, deps: PreferencesRoutesDeps): void {
  const { preferencesStore, notify } = deps;

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
    if (Object.prototype.hasOwnProperty.call(body, 'preapprovalDefaults')) {
      const pre = parsePreapprovals(body.preapprovalDefaults);
      if (!pre.ok) {
        res.statusCode = 400;
        res.end(pre.error);
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'improverAutoApply') && typeof body.improverAutoApply !== 'boolean') {
      res.statusCode = 400;
      res.end('improverAutoApply must be a boolean');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'prReviewers')
      && !(Array.isArray(body.prReviewers) && body.prReviewers.every(isReviewerEntry))) {
      res.statusCode = 400;
      res.end('prReviewers must be a list of GitHub logins or org/team slugs');
      return;
    }
    const merged = preferencesStore.merge(body);
    // Other devices only need to hear about keys the daemon itself acts on —
    // launchConcurrency feeds the launch governor, so it must reach every tab live.
    if (Object.prototype.hasOwnProperty.call(body, 'launchConcurrency')) {
      notify({ type: 'launch_concurrency_changed', value: merged.launchConcurrency });
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(merged));
  });
}
