// analyzeTractability.mjs — join the tractability records into the study.
// Methodology per the 2026-08-15 design review:
//   - PRIMARY outcome: topRelSep (the ranked-first hypothesis) — operational.
//     bestRelSep is reported ONLY as an oracle ceiling (truth picks the winner).
//   - Threshold sensitivity at 10/15/25% of range.
//   - Tie-corrected Spearman; pooled correlations labeled exploratory.
//   - Exact (Clopper-Pearson) binomial intervals on all rates.
//   - Verdict codes evaluated on per-code semantic endpoints, not one oracle
//     threshold: "consistent-*" -> truth-class inclusion among viable classes;
//     "unresolved" -> abstention. Wording: observed reliability on these
//     designed scenarios — NOT calibrated certainty.
//   - Anomaly: geometry-gated rule (observable AND no viable class), with the
//     naive unresolved-alarm shown only as the strawman it is.
//   - Single seed per scenario: claims are about these realizations only.
//
//     node benchmarks/botbench/analyzeTractability.mjs

import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results", "tractability");

// ---- load, later files superseding earlier ---------------------------------

const files = fs.readdirSync(DIR).filter((f) => f.startsWith("records") && f.endsWith(".jsonl"))
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
const records = [...byKey.values()];
if (!records.length) { console.error("no records yet"); process.exit(1); }

// ---- stats helpers ----------------------------------------------------------

const fin = (x) => Number.isFinite(x);
const fmt = (x, d = 3) => (fin(x) ? x.toFixed(d) : "n/a");

