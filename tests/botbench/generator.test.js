/**
 * BOT Bench generator smoke tests (fast; runs in normal `npm test`).
 *
 * Guards the M1 contract of benchmarks/botbench/PLAN.md: determinism, truth/
 * observation seed-key separation, platform feasibility, FOV masking, matched
 * -RMS pairing, adapter aliasing vs compacting, and the conditioning
 * diagnostic's one required qualitative property (orbit >> straight).
 * The full sweep lives in benchmarks/botbench/ and is NOT run here.
 */

import {setSit} from "../../src/Globals";
import {DEFAULT_SITE, generateScenario, SITES, canonical} from "../../benchmarks/botbench/lib/generateScenario";
import {toLOSDataset, toTraverseDataset, toActiveTraverseDataset} from "../../benchmarks/botbench/lib/adapters";
import {generatePlatformPath} from "../../benchmarks/botbench/lib/platforms";
import {deriveSeed, makeStream} from "../../benchmarks/botbench/lib/rng";
import {computeMetrics} from "../../benchmarks/botbench/lib/metrics";

beforeAll(() => {
    // BalloonPhysics/CelestialMath fall back to Sit.lat/lon in places.
    setSit({name: "botbench-test", frames: 1000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
});

const baseSpec = (over = {}) => ({
    durationSeconds: 15,
    fps: 10,
    initialHorizontalRangeM: 5000,
    siteId: "flat-reference",
    platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
    target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
    wind: {kind: "fixed"},
    observation: {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03},
    ...over,
});

describe("botbench generator", () => {
    test("is deterministic: same spec+seed => identical ids and arrays", () => {
        const a = generateScenario(baseSpec(), {scenarioSeed: 101});
        const b = generateScenario(baseSpec(), {scenarioSeed: 101});
        expect(a.scenarioId).toBe(b.scenarioId);
        expect(Array.from(a.target.positionENU)).toEqual(Array.from(b.target.positionENU));
        expect(Array.from(a.observation.observedDirectionENU))
            .toEqual(Array.from(b.observation.observedDirectionENU));
    });

    test("different seeds change the realization but not the shape", () => {
        // NOTE: needs a gusty wind — a constant-wind floater is fully
        // deterministic (the oracle-compatible control), so the target seed
        // correctly has no effect there.
        const gusty = () => baseSpec({wind: {kind: "fixed-gust"}});
        const a = generateScenario(gusty(), {scenarioSeed: 101});
        const b = generateScenario(gusty(), {scenarioSeed: 102});
        expect(a.scenarioId).not.toBe(b.scenarioId);
        expect(a.n).toBe(b.n);
        expect(Array.from(a.target.positionENU)).not.toEqual(Array.from(b.target.positionENU));
    });

    test("truth-key separation: observation spec changes do not touch truth", () => {
        const wobbleSpec = baseSpec({
            observation: {kind: "wobble", fovFullDeg: 0.9,
                wobble: {amplitude: 0.15, driftSpeed: 0.10, reactionTime: 0.4,
                    correctionSpeed: 1.0, accuracy: 0.8}},
        });
        const whiteSpec = baseSpec({observation: {kind: "white", fovFullDeg: 0.9, gaussianSigmaDeg: 0.05}});
        const w = generateScenario(wobbleSpec, {scenarioSeed: 301});
        const g = generateScenario(whiteSpec, {scenarioSeed: 301});
        expect(Array.from(w.target.positionENU)).toEqual(Array.from(g.target.positionENU));
        expect(Array.from(w.platform.positionENU)).toEqual(Array.from(g.platform.positionENU));
        expect(w.scenarioGroupId).toBe(g.scenarioGroupId);
        expect(w.scenarioId).not.toBe(g.scenarioId);
    });

    test("matched-white rescales its own draw to the exact requested RMS", () => {
        const target = 0.1234;
        const s = generateScenario(baseSpec({
            observation: {kind: "white", fovFullDeg: 5, matchedRealizedRmsDeg: target},
        }), {scenarioSeed: 301});
        expect(s.observation.realizedRmsDegAllFrames).toBeCloseTo(target, 10);
    });

    test("anomaly pairs with sharedSeedKey get the identical pointing realization", () => {
        const mk = (anomalous) => baseSpec({
            durationSeconds: 15,
            initialHorizontalRangeM: 20000,
            target: {kind: "anomalous", family: "anomalous",
                parameters: {tupleId: "pulse-20g", anomalous}},
            observation: {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03,
                sharedSeedKey: "pair-pulse-20g-op-401"},
            pairId: "pair-pulse-20g-op-401",
        });
        const a = generateScenario(mk(true), {scenarioSeed: 401});
        const c = generateScenario(mk(false), {scenarioSeed: 401});
        expect(Array.from(a.observation.tangentErrorDeg))
            .toEqual(Array.from(c.observation.tangentErrorDeg));
        // ...but the truth differs (20g pulse vs 2.5g control).
        expect(Array.from(a.target.positionENU)).not.toEqual(Array.from(c.target.positionENU));
    });

    test("platform feasibility: an infeasible orbit throws loudly", () => {
        expect(() => generateScenario(baseSpec({initialHorizontalRangeM: 500}),
            {scenarioSeed: 101})).toThrow(/infeasible/);
    });

    test("straight platform is exactly straight; orbit keeps its radius", () => {
        const st = generateScenario(baseSpec({platform: {kind: "straight", speedMS: 70, altitudeAGL: 3000}}),
            {scenarioSeed: 101});
        const p = st.platform.positionENU;
        for (let f = 0; f < st.n; f++) {
            expect(p[f * 3 + 1]).toBeCloseTo(-5000, 9);
            expect(p[f * 3 + 2]).toBeCloseTo(3000, 9);
        }
        const orb = generateScenario(baseSpec(), {scenarioSeed: 101});
        const q = orb.platform.positionENU;
        for (let f = 0; f < orb.n; f++) {
            expect(Math.hypot(q[f * 3], q[f * 3 + 1])).toBeCloseTo(5000, 6);
        }
    });

    test("clean observation has zero error and full FOV coverage", () => {
        const s = generateScenario(baseSpec({observation: {kind: "clean", fovFullDeg: 0.5}}),
            {scenarioSeed: 101});
        expect(s.observation.realizedMaxDeg).toBe(0);
        expect(s.observation.outOfFrameCount).toBe(0);
        // clean and observed directions are identical
        expect(Array.from(s.observation.observedDirectionENU))
            .toEqual(Array.from(s.observation.cleanDirectionENU));
    });

    test("FOV masking excludes frames whose error exceeds half the FOV", () => {
        // Absurdly tight FOV so white noise at 0.03 deg spills out.
        const s = generateScenario(baseSpec({
            observation: {kind: "white", fovFullDeg: 0.06, gaussianSigmaDeg: 0.03},
        }), {scenarioSeed: 101});
        expect(s.observation.outOfFrameCount).toBeGreaterThan(0);
        for (const f of s.observation.excluded) {
            expect(s.observation.angularErrorDeg[f]).toBeGreaterThan(0.03);
        }
        expect(s.observation.outOfFrameCount + Array.from(s.observation.inFov)
            .reduce((a, b) => a + b, 0)).toBe(s.n);
    });

    test("balloon truth rises at roughly the commanded rate; floater stays level", () => {
        const riser = generateScenario(baseSpec({
            durationSeconds: 30,
            target: {kind: "party-rising", family: "balloon", parameters: {startAGL: 300, ascentRate: 3}},
            wind: {kind: "zero"},
        }), {scenarioSeed: 101});
        const zEnd = riser.target.positionENU[(riser.n - 1) * 3 + 2];
        expect(zEnd - 300).toBeGreaterThan(75);   // ~90 m expected over 30 s
        expect(zEnd - 300).toBeLessThan(105);

        const floater = generateScenario(baseSpec({wind: {kind: "zero"}}), {scenarioSeed: 101});
        const z0 = floater.target.positionENU[2];
        const z1 = floater.target.positionENU[(floater.n - 1) * 3 + 2];
        expect(Math.abs(z1 - z0)).toBeLessThan(1);
    });

    test("impulse anomaly changes velocity by the declared delta-v; control stays capped", () => {
        const mk = (anomalous) => baseSpec({
            initialHorizontalRangeM: 20000,
            target: {kind: "anomalous", family: "anomalous",
                parameters: {tupleId: "impulse-east", anomalous}},
            observation: {kind: "clean", fovFullDeg: 60},
        });
        const a = generateScenario(mk(true), {scenarioSeed: 401});
        const dt = 1 / a.fps;
        const vAt = (s, f) => (s.target.positionENU[(f + 1) * 3] - s.target.positionENU[f * 3]) / dt;
        // before onset (5 s): 120 m/s east; after: 270.
        expect(vAt(a, 30)).toBeCloseTo(120, 0);
        expect(vAt(a, 70)).toBeCloseTo(270, 0);

        const c = generateScenario(mk(false), {scenarioSeed: 401});
        // control delta-v capped at 2.5g * 2s / 2 = 24.5 m/s
        expect(vAt(c, 90)).toBeCloseTo(120 + 24.5, 0);
    });

    test("venus truth is a unit direction series that drifts over 120 s", () => {
        const s = generateScenario(baseSpec({
            durationSeconds: 120,
            target: {kind: "venus", family: "venus", parameters: {}},
            observation: {kind: "clean", fovFullDeg: 0.5},
        }), {scenarioSeed: 101});
        expect(s.target.kind).toBe("direction");
        const d0 = s.target.directionENU.slice(0, 3);
        const d1 = s.target.directionENU.slice((s.n - 1) * 3, (s.n - 1) * 3 + 3);
        expect(Math.hypot(...d0)).toBeCloseTo(1, 9);
        expect(Math.hypot(...d1)).toBeCloseTo(1, 9);
        const dot = Math.min(1, d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]);
        const driftDeg = Math.acos(dot) * 180 / Math.PI;
        expect(driftDeg).toBeGreaterThan(0.1);   // sidereal drift is real
        expect(driftDeg).toBeLessThan(2);
    });

    test("adapters: LOS/Traverse views alias buffers; active adapter compacts", () => {
        const s = generateScenario(baseSpec({
            observation: {kind: "white", fovFullDeg: 0.06, gaussianSigmaDeg: 0.03},
        }), {scenarioSeed: 101});
        const los = toLOSDataset(s);
        expect(los.sensorPos).toBe(s.platform.positionENU);
        expect(los.losDir).toBe(s.observation.observedDirectionENU);
        expect(los.count).toBe(s.n);
        const trav = toTraverseDataset(s, {los: "clean"});
        expect(trav.D).toBe(s.observation.cleanDirectionENU);
        const act = toActiveTraverseDataset(s);
        expect(act.dataset.n).toBe(s.n - s.observation.outOfFrameCount);
        expect(act.frameIndices.length).toBe(act.dataset.n);
        for (let i = 1; i < act.frameIndices.length; i++) {
            expect(act.frameIndices[i]).toBeGreaterThan(act.frameIndices[i - 1]);
        }
    });

    test("conditioning diagnostic separates orbit from straight flight", () => {
        const orbit = generateScenario(baseSpec({durationSeconds: 60}), {scenarioSeed: 101});
        const straight = generateScenario(baseSpec({
            durationSeconds: 60,
            platform: {kind: "straight", speedMS: 70, altitudeAGL: 3000},
        }), {scenarioSeed: 101});
        expect(orbit.diagnostics.cvDesignRcondObserved)
            .toBeGreaterThan(10 * straight.diagnostics.cvDesignRcondObserved);
    });

    test("seed hygiene: deriveSeed never returns 0 and streams are independent", () => {
        expect(deriveSeed("", 0, "", "")).not.toBe(0);
        const s1 = makeStream(deriveSeed("k", 1, "platform", "1"));
        const s2 = makeStream(deriveSeed("k", 1, "target", "1"));
        expect(s1.seed).not.toBe(s2.seed);
        // canonical() sorts keys: object key order must not change hashes
        expect(canonical({a: 1, b: 2})).toBe(canonical({b: 2, a: 1}));
    });

    test("a collapsed on-sensor estimate is counted, flagged, and scores 180 deg", () => {
        const s = generateScenario(baseSpec(), {scenarioSeed: 101});
        // Fabricate the pathological estimate: the sensor path itself.
        const est = {kind: "track", positions: s.platform.positionENU.slice(),
            parameterSummary: {}};
        const m = computeMetrics(s, est);
        expect(m.estimateSummary.onSensorFraction).toBe(1);
        expect(m.failureFlags.collapsedOnSensor).toBe(true);
        // Residuals are DEFINED (180 deg convention, matching meanAngularError), never null — so the run
        // participates in anomaly AUC pools as a non-detection.
        expect(m.metrics.angular.observedMeanDeg).toBeCloseTo(180, 6);
    });

    test("non-finite estimate frames stay excluded — never scored as a 180 deg collapse", () => {
        const s = generateScenario(baseSpec(), {scenarioSeed: 101});
        const positions = s.platform.positionENU.slice();
        // Frames 0..half-1: NaN garbage. Frames half..n-1: genuine on-sensor collapse.
        const half = Math.floor(s.n / 2);
        for (let f = 0; f < half; f++) positions[f * 3] = NaN;
        const m = computeMetrics(s, {kind: "track", positions, parameterSummary: {}});
        expect(m.failureFlags.nonFinite).toBe(true);
        // onSensorFraction counts only FINITE frames (all of which sit on the sensor)
        expect(m.estimateSummary.onSensorFraction).toBe(1);
        // Residual mean comes only from the collapsed (180 deg) frames — the NaN
        // frames are excluded, not converted into valid residuals.
        expect(m.metrics.angular.observedMeanDeg).toBeCloseTo(180, 6);
        expect(m.estimateSummary.finiteFrameFraction).toBeCloseTo(1 - half / s.n, 9);
    });

    test("every site exists and HAB altitude clears mountain ground", () => {
        expect(Object.keys(SITES).sort()).toEqual(
            ["central-valley", "cheyenne-mountain", "denver", "flat-reference", "ocean"]);
        // The default is on LAND and above sea level. An over-water default
        // gave every generated scene nothing to look at when opened — no
        // terrain to judge a track against, no imagery to judge scale by.
        expect(SITES[DEFAULT_SITE]).toBeDefined();
        expect(SITES[DEFAULT_SITE].groundElevationMSL).toBeGreaterThan(0);
        const s = generateScenario(baseSpec({
            siteId: "cheyenne-mountain",
            initialHorizontalRangeM: 20000,
            durationSeconds: 15,
            target: {kind: "hab-stable", family: "balloon",
                parameters: {startAGL: 19000 - 2900}},
            wind: {kind: "hab-steady"},
        }), {scenarioSeed: 501});
        expect(s.target.positionENU[2]).toBeCloseTo(19000 - 2900, 0);
    });
});
