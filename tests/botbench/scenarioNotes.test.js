/**
 * buildScenarioNotes — the prose that travels with a file handoff and lands in
 * the sitch Notes panel (src/analysis/BotBenchIngest.js).
 *
 * WHY THIS EXISTS. Opening a BOT scenario in Sitrec gives you tracks and
 * nothing else: the declared pointing error, the frame datum, the wind and the
 * provenance seal all live in JSON sidecars the app's importer has no route
 * for. The notes carry what those sidecars say.
 *
 * The property that MUST hold is the blinding one. An answers file may state
 * its answer — its truth track is drawn in the scene, so withholding the
 * number describing it would be theatre — but a CHALLENGE file has no answer
 * to state, and must not acquire one. These build both from the same scenario
 * sidecar, differing only in whether the truth sidecar is supplied, and check
 * that the answer appears in exactly one of them.
 *
 * The fixtures are inline rather than read from
 * benchmarks/botbench/results/, which is generated output and gitignored: a
 * test that read it would pass locally and fail in CI.
 */

import {buildScenarioNotes} from "../../src/analysis/BotBenchIngest";

const SCENARIO = {
    specVersion: "1.1",
    trackId: "orbitpoint-70ms-3000m_r2km_60s-2fps_anom-real-hover_white0p03deg_s901",
    frame: {
        type: "ENU", originLLA: [35, -125, 0], ellipsoid: "WGS84",
        surfaceModel: "flat-plane", groundElevationMSL: 0,
    },
    epochISO: "2025-02-01T20:00:00Z",
    nominalFps: 2, frameCount: 121, durationSeconds: 60,
    losError: {
        model: "white", sigmaDeg: 0.03, correlated: false,
        note: "per-axis 1-sigma in the pan/tilt tangent plane",
    },
    wind: null,
    sensor: {fovFullDeg: 0.5},
    seal: {inputCsvSha256: "526858530b6e689cf30c8133d780617c8e57ad16eb5e8ced3aad752c051613cb"},
};

// The generating spec holds initialHorizontalRangeM — the answer to the
// question the analysis is asked — which is precisely what must not reach a
// challenge file's notes.
const TRUTH = {
    truthKind: "position", objectClass: "real", targetKind: "real-segment",
    anomalous: true,
    events: [{eventId: "hover-impulse", family: "impulse", anomalous: true, onsetSeconds: 30}],
    geometry: {sensorSpanM: 3613.6, losSweepDeg: 24.828, cvConditioningBucket: "well-posed"},
    realizedNoise: {meanDeg: 0.037045},
    provenance: {
        generator: "botbench", generatorVersion: "1.1",
        scenarioId: "bb-66aa1e34", scenarioSeed: 901,
        spec: {
            initialHorizontalRangeM: 2000,
            platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
            target: {
                kind: "real-segment", family: "real",
                parameters: {label: "hover", source: {file: "drone_px4_36634f3e.csv", rule: "offset"}},
            },
        },
    },
};

// The matched control of a pair: the same splice machinery at zero magnitude.
const TRUTH_CONTROL = {
    ...TRUTH,
    anomalous: false,
    events: [{eventId: "hover-impulse-control", family: "impulse", anomalous: false,
        onsetSeconds: 30, parameters: {spliced: false}}],
};

describe("buildScenarioNotes", () => {
    test("an answers file states what the object was and what was declared", () => {
        const notes = buildScenarioNotes(SCENARIO, TRUTH, "x.all.csv");
        expect(notes).toContain("hover (real, drone_px4_36634f3e)");
        expect(notes).toContain("orbits the target, 70 m/s, 3000 m");
        expect(notes).toContain("impulse @ 30s");
        expect(notes).toContain("DECLARED ANOMALOUS");
        expect(notes).toContain("ANSWER KEY");
        expect(notes).toContain("2000 m");
        // Provenance a reader can use to check the file is the one a published
        // result was quoted against.
        expect(notes).toContain("seed 901");
        expect(notes).toContain("526858530b6e");
    });

    test("a CHALLENGE file gets no answer key at all", () => {
        // Same scenario sidecar, no truth sidecar — the published-challenge case.
        const notes = buildScenarioNotes(SCENARIO, null, "x.input.csv");
        expect(notes).not.toContain("ANSWER KEY");
        expect(notes).not.toContain("Initial horizontal range");
        expect(notes).not.toContain("2000 m");
        // None of the structured target description survives either.
        expect(notes).not.toContain("Target:");
        expect(notes).not.toContain("Platform:");
        expect(notes).not.toContain("DECLARED ANOMALOUS");
        expect(notes).not.toContain("real-segment");
        expect(notes).not.toContain("drone_px4");

        // It still says everything about the MEASUREMENT, which is the half a
        // challenge file is entitled to and the half that is otherwise lost.
        expect(notes).toContain("121 samples");
        expect(notes).toContain("0.03");
        expect(notes).toContain("2025-02-01T20:00:00Z");
    });

    test("the trackId is quoted verbatim, and is its own leak channel", () => {
        // NOT a property of these notes to fix, and recorded here so nobody
        // mistakes the blinding above for more than it is. The generated
        // scenario names encode the target and the range — this fixture's
        // trackId contains both "anom-real-hover" and, in the real set, "r2km".
        // The header quotes the identifier because a reader has to be able to
        // tell which file they are looking at, and the app titles every
        // imported track by its filename regardless. A challenge set that
        // needs to be blind must be blind in its FILENAMES; nothing downstream
        // can restore that once it is lost.
        const notes = buildScenarioNotes(SCENARIO, null, "x.input.csv");
        expect(notes).toContain(SCENARIO.trackId);
        expect(SCENARIO.trackId).toContain("hover");
    });

    test("white noise gets a residual floor; a wobble deadband explicitly does not", () => {
        const white = buildScenarioNotes(SCENARIO, TRUTH, "x.all.csv");
        // sigma * sqrt(pi/2) at sigma = 0.03. Quoting sigma itself, or
        // sigma*sqrt(2), would tell a reader the wrong thing about their fit.
        expect(white).toContain("0.0376");

        const wobble = buildScenarioNotes({
            ...SCENARIO,
            losError: {model: "correlated", sigmaDeg: 0.15, correlated: true,
                note: "sigmaDeg is the deadband amplitude, NOT a white 1-sigma."},
        }, TRUTH, "x.all.csv");
        expect(wobble).toContain("deadband AMPLITUDE");
        expect(wobble).toContain("does not convert to a residual floor");
        // 0.15 * 1.2533 = 0.188. It must not appear: the Rayleigh relation does
        // not hold for a deadband, so quoting a floor would be a fabrication.
        expect(wobble).not.toContain("0.188");
    });

    test("a sham splice is labelled as one, so a control cannot read as anomalous", () => {
        const notes = buildScenarioNotes(SCENARIO, TRUTH_CONTROL, "x.all.csv");
        expect(notes).toContain("sham impulse @ 30s (matched control)");
        expect(notes).not.toContain("DECLARED ANOMALOUS");
    });

    test("a missing scenario sidecar degrades rather than throws", () => {
        // FMV and third-party files reach this with nothing at all.
        expect(() => buildScenarioNotes(null, null, "whatever.csv")).not.toThrow();
        expect(buildScenarioNotes(null, null, "whatever.csv")).toContain("whatever.csv");
    });
});
