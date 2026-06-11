import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  // One retry: some tests pass individually but flake under suite load — usually
  // daemon-spawn timing races (free-port allocation, fixture seeding). A single retry
  // is enough to absorb the noise without hiding genuine failures.
  retries: 1,
  use: {
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: process.env.CI ? 'github' : 'list',
});
