// @playwright/test wordt in de Playwright-container geinstalleerd (in-container.sh),
// niet via een workspace-package.json.
// oxlint-disable actual/no-extraneous-dependencies
import { defineConfig } from '@playwright/test';

// Draait alleen in de Playwright-container van run.sh.
// De testservers zijn http://fork:5006 en http://stock:5006; Actual heeft
// een secure context nodig (SharedArrayBuffer), vandaar de chromium-vlag.
export default defineConfig({
  testDir: '.',
  testMatch: 'scenario.spec.ts',
  timeout: 4 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '/out/playwright',
  expect: { timeout: 15_000 },
  globalTimeout: 25 * 60_000,
  use: {
    browserName: 'chromium',
    viewport: { width: 1600, height: 1400 },
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
    screenshot: 'off',
    trace: 'off',
    actionTimeout: 30_000,
    launchOptions: {
      args: [
        `--unsafely-treat-insecure-origin-as-secure=${process.env.FORK_URL},${process.env.STOCK_URL}`,
      ],
    },
  },
});
