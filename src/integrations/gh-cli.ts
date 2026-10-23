import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubApi, githubToken } from './github-api.js';
import { ghViaApi } from './gh-api-shim.js';

const execFileP = promisify(execFile);

export interface RunGhOpts { maxBuffer?: number; timeout?: number }

export type RunGh = (cwd: string, args: string[], opts?: RunGhOpts) => Promise<string>;

// Shared `gh` seam for the integrations that talk to GitHub. With a token in the env (from
// ~/.outpost/.env — launchd strips shell env, see env-file.ts) the call goes straight to the
// API and the `gh` binary is never needed; without one it falls back to the binary, so a
// machine authenticated only through `gh auth login` keeps working. `cwd` picks the repo either way.
export async function runGh(
  cwd: string,
  args: string[],
  opts: RunGhOpts = {},
): Promise<string> {
  const token = githubToken();
  if (token) return ghViaApi({ api: new GitHubApi({ token, timeout: opts.timeout ?? 15_000 }) }, cwd, args);
  const { stdout } = await execFileP('gh', args, {
    cwd,
    maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    timeout: opts.timeout ?? 15_000,
  });
  return stdout.toString();
}
