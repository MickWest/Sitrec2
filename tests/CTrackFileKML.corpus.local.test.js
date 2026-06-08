/**
 * @jest-environment jsdom
 *
 * Opt-in local corpus validation. Runs every real .kml/.kmz under CORPUS_DIR through
 * CTrackFileKML and reports files that SHOULD import (contain a track-like time+geometry
 * structure) but currently throw or yield no track. SKIPPED unless CORPUS_DIR is set, so it
 * is CI-safe and commits no absolute paths. Run before/after the generic-ingestion refactor
 * to prove no regressions across the full local corpus:
 *
 *   CORPUS_DIR="/path/to/Sitrec Resources" npx jest tests/CTrackFileKML.corpus.local.test.js
 *
 * NOTE: catches only THROW / NO-TRACK failures, not "silently wrong" imports (wrong
 * placemark chosen, time-disordered segments, wrong altitude datum).
 */
import fs from 'fs';
import path from 'path';
import {CTrackFileKML} from '../src/TrackFiles/CTrackFileKML';
import {parseXml} from '../src/parseXml';
import {MISB} from '../src/MISBFields';

// Compact, deterministic parity signature for one track's MISB rows. Run before AND after the
// generic-ingestion refactor; `diff` of the parity baseline MUST be empty for every file that
// imports today, or some existing save's geometry/count/index could have shifted.
function trackParity(misb) {
    const n = misb.length;
    if (!n) return 'n=0';
    const r = (v) => (v === undefined || v === null || Number.isNaN(v)) ? 'x' : Number(v).toFixed(5);
    const rt = (v) => (v === undefined ? 'x' : String(v));
    let h = 2166136261 >>> 0;
    for (let i = 0; i < n; i++) {
        const s = `${rt(misb[i][MISB.UnixTimeStamp])},${r(misb[i][MISB.SensorLatitude])},${r(misb[i][MISB.SensorLongitude])},${r(misb[i][MISB.SensorTrueAltitude])}`;
        for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
    }
    const a = misb[0], b = misb[n - 1];
    return `n=${n} t0=${rt(a[MISB.UnixTimeStamp])} t1=${rt(b[MISB.UnixTimeStamp])} `
        + `p0=${r(a[MISB.SensorLatitude])}/${r(a[MISB.SensorLongitude])}/${r(a[MISB.SensorTrueAltitude])} `
        + `pN=${r(b[MISB.SensorLatitude])}/${r(b[MISB.SensorLongitude])}/${r(b[MISB.SensorTrueAltitude])} h=${h.toString(16)}`;
}

jest.mock('../src/nodes/CNodeTrack', () => ({
    CNodeTrackFromLLAArray: jest.fn(() => ({setArray: jest.fn(), recalculateCascade: jest.fn()}))
}));
jest.mock('../src/nodes/CNodeDisplayTrack', () => ({CNodeDisplayTrack: jest.fn()}));
jest.mock('../src/LayerMasks', () => ({MASK_WORLD: 1}));
jest.mock('../src/Globals', () => ({
    CustomManager: {shouldIgnore: () => false, ignore: () => {}},
    NodeMan: {getUniqueID: (n) => n},
    Sit: {allowDashInFlightNumber: false}
}));
jest.mock('../src/CFeatureManager', () => ({FeatureManager: {addFeature: jest.fn()}}));

const JSZip = require('jszip');
// Opt-in local validation: point CORPUS_DIR at a local folder of real .kml/.kmz files.
// Skipped entirely (CI-safe) when CORPUS_DIR is unset or missing — no committed absolute paths.
const CORPUS = process.env.CORPUS_DIR;
const MAXBYTES = 40_000_000;

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!/dist-standalone|node_modules/.test(p)) walk(p, out); }
        else if (/\.(kml|kmz)$/i.test(e.name)) out.push(p);
    }
}

