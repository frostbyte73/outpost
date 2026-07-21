import { test, expect } from './harness/browser.js';

test('POST /api/allowlist/rules adds a tool rule and increments the count', async ({ daemon, outpostPage }) => {
  const before = await outpostPage.request.get(`${daemon.baseUrl}/api/info`);
  const initial = (await before.json()).allowlistRuleCount;

  const post = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'tool', value: 'FakeNewTool' },
  });
  expect(post.status()).toBe(200);
  const postBody = await post.json();
  expect(postBody.added).toBe(true);
  expect(postBody.ruleCount).toBe(initial + 1);

  // Idempotency: re-adding returns added=false, count unchanged.
  const post2 = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'tool', value: 'FakeNewTool' },
  });
  const post2Body = await post2.json();
  expect(post2Body.added).toBe(false);
  expect(post2Body.ruleCount).toBe(initial + 1);
});

test('rejects bad regex for bash patterns', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'bash', value: '[invalid(regex' },
  });
  expect(res.status()).toBe(400);
});

test('rejects unknown kind', async ({ daemon, outpostPage }) => {
  const res = await outpostPage.request.post(`${daemon.baseUrl}/api/allowlist/rules`, {
    data: { kind: 'wat', value: 'x' },
  });
  expect(res.status()).toBe(400);
});
