/**
 * interchangeReidentification.test.js — the security property of a sealed BOT
 * interchange release: opaque ids must NOT be re-identifiable from public
 * inputs.
 *
 * THE ATTACK. Everything in this repo is public: the scenario templates, their
 * scenarioSeed values, and the generator. So an adversary holding only the
 * shipped challenge can:
 *
 *   1. read a shipped input.csv and take its TrackID out of the file;
 *   2. regenerate every public template under that TrackID;
 *   3. compare bytes (or just digests) against the shipped file.
 *
 * An exact match hands over both the identity AND the truth. Note this beats
 * the opaque-id permutation completely — the permutation protects the LABEL
 * while the CONTENT stays reproducible. It also survives seed randomization on
 * its own, because generatePlatformPath takes NO seed: the SensorPos columns
 * are a pure function of the spec.
 *
 * The defence is that a sealed release draws its parameters from the withheld
 * salt (randomizeSpec), so no shipped file corresponds to any public template.
 *
 * This test runs the attack twice:
 *   - against a NON-randomized sealed release, which MUST be fully
 *     re-identified (otherwise the attack is not actually working and a pass
 *     on the randomized case would be meaningless);
 *   - against a randomized sealed release, which must yield ZERO matches.
 */

import fs from "fs";
import os from "os";
import path from "path";
import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {buildInputCsv} from "../../benchmarks/botbench/lib/exportInterchange";
import {SCENARIOS, buildRelease, extractionFloorM, rebuildFromProvenance}
    from "../../benchmarks/botbench/lib/interchangeRelease";

const SALT = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

// Numeric payload of an input.csv, with the TrackID and TrackSource columns
// stripped. An adversary who cannot guess the TrackID still recognises the
// geometry, so the stronger test compares only the physics columns.
function payload(csvText) {
    return csvText.trim().split("\n").slice(1)
        .map((line) => line.split(",").slice(2).join(","))
        .join("\n");
}

/**
 * Try to map each shipped file to a public template.
 * @returns array of {shipped, templateIndex} for every exact match found
 */
function attack(challengeDir, shippedNames) {
    const hits = [];
    // Precompute what each public template produces. The TrackID column varies
    // per shipped file, so compare the numeric payload rather than raw bytes.
    const candidates = SCENARIOS.map((e, i) => {
        const scenario = generateScenario(e.spec, {scenarioSeed: e.scenarioSeed});
        return {i, payload: payload(buildInputCsv(scenario, "x", "botbench"))};
    });

    for (const name of shippedNames) {
        const text = fs.readFileSync(
            path.join(challengeDir, "Input", `${name}.input.csv`), "utf8");
        const p = payload(text);
        for (const c of candidates) {
            if (c.payload === p) hits.push({shipped: name, templateIndex: c.i});
        }
    }
    return hits;
}

/**
 * EXACT-TRUTH EXTRACTION from a single shipped input.csv.
 *
 * platforms.js "orbit-point" orbits THE TARGET'S INITIAL GROUND POINT, so an
 * algebraic circle fit to the published SensorPos E,N columns recovers where
 * the target started — exactly, and invariantly under any rigid transform of
 * the scene. Projecting the frame-0 sightline onto that point then pins the
 * range, and with a NOISELESS sightline the whole position falls out to ~1e-9 m.
 *
 * @returns position error in metres at frame 0
 */
/**
 * THE ORIGIN ATTACK, from the shipped files only.
 *
 * The generator places every track target at the ENU ORIGIN — truth[0] is
 * exactly (0, 0, startAGL) — and scenario.json publishes that origin in
 * frame.originLLA. So no circle fit is needed: solve the frame-0 ray for the
 * point with E = N = 0 and frame-0 truth falls out. This needs no arc, so it
 * defeats a straight sensor path too, and it bypasses the orbit-direction
 * defence entirely.
 *
 * @returns position error in metres at frame 0
 */