async function readKml(f) {
    if (/\.kmz$/i.test(f)) {
        const zip = await JSZip.loadAsync(fs.readFileSync(f));
        const name = Object.keys(zip.files).find(n => /\.kml$/i.test(n) && !zip.files[n].dir);
        return name ? await zip.files[name].async('string') : '';
    }
    return fs.readFileSync(f, 'utf-8');
}

function looksLikeTrack(raw) {
    if (/<gx:Track|<gx:MultiTrack/.test(raw)) return true;
    if (/<TimeStamp/.test(raw) && /<Point/.test(raw)) return true;
    if (/<TimeSpan/.test(raw) && /<(Point|LineString|gx:coord)/.test(raw)) return true;
    return false;
}

const hasCorpus = !!CORPUS && fs.existsSync(CORPUS);
const maybe = hasCorpus ? test : test.skip;

maybe('scan local KML corpus for import failures (set CORPUS_DIR)', async () => {
    const files = [];
    walk(CORPUS, files);
    const fail = [], skipped = [], names = [], parity = [];
    let ok = 0, legitNotTrack = 0;
    for (const f of files) {
        const sz = fs.statSync(f).size;
        if (sz > MAXBYTES) { skipped.push(f); continue; }
        let raw;
        try { raw = await readKml(f); } catch (e) { fail.push({f: f.replace(CORPUS, '~'), reason: 'unzip-err', sz}); continue; }
        const lt = looksLikeTrack(raw);
        const rel = f.replace(CORPUS, '~');
        let reason = null;
        try {
            const tf = new CTrackFileKML(parseXml(raw));
            const contains = tf.doesContainTrack();
            if (contains) {
                const misb = tf.toMISB(0);
                if (!Array.isArray(misb) || misb.length === 0) reason = 'claims-track-but-empty';
                else ok++;
                // FULL PARITY BASELINE — count + per-track geometry + name. The refactor must
                // reproduce this byte-for-byte for every currently-importing file (default path),
                // or an existing save's track id / index / positions / frame-range could shift.
                try {
                    const tc = tf.getTrackCount();
                    const parts = [];
                    for (let i = 0; i < tc; i++) {
                        let nm = '?'; try { nm = tf.getShortName(i, path.basename(f)); } catch (_) {}
                        let mi; try { mi = tf.toMISB(i); } catch (_) { parts.push(`[${i}] name=${nm} ERR`); continue; }
                        parts.push(`[${i}] name=${nm} ${Array.isArray(mi) ? trackParity(mi) : 'none'}`);
                    }
                    parity.push(`${rel}\tcount=${tc}\t${parts.join('  ||  ')}`);
                    names.push(`${tf.getShortName(0, path.basename(f))}\t${rel}`);
                } catch (_) {}
            } else if (lt) {
                reason = 'looks-like-track-but-no-track';
            } else {
                legitNotTrack++;
            }
        } catch (e) {
            if (lt) reason = 'THREW: ' + String(e.message).slice(0, 80);
            else legitNotTrack++;
        }
        if (reason) fail.push({f: rel, reason, sz});
    }
    // Baselines: run before AND after the refactor; `diff` of each MUST be empty for safety.
    names.sort();
    parity.sort();
    const TMP = process.env.TMPDIR || '/tmp';
    fs.writeFileSync(path.join(TMP, 'kml_names_baseline.txt'), names.join('\n'));
    fs.writeFileSync(path.join(TMP, 'kml_parity_baseline.txt'), parity.join('\n'));
    const report = [
        `scanned=${files.length} ok-track=${ok} legit-not-track=${legitNotTrack} skipped-large=${skipped.length} FAILURES=${fail.length}`,
        ...fail.map(x => `  [${x.reason}] (${x.sz}B) ${x.f}`),
        skipped.length ? `\nskipped (>${MAXBYTES}B): ${skipped.length}` : '',
    ].join('\n');
    fs.writeFileSync(path.join(process.env.TMPDIR || '/tmp', 'kml_corpus_failures.txt'), report);
    process.stdout.write('\n===== CORPUS SCAN =====\n' + report + '\n=======================\n');
    expect(true).toBe(true);
}, 600000);
