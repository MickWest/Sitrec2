// Save -> Load round-trip regression test for the default (custom) sitch.
//
// Verifies the three things asked for:
//   A) the round trip does not crash (no ASSERT, no console/page error)
//   B) it actually saves and loads (serialization produces a real sitch file,
//      and reloading it from those bytes rebuilds a populated node graph)
//   C) the reloaded scene renders the SAME screenshot as before saving
//
// How it exercises the REAL save/load paths without a server or login:
//   - SAVE: window.CustomManager.getCustomSitchString() returns the exact JSON
//     text that saving uploads (CustomManagerSerialize.js:95/545) — a pure
//     data export with no network call.
//   - LOAD: the app's ?custom=<url> path does fetch(url) -> textSitchToObject()
//     -> new CSituation() (index.js:612-623). We point ?custom= at a sentinel
//     URL and use page.route() to fulfill that fetch with the just-saved bytes,
//     so the sitch is fully reconstructed from its serialized form.
//
// Fresh-construct (?action=new) vs deserialize (?custom=) are different code
// paths, so screenshot A == screenshot B is a genuine fidelity check, not a
// tautology. The comparison is done in-test (no committed baseline to drift):
// it always re-derives both sides and asserts they agree within the same
// tolerance the rest of the suite uses (threshold 0.02, maxDiffPixels 20000).
//
// Only the custom sitch is fully serializable (CustomSupport.js guards
// serialization with `if (!Sit.isCustom) return`), which is why the default
// custom sitch is both the right and the only meaningful choice here.

import {expect, test} from '@playwright/test';
import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';
import {writeFileSync} from 'fs';
import {
    assertServerReachable,
    attachConsoleErrorRejector,
    buildRegressionUrl,
    formatSceneSettleState,
    waitForFrames,
    waitForRenderFrame,
    waitForSceneToSettle,
} from './settle-utils.js';

// Same tolerance the visual suite uses (snapshot-utils.js defaultOptions).
const PIXEL_THRESHOLD = 0.02;
const MAX_DIFF_PIXELS = 20000;

// A cross-origin URL that will never be reached on the network — page.route()
// intercepts the app's fetch of it and returns the freshly-serialized sitch.
const SENTINEL_CUSTOM_URL = 'https://sitrec-roundtrip.invalid/roundtrip-default-sitch.js';

// Read the sitch identity used for the before/after sanity checks (proves the
// load produced a real, populated, custom sitch rather than an empty scene).
async function readSitchIdentity(page) {
    return page.evaluate(() => ({
        isCustom: !!window.Sit?.isCustom,
        name: window.Sit?.name ?? '',
        nodeCount: (window.NodeMan && window.NodeMan.list) ? Object.keys(window.NodeMan.list).length : 0,
    }));
}

async function loadAndSettle(page, fullUrl, label) {
    console.log(`[ROUNDTRIP] Loading (${label}): ${fullUrl}`);
    const response = await page.goto(fullUrl, {waitUntil: 'load', timeout: 30000});
    if (response && !response.ok()) {
        console.warn(`[ROUNDTRIP] ${label} load status ${response.status()}`);
    }
    const settle = await waitForSceneToSettle(page, {maxWaitMs: 90000});
    console.log(`[ROUNDTRIP] ${label} settled (${settle.timedOut ? 'timed out' : 'stable'}): ${formatSceneSettleState(settle.state)}`);
    await waitForFrames(page, 5);
    await waitForRenderFrame(page);
}

