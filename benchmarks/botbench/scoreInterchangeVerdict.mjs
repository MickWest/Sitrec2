#!/usr/bin/env node
/**
 * scoreInterchangeVerdict.mjs — turn interchange-verdict.json into a readable table.
 *
 * Usage: node benchmarks/botbench/scoreInterchangeVerdict.mjs [rows.json]
 *
 * SCORING IS ASYMMETRIC, deliberately.
 *
 * Only three of the six published truth classes have a Sitrec interpretation class
 * (balloon, aircraft->fixedWing, venus->knownObject). For the other three — bird,
 * aerostat, anomalous — there is no model, so the HONEST outcome is that no single
 * class is claimed. "unresolved" is a pass for those, and "consistent-one" is a
 * FALSE IDENTIFICATION, the worst result on the sheet. Scoring every "unresolved"
 * as a failure would reward the overconfidence TraverseRanking exists to prevent.
 *
 * The ceiling is "consistent-one": "probably-balloon" needs independent wind
 * corroboration that the benchmark cannot supply without manufacturing it (a
 * scenario's wind is a hand-set constant), so it is unreachable here BY DESIGN.
 *
 * The set also declares its own difficulty in geometry.designIntent. Only the
 * "recoverable" cells are expected to resolve; "degenerate-by-design" cells are
 * SUPPOSED to defeat the analysis, and counting them as misses would make the
 * benchmark look worse the more honest the scenario set got.
 */

import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN = process.argv[2] || path.resolve(__dirname, "results/interchange-verdict.json");
// `answers/` exists only in a SEALED build (lib/interchangeRelease.js); the
// documented default publishes All/ at the top level. Take whichever is there.
const ALL = [
    path.resolve(__dirname, "results/interchange/answers/All"),
    path.resolve(__dirname, "results/interchange/All"),
].find((d) => fs.existsSync(d)) || path.resolve(__dirname, "results/interchange/All");

// The three truth classes Sitrec actually models. Declared here rather than
// beside score(), because the input validation below needs it — a `const` is in
// its temporal dead zone until its declaration runs, so referring to it from
// earlier code throws at startup rather than failing a check.
const HAS_CLASS = new Set(["balloon", "aircraft", "venus"]);

const rows = JSON.parse(fs.readFileSync(IN, "utf8"));

// REFUSE TO SCORE AN INVALID *OR* INCOMPLETE ARTIFACT.
//
// The runner only publishes to the canonical path after validating, but this
// script takes a path argument and can be pointed at a .partial file, an old
// artifact, or a hand-edited one — so it defends itself rather than trusting
// the producer.
//
// TWO SEPARATE CHECKS, and an earlier version had only the first. Row validity
// catches a run that errored. It does NOT catch a run that stopped early: a
// .partial holding 20 perfectly valid rows passes every per-row test and then
// yields a confident "2/9 identified" computed from half the data. Missing
// scenarios are silently absent from every denominator, which is the same
// absence-read-as-measurement failure as the merged bands and the crashed
// pairs. Both directions have to be closed.
//
// Pass --partial-ok for a deliberate subset (BOTBENCH_IV_IDS / BOTBENCH_IV_LIMIT).
const PARTIAL_OK = process.argv.includes("--partial-ok");

const refuse = (title, lines) => {
    console.error(`\nREFUSING TO SCORE ${path.basename(IN)}: ${title}\n`);
    for (const l of lines.slice(0, 12)) console.error(`  ${l}`);
    if (lines.length > 12) console.error(`  ...and ${lines.length - 12} more`);
    console.error("\nA partial or failed run is not a measurement. Re-run the sweep,");
    console.error("or pass --partial-ok if this subset is deliberate.\n");
    process.exit(1);
};

if (!Array.isArray(rows) || rows.length === 0) {
    refuse("the file holds no rows", [`parsed type: ${Array.isArray(rows) ? "empty array" : typeof rows}`]);
}

// `== null` deliberately, to catch BOTH null and undefined. A row from an older
// schema, a hand-edited file, or a partially-written object may lack the key
// entirely — and `undefined === null` is false, so a strict check waves it
// through to score() where it falls out as "miss" and is blamed on the analysis.
// Identity and config are checked the same way: a row that cannot say which
// scenario it is cannot be counted in any denominator.
const invalid = rows.filter((r) => r.error
    || r.executiveCode == null || r.id == null || r.config == null
    || !Array.isArray(r.viableClasses));
