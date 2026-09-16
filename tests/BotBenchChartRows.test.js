// BotBenchChartRows.test.js — the rows the result charts read, built from a run.
//
// The first case is the failure that prompted this file. A user chose a scenario
// set's All folder on its own, which leaves the sidecars behind in the sibling
// meta folder. 300 tracks were analysed and scored, and the chart window drew
// nothing: the adapter had looked for the clip length only in the folder name and
// the sidecar, when every row already carried it.

import {
    rowsFromBotBenchEntries, rowsFromJsonl, apertureFromPositions, classOf, classCorrectFor, filterRowsToSolvers,
    batchDurationSeconds,
} from "../src/analysis/charts/BotBenchChartRows";

function entry({name, relativePath = name, sidecar = null, labels = null, quality = {}, row = {}, results = null}) {
    return {
        name, relativePath,
        sidecarText: sidecar,
        labelsText: labels ? JSON.stringify(labels) : null,
        row: {
            quality: {frames: 201, durationS: 20, declaredLosSigmaDeg: null, ...quality},
            viableClasses: ["balloon"],
            truthScore: {topRelSep: 0.01, bestRelSep: 0.005, meanTruthRangeM: 5000},
            top: {key: "lantern", name: "Sky Lantern / Balloon"},
            verdictCode: "consistent-one",
            ...row,
        },
        results,
    };
}

describe("a run over an All folder chosen on its own, with no sidecars", () => {
    const rows = rowsFromBotBenchEntries([
        entry({name: "balloon_001.all.csv"}),
        entry({name: "weather_balloon_002.all.csv", row: {viableClasses: ["fixedWing"]}}),
        entry({name: "drone_003.all.csv", row: {viableClasses: []}}),
    ]);

    test("the clip length comes from the run itself", () => {
        for (const r of rows) expect(r.d_durationSeconds).toBe(20);
    });
    test("the batch duration stays unknown when no batch folder was scanned", () => {
        for (const r of rows) expect(r.d_batchDurationSeconds).toBeNull();
    });
    test("the pointing-error rung is honestly unknown, not guessed", () => {
        for (const r of rows) expect(r.d_errorDeg).toBeNull();
    });
    test("the class comes from the file name", () => {
        expect(rows.map((r) => r.d_class)).toEqual(["balloon", "weather_balloon", "drone"]);
    });
    test("the class outcome is still judged, against the class the name implies", () => {
        // balloon viable for a balloon: right. fixedWing viable for a weather balloon: wrong.
        // nothing viable for a drone: not the true class.
        expect(rows.map((r) => r.d_classCorrect)).toEqual([true, false, false]);
    });
    test("each row records that no sidecar was paired", () => {
        for (const r of rows) expect(r.in_sidecarPaired).toBe(false);
    });
    test("a file-name path with no folder gives no set, rather than the file name", () => {
        for (const r of rows) expect(r.set).toBeNull();
    });
});

describe("where the length and rung come from when they are available", () => {
    test("the folder names win", () => {
        const [r] = rowsFromBotBenchEntries([entry({
            name: "drone_001.all.csv", relativePath: "batch_120sec/0.2deg/All/drone_001.all.csv",
            quality: {durationS: 120},
        })]);
        expect(r.d_durationSeconds).toBe(120);
        expect(r.d_batchDurationSeconds).toBe(120);
        expect(r.d_errorDeg).toBe(0.2);
        expect(r.set).toBe("batch_120sec");
        expect(r.path).toBe("batch_120sec/0.2deg/All/drone_001.all.csv");
    });
    test("a declared sigma of exactly zero is the clean rung, not a missing one", () => {
        const [r] = rowsFromBotBenchEntries([entry({
            name: "balloon_001.all.csv", relativePath: "All/balloon_001.all.csv",
            sidecar: "{}", quality: {declaredLosSigmaDeg: 0},
        })]);
        expect(r.d_errorDeg).toBe(0);
        expect(r.in_sidecarPaired).toBe(true);
    });
    test("floating-point noise in the measured length does not split one length into two", () => {
        const [r] = rowsFromBotBenchEntries([entry({name: "balloon_001.all.csv", quality: {durationS: 19.999999997}})]);
        expect(r.d_durationSeconds).toBe(20);
    });
    test("the answer key's class beats the file name", () => {
        expect(classOf("balloon_001", {targetKind: "weather-rising", objectClass: "balloon"})).toBe("weather_balloon");
        expect(classOf("anything", {targetKind: "drone-circle", objectClass: "drone"})).toBe("drone");
    });
    test("a name that is not a known class gives null, never a guess", () => {
        expect(classOf("bot-0001", null)).toBeNull();
        expect(classOf("track_07", null)).toBeNull();
        expect(classCorrectFor(null, null, ["balloon"])).toBeNull();
    });
});

