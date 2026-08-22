/**
 * triageFeatures.bench.test.js — measure the NEW triage signals against the
 * outcomes already recorded, without re-running the expensive fit battery.
 *
 *     npm run bench-bot-triage
 *
 * WHY THIS IS CHEAP. A tractability record stores its own spec, and generation
 * is deterministic and fast — it is the FITTING that costs minutes. So the
 * scenario can be regenerated here purely to read pre-fit observables, and
 * joined against the outcome the battery already measured. Nothing is re-fitted
 * and no outcome is recomputed.
 *
 * The signals under test, all truth-free:
 *   - conditioningStack / maxObservableOrder (lib/diagnostics.js): how high an
 *     order of target dynamics this geometry can support at all.
 *   - sigma_r/r (lib/crlbTriage.js): a pre-fit lower bound on fractional range
 *     error for an assumed constant-velocity target.
 *   - the empirical noise self-check (lib/noiseSelfCheck.js): does the data
 *     agree with the scenario's DECLARED pointing error.
 *
 * What this can and cannot show. With a few dozen heterogeneous scenarios, one seed
 * each, this is a DESCRIPTIVE join: it establishes that the signals compute
 * over real records, what values they take, and whether their ordering looks
 * related to outcome. It cannot establish a threshold, and it must not be read
 * as validating one. Output: results/tractability/triage-features.md.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {REAL_SCENARIOS, buildRealScenarioSpec} from "./lib/realScenarioSet";
import {makeLosGeometry, crlbTriage} from "./lib/crlbTriage";
import {noiseSelfCheck} from "./lib/noiseSelfCheck";

const DIR = path.resolve(__dirname, "results", "tractability");

function loadRecords() {
    if (!fs.existsSync(DIR)) return [];
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
    return [...byKey.values()];
}

// Regenerate a record's scenario for its pre-fit observables only.
function regenerate(record) {
    const spec = record.outcome?.spec;
    if (!spec) return null;
    if (spec.target?.family === "real") {
        const wanted = record.label.replace(/-anom$/, "");
        const def = REAL_SCENARIOS.find((d) => d.label === wanted
            && (record.label.endsWith("-anom") ? d.anomalous === true : !d.anomalous));
        if (!def) return null;
        buildRealScenarioSpec(def);
    }
    const seed = record.setId === "real" ? 901 : record.setId === "maneuver" ? 801 : 101;
    try {
        return generateScenario(spec, {scenarioSeed: seed});
    } catch (e) {
        return {error: String(e.message ?? e)};
    }
}

const fin = (x) => Number.isFinite(x);
const fmt = (x, d = 3) => (fin(x) ? x.toFixed(d) : "n/a");

describe("triage features vs recorded outcomes", () => {
    jest.setTimeout(600000);

    beforeAll(() => {
        setSit({name: "botbench-triage", frames: 100000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("computes the new signals over every record and reports the join", () => {
        const records = loadRecords();
        if (!records.length) {
            console.log("[botbench] no tractability records — run bench-bot-tract first");
            return;
        }

        const rows = [];
        const stale = [];
        for (const r of records) {
            const s = regenerate(r);
            if (!s || s.error) {
                // A stale spec (its segment key predates an ingest change) is a
                // finding in itself, not a crash: report it and continue.
                stale.push(`${r.setId}/${r.label}: ${s?.error ?? "no spec"}`);
                continue;
            }
            const d = s.diagnostics ?? {};
            // Both modules take raw series, not a scenario: they are
            // deliberately ignorant of this harness's object shapes, which is
            // also what keeps them structurally unable to see truth.
            const obs = s.observation;
            const active = [];
            for (let f = 0; f < s.n; f++) if (obs.inFov[f]) active.push(f);
            const sigmaDeg = s.spec.observation.gaussianSigmaDeg
                ?? s.spec.observation.wobble?.amplitude ?? 0.03;
            let crlb = null, noise = null;
            try {
                const geometry = makeLosGeometry({
                    sensorPositionENU: s.platform.positionENU,
                    observedDirectionENU: obs.observedDirectionENU,
                    times: s.times,
                    activeFrames: active,
                    sigmaRad: sigmaDeg * Math.PI / 180,
                });
                // The SEARCHED bracket, never the generating range.
                crlb = crlbTriage(geometry, {
                    minRangeM: r.outcome.resolvedRangeLoM,
                    maxRangeM: r.outcome.resolvedRangeHiM,
                });
            } catch (e) { crlb = {error: String(e.message ?? e)}; }
            try {
                noise = noiseSelfCheck(obs.observedDirectionENU, {
                    times: s.times, activeFrames: active,
                    declaredSigmaDeg: sigmaDeg,
                    declaredKind: s.spec.observation.kind,
                });
            } catch (e) { noise = {error: String(e.message ?? e)}; }
            rows.push({r, d, crlb, noise});
        }

        const L = [];
        L.push("# Triage features vs recorded outcomes");
        L.push("");
        L.push(`${rows.length} records joined${stale.length ? `, ${stale.length} skipped as stale` : ""}.`);
        L.push(`DESCRIPTIVE ONLY: ${rows.length} heterogeneous scenarios, one seed each. This shows what`);
        L.push("the signals compute and how they order, not that any threshold is valid.");
        L.push("");
        if (stale.length) {
            L.push("## Stale specs (could not regenerate)");
            L.push("");
            for (const s of stale) L.push(`- ${s}`);
            L.push("");
        }
        L.push("## Join");
        L.push("");
        L.push("| scenario | maxOrder | cv | ca | jerk | sigma_r/r (med) | noise ratio | verdict | topRelSep |");
        L.push("|---|---|---|---|---|---|---|---|---|");
        for (const {r, d, crlb, noise} of rows) {
            const st = d.conditioningStack ?? {};
            const med = crlb?.sigmaROverR?.median;
            L.push(`| ${r.setId}/${r.label} | ${d.maxObservableOrder ?? "n/a"} `
                + `| ${fmt(st.cv, 2)} | ${fmt(st.ca, 2)} | ${fmt(st.jerk, 2)} `
                + `| ${fin(med) ? med.toExponential(2) : (crlb?.error ? "err" : "n/a")} `
                + `| ${fmt(noise?.ratioToDeclared ?? noise?.ratio, 2)} `
                + `| ${r.error ? "ERROR" : r.outcome.executive.code} `
                + `| ${fmt(r.derived?.topRelSep)} |`);
        }
        L.push("");

        // Does the order gate separate solved from unsolved? Descriptive counts.
        L.push("## maxObservableOrder vs solved (topRelSep <= 0.15)");
        L.push("");
        L.push("| maxOrder | records | solved |");
        L.push("|---|---|---|");
        const byOrder = new Map();
        for (const {r, d} of rows) {
            const k = d.maxObservableOrder ?? -1;
            if (!byOrder.has(k)) byOrder.set(k, []);
            byOrder.get(k).push(r);
        }
        for (const k of [...byOrder.keys()].sort((a, b) => a - b)) {
            const rs = byOrder.get(k);
            const solved = rs.filter((r) => fin(r.derived?.topRelSep)
                && r.derived.topRelSep <= 0.15).length;
            L.push(`| ${k} | ${rs.length} | ${solved} |`);
        }
        L.push("");
        L.push("## Noise self-check: declared vs measured");
        L.push("");
        const flagged = rows.filter(({noise}) => noise?.mismatch === true
            || noise?.ratioFlag === true);
        L.push(`${flagged.length} of ${rows.length} records flag a mismatch between the`);
        L.push("declared pointing error and the empirical estimate.");
        for (const {r, noise} of flagged) {
            L.push(`- ${r.setId}/${r.label}: ratio ${fmt(noise.ratioToDeclared ?? noise.ratio, 2)}`
                + (noise.whiteness ? `, ${noise.whiteness}` : ""));
        }
        L.push("");

        const out = path.join(DIR, "triage-features.md");
        fs.writeFileSync(out, L.join("\n") + "\n");
        console.log(`[botbench] triage feature join -> ${out}\n`
            + L.slice(L.indexOf("## Join")).slice(0, 34).join("\n"));

        expect(rows.length).toBeGreaterThan(0);
    });
});
