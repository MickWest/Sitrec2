import {defineConfig, devices} from '@playwright/test';

// PLAYWRIGHT_BASE_URL should point at the sitrec app root.
// - Production: https://local.metabunk.org/sitrec/ (sitrec served under /sitrec/)
// - Docker sandbox: http://localhost:8080/ (PHP `-t /build` serves sitrec at /)
// If env var is unset, default to production layout.
// If env var is set without a path, assume production-style /sitrec/ subpath so
// legacy configs that only override host keep working.
let baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://local.metabunk.org';
{
  const u = new URL(baseURL);
  if (u.pathname === '/' && !process.env.PLAYWRIGHT_BASE_URL) {
    u.pathname = '/sitrec/';
  } else if (!u.pathname.endsWith('/')) {
    u.pathname += '/';
  }
  baseURL = u.toString();
}

export default defineConfig({
  testDir: './tests_regression',
  testMatch: ['**/ui-playwright.test.js', '**/ui-menu-sweep.test.js', '**/regression.test.js', '**/chatbot-playwright.test.js', '**/webm-video-export.test.js', '**/motion-analysis.test.js', '**/motion-accumulation.test.js', '**/video-loading.test.js', '**/satellite-label-visibility.test.js', '**/mobile-viewport.test.js', '**/video-cache-gaps.test.js', '**/nitf-decode.test.js'],
  timeout: 120000,
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  workers: 4,
  maxFailures: 1,
  reporter: 'list',
  
  use: {
    baseURL,
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
          // Debian chromium ships with proprietary codecs (H.264) that Playwright's
          // bundled Chromium lacks on arm64 Linux. The Docker sandbox sets
          // SITREC_CHROMIUM=/usr/bin/chromium; on macOS dev machines it's unset and
          // Playwright falls back to its own build.
          executablePath: process.env.SITREC_CHROMIUM || undefined,
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
