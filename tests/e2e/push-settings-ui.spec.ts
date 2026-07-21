import { test, expect } from './harness/browser.js';

// We don't drive the full PushManager.subscribe() flow here because Chromium headless
// doesn't activate service workers against the test daemon's self-signed cert, so
// navigator.serviceWorker.ready never resolves. The daemon-side subscribe POST is
// covered by push-subscribe.spec.ts; here we just verify the Settings UI is wired:
// section renders, toggle starts in the off state, test button is gated on subscription.
test.use({ contextOptions: { permissions: ['notifications'] } });

test('Settings surface renders the push section with correct initial state', async ({ outpostPage }) => {
  // Settings is a full nav surface now (no sheet) — Notifications is one of its sections.
  await outpostPage.locator('.o-sidebar-item[data-surface="settings"]').click();
  await outpostPage.locator('.settings-nav-item[data-key="notifications"]').click();
  await expect(outpostPage.locator('.push-toggle')).toBeVisible({ timeout: 5_000 });
  await expect(outpostPage.locator('.push-test')).toBeVisible();
  await expect(outpostPage.locator('.push-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(outpostPage.locator('.push-toggle')).toContainText(/Enable push notifications/);
  await expect(outpostPage.locator('.push-toggle-state')).toHaveText('Off');
  // Test button is disabled until subscribed.
  await expect(outpostPage.locator('.push-test')).toBeDisabled();
  // iOS install banner stays hidden on a non-iOS UA (Playwright defaults to Chrome).
  await expect(outpostPage.locator('.push-ios-banner')).toBeHidden();
});
