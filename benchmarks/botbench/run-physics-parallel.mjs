#!/usr/bin/env node
/**
 * run-physics-parallel.mjs — parallel chunk driver for the round-2 physics
 * bench (physics.bench.test.js).
 *
 *     npm run bench-bot-physics-par                       # full 140 cells
 *     node benchmarks/botbench/run-physics-parallel.mjs --smoke   # 4-cell smoke
 *     ... --total 140 --chunk 7 --concurrency 10 --stall 12       # explicit knobs
 *
 * Splits the cell selection into OFFSET/LIMIT slices (the same env-var
 * sharding the bench already supports) and runs up to --concurrency Jest
 * processes at once. Every fit is independent and the DE optimizer runs from
 * a fixed per-fit seed, so results are schedule-invariant: the merged
 * records are identical to a sequential run except timing.wallMs.
 *
 * Progress: each chunk appends one line per physics-solver run to a sidecar
 * file (BOTBENCH_PROGRESS_FILE — Jest buffers console output, so stdout is
 * silent until a chunk finishes); the driver tails those files and prints a
 * status line periodically.
 *
 * Safety:
 *  - Strict options: unknown flags and non-integer values are fatal, never
 *    defaulted, and all values have sane upper bounds (a huge --total or
 *    --concurrency would OOM the queue / fork-bomb Jest).
 *  - Single instance: a pid lockfile refuses a second concurrent driver —
 *    its archive step would move a live run's chunk files out from under its
 *    merge. The lock name is NEVER renamed or unlinked at exit: a clean exit
 *    appends a " released" marker instead, so no exit-time window exists in
 *    which a foreign lock can be removed or the name observed absent. The
 *    next acquirer consumes a released lock (or a dead crash leftover under
 *    --force-lock; an unreleased dead lock otherwise refuses with
 *    instructions) via a takeover serialized by an atomic CLAIM file: while
 *    the claim is held nothing can interpose between the re-read of the
 *    lock and its unlink (creators only ever link(), other takeovers are
 *    excluded, finished owners never write again), so the takeover provably
 *    removes the file it read. Claims are removed only by their living
 *    holder — a stale claim (SIGKILL mid-takeover) always refuses with a
 *    manual-removal instruction; even --force-lock never removes a claim it
 *    does not hold. Acquisition itself is an atomic link(tmp, lock). The
 *    running driver re-verifies ownership before/after archival, every
 *    tick, and before the merge, aborting hard if the lock changed — every
 *    residual interleaving ends in a loud abort, never silent corruption.
 *  - SIGINT/SIGTERM kill all running chunk processes before exiting, so no
 *    orphan Jest run keeps writing chunk files into a later run's namespace.
 *  - Stall watchdog: a chunk whose progress file stops growing for --stall
 *    minutes (default 12) is killed and marked failed — a wedged fit cannot
 *    hang the driver forever. Fail-fast: after the first chunk failure no
 *    further chunks are launched (in-flight ones finish or stall out).
 *  - Archive: pre-existing chunk files (physics-records-N.jsonl /
 *    physics-summary-N.md) are MOVED to results/archive-<stamp>/ before the
 *    run (chunk N of a new split would silently overwrite them); on full runs
 *    the canonical physics-records.jsonl / physics-summary.md are COPIED
 *    there before the merge overwrites them.
 *  - Merge integrity: every chunk file must contain exactly limit x
 *    records-per-cell records (rate self-calibrated from the first chunk),
 *    and a canonical merge additionally cross-checks the bench's logged
 *    selection size. Smoke runs write .smoke.* outputs, a partial --total
 *    writes .partial.* outputs — only a verified-full run may replace the
 *    canonical files.
 */

import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const RESULTS = path.join(__dirname, "results");
const JEST_BIN = path.join(REPO, "node_modules", "jest", "bin", "jest.js");
const TEST_PATH = "benchmarks/botbench/physics.bench.test.js";

// Progress lines come only from the async physics-solver loop in the bench
// (cheap cv/ks runs are not logged there — they are microseconds).
const PHYSICS_SOLVERS_PER_CELL = 5;

