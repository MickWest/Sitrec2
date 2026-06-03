#!/usr/bin/env node
/**
 * Fast Chrome visual regression runner.
 *
 * Goal: run a visual regression pass over every sitch carrying the
 * "Regression" label, MUCH faster than the Playwright test-runner suite, by:
 *
 *   - Using the *real* installed Google Chrome (channel: 'chrome') instead of
 *     Playwright's bundled Chromium. On macOS this means the Metal/ANGLE GPU
 *     path — fast AND deterministic, unlike the SwiftShader CPU rasterizer the
 *     CI suite falls back to (which is the source of its brightness/empty-render
 *     flakes).
 *   - A single *persistent* browser context with a warm on-disk cache. The
 *     first cold run downloads tiles/assets; every subsequent run serves them
 *     from disk, so a complex sitch loads in a couple of seconds — exactly the
 *     "lack of caching" speedup the existing suite never gets (fresh context
 *     per worker).
 *   - One browser, sequential (or lightly concurrent) navigations — no
 *     per-test worker spawn, no 4-way SwiftShader contention.
 *
 * Per sitch it does the actual regression check the user asked for: load,
 * wait for the scene to settle, jump to a fixed frame (locked via the
 * `frame=` URL param), screenshot a fixed-size region with the top menu bar
 * (which contains a live clock!) cropped off, and pixel-compare to a baseline.
 *
 * The set of sitches is enumerated dynamically from the server's label
 * metadata, so coverage grows automatically as sitches are tagged
 * "Regression" in the sitch browser — no hardcoded list to maintain. Labelled
 * sitches are gathered across all --user accounts (default 99999999 then 1).
 * When a sitch has saved versions under more than one account, the FIRST listed
 * user wins — so 99999999 (the curated regression user) is preferred and user 1
 * (the admin account) is only a fallback for sitches it solely owns.
 *
 * Usage:
 *   node tests_regression/fast-regression/run.mjs                # compare vs baselines
 *   node tests_regression/fast-regression/run.mjs --update       # (re)write baselines
 *   node tests_regression/fast-regression/run.mjs --list         # just list the Regression sitches
 *   node tests_regression/fast-regression/run.mjs --filter=wind  # only sitches whose name matches
 *   node tests_regression/fast-regression/run.mjs --user=99999999,1  # test users to enumerate under (first wins)
 *   node tests_regression/fast-regression/run.mjs --concurrency=3
 *   node tests_regression/fast-regression/run.mjs --headless     # new-headless Chrome (no window)
 *
 * Output: a machine-readable report at output/report.json (for agents/CI) plus
 * a human summary on stdout. On a diff, Good/Bad/Diff PNGs land in output/.
 */

// local.metabunk.org is a dev host; Node's fetch would reject its cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import {chromium} from 'playwright';
import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';
import {existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, unlinkSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config + CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
};

const CONFIG = {
    base: (opt('base', process.env.SITREC_REGRESS_BASE || 'https://local.metabunk.org/regress/')).replace(/\/?$/, '/'),
    // Test users to enumerate Regression-labelled sitches under. 99999999 is the
    // shared regression test user (its saved versions are the curated fixtures the
    // baselines are captured against); user 1 is the real admin account, used only
    // as a fallback for sitches that exist solely under it. Order matters: when a
    // sitch has versions under several users, the first listed wins, so 99999999
    // is preferred. Comma-separated, e.g. --user=99999999,1.
    testUserIDs: opt('user', '99999999,1').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)),
    label: opt('label', 'Regression'),
    frame: Number(opt('frame', '10')),
    viewport: {width: Number(opt('width', '1920')), height: Number(opt('height', '1080'))},
    cropTop: Number(opt('cropTop', '30')),     // menu bar (with live clock) height + margin
    // Default 3 lanes: ~2x faster (overlaps settle/tile-load across sitches) and
    // proven pixel-identical to serial on a real GPU — contention shifts timing,
    // not pixels. Drop to --concurrency=1 for the most deterministic ordering or
    // on a CPU rasterizer (CI/SwiftShader), where parallel WebGL contexts can
    // lose the GPU context under contention.
    concurrency: Math.max(1, Number(opt('concurrency', '3'))),
    localTerrain: flag('localTerrain'),
    headless: flag('headless'),
    update: flag('update'),
    list: flag('list'),
    filter: opt('filter', null),
    sitches: opt('sitches', null),     // explicit comma-separated names (bypass label enumeration)
    perSitchTimeoutMs: Number(opt('timeout', '90000')),
    // pixelmatch sensitivity. threshold = per-pixel color tolerance (0..1).
    // maxDiffRatio = fraction of differing pixels we tolerate before failing.
    matchThreshold: Number(opt('matchThreshold', '0.05')),
    maxDiffRatio: Number(opt('maxDiffRatio', '0.001')),
};