if (invalid.length) {
    refuse(`${invalid.length} of ${rows.length} rows are not scoreable`,
        invalid.map((r) => `${r.id ?? "<no id>"} [${r.config ?? "<no config>"}] `
            + (r.error ? `errored: ${String(r.error).split("\n")[0]}`
                : r.executiveCode == null ? "no executive verdict"
                    : !Array.isArray(r.viableClasses) ? "viableClasses missing or not an array"
                        : "missing id or config")));
}

// DUPLICATES, always — a repeated row corrupts every denominator.
//
// This is checked even under --partial-ok, because a deliberate subset is still
// never a reason to count a scenario twice. The scoring loops below iterate over
// `rows`, so a row appearing three times contributes three times: "2/9
// identified" quietly becomes "2/11", and a duplicated falseID reads as three
// separate failures. An append-instead-of-overwrite, a concatenation of two
// chunked runs, or a merge that did not de-duplicate all produce exactly this.
//
// A presence check cannot catch it: an earlier version tested membership of a
// Set built from the rows, and a duplicated key is trivially present.
// The id and the config are kept alongside the joined key, so the message can be
// built from them directly. Splitting the key back apart would misreport any id
// that itself contains the "|" separator.
const counts = new Map();
for (const r of rows) {
    const k = `${r.id}|${r.config}`;
    const seen = counts.get(k);
    counts.set(k, seen ? {...seen, n: seen.n + 1} : {id: r.id, config: r.config, n: 1});
}
const dupes = [...counts.values()].filter((d) => d.n > 1);
if (dupes.length) {
    refuse(`${dupes.length} (scenario, config) pair(s) appear more than once`,
        dupes.map((d) => `${d.id} [${d.config}] appears ${d.n} times`));
}

// TRUTH LABELS — the fields score() BRANCHES on, and the ones whose absence is
// silently survivable.
//
// The checks above cover the verdict side. They do nothing for the truth side,
// and score() reads `objectClass`, `truthClass` and `anomalous` without
// verifying any of them:
//
//   objectClass missing -> HAS_CLASS.has(undefined) is false -> the row is
//     treated as an UNMODELLED truth, so a failure becomes "honest-unknown",
//     which is a pass. Measured: strip bot-0002's label and a balloon `miss`
//     silently becomes a pass.
//   truthClass missing on a modelled class -> every comparison against it fails
//     -> a correct identification is recorded as a false ID.
//   anomalous missing on an "anomalous" row -> control detection fails, and a
//     control cell is scored against rules written for a real anomaly.
//
// readInterchange leaves `labels` null when a .truth.json is absent, so this is
// reachable by deleting one file — and it fails in the flattering direction,
// like every other defect this harness has had.
// VALIDATE AGAINST A KNOWN SET, NOT MERELY AGAINST null.
//
// A first version only tested `objectClass != null`, which fails OPEN: any
// unrecognised value — a typo like "ballon", a class added to the generator but
// not here — is not in HAS_CLASS, so it is silently treated as an UNMODELLED
// truth and its failures score as "honest-unknown" passes. An unknown label is
// not an unmodelled object; it is a label this scorer does not understand, and
// the two must not share a bucket.
//
// The expected truth -> Sitrec class map, mirroring the runner's. Duplicated
// deliberately: the point is to CHECK the runner's output, so deriving it from
// the same import would make the check vacuous.
const TRUTH_TO_CLASS = {
    balloon: "balloon",
    aircraft: "fixedWing",
    venus: "knownObject",
    bird: null,
    aerostat: null,
    anomalous: null,
};

const truthProblem = (r) => {
    if (typeof r.objectClass !== "string" || !r.objectClass) {
        return "no objectClass — is its .truth.json missing?";
    }
    if (!(r.objectClass in TRUTH_TO_CLASS)) {
        return `unrecognised objectClass "${r.objectClass}" — this scorer has no `
            + "rule for it, and guessing would score it as an unmodelled object";
    }
    const want = TRUTH_TO_CLASS[r.objectClass];
    // `undefined` (key absent) is distinct from an explicit null, which is the
    // correct value for an unmodelled class.
    if (r.truthClass === undefined) return "truthClass key is absent";
    if ((r.truthClass ?? null) !== want) {
        return `truthClass "${r.truthClass}" contradicts objectClass `
            + `"${r.objectClass}" (expected ${want === null ? "null" : `"${want}"`})`;
    }
    if (r.objectClass === "anomalous" && typeof r.anomalous !== "boolean") {
        return "anomalous cell with no anomalous flag — control vs anomaly is undecidable";
    }
    return null;
};

