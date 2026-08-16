/**
 * jumpStatistic.bench.test.js — promote the study's F9 lead from an anecdote
 * over eight pilot cases to a measurement over EVERY recorded scenario.
 *
 *     npx jest benchmarks/botbench/jumpStatistic.bench.test.js \
 *         --testPathIgnorePatterns /node_modules/ --forceExit
 *
 * (No npm script: package.json is not this package's to edit. The command
 * above is the same shape every other bench script in this directory runs.)
 *
 * THE QUESTION. The dossier's kinematic profile reports `jumpRatio` — the
 * largest single-frame jump in sightline angular rate divided by the median
 * rate. It is computed from the sightlines alone: no fit, no assumed class, no
 * truth. That property is exactly what the anomaly work needs, and F9 saw it
 * behave on five cases: two spliced-impulse anomalies above the mundane Go Fast
 * control, and — the interesting part — the radiosonde-burst false-positive
 * probe, a violent MUNDANE discontinuity, staying down with the control. Five
 * cases is a lead, not a measurement. This bench measures it over all of them.
 *
 * WHY THIS IS A BENCH TEST AND NOT A PLAIN NODE SCRIPT. The statistic needs
 * the OBSERVED sightlines, which a record does not carry (records store
 * summaries, not series), so every scenario is regenerated through
 * generateScenario — and that pulls in the whole lib graph, whose imports are
 * extensionless. Plain Node ESM does not resolve those; babel does. Same
 * reason dossiers.bench.test.js is a bench test.
 *
 * WHY THE STATISTICS ARE COPIED AND NOT IMPORTED. Clopper-Pearson and Fisher
 * exist and work in analyzeTractability.mjs, and this file reuses their
 * approach verbatim — but it cannot import them: the Jest config maps every
 * `.mjs` import to a stub module, so `import {...} from "./analyzeTractability.mjs"`
 * would silently bind stubs instead of failing. Copying the two routines is
 * the honest option at this ownership boundary; the analyzer is not ours to
 * convert.
 *
 * NOTHING IN lib/dossier.js CHANGES. kinematicProfile is imported and called
 * exactly as the dossier builder calls it.
 *
 * Output: results/tractability/jump-statistic.md, byte-deterministic (no
 * wall-clock, no unseeded randomness anywhere on this path).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {REAL_SCENARIOS, buildRealScenarioSpec} from "./lib/realScenarioSet";
import {kinematicProfile} from "./lib/dossier";

const DIR = path.resolve(__dirname, "results", "tractability");
const OUT = path.join(DIR, "jump-statistic.md");

// ---------------------------------------------------------------------------
// PRE-REGISTERED THRESHOLD. Declared here, above every line that reads a
// label, because the named trap for this measurement is picking the threshold
// after seeing which value separates the classes.
//
// TAU = 0.5 is not chosen here. It is lifted from an assertion that was already
// in the repository before the F9 numbers existed:
//
//     tests/botbench/kinematicProfile.test.js
//     expect(stepped.jumpRatio).toBeGreaterThan(0.5);
//
// that assertion is the committed floor a spliced velocity discontinuity must
// clear on NOISELESS ANALYTIC series — series built inside the test, with no
// dependence on any recorded scenario. It entered in commit a8531503; finding
// F9 entered one commit later, in 65199835. So the number cannot have been
// tuned to the values measured below, and `git show a8531503:tests/botbench/
// kinematicProfile.test.js` is the check that says so.
//
// It is a PRE-REGISTRATION, not a calibration: nothing here claims 0.5 is the
// right operating point, only that it was fixed before the outcome was seen.
// ---------------------------------------------------------------------------
const TAU = 0.5;

// Secondary, LABEL-BLIND: a Tukey upper fence (Q3 + 1.5*IQR) over all measured
// values, which cannot be tuned to separate the classes because it never sees
// them. The RULE is fixed here; the number it produces is whatever the data
// gives. Reported alongside TAU, never in place of it.
const TUKEY_K = 1.5;

// Disclosure sweep. A fixed grid, printed in full so the free parameter's
// leverage is visible rather than hidden behind one favorable choice. No
// threshold is promoted on the strength of its outcome.
const SWEEP = [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

// Deterministic set order: the order buildWorkList uses in the tractability
// runner, then label ascending inside each set.
const SET_ORDER = ["real", "maneuver", "standard"];

// ---------------------------------------------------------------------------
// Records: joined later-file-wins by (setId,label), identical to the join
// dossiers.bench.test.js uses, so both read the same 26 scenarios.
// ---------------------------------------------------------------------------
function loadRecords() {
    if (!fs.existsSync(DIR)) return new Map();
    const files = fs.readdirSync(DIR)
        .filter((f) => f.startsWith("records") && f.endsWith(".jsonl"))
        .map((f) => path.join(DIR, f))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    const byKey = new Map();
    for (const f of files) {
        for (const line of fs.readFileSync(f, "utf8").split("\n")) {
            if (!line.trim()) continue;
            const r = JSON.parse(line);
            byKey.set(`${r.setId}|${r.label}`, r);
        }
    }
    return byKey;
}

// Regenerate one scenario and take its jumpRatio. Returns {ok:false, reason}
// rather than throwing, because criterion 4 is that an unregenerable record is
// LISTED, never silently dropped — a skipped scenario that vanishes is how a
// separation gets to look cleaner than it is.
function jumpFor(record) {
    if (record.error) return {ok: false, reason: `record carries a run error: ${record.error}`};
    const spec = record.outcome?.spec;
    if (!spec) return {ok: false, reason: "record has no outcome.spec to regenerate from"};
    if (spec.target?.family === "real") {
        // A real-segment spec references a registered segment by key; rebuild
        // it from the set definition so the key resolves.
        const wanted = record.label.replace(/-anom$/, "");
        const def = REAL_SCENARIOS.find((d) => d.label === wanted
            && (record.label.endsWith("-anom") ? d.anomalous === true : !d.anomalous));
        if (!def) return {ok: false, reason: "no REAL_SCENARIOS definition matches the label"};
        buildRealScenarioSpec(def);
    }
    // The generating seeds the tractability runner used, per set.
    const seed = record.setId === "real" ? 901 : record.setId === "maneuver" ? 801 : 101;
    let scenario;
    try {
        scenario = generateScenario(spec, {scenarioSeed: seed});
    } catch (e) {
        return {ok: false, reason: `generateScenario threw: ${String(e?.message ?? e)}`};
    }
    const dirs = scenario.observation?.observedDirectionENU;
    if (!dirs) return {ok: false, reason: "regenerated scenario has no observedDirectionENU"};
    // Pointing-noise floor on the RATE series, from the REALIZED errors rather
    // than the declared sigma (the wobble scenario declares an amplitude, not a
    // sigma, so the declared number would be wrong for it).
    //
    // The frame-to-frame difference of two independent 2-D pointing errors of
    // per-axis sd s has magnitude Rayleigh(scale = rms), where rms is the 2-D
    // realized RMS error, so its MEDIAN is rms*sqrt(2 ln 2). Multiplying by fps
    // turns that into the angular RATE a perfectly still target would show.
    // Comparing it against the clip's own median rate says whether the rate
    // series carries motion at all, or only noise.
    const rms = scenario.observation.realizedRmsDegAllFrames;
    const noiseMedRate = rms * Math.sqrt(2 * Math.LN2) * spec.fps;
    // The same three assumed ranges the dossier passes. They scale the implied
    // SPEED columns only; jumpRatio is a ratio of angular rates and does not
    // depend on them. Passing them anyway keeps this call byte-identical to
    // the dossier's, so the numbers below are the same numbers F9 quoted.
    const lo = record.outcome.resolvedRangeLoM;
    const hi = record.outcome.resolvedRangeHiM;
    const p = kinematicProfile(dirs, scenario.n, spec.fps, [lo, Math.sqrt(lo * hi), hi]);
    return {ok: true, jumpRatio: p.jumpRatio, maxJump: p.maxJump,
        medRate: p.medRate, maxJumpT: p.maxJumpT, n: scenario.n, fps: spec.fps,
        rmsDeg: rms, noiseMedRate,
        // >> 1: the rate series is dominated by real motion.
        // ~ 1: the rate series is dominated by pointing noise.
        motionToNoise: noiseMedRate > 0 ? p.medRate / noiseMedRate : NaN};
}

// ---------------------------------------------------------------------------
// Exact statistics — same approach as analyzeTractability.mjs (see the header
// note on why these are copied rather than imported).
// ---------------------------------------------------------------------------
function binomCdf(k, n, p) {
    let sum = 0, logC = 0;
    for (let i = 0; i <= k; i++) {
        if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
        sum += Math.exp(logC + i * Math.log(p || 1e-300) + (n - i) * Math.log(1 - p || 1e-300));
    }
    return Math.min(1, sum);
}
function bisect(f, lo, hi) {
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}
// Exact Clopper-Pearson 95% interval by bisection on the binomial CDF.
function cpInterval(k, n) {
    if (!n) return [NaN, NaN];
    const lo = k === 0 ? 0 : bisect((p) => 1 - binomCdf(k - 1, n, p) < 0.025, 0, 1);
    const hi = k === n ? 1 : bisect((p) => 1 - binomCdf(k, n, p) <= 0.975, 0, 1);
    return [lo, hi];
}
const rate = (k, n) => {
    const [lo, hi] = cpInterval(k, n);
    return `${k}/${n}${n ? ` (${(100 * k / n).toFixed(0)}%, CI ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%)` : ""}`;
};
// Fisher exact (2x2, two-sided by min-likelihood).
function fisher(a, b, c, d) {
    const logFact = (m) => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s; };
    const pTable = (a2) => {
        const b2 = a + b - a2, c2 = a + c - a2, d2 = d - a + a2;
        if (b2 < 0 || c2 < 0 || d2 < 0) return 0;
        return Math.exp(logFact(a + b) + logFact(c + d) + logFact(a + c) + logFact(b + d)
            - logFact(a + b + c + d) - logFact(a2) - logFact(b2) - logFact(c2) - logFact(d2));
    };
    const p0 = pTable(a);
    let p = 0;
    for (let a2 = 0; a2 <= a + b && a2 <= a + c; a2++) {
        const pi = pTable(a2);
        if (pi <= p0 + 1e-12) p += pi;
    }
    return Math.min(1, p);
}

// Spearman rank correlation with average ranks for ties — same routine as the
// analyzer, for the same reason as above (it cannot be imported).
function avgRanks(xs) {
    const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(xs.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) out[idx[k][1]] = r;
        i = j + 1;
    }
    return out;
}
function spearman(pairs) {
    const xs = avgRanks(pairs.map((p) => p[0]));
    const ys = avgRanks(pairs.map((p) => p[1]));
    const n = pairs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
// Type-7 (linear interpolation) quantile, the R/numpy default.
function quantile(sortedAsc, q) {
    const n = sortedAsc.length;
    if (!n) return NaN;
    const h = (n - 1) * q;
    const lo = Math.floor(h), hi = Math.ceil(h);
    return sortedAsc[lo] + (h - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

describe("jump statistic over every recorded scenario", () => {
    jest.setTimeout(30 * 60 * 1000);

    beforeAll(() => {
        setSit({name: "botbench-jumpstat", frames: 100000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("measures jumpRatio for every record and writes the report", () => {
        const byKey = loadRecords();
        if (!byKey.size) {
            console.log("[botbench] no tractability records yet — run bench-bot-tract first");
            return;
        }

        const records = [...byKey.values()].sort((a, b) => {
            const s = SET_ORDER.indexOf(a.setId) - SET_ORDER.indexOf(b.setId);
            return s !== 0 ? s : a.label.localeCompare(b.label);
        });

        // MEASURE FIRST, LABEL SECOND. jumpFor never sees anomalousDeclared,
        // and the label is attached only after the value exists.
        const measured = [], skipped = [];
        for (const r of records) {
            const j = jumpFor(r);
            if (!j.ok) { skipped.push({key: `${r.setId}|${r.label}`, reason: j.reason}); continue; }
            measured.push({setId: r.setId, label: r.label,
                anomalous: r.anomalousDeclared === true, ...j});
        }
        expect(measured.length).toBeGreaterThan(0);

        const values = measured.map((m) => m.jumpRatio).filter(Number.isFinite);
        const asc = [...values].sort((a, b) => a - b);
        const tukey = quantile(asc, 0.75) + TUKEY_K * (quantile(asc, 0.75) - quantile(asc, 0.25));

        const anom = measured.filter((m) => m.anomalous);
        const mund = measured.filter((m) => !m.anomalous);
        const tp = anom.filter((m) => m.jumpRatio > TAU).length;
        const fp = mund.filter((m) => m.jumpRatio > TAU).length;
        const p = fisher(tp, anom.length - tp, fp, mund.length - fp);

        const burst = measured.find((m) => m.setId === "real" && m.label === "burst");
        const mundAsc = mund.map((m) => m.jumpRatio).sort((a, b) => a - b);

        // -------------------------------------------------------------------
        // Report. The threshold section comes BEFORE any outcome, which is the
        // frozen-oracle rule for this measurement.
        // -------------------------------------------------------------------
        const L = [];
        L.push("# The rate-jump statistic over every recorded scenario");
        L.push("");
        L.push("Generated by `benchmarks/botbench/jumpStatistic.bench.test.js`. Regenerate with");
        L.push("");
        L.push("    npx jest benchmarks/botbench/jumpStatistic.bench.test.js \\");
        L.push("        --testPathIgnorePatterns /node_modules/ --forceExit");
        L.push("");
        L.push("## What is measured");
        L.push("");
        L.push("`jumpRatio` from `kinematicProfile` (`benchmarks/botbench/lib/dossier.js`,");
        L.push("unchanged): the largest single-frame jump in sightline angular rate divided by");
        L.push("the median rate over the clip. It is computed from the observed sightlines");
        L.push("alone — no fit, no assumed object class, no truth, no generating range. That is");
        L.push("the property that makes it interesting: it is available on any clip, before any");
        L.push("analysis commits to anything.");
        L.push("");
        L.push("Frozen inputs: the tractability records under `results/tractability/`, joined");
        L.push("later-file-wins by `(setId,label)` — the same join the dossier builder uses.");
        L.push("Records store summaries, not series, so each scenario is regenerated through");
        L.push("`generateScenario` at the seed its set was run with (real 901, maneuver 801,");
        L.push("standard 101). Generation is deterministic, so the regenerated sightlines are");
        L.push("the ones the record was produced from.");
        L.push("");
        L.push("## Pre-registered threshold, declared before the outcome");
        L.push("");
        L.push(`**PRIMARY: alarm iff jumpRatio > ${TAU}.**`);
        L.push("");
        L.push("The number is not chosen here. It is lifted from an assertion already committed");
        L.push("to `tests/botbench/kinematicProfile.test.js`:");
        L.push("");
        L.push("    expect(stepped.jumpRatio).toBeGreaterThan(0.5);");
        L.push("");
        L.push("— the floor a spliced velocity discontinuity must clear on NOISELESS ANALYTIC");
        L.push("series constructed inside that test, with no dependence on any recorded");
        L.push("scenario. That assertion entered the repository in commit `a8531503`; finding F9,");
        L.push("which first quoted measured jumpRatios, entered one commit later in `65199835`.");
        L.push("`git show a8531503:tests/botbench/kinematicProfile.test.js` is the check. So the");
        L.push("threshold provably predates the values it is applied to, and could not have been");
        L.push("tuned to them.");
        L.push("");
        L.push("This is a pre-registration, not a calibration. Nothing here claims 0.5 is the");
        L.push("right operating point — only that it was fixed before the outcome was seen.");
        L.push("");
        L.push(`**SECONDARY, LABEL-BLIND: a Tukey upper fence, Q3 + ${TUKEY_K} x IQR** over all`);
        L.push("measured values. It never sees the anomalous/mundane labels, so it cannot be");
        L.push("tuned to separate them; whatever number the distribution gives is the number");
        L.push("used.");
        L.push("");
        L.push("**DISCLOSURE, NOT SELECTION:** a full sweep over a fixed threshold grid is");
        L.push("printed at the end so the free parameter's leverage is visible. No threshold is");
        L.push("promoted on the strength of its outcome; the headline is the primary one.");
        L.push("");
        L.push("## Per-scenario values");
        L.push("");
        L.push(`${measured.length} scenarios measured, ${skipped.length} not regenerable`
            + " (listed below).");
        L.push("");
        L.push("`motion/noise` is the clip's median angular rate divided by the rate a");
        L.push("perfectly still target would show from pointing noise alone at that sample rate");
        L.push("(realized 2-D RMS error x sqrt(2 ln 2) x fps). At 1 the rate series is pure");
        L.push("noise; well above 1 it carries real motion.");
        L.push("");
        L.push("| set | scenario | declared | jumpRatio | maxJump °/s | median rate °/s | jump at t (s) | n @ fps | motion/noise |");
        L.push("|---|---|---|---|---|---|---|---|---|");
        for (const m of measured) {
            L.push(`| ${m.setId} | ${m.label} | ${m.anomalous ? "**anomalous**" : "mundane"} `
                + `| ${fmt(m.jumpRatio)} | ${fmt(m.maxJump, 4)} | ${fmt(m.medRate, 4)} `
                + `| ${fmt(m.maxJumpT, 1)} | ${m.n} @ ${m.fps} | ${fmt(m.motionToNoise, 2)} |`);
        }
        L.push("");
        L.push("### Records that could not be regenerated");
        L.push("");
        if (!skipped.length) {
            L.push("None — every record in the joined set produced a value.");
        } else {
            for (const s of skipped) L.push(`- \`${s.key}\` — ${s.reason}`);
        }
        L.push("");
        L.push("## Separation at the pre-registered threshold");
        L.push("");
        L.push(`Alarm iff jumpRatio > ${TAU}. Exact (Clopper-Pearson) 95% intervals.`);
        L.push("");
        L.push(`- Declared anomalous, alarmed: ${rate(tp, anom.length)}`);
        L.push(`- Mundane, alarmed (false positives): ${rate(fp, mund.length)}`);
        L.push(`- Fisher exact, two-sided: p = ${fmt(p, 4)}`);
        L.push("");
        L.push(p < 0.05
            ? "**The two rates differ at this threshold on this set.**"
            : "**No separation.** The two rates are statistically indistinguishable, and their"
              + " Clopper-Pearson intervals overlap almost completely. The false-positive rate"
              + " on mundane scenarios is of the same order as the true-positive rate on"
              + " declared anomalies.");
        L.push("");
        L.push("2x2 as tested:");
        L.push("");
        L.push("| | alarm | no alarm |");
        L.push("|---|---|---|");
        L.push(`| declared anomalous | ${tp} | ${anom.length - tp} |`);
        L.push(`| mundane | ${fp} | ${mund.length - fp} |`);
        L.push("");
        L.push("Which anomalies alarm and which do not:");
        L.push("");
        for (const m of anom) {
            L.push(`- ${m.setId}/${m.label}: ${fmt(m.jumpRatio)} `
                + `— ${m.jumpRatio > TAU ? "ALARM" : "no alarm"}`);
        }
        if (fp) {
            L.push("");
            L.push("Mundane scenarios that alarm:");
            L.push("");
            for (const m of mund.filter((x) => x.jumpRatio > TAU)) {
                L.push(`- ${m.setId}/${m.label}: ${fmt(m.jumpRatio)}`);
            }
        }
        L.push("");
        L.push("## The radiosonde-burst probe against the mundane distribution");
        L.push("");
        L.push("The burst probe is the designed false positive: a real radiosonde going from a");
        L.push("+5 m/s climb to a -40 m/s fall in one sample. It is a violent MUNDANE");
        L.push("discontinuity, and it trips the class-viability alarm. A statistic that");
        L.push("separates anomalies but also fires here is worth much less than one that does");
        L.push("not, so its value is stated against the mundane set rather than buried in it.");
        L.push("");
        if (!burst) {
            L.push("**The burst record was not measurable in this run** — see the skipped list.");
        } else {
            const below = mundAsc.filter((v) => v < burst.jumpRatio).length;
            const pct = mundAsc.length > 1 ? (100 * below / (mundAsc.length - 1)) : NaN;
            L.push(`- burst jumpRatio = **${fmt(burst.jumpRatio)}** `
                + `(max jump ${fmt(burst.maxJump, 4)} °/s at t=${fmt(burst.maxJumpT, 1)} s, `
                + `median rate ${fmt(burst.medRate, 4)} °/s)`);
            L.push(`- mundane distribution (n=${mundAsc.length}): min ${fmt(mundAsc[0])}, `
                + `Q1 ${fmt(quantile(mundAsc, 0.25))}, median ${fmt(quantile(mundAsc, 0.5))}, `
                + `Q3 ${fmt(quantile(mundAsc, 0.75))}, max ${fmt(mundAsc[mundAsc.length - 1])}`);
            L.push(`- the burst sits at the ${fmt(pct, 0)}th percentile of the mundane set`
                + ` (${below} of ${mundAsc.length - 1} other mundane scenarios below it)`);
            L.push(`- against the pre-registered threshold: `
                + `${burst.jumpRatio > TAU ? "**it ALARMS**" : "**it does not alarm**"}`);
            L.push(`- against the label-blind Tukey fence (${fmt(tukey)}): `
                + `${burst.jumpRatio > tukey ? "**it ALARMS**" : "**it does not alarm**"}`);
        }
        L.push("");
        L.push("## Distributions");
        L.push("");
        const anomAsc = anom.map((m) => m.jumpRatio).sort((a, b) => a - b);
        const desc = (arr) => (arr.length
            ? `n=${arr.length}, min ${fmt(arr[0])}, Q1 ${fmt(quantile(arr, 0.25))}, `
              + `median ${fmt(quantile(arr, 0.5))}, Q3 ${fmt(quantile(arr, 0.75))}, `
              + `max ${fmt(arr[arr.length - 1])}`
            : "n=0");
        L.push(`- declared anomalous: ${desc(anomAsc)}`);
        L.push(`- mundane: ${desc(mundAsc)}`);
        L.push(`- overlap: `
            + (anomAsc.length && mundAsc.length
                ? (anomAsc[0] > mundAsc[mundAsc.length - 1]
                    ? "none — every anomaly is above every mundane scenario"
                    : `the anomalous range [${fmt(anomAsc[0])}, ${fmt(anomAsc[anomAsc.length - 1])}]`
                      + ` overlaps the mundane range [${fmt(mundAsc[0])}, `
                      + `${fmt(mundAsc[mundAsc.length - 1])}]`)
                : "not computable"));
        L.push("");
        L.push("## Why it does not separate: the rate series is mostly pointing noise");
        L.push("");
        L.push("The values sort by SAMPLE RATE, not by label. Every 10 Hz scenario in the set");
        L.push("lands in one band regardless of what the target is doing, and every 1-2 Hz");
        L.push("scenario lands well below it.");
        L.push("");
        L.push("| fps | scenarios | jumpRatio min-median-max | motion/noise min-median-max |");
        L.push("|---|---|---|---|");
        for (const f of [...new Set(measured.map((m) => m.fps))].sort((a, b) => a - b)) {
            const g = measured.filter((m) => m.fps === f);
            const gj = g.map((m) => m.jumpRatio).sort((a, b) => a - b);
            const gm = g.map((m) => m.motionToNoise).sort((a, b) => a - b);
            L.push(`| ${f} | ${g.length} `
                + `| ${fmt(gj[0])} - ${fmt(quantile(gj, 0.5))} - ${fmt(gj[gj.length - 1])} `
                + `| ${fmt(gm[0], 2)} - ${fmt(quantile(gm, 0.5), 2)} `
                + `- ${fmt(gm[gm.length - 1], 2)} |`);
        }
        L.push("");
        L.push(`- Spearman(jumpRatio, fps) = `
            + `${fmt(spearman(measured.map((m) => [m.fps, m.jumpRatio])), 2)}`);
        const mnPairs = measured.filter((m) => Number.isFinite(m.motionToNoise))
            .map((m) => [m.motionToNoise, m.jumpRatio]);
        L.push(`- Spearman(jumpRatio, motion/noise) = ${fmt(spearman(mnPairs), 2)}`);
        L.push(`- Spearman(jumpRatio, declared anomalous) = `
            + `${fmt(spearman(measured.map((m) => [m.anomalous ? 1 : 0, m.jumpRatio])), 2)}`);
        L.push("");
        L.push("The mechanism is arithmetic, not mysterious. `kinematicProfile` computes the");
        L.push("rate as the angle between CONSECUTIVE sightlines times fps. Raise fps and the");
        L.push("true inter-frame motion shrinks proportionally while the pointing error does");
        L.push("not, so above some rate the angle between consecutive samples is almost entirely");
        L.push("noise. `maxJump / medRate` then measures the extreme-to-median ratio of a");
        L.push("Rayleigh noise draw over a few hundred frames — a number near 2 to 3 that says");
        L.push("nothing whatever about the trajectory. The `motion/noise` column is where to");
        L.push("read this. It is a ratio of the OBSERVED median rate to the noise-only median,");
        L.push("so 1.0 means pure noise and a value near 1.5 means noise and motion contribute");
        L.push("about equally (the motion-only part of a 1.5 is sqrt(1.5^2 - 1) = 1.1 noise");
        L.push("units). At 10 Hz the whole set sits between 0.95 and 2.05; at 1-2 Hz it runs");
        L.push("from 5.9 to 21.3.");
        L.push("");
        L.push("The decisive comparison, all three at 10 Hz and 0.03 deg declared noise:");
        L.push("");
        for (const key of ["maneuver|static-point", "maneuver|straight-ca",
            "maneuver|hypersonic-glide"]) {
            const [s, l] = key.split("|");
            const m = measured.find((x) => x.setId === s && x.label === l);
            if (m) {
                L.push(`- ${s}/${l} (${m.anomalous ? "declared anomalous" : "mundane"}): `
                    + `${fmt(m.jumpRatio)}`);
            }
        }
        L.push("");
        L.push("A target that never moves and a target flying a straight constant-acceleration");
        L.push("line both score ABOVE the hypersonic glide. Any reading of this statistic as an");
        L.push("anomaly channel has to survive that, and it does not.");
        L.push("");
        L.push("Why F9's five cases looked clean: four of them are 1-2 Hz real-arm scenarios and");
        L.push("the fifth, the hypersonic glide, was the only 10 Hz case in the pilot. The");
        L.push("sample-rate confound is invisible in a set with one member on the far side of");
        L.push("it.");
        L.push("");
        L.push("## Post-hoc subgroup — HYPOTHESIS ONLY, not a result");
        L.push("");
        L.push("This section exists because suppressing it would be dishonest, not because it");
        L.push("establishes anything. The subgroup boundary was chosen AFTER seeing the");
        L.push("confound above, so it carries none of the pre-registration protection the");
        L.push("primary threshold has, and it is reported with its ceiling attached.");
        L.push("");
        const LOW_FPS = 2;
        const low = measured.filter((m) => m.fps <= LOW_FPS);
        const lowAnom = low.filter((m) => m.anomalous);
        const lowMund = low.filter((m) => !m.anomalous);
        const lowSorted = [...low].sort((a, b) => b.jumpRatio - a.jumpRatio);
        L.push(`Among the ${low.length} scenarios sampled at ${LOW_FPS} Hz or below — the ones `
            + "whose rate series still carries motion — ranked by jumpRatio:");
        L.push("");
        for (let i = 0; i < lowSorted.length; i++) {
            const m = lowSorted[i];
            L.push(`${i + 1}. ${m.setId}/${m.label} `
                + `(${m.anomalous ? "**anomalous**" : "mundane"}): ${fmt(m.jumpRatio)}`);
        }
        L.push("");
        const lowTp = lowAnom.filter((m) => m.jumpRatio > TAU).length;
        const lowFp = lowMund.filter((m) => m.jumpRatio > TAU).length;
        L.push(`At the pre-registered threshold ${TAU}: anomalous ${rate(lowTp, lowAnom.length)}, `
            + `mundane ${rate(lowFp, lowMund.length)}, Fisher exact two-sided p = `
            + `${fmt(fisher(lowTp, lowAnom.length - lowTp, lowFp, lowMund.length - lowFp), 4)}.`);
        L.push("");
        // The ceiling: even a PERFECT split at these counts cannot reach significance.
        const perfectP = fisher(lowAnom.length, 0, 0, lowMund.length);
        L.push(`The ceiling matters more than the number. With ${lowAnom.length} declared `
            + `anomalies and ${lowMund.length} mundane scenarios, a PERFECT split — every `
            + `anomaly above every mundane scenario — would give Fisher p = ${fmt(perfectP, 4)}.`);
        L.push(perfectP < 0.05
            ? "So the subgroup could in principle reach significance; it is still post-hoc."
            : "So this subgroup CANNOT reach p < 0.05 no matter how the values fall. It can"
              + " only generate a hypothesis, never test one.");
        L.push("");
        L.push("The honest read: a low-rate replication arm — several more spliced-impulse");
        L.push("pairs recorded at 1-2 Hz, pre-registered at this same threshold — is what would");
        L.push("turn this into evidence. That is a scenario-generation job, not an analysis one.");
        L.push("");
        L.push("## Label-blind secondary threshold");
        L.push("");
        L.push(`Tukey upper fence over all ${values.length} measured values: `
            + `Q3 ${fmt(quantile(asc, 0.75))} + ${TUKEY_K} x IQR `
            + `${fmt(quantile(asc, 0.75) - quantile(asc, 0.25))} = **${fmt(tukey)}**.`);
        L.push("");
        const tTp = anom.filter((m) => m.jumpRatio > tukey).length;
        const tFp = mund.filter((m) => m.jumpRatio > tukey).length;
        L.push(`- Declared anomalous, alarmed: ${rate(tTp, anom.length)}`);
        L.push(`- Mundane, alarmed: ${rate(tFp, mund.length)}`);
        L.push(`- Fisher exact, two-sided: p = `
            + `${fmt(fisher(tTp, anom.length - tTp, tFp, mund.length - tFp), 4)}`);
        L.push("");
        L.push("## Cross-check against the five values F9 quoted");
        L.push("");
        L.push("These come from the same function called the same way, so they should reproduce");
        L.push("the study's numbers to its rounding. If they do not, one of the two is stale.");
        L.push("");
        L.push("| scenario | F9 quoted | measured here |");
        L.push("|---|---|---|");
        // The five values finding F9 reports, one decimal place as printed there.
        const F9 = [["real|gofast-anom", "0.6"], ["real|hover-anom", "0.3"],
            ["maneuver|hypersonic-glide", "2.5"], ["real|gofast", "0.2"],
            ["real|burst", "0.2"]];
        let f9Match = 0;
        for (const [key, quoted] of F9) {
            const [s, l] = key.split("|");
            const m = measured.find((x) => x.setId === s && x.label === l);
            const got = m ? m.jumpRatio.toFixed(1) : "n/a";
            if (got === quoted) f9Match++;
            L.push(`| ${s}/${l} | ${quoted} | ${fmt(m?.jumpRatio)} `
                + `(${got}) ${got === quoted ? "" : "— MISMATCH"}|`);
        }
        L.push("");
        L.push(`${f9Match} of ${F9.length} reproduce at the study's precision.`);
        L.push("");
        L.push("## Threshold sweep — disclosure of the free parameter");
        L.push("");
        L.push("Every row is reported. The primary threshold's row is the headline; no other");
        L.push("row is promoted because it looks better.");
        L.push("");
        L.push("| threshold | anomalous alarmed | mundane alarmed | Fisher p | burst alarms |");
        L.push("|---|---|---|---|---|");
        for (const t of SWEEP) {
            const a = anom.filter((m) => m.jumpRatio > t).length;
            const b = mund.filter((m) => m.jumpRatio > t).length;
            L.push(`| ${t.toFixed(2)}${t === TAU ? " (pre-registered)" : ""} `
                + `| ${a}/${anom.length} | ${b}/${mund.length} `
                + `| ${fmt(fisher(a, anom.length - a, b, mund.length - b), 4)} `
                + `| ${burst ? (burst.jumpRatio > t ? "yes" : "no") : "n/a"} |`);
        }
        L.push("");
        L.push("## What this is not");
        L.push("");
        L.push("- Not a calibrated detector, and on this evidence not a detector at all. The");
        L.push("  threshold was pre-registered from an analytic test assertion, not fitted, and");
        L.push("  no operating point is recommended.");
        L.push("- Not a reason to change `kinematicProfile`. Nothing here says the profile is");
        L.push("  wrong; the time-resolved TABLE is still the thing that shows an analyst where");
        L.push("  a discontinuity sits, and that is what it was added for. What fails is the");
        L.push("  single summary number's use as a class-free anomaly channel.");
        L.push("- Single seed per scenario, designed scenarios. Every rate here is about these");
        L.push("  realizations, not a population; the intervals price the counting uncertainty");
        L.push("  only, not scenario-selection uncertainty.");
        L.push("- The statistic self-normalizes by the clip's median rate, which is pinned by");
        L.push("  test: the same physical discontinuity scores LOWER the earlier in the clip it");
        L.push("  happens, because it raises the median it is divided by.");
        L.push("- `declared anomalous` mixes two different things: spliced velocity impulses in");
        L.push("  the real arm (gofast-anom, hover-anom) and anomalous PERFORMANCE shapes in the");
        L.push("  maneuver arm (instant turn, zigzag, high-g turn, hypersonic glide). Those are");
        L.push("  not the same physical signature and there is no reason one statistic should");
        L.push("  catch both; the per-scenario table is where that distinction is readable.");
        L.push("");

        const body = L.join("\n");
        fs.mkdirSync(DIR, {recursive: true});
        fs.writeFileSync(OUT, body);
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        console.log(`[botbench] wrote ${OUT}`);
        console.log(`[botbench] report body sha256 = ${hash}`);
        console.log(`[botbench] measured ${measured.length}, skipped ${skipped.length};`
            + ` anomalous ${tp}/${anom.length} mundane ${fp}/${mund.length} at tau=${TAU},`
            + ` Fisher p=${fmt(p, 4)}; burst=${burst ? fmt(burst.jumpRatio) : "n/a"};`
            + ` tukey=${fmt(tukey)}`);

        // The report is a deliverable, so its structural obligations are
        // asserted rather than hoped for: the threshold must be declared before
        // any outcome, and the burst must be named.
        expect(body.indexOf("Pre-registered threshold, declared before the outcome"))
            .toBeLessThan(body.indexOf("Separation at the pre-registered threshold"));
        expect(body).toContain("radiosonde-burst probe against the mundane distribution");
        expect(skipped.length + measured.length).toBe(byKey.size);
    });

    test("the statistic is deterministic across repeated regeneration", () => {
        // The determinism contract for the report is a double RUN with an
        // identical hash; this is the cheap in-process half of it — the same
        // record regenerated twice must give bit-identical values, or the
        // report hash could only be stable by luck.
        const byKey = loadRecords();
        if (!byKey.size) return;
        const probe = byKey.get("real|burst") ?? [...byKey.values()][0];
        const a = jumpFor(probe), b = jumpFor(probe);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