// ---- args ------------------------------------------------------------------
// Strict parsing: a typo'd or partial numeric must fail loudly, not silently
// fall back — parseInt("1e2") is 1, a silently-shrunk --total would merge a
// PARTIAL record set over the canonical results, and --chunk 0 would loop
// forever in makeChunks.
const FULL_TOTAL = 140;   // cells in the full selectEntries() selection
const USAGE = "usage: run-physics-parallel.mjs [--smoke] [--total N] [--chunk N]"
    + " [--concurrency N] [--stall MINUTES] [--force-lock]";
function usageFail(msg) {
    console.error(`${msg}\n${USAGE}`);
    process.exit(1);
}
const argv = process.argv.slice(2);
const opts = {};
const NUM_FLAGS = new Set(["--total", "--chunk", "--concurrency", "--stall"]);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") { opts.smoke = true; continue; }
    if (a === "--force-lock") { opts.forceLock = true; continue; }
    if (!NUM_FLAGS.has(a)) usageFail(`unknown option: ${a}`);
    const v = argv[++i];
    if (!/^[0-9]+$/.test(v ?? "")) usageFail(`${a} requires a whole number, got: ${v}`);
    opts[a.slice(2)] = parseInt(v, 10);
}
const SMOKE = opts.smoke === true;
const FORCE_LOCK = opts.forceLock === true;
const TOTAL = opts.total ?? (SMOKE ? 4 : FULL_TOTAL);
const CHUNK = opts.chunk ?? (SMOKE ? 2 : 7);
const CONC = opts.concurrency ?? (SMOKE ? 2 : 10);
const STALL_MIN = opts.stall ?? 12;
if (TOTAL < 1 || CHUNK < 1 || CONC < 1 || STALL_MIN < 1) {
    usageFail("--total, --chunk, --concurrency and --stall must all be >= 1");
}
if (TOTAL > 10000 || CHUNK > 10000) {
    usageFail("--total/--chunk out of range (max 10000)");
}
if (CONC > 32) {
    usageFail("--concurrency out of range (max 32 — more Jest processes than cores only thrash)");
}
if (STALL_MIN > 120) usageFail("--stall out of range (max 120 minutes)");
// A non-smoke run that does not cover the full selection must never replace
// the canonical results — it writes .partial outputs instead.
const PARTIAL = !SMOKE && TOTAL !== FULL_TOTAL;
const OUT_SUFFIX = SMOKE ? ".smoke" : PARTIAL ? ".partial" : "";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(RESULTS, "parallel-logs", `run-${stamp}${SMOKE ? "-smoke" : ""}`);
const archiveDir = path.join(RESULTS, `archive-${stamp}`);
const t0 = Date.now();

