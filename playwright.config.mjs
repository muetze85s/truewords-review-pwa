import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.visual.spec.mjs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome HiDPI'],
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1366, height: 1024 },
    deviceScaleFactor: 1,
    locale: 'de-DE',
    timezoneId: 'Asia/Bangkok',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
    },
  },
  webServer: {
    command: 'node tests/visual/serve.mjs',
    url: 'http://127.0.0.1:4173/tests/visual/review-fixture.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
