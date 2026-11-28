import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartDaemonOpts } from '../e2e/harness/daemon.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures');

// Enough content that list rows, a session and a gated step render instead of only empty
// states — modelled on cockpit-board.spec.ts's seed.
export function seedOpts(): { opts: StartDaemonOpts; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), 'outpost-ui-check-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);

  // The fixture's own dates are older than the 7-day auto-archive window.
  const jsonl = readFileSync(join(FIXTURES, 'seeded-session.jsonl'), 'utf8')
    .replaceAll('2026-06-10T', `${new Date().toISOString().slice(0, 10)}T`);
  const now = Date.now();
  const job = {
    id: 'uic-job-1', source: 'manual', title: 'Stop mergeable flapping', description: '', state: 'executing',
    steps: [{
      id: 'uic-step-1', type: 'orchestrated', controller: 'code.orchestrate-pr', title: 'Fix the watcher', description: '',
      workspace: { kind: 'writable', repoCwd: repo, branch: 'outpost/uic-step-1' }, goal: 'g', inputs: {},
      phase: 'spec', state: 'gate_pending_approval',
      gate: { draft: '## Problem\n\nUNKNOWN flaps.\n', question: 'Approve the spec?', requestedAt: now },
      artifacts: { spec: '## Problem\n\nUNKNOWN flaps.\n' },
      sessionId: '66666666-6666-6666-6666-666666666666', dispatches: [], inbox: [], roundsSpent: 1, consecutiveSelfRounds: 0,
      createdAt: now, updatedAt: now,
    }],
    createdAt: now, updatedAt: now,
  };

  // The daemon links its actions into $HOME/.claude/skills at boot; with the real HOME
  // that repoints the user's live skills at this throwaway runtime dir.
  const home = mkdtempSync(join(tmpdir(), 'outpost-ui-check-home-'));

  return {
    opts: {
      fixturePath: join(FIXTURES, 'simple-text-response.jsonl'),
      initialProjects: [{ cwd: repo, sessions: [{ id: '77777777-7777-7777-7777-777777777777', jsonl }] }],
      initialJobs: [job],
      localhostOnly: true,
      extraEnv: { HOME: home },
    },
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
