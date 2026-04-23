#!/usr/bin/env node
/**
 * Populate a Local-tile cache (elevation + Esri imagery) under $SITREC_TERRAIN_DIR,
 * so Playwright regression runs with REGRESSION_LOCAL_TERRAIN=1 don't need external
 * network access for terrain rendering.
 *
 * Env:
 *   SITREC_TERRAIN_DIR  output root (default: /build/sitrec-terrain — Docker sandbox)
 *   MAX_ELEV            max zoom for elevation (default: 6)
 *   MAX_IMG             max zoom for imagery   (default: 7)
 *   CONCURRENCY         parallel downloads (default: 24)
 *
 * Existing files are skipped; re-running resumes interrupted downloads.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.SITREC_TERRAIN_DIR || '/build/sitrec-terrain';
const ELEV_DIR = path.join(ROOT, 'elevation');
const IMG_DIR = path.join(ROOT, 'imagery', 'esri');
const MAX_ELEV = parseInt(process.env.MAX_ELEV || '6', 10);
const MAX_IMG = parseInt(process.env.MAX_IMG || '7', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '24', 10);

function ensureDir(p) { fs.mkdirSync(p, {recursive: true}); }

function download(url, out) {
    return new Promise((resolve) => {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) { resolve({skipped: true}); return; }
        ensureDir(path.dirname(out));
        const tmp = out + '.tmp';
        const file = fs.createWriteStream(tmp);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                file.close(); try { fs.unlinkSync(tmp); } catch {}
                resolve({error: res.statusCode, url});
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(() => { fs.renameSync(tmp, out); resolve({ok: true}); }); });
        }).on('error', (e) => { file.close(); try { fs.unlinkSync(tmp); } catch {}; resolve({error: e.message, url}); });
    });
}

async function runPool(tasks, conc) {
    let i = 0, done = 0, errs = 0, skipped = 0;
    const next = async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            const r = await t();
            if (r.error) errs++; else if (r.skipped) skipped++; else done++;
            if ((done + errs + skipped) % 100 === 0) {
                process.stdout.write(`  ${done+errs+skipped}/${tasks.length} (dl=${done} skip=${skipped} err=${errs})\n`);
            }
        }
    };
    await Promise.all(Array.from({length: conc}, next));
    console.log(`Done: dl=${done} skip=${skipped} err=${errs} total=${tasks.length}`);
}

async function main() {
    const tasks = [];
    for (let z = 0; z <= MAX_ELEV; z++) {
        const n = 1 << z;
        for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
            const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
            const out = path.join(ELEV_DIR, String(z), String(x), `${y}.png`);
            tasks.push(() => download(url, out));
        }
    }
    for (let z = 0; z <= MAX_IMG; z++) {
        const n = 1 << z;
        for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
            const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
            const out = path.join(IMG_DIR, String(z), String(y), `${x}.jpg`);
            tasks.push(() => download(url, out));
        }
    }
    console.log(`Downloading ${tasks.length} tiles (elev 0..${MAX_ELEV}, imagery 0..${MAX_IMG})`);
    await runPool(tasks, CONCURRENCY);
}

main().catch(err => { console.error(err); process.exit(1); });