// Tie-corrected Spearman: average ranks over tied groups.
function avgRanks(vals) {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const r = (i + j) / 2;
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

// Exact Clopper-Pearson 95% interval by bisection on the binomial CDF.
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

// ---- endpoints --------------------------------------------------------------

// Expected class per scenario, for the truth-class-inclusion endpoint. The
// maneuver shapes are synthetic kinematics with no true class: excluded.
const EXPECTED_CLASS = {
    "standard|*": ["balloon"],
    "real|gofast": ["balloon"], "real|gofast-anom": null,   // anomalous: no class is correct
    "real|aguadilla": ["balloon"],
    "real|rubberduck-balloon": ["balloon"],
    "real|burst": ["balloon"],
    "real|rubberduck-drone": ["multirotor"],
    "real|dash": ["multirotor", "fixedWing"],   // VTOL: either reading defensible
    "real|circuits": ["fixedWing"],
    "real|hover": ["multirotor"], "real|hover-anom": null,
};
function expectedClasses(r) {
    if (r.setId === "standard") return EXPECTED_CLASS["standard|*"];
    return EXPECTED_CLASS[`${r.setId}|${r.label}`] ?? undefined;   // undefined = not applicable
}
const viableClasses = (r) => r.outcome.classes.filter((c) => c.viable).map((c) => c.key);

// v2 anomaly rule (geometry-gated): the geometry is NOT the collapse regime
// (rcond above -2.5) AND no candidate class is viable.
const observable = (r) => fin(r.triage.cvDesignLog10RcondObserved)
    && r.triage.cvDesignLog10RcondObserved > -2.5;
const alarmV2 = (r) => observable(r) && viableClasses(r).length === 0;
const alarmNaive = (r) => r.outcome.executive.code === "unresolved";

// ---- report -----------------------------------------------------------------

const L = [];
L.push("# Tractability study — triage vs outcome");
L.push("");
L.push(`${records.length} scenarios, one seed each (claims are about these realizations, `);
L.push(`not populations). Files: ${files.map((f) => path.basename(f)).join(", ")}.`);
L.push("Fixed 20 NM anchor. PRIMARY outcome: topRelSep (rank-1 hypothesis vs truth).");
L.push("bestRelSep is an ORACLE CEILING (truth selects the winner) — labeled as such.");
L.push("");

L.push("## Per-scenario");
L.push("");
L.push("| set | scenario | anom | log10rcond | sweep° | verdict | topRelSep | oracleRelSep | s |");
L.push("|---|---|---|---|---|---|---|---|---|");
for (const r of [...records].sort((a, b) =>
    (a.triage.cvDesignLog10RcondObserved ?? -99) - (b.triage.cvDesignLog10RcondObserved ?? -99))) {
    L.push(`| ${r.setId} | ${r.label} | ${r.anomalousDeclared ? "Y" : ""} `
        + `| ${fmt(r.triage.cvDesignLog10RcondObserved, 2)} | ${fmt(r.triage.losSweepDeg, 1)} `
        + `| ${r.error ? "ERROR" : r.outcome.executive.code} `
        + `| ${fmt(r.derived?.topRelSep)} | ${fmt(r.derived?.bestRelSep)} `
        + `| ${Math.round(r.wallMs / 1000)} |`);
}
L.push("");

// ---- triage -----------------------------------------------------------------
const ok = records.filter((r) => !r.error);
const withTop = ok.filter((r) => fin(r.derived?.topRelSep));
L.push("## Triage (EXPLORATORY: pooled cells vary geometry, target, duration, noise jointly)");
L.push("");
L.push(`Scenarios with a finite rank-1 outcome: ${withTop.length}/${ok.length}. A missing`);
L.push("topRelSep means no eligible ranked hypothesis produced a comparable track — an");
L.push("outcome in itself, counted below as not-solved.");
L.push("");
for (const [name, get] of [
    ["cvDesignLog10RcondObserved", (r) => r.triage.cvDesignLog10RcondObserved],
    ["losSweepDeg", (r) => r.triage.losSweepDeg],
    ["losMeanRateDegPerS", (r) => r.triage.losMeanRateDegPerS],
    ["durationSeconds", (r) => r.triage.durationSeconds],
]) {
    const pairs = withTop.filter((r) => fin(get(r))).map((r) => [get(r), r.derived.topRelSep]);
    if (pairs.length >= 8) {
        L.push(`- Spearman(${name}, topRelSep) = ${fmt(spearman(pairs), 2)} (n=${pairs.length}, tie-corrected, exploratory)`);
    }
}
L.push("");
L.push("Solved-rate by conditioning bin (solved = topRelSep ≤ threshold; missing = not solved):");
L.push("");
L.push("| log10rcond bin | n | ≤0.10 | ≤0.15 | ≤0.25 |");
L.push("|---|---|---|---|---|");
for (const [lo, hi] of [[-99, -3], [-3, -2], [-2, -1], [-1, 99]]) {
    const bin = ok.filter((r) => {
        const v = r.triage.cvDesignLog10RcondObserved;
        return fin(v) && v >= lo && v < hi;
    });
    if (!bin.length) continue;
    const at = (th) => bin.filter((r) => fin(r.derived?.topRelSep) && r.derived.topRelSep <= th).length;
    L.push(`| [${lo}, ${hi}) | ${bin.length} | ${rate(at(0.10), bin.length)} | ${rate(at(0.15), bin.length)} | ${rate(at(0.25), bin.length)} |`);
}
L.push("");

// ---- verdict reliability ----------------------------------------------------
L.push("## Verdict codes: observed reliability on these designed scenarios");
L.push("");
L.push("Per-code SEMANTIC endpoint (not one oracle threshold): consistent-* is scored on");
L.push("truth-class inclusion among viable classes (maneuver shapes excluded: no true");
L.push("class); unresolved is scored as abstention. Anomalous members: NO class is correct.");
L.push("");
L.push("| code | n | endpoint | result |");
L.push("|---|---|---|---|");
const byCode = new Map();
for (const r of ok) {
    const c = r.outcome.executive.code;
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(r);
}
for (const [c, rs] of byCode) {
    if (c === "unresolved") {
        L.push(`| ${c} | ${rs.length} | abstention | abstained on ${rs.length}; `
            + `${rs.filter((r) => r.anomalousDeclared).length} anomalous, `
            + `${rs.filter((r) => !r.anomalousDeclared).length} mundane |`);
        continue;
    }
    const scored = rs.filter((r) => expectedClasses(r) !== undefined);
    const okClass = scored.filter((r) => {
        const exp = expectedClasses(r);
        if (exp === null) return false;                    // anomalous: inclusion is an error
        return exp.some((k) => viableClasses(r).includes(k));
    });
    const anomWrong = scored.filter((r) => expectedClasses(r) === null).length;
    L.push(`| ${c} | ${rs.length} | truth-class inclusion | ${rate(okClass.length, scored.length)}`
        + `${anomWrong ? `; includes ${anomWrong} anomalous scored as failures` : ""}`
        + ` (${rs.length - scored.length} n/a: maneuver) |`);
}
L.push("");
L.push("Spread check — topRelSep range within each code (a certainty statement should");
L.push("not span an order of magnitude):");
for (const [c, rs] of byCode) {
    const seps = rs.map((r) => r.derived?.topRelSep).filter(fin).sort((a, b) => a - b);
    if (seps.length) {
        L.push(`- ${c}: topRelSep ${fmt(seps[0])} .. ${fmt(seps[seps.length - 1])} (n=${seps.length})`);
    }
}
L.push("");

// ---- anomaly ----------------------------------------------------------------
L.push("## Anomaly probes");
L.push("");
L.push("| scenario | anomalous | verdict | viable classes | log10rcond | alarmV2 |");
L.push("|---|---|---|---|---|---|");
for (const r of ok.filter((r) => r.anomalousDeclared || r.pairId
        || r.label === "burst" || r.setId === "maneuver")) {
    L.push(`| ${r.setId}/${r.label} | ${r.anomalousDeclared ? "YES" : "no"} `
        + `| ${r.outcome.executive.code} | ${viableClasses(r).join("+") || "none"} `
        + `| ${fmt(r.triage.cvDesignLog10RcondObserved, 2)} | ${alarmV2(r) ? "FIRE" : ""} |`);
}
L.push("");
const anom = ok.filter((r) => r.anomalousDeclared);
const mund = ok.filter((r) => !r.anomalousDeclared);
for (const [name, fn] of [["naive (code==unresolved)", alarmNaive],
                          ["v2 (observable AND no viable class)", alarmV2]]) {
    const tp = anom.filter(fn).length, fp = mund.filter(fn).length;
    const p = fisher(tp, anom.length - tp, fp, mund.length - fp);
    L.push(`- Alarm ${name}: fires ${rate(tp, anom.length)} anomalous vs `
        + `${rate(fp, mund.length)} mundane; Fisher exact p=${fmt(p, 3)}`);
}
L.push("");
L.push("The mundane burst and aguadilla rows are the false-positive probes; the");
L.push("hypersonic row is the false-negative probe (fast-far read as slow-near).");
L.push("");

const md = L.join("\n") + "\n";
fs.writeFileSync(path.join(DIR, "summary.md"), md);
console.log(md);
