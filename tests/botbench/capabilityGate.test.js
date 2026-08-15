/**
 * capabilityGate.test.js — ENFORCES the S2 stop gate in CI.
 *
 * The emerging-threats S2 range-family detector has a known range-pinning
 * degeneracy (the smoothness valley pins the shortest range, not the truth),
 * so its positive "measured" exceedance is unsound pending a parallax-based
 * redesign. This test makes the disable structural, not advisory: it fails if
 * S2_POSITIVE_ENABLED is true, and asserts that no exceedance lower bound is
 * ever emitted while it is false — even on a target that genuinely exceeds its
 * envelope by 2x at strong geometry. That guarantees no broken positive
 * verdict can reach the bench summary, pilot calibration, or the paper.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {rangeFamilyExceedance, capabilityVerdict, isValidCalibration,
    measureCapability, applyCapabilityCalibration,
    S2_POSITIVE_ENABLED, CAPABILITY_THRESHOLD_CALIBRATED} from "../../benchmarks/botbench/lib/capabilityDetect";
import {resolveDetectorConfig, configKey} from "../../benchmarks/botbench/lib/envelopeFeasibility";

beforeAll(() => setSit({name: "cap-gate", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105}));

describe("capability S2 stop gate", () => {
    test("S2 positive exceedance path is DISABLED pending the parallax redesign", () => {
        // If this fails, someone enabled S2 without the range-pinning redesign.
        expect(S2_POSITIVE_ENABLED).toBe(false);
    });

    test("no exceedance lower bound is emitted while the gate is closed", () => {
        // A genuine 2x speed exceedance at strong geometry — exactly the case
        // that would tempt a positive verdict. All LBs must stay null.
        const scenario = generateScenario({
            durationSeconds: 60, fps: 10, initialHorizontalRangeM: 2000,
            siteId: "flat-reference",
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "capability", family: "quad",
                parameters: {dimension: "quad-speed", catalogId: "air3", lambda: 2.0}},
            wind: {kind: "zero"}, observation: {kind: "clean", fovFullDeg: 0.9},
        }, {scenarioSeed: 701});
        const s2 = rangeFamilyExceedance(scenario, "quad", "air3");
        expect(s2.verdict).toBe("held-pending-redesign");
        expect(s2.speedExceedanceLB).toBeNull();
        expect(s2.climbExceedanceLB).toBeNull();
        expect(s2.gExceedanceLB).toBeNull();
        expect(s2.decisive).toBe(false);
        // the raw valley diagnostic is still recorded (for the redesign), but
        // it is not a verdict.
        expect(typeof s2.decisiveByValley).toBe("boolean");
    });

    test("NO untrusted exceedance value survives ANYWHERE in the S2 output while closed", () => {
        // The per-range margins are the untrusted numbers (e.g. the spurious
        // weak-geometry +234%). While the gate is closed they must be absent
        // from the exported object entirely — a deep scan of the whole result
        // must find no *MarginFrac / *ExceedanceLB / horizSpeed field with a
        // non-null value.
        const scenario = generateScenario({
            durationSeconds: 15, fps: 10, initialHorizontalRangeM: 20000,   // weak: worst offender
            siteId: "flat-reference",
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "capability", family: "quad",
                parameters: {dimension: "quad-speed", catalogId: "air3", lambda: 2.0}},
            wind: {kind: "zero"}, observation: {kind: "clean", fovFullDeg: 0.9},
        }, {scenarioSeed: 701});
        const s2 = rangeFamilyExceedance(scenario, "quad", "air3");

        const offenders = [];
        const scan = (obj, pathStr) => {
            if (obj === null || typeof obj !== "object") return;
            for (const [k, v] of Object.entries(obj)) {
                const p = `${pathStr}.${k}`;
                if (/margin|exceedance|horizspeed/i.test(k) && v !== null && v !== undefined) {
                    offenders.push(`${p}=${v}`);
                }
                scan(v, p);
            }
        };
        scan(s2, "s2");
        expect(offenders).toEqual([]);
        // per-range entries carry only rangeM + plausScore for the redesign.
        for (const p of s2.perRange) {
            expect(Object.keys(p).sort()).toEqual(["plausScore", "rangeM"]);
        }
    });
});

describe("capability α̂ claim gate (fail-closed)", () => {
    jest.setTimeout(300000);

    test("no calibration artifact exists in the repo yet", () => {
        expect(CAPABILITY_THRESHOLD_CALIBRATED).toBe(false);
    });

    test("isValidCalibration is fail-closed and CONFIG-BOUND", () => {
        const key = configKey(resolveDetectorConfig({}));
        const good = {alphaThreshold: 1.15, family: "quad", catalogId: "air3",
            nControls: 25, provenance: "pilot-2026-07-23", detectorConfigKey: key};
        expect(isValidCalibration(good, "quad", "air3", key)).toBe(true);
        // every degradation must fail closed:
        expect(isValidCalibration(null, "quad", "air3", key)).toBe(false);
        expect(isValidCalibration({...good, alphaThreshold: undefined}, "quad", "air3", key)).toBe(false);
        expect(isValidCalibration({...good, provenance: ""}, "quad", "air3", key)).toBe(false);
        expect(isValidCalibration({...good, nControls: 5}, "quad", "air3", key)).toBe(false);
        expect(isValidCalibration(good, "quad", "mavic3", key)).toBe(false);   // wrong catalog
        expect(isValidCalibration(good, "fixedwing", "air3", key)).toBe(false); // wrong family
        // CONFIG BINDING: artifact without the key, or with a different key,
        // or run under a different config, must fail closed.
        expect(isValidCalibration({...good, detectorConfigKey: undefined}, "quad", "air3", key)).toBe(false);
        expect(isValidCalibration({...good, detectorConfigKey: "some-other-config"}, "quad", "air3", key)).toBe(false);
        const otherKey = configKey(resolveDetectorConfig({bandwidthSec: 5}));
        expect(isValidCalibration(good, "quad", "air3", otherKey)).toBe(false);
    });

    test("no binary claim without a valid artifact — even on a genuine 2x exceedance (α̂ well above 1)", async () => {
        const scenario = generateScenario({
            durationSeconds: 60, fps: 10, initialHorizontalRangeM: 2000,
            siteId: "flat-reference",
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {kind: "capability", family: "quad",
                parameters: {dimension: "quad-speed", catalogId: "air3", lambda: 2.0}},
            wind: {kind: "zero"}, observation: {kind: "clean", fovFullDeg: 0.9},
        }, {scenarioSeed: 701});

        // All four cases below ask the SAME question of the same scenario and differ only in
        // the calibration artifact, which the measurement does not depend on. Measuring once
        // and gating four times is therefore the identical test at a quarter of the solve
        // cost — four multi-seed Nelder-Mead searches become one. It also makes the point
        // sharper: every case now provably shares one α̂, so any difference in the verdicts
        // is attributable to the artifact and nothing else.
        const {feas, runningKey: measuredKey} = await measureCapability(scenario, "quad", "air3");
        const gateWith = (calibration) =>
            applyCapabilityCalibration(feas, "quad", "air3", measuredKey, calibration);

        // default: no calibration passed => measurement only
        const v = gateWith(null);
        expect(v.calibrated).toBe(false);
        expect(v.exceedanceForced).toBeNull();
        expect(v.claimStatus).toBe("uncalibrated-measurement");
        expect(v.alphaStarIsUpperBound).toBe(true);

        const runningKey = v.detectorConfigKey;
        expect(typeof runningKey).toBe("string");

        // a MALFORMED calibration (no provenance) must also fail closed
        const vBad = gateWith({alphaThreshold: 1.1, family: "quad", catalogId: "air3",
            nControls: 25, detectorConfigKey: runningKey});
        expect(vBad.exceedanceForced).toBeNull();

        // a CONFIG-MISMATCHED artifact (right shape, wrong config key) fails closed
        const vMismatch = gateWith({alphaThreshold: 1.1, family: "quad", catalogId: "air3",
            nControls: 25, provenance: "x", detectorConfigKey: "wrong-config-key"});
        expect(vMismatch.calibrated).toBe(false);
        expect(vMismatch.exceedanceForced).toBeNull();

        // a VALID, CONFIG-BOUND artifact opens the gate — proving the disable is
        // the gate, not a dead code path (synthetic artifact for the test only).
        const vGood = gateWith({alphaThreshold: 1.1, family: "quad", catalogId: "air3",
            nControls: 25, provenance: "unit-test-synthetic", detectorConfigKey: runningKey});
        expect(vGood.calibrated).toBe(true);
        expect(typeof vGood.exceedanceForced).toBe("boolean");
        expect(vGood.calibrationProvenance).toBe("unit-test-synthetic");
    });
});
