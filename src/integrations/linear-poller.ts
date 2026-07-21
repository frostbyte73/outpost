import { linearQuery as defaultQuery } from './linear-api.js';
import type { JobQueue } from '../work/work-queue.js';
import type { WorkEngine } from '../work/engine.js';

interface AssignedIssueNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description?: string;
}

interface AssignedIssuesData {
  viewer: { assignedIssues: { nodes: AssignedIssueNode[] } };
}

const QUERY = `
  query AssignedOpen {
    viewer {
      assignedIssues(filter: { state: { type: { in: ["unstarted", "started"] } } }, first: 50) {
        nodes { id identifier url title description }
      }
    }
  }
`;

export interface LinearPollerOpts {
  queue: JobQueue;
  engine: WorkEngine;
  pollMs?: number;
  query?: typeof defaultQuery;
}

export class LinearPoller {
  readonly id = 'linear';
  readonly name = 'Linear — assigned issues';
  readonly description = 'Enqueues open Linear issues assigned to you as jobs.';
  private readonly pollMs: number;
  private readonly query: typeof defaultQuery;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private running = false;

  constructor(private readonly opts: LinearPollerOpts) {
    this.pollMs = opts.pollMs ?? (Number(process.env.OUTPOST_LINEAR_POLL_MS) || 60 * 60_000);
    this.query = opts.query ?? defaultQuery;
  }

  get intervalMs(): number | null { return this.pollMs; }

  status(): { lastRunAt: number | null; lastError: string | null; running: boolean } {
    return { lastRunAt: this.lastRunAt, lastError: this.lastError, running: this.running };
  }

  async runNow(): Promise<void> {
    await this.syncNow();
  }

  start(): void {
    void this.syncNow().catch((e) => console.error('[linear-poller] initial sync failed:', (e as Error).message));
    this.timer = setInterval(() => {
      void this.syncNow().catch((e) => console.error('[linear-poller] sync failed:', (e as Error).message));
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncNow(): Promise<{ added: string[] }> {
    this.running = true;
    try {
      const data = await this.query<AssignedIssuesData>(QUERY, {});
      const added: string[] = [];
      for (const node of data.viewer.assignedIssues.nodes) {
        const existing = this.opts.queue.get(node.identifier);
        if (existing) continue;
        this.opts.engine.ensureLinearJob({
          id: node.id,
          identifier: node.identifier,
          url: node.url,
          title: node.title,
          description: node.description ?? '',
        });
        added.push(node.identifier);
      }
      this.opts.queue.recordLinearSync();
      console.log(`[linear-poller] sync: +${added.length} (total ${this.opts.queue.list().length})`);
      this.lastRunAt = Date.now();
      this.lastError = null;
      return { added };
    } catch (e) {
      this.lastRunAt = Date.now();
      this.lastError = (e as Error).message;
      throw e;
    } finally {
      this.running = false;
    }
  }
}