describe("the parallax aperture", () => {
    test("is the angle at the mid-clip target between the first and last sensor positions", () => {
        const S = [-1000, 0, 0, 0, 0, 0, 1000, 0, 0];
        const T = [0, 1000, 0, 0, 1000, 0, 0, 1000, 0];
        expect(apertureFromPositions(S, T)).toBeCloseTo(90, 9);
    });
    test("uses only frames with a valid truth position", () => {
        // Frame 0 is invalid, so the first sensor position used is frame 1 at the
        // origin, directly below the target: a 45-degree aperture, not 90.
        const S = [-1000, 0, 0, 0, 0, 0, 1000, 0, 0];
        const T = [9e9, 9e9, 9e9, 0, 1000, 0, 0, 1000, 0];
        expect(apertureFromPositions(S, T, [0, 1, 1])).toBeCloseTo(45, 9);
    });
    test("gives null rather than a number it cannot stand behind", () => {
        expect(apertureFromPositions(null, [0, 0, 0])).toBeNull();
        expect(apertureFromPositions([0, 0, 0], [0, 1, 0])).toBeNull();            // one frame
        expect(apertureFromPositions([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0])).toBeNull(); // zero length
    });
    test("is measured from the run's positions, and is never the sidecar's sweep angle", () => {
        const withPositions = entry({
            name: "balloon_001.all.csv",
            results: {dataset: {S: [-1000, 0, 0, 1000, 0, 0]}, truth: {track: [0, 1000, 0, 0, 1000, 0], valid: null}},
        });
        const sweepOnly = entry({name: "balloon_002.all.csv", labels: {geometry: {losSweepDeg: 14}}});
        const [a, b] = rowsFromBotBenchEntries([withPositions, sweepOnly]);
        expect(a.in_apertureDeg).toBeCloseTo(90, 9);
        expect(b.in_apertureDeg).toBeNull();
    });
});

describe("rowsFromJsonl", () => {
    test("drops the header line and survives a bad line", () => {
        const text = [JSON.stringify({header: true}), JSON.stringify({base: "a"}), "{not json", "",
            JSON.stringify({base: "b"})].join("\n");
        expect(rowsFromJsonl(text).map((r) => r.base)).toEqual(["a", "b"]);
    });
    test("derives the batch duration from current and older folder names", () => {
        const rows = rowsFromJsonl([
            JSON.stringify({base: "a", path: "rock_v3/batch_240sec/0.2deg/All/a.all.csv"}),
            JSON.stringify({base: "b", batch: "batch_60s"}),
            JSON.stringify({base: "c", set: "batch_40sec"}),
        ].join("\n"));
        expect(rows.map((r) => r.d_batchDurationSeconds)).toEqual([240, 60, 40]);
        expect(batchDurationSeconds({path: "batch_120sec/All/a.csv"})).toBe(120);
        expect(batchDurationSeconds({path: "All/a.csv"})).toBeNull();
    });
});

