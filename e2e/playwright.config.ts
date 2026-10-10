import { defineConfig } from '@playwright/test';

/**
 * Alpha test suite: drives the real web app (Next.js on :3000) against the real API, worker,
 * PostgreSQL, Redis, object storage and ClamAV. Every run creates its own "Alpha QA" tenant
 * (global-setup.ts) with passwords generated in-process. Uses the installed Microsoft Edge.
 *   npx playwright test -c e2e
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './report', open: 'never' }]],
  use: {
    baseURL: process.env.ALPHA_BASE_URL ?? 'http://localhost:3000',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
});
