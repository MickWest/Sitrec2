/**
 * dossiers.bench.test.js — build the escalation-pilot dossiers: truth-blind
 * case files for an analyst (human or agent), plus a separate answer key.
 *
 *     npm run bench-bot-dossiers
 *
 * WHY THIS IS A BENCH TEST AND NOT A PLAIN NODE SCRIPT. It was one, and the
 * kinematic profile silently never appeared in any dossier. The profile needs
 * the OBSERVED sightlines, so it regenerates the scenario through
 * generateScenario, and that pulls in the whole lib graph, whose imports are
 * extensionless. Plain Node ESM does not resolve those; babel does. Every
 * other generator in this directory runs under Jest for exactly this reason.
 * The failure was swallowed by a try/catch that logged to stderr while the
 * script exited 0 — so the harness now ASSERTS the profile is present rather
 * than hoping, which is the real fix.
 *
 * Case selection covers the behaviors the pilot must probe:
 *   - a fit found but withheld by the class screen (dash)
 *   - honest abstentions on mundane data (aguadilla, burst, circuits)
 *   - true anomalies the verdict abstained on (gofast-anom, hover-anom)
 *   - a confident WRONG answer (hypersonic-glide)
 *   - a clean solve as the do-no-harm control (gofast)
 *
 * Output: results/escalation/case-<id>.md (truth-blind) and keys.json (the
 * scoring key, never shown to the analyst).
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "./lib/generateScenario";
import {REAL_SCENARIOS, buildRealScenarioSpec} from "./lib/realScenarioSet";
import {buildDossier, buildAnswerKey, kinematicProfile} from "./lib/dossier";

const DIR = path.resolve(__dirname, "results", "tractability");
const OUT = path.resolve(__dirname, "results", "escalation");

const WANT = [
    "real|dash", "real|aguadilla", "real|burst", "real|circuits",
    "real|gofast-anom", "real|hover-anom", "maneuver|hypersonic-glide",
    "real|gofast",
];

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

// The profile needs the OBSERVED sightlines, which a record does not carry (it
// stores summaries, not series). Regenerating from the record's own spec is
// exact, because generation is deterministic, and keeps this path truth-free:
// only observation.observedDirectionENU is read.
function profileFor(record) {
    const spec = record.outcome?.spec;
    if (!spec) return null;
    if (spec.target?.family === "real") {
        // A real-segment spec references a registered segment by key; rebuild
        // it from the set definition so the key resolves.
        const wanted = record.label.replace(/-anom$/, "");
        const def = REAL_SCENARIOS.find((d) => d.label === wanted
            && (record.label.endsWith("-anom") ? d.anomalous === true : !d.anomalous));
        if (!def) return null;
        buildRealScenarioSpec(def);
    }
    const seed = record.setId === "real" ? 901 : record.setId === "maneuver" ? 801 : 101;
    const scenario = generateScenario(spec, {scenarioSeed: seed});
    // Three assumed ranges spanning the SEARCHED bracket (never the true one).
    const lo = record.outcome.resolvedRangeLoM;
    const hi = record.outcome.resolvedRangeHiM;
    const ranges = [lo, Math.sqrt(lo * hi), hi];
    return {...kinematicProfile(scenario.observation.observedDirectionENU,
        scenario.n, spec.fps, ranges), ranges};
}

describe("escalation dossiers", () => {
    jest.setTimeout(180000);

    beforeAll(() => {
        setSit({name: "botbench-dossiers", frames: 100000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("writes a truth-blind dossier and answer key per selected case", () => {
        const byKey = loadRecords();
        if (!byKey.size) {
            console.log("[botbench] no tractability records yet — run bench-bot-tract first");
            return;
        }
        fs.mkdirSync(OUT, {recursive: true});
        const keys = {};
        let i = 0;
        const missing = [];
        for (const want of WANT) {
            const r = byKey.get(want);
            if (!r || r.error) { missing.push(want); continue; }
            i++;
            const caseId = `C${String(i).padStart(2, "0")}`;
            const profile = profileFor(r);
            // The profile is the point of this exporter, not a nicety: without
            // it a spliced impulse is invisible in the scalar summaries, which
            // is how the first pilot missed every anomaly. A silent absence is
            // the failure mode, so fail loudly instead.
            expect(profile).not.toBeNull();
            expect(profile.rows.length).toBeGreaterThan(3);
            const md = buildDossier(r, {caseId, profile});
            expect(md).toContain("Kinematic profile");
            // Truth-blindness, asserted rather than assumed.
            expect(md).not.toContain("truthSep");
            expect(md).not.toMatch(/\bmeanTruthRange\b/);
            fs.writeFileSync(path.join(OUT, `case-${caseId}.md`), md);
            keys[caseId] = buildAnswerKey(r);
        }
        fs.writeFileSync(path.join(OUT, "keys.json"), JSON.stringify(keys, null, 2));
        console.log(`[botbench] wrote ${i} dossiers + keys.json to ${OUT}`
            + (missing.length ? `\n  missing records (skipped): ${missing.join(", ")}` : ""));
        expect(i).toBeGreaterThan(0);
    });
});