describe("every candidate's error, for the solver figure", () => {
    const {candidateErrorsFrom} = require("../src/analysis/charts/BotBenchChartRows");
    const hypothesis = (key, name, truthComparison) => ({key, name, truthComparison});

    test("lists each comparable candidate's error in metres and over the mean true range", () => {
        const errors = candidateErrorsFrom({hypotheses: [
            hypothesis("lantern", "Sky Lantern / Balloon", {comparable: true, score: 50, meanTruthRange: 5000}),
            hypothesis("constAlt", "Constant Altitude", {comparable: true, score: 500, meanTruthRange: 5000}),
        ]});
        expect(errors).toEqual([
            {key: "lantern", name: "Sky Lantern / Balloon", relSep: 0.01, sepM: 50, angDeg: null, losDeg: null,
                headingDeg: null, velocityMS: null, blindRank: null, rangeBlind: false},
            {key: "constAlt", name: "Constant Altitude", relSep: 0.1, sepM: 500, angDeg: null, losDeg: null,
                headingDeg: null, velocityMS: null, blindRank: null, rangeBlind: false},
        ]);
    });
    test("with positions and a frame rate, adds the heading and velocity errors", () => {
        // Truth goes east at 10 m/s for four frames at 10 Hz; three candidates.
        const fps = 10;
        const truth = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0];
        const north = [0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0];          // north at 10 m/s
        const fast = [0, 0, 0, 1.2, 0, 0, 2.4, 0, 0, 3.6, 0, 0];      // east at 12 m/s
        const still = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];           // does not move
        const comparison = {comparable: true, score: 1, meanTruthRange: 1000};
        const errors = candidateErrorsFrom({
            dataset: {S: new Array(12).fill(0), fps}, truth: {track: truth, valid: null},
            hypotheses: [
                {key: "a", name: "North", track: north, truthComparison: comparison},
                {key: "b", name: "Fast", track: fast, truthComparison: comparison},
                {key: "c", name: "Still", track: still, truthComparison: comparison},
            ],
        });
        expect(errors[0].headingDeg).toBeCloseTo(90, 9);
        expect(errors[0].velocityMS).toBeCloseTo(Math.hypot(10, 10), 9);
        expect(errors[1].headingDeg).toBeCloseTo(0, 9);
        expect(errors[1].velocityMS).toBeCloseTo(2, 9);
        // A track that does not move has no heading, and its velocity error is the truth's speed.
        expect(errors[2].headingDeg).toBeNull();
        expect(errors[2].velocityMS).toBeCloseTo(10, 9);
    });
    test("the heading error wraps around north and skips frames the truth marks invalid", () => {
        const {meanMotionErrors} = require("../src/analysis/charts/BotBenchChartRows");
        // Truth heads 10 degrees east of north; the candidate 10 degrees west of north: 20 apart, not 340.
        const fps = 1, s = Math.sin(10 * Math.PI / 180), c = Math.cos(10 * Math.PI / 180);
        const truth = [0, 0, 0, s, c, 0, 2 * s, 2 * c, 0];
        const cand = [0, 0, 0, -s, c, 0, -2 * s, 2 * c, 0];
        expect(meanMotionErrors(cand, truth, null, fps).headingDeg).toBeCloseTo(20, 9);
        // With the middle frame invalid no pair of consecutive frames is valid, so nothing counts.
        expect(meanMotionErrors(cand, truth, [1, 0, 1], fps)).toEqual({headingDeg: null, velocityMS: null});
        // No frame rate, no motion.
        expect(meanMotionErrors(cand, truth, null, null)).toEqual({headingDeg: null, velocityMS: null});
    });
    test("with positions, adds the angle to truth and the sightline residual", () => {
        // Sensor at the origin, truth 1 km north, the candidate 1 km north and 100 m east.
        const [error] = candidateErrorsFrom({
            dataset: {S: [0, 0, 0, 0, 0, 0]},
            truth: {track: [0, 1000, 0, 0, 1000, 0], valid: null},
            hypotheses: [{key: "lantern", name: "Sky Lantern / Balloon", errDeg: 0.004,
                track: [100, 1000, 0, 100, 1000, 0],
                truthComparison: {comparable: true, score: 100, meanTruthRange: 1000}}],
        });
        expect(error.angDeg).toBeCloseTo(Math.atan2(100, 1000) * 180 / Math.PI, 9);
        expect(error.losDeg).toBe(0.004);
    });
    test("leaves out what the truth scoring did not count", () => {
        const errors = candidateErrorsFrom({hypotheses: [
            hypothesis("star", "Star", {comparable: false, note: "at infinity"}),
            hypothesis("ground", "Ground Object", {comparable: true, score: NaN, meanTruthRange: 5000}),
            hypothesis("fixedPoint", "Stationary Point in Space", null),
            hypothesis("quadcopter", "Quadcopter", {comparable: true, score: 100, meanTruthRange: 5000}),
        ]});
        expect(errors.map((e) => e.key)).toEqual(["quadcopter"]);
    });
    test("gives null when there is no analysis, or nothing in it was scored", () => {
        expect(candidateErrorsFrom(null)).toBeNull();
        expect(candidateErrorsFrom({hypotheses: []})).toBeNull();
    });
    test("a row takes the list kept on its entry, and carries the entry where JSON cannot see it", () => {
        const kept = [{key: "lantern", name: "Sky Lantern / Balloon", relSep: 0.002}];
        const source = entry({name: "balloon_001.all.csv"});
        source.candidateErrors = kept;
        const [row] = rowsFromBotBenchEntries([source]);
        expect(row.r_candidates).toBe(kept);
        expect(row.entry).toBe(source);
        expect(Object.keys(row)).not.toContain("entry");
        expect(JSON.stringify(row)).not.toContain("labelsText");
    });
});