const baselineDir = join(__dirname, 'baseline');
const outputDir = join(__dirname, 'output');
const profileDir = join(__dirname, '.chrome-profile');
for (const d of [baselineDir, outputDir, profileDir]) mkdirSync(d, {recursive: true});

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------
// Enumeration: which sitches carry the label, and their latest version URL.
// Done from Node (no browser, no CORS) against the same endpoints the sitch
// browser uses.
// ---------------------------------------------------------------------------
async function fetchJson(url) {
    const r = await fetch(url, {headers: {'Accept': 'application/json'}});
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
}

async function enumerateSitches() {
    const server = CONFIG.base + 'sitrecServer/';
    // Append a testUserID to a URL (the param the sitch browser / endpoints use).
    const tu = (u, uid) => u + (u.includes('?') ? '&' : '?') + 'testUserID=' + uid;

    let names;
    if (CONFIG.sitches) {
        // Explicit list of saved-sitch names (vetting candidates without needing
        // the label yet). Comma-separated; whitespace trimmed.
        names = CONFIG.sitches.split(',').map(s => s.trim()).filter(Boolean);
    } else {
        // The label map (metadata.php sitchLabels) is global — the same regardless
        // of testUserID — so it tells us a sitch IS labelled, but not which user
        // owns its saved versions. Take the UNION of labelled names across users
        // (a query per user, in case any user ever sees a different map), then
        // resolve the owning user per-sitch in the version fetch below.
        const nameSet = new Set();
        for (const uid of CONFIG.testUserIDs) {
            let meta;
            try {
                meta = await fetchJson(tu(server + 'metadata.php', uid));
            } catch (e) {
                console.warn(`  ! metadata fetch failed for user ${uid}: ${e.message}`);
                continue;
            }
            const sitchLabels = Array.isArray(meta.sitchLabels) ? {} : (meta.sitchLabels || {});
            for (const [n, labs] of Object.entries(sitchLabels))
                if (Array.isArray(labs) && labs.includes(CONFIG.label)) nameSet.add(n);
        }
        names = [...nameSet].sort((a, b) => a.localeCompare(b));
    }

    if (CONFIG.filter) names = names.filter(n => n.toLowerCase().includes(CONFIG.filter.toLowerCase()));

    const sitches = [];
    for (const name of names) {
        // A labelled sitch's versions live under exactly one user; we don't know
        // which from the (global) label map, so try every test user and use the
        // first that actually has saved versions.
        let versions, usedUid;
        for (const uid of CONFIG.testUserIDs) {
            const vurl = server + 'getsitches.php?get=versions&name=' + encodeURIComponent(name) +
                '&userid=' + uid;
            try {
                const v = await fetchJson(tu(vurl, uid));
                if (Array.isArray(v) && v.length > 0) { versions = v; usedUid = uid; break; }
            } catch (e) {
                // try the next user
            }
        }
        if (!versions) {
            console.warn(`  ! no versions found for "${name}" (users tried: ${CONFIG.testUserIDs.join(', ')})`);
            continue;
        }
        const latest = versions[versions.length - 1];
        sitches.push({name, slug: slug(name), version: latest.version, url: latest.url, ref: latest.ref, userid: usedUid});
    }
    return sitches;
}

function buildLoadUrl(sitch) {
    const params = [
        'custom=' + encodeURIComponent(sitch.url),
        'regression=1',
        'frame=' + CONFIG.frame,
        'ignoreunload=1',
    ];
    if (CONFIG.localTerrain) params.push('regressionLocalTerrain=1');
    return CONFIG.base + '?' + params.join('&');
}

