import type { JobRecord } from './work-types.js';

export interface JobLiveness {
  orchestrator: boolean;
  stepIds: string[];
}

// The job shape sent to the PWA: the persisted record plus a derived, never-persisted
// `live` snapshot of which of its sessions currently have a live subprocess.
export type JobWithLiveness = JobRecord & { live: JobLiveness };

export function withLiveness(
  job: JobRecord,
  isActive: (sessionId?: string) => boolean,
): JobWithLiveness {
  const stepIds: string[] = [];
  for (const s of job.steps) {
    if (s.cancelled) continue;
    const stepLive = isActive(s.sessionId);
    const editLive = s.type === 'open-pr'
      && (s.editQueue ?? []).some((e) => e.status === 'running' && isActive(e.sessionId));
    if (stepLive || editLive) stepIds.push(s.id);
  }
  return { ...job, live: { orchestrator: isActive(job.orchestratorSessionId), stepIds } };
}