describe("the Selected Solvers chart filter", () => {
    const row = {
        base: "drone_001",
        r_topKey: "lantern", r_topName: "Sky Lantern / Balloon", r_topRelSep: 0.4, r_topSepM: 400,
        r_bestName: "Constant Altitude", r_bestRelSep: 0.01, r_bestSepM: 10,
        r_candidates: [
            {key: "lantern", name: "Sky Lantern / Balloon", relSep: 0.4, sepM: 400,
                losDeg: 0.02, blindRank: 0, rangeBlind: false},
            {key: "constAlt", name: "Constant Altitude", relSep: 0.01, sepM: 10,
                losDeg: 0.03, blindRank: 2, rangeBlind: false},
            {key: "gfKalman", name: "Global Fit: Kalman Smoother", relSep: 0.08, sepM: 80,
                losDeg: 0.001, blindRank: 1, rangeBlind: true},
        ],
    };

    test("removes unselected candidates and recalculates top and best within the subset", () => {
        const [filtered] = filterRowsToSolvers([row], ["constAlt", "gfKalman"]);
        expect(filtered.r_candidates.map((candidate) => candidate.key)).toEqual(["constAlt", "gfKalman"]);
        expect([filtered.r_topKey, filtered.r_topName, filtered.r_topRelSep, filtered.r_topSepM])
            .toEqual(["gfKalman", "Global Fit: Kalman Smoother", 0.08, 80]);
        expect(filtered.r_topBlind).toBe(1);
        expect([filtered.r_bestName, filtered.r_bestRelSep, filtered.r_bestSepM])
            .toEqual(["Constant Altitude", 0.01, 10]);
        expect(row.r_candidates).toHaveLength(3);
    });

    test("does not invent a new blind ranking for old chart data", () => {
        const old = {...row, r_topKey: "lantern", r_candidates: row.r_candidates.map(({blindRank, ...candidate}) => candidate)};
        const [kept] = filterRowsToSolvers([old], ["lantern", "constAlt"]);
        expect(kept.r_topKey).toBe("lantern");
        const [unknown] = filterRowsToSolvers([old], ["constAlt"]);
        expect(unknown.r_topKey).toBeNull();
        expect(unknown.r_bestName).toBe("Constant Altitude");
    });
});

describe("how far the sensor turned", () => {
    const {sensorTurnFromPositions} = require("../src/analysis/charts/BotBenchChartRows");

    test("a straight path does not turn", () => {
        const S = [];
        for (let f = 0; f < 50; f++) S.push(f * 10.7, f * 3, 5000);
        expect(sensorTurnFromPositions(S)).toBeCloseTo(0, 9);
    });
    test("a quarter circle turns 90 degrees", () => {
        const S = [];
        for (let i = 0; i <= 1000; i++) {
            const a = (i / 1000) * Math.PI / 2;
            S.push(2000 * Math.sin(a), 2000 * Math.cos(a), 5000);
        }
        expect(sensorTurnFromPositions(S)).toBeCloseTo(90, 0);
    });
    test("turning one way and then back adds both turns", () => {
        const S = [0, 0, 5000];
        let x = 0, y = 0;
        const leg = (headingDeg, steps) => {
            for (let i = 0; i < steps; i++) {
                x += 10 * Math.sin(headingDeg * Math.PI / 180);
                y += 10 * Math.cos(headingDeg * Math.PI / 180);
                S.push(x, y, 5000);
            }
        };
        leg(0, 20);
        leg(30, 20);
        leg(0, 20);
        expect(sensorTurnFromPositions(S)).toBeCloseTo(60, 6);
    });
    test("a sensor that does not move gives no turn, rather than noise", () => {
        expect(sensorTurnFromPositions([5, 5, 5000, 5, 5, 5000, 5, 5, 5000])).toBeNull();
        expect(sensorTurnFromPositions(null)).toBeNull();
    });
});

describe("the extra facts a row carries for the charts", () => {
    test("straightness, the sensor turn kept on the entry, and both errors in metres", () => {
        const source = entry({
            name: "balloon_001.all.csv", quality: {straightness: 0.95},
            row: {truthScore: {topRelSep: 0.01, bestRelSep: 0.005, topSepM: 50, bestSepM: 25, meanTruthRangeM: 5000}},
        });
        source.sensorTurnDeg = 42;
        const [row] = rowsFromBotBenchEntries([source]);
        expect(row.q_straightness).toBe(0.95);
        expect(row.in_sensorTurnDeg).toBe(42);
        expect(row.r_topSepM).toBe(50);
        expect(row.r_bestSepM).toBe(25);
    });
});

describe("the sensor-turn level", () => {
    test("comes from the answer key's spec, and is unknown without one", () => {
        const withKey = entry({name: "balloon_001.all.csv", relativePath: "batch_20sec/0.2deg/All/balloon_001.all.csv",
            labels: {provenance: {spec: {platform: {kind: "centered-turn", turnDeg: 10}}}}});
        const without = entry({name: "drone_002.all.csv", relativePath: "batch_20sec/0.2deg/All/drone_002.all.csv"});
        const [a, b] = rowsFromBotBenchEntries([withKey, without]);
        expect([a.d_turnDeg, b.d_turnDeg]).toEqual([10, null]);
        expect([a.d_errorDeg, a.d_durationSeconds]).toEqual([0.2, 20]);
    });
});
