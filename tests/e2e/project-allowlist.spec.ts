import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolvePath(__dirname, 'fixtures', 'tool-use-mcp-write-only.jsonl');
const TEST_CWD = '/tmp/outpost-e2e-project-allowlist';

test.use({ daemonOpts: { fixturePath: FIXTURE } });

test.beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
});

test('POST /api/allowlist/rules with project scope writes file under runtimeDir', async ({ daemon, outpostPage }) => {
  const post = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'mcp', value: '^mcp__incident-io__incident_update$', scope: { project: TEST_CWD } },
  });
  expect(post.status()).toBe(200);
  expect((await post.json()).added).toBe(true);

  // File landed under <runtimeDir>/allowlists/<sanitized>.json with 0o600 perms (from Task 6 security fix).
  const expectedFile = join(daemon.runtimeDir, 'allowlists', `${TEST_CWD.replace(/\//g, '-')}.json`);
  expect(existsSync(expectedFile)).toBe(true);
  const contents = JSON.parse(readFileSync(expectedFile, 'utf8'));
  expect(contents.alwaysAllowMcpPatterns).toContain('^mcp__incident-io__incident_update$');

  // Re-add same rule: idempotent.
  const post2 = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'mcp', value: '^mcp__incident-io__incident_update$', scope: { project: TEST_CWD } },
  });
  expect((await post2.json()).added).toBe(false);
});

test('a project rule auto-allows a subsequent tool call (no approval card appears)', async ({ daemon, outpostPage }) => {
  // Promote the rule first (idempotent if Task already ran above).
  await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'mcp', value: '^mcp__incident-io__incident_update$', scope: { project: TEST_CWD } },
  });

  // Open a session in TEST_CWD; the fixture's MCP tool_use should auto-allow because of the project rule.
  await outpostPage.locator('#new-session').click();
  await outpostPage.locator('#cwd-picker-custom-input').fill(TEST_CWD);
  await outpostPage.locator('#cwd-picker-custom-form button[type=submit]').click();

  const composer = outpostPage.locator('#composer');
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Wait for the WS to connect before sending the prompt.
  await outpostPage.waitForFunction(
    () => document.documentElement.getAttribute('data-conn') === 'connected',
    { timeout: 10_000 }
  );

  await composer.click();
  await outpostPage.keyboard.type('go');
  await outpostPage.keyboard.press('Enter');

  // Give the daemon a moment to process the hook (server takes a few hundred ms to
  // write the JSONL entry for findSession to discover the cwd).
  await outpostPage.waitForTimeout(1000);

  // No approval card — the project rule auto-allowed.
  await expect(outpostPage.locator('button.approve')).toHaveCount(0);
  const res = await outpostPage.request.get(`${daemon.baseUrl}/api/sessions`);
  expect((await res.json()).pending).toHaveLength(0);
});

test('rejects scope with non-absolute project path', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'tool', value: 'X', scope: { project: 'relative/path' } },
  });
  expect(res.status()).toBe(400);
});

test('rejects scope shape that is neither "global" nor {project: <absolute>}', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'tool', value: 'X', scope: { unrecognized: 'shape' } },
  });
  expect(res.status()).toBe(400);
});

test('scope omitted defaults to global (preserves backward compatibility)', async ({ daemon, outpostPage }) => {
  const before = await outpostPage.request.get(`${daemon.baseUrl}/api/info`);
  const initial = (await before.json()).allowlistRuleCount;
  const post = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'tool', value: 'BackcompatTool' },  // no scope
  });
  expect(post.status()).toBe(200);
  expect((await post.json()).added).toBe(true);
  const after = await outpostPage.request.get(`${daemon.baseUrl}/api/info`);
  expect((await after.json()).allowlistRuleCount).toBe(initial + 1);
});
