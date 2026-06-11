import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfSignedCert } from './tls.js';
import { freePort } from './port.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..', '..', '..');
const MOCK_CLAUDE_DIR = resolvePath(__dirname, '..', 'bin');

export interface SeedSession {
  id: string;
  // Raw JSONL content for the session — caller is responsible for valid lines.
  jsonl: string;
}

export interface SeedProject {
  cwd: string;
  sessions?: SeedSession[];
}

export interface StartDaemonOpts {
  // Path to the fixture JSONL the mock claude will replay.
  fixturePath: string;
  // Optional: pre-seed projects and sessions on disk before the daemon starts.
  initialProjects?: SeedProject[];
}

export interface DaemonHandle {
  baseUrl: string;
  process: ChildProcess;
  runtimeDir: string;
  projectsRoot: string;
  certPath: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

// Mirrors how claude code sanitizes a cwd into a project-dir name:
// "/Users/dc/work/foo" → "-Users-dc-work-foo".
function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

async function waitForListening(proc: ChildProcess, stderrBuf: { value: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('[daemon] listening on')) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before listening (code ${code})\nstderr:\n${stderrBuf.value}`));
    };
    const cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.off('exit', onExit);
      clearTimeout(timer);
    };
    proc.stdout?.on('data', onData);
    proc.on('exit', onExit);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for daemon\nstderr:\n${stderrBuf.value}`));
    }, 10_000);
  });
}

export async function startDaemon(opts: StartDaemonOpts): Promise<DaemonHandle> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'outpost-test-'));
  const projectsRoot = join(runtimeDir, 'claude-projects');
  mkdirSync(projectsRoot, { recursive: true });

  // Seed fixture projects/sessions.
  for (const p of opts.initialProjects ?? []) {
    const projectDir = join(projectsRoot, sanitizeCwd(p.cwd));
    mkdirSync(projectDir, { recursive: true });
    for (const s of p.sessions ?? []) {
      writeFileSync(join(projectDir, `${s.id}.jsonl`), s.jsonl);
    }
  }

  const host = '127.0.0.1';
  const httpsPort = await freePort();
  const hookPort = await freePort();
  const { certPath, keyPath } = selfSignedCert(runtimeDir, host);

  const env = {
    ...process.env,
    PATH: `${MOCK_CLAUDE_DIR}:${process.env.PATH ?? ''}`,
    OUTPOST_RUNTIME_DIR: runtimeDir,
    OUTPOST_PROJECTS_ROOT: projectsRoot,
    OUTPOST_CERT_PATH: certPath,
    OUTPOST_KEY_PATH: keyPath,
    OUTPOST_HOST: host,
    OUTPOST_BIND_ADDRESS: host,
    OUTPOST_HTTPS_PORT: String(httpsPort),
    OUTPOST_HOOK_PORT: String(hookPort),
    OUTPOST_TEST_FIXTURE: opts.fixturePath,
    OUTPOST_TEST_DELAY_MS: '5',
    // Point the daemon's allowlist write path at the per-test temp dir so /api/allowlist/rules
    // POSTs don't mutate the repo's checked-in config/allowlist.json. The in-memory allowlist
    // still starts from the repo's config (which is imported at compile time).
    OUTPOST_ALLOWLIST_PATH: join(runtimeDir, 'allowlist.json'),
  };

  const proc = spawn('npx', ['tsx', 'src/daemon.ts'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderrBuf = { value: '' };
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (c: string) => { stderrBuf.value += c; });

  try {
    await waitForListening(proc, stderrBuf);
  } catch (e) {
    proc.kill('SIGTERM');
    throw e;
  }

  return {
    baseUrl: `https://${host}:${httpsPort}`,
    process: proc,
    runtimeDir,
    projectsRoot,
    certPath,
    host,
    port: httpsPort,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    },
  };
}
