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
//   - Spliced-impulse pairs analyzed PAIRED (shared truth, shared noise
//     realization, shared event window), not pooled — with the honest note
//     that two pairs cannot reach significance whatever they show.
//   - Router buckets and the rcond-gate risk-coverage sweep read TRUTH-FREE
//     fields only; truth enters afterwards, to score what the gate committed.
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

// Exact McNemar: the two-sided binomial sign test on the DISCORDANT pairs only
// (concordant pairs carry no information about the within-pair effect). The
// chi-square form is not usable at these counts, and no continuity correction
// rescues it.
function mcnemarExact(b, c) {
    const n = b + c;
    if (!n) return NaN;
    const k = Math.max(b, c);
    return Math.min(1, 2 * (1 - binomCdf(k - 1, n, 0.5)));
}
// Smallest discordant count that COULD reach p < alpha — the best case, every
// discordant pair falling the same way. This is the "how many would we need"
// number, and it is a floor: any concordant pair pushes the requirement up.
function minDiscordantForP(alpha) {
    for (let n = 1; n <= 500; n++) if (mcnemarExact(n, 0) < alpha) return n;
    return NaN;
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

// The truth-class-inclusion endpoint, as one function so the verdict table and
// the risk-coverage sweep score commitments the same way.
// null = not scorable (maneuver shapes have no true class).
function classInclusion(r) {
    const exp = expectedClasses(r);
    if (exp === undefined) return null;
    if (exp === null) return false;                        // anomalous: inclusion is an error
    return exp.some((k) => viableClasses(r).includes(k));
}

// The collapse floor: below this the CV design matrix has lost the directions
// that separate range hypotheses, so "no class fits" carries no information.
// PROVISIONAL and uncalibrated — it comes from the CV-family collapse
// measurement, not from a fitted operating point. The anomaly gate and the
// router share the one constant so triage and alarm cannot disagree about
// which geometries are dead; the risk-coverage sweep below varies it.
const COLLAPSE_LOG10RCOND = -2.5;

// v2 anomaly rule (geometry-gated): the geometry is NOT the collapse regime
// AND no candidate class is viable. A missing conditioning number counts as
// degenerate — fail closed, never treat an absent measurement as headroom.
const observable = (r) => fin(r.triage.cvDesignLog10RcondObserved)
    && r.triage.cvDesignLog10RcondObserved > COLLAPSE_LOG10RCOND;
const alarmV2 = (r) => observable(r) && viableClasses(r).length === 0;
const alarmNaive = (r) => r.outcome.executive.code === "unresolved";

// ---- router buckets (TRUTH-FREE) --------------------------------------------

// The shipping verdict emits five codes. Two of them commit to a single class
// ("probably-balloon" is the wind-corroborated form of "consistent-one"); two
// commit to nothing ("insufficient" is a provenance-driven abstention, the
// same product as "unresolved" for routing); "consistent-several" is already a
// set. Only the code and the pre-fit conditioning number are read here — no
// truth quantity reaches this function, so the labels can be back-filled onto
// any run and used to gate work before an answer exists.
const COMMITTED_CODES = new Set(["consistent-one", "probably-balloon"]);

function routerBucket(r) {
    const code = r.outcome.executive.code;
    const informative = observable(r);
    if (COMMITTED_CODES.has(code)) {
        // Geometry may only DOWNGRADE. A single-class commitment made where the
        // design matrix has collapsed is published as a set, never auto-committed:
        // in the collapse regime the mundane family is a superset of everything
        // the bearings admit, so "one class" is a statement about the priors.
        return informative ? "auto-commit" : "report-set";
    }
    if (code === "consistent-several") return "report-set";
    // Nothing committed. Degenerate geometry means no probe can help, so the
    // case closes here and its anomaly status is "untestable", never "clean".
    return informative ? "escalate" : "terminal-untestable";
}
const BUCKETS = ["auto-commit", "report-set", "escalate", "terminal-untestable"];

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
    const scored = rs.filter((r) => classInclusion(r) !== null);
    const okClass = scored.filter((r) => classInclusion(r));
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

// ---- paired contrasts -------------------------------------------------------
// Steps 4 and 15: the spliced-impulse pairs are the only place in this set
// where a comparison is clean, so they get their own analysis rather than
// being averaged into the pooled alarm rates.
L.push("## Paired contrasts — spliced-impulse pairs");
L.push("");
L.push("Both members of a pair share the truth track, the noise REALIZATION (same");
L.push("observation seed key) and the event window; the only difference is the");
L.push("spliced impulse. Everything the pooled comparison must average over —");
L.push("geometry, target, duration, sigma — is held fixed INSIDE a pair, so the");
L.push("within-pair contrast isolates the impulse. That is what the pairs are for.");
L.push("");

const pairs = new Map();
for (const r of ok) {
    if (!r.pairId) continue;
    if (!pairs.has(r.pairId)) pairs.set(r.pairId, []);
    pairs.get(r.pairId).push(r);
}
// Mundane member first: the contrast is always read as mundane -> anomalous.
for (const rs of pairs.values()) rs.sort((a, b) => (a.anomalousDeclared ? 1 : 0) - (b.anomalousDeclared ? 1 : 0));

const seedKey = (r) => r.outcome?.spec?.observation?.sharedSeedKey;
for (const [id, rs] of pairs) {
    // The paired analysis is licensed by the shared noise stream and by having
    // exactly one member of each kind. Check both rather than trusting the label:
    // a pairId with two mundane members would silently produce a null contrast.
    const keys = new Set(rs.map(seedKey));
    const nAnom = rs.filter((r) => r.anomalousDeclared).length;
    if (rs.length !== 2 || keys.size !== 1 || !seedKey(rs[0]) || nAnom !== 1) {
        L.push(`- WARNING ${id}: not a usable pair (${rs.length} members, `
            + `${keys.size} distinct seed key(s) = ${[...keys].join("/")}, `
            + `${nAnom} anomalous) — paired claims for it are void.`);
    }
}
L.push("| pair | member | anomalous | seed key | log10rcond | verdict | viable classes | topRelSep | alarm v2 | bucket |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const [id, rs] of pairs) {
    for (const r of rs) {
        L.push(`| ${id} | ${r.setId}/${r.label} | ${r.anomalousDeclared ? "YES" : "no"} `
            + `| ${seedKey(r) ?? "none"} | ${fmt(r.triage.cvDesignLog10RcondObserved, 2)} `
            + `| ${r.outcome.executive.code} | ${viableClasses(r).join("+") || "none"} `
            + `| ${fmt(r.derived?.topRelSep)} | ${alarmV2(r) ? "FIRE" : "silent"} `
            + `| ${routerBucket(r)} |`);
    }
}
L.push("");
L.push("Within-pair contrast (mundane -> anomalous). Where the anomalous member has no");
L.push("finite rank-1 outcome the paired SCORE difference does not exist, and the");
L.push("contrast is carried entirely by the verdict and alarm endpoints:");
for (const [id, rs] of pairs) {
    const [m, a] = rs;
    if (!m || !a) continue;
    const seps = [m, a].map((r) => r.derived?.topRelSep);
    const dSep = seps.every(fin)
        ? `topRelSep ${fmt(seps[0])} -> ${fmt(seps[1])} (delta ${fmt(seps[1] - seps[0])})`
        : "topRelSep contrast UNDEFINED (no finite rank-1 outcome on both sides)";
    L.push(`- ${id}: verdict ${m.outcome.executive.code} -> ${a.outcome.executive.code}; `
        + `viable {${viableClasses(m).join(",") || "empty"}} -> {${viableClasses(a).join(",") || "empty"}}; `
        + `alarm v2 ${alarmV2(m) ? "FIRE" : "silent"} -> ${alarmV2(a) ? "FIRE" : "silent"}; `
        + `log10rcond ${fmt(m.triage.cvDesignLog10RcondObserved, 2)} -> `
        + `${fmt(a.triage.cvDesignLog10RcondObserved, 2)}; bucket ${routerBucket(m)} -> ${routerBucket(a)}.`);
    L.push(`  ${dSep}.`);
}
L.push("");
L.push("McNemar-style discordance over the pairs. b = anomalous member alarms while");
L.push("its mundane twin stays silent (the wanted direction); c = the reverse.");
L.push("Concordant pairs are uninformative about the within-pair effect and are");
L.push("excluded, which is the whole content of the test.");
L.push("");
L.push("| alarm | pairs | b (anom fires only) | c (mundane fires only) | concordant | exact two-sided p |");
L.push("|---|---|---|---|---|---|");
for (const [name, fn] of [["naive (code==unresolved)", alarmNaive],
                          ["v2 (observable AND no viable class)", alarmV2]]) {
    let b = 0, c = 0, conc = 0;
    for (const rs of pairs.values()) {
        const [m, a] = rs;
        if (!m || !a) continue;
        if (fn(a) && !fn(m)) b++;
        else if (fn(m) && !fn(a)) c++;
        else conc++;
    }
    L.push(`| ${name} | ${b + c + conc} | ${b} | ${c} | ${conc} | ${fmt(mcnemarExact(b, c), 3)} |`);
}
L.push("");
const nPairs = [...pairs.values()].filter((rs) => rs.length === 2).length;
const need05 = minDiscordantForP(0.05);
L.push(`NOT SIGNIFICANT, AND CANNOT BE. With ${nPairs} pairs the smallest attainable`);
L.push(`two-sided exact p is ${fmt(mcnemarExact(nPairs, 0), 3)} — even a perfect ${nPairs}/${nPairs} discordance in the`);
L.push("wanted direction clears no conventional threshold. This section installs the");
L.push("machinery and shows the direction of the discordance; it claims no result.");
L.push("");
L.push(`Exact statement of what N would be needed: at least ${need05} DISCORDANT pairs, all`);
L.push(`falling the same way, are required for two-sided p < 0.05 `
    + `(2 x 0.5^${need05} = ${fmt(mcnemarExact(need05, 0), 3)}), and`);
L.push(`${minDiscordantForP(0.01)} such pairs for p < 0.01.`);
L.push(`If every pair is discordant that is ${need05} pairs total; each concordant pair`);
L.push(`raises the requirement, so a design should budget more than ${need05}.`);
L.push("");
{
    // Paired vs pooled, stated honestly: the paired p here is WORSE than the
    // pooled one. That is the price of throwing away confounded comparisons,
    // not evidence that the pairing failed.
    const tp = anom.filter(alarmV2).length, fp = mund.filter(alarmV2).length;
    const pooledP = fisher(tp, anom.length - tp, fp, mund.length - fp);
    L.push(`Paired vs pooled (alarm v2): pooled Fisher over all ${ok.length} scenarios gives`);
    L.push(`p=${fmt(pooledP, 3)} on ${anom.length} anomalous vs ${mund.length} mundane, but those groups differ in`);
    L.push("geometry, target, duration and arm as well as in the impulse. The paired test");
    L.push(`gives p=${fmt(mcnemarExact(2, 0), 3)} on ${nPairs} pairs and confounds nothing. The larger paired p is`);
    L.push("the cost of discarding the confounded comparisons, not a failure of pairing;");
    L.push("the pooled number should not be read as the stronger evidence.");
}
L.push("");

// ---- router buckets ---------------------------------------------------------
L.push("## Router buckets — terminal routing (truth-free)");
L.push("");
L.push("Every scenario lands in exactly one bucket. The rule reads the verdict code");
L.push("and the pre-fit conditioning number, nothing else; no truth quantity enters,");
L.push("so these labels can be back-filled onto any past run and used to gate work");
L.push("before an answer exists.");
L.push("");
L.push("PROVISIONAL THRESHOLDS (uncalibrated, printed so no consumer can use a bucket");
L.push("label without seeing what conditioned it):");
L.push(`- collapse floor: log10 rcond <= ${COLLAPSE_LOG10RCOND.toFixed(1)} is the collapse regime. Shared with the`);
L.push("  v2 alarm gate. A missing rcond counts as collapsed (fail closed).");
L.push(`- committed codes: ${[...COMMITTED_CODES].join(", ")}. consistent-several is a set.`);
L.push("  unresolved and insufficient commit to nothing and route on geometry.");
L.push("- geometry may only DOWNGRADE: a committed code in the collapse regime is");
L.push("  published as report-set, never auto-committed, because down there the");
L.push("  mundane family is a superset of everything the bearings admit.");
{
    const absentSets = new Set(ok.map((r) => (r.outcome.absentHypotheses || []).join("|")));
    L.push("- the program's second escalate disjunct (named auxiliary data plausibly");
    L.push(`  exists) is NOT applied: outcome.absentHypotheses takes ${absentSets.size} distinct value(s)`);
    L.push(`  across ${ok.length} records, so here it ${absentSets.size === 1
        ? "discriminates nothing and would route every open" : "would need its own audit before it could route any"}`);
    L.push("  case to escalate.");
}
L.push("");
const buckets = new Map(BUCKETS.map((b) => [b, []]));
for (const r of ok) buckets.get(routerBucket(r)).push(r);
L.push("| bucket | n | share | members |");
L.push("|---|---|---|---|");
for (const b of BUCKETS) {
    const rs = buckets.get(b);
    L.push(`| ${b} | ${rs.length} | ${(100 * rs.length / ok.length).toFixed(0)}% `
        + `| ${rs.map((r) => `${r.setId}/${r.label}`).join(", ") || "—"} |`);
}
if (records.length !== ok.length) {
    L.push("");
    L.push(`(${records.length - ok.length} errored record(s) are not routable and are excluded.)`);
}
L.push("");
L.push("Per-bucket outcome. Truth enters only HERE, to score what the truth-free rule");
L.push("routed. Solved = topRelSep ≤ 0.15; missing rank-1 outcome counts as not solved.");
L.push("");
L.push("| bucket | n | declared anomalous | rank-1 finite | solved ≤0.15 | truth-class inclusion | anomaly status emitted |");
L.push("|---|---|---|---|---|---|---|");
for (const b of BUCKETS) {
    const rs = buckets.get(b);
    if (!rs.length) { L.push(`| ${b} | 0 | — | — | — | — | — |`); continue; }
    const finite = rs.filter((r) => fin(r.derived?.topRelSep));
    const solved = rs.filter((r) => fin(r.derived?.topRelSep) && r.derived.topRelSep <= 0.15);
    const scored = rs.filter((r) => classInclusion(r) !== null);
    const okClass = scored.filter((r) => classInclusion(r));
    // The never-clean rule: where the geometry is dead the anomaly test has no
    // power, so the only honest status is "untestable". Elsewhere the v2 alarm
    // is a real test and its firing count is the status.
    const status = b === "terminal-untestable"
        ? "untestable (never \"clean\")"
        : `${rs.filter(alarmV2).length}/${rs.length} alarm v2 fired`;
    L.push(`| ${b} | ${rs.length} | ${rs.filter((r) => r.anomalousDeclared).length} `
        + `| ${finite.length}/${rs.length} | ${rate(solved.length, rs.length)} `
        + `| ${scored.length ? rate(okClass.length, scored.length) : "n/a (no scorable member)"} `
        + `| ${status} |`);
}
L.push("");
{
    const downgraded = ok.filter((r) => COMMITTED_CODES.has(r.outcome.executive.code) && !observable(r));
    L.push(`Downgraded by the collapse floor (committed code -> report-set): ${downgraded.length} — `
        + `${downgraded.map((r) => `${r.setId}/${r.label} (topRelSep ${fmt(r.derived?.topRelSep)})`).join(", ") || "none"}.`);
    L.push("The downgrade is not free: it removes right commitments along with wrong ones,");
    L.push("and the sweep below is how that trade is meant to be read, not argued.");
    L.push("");
    // The shipping verdict emits "unresolved" exactly when no class is viable,
    // so on this set the escalate bucket and the v2 alarm are the same event.
    // The alarm column above is therefore NOT independent corroboration of the
    // routing; only an "insufficient" code with a viable class would separate them.
    const same = ok.every((r) => (routerBucket(r) === "escalate") === alarmV2(r));
    L.push(`Alarm-vs-bucket independence: escalate and "alarm v2 fired" are ${same
        ? "the SAME event on this set" : "distinct events on this set"} — the shipping`);
    L.push("verdict emits unresolved exactly when no class is viable, so the alarm column");
    L.push("above corroborates nothing about the routing. Separating them needs a code");
    L.push("that abstains while a class stays viable (insufficient), which this set lacks.");
}
L.push("");

// ---- risk-coverage ----------------------------------------------------------
// Step 20: a gate is a selective-prediction system, and a single operating
// point hides the denominator. Sweep it and show the trade.
L.push("## Risk-coverage curve — sweeping the rcond auto-commit gate");
L.push("");
L.push("Coverage = fraction of ALL scenarios the router auto-commits at that gate");
L.push("(committed code AND log10 rcond > gate). Risk = the error rate among exactly");
L.push("those, scored two ways: the PRIMARY trajectory endpoint (topRelSep above the");
L.push("tolerance, or no finite rank-1 outcome at all) and truth-class inclusion,");
L.push("whose denominator is smaller because maneuver shapes have no true class.");
L.push("The gate itself is truth-free; truth enters only to score what it let through.");
L.push("n is printed at every point: at 26 scenarios most points are tiny and the");
L.push("exact intervals below are the honest width of each claim.");
L.push("");
L.push("| gate log10rcond > | committed n | coverage | error (topRelSep > 0.15) | error (> 0.25) | class error |");
L.push("|---|---|---|---|---|---|");
const sweep = [];
// Below the loosest committed geometry the gate is inert, which is the honest
// zero-gate baseline the curve needs at its left end.
const minCommittedRcond = Math.min(...ok
    .filter((r) => COMMITTED_CODES.has(r.outcome.executive.code))
    .map((r) => r.triage.cvDesignLog10RcondObserved).filter(fin));
for (let g = -4.0; g <= -0.5 + 1e-9; g += 0.25) {
    const gate = Math.round(g * 100) / 100;
    const committed = ok.filter((r) => COMMITTED_CODES.has(r.outcome.executive.code)
        && fin(r.triage.cvDesignLog10RcondObserved)
        && r.triage.cvDesignLog10RcondObserved > gate);
    const errAt = (tol) => committed.filter((r) => !(fin(r.derived?.topRelSep)
        && r.derived.topRelSep <= tol)).length;
    const scored = committed.filter((r) => classInclusion(r) !== null);
    const classErr = scored.filter((r) => !classInclusion(r)).length;
    sweep.push({gate, n: committed.length, err15: errAt(0.15), err25: errAt(0.25),
        classErr, classN: scored.length});
    const tag = gate === COLLAPSE_LOG10RCOND ? " (default)"
        : gate < minCommittedRcond ? " (ungated)" : "";
    L.push(`| ${gate.toFixed(2)}${tag} `
        + `| ${committed.length} | ${rate(committed.length, ok.length)} `
        + `| ${committed.length ? rate(errAt(0.15), committed.length) : "n/a"} `
        + `| ${committed.length ? rate(errAt(0.25), committed.length) : "n/a"} `
        + `| ${scored.length ? rate(classErr, scored.length) : "n/a"} |`);
}
L.push("");
{
    const live = sweep.filter((s) => s.n > 0);
    const risk = (s) => s.err15 / s.n;
    const loosest = live[0], tightest = live[live.length - 1];
    const best = live.reduce((a, s) => (risk(s) < risk(a) ? s : a), live[0]);
    // Does buying less coverage ever buy less risk? That is the only question a
    // risk-coverage curve exists to answer, so it is measured, not asserted.
    const falls = live.some((s, i) => i > 0 && risk(s) < risk(live[i - 1]));
    L.push(`Reading the curve on this set: the loosest gate (${loosest.gate.toFixed(2)}) commits `
        + `${loosest.n}/${ok.length} at risk ${loosest.err15}/${loosest.n}; the`);
    L.push(`tightest non-empty gate (${tightest.gate.toFixed(2)}) commits ${tightest.n}/${ok.length} `
        + `at risk ${tightest.err15}/${tightest.n}. The lowest risk`);
    L.push(`any gate reaches is ${best.err15}/${best.n} at gate ${best.gate.toFixed(2)}, and risk `
        + `${falls ? "does fall somewhere as the gate" : "NEVER falls anywhere as the gate"}`);
    L.push(falls
        ? "tightens, so the trade is real and the operating point is worth choosing."
        : "tightens: the gate strips correct commitments at least as fast as wrong ones.");
    L.push("No setting yields an error-free commit set. That is F1 restated in");
    L.push("operating-point terms — conditioning is not the variable that decides whether");
    L.push("a commitment is right — and a gate tuned on 26 scenarios with single-digit");
    L.push("commit counts is a picture of this set, not a shippable operating point.");
}
L.push("");

const md = L.join("\n") + "\n";
fs.writeFileSync(path.join(DIR, "summary.md"), md);
console.log(md);