test.describe('Save/Load Round-Trip', () => {
    // One retry absorbs the same SwiftShader/program-link flakes the rest of
    // the visual suite guards against; a genuine round-trip regression fails
    // both attempts.
    test.describe.configure({retries: 1});

    test('default sitch survives a save -> load round trip with the same render', async ({page, baseURL}, testInfo) => {
        test.setTimeout(300000);

        // The dev server is expected to always be up — fail fast and clearly if
        // it isn't, rather than letting the first navigation hit its 30s timeout.
        await assertServerReachable(page.request, baseURL);

        await page.setViewportSize({width: 1920, height: 1080});

        // A) crash detection: reject the moment an ASSERT or real error fires.
        const {errorPromise, detach} = attachConsoleErrorRejector(page, {label: `W${testInfo.workerIndex}`});

        const run = async () => {
            // --- 1. Load the default (custom) sitch ----------------------------
            await loadAndSettle(page, buildRegressionUrl('?action=new&frame=10'), 'default');

            const before = await readSitchIdentity(page);
            expect(before.isCustom, 'default sitch should be the custom (savable) sitch').toBe(true);
            expect(before.nodeCount, 'node graph should be populated before saving').toBeGreaterThan(10);

            const screenshotA = await page.screenshot({fullPage: true, timeout: 30000});

            // --- 2. SAVE: serialize via the real save serialization ------------
            const saved = await page.evaluate(() => window.CustomManager.getCustomSitchString());
            expect(typeof saved, 'getCustomSitchString() should return a string').toBe('string');
            expect(saved.length, 'serialized sitch should be substantial').toBeGreaterThan(500);

            // It must be valid, sitch-shaped JSON — JSON.parse throwing here is a
            // real "save produced garbage" failure (B).
            let parsed;
            expect(() => {
                parsed = JSON.parse(saved);
            }, 'serialized sitch should be valid JSON').not.toThrow();
            expect(parsed?.isASitchFile ?? parsed?.isCustom ?? parsed?.name,
                'serialized sitch should look like a sitch file').toBeTruthy();

            // --- 3. LOAD: reconstruct from the saved bytes via ?custom= --------
            // Intercept the app's fetch of the sentinel URL and return the bytes
            // we just serialized, exercising the real fetch->parse->CSituation path.
            await page.route(SENTINEL_CUSTOM_URL, (route) => route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                headers: {'Access-Control-Allow-Origin': '*'},
                body: saved,
            }));

            const loadUrl = buildRegressionUrl('?custom=' + encodeURIComponent(SENTINEL_CUSTOM_URL) + '&frame=10');
            await loadAndSettle(page, loadUrl, 'reloaded');

            const after = await readSitchIdentity(page);
            expect(after.isCustom, 'reloaded sitch should still be custom').toBe(true);
            expect(after.nodeCount, 'reloaded node graph should be populated').toBeGreaterThan(10);
            expect(after.name, 'reloaded sitch name should match the saved sitch').toBe(before.name);

            const screenshotB = await page.screenshot({fullPage: true, timeout: 30000});

            // --- 4. COMPARE: same render before save and after load (C) --------
            const pngA = PNG.sync.read(screenshotA);
            const pngB = PNG.sync.read(screenshotB);
            expect(pngB.width, 'screenshot widths should match').toBe(pngA.width);
            expect(pngB.height, 'screenshot heights should match').toBe(pngA.height);

            const diff = new PNG({width: pngA.width, height: pngA.height});
            const numDiff = pixelmatch(
                pngA.data, pngB.data, diff.data, pngA.width, pngA.height,
                {threshold: PIXEL_THRESHOLD},
            );
            console.log(`[ROUNDTRIP] save->load pixel diff: ${numDiff} (max ${MAX_DIFF_PIXELS})`);

            if (numDiff > MAX_DIFF_PIXELS) {
                // Save artifacts so the difference can be inspected.
                writeFileSync(testInfo.outputPath('roundtrip_before_save.png'), screenshotA);
                writeFileSync(testInfo.outputPath('roundtrip_after_load.png'), screenshotB);
                writeFileSync(testInfo.outputPath('roundtrip_diff.png'), PNG.sync.write(diff));
                console.log(`[ROUNDTRIP] diff artifacts written to ${testInfo.outputPath('')}`);
            }

            expect(numDiff,
                `save->load changed ${numDiff} pixels (max ${MAX_DIFF_PIXELS}); see roundtrip_*.png artifacts`)
                .toBeLessThanOrEqual(MAX_DIFF_PIXELS);
        };

        try {
            await Promise.race([run(), errorPromise]);
        } finally {
            detach();
        }
    });
});
