import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Prefer a pre-installed Chromium when present (CI images / remote dev boxes).
const executablePath =
  process.env.PW_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * E2E against the real server + mock host agent. Needs Postgres and Redis with
 * migrations and `SEED_DEMO=true pnpm db:seed` applied. Running dev servers are reused.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm --dir ../server exec nest start',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // Open-source Chromium has no H.264 decoder, so the mock streams MJPEG here.
      command: 'MOCK_VIDEO=mjpeg pnpm --dir ../host-agent exec tsx src/main.ts --mock',
      url: 'http://127.0.0.1:4100/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
