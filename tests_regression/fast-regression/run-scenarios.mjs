#!/usr/bin/env node
/**
 * run-scenarios.mjs — the Scenario Harness runner (see SCENARIO-HARNESS-PLAN.md).
 *
 * Sibling to run.mjs: it IMPORTS run.mjs's proven internals (settle/launch/enumerate)
 * rather than forking them, opens a fresh page PER scenario inside ONE shared persistent
 * Chrome context (so the on-disk tile/asset/video cache stays warm — the real speedup),
 * drives each scenario's steps through the shared stepRunner, and compares the captured
 * values against COMMITTED JSON baselines (value tier). Pixels (pixel tier) reuse run.mjs
 * and stay LOCAL-only — they arrive in milestone M5; M1 is value-only.
 *
 * Usage:
 *   node tests_regression/fast-regression/run-scenarios.mjs                 # compare vs value baselines
 *   node tests_regression/fast-regression/run-scenarios.mjs --update-values # (re)write value baselines (commit after review)
 *   node tests_regression/fast-regression/run-scenarios.mjs --scenario=gofast-camera-los
 *   node tests_regression/fast-regression/run-scenarios.mjs --filter=camera --headed --concurrency=2
 *
 * Exit codes: 0 all good · 1 value diffs / assert failures · 2 hard error (load/assert/blank).
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import {chromium} from 'playwright';
import {existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

import {
    CONFIG, buildLaunchOpts, buildLoadUrl, profileDir, outputDir,
    waitForSettle, renderOneFrame, runPool, enumerateSitches,
} from './run.mjs';
import {executeSteps, lintScenario, canonicalize, diffValue} from './stepRunner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, 'scenarios');
const valueBaselineDir = join(__dirname, 'value-baseline');
for (const d of [valueBaselineDir, outputDir]) mkdirSync(d, {recursive: true});

// ---------------------------------------------------------------------------
// CLI (reuses run.mjs CONFIG for base/headless/viewport/concurrency/timeout)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, def) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : def; };
const OPTS = {
    updateValues: flag('update-values'),
    scenario: opt('scenario', null),
    filter: opt('filter', null),
    list: flag('list'),
};

// ---------------------------------------------------------------------------
// Discover scenario modules: scenarios/<area>/<slug>.scenario.mjs
// ---------------------------------------------------------------------------
async function discoverScenarios() {
    if (!existsSync(scenariosDir)) return [];
    const files = readdirSync(scenariosDir, {recursive: true})
        .filter(f => typeof f === 'string' && f.endsWith('.scenario.mjs'))
        .map(f => join(scenariosDir, f))
        .sort();
    const out = [];
    for (const file of files) {
        try {
            const mod = await import(pathToFileURL(file).href);
            const sc = mod.default;
            if (!sc || !sc.id) { console.warn(`  ! ${file}: no default export with an id`); continue; }
            sc.__file = file;
            out.push(sc);
        } catch (e) {
            console.warn(`  ! failed to import ${file}: ${e.message}`);
        }
    }
    let filtered = out;
    if (OPTS.scenario) filtered = filtered.filter(s => s.id === OPTS.scenario);
    if (OPTS.filter) filtered = filtered.filter(s => s.id.toLowerCase().includes(OPTS.filter.toLowerCase()));
    return filtered;
}

// Resolve a scenario's load target into the {builtin|url, frame, ...} shape buildLoadUrl wants.
async function resolveLoadTarget(sc, setup = null) {
    if (setup?.target) {
        return {
            ...setup.target,
            frame: setup.target.frame ?? sc.frame,
            query: {...(setup.target.query || {}), ...(setup.query || {})},
            extraParams: [...(setup.target.extraParams || []), ...(setup.extraParams || [])],
        };
    }

    if (sc.builtin === false || sc.url) {
        // Saved/Regression sitch: resolve its latest version URL by name.
        if (sc.url) return {url: sc.url, name: sc.sitch, frame: sc.frame, localTerrain: sc.localTerrain, query: sc.query};
        const list = await enumerateSitches();
        const match = list.find(s => s.name === sc.sitch);
        if (!match) throw new Error(`saved sitch '${sc.sitch}' not found via enumerateSitches()`);
        return {url: match.url, name: match.name, frame: sc.frame, localTerrain: sc.localTerrain, query: sc.query};
    }
    return {builtin: true, sitch: sc.sitch, name: sc.sitch, frame: sc.frame, localTerrain: sc.localTerrain, query: sc.query};
}

// Narrow, STARTUP-SAFE, cache-safe network blocks. The primary write-protection is the
// lint (saveSitch/getShareLink are FORBIDDEN fns) + isolated never-saved pages; these route
// blocks are belt-and-suspenders only. Critically they must NOT break app init:
// rehost.php is DUAL-purpose — `?getuser=1` is a startup user-identity READ (must pass),
// while `?action=…` is the WRITE that precedes S3 PUT uploads. So we block only action=
// writes, never getuser. We do NOT install a catch-all route (it would bypass the warm HTTP
// cache and defeat the speedup).
async function installNetworkGuards(page, sc) {
    await page.route('**/rehost.php?*action=*', r => r.abort());   // rehost WRITE actions only (not getuser)
    if ((sc.network ?? 'none') === 'none') {
        // Live external data sources — value baselines must come from bundled fixtures, never
        // daily-changing feeds. Targeted host globs (don't match local rehost/getsitches), so
        // a scenario that doesn't fetch them is unaffected; one that does fails fast.
        for (const host of ['celestrak.org', 'celestrak.com', 'proxyStarlink.php', 'open-meteo.com',
                            'rucsoundings', 'weather.uwyo.edu', 'ncei.noaa.gov']) {
            await page.route(`**/*${host}*`, r => r.abort());
        }
    }
}