// ---------------------------------------------------------------------------
// Scene-settle detection (ported from tests_regression/regression.test.js).
// Reads sitrec's load/parse/tile/elevation bookkeeping plus a hash of the set
// of visible tiles, and waits for it to go quiet AND stable. This is the
// battle-tested heuristic the existing suite uses, tuned here for speed.
// ---------------------------------------------------------------------------
function settleStateFn() {
    const globals = window.Globals;
    const nodeMan = window.NodeMan;
    const loadingDiv = document.getElementById('loadingIndicator');
    const terrainUI = (nodeMan?.exists && nodeMan.exists('terrainUI')) ? nodeMan.get('terrainUI') : null;

    const state = {
        ready: !!globals && !!nodeMan && !!nodeMan.list,
        pendingActions: 0, deserializing: false, parsing: 0, loadingVisible: false,
        texturePendingLoads: 0, textureLoading: 0, textureRecalc: 0, texturePendingAncestor: 0,
        elevationLoading: 0, elevationRecalc: 0, elevationPendingAncestor: 0,
        pending3DTiles: 0, activeVisibleTextureTiles: 0, visibleTileHash: 0,
        videoPending: false,
        mapType: terrainUI?.mapType || '', elevationType: terrainUI?.elevationType || '',
        sitName: window.Sit?.name || '', frame: (typeof window.par !== 'undefined') ? window.par.frame : null,
    };
    if (!state.ready) return state;

    state.pendingActions = globals.pendingActions ?? 0;
    state.deserializing = !!globals.deserializing;
    state.parsing = globals.parsing ?? 0;
    state.loadingVisible = !!loadingDiv && loadingDiv.style.display !== 'none' &&
        (loadingDiv.textContent || '').includes('Loading');
    if (typeof window.areVideoFramesPendingForFixedFrame === 'function') {
        try { state.videoPending = !!window.areVideoFramesPendingForFixedFrame(); } catch { /* ignore */ }
    }

    const hashString = (input) => {
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return hash >>> 0;
    };

    for (const entry of Object.values(nodeMan.list)) {
        const node = entry?.data;
        if (!node) continue;

        if (node.elevationMap && node.elevationMap.forEachTile) {
            node.elevationMap.forEachTile((tile) => {
                if ((tile.tileLayers ?? 0) === 0) return;
                if (tile.isLoadingElevation) state.elevationLoading++;
                if (tile.isRecalculatingCurve) state.elevationRecalc++;
                if (tile.pendingAncestorLoad) state.elevationPendingAncestor++;
            });
        }

        if (node.maps) {
            for (const mapID in node.maps) {
                const map = node.maps[mapID]?.map;
                if (!map || !map.forEachTile) continue;
                if (map.pendingTileLoads && typeof map.pendingTileLoads.size === 'number') {
                    state.texturePendingLoads += map.pendingTileLoads.size;
                }
                map.forEachTile((tile) => {
                    const active = (tile.tileLayers ?? 0) !== 0;
                    const visible = !!tile.mesh?.visible;
                    if (!active || !visible) return;
                    state.activeVisibleTextureTiles++;
                    if (tile.isLoading) state.textureLoading++;
                    if (tile.isRecalculatingCurve) state.textureRecalc++;
                    if (tile.pendingAncestorLoad) state.texturePendingAncestor++;
                    const sig = `${mapID}:${tile.z}/${tile.x}/${tile.y}:${tile.usingParentData ? 1 : 0}:${tile.needsHighResLoad ? 1 : 0}`;
                    state.visibleTileHash = (state.visibleTileHash ^ hashString(sig)) >>> 0;
                });
            }
        }

        if (typeof node.getPendingLoadState === 'function') {
            const pending = node.getPendingLoadState();
            if (pending?.hasPending) state.pending3DTiles++;
        }
    }
    return state;
}