const untruthed = rows.map((r) => [r, truthProblem(r)]).filter(([, p]) => p);
if (untruthed.length) {
    refuse(`${untruthed.length} of ${rows.length} rows have unusable truth labels`,
        untruthed.map(([r, p]) => `${r.id} [${r.config}] ${p}`));
}

// Completeness: every published scenario must appear for every config present.
if (!PARTIAL_OK) {
    const expected = fs.readdirSync(ALL).filter((f) => f.endsWith(".all.csv"))
        .map((f) => f.replace(/\.all\.csv$/, "")).sort();
    const cfgs = [...new Set(rows.map((r) => r.config))];
    const missing = [];
    for (const cfg of cfgs) {
        for (const id of expected) {
            if (!counts.has(`${id}|${cfg}`)) missing.push(`${id} [${cfg}] not present`);
        }
    }
    if (missing.length) {
        refuse(`${rows.length} rows for ${cfgs.length} config(s), but `
            + `${expected.length} scenarios are published — ${missing.length} missing`, missing);
    }
}

// designIntent / conditioning live in the truth sidecar, not in the run rows.
const design = {};
for (const r of rows) {
    if (design[r.id]) continue;
    const p = path.join(ALL, `${r.id}.truth.json`);
    if (!fs.existsSync(p)) continue;
    const g = JSON.parse(fs.readFileSync(p, "utf8")).geometry || {};
    design[r.id] = {
        intent: g.designIntent ?? null,
        bucket: g.cvConditioningBucket ?? null,
        rcond: g.cvDesignLog10RcondObserved ?? null,
    };
}


/**
 * The four "anomalous" cells are TWO MATCHED PAIRS, and the truth file's
 * `anomalous` boolean is what separates them:
 *
 *   anomalous = false  CONTROL. The same manoeuvre flown within a physically
 *                      achievable envelope. It is SUPPOSED to look like an
 *                      ordinary object, so naming a conventional class is the
 *                      correct answer, not a false identification.
 *   anomalous = true   The real thing (a 20 g pulse; an instantaneous 150 m/s
 *                      velocity step). Confidently calling this conventional
 *                      IS a false identification.
 *
 * Treating all four the same way would score the controls as failures for doing
 * exactly what they were built to test.
 */
function isControlCell(r) {
    return r.objectClass === "anomalous" && r.anomalous === false;
}

/**
 * Every outcome this can return. An earlier version documented five and returned
 * eight, which is how a reader ends up trusting a tally they cannot decode.
 *
 *   hit             a modelled class, correctly and singly identified
 *   miss            a modelled class, not identified at all
 *   miss-several    a modelled class named among several — the truth is in the
 *                   list but nothing is concluded. Counted as a miss because the
 *                   scored question is identification, NOT because naming
 *                   several is dishonest; it is often the correct answer.
 *   falseID         a class was singly claimed that is not the truth  <-- worst
 *   honest-unknown  an unmodelled truth, correctly left unclaimed
 *   control-named   a control cell (ordinary motion) given a single conventional
 *                   class. NOT a "hit": the cell has no true object class, so
 *                   only the willingness to name one is scored, never which.
 *   control-unnamed a control cell left unresolved or ambiguous
 *   abstain         "insufficient": the analysis declined on stated gate grounds
 *   error           the run threw
 *
 * CAVEAT ON CLASS-LEVEL CREDIT. `hit` and `hit-control` score the CLASS NAME
 * only. They say nothing about where the trajectory went — bot-0008 scores
 * hit-control with its winning fit ~18 km from truth. That is credit in the
 * direction that flatters the analysis, and the separation column must be read
 * alongside the tally rather than after it.
 */
