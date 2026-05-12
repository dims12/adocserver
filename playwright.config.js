import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.ADOC_TEST_PORT ?? 5174)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests',
  // Playwright e2e tests use *.spec.js; Node unit tests use *.test.js and
  // are run via `node --test` (see package.json scripts).
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `node bin/adocserver.js docs --port ${PORT} --host 127.0.0.1`,
    url: `${BASE_URL}/docs/index.adoc`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
