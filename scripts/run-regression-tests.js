#!/usr/bin/env node
/**
 * Regression test runner.
 *
 * Runs Playwright headlessly and, on Linux without an existing $DISPLAY,
 * starts an Xvfb virtual display so tests that opt out of headless mode
 * (e.g. video-cache-gaps.test.js) still launch successfully.
 *
 * Falls back to running Playwright directly when no Xvfb is available
 * (e.g. on macOS developer machines — Playwright is already headless per
 * playwright.config.js).
 */

const {spawn, spawnSync} = require('child_process');
const path = require('path');

const extraArgs = process.argv.slice(2);
const passArgs = extraArgs.length ? extraArgs : ["--grep-invert=Chatbot Tests"];

// Default REGRESSION_LOCAL_TERRAIN=1 so baselines are deterministic across
// host and sandbox — the test suite appends regressionLocalTerrain=1 to every
// URL, which forces the sitch to use the Local map source (the pre-cached
// tile bind mount) instead of external ESRI/AWS tiles. That both avoids the
// headless-fetch-stall bug and keeps darwin vs linux baselines tile-compatible
// (they differ only by rendering, not by tile data). Override per-run with
// REGRESSION_LOCAL_TERRAIN=0 for anyone who specifically wants to exercise
// the external-tile path.
if (process.env.REGRESSION_LOCAL_TERRAIN === undefined) {
    process.env.REGRESSION_LOCAL_TERRAIN = '1';
}

function commandExists(cmd) {
    const r = spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], {stdio: 'ignore'});
    return r.status === 0;
}

function runPlaywright(env) {
    return new Promise((resolve) => {
        const child = spawn('npx', ['playwright', 'test', ...passArgs], {
            stdio: 'inherit',
            env: {...process.env, ...env},
        });
        child.on('exit', (code) => resolve(code ?? 1));
    });
}

async function main() {
    if (process.platform !== 'linux' || process.env.DISPLAY || !commandExists('Xvfb')) {
        const code = await runPlaywright({});
        process.exit(code);
    }

    const display = ':' + (99 + Math.floor(Math.random() * 900));
    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let xvfbFailed = false;
    xvfb.on('error', () => {
        xvfbFailed = true;
    });
    // Give Xvfb a moment to bind; it's fine if this races — Playwright retries.
    await new Promise((r) => setTimeout(r, 500));

    let code;
    try {
        code = await runPlaywright(xvfbFailed ? {} : {DISPLAY: display});
    } finally {
        try { xvfb.kill('SIGTERM'); } catch {}
    }
    process.exit(code);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