function extractTruthViaOrigin(challengeDir, answersDir, name) {
    const read = (f) => {
        const lines = fs.readFileSync(f, "utf8").trim().split("\n");
        const hdr = lines[0].split(",");
        const c = lines[1].split(",");
        const o = {}; hdr.forEach((h, i) => { o[h] = c[i]; }); return o;
    };
    const i0 = read(path.join(challengeDir, "Input", `${name}.input.csv`));
    const t0 = read(path.join(answersDir, "Truth", `${name}.truth.csv`));
    // Direction truth: the column EXISTS in v1.1 and is empty, so an
    // undefined-check no longer detects it — and Number("") is 0, which would
    // have turned "no position to extract" into a confident extraction at the
    // origin and quietly weakened this assertion.
    if (!t0.TruePositionX) return Infinity;

    const S = [Number(i0.SensorPositionX), Number(i0.SensorPositionY), Number(i0.SensorPositionZ)];
    const L = [Number(i0.LOSUnitVectorX), Number(i0.LOSUnitVectorY), Number(i0.LOSUnitVectorZ)];
    const lam = ((0 - S[0]) * L[0] + (0 - S[1]) * L[1]) / (L[0] * L[0] + L[1] * L[1]);
    return Math.hypot(
        S[0] + lam * L[0] - Number(t0.TruePositionX),
        S[1] + lam * L[1] - Number(t0.TruePositionY),
        S[2] + lam * L[2] - Number(t0.TruePositionZ),
    );
}

function extractTruth(challengeDir, answersDir, name) {
    const rows = (f) => {
        const lines = fs.readFileSync(f, "utf8").trim().split("\n");
        const hdr = lines[0].split(",");
        return lines.slice(1).map((l) => {
            const c = l.split(","); const o = {};
            hdr.forEach((h, i) => { o[h] = c[i]; }); return o;
        });
    };
    const input = rows(path.join(challengeDir, "Input", `${name}.input.csv`));
    const truth = rows(path.join(answersDir, "Truth", `${name}.truth.csv`));
    if (!truth[0].TruePositionX) return Infinity;   // direction truth: empty column

    // Kasa circle fit over the sensor ground track.
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxxx = 0, Syyy = 0, Sxyy = 0, Sxxy = 0;
    const N = input.length;
    for (const r of input) {
        const x = Number(r.SensorPositionX), y = Number(r.SensorPositionY);
        Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
        Sxxx += x * x * x; Syyy += y * y * y; Sxyy += x * y * y; Sxxy += x * x * y;
    }
    const a = 2 * (Sxx - Sx * Sx / N), b = 2 * (Sxy - Sx * Sy / N);
    const c = 2 * (Syy - Sy * Sy / N);
    const d = Sxxx + Sxyy - (Sxx + Syy) * Sx / N;
    const e = Syyy + Sxxy - (Sxx + Syy) * Sy / N;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-9) return Infinity;              // not an arc
    const cE = (d * c - e * b) / det;
    const cN = (a * e - b * d) / det;

    // Least squares over BOTH horizontal components: solving either alone
    // divides by a LOS component that can vanish.
    const S = [Number(input[0].SensorPositionX), Number(input[0].SensorPositionY),
        Number(input[0].SensorPositionZ)];
    const L = [Number(input[0].LOSUnitVectorX), Number(input[0].LOSUnitVectorY), Number(input[0].LOSUnitVectorZ)];
    const lam = ((cE - S[0]) * L[0] + (cN - S[1]) * L[1]) / (L[0] * L[0] + L[1] * L[1]);
    const est = [S[0] + lam * L[0], S[1] + lam * L[1], S[2] + lam * L[2]];
    const act = [Number(truth[0].TruePositionX), Number(truth[0].TruePositionY),
        Number(truth[0].TruePositionZ)];
    return Math.hypot(est[0] - act[0], est[1] - act[1], est[2] - act[2]);
}