function score(r) {
    const modelled = HAS_CLASS.has(r.objectClass);
    if (r.error) return "error";

    // "insufficient" is an EVIDENCE gate — circular sightlines, or range not
    // determined by this geometry — and it applies to every cell including a
    // control. A previous version of this function tested controls first, on the
    // reasoning that "a control that declines has failed its test". That was
    // wrong: it converted the analysis correctly refusing on inadequate evidence
    // into a scored failure. "unresolved" (no model passed the screen) is a
    // control failure; "insufficient" (the evidence cannot discriminate at all)
    // is not.
    if (r.executiveCode === "insufficient") return "abstain";

    if (isControlCell(r)) {
        // NOT scored as a "hit". A control cell's truth label is "anomalous" and
        // it has NO true object class, so there is nothing to compare a class
        // name against — calling any single class a hit would reward an
        // arbitrary claim, since "balloon" would score exactly as well as the
        // "fixedWing" actually returned. What is scored is only WILLINGNESS to
        // name a conventional class for physically ordinary motion.
        //
        // The real control test is pairwise and lives in reportPairs() below.
        return r.executiveCode === "consistent-one" ? "control-named" : "control-unnamed";
    }
    if (!modelled) {
        return r.executiveCode === "consistent-one" ? "falseID" : "honest-unknown";
    }
    if (r.executiveCode === "consistent-one") {
        return r.viableClasses[0] === r.truthClass ? "hit" : "falseID";
    }
    if (r.executiveCode === "consistent-several") {
        return r.viableClasses.includes(r.truthClass) ? "miss-several" : "miss";
    }
    return "miss";
}

/**
 * THE REAL CONTROL TEST — and it is pairwise, not per-cell.
 *
 * The set ships two MATCHED PAIRS. Each pair shares identical geometry and an
 * identical pointing-error realization; the only difference is whether the
 * manoeuvre is physically achievable. The question they are built to ask is not
 * "what class did each get" but "does the analysis tell them apart at all".
 *
 * Scoring the members separately, as this file first did, cannot see that. It
 * scored one control a failure without noticing that its anomalous twin got the
 * SAME verdict — which is the actual result, and a more serious one.
 */
// Sitrec class -> the family key its band is recorded under in perClassCoverage
// (keys look like "lantern|free", "quadcopter|", "aircraft|").
const CLASS_TO_BAND_KEY = {
    balloon: /^lantern/,
    fixedWing: /^aircraft/,
    multirotor: /^quadcopter/,
};

const PAIRS = [
    {name: "pulse-20g", control: "bot-0004", anomaly: "bot-0011"},
    {name: "impulse-east", control: "bot-0008", anomaly: "bot-0017"},
];

function reportPairs(sub) {
    const by = Object.fromEntries(sub.map((r) => [r.id, r]));
    console.log("\nMATCHED PAIRS — same geometry, same pointing error, differing only in");
    console.log("whether the manoeuvre is physically achievable:");
    for (const p of PAIRS) {
        const c = by[p.control], a = by[p.anomaly];

        // A MISSING OR FAILED MEMBER IS NOT A RESULT.
        //
        // Comparing verdicts naively makes two crashed runs look like perfect
        // agreement: both carry executiveCode null and viableClasses [], so the
        // equality test passes and the pair reports INDISTINGUISHABLE — turning
        // a harness failure into a finding about the analysis, in the direction
        // that manufactures a headline. Every degenerate case is named instead.
        if (!c || !a) {
            const missing = [!c && p.control, !a && p.anomaly].filter(Boolean).join(", ");
            console.log(`  ${p.name.padEnd(14)} NOT SCORED — ${missing} absent from this run`);
            continue;
        }
        const broken = [c, a].filter((r) => r.error || r.executiveCode === null);
        if (broken.length) {
            console.log(`  ${p.name.padEnd(14)} NOT SCORED — no verdict for `
                + `${broken.map((r) => r.id).join(", ")} `
                + `(${broken[0].error ? "run errored" : "no executive verdict produced"})`);
            continue;
        }

        const same = c.executiveCode === a.executiveCode
            && JSON.stringify(c.viableClasses) === JSON.stringify(a.viableClasses);
        console.log(`  ${p.name.padEnd(14)} control ${p.control} ${c.executiveCode}`
            + `${c.viableClasses.length ? " " + c.viableClasses.join("/") : ""}`
            + `  |  anomaly ${p.anomaly} ${a.executiveCode}`
            + `${a.viableClasses.length ? " " + a.viableClasses.join("/") : ""}`);
        console.log(`  ${" ".repeat(14)} -> ${same ? "INDISTINGUISHABLE" : "distinguished"}`);
    }
}