function isPending(s) {
    if (!s.ready) return true;
    return s.pendingActions > 0 || s.deserializing || s.parsing > 0 || s.loadingVisible ||
        s.texturePendingLoads > 0 || s.textureLoading > 0 || s.textureRecalc > 0 ||
        s.texturePendingAncestor > 0 || s.elevationLoading > 0 || s.elevationRecalc > 0 ||
        s.elevationPendingAncestor > 0 || s.pending3DTiles > 0 || s.videoPending;
}

// minWaitMs is the floor we wait before trusting a "quiet" reading when we have
// NOT seen any load activity. Terrain sitches trip observedBusy (tile loads) and
// finish as soon as they're stable, ignoring this floor. But celestial / no-tile
// sitches (night sky, some rocket/eclipse sitches) never trip it, so this floor
// must be long enough for their async load (stars/TLE/definition) to complete —
// otherwise we screenshot an empty scene at frame 0. 3000 matches the original
// suite and is overlapped away by --concurrency.
async function waitForSettle(page, {maxWaitMs = 60000, stableChecks = 20, minWaitMs = 3000} = {}) {
    const start = Date.now();
    let stable = 0, lastSig = '', observedBusy = false;
    while (Date.now() - start < maxWaitMs) {
        const s = await page.evaluate(settleStateFn);
        const sig = `${s.activeVisibleTextureTiles}:${s.visibleTileHash}`;
        if (isPending(s)) {
            observedBusy = true; stable = 0; lastSig = '';
        } else {
            if (sig === lastSig) stable++; else { stable = 1; lastSig = sig; }
            const elapsed = Date.now() - start;
            if ((observedBusy || elapsed >= minWaitMs) && stable >= stableChecks) {
                return {timedOut: false, state: s};
            }
        }
        await page.waitForTimeout(40);
    }
    return {timedOut: true, state: await page.evaluate(settleStateFn)};
}

// Force one render frame to actually complete (flag + double rAF), then flush
// every WebGL context so the GPU has truly caught up before we screenshot.
// Without the flush, drivers that batch command submission can leave sub-pixel
// rasterization in flight, producing spurious 1-3px diffs.
async function renderOneFrame(page) {
    await page.evaluate(() => new Promise((resolve) => {
        try { if (window.setRenderOne) window.setRenderOne(true); } catch { /* ignore */ }
        requestAnimationFrame(() => requestAnimationFrame(() => {
            try {
                const vm = window.ViewMan;
                if (vm && vm.list) {
                    for (const e of Object.values(vm.list)) {
                        const r = e?.data?.renderer;
                        if (r && typeof r.getContext === 'function') {
                            try { const gl = r.getContext(); if (gl && gl.flush) gl.flush(); } catch { /* ignore */ }
                        }
                    }
                }
            } catch { /* ignore */ }
            resolve();
        }));
    }));
}