function log(msg) {
    console.log(`[driver ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
function mmss(secs) {
    const m = Math.floor(secs / 60), s = Math.round(secs % 60);
    return `${m}m${String(s).padStart(2, "0")}s`;
}

// ---- single-instance lock ----------------------------------------------------
// Two concurrent drivers would be destructive: the second one's archive step
// moves the first one's in-flight chunk files out from under its merge.
// Acquisition is ATOMIC (open "wx"), and — crucially — NO non-owner ever
// unlinks the lock: an automated "reap the stale lock" path is inherently
// racy (unlink removes whatever is there NOW, so a racer acting on an old
// staleness verdict can delete the fresh lock a winner just created, and two
// drivers end up running). A dead-pid lock therefore refuses with removal
// instructions (git's index.lock model); --force-lock is the explicit,
// human/agent-authorized override.
const LOCK = path.join(RESULTS, "parallel-logs", "driver.lock");
const MY_PID = String(process.pid);
const RELEASED_MARK = " released";

// Lock lifecycle: created atomically via link(tmp, LOCK) with content
// "<pid>"; a clean exit APPENDS " released" (the name is NEVER renamed or
// unlinked at exit — so no exit-time window exists in which a foreign lock
// can be removed or the name observed absent); the next acquirer CONSUMES a
// released lock (or, under --force-lock, a dead crash leftover) via a
// byte-verified takeover. A live lock is only ever destroyed by no path.
function readLockRaw() {
    try { return fs.readFileSync(LOCK, "utf8"); } catch { return null; }
}
function pidAlive(pidStr) {
    const pid = parseInt(pidStr ?? "", 10);
    if (!Number.isFinite(pid)) return false;
    // kill(pid, 0) = existence probe; EPERM means alive but not ours.
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === "EPERM"; }
}
// Atomic create-with-content: link(tmp, target) fails EEXIST if the target
// exists, and the target is never observable empty. Returns true on success.
function atomicCreate(target, content) {
    const tmp = `${target}.tmp-${MY_PID}`;
    fs.writeFileSync(tmp, content);
    let ok = false;
    try { fs.linkSync(tmp, target); ok = true; }
    catch (e) { if (e.code !== "EEXIST") { fs.unlinkSync(tmp); throw e; } }
    fs.unlinkSync(tmp);
    return ok;
}

// The CLAIM serializes every mutation of an EXISTING lock name. This is what
// closes the takeover's read-then-remove TOCTOU outright (not just narrows
// it): while a takeover holds the claim, nothing can interpose between its
// re-read of the lock and its unlink — creators only ever link() (which
// cannot touch an existing name), other takeovers are excluded by the claim
// itself, and a released or dead owner never writes again. The re-read under
// the claim is therefore authoritative, and the unlink provably removes the
// file that was read. A claim can only go stale if a process is SIGKILLed
// inside this microsecond-scale critical section (signals cannot interrupt
// sync code in Node); that ALWAYS refuses with instructions — claims are
// removed only by their living holder, with no override: auto-reaping (or
// force-reaping) a claim would just recreate the original race one level
// down.
const CLAIM = `${LOCK}.claim`;
function takeoverUnderClaim() {
    if (!atomicCreate(CLAIM, MY_PID)) {
        let claimPid = null;
        try { claimPid = fs.readFileSync(CLAIM, "utf8").trim(); } catch { return; } // racer finished
        if (pidAlive(claimPid)) return;                 // live takeover in progress — re-evaluate
        // Stale claim (SIGKILL inside the microsecond critical section). NO
        // automated path may remove a claim it does not hold — not even
        // --force-lock: an unlink here acts on whatever claim exists NOW, so
        // a forcer acting on a stale read could delete a racer's fresh LIVE
        // claim and put two takeovers inside the critical section at once —
        // the exact race the claim exists to prevent. Manual recovery only.
        console.error(`stale takeover claim at ${CLAIM} (pid ${claimPid} died mid-takeover).\n`
            + "If no driver is running, remove it with:\n"
            + `    rm "${CLAIM}"\n`
            + "then rerun.");
        process.exit(1);
    }
    try {
        // Authoritative re-read: no interposition possible under the claim.
        const raw = readLockRaw();
        if (raw === null) return;                       // already consumed
        const released = raw.endsWith(RELEASED_MARK);
        const pidStr = raw.trim().split(/\s+/)[0];
        if (!released && !(FORCE_LOCK && !pidAlive(pidStr))) return;  // fresh/live — back off
        fs.unlinkSync(LOCK);                            // provably the file just read
    } finally {
        try { fs.unlinkSync(CLAIM); } catch { /* ours */ }
    }
}

function acquireLock() {
    fs.mkdirSync(path.dirname(LOCK), {recursive: true});
    for (let attempt = 0; attempt < 8; attempt++) {
        if (atomicCreate(LOCK, MY_PID)) {
            process.on("exit", releaseByMarker);
            return;
        }
        const raw = readLockRaw();
        if (raw === null) continue;                     // vanished — retry create
        const released = raw.endsWith(RELEASED_MARK);
        const pidStr = raw.trim().split(/\s+/)[0];
        if (!released && pidAlive(pidStr)) {
            console.error(FORCE_LOCK
                ? `--force-lock refused: pid ${pidStr} is STILL RUNNING — stop it first.`
                : `another driver run (pid ${pidStr}) is active — refusing to start`);
            process.exit(1);
        }
        if (released || FORCE_LOCK) {
            takeoverUnderClaim();                       // then retry the create
            continue;
        }
        console.error(`stale driver lock at ${LOCK}`
            + ` (pid ${pidStr || "unreadable"} is not running and never released — crash/SIGKILL?).\n`
            + "If no driver is running, remove it with:\n"
            + `    rm "${LOCK}"\n`
            + "or rerun with --force-lock.");
        process.exit(1);
    }
    console.error("could not acquire driver lock (racing with other starters?)");
    process.exit(1);
}

function releaseByMarker() {
    // Append-only release: never rename or unlink the live lock name. Worst
    // case (the lock is swapped in the microseconds between the ownership
    // read and the append — which requires manual interference, since
    // --force-lock refuses while our pid is alive) an intruder lock gains a
    // bogus released marker and ITS owner fail-louds at its next ownership
    // check: a spurious abort, never a silently removed lock.
    try {
        if (fs.readFileSync(LOCK, "utf8") === MY_PID) {
            fs.appendFileSync(LOCK, RELEASED_MARK);
        }
    } catch { /* replaced or gone — not ours to touch */ }
}

// Detect a taken-over or manually-removed lock while running and abort fast
// — better a loud dead driver than two drivers corrupting each other's
// chunk files. Called before/after archival, every tick, and pre-merge.
function verifyLockOwnership() {
    if (readLockRaw() === MY_PID) return;
    log("LOCK COMPROMISED — driver.lock was removed or replaced while running; "
        + "killing chunks and aborting to avoid concurrent-driver corruption.");
    for (const ch of liveChildren) { try { ch.kill("SIGKILL"); } catch { /* gone */ } }
    process.exit(3);
}

// ---- child tracking + signal cleanup ------------------------------------------
// If the driver dies without killing its children, orphaned Jest chunks keep
// running and later write physics-records-N.jsonl into a NEW run's namespace,
// corrupting its merge. Kill them before exiting.
const liveChildren = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        log(`${sig} received — killing ${liveChildren.size} running chunk process(es)`);
        for (const ch of liveChildren) { try { ch.kill("SIGKILL"); } catch { /* gone */ } }
        process.exit(sig === "SIGINT" ? 130 : 143);
    });
}

// ---- archive pre-existing outputs -------------------------------------------
function archivePreexisting() {
    if (!fs.existsSync(RESULTS)) fs.mkdirSync(RESULTS, {recursive: true});
    const entries = fs.readdirSync(RESULTS);
    const chunkPat = /^physics-(records|summary)-\d+\.(jsonl|md)$/;
    const moves = entries.filter((f) => chunkPat.test(f));
    const copies = OUT_SUFFIX ? [] : ["physics-records.jsonl", "physics-summary.md"]
        .filter((f) => entries.includes(f));
    if (!moves.length && !copies.length) return;
    fs.mkdirSync(archiveDir, {recursive: true});
    for (const f of moves) {
        fs.renameSync(path.join(RESULTS, f), path.join(archiveDir, f));
        log(`archived stale chunk file ${f} -> ${path.relative(REPO, archiveDir)}/`);
    }
    for (const f of copies) {
        fs.copyFileSync(path.join(RESULTS, f), path.join(archiveDir, f));
        log(`backed up canonical ${f} -> ${path.relative(REPO, archiveDir)}/`);
    }
}

// ---- chunk execution ---------------------------------------------------------
function makeChunks() {
    const chunks = [];
    for (let off = 0; off < TOTAL; off += CHUNK) {
        chunks.push({offset: off, limit: Math.min(CHUNK, TOTAL - off)});
    }
    return chunks;
}

function runChunk(c) {
    return new Promise((resolve) => {
        const logPath = path.join(runDir, `chunk-${c.offset}.log`);
        const progressPath = path.join(runDir, `progress-${c.offset}.log`);
        const out = fs.openSync(logPath, "w");
        const child = spawn(process.execPath, [JEST_BIN, TEST_PATH,
            "--testPathIgnorePatterns", "/node_modules/", "--forceExit"], {
            cwd: REPO,
            env: {
                ...process.env,
                BOTBENCH_PHYSICS_OFFSET: String(c.offset),
                BOTBENCH_PHYSICS_LIMIT: String(c.limit),
                BOTBENCH_PROGRESS_FILE: progressPath,
            },
            stdio: ["ignore", out, out],
        });
        liveChildren.add(child);
        const started = Date.now();
        // Stall watchdog: a wedged fit produces no progress-file growth; kill
        // the chunk rather than hang the whole driver. The first progress line
        // can lag chunk start by a couple of minutes (Jest boot + first fits),
        // well inside the default 12 min window.
        let lastActivity = Date.now(), lastSize = -1, stalled = false;
        const watchdog = setInterval(() => {
            let size = -1;
            try { size = fs.statSync(progressPath).size; } catch { /* not yet */ }
            if (size > lastSize) {
                lastSize = size;
                lastActivity = Date.now();
                return;
            }
            if (Date.now() - lastActivity > STALL_MIN * 60000) {
                stalled = true;
                log(`chunk offset=${c.offset}: no progress for ${STALL_MIN} min — killing`);
                try { child.kill("SIGKILL"); } catch { /* already gone */ }
            }
        }, 30000);
        const finish = (code) => {
            clearInterval(watchdog);
            liveChildren.delete(child);
            try { fs.closeSync(out); } catch { /* already closed */ }
            resolve({...c, code, stalled, secs: (Date.now() - started) / 1000});
        };
        child.on("close", (code) => finish(stalled ? -2 : (code ?? -1)));
        child.on("error", () => finish(-1));
    });
}

function progressCounts() {
    let lines = 0, cpuMs = 0;
    if (!fs.existsSync(runDir)) return {lines, cpuMs};
    for (const f of fs.readdirSync(runDir)) {
        if (!f.startsWith("progress-")) continue;
        const txt = fs.readFileSync(path.join(runDir, f), "utf8");
        for (const ln of txt.split("\n")) {
            if (!ln.trim()) continue;
            lines++;
            const ms = parseInt(ln.trim().split(/\s+/).pop(), 10);
            if (Number.isFinite(ms)) cpuMs += ms;
        }
    }
    return {lines, cpuMs};
}

function printProgress(chunks, done, running) {
    const {lines, cpuMs} = progressCounts();
    const expected = TOTAL * PHYSICS_SOLVERS_PER_CELL;
    const elapsed = (Date.now() - t0) / 1000;
    const pct = expected ? Math.round(100 * lines / expected) : 0;
    const eta = lines > 0 && lines < expected
        ? ` eta ~${mmss(elapsed * (expected - lines) / lines)}` : "";
    const failed = done.filter((d) => d.code !== 0).length;
    log(`chunks ${done.length - failed}ok${failed ? ` ${failed}FAIL` : ""}`
        + `/${chunks.length} (${running.size} running)`
        + ` | solver runs ${lines}/${expected} (${pct}%)`
        + ` | solver time ${mmss(cpuMs / 1000)} | elapsed ${mmss(elapsed)}${eta}`);
}

async function runAll(chunks) {
    const queue = [...chunks];
    const done = [];
    const running = new Set();
    let stopLaunching = false;
    async function worker() {
        while (queue.length && !stopLaunching) {
            const c = queue.shift();
            running.add(c.offset);
            const r = await runChunk(c);
            running.delete(c.offset);
            done.push(r);
            log(`chunk offset=${c.offset} limit=${c.limit} `
                + `${r.code === 0 ? "OK" : `FAILED (exit ${r.code}${r.stalled ? ", stalled" : ""})`}`
                + ` in ${mmss(r.secs)}`);
            if (r.code !== 0 && !stopLaunching) {
                // Failures here are deterministic (bench asserts), so a retry
                // would fail identically — stop launching, let in-flight finish.
                stopLaunching = true;
                log("fail-fast: not launching further chunks");
            }
        }
    }
    const tick = setInterval(() => {
        verifyLockOwnership();
        printProgress(chunks, done, running);
    }, SMOKE ? 5000 : 15000);
    await Promise.all(Array.from({length: Math.min(CONC, chunks.length)}, worker));
    clearInterval(tick);
    printProgress(chunks, done, running);
    return {done, skipped: queue.length};
}

// ---- merge + summary (ports the aggregation from physics.bench.test.js) -----
const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v))
    ? "-" : v.toFixed(d);
const med = (v) => {
    const s = v.filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : null;
};

function buildSummary(records) {
    const scenarioIds = new Set(records.map((r) => r.scenarioId));
    const ok = records.filter((r) => r.status === "ok"
        && r.metrics?.truth?.kind === "track" && r.metrics.truth.comparable);
    const groups = new Map();
    for (const r of ok) {
        const regime = r.blockId === "ANOMALY-CONTROL"
            ? (r.axes.anomalous ? "anomaly" : "anomaly-control")
            : r.blockId;
        const k = `${regime}|${r.axes.targetKind ?? r.axes.targetFamily}|${r.solver.id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }

    const lines = [];
    lines.push("# BOT Bench round 2 — flagship solvers vs truth");
    lines.push("");
    lines.push(`Scenarios: ${scenarioIds.size}  records: ${records.length}. `
        + "DE budgets are the moderate deterministic bench budgets (see "
        + "physicsSolvers.js) — cross-solver comparisons here are fair; "
        + "absolute in-app quality may be modestly better.");
    lines.push("");
    lines.push(`Run via run-physics-parallel.mjs (${Math.ceil(TOTAL / CHUNK)} chunks, `
        + `concurrency ${CONC}) — per-fit wall times are contended; compare `
        + "timing ratios, not absolutes.");
    lines.push("");
    lines.push("## Truth recovery by regime x target x solver");
    lines.push("");
    lines.push("| regime | target | solver | n | relSep med | clean resid med deg | wall med s |");
    lines.push("|---|---|---|---:|---:|---:|---:|");
    for (const [k, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        const [regime, target, solverId] = k.split("|");
        lines.push(`| ${regime} | ${target} | ${solverId} | ${rows.length} `
            + `| ${fmt(med(rows.map((r) => r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM)), 4)} `
            + `| ${fmt(med(rows.map((r) => r.metrics.angular.cleanMeanDeg)), 4)} `
            + `| ${fmt(med(rows.map((r) => r.timing.wallMs / 1000)), 1)} |`);
    }
    lines.push("");

    lines.push("## Lantern wind recovery (balloon-family cells)");
    lines.push("");
    lines.push("| block | target | wind | truth m/s | solved m/s | error m/s |");
    lines.push("|---|---|---|---:|---:|---:|");
    for (const r of records.filter((r) => r.windRecovery
        && String(r.axes.targetFamily) === "balloon")) {
        const w = r.windRecovery;
        lines.push(`| ${r.blockId} | ${r.axes.targetKind} | ${r.axes.windKind} `
            + `| ${fmt(Math.hypot(w.truthU, w.truthV), 2)} `
            + `| ${fmt(Math.hypot(w.solvedU, w.solvedV), 2)} `
            + `| ${fmt(w.errorMS, 2)} |`);
    }
    lines.push("");

    lines.push("## Status counts");
    lines.push("");
    const statusCounts = new Map();
    for (const r of records) {
        const k = `${r.solver.id}|${r.status}`;
        statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
    }
    lines.push("| solver | status | n |");
    lines.push("|---|---|---:|");
    for (const [k, n] of [...statusCounts].sort((a, b) => a[0].localeCompare(b[0]))) {
        const [solverId, status] = k.split("|");
        lines.push(`| ${solverId} | ${status} | ${n} |`);
    }
    lines.push("");
    return lines.join("\n");
}

function mergeChunks(chunks) {
    const sorted = [...chunks].sort((a, b) => a.offset - b.offset);
    const perChunk = sorted.map((c) => {
        const p = path.join(RESULTS, `physics-records-${c.offset}.jsonl`);
        const recs = fs.readFileSync(p, "utf8").split("\n")
            .filter((l) => l.trim()).map((l) => JSON.parse(l));
        return {c, recs};
    });
    // Integrity check before anything is written: every chunk must hold
    // exactly limit x records-per-cell records (rate self-calibrated from the
    // first chunk, so a solver-roster change doesn't need a constant updated
    // here). Catches truncated, stale, or foreign chunk files — e.g. a manual
    // OFFSET/LIMIT bench run writing into results/ alongside this driver.
    const first = perChunk[0];
    if (first.recs.length === 0 || first.recs.length % first.c.limit !== 0) {
        log(`ABORTING merge — chunk offset=${first.c.offset} has `
            + `${first.recs.length} records for ${first.c.limit} cells`);
        process.exit(2);
    }
    const recordsPerCell = first.recs.length / first.c.limit;
    for (const {c, recs} of perChunk) {
        if (recs.length !== c.limit * recordsPerCell) {
            log(`ABORTING merge — chunk offset=${c.offset}: ${recs.length} records, `
                + `expected ${c.limit * recordsPerCell}`);
            process.exit(2);
        }
    }
    const records = perChunk.flatMap((x) => x.recs);
    fs.writeFileSync(path.join(RESULTS, `physics-records${OUT_SUFFIX}.jsonl`),
        records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(RESULTS, `physics-summary${OUT_SUFFIX}.md`), buildSummary(records));
    // Chunk outputs are redundant after the merge — park them with the run
    // logs so results/ holds only canonical files.
    for (const c of chunks) {
        for (const f of [`physics-records-${c.offset}.jsonl`, `physics-summary-${c.offset}.md`]) {
            const p = path.join(RESULTS, f);
            if (fs.existsSync(p)) fs.renameSync(p, path.join(runDir, f));
        }
    }
    return records;
}

// ---- main --------------------------------------------------------------------
if (!fs.existsSync(JEST_BIN)) {
    console.error(`jest not found at ${JEST_BIN} — run npm install`);
    process.exit(1);
}
acquireLock();
fs.mkdirSync(runDir, {recursive: true});
verifyLockOwnership();   // archival must never run on a yanked lock
archivePreexisting();
verifyLockOwnership();

const chunks = makeChunks();
log(`${SMOKE ? "SMOKE: " : PARTIAL ? "PARTIAL: " : ""}${TOTAL} cells in `
    + `${chunks.length} chunks of <=${CHUNK}, concurrency ${CONC}; `
    + `logs in ${path.relative(REPO, runDir)}/`);

const {done: results, skipped} = await runAll(chunks);
const failed = results.filter((r) => r.code !== 0);
if (failed.length || skipped) {
    for (const f of failed) {
        log(`FAILED chunk offset=${f.offset}${f.stalled ? " (stalled)" : ""}: see `
            + `${path.relative(REPO, path.join(runDir, `chunk-${f.offset}.log`))}`);
    }
    if (skipped) log(`${skipped} chunk(s) never launched (fail-fast).`);
    log(`ABORTING merge — ${failed.length} failed, ${skipped} skipped of ${chunks.length} chunks.`);
    process.exit(2);
}

// Before a CANONICAL merge, cross-check the bench's actual selection size
// (logged by every chunk as "(offset N of TOTAL)"): if the selection has
// grown, a run that covered FULL_TOTAL cells is no longer full and must not
// replace the canonical records. (A shrunken selection already fails above:
// out-of-range chunks get zero scenarios and the bench's own assertions fail.)
if (!OUT_SUFFIX) {
    const chunk0 = fs.readFileSync(path.join(runDir, "chunk-0.log"), "utf8");
    const m = chunk0.match(/\(offset \d+ of (\d+)\)/);
    if (!m) {
        log("ABORTING merge — could not verify the selection size from chunk-0.log "
            + "(bench log format changed?); refusing to overwrite canonical results.");
        process.exit(2);
    }
    const actual = parseInt(m[1], 10);
    if (actual !== TOTAL) {
        log(`ABORTING merge — selection has ${actual} cells but this run covered `
            + `${TOTAL}; refusing to overwrite canonical results. `
            + `Update FULL_TOTAL / rerun with --total ${actual}.`);
        process.exit(2);
    }
}

verifyLockOwnership();
const records = mergeChunks(chunks);
const {cpuMs} = progressCounts();
const wallSecs = (Date.now() - t0) / 1000;
log(`MERGE OK -> results/physics-records${OUT_SUFFIX}.jsonl `
    + `(${records.length} records, ${new Set(records.map((r) => r.scenarioId)).size} scenarios)`);
log(`wall ${mmss(wallSecs)} | summed physics-solver time ${mmss(cpuMs / 1000)} `
    + `| effective speedup ~${(cpuMs / 1000 / wallSecs).toFixed(1)}x`);