// ---------------------------------------------------------------------------
// Per-scenario processing
// ---------------------------------------------------------------------------
async function processScenario(context, sc) {
    const result = {
        id: sc.id, sitch: sc.sitch, status: 'error', cause: '',
        captures: {}, assertResults: [], warnings: [], diffs: [], consoleErrors: [],
        baselinePath: join(valueBaselineDir, sc.id + '.json'),
    };

    // Lint BEFORE opening a page — a forbidden/unbracketed-mutation scenario never runs.
    const lintErrors = lintScenario(sc);
    if (lintErrors.length) {
        result.status = 'error';
        result.cause = 'lint: ' + lintErrors.join('; ');
        return result;
    }

    const page = await context.newPage();
    const cleanupFns = [];
    let assertSeen = null;
    const consoleErrors = [];
    page.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('ASSERT:')) { assertSeen = t; consoleErrors.push(t); return; }
        if (msg.type() === 'error') {
            const u = msg.location()?.url || '';
            if (t.includes('Failed to load resource') && u.endsWith('/favicon.ico')) return;
            consoleErrors.push(t);
        }
    });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

    try {
        let setup = null;
        if (typeof sc.beforeLoad === 'function') {
            setup = await sc.beforeLoad({config: CONFIG, outputDir, cwd: process.cwd()});
            if (typeof setup?.cleanup === 'function') cleanupFns.push(setup.cleanup);
        }
        await installNetworkGuards(page, sc);
        const target = await resolveLoadTarget(sc, setup);
        const wantFrame = target.frame ?? sc.frame ?? CONFIG.frame;
        const url = buildLoadUrl(target);
        await page.goto(url, {waitUntil: 'load', timeout: 30000});
        const settle = await waitForSettle(page, {maxWaitMs: CONFIG.perSitchTimeoutMs, wantFrame});
        await renderOneFrame(page);

        if (assertSeen) {
            result.status = 'fail'; result.cause = 'ASSERT during load: ' + assertSeen.slice(0, 200);
            result.consoleErrors = consoleErrors.slice(0, 20);
            return result;
        }
        // getFrame returns the handleAPICall envelope {success, result:{frame,…}} — unwrap .result.
        const renderedFrame = await page.evaluate(`window.sitrecAPI.call('getFrame', {})`).then(r => r?.result?.frame);
        if (settle.timedOut || renderedFrame !== wantFrame) {
            result.status = 'error';
            result.cause = `never reached frame ${wantFrame} (got ${renderedFrame}, timedOut=${settle.timedOut})`;
            result.consoleErrors = consoleErrors.slice(0, 20);
            return result;
        }

        // Drive the steps through the shared interpreter.
        const driver = {
            evaluate: (expr) => page.evaluate(expr),
            settle: async (frame) => {
                await page.evaluate(`window.sitrecAPI.call('setFrame', {frame:${Number(frame)}})`);
                await waitForSettle(page, {wantFrame: Number(frame), maxWaitMs: CONFIG.perSitchTimeoutMs, minWaitMs: 200});
                await renderOneFrame(page);
            },
            // pixel tier (M5) — stubbed in M1
            screenshot: async () => null,
        };
        const exec = await executeSteps(driver, sc);
        result.captures = exec.captures;
        result.assertResults = exec.asserts;
        result.warnings = exec.warnings;

        result.consoleErrors = consoleErrors.slice(0, 20);
        if (assertSeen) { result.status = 'fail'; result.cause = 'ASSERT during steps: ' + assertSeen.slice(0, 200); return result; }
        if (exec.error) { result.status = 'error'; result.cause = 'step error: ' + exec.error; return result; }
        // Steps ran clean — fall through to the compare/write block, which sets the FINAL
        // status (pass/baseline/updated/fail). (result.status starts as 'error' as a fail-safe
        // default; clear it here so a clean run is not mistaken for an error.)
        result.status = 'ok';

        // ---- Compare or write the value baseline ----
        const failedAsserts = exec.asserts.filter(a => !a.ok);
        const hadBaseline = existsSync(result.baselinePath);
        const baselineObj = {schema: 1, scenarioId: sc.id, sitch: sc.sitch, frame: wantFrame, captures: exec.captures};

        if (OPTS.updateValues || !hadBaseline) {
            // POISON GUARD: never write a baseline from a failing run.
            if (failedAsserts.length) {
                result.status = 'fail';
                result.cause = `refusing to write baseline: ${failedAsserts.length} assert(s) failed`;
                result.diffs = failedAsserts;
                return result;
            }
            writeFileSync(result.baselinePath, JSON.stringify(baselineObj, null, 2) + '\n');
            result.status = hadBaseline ? 'updated' : 'baseline';
            return result;
        }

        // Compare each capture against the committed baseline with per-capture tolerance.
        const baseline = JSON.parse(readFileSync(result.baselinePath, 'utf8'));
        const tolFor = (name) => (sc.steps.find(s => (s.type === 'capture' && s.name === name)
            || (s.type === 'eval' && s.name === name) || (s.type === 'apiCall' && s.capture === name)) || {}).tol;
        const diffs = [];
        for (const name of Object.keys(exec.captures)) {
            if (!(name in (baseline.captures || {}))) { diffs.push({path: name, expected: '(absent)', actual: '(new capture)'}); continue; }
            for (const d of diffValue(baseline.captures[name], exec.captures[name], {tol: tolFor(name)})) {
                diffs.push({path: `${name}.${d.path}`, ...d});
            }
        }
        for (const name of Object.keys(baseline.captures || {})) {
            if (!(name in exec.captures)) diffs.push({path: name, expected: '(baseline)', actual: '(missing)'});
        }
        result.diffs = [...diffs, ...failedAsserts.map(a => ({path: 'assert:' + a.name, expected: a.expected, actual: a.actual}))];
        result.status = result.diffs.length ? 'fail' : 'pass';
        if (result.diffs.length) result.cause = `${result.diffs.length} value diff(s)/assert failure(s)`;
        return result;
    } catch (e) {
        result.status = 'error';
        result.cause = e.message || String(e);
        result.consoleErrors = consoleErrors.slice(0, 20);
        return result;
    } finally {
        await page.close().catch(() => {});
        for (const cleanup of cleanupFns.reverse()) {
            await cleanup().catch(() => {});
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const runStart = Date.now();
    console.log(`Discovering scenarios in ${scenariosDir} ...`);
    const scenarios = await discoverScenarios();
    console.log(`Found ${scenarios.length} scenario(s):`);
    for (const s of scenarios) console.log(`  - ${s.id}  [sitch=${s.sitch}, tier=${s.tier || 'value'}]`);
    if (OPTS.list) return 0;
    if (!scenarios.length) { console.error('No scenarios to run.'); return 1; }

    const context = await chromium.launchPersistentContext(profileDir, buildLaunchOpts(CONFIG));
    let results;
    try {
        console.log(`\nRunning (concurrency=${CONFIG.concurrency}, ${CONFIG.headless ? 'headless' : 'headed'}, ${OPTS.updateValues ? 'UPDATE-VALUES' : 'compare'})...\n`);
        results = await runPool(scenarios, CONFIG.concurrency, async (sc) => {
            const r = await processScenario(context, sc);
            const tag = {pass: '✓ PASS', baseline: '＋ BASE', updated: '↻ UPDT', fail: '✗ FAIL', error: '‼ ERR '}[r.status] || r.status;
            const nCap = Object.keys(r.captures).length, nAss = r.assertResults.length;
            console.log(`${tag}  ${r.id.padEnd(36)} captures=${nCap} asserts=${nAss}${r.cause ? '  [' + r.cause + ']' : ''}`);
            for (const w of r.warnings) console.log(`        ⚠ ${w}`);
            return r;
        });
    } finally {
        await context.close().catch(() => {});
    }

    const totalMs = Date.now() - runStart;
    const counts = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    writeFileSync(join(outputDir, 'scenario-report.json'),
        JSON.stringify({timestamp: new Date(runStart).toISOString(), totalMs, counts, results}, null, 2));

    console.log('\n' + '─'.repeat(60));
    console.log(`Done in ${(totalMs / 1000).toFixed(1)}s — ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
    for (const r of results) {
        if (r.status === 'fail' || r.status === 'error') {
            console.log(`   ${r.status === 'error' ? '‼' : '✗'} ${r.id}: ${r.cause}`);
            for (const d of (r.diffs || []).slice(0, 12)) {
                console.log(`       ${d.path}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.actual)}`
                    + (d.delta !== undefined ? ` (Δ${d.delta.toExponential(2)} > ${d.tol})` : ''));
            }
        }
    }
    console.log(`Report: ${join(outputDir, 'scenario-report.json')}`);

    if (counts.error > 0) return 2;
    if (counts.fail > 0) return 1;
    return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
