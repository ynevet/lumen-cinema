import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite drives the real client against the real API and a real Postgres - the point
 * is to prove the click-to-reserve flow end to end, so there is nothing stubbed. Start the
 * database first (`npm run db:up`); Playwright starts the API and the web client itself,
 * or reuses them if `npm run dev` is already running.
 *
 * Serial by design: the tests share one auditorium, and running them at once would have
 * them competing for seats.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    // `localhost` rather than an explicit 127.0.0.1: Vite binds to whichever loopback the
    // host prefers, which on Windows is the IPv6 one, and a literal IPv4 address misses it.
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Started separately rather than through the root `dev` script, so that the suite waits
  // for the API's own health check. Vite answers on 5173 long before the API has finished
  // migrating and seeding, and anything that starts in that gap fails at the proxy.
  // The binaries are invoked directly rather than through `npm run`: nesting one npm
  // lifecycle inside another leaves the child holding the parent's npm environment, and
  // on Windows the API never gets as far as listening. `npm run test:e2e` builds the
  // shared package first, so there is nothing left for these to do but start.
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      cwd: 'apps/api',
      url: 'http://localhost:4000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx vite',
      cwd: 'apps/web',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
