import {expect, test} from '@playwright/test';
import {takeScreenshotOrCompare} from './snapshot-utils.js';

/**
 * Docker smoke tests — verify the Docker image starts correctly and the app
 * loads and renders in a browser. Run against a live Docker container in CI.
 *
 * Uses a separate config: npx playwright test --config=playwright.docker.config.js
 *
 * NOTE: We cannot wait for "No pending actions" because the Docker container
 * has no map tile API keys, so hasPendingTiles() never clears. Instead we
 * wait for the node graph to initialize (Globals.pendingActions === 0) and
 * then let the scene stabilize for a few seconds before screenshotting.
 *
 * First CI run creates the linux baseline snapshot (uploaded as artifact).
 * Download and commit it to enable visual regression on subsequent runs:
 *   tests_regression/docker-smoke.test.js-snapshots/docker-smoke-snapshot-chromium-linux.png
 */

test.describe('Docker Smoke Tests', () => {
    test('app loads and renders without errors', async ({page}, testInfo) => {
        test.setTimeout(120000);
        await page.setViewportSize({width: 1280, height: 720});

        const errors = [];

        page.on('console', msg => {
            if (msg.text().includes('ASSERT:')) {
                errors.push(`ASSERTION: ${msg.text()}`);
            }
        });

        page.on('pageerror', err => {
            errors.push(`PAGE ERROR: ${err.message}`);
        });

        // Load a fresh default sitch — requires no external data or API keys
        const response = await page.goto('?action=new&frame=10&ignoreunload=1&regression=1', {
            waitUntil: 'load',
            timeout: 30000,
        });

        // Verify HTTP 200
        expect(response.status()).toBe(200);

        // Wait for the app's node graph to initialize.
        // We check for Globals.pendingActions === 0 which means the core setup
        // is done, even if map tiles are still loading (they'll hang without API keys).
        await page.waitForFunction(
            () => window.Globals && window.NodeMan && window.NodeMan.list
                && Object.keys(window.NodeMan.list).length > 0
                && window.Globals.pendingActions === 0,
            {timeout: 60000}
        );

        // Let the scene render and stabilize for a few seconds
        await page.waitForTimeout(5000);

        // Verify at least one WebGL canvas was created (3D scene rendered)
        const canvasCount = await page.locator('canvas').count();
        expect(canvasCount).toBeGreaterThan(0);

        // No assertion failures or uncaught errors during initialization
        expect(errors).toEqual([]);

        // Visual regression screenshot.
        // First run: creates baseline (test passes).
        // Subsequent runs: compares against committed baseline.
        await takeScreenshotOrCompare(page, 'docker-smoke-snapshot', testInfo, {
            maxDiffPixels: 50000,
            threshold: 0.3,
        });
    });

    // The baseline response headers, proven against a RUNNING container rather than
    // read out of the Dockerfile. tests/securityHeaders.test.js already asserts the
    // conf says the right thing; only this can show Apache actually attaches it,
    // which is a different claim — a Header directive is inert unless mod_headers
    // is loaded and the conf enabled, and both of those are silent when missing.
    //
    // See docs/dev/SecurityHeaders.md for why the set is only these two.
    const BASELINE_HEADERS = {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
    };

    test('baseline security headers are served', async ({request}) => {
        const res = await request.get('/');
        expect(res.status()).toBeLessThan(400);
        const headers = res.headers();
        for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
            expect(`${name}: ${headers[name]}`).toBe(`${name}: ${value}`);
        }
    });

    test('the headers survive an error response', async ({request}, testInfo) => {
        // This is what earns `Header always set`. Without `always`, Apache attaches
        // the header to 2xx/3xx only, so the test above passes while the error
        // response — where a browser sniffing the body matters most — carries none.
        //
        // The status is NOT asserted. A deployment is free to answer an unknown path
        // with a rewrite to the app instead of a 404 (www.metabunk.org does exactly
        // that), and this test must not fail a release over a routing choice it has
        // no opinion about. The headers are asserted unconditionally; the status only
        // decides whether `always` was actually exercised, which is recorded either
        // way so a green run cannot quietly mean "checked nothing".
        const res = await request.get('/this-path-does-not-exist-' + Date.now());
        const headers = res.headers();
        for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
            expect(`${name} on ${res.status()}: ${headers[name]}`)
                .toBe(`${name} on ${res.status()}: ${value}`);
        }
        testInfo.annotations.push({
            type: res.status() >= 400 ? 'always-exercised' : 'always-not-exercised',
            description: `unknown path answered ${res.status()}`,
        });
    });
});
