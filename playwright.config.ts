import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
export default defineConfig({ testDir: './tests', testMatch: '**/*.spec.ts', workers: 1,
  outputDir: `${tmpdir()}/lightnvr-T1-playwright`, reporter: 'line',
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: process.env.LIGHTNVR_CHROMIUM ? { executablePath: process.env.LIGHTNVR_CHROMIUM } : {} },
});