// ~95% one-color => blank/failed render.
function isBlank(pngBuffer) {
    try {
        const png = PNG.sync.read(pngBuffer);
        const {data, width, height} = png;
        const n = width * height;
        const step = Math.max(1, Math.floor(n / 5000));
        const counts = {};
        let samples = 0;
        for (let i = 0; i < n; i += step) {
            const o = i * 4;
            const key = ((data[o] & 0xF8) << 16) | ((data[o + 1] & 0xF8) << 8) | (data[o + 2] & 0xF8);
            counts[key] = (counts[key] || 0) + 1;
            samples++;
        }
        return Math.max(...Object.values(counts)) / samples > 0.95;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Per-sitch processing
// ---------------------------------------------------------------------------
async function processSitch(context, sitch) {
    const result = {
        name: sitch.name, slug: sitch.slug, status: 'error',
        loadMs: 0, settleMs: 0, settleTimedOut: false, diffPixels: 0, diffRatio: 0,
        dims: null, renderedFrame: null, consoleErrors: [], note: '', cause: '',
        baselinePath: join(baselineDir, sitch.slug + '.png'),
        actualPath: null, diffPath: null,
    };
    const t0 = Date.now();
    const page = await context.newPage();
    const consoleErrors = [];
    let assertSeen = null;

    page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('ASSERT:')) { assertSeen = text; consoleErrors.push(text); return; }
        if (msg.type() === 'error') {
            const u = msg.location()?.url || '';
            if (text.includes('Failed to load resource') && (u.endsWith('/favicon.ico'))) return;
            consoleErrors.push(text);
        }
    });
    page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

    try {
        const url = buildLoadUrl(sitch);
        await page.goto(url, {waitUntil: 'load', timeout: 30000});

        const settleStart = Date.now();
        const settle = await waitForSettle(page, {maxWaitMs: CONFIG.perSitchTimeoutMs});
        result.settleMs = Date.now() - settleStart;
        result.settleTimedOut = settle.timedOut;
        result.note = `map=${settle.state.mapType || '?'} elev=${settle.state.elevationType || '?'} frame=${settle.state.frame}`;

        if (assertSeen) {
            result.status = 'fail';
            result.note = 'ASSERT: ' + assertSeen.slice(0, 200);
            result.cause = 'assertion failure during load';
            result.consoleErrors = consoleErrors.slice(0, 20);
            return result;
        }

        await renderOneFrame(page);

        // Confirm the frame lock actually took (regression mode renders on
        // demand, so par.frame only snaps to fixedFrame once a frame renders).
        const renderedFrame = await page.evaluate(() => (typeof window.par !== 'undefined') ? window.par.frame : null);
        result.renderedFrame = renderedFrame;
        if (renderedFrame !== CONFIG.frame) {
            result.note += ` frameMismatch(want ${CONFIG.frame},got ${renderedFrame})`;
        }

        const clip = {x: 0, y: CONFIG.cropTop, width: CONFIG.viewport.width, height: CONFIG.viewport.height - CONFIG.cropTop};
        let buf = await page.screenshot({clip, timeout: 30000});
        if (isBlank(buf)) {
            await renderOneFrame(page);
            await page.waitForTimeout(300);
            await renderOneFrame(page);
            buf = await page.screenshot({clip, timeout: 30000});
            if (isBlank(buf)) {
                result.status = 'error';
                result.note = 'blank render';
                result.cause = 'blank/empty render (no scene)';
                result.consoleErrors = consoleErrors.slice(0, 20);
                return result;
            }
        }

        const actual = PNG.sync.read(buf);
        result.dims = `${actual.width}x${actual.height}`;
        const baselinePath = join(baselineDir, sitch.slug + '.png');

        const hadBaseline = existsSync(baselinePath);
        if (CONFIG.update || !hadBaseline) {
            writeFileSync(baselinePath, buf);
            result.status = hadBaseline ? 'updated' : 'baseline';
            // Clean any stale diff artifacts for this sitch.
            for (const suf of ['_Bad', '_Diff']) {
                const p = join(outputDir, sitch.slug + suf + '.png');
                if (existsSync(p)) unlinkSync(p);
            }
            return result;
        }

        const baseline = PNG.sync.read(readFileSync(baselinePath));
        if (baseline.width !== actual.width || baseline.height !== actual.height) {
            result.status = 'fail';
            result.note = `size mismatch baseline ${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}`;
            result.cause = `dimension mismatch ${baseline.width}x${baseline.height} -> ${actual.width}x${actual.height}`;
            result.actualPath = join(outputDir, sitch.slug + '_Bad.png');
            writeFileSync(result.actualPath, buf);
            return result;
        }

        const diff = new PNG({width: actual.width, height: actual.height});
        const diffPixels = pixelmatch(baseline.data, actual.data, diff.data, actual.width, actual.height, {threshold: CONFIG.matchThreshold});
        const total = actual.width * actual.height;
        result.diffPixels = diffPixels;
        result.diffRatio = diffPixels / total;

        if (result.diffRatio > CONFIG.maxDiffRatio) {
            result.status = 'fail';
            result.cause = `${result.diffPixels}px differ (${(result.diffRatio * 100).toFixed(3)}% > ${(CONFIG.maxDiffRatio * 100).toFixed(3)}% tolerance)`;
            result.actualPath = join(outputDir, sitch.slug + '_Bad.png');
            result.diffPath = join(outputDir, sitch.slug + '_Diff.png');
            writeFileSync(result.actualPath, buf);
            writeFileSync(result.diffPath, PNG.sync.write(diff));
        } else {
            result.status = 'pass';
            for (const suf of ['_Bad', '_Diff']) {
                const p = join(outputDir, sitch.slug + suf + '.png');
                if (existsSync(p)) unlinkSync(p);
            }
        }
        result.consoleErrors = consoleErrors.slice(0, 20);
        return result;
    } catch (e) {
        result.status = 'error';
        result.note = (result.note ? result.note + ' | ' : '') + e.message;
        result.consoleErrors = consoleErrors.slice(0, 20);
        return result;
    } finally {
        result.loadMs = Date.now() - t0;
        if (!result.cause) {
            result.cause = {
                pass: 'matches baseline within tolerance',
                baseline: 'baseline created',
                updated: 'baseline updated',
            }[result.status] || result.note || result.status;
        }
        await page.close().catch(() => {});
    }
}

