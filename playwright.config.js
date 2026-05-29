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
  testMatch: ['**/ui-playwright.test.js', '**/ui-menu-sweep.test.js', '**/regression.test.js', '**/save-load-roundtrip.test.js', '**/chatbot-playwright.test.js', '**/webm-video-export.test.js', '**/motion-analysis.test.js', '**/motion-accumulation.test.js', '**/video-loading.test.js', '**/satellite-label-visibility.test.js', '**/mobile-viewport.test.js', '**/video-cache-gaps.test.js', '**/nitf-decode.test.js'],
  // All baseline snapshots live under a single tracked directory,
  // organized by source test file. Diffs and "actual" images on test
  // failure go to snapshots-diffs/ (gitignored) instead of the default
  // test-results/. Paths are relative to testDir so every worktree
  // produces the same layout.
  snapshotPathTemplate: '{testDir}/snapshots-baseline/{testFileName}/{arg}{-projectName}{-platform}{ext}',
  outputDir: './tests_regression/snapshots-diffs',
  timeout: 120000,
  fullyParallel: true,
  forbidOnly: false,
  // One retry absorbs the transient WebGL context-lost / shader-link races
  // that appear intermittently with workers=4 in the Docker sandbox's
  // SwiftShader backend. Real regressions fail both attempts; flakes pass
  // the second time without rescheduling the whole suite.
  retries: 1,
  // Worker count tradeoff: workers=4 is fast (~3 min for the whole suite)
  // but produces SwiftShader shader-link failures under contention — the
  // ocean shader, gimbal video paths, and other GPU-heavy tests flake.
  // Set PLAYWRIGHT_WORKERS=2 (or 1) when running the full suite locally
  // through the test viewer; the default of 4 stays correct for CI where
  // each shard runs on a fresh container.
  workers: process.env.PLAYWRIGHT_WORKERS
      ? Number(process.env.PLAYWRIGHT_WORKERS)
      : 4,
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
          // ANGLE backend: defaults to swiftshader (CPU rasterizer) so CI
          // and headless containers without a GPU keep working. Override
          // via SITREC_ANGLE_BACKEND on dev machines that have a real GPU
          // — e.g. SITREC_ANGLE_BACKEND=metal on macOS, =gl on Linux with
          // a usable GPU. Real-GPU backends are dramatically faster and,
          // more importantly, deterministic: SwiftShader's program-link
          // races under workers=4 contention are what produce the
          // intermittent orion / ocean-shader brightness and empty-render
          // flakes that retries=3 only partially absorbs.
          args: [
            '--use-angle=' + (process.env.SITREC_ANGLE_BACKEND || 'swiftshader'),
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--enable-unsafe-swiftshader',
            '--disk-cache-dir=' + (process.env.SITREC_PW_CACHE_DIR || './playwright-cache'),
            '--disk-cache-size=1073741824',
          ],
        },
      },
    },
  ],
});