const configs = [...new Set(rows.map((r) => r.config))];

for (const cfg of configs) {
    const sub = rows.filter((r) => r.config === cfg);
    console.log(`\n${"=".repeat(112)}\nCONFIG: ${cfg}   `
        + `bracket ${sub[0].bracketLoNM ? sub[0].bracketLoNM.toFixed(1) + "-"
            + sub[0].bracketHiNM.toFixed(1) + " NM (pinned)" : "adaptive around anchor"}`);
    console.log("=".repeat(112));
    console.log(
        "id".padEnd(9) + "class".padEnd(10) + "intent".padEnd(21)
        + "trueRng".padStart(9) + "  " + "verdict".padEnd(19)
        + "top".padEnd(13) + "sep".padStart(9) + "cov".padStart(6) + "  outcome");
    console.log("-".repeat(112));

    const tally = {};
    for (const r of sub) {
        const o = score(r);
        tally[o] = (tally[o] || 0) + 1;
        const rng = r.truthRangeLoNM === null ? "-"
            : `${r.truthRangeLoNM.toFixed(1)}-${r.truthRangeHiNM.toFixed(1)}`;
        console.log(
            r.id.padEnd(9)
            + String(r.objectClass).padEnd(10)
            + String(design[r.id]?.intent ?? "-").padEnd(21)
            + rng.padStart(9) + "  "
            + String(r.executiveCode).padEnd(19)
            + String(r.topKey ?? "-").padEnd(13)
            + (r.topTruthSepM === null ? "-" : Math.round(r.topTruthSepM) + "m").padStart(9)
            + (r.unionCoverage === null ? "-" : r.unionCoverage.toFixed(2)).padStart(6)
            + "  " + o);
    }
    console.log("-".repeat(112));
    console.log("tally:", JSON.stringify(tally));

    // The headline number: of the cells the SET says should be recoverable and
    // that Sitrec actually models, how many were identified?
    const target = sub.filter((r) => design[r.id]?.intent === "recoverable"
        && HAS_CLASS.has(r.objectClass));
    const hits = target.filter((r) => score(r) === "hit").length;
    console.log(`recoverable AND modelled: ${hits}/${target.length} identified`
        + `  [${target.map((r) => r.id + ":" + score(r)).join(", ")}]`);

    const falseIDs = sub.filter((r) => score(r) === "falseID");
    if (falseIDs.length) {
        console.log(`FALSE IDs (${falseIDs.length}): `
            + falseIDs.map((r) => `${r.id} (${r.objectClass} -> ${r.viableClasses.join("/")})`).join(", "));
    }

    // Band containment is a separate axis from identification: a band can contain
    // truth while the verdict says nothing, and can miss truth while the verdict
    // is right. Both are failures, of different kinds.
    const withCov = sub.filter((r) => Number.isFinite(r.unionCoverage));
    const contained = withCov.filter((r) => r.unionCoverage >= 0.95).length;
    console.log(`band contains truth (>=0.95), UNION across classes: ${contained}/${withCov.length}`
        + `  [misses: ${withCov.filter((r) => r.unionCoverage < 0.95)
            .map((r) => r.id + ":" + r.unionCoverage.toFixed(2)).join(", ") || "none"}]`);

    // The union credits a scenario when ANY class's band contains the truth —
    // including a class the verdict rejected. Scored against the band of the
    // class that is actually correct, the figure is materially lower, and that
    // is the one that says whether the band feature works.
    const perTruth = sub.filter((r) => r.truthClass && r.perClassCoverage);
    const hit = perTruth.filter((r) => Object.entries(r.perClassCoverage)
        .some(([k, v]) => CLASS_TO_BAND_KEY[r.truthClass]?.test(k) && v >= 0.95));
    console.log(`band contains truth, CORRECT CLASS only: ${hit.length}/${perTruth.length}`
        + `  [${perTruth.filter((r) => !hit.includes(r)).map((r) => r.id).join(", ") || "none missed"}]`);

    reportPairs(sub);
}