describe("sealed interchange release: re-identification resistance", () => {
    jest.setTimeout(180000);

    let tmpRoot;

    beforeAll(() => {
        setSit({name: "botbench-reid", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-reid-"));
    });

    afterAll(() => {
        if (tmpRoot) fs.rmSync(tmpRoot, {recursive: true, force: true});
    });

    // POSITIVE CONTROL. Without parameter randomization every shipped file is
    // reproducible from public source, so the attack must recover ALL of them.
    // If this ever stops finding matches, the attack has broken and the
    // negative result below proves nothing.
    test("the attack works: a non-randomized release is fully re-identified", () => {
        const out = path.join(tmpRoot, "weak");
        const rel = buildRelease({
            outDir: out, sealed: true, saltHex: SALT,
            randomize: false, harden: false,
        });
        const names = rel.index.map((r) => r.name);

        const hits = attack(rel.challengeDir, names);
        expect(hits.length).toBe(SCENARIOS.length);
        // ...and the recovered mapping is the true one.
        const trueMap = new Map(rel.realized.map((r, i) => [r.descriptive, i]));
        for (const h of hits) {
            const descriptive = rel.opaqueMap.find((m) => m.opaqueName === h.shipped).descriptiveName;
            expect(trueMap.get(descriptive)).toBe(h.templateIndex);
        }
        // The manifest must say so out loud rather than implying safety.
        expect(rel.manifest.parametersRandomized).toBe(false);
        expect(rel.manifest.reidentificationNote).toMatch(/NOT SAFE TO PUBLISH/);
    });

    test("a randomized sealed release is not re-identifiable", () => {
        const out = path.join(tmpRoot, "sealed");
        const rel = buildRelease({outDir: out, sealed: true, saltHex: SALT});
        const names = rel.index.map((r) => r.name);

        expect(rel.manifest.parametersRandomized).toBe(true);
        expect(attack(rel.challengeDir, names)).toEqual([]);
    });

    test("realized parameters differ from every public template", () => {
        const out = path.join(tmpRoot, "params");
        const rel = buildRelease({outDir: out, sealed: true, saltHex: SALT});

        for (const r of rel.realized) {
            const same = SCENARIOS.some((t) =>
                t.spec.initialHorizontalRangeM === r.spec.initialHorizontalRangeM
                && t.spec.durationSeconds === r.spec.durationSeconds
                && t.spec.platform.speedMS === r.spec.platform.speedMS
                && t.spec.platform.altitudeAGL === r.spec.platform.altitudeAGL);
            expect(same).toBe(false);
            // The seed must not be a public one either.
            expect(SCENARIOS.map((t) => t.scenarioSeed)).not.toContain(r.scenarioSeed);
        }
    });

    test("a different salt yields a different release", () => {
        const a = buildRelease({outDir: path.join(tmpRoot, "sa"), sealed: true, saltHex: SALT});
        const b = buildRelease({
            outDir: path.join(tmpRoot, "sb"), sealed: true,
            saltHex: "f".repeat(64),
        });
        // Different parameters, so different input bytes under every id.
        const da = new Set(a.manifest.files.map((f) => f.inputCsvSha256));
        const db = b.manifest.files.map((f) => f.inputCsvSha256);
        expect(db.some((h) => da.has(h))).toBe(false);
    });

    test("the matched anomaly/control pair survives randomization", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "pair"), sealed: true, saltHex: SALT,
        });
        const pair = rel.realized.filter((r) => r.jitterKey === "impulse-east-pair");
        expect(pair.length).toBe(2);
        // Same geometry: a pair whose members were jittered apart would no
        // longer isolate the manoeuvre as the only difference.
        expect(pair[0].spec.initialHorizontalRangeM).toBe(pair[1].spec.initialHorizontalRangeM);
        expect(pair[0].spec.durationSeconds).toBe(pair[1].spec.durationSeconds);
        expect(pair[0].spec.platform).toEqual(pair[1].spec.platform);
        expect(pair[0].scenarioSeed).toBe(pair[1].scenarioSeed);
        // ...and differ only in the anomalous flag.
        expect(pair[0].spec.target.parameters.anomalous)
            .not.toBe(pair[1].spec.target.parameters.anomalous);
    });

    // Matched pairs share a sensor trajectory by construction, so the grouping
    // is derivable from the shipped columns whatever we do. The manifest must
    // report it accurately rather than implying it is hidden.
    test("residual pair linkage is measured and published, not implied hidden", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "linkage"), sealed: true, saltHex: SALT,
        });

        // The declared groups must match the true jitterKey grouping.
        const nameOf = new Map(rel.opaqueMap.map((m) => [m.descriptiveName, m.opaqueName]));
        const expected = new Map();
        for (const r of rel.realized) {
            if (!expected.has(r.jitterKey)) expected.set(r.jitterKey, []);
            expected.get(r.jitterKey).push(nameOf.get(r.descriptive));
        }
        const trueGroups = [...expected.values()].filter((g) => g.length > 1)
            .map((g) => [...g].sort()).sort();
        const declared = [...rel.manifest.sharedGeometryGroups].sort();
        expect(declared).toEqual(trueGroups);
        expect(rel.manifest.sharedGeometryNote).toMatch(/at most one member/);
    });

    // POSITIVE CONTROL for the extraction: a non-randomized release still uses
    // orbit-point and still ships the noiseless member, so its truth must come
    // out to numerical precision. If this stops working, the negative result
    // below proves nothing.
    test("the extraction works: a non-randomized release yields EXACT truth", () => {
        const out = path.join(tmpRoot, "extract-weak");
        const rel = buildRelease({
            outDir: out, sealed: true, saltHex: SALT,
            randomize: false, harden: false,
        });
        const clean = rel.index.find((r) => r.declaredSigmaDeg === 0);
        expect(clean).toBeDefined();
        const err = extractTruth(rel.challengeDir, rel.answersDir, clean.name);
        expect(err).toBeLessThan(1e-6);   // measured ~3e-9 m
    });

    test("no sealed member yields exact truth by circle-fit extraction", () => {
        const out = path.join(tmpRoot, "extract-sealed");
        const rel = buildRelease({outDir: out, sealed: true, saltHex: SALT});

        for (const r of rel.realized) {
            const err = extractTruth(rel.challengeDir, rel.answersDir,
                rel.index.find((x) => x.truthSha256 === r.truthSha256).name);
            // The floor scales with range: "how much did they learn" is
            // relative, and 94 m on a 5 km range is a 2% fix on the single
            // hardest unknown in the whole problem.
            expect(err).toBeGreaterThanOrEqual(extractionFloorM(r.spec));
        }
    });

    // POSITIVE CONTROL for the origin attack. Unhardened, every target sits at
    // the ENU origin, so this must land on truth to numerical precision — and
    // note it needs no arc, so it works where the circle fit cannot.
    test("the origin attack works: unhardened truth sits at the ENU origin", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "origin-weak"), sealed: true, saltHex: SALT,
            randomize: false, harden: false,
        });
        const errs = rel.index
            .map((r) => extractTruthViaOrigin(rel.challengeDir, rel.answersDir, r.name))
            .filter((e) => Number.isFinite(e));
        expect(errs.length).toBeGreaterThan(0);
        // The clean member is exact; noisy members are pinned to a small
        // FRACTION OF RANGE. The bound is relative, not the absolute 50 m it
        // used to be: the residual here is the pointing error projected out to
        // the target, so it grows with range, and an absolute bound silently
        // became a statement about which ranges happened to be in the set.
        // Measured worst case is 1.6e-3 of range; extractionFloorM is 0.2.
        expect(Math.min(...errs)).toBeLessThan(1e-6);
        for (const r of rel.realized) {
            const name = rel.index.find((x) => x.truthSha256 === r.truthSha256)?.name;
            if (!name) continue;
            const err = extractTruthViaOrigin(rel.challengeDir, rel.answersDir, name);
            if (!Number.isFinite(err)) continue;                 // direction truth
            expect(err).toBeLessThan(0.005 * r.spec.initialHorizontalRangeM);
        }
    });

    test("no sealed member yields truth via the origin attack", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "origin-sealed"), sealed: true, saltHex: SALT,
        });
        for (const r of rel.index) {
            const err = extractTruthViaOrigin(rel.challengeDir, rel.answersDir, r.name);
            expect(err).toBeGreaterThan(1000);
        }
    });

    // The guarantee must hold for ANY release salt, not the one that happened
    // to be picked here. An earlier version passed only by luck: a banked-curve
    // arc centre landed 94 m from the target under an unlucky draw.
    test("both extraction floors hold across many independent salts", () => {
        const worstFit = [], worstOrigin = [];
        for (let k = 0; k < 12; k++) {
            const salt = `${k}`.padStart(2, "0").repeat(32).slice(0, 64);
            const rel = buildRelease({
                outDir: path.join(tmpRoot, `salt-${k}`), sealed: true, saltHex: salt,
            });
            for (const r of rel.realized) {
                const floor = extractionFloorM(r.spec);
                expect(r.extractionErrorM).toBeGreaterThanOrEqual(floor);
                expect(r.originErrorM).toBeGreaterThanOrEqual(floor);
                worstFit.push(r.extractionErrorM / floor);
                worstOrigin.push(r.originErrorM / floor);
            }
        }
        expect(Math.min(...worstFit)).toBeGreaterThanOrEqual(1);
        expect(Math.min(...worstOrigin)).toBeGreaterThanOrEqual(1);
    });

    test("no sealed target starts at the published ENU origin", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "notorigin"), sealed: true, saltHex: SALT,
        });
        for (const r of rel.realized) {
            const P = r.scenario.target.positionENU;
            if (!P) continue;                                  // direction truth
            expect(Math.hypot(P[0], P[1])).toBeGreaterThan(1000);
        }
    });

    test("a sealed release ships no noiseless member and no shared truth", () => {
        const out = path.join(tmpRoot, "notruthshare");
        const rel = buildRelease({outDir: out, sealed: true, saltHex: SALT});

        // Noiseless bearings are exactly the true bearings, so a noiseless
        // member is solvable outright — and it shared truth with a noisy one.
        expect(rel.manifest.noiselessMembersShipped).toEqual([]);
        // No two shipped scenarios may share truth.
        const truths = rel.index.map((r) => r.truthSha256);
        expect(new Set(truths).size).toBe(truths.length);
        // Nothing is dropped silently — but note WHICH counter moves. The clean
        // member is now withheld for being noiseless (hardening's documented
        // job) before the truth-duplicate pass ever sees it, so it lands in
        // withheldNoiseless rather than withheldForSharedTruth.
        expect(rel.manifest.withheldNoiseless
            + rel.manifest.withheldForSharedTruth).toBeGreaterThan(0);
        const withheld = JSON.parse(fs.readFileSync(
            path.join(rel.answersDir, "withheld-scenarios.json"), "utf8"));
        expect(withheld.withheld.length).toBe(rel.manifest.withheldForSharedTruth);
        expect(withheld.withheldNoiseless.length).toBe(rel.manifest.withheldNoiseless);

        // The development set keeps both members — it is not a challenge.
        const dev = buildRelease({outDir: path.join(tmpRoot, "dev"), sealed: false});
        expect(dev.index.length).toBe(SCENARIOS.length);
    });

    test("sealed releases do not use the target-revealing orbit-point path", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "orbitkind"), sealed: true, saltHex: SALT,
        });
        for (const r of rel.realized) {
            expect(r.spec.platform.kind).not.toBe("orbit-point");
            if (r.spec.platform.kind === "orbit-direction") {
                // f = 1 would put the orbit centre back on the target.
                expect(Math.abs(r.spec.platform.rangeErrorFactor - 1)).toBeGreaterThan(0.1);
            }
        }
    });

    // The celestial scenario's bearings ARE the real sky, computed from the
    // site and epoch that scenario.json publishes. Rotating them about the
    // local vertical would shift Venus's azimuth while keeping its elevation,
    // so the shipped sightlines would contradict any ephemeris — and checking
    // them against an ephemeris is what that scenario exists to test.
    test("the rigid transform preserves the celestial contract", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "venus"), sealed: true, saltHex: SALT,
        });
        const venus = rel.realized.find((r) => r.spec.target.kind === "venus");
        expect(venus).toBeDefined();

        // No rotation was applied...
        expect(venus.placement.psiRad).toBe(0);
        // ...so the shipped bearings equal the untransformed celestial truth.
        const fresh = generateScenario(venus.spec, {scenarioSeed: venus.scenarioSeed});
        const shipped = venus.scenario.target.directionENU;
        const truthDir = fresh.target.directionENU;
        let maxDeg = 0;
        for (let i = 0; i < truthDir.length; i += 3) {
            const dot = shipped[i] * truthDir[i] + shipped[i + 1] * truthDir[i + 1]
                + shipped[i + 2] * truthDir[i + 2];
            const cr = Math.hypot(
                shipped[i + 1] * truthDir[i + 2] - shipped[i + 2] * truthDir[i + 1],
                shipped[i + 2] * truthDir[i] - shipped[i] * truthDir[i + 2],
                shipped[i] * truthDir[i + 1] - shipped[i + 1] * truthDir[i],
            );
            maxDeg = Math.max(maxDeg, Math.atan2(cr, dot) * 180 / Math.PI);
        }
        expect(maxDeg).toBe(0);

        // No translation either. It would buy NOTHING — a direction-kind target
        // has no finite truth position, so both extraction attacks already
        // return Infinity — while pulling the scene away from originLLA, whose
        // ENU basis the shipped bearings live in. See
        // tests/botbench/venusEphemerisContract.test.js, which pins the whole
        // contract against an independent ephemeris.
        expect(venus.placement).toEqual({psiRad: 0, dE: 0, dN: 0});
        // Hardening a celestial scenario relies on parameter jitter alone, so
        // check that part is genuinely still doing its job.
        expect(SCENARIOS.map((t) => t.scenarioSeed)).not.toContain(venus.scenarioSeed);
    });

    // The rigid placement is applied AFTER generateScenario, so spec + seed +
    // generatorVersion alone rebuild a scene that was never shipped. If the
    // placement is not recorded, the provenance describes nothing real.
    test("recorded provenance reproduces the shipped bytes exactly", () => {
        const rel = buildRelease({
            outDir: path.join(tmpRoot, "provenance"), sealed: true, saltHex: SALT,
        });
        const realizedSpecs = JSON.parse(fs.readFileSync(
            path.join(rel.answersDir, "realized-specs.json"), "utf8")).scenarios;

        for (const r of rel.index) {
            const tj = JSON.parse(fs.readFileSync(
                path.join(rel.answersDir, "Truth", `${r.name}.truth.json`), "utf8"));
            const p = tj.provenance;
            expect(p.placement).toBeDefined();

            // Replay from the recorded provenance ALONE.
            const rebuilt = rebuildFromProvenance({
                spec: p.spec, scenarioSeed: p.scenarioSeed, placement: p.placement,
                generatorVersion: p.generatorVersion,
            });
            const shipped = fs.readFileSync(
                path.join(rel.challengeDir, "Input", `${r.name}.input.csv`), "utf8");
            expect(buildInputCsv(rebuilt, r.trackId, "botbench")).toBe(shipped);
        }

        // answers/realized-specs.json must carry it too.
        for (const s of realizedSpecs) expect(s.placement).toBeDefined();
    });

    test("a sealed release fails closed without a salt", () => {
        expect(() => buildRelease({outDir: path.join(tmpRoot, "nosalt"), sealed: true}))
            .toThrow(/requires a salt/);
        expect(() => buildRelease({
            outDir: path.join(tmpRoot, "shortsalt"), sealed: true, saltHex: "abc123",
        })).toThrow(/requires a salt/);
    });
});
