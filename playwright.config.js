import {defineConfig, devices} from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://local.metabunk.org';

export default defineConfig({
  testDir: './tests_regression',
  testMatch: ['**/ui-playwright.test.js', '**/regression.test.js', '**/chatbot-playwright.test.js', '**/webm-video-export.test.js', '**/motion-analysis.test.js', '**/motion-accumulation.test.js', '**/video-loading.test.js', '**/satellite-label-visibility.test.js', '**/mobile-viewport.test.js', '**/video-cache-gaps.test.js'],
  timeout: 120000,
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  workers: 4,
  maxFailures: 1,
  reporter: 'list',
  
  use: {
    baseURL: baseURL + '/sitrec',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'allow',
  },

  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--enable-unsafe-swiftshader',
            '--disk-cache-dir=./playwright-cache',
            '--disk-cache-size=1073741824',
          ],
        },
      },
    },
  ],
});
