// Generate inputs first: npm run bench-bot-platform
// Run against your built local checkout:
// BOTBENCH_URL=https://local.metabunk.org/sitrec/?action=new npm run bench-bot-folder
// Optional: --folder=.../All (all files), --workers=8, --baseline=previous.json
// The default selects 16 cases across both platform paths and four error rungs.
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const files = [];
if (args.folder) {
    for (const name of readdirSync(args.folder).sort()) {
        if (name.endsWith('.all.csv')) files.push(path.resolve(args.folder, name));
    }
} else {
    for (const sensor of ['orbit', 'straight']) {
        for (const error of ['0.0', '0.02', '0.2', '2.0']) {
            const dir = path.join(root, `botset_platform_${sensor}`, 'batch_90s', `${error}deg`, 'All');
            const names = readdirSync(dir).filter(n => n.endsWith('.all.csv')).sort();
            for (const i of [0, 79]) files.push(path.join(dir, names[i]));
        }
    }
}
if (!files.length) throw new Error('No generated All CSV files found');
const inputs = files.map(file => {
    const name = path.basename(file), base = name.replace(/\.all\.csv$/, '');
    const meta = path.join(path.dirname(file), '..', 'meta');
    return {name, relativePath: path.relative(root, file), text: readFileSync(file, 'utf8'),
        sidecarText: readFileSync(path.join(meta, `${base}.scenario.json`), 'utf8'),
        labelsText: readFileSync(path.join(meta, `${base}.truth.json`), 'utf8')};
});
const previous = args.baseline ? JSON.parse(readFileSync(args.baseline, 'utf8')) : null;
const browser = await chromium.launch({headless: true, args: ['--enable-unsafe-swiftshader']});
try {
    const page = await browser.newPage({ignoreHTTPSErrors: true});
    page.on('pageerror', error => console.error(error.message));
    const ready = page.waitForEvent('console', {predicate: message => message.text().includes('Done with setup, starting animation'), timeout: 60000});
    await page.goto(process.env.BOTBENCH_URL || 'https://local.metabunk.org/sitrec/?action=new');
    await ready;
    await page.waitForFunction(() => !!window._botBench?.createAnalysisPool, null, {timeout: 60000});
    // The real folder dialog holds playback paused while fitting.
    await page.evaluate(() => window._botBench.open());
    await page.exposeFunction('benchProgress', (mode, count) => console.log(`${mode}: ${count}/${inputs.length}`));
    const report = await page.evaluate(async ({inputs, previous, workerCount}) => {
        const api = window._botBench;
        const workers = workerCount || Math.max(1, Math.min(inputs.length, 16, navigator.hardwareConcurrency - 1));
        const fingerprint = async out => {
            const {buildHtml, ...results} = out.results;
            const row = {...out.row};
            delete row.elapsedMs; // Only the wall clock is allowed to change.
            const bytes = new TextEncoder().encode(JSON.stringify(api.packForCache({results, row, battery: out.battery})));
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
        };
        const measure = async parallel => {
            const pool = parallel ? api.createAnalysisPool(workers) : null;
            const hashes = [], times = [];
            let next = 0, completed = 0;
            const start = performance.now();
            try {
                await Promise.all(Array.from({length: parallel ? workers : 1}, async () => {
                    while (next < inputs.length) {
                        const i = next++, input = inputs[i];
                        const t = performance.now();
                        const record = await api.ingestBotBenchEntry({...input,
                            getFile: async () => new File([input.text], input.name)});
                        const out = pool ? await pool.run(record) : await api.runBotBenchAnalysis(record);
                        hashes[i] = await fingerprint(out);
                        times[i] = performance.now() - t;
                        await window.benchProgress(parallel ? 'workers' : 'serial', ++completed);
                    }
                }));
                return {totalMs: performance.now() - start, times, hashes};
            } finally { pool?.dispose(); }
        };
        const serial = previous?.serial ?? previous ?? await measure(false);
        const parallel = await measure(true);
        const identical = parallel.hashes.length === serial.hashes.length
            && parallel.hashes.every((h, i) => h === serial.hashes[i]);
        return {files: inputs.map(i => i.relativePath), cores: navigator.hardwareConcurrency,
            userAgent: navigator.userAgent,
            earthRadii: [window.Globals.equatorRadius, window.Globals.polarRadius],
            workers, serial, parallel, identical, speedup: serial.totalMs / parallel.totalMs};
    }, {inputs, previous, workerCount: Number(args.workers) || null});
    const output = path.join(root, 'folder-performance.json');
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({files: report.files.length, workers: report.workers,
        serialMs: report.serial.totalMs, parallelMs: report.parallel.totalMs,
        speedup: report.speedup, identical: report.identical, output}, null, 2));
    if (!report.identical) process.exitCode = 1;
} finally { await browser.close(); }
