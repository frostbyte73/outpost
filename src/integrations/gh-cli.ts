import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubApi, githubToken } from './github-api.js';
import { ghViaApi } from './gh-api-shim.js';

const execFileP = promisify(execFile);

export interface RunGhOpts { maxBuffer?: number; timeout?: number }

export type RunGh = (cwd: string, args: string[], opts?: RunGhOpts) => Promise<string>;

let ghMissing = false;

// Shared `gh` seam for the integrations that talk to GitHub. Runs the `gh` binary, which also
// reads the token from ~/.outpost/.env (launchd strips shell env, see env-file.ts); only on a
// machine without `gh` does a token send the call to the API shim instead, since the shim
// knows fewer argv shapes and resolves the repo only from origin. `cwd` picks the repo either way.
export async function runGh(
  cwd: string,
  args: string[],
  opts: RunGhOpts = {},
): Promise<string> {
  const token = githubToken();
  const viaApi = (t: string) => ghViaApi({ api: new GitHubApi({ token: t, timeout: opts.timeout ?? 15_000 }) }, cwd, args);
  if (token && ghMissing) return viaApi(token);
  try {
    const { stdout } = await execFileP('gh', args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      timeout: opts.timeout ?? 15_000,
    });
    return stdout.toString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !token) throw err;
    ghMissing = true;
    return viaApi(token);
  }
}
