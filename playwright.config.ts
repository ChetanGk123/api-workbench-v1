import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.AW_PORT ?? 4310);
const OTHER = Number(process.env.AW_OTHER_PORT ?? 4311);

// One counted runner: pure core cases and real-Chrome browser cases. Any failure fails the exit code.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: 'core', testMatch: /core\.spec\.ts$/ },
    { name: 'chrome', testMatch: /(browser|shell|data|import)\.spec\.ts$/, use: { channel: process.env.AW_BROWSER ?? 'chrome' } },
  ],
  webServer: {
    command: 'node tests/fixture/server.mjs',
    url: `http://127.0.0.1:${PORT}/__ready`,
    reuseExistingServer: !!process.env.AW_REUSE_SERVER,
    env: { AW_PORT: String(PORT), AW_OTHER_PORT: String(OTHER) },
  },
});