// Simple concurrency pool.
async function runPool(items, n, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function loop() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({length: Math.min(n, items.length)}, loop));
    return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const runStart = Date.now();
    console.log(`Enumerating "${CONFIG.label}" sitches from ${CONFIG.base} ...`);
    const sitches = await enumerateSitches();
    console.log(`Found ${sitches.length} "${CONFIG.label}" sitch(es):`);
    for (const s of sitches) console.log(`  - ${s.name}  [${s.version}]`);

    if (CONFIG.list) {
        writeFileSync(join(outputDir, 'sitches.json'), JSON.stringify(sitches, null, 2));
        return 0;
    }
    if (sitches.length === 0) {
        console.error('No sitches to test.');
        return 1;
    }

    const context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: CONFIG.headless,
        viewport: CONFIG.viewport,
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
        args: ['--hide-scrollbars', '--mute-audio'],
    });

    let results;
    try {
        console.log(`\nRunning (concurrency=${CONFIG.concurrency}, ${CONFIG.headless ? 'headless' : 'headed'} Chrome)...\n`);
        results = await runPool(sitches, CONFIG.concurrency, async (sitch) => {
            const r = await processSitch(context, sitch);
            const tag = {pass: '✓ PASS', baseline: '＋ BASE', updated: '↻ UPDT', fail: '✗ FAIL', error: '‼ ERR '}[r.status] || r.status;
            const extra = r.status === 'pass' || r.status === 'fail'
                ? ` diff=${r.diffPixels}px (${(r.diffRatio * 100).toFixed(3)}%)` : '';
            console.log(`${tag}  ${r.name.padEnd(34)} ${(r.loadMs / 1000).toFixed(1)}s  settle=${(r.settleMs / 1000).toFixed(1)}s${r.settleTimedOut ? '*' : ''}${extra}${r.note ? '  [' + r.note + ']' : ''}`);
            return r;
        });
    } finally {
        await context.close().catch(() => {});
    }

    const totalMs = Date.now() - runStart;
    const counts = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    const report = {
        timestamp: new Date(runStart).toISOString(),
        base: CONFIG.base, label: CONFIG.label, frame: CONFIG.frame,
        viewport: CONFIG.viewport, cropTop: CONFIG.cropTop,
        concurrency: CONFIG.concurrency, headless: CONFIG.headless,
        totalMs, counts, results,
    };
    writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));

    console.log('\n' + '─'.repeat(60));
    console.log(`Done in ${(totalMs / 1000).toFixed(1)}s — ` +
        Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
    // Show a one-line cause for anything that didn't pass, so an agent (or a
    // human skimming) sees *why* without opening report.json.
    for (const r of results) {
        if (r.status === 'fail' || r.status === 'error') {
            console.log(`   ${r.status === 'error' ? '‼' : '✗'} ${r.name}: ${r.cause}` +
                (r.diffPath ? `\n       diff:   ${r.diffPath}\n       actual: ${r.actualPath}\n       base:   ${r.baselinePath}` : ''));
        }
    }
    console.log(`Report: ${join(outputDir, 'report.json')}`);

    // Exit codes for programmatic callers: 0 = all good, 1 = visual diffs
    // only, 2 = at least one hard error (load/assert/blank). Errors dominate.
    if (counts.error > 0) return 2;
    if (counts.fail > 0) return 1;
    return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
});
