// RockV3ChartSpecs.test.js — which figures a set of result rows can support.
//
// The sweep figures compare cells across pointing-error rungs or clip lengths. A
// run over one folder is a single cell, and it used to get no figure at all. These
// tests pin both halves: a single cell charts by target class, and a sweep never
// gets a by-class figure that would quietly pool its rungs together.

import {
    buildAllFigures, rungGroups, durationGroups, isSingleCell, cellDescription, rungLabel, CLASSES,
    figErrorByClass, figOutcomeByClass,
} from "../src/analysis/charts/RockV3ChartSpecs";
import {median} from "../src/analysis/charts/ChartStats";

// A small deterministic generator, so a failure reproduces.
function makeRows({perClass = 20, durations = [20], rungs = [null], sidecar = false} = {}) {
    let state = 12345;
    const rand = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
    const rows = [];
    for (const d of durations) {
        for (const e of rungs) {
            for (const cls of CLASSES) {
                for (let i = 0; i < perClass; i++) {
                    const rel = Math.pow(10, -3 + 2.5 * rand());
                    rows.push({
                        base: `${cls}_${String(i + 1).padStart(3, "0")}`,
                        d_class: cls, d_durationSeconds: d, d_errorDeg: e,
                        d_classCorrect: rand() > 0.3,
                        r_viable: rand() > 0.2 ? "balloon+multirotor" : "",
                        r_topRelSep: rel, r_bestRelSep: rel / (1 + rand()),
                        r_topBlind: rand() > 0.9 ? 1 : 0,
                        r_verdict: rand() > 0.5 ? "consistent-several" : "unresolved",
                        r_topKey: rand() > 0.5 ? "lantern" : "quadcopter",
                        r_topName: "Sky Lantern / Balloon",
                        in_apertureDeg: 5 + 50 * rand(), in_trueRangeMeanM: 2000 + 20000 * rand(),
                        in_sidecarPaired: sidecar,
                    });
                }
            }
        }
    }
    return rows;
}

const keysOf = (rows) => buildAllFigures(rows).filter((f) => !f.error).map((f) => f.key);
const BY_CLASS = ["errorByClass", "withinByClass", "outcomeByClass", "verdictByClass", "topCandidateByClass"];
const SWEEP_ONLY = ["errorByLength", "errorByRung", "withinByRung", "withinByLength", "classOutcome",
    "verdictMix", "topCandidateMix"];

describe("one cell with the pointing error unknown: the All-folder run", () => {
    const rows = makeRows();

    test("it now draws figures", () => {
        const keys = keysOf(rows);
        for (const key of BY_CLASS) expect(keys).toContain(key);
        expect(keys).toContain("rankingCost");
        expect(keys).toContain("errorVsGeometry");
    });
    test("and not the sweep figures, which would compare nothing", () => {
        const keys = keysOf(rows);
        for (const key of SWEEP_ONLY) expect(keys).not.toContain(key);
    });
    test("the box medians are the medians of each class's values", () => {
        const figure = figErrorByClass(rows);
        for (const cls of CLASSES) {
            const values = rows.filter((r) => r.d_class === cls).map((r) => r.r_topRelSep);
            expect(figure.stats[cls]).toBeCloseTo(median(values), 12);
        }
    });
    test("the boxes are drawn from precomputed statistics, not recomputed by Plotly", () => {
        const box = figErrorByClass(rows).data.find((trace) => trace.type === "box");
        expect(box.q1).toHaveLength(1);
        expect(box.median).toHaveLength(1);
        expect(box.lowerfence).toHaveLength(1);
        expect(box.y).toBeUndefined();
    });
    test("the caption says the pointing error is unstated, and why", () => {
        const caption = figErrorByClass(rows).layout.annotations.at(-1).text;
        expect(caption).toContain("unstated");
        expect(caption).toContain("sidecar");
    });
    test("the panels that group by rung label the unknown rung plainly", () => {
        const ranking = buildAllFigures(rows).find((f) => f.key === "rankingCost");
        expect(ranking.layout.annotations.some((a) => String(a.text).includes("unstated"))).toBe(true);
        expect(rungLabel(null)).toBe("unstated");
    });
});

describe("one cell with the pointing error known", () => {
    const rows = makeRows({rungs: [0.2], sidecar: true});
    test("the same figures, described by their rung", () => {
        const keys = keysOf(rows);
        for (const key of BY_CLASS) expect(keys).toContain(key);
        expect(cellDescription(rows)).toBe("20 s clips, 0.2° pointing error");
        expect(figErrorByClass(rows).layout.annotations.at(-1).text).not.toContain("unstated");
    });
});

describe("a sweep", () => {
    const rows = makeRows({rungs: [0, 0.2], durations: [20, 120], perClass: 8, sidecar: true});
    test("gets the sweep figures and no by-class figure", () => {
        const keys = keysOf(rows);
        expect(isSingleCell(rows)).toBe(false);
        for (const key of BY_CLASS) expect(keys).not.toContain(key);
        for (const key of ["errorByLength", "errorByRung", "withinByRung", "withinByLength", "classOutcome"]) {
            expect(keys).toContain(key);
        }
    });
});

describe("a sweep of the pointing-error ladder at one clip length", () => {
    // The run that prompted durationGroups: 40 s clips at nine rungs drew two
    // figures, because every rung figure asked only for 20 s and 120 s clips.
    const rows = makeRows({rungs: [0, 0.01, 0.1, 0.2, 1.0], durations: [40], perClass: 6, sidecar: true});

    test("gets the rung figures, one panel row for the length the rows carry", () => {
        const keys = keysOf(rows);
        for (const key of ["errorByRung", "withinByRung", "classOutcome", "verdictMix", "topCandidateMix"]) {
            expect(keys).toContain(key);
        }
        const figure = buildAllFigures(rows).find((f) => f.key === "errorByRung");
        expect(figure.layout.annotations.some((a) => String(a.text).includes("40 s clips"))).toBe(true);
    });
    test("and no figure that compares clip lengths, which needs two", () => {
        const keys = keysOf(rows);
        expect(keys).not.toContain("errorByLength");
        expect(keys).not.toContain("withinByLength");
    });
});

describe("durationGroups", () => {
    const at = (d) => [{d_durationSeconds: d}];
    test("the lengths asked for, when present", () => {
        expect(durationGroups([...at(20), ...at(40), ...at(120)], [20, 120])).toEqual([20, 120]);
    });
    test("otherwise the first two lengths the rows carry", () => {
        expect(durationGroups([...at(60), ...at(40), ...at(300)], [20, 120])).toEqual([40, 60]);
    });
    test("and none when no row carries a length", () => {
        expect(durationGroups([{d_durationSeconds: null}], [20, 120])).toEqual([]);
    });
});

describe("rungGroups", () => {
    const at = (rung) => [{d_errorDeg: rung}];
    test("the rungs asked for, when present", () => {
        expect(rungGroups([...at(0), ...at(0.2), ...at(0.5)], [0, 0.2])).toEqual([0, 0.2]);
    });
    test("otherwise whichever rungs the rows carry", () => {
        expect(rungGroups(at(0.5), [0, 0.2])).toEqual([0.5]);
    });
    test("and one pooled group when no row carries a rung", () => {
        expect(rungGroups(at(null), [0, 0.2])).toEqual([null]);
        expect(rungGroups([], [0, 0.2])).toEqual([]);
    });
});

describe("the class outcome", () => {
    test("leaves out a track whose true class is unknown, instead of scoring it a miss", () => {
        const rows = makeRows({perClass: 10});
        rows.slice(0, 5).forEach((r) => { r.d_classCorrect = null; });
        const figure = figOutcomeByClass(rows);
        const counted = Object.values(figure.stats).reduce((sum, n) => sum + n, 0);
        expect(counted).toBe(rows.length - 5);
        expect(figure.layout.annotations.at(-1).text).toContain("left out");
    });
});

describe("whose error, and in what unit", () => {
    const {makeMeasure, figErrorByLength, figErrorBySolver, figWithinTolerance, ERROR_METRICS} =
        require("../src/analysis/charts/RockV3ChartSpecs");
    // Two candidates per track: the lantern is the one ranked first, the quadcopter the best.
    const rows = makeRows({rungs: [0, 0.2], durations: [20, 120], perClass: 6, sidecar: true}).map((r, i) => ({
        ...r,
        rowIndex: i,
        r_topSepM: r.r_topRelSep * 5000,
        r_bestSepM: r.r_bestRelSep * 5000,
        r_topName: "Sky Lantern / Balloon",
        r_bestName: "Quadcopter",
        r_candidates: [
            {key: "lantern", name: "Sky Lantern / Balloon", relSep: r.r_topRelSep, sepM: r.r_topRelSep * 5000,
                angDeg: 0.01 + i * 1e-4, losDeg: 0.02},
            {key: "quadcopter", name: "Quadcopter", relSep: r.r_bestRelSep, sepM: r.r_bestRelSep * 5000,
                angDeg: 0.005, losDeg: 0.03},
        ],
    }));
    const inCell = (cls, duration, rung) =>
        rows.filter((r) => r.d_class === cls && r.d_durationSeconds === duration && r.d_errorDeg === rung);

    test("the default measure draws the figures exactly as before", () => {
        const plain = figErrorByLength(rows);
        const explicit = figErrorByLength(rows, {measure: makeMeasure({metric: "relSep", subject: "top"})});
        expect(explicit.stats).toEqual(plain.stats);
        expect(plain.stats["0deg/balloon/20"]).toBeCloseTo(median(inCell("balloon", 20, 0).map((r) => r.r_topRelSep)), 12);
        expect(plain.layout.shapes.length).toBeGreaterThan(0);
    });
    test("a named solver's error is read from the candidate list", () => {
        const figure = figErrorByLength(rows, {measure: makeMeasure({subject: "Quadcopter"})});
        expect(figure.stats["0deg/balloon/20"]).toBeCloseTo(median(inCell("balloon", 20, 0).map((r) => r.r_bestRelSep)), 12);
        expect(figure.title).toContain("Quadcopter");
    });
    test("in metres the axis says so, the floor is a centimetre, and there is no 5% line", () => {
        const figure = figErrorByLength(rows, {measure: makeMeasure({metric: "sepM"})});
        expect(figure.layout.yaxis.title.text).toContain("(m)");
        expect(figure.layout.shapes ?? []).toHaveLength(0);
        const box = figure.data.find((t) => t.type === "box");
        expect(Math.min(...box.lowerfence)).toBeGreaterThanOrEqual(ERROR_METRICS.sepM.floor);
    });
    test("the top candidate's angle is the angle of the candidate the ranking put first", () => {
        const measure = makeMeasure({metric: "angDeg"});
        expect(measure.value(rows[3])).toBe(rows[3].r_candidates[0].angDeg);
        // The two motion units read the candidate list the same way, and say they need it.
        for (const [metric, field] of [["headingDeg", "headingDeg"], ["velocityMS", "velocityMS"]]) {
            const rowsWithMotion = rows.map((r) => ({...r, r_candidates: (r.r_candidates ?? []).map((c) =>
                ({...c, headingDeg: 12.5, velocityMS: 3.25}))}));
            const m = makeMeasure({metric});
            expect(m.needsLists).toBe(true);
            expect(m.value(rowsWithMotion[3])).toBe(rowsWithMotion[3].r_candidates[0][field]);
            expect(m.candidate({[field]: 7})).toBe(7);
            expect(m.ceiling).toBeGreaterThan(m.floor);
        }
        expect(ERROR_METRICS.velocityMS.format(3.25)).toBe("3.3 m/s");
        // The heading error is bounded, so it gets a fixed linear axis and no floor.
        const heading = makeMeasure({metric: "headingDeg"});
        expect(heading.axis).toEqual({type: "linear", range: [0, 180], dtick: 25});
        expect(heading.yRange(50)).toEqual([0, 180]);
        expect(heading.floorNote(3)).toBe("");
        expect(makeMeasure({metric: "sepM"}).axis).toBeNull();
        const headingRows = rows.map((r, i) => ({...r, r_candidates: (r.r_candidates ?? []).map((c) =>
            ({...c, headingDeg: 10 + (i % 7) * 20}))}));
        const byLength = figErrorByLength(headingRows, {measure: heading});
        expect(byLength.layout.yaxis).toMatchObject({type: "linear", range: [0, 180], dtick: 25});
        expect(byLength.layout.yaxis2).toMatchObject({type: "linear", range: [0, 180], dtick: 25});
        expect(byLength.layout.annotations.at(-1).text).toMatch(/on the values themselves/);
        expect(byLength.layout.annotations.at(-1).text).not.toMatch(/log10|drawn at the floor/);
        const box = byLength.data.find((tr) => tr.type === "box");
        expect(box.median.every((v) => v >= 0 && v <= 180)).toBe(true);
        const bySolver = figErrorBySolver(headingRows, {measure: heading});
        expect(bySolver.layout.yaxis).toMatchObject({type: "linear", range: [0, 180]});
        expect(ERROR_METRICS.velocityMS.format(250)).toBe("250 m/s");
        expect(makeMeasure({metric: "relSep"}).needsLists).toBe(false);
        expect(measure.best(rows[3])).toBe(0.005);
    });
    test("the tolerance figures keep a share of range, for whichever candidate is chosen", () => {
        const figure = figWithinTolerance(rows, {axis: "rung", measure: makeMeasure({metric: "sepM", subject: "Quadcopter"})});
        const expected = inCell("balloon", 20, 0).filter((r) => r.r_bestRelSep < 0.05).length;
        expect(figure.stats["20/5.0%/balloon"][0].k).toBe(expected);
    });
    test("the solver figure lists each solver once, and its dots carry their rows", () => {
        const figure = figErrorBySolver(rows);
        expect([...figure.stats.solvers].sort()).toEqual(["Quadcopter", "Sky Lantern / Balloon"]);
        const dots = figure.data.find((t) => t.type === "scattergl");
        expect(dots.customdata.every((id) => Number.isInteger(id))).toBe(true);
    });
    test("the registry hands the choice to every error figure, and to no other", () => {
        const measure = makeMeasure({metric: "sepM", subject: "Quadcopter"});
        const statsOf = (figures) => Object.fromEntries(figures.filter((f) => !f.error)
            .map((f) => [f.key, JSON.stringify(f.stats)]));
        const plain = statsOf(buildAllFigures(rows));
        const chosen = statsOf(buildAllFigures(rows, {measure}));
        const errorKeys = ["errorByLength", "errorByRung", "withinByLength", "withinByRung", "errorBySolver",
            "errorVsGeometry", "rankingCost"];
        expect(Object.keys(plain)).toEqual(expect.arrayContaining(["errorByLength", "withinByRung", "verdictMix"]));
        for (const key of Object.keys(plain)) {
            expect([key, plain[key] === chosen[key]]).toEqual([key, !errorKeys.includes(key)]);
        }
    });
    test("the solver figure draws a runaway value at the ceiling, counts it, and keeps it in the label", () => {
        // A client's Ground Object candidate reached 2.52e59 of the range, which stretched the axis to 1e59.
        const ceiling = ERROR_METRICS.relSep.ceiling;
        const wild = rows.map((r, i) => (i === 0 ? {...r, r_candidates: [...r.r_candidates,
            {key: "ground", name: "Ground Object", relSep: 2.52e59, sepM: 1e63, angDeg: 1, losDeg: 0.5}]} : r));
        const figure = figErrorBySolver(wild);
        expect(figure.layout.yaxis.range[1]).toBeLessThanOrEqual(Math.log10(ceiling * 2.2) + 1e-9);
        const dots = figure.data.filter((t) => t.type === "scattergl");
        expect(Math.max(...dots.flatMap((t) => t.y))).toBe(ceiling);
        expect(dots.flatMap((t) => t.text).some((label) => /2\.52e\+59, drawn at the ceiling/.test(label))).toBe(true);
        const boxes = figure.data.filter((t) => t.type === "box");
        expect(Math.max(...boxes.flatMap((t) => [...t.q3, ...t.upperfence]))).toBeLessThanOrEqual(ceiling);
        expect(figure.layout.annotations.at(-1).text.replace(/<br>/g, " "))
            .toContain("and 1 above a thousand times the mean true range at the ceiling");
        // a figure with nothing past the ceiling says nothing about it
        expect(figErrorBySolver(rows).layout.annotations.at(-1).text).not.toMatch(/ceiling/);
    });
    test("a dot's hover label names the file by its path under the scanned folder", () => {
        const withPath = rows.map((r) => ({...r, path: `batch_${r.d_durationSeconds}sec/${r.d_errorDeg}deg/All/${r.base}.all.csv`}));
        const lengthDots = figErrorByLength(withPath).data.filter((t) => t.type === "scattergl");
        expect(lengthDots.flatMap((t) => t.text).every((label) => /^batch_\d+sec\/[\d.]+deg\/All\/.+\.all\.csv$/.test(label))).toBe(true);
        const solverDots = figErrorBySolver(withPath).data.filter((t) => t.type === "scattergl");
        expect(solverDots.flatMap((t) => t.text).every((label) => /\.all\.csv · /.test(label))).toBe(true);
        // rows without a path, as from a JSONL file, keep the file name
        expect(figErrorByLength(rows).data.find((t) => t.type === "scattergl").text[0]).toBe(rows[0].base);
    });
});

describe("page furniture", () => {
    const rows = makeRows({rungs: [0, 0.2], durations: [20, 120], perClass: 6, sidecar: true});
    test("every legend sits under the panels, and every error axis is labelled in powers of ten", () => {
        for (const figure of buildAllFigures(rows).filter((f) => !f.error)) {
            const layout = figure.layout;
            if (layout.showlegend) {
                expect([figure.key, layout.legend.y < 0, layout.legend.yanchor]).toEqual([figure.key, true, "top"]);
            }
            for (const [name, axis] of Object.entries(layout)) {
                if (/^[xy]axis\d*$/.test(name) && axis?.type === "log" && /error/i.test(axis.title?.text ?? "")) {
                    expect([figure.key, name, axis.exponentformat]).toEqual([figure.key, name, "power"]);
                }
            }
        }
    });
});

describe("sensor-turn levels", () => {
    const {figErrorByTurn, figErrorByLength, turnLevelsOf} = require("../src/analysis/charts/RockV3ChartSpecs");
    // The same tracks at two turn levels, the straight clips ten times worse.
    const base = makeRows({rungs: [0, 0.2], durations: [20, 60, 120], perClass: 6, sidecar: true});
    const rows = [0, 20].flatMap((turn) => base.map((r) => ({...r, d_turnDeg: turn,
        r_topRelSep: turn === 0 ? r.r_topRelSep * 10 : r.r_topRelSep})));
    const inCell = (cls, duration, rung, turn) => rows.filter((r) => r.d_class === cls
        && r.d_durationSeconds === duration && r.d_errorDeg === rung && r.d_turnDeg === turn);

    test("one line per turn level along clip length, and one line per clip length along turn level", () => {
        expect(turnLevelsOf(rows)).toEqual([0, 20]);
        const byLength = figErrorByTurn(rows, {across: "length"});
        expect(byLength.key).toBe("errorByLengthAndTurn");
        expect(byLength.stats["0deg/balloon/0/60"])
            .toBeCloseTo(median(inCell("balloon", 60, 0, 0).map((r) => r.r_topRelSep)), 12);
        expect(byLength.stats["0deg/balloon/20/60"])
            .toBeCloseTo(median(inCell("balloon", 60, 0, 20).map((r) => r.r_topRelSep)), 12);
        // 2 rungs x 3 classes, two lines per panel, each line in the legend once
        expect(byLength.data).toHaveLength(12);
        expect(byLength.data.filter((t) => t.showlegend).map((t) => t.name)).toEqual(["0° turn", "20° turn"]);
        const byTurn = figErrorByTurn(rows, {across: "turn"});
        expect(byTurn.key).toBe("errorByTurn");
        expect(byTurn.data.filter((t) => t.showlegend).map((t) => t.name)).toEqual(["20 s clips", "60 s clips", "120 s clips"]);
    });

    test("needs two turn levels", () => {
        expect(figErrorByTurn(base.map((r) => ({...r, d_turnDeg: 5})))).toBeNull();
        expect(figErrorByTurn(base)).toBeNull();
    });

    test("one chosen turn level limits every other figure, and its title says so", () => {
        const figures = buildAllFigures(rows, {turnDeg: 20});
        const byLength = figures.find((f) => f.key === "errorByLength");
        expect(byLength.stats).toEqual(figErrorByLength(rows.filter((r) => r.d_turnDeg === 20)).stats);
        expect(byLength.title).toMatch(/sensor turn 20°$/);
        expect(byLength.layout.title.text).toMatch(/sensor turn 20°$/);
        const turns = figures.find((f) => f.key === "errorByLengthAndTurn");
        expect(turns.stats).toEqual(figErrorByTurn(rows).stats);
        expect(turns.title).not.toMatch(/sensor turn 20°$/);
        expect(buildAllFigures(rows).find((f) => f.key === "errorByLength").stats).toEqual(figErrorByLength(rows).stats);
    });
});

describe("dot marks: area by clip length, straight tracks as squares", () => {
    const {makeMarks, isStraightTrack, STRAIGHT_MARK_COLOR, figErrorByLength} = require("../src/analysis/charts/RockV3ChartSpecs");
    const base = makeRows({rungs: [0, 0.2], durations: [20, 120, 300], perClass: 6, sidecar: true});
    const rows = base.map((r, i) => ({...r, d_turnDeg: i % 2 === 0 ? 0 : 10}));
    const dotsOf = (figure) => figure.data.filter((t) => t.type === "scattergl");

    test("off by default: the dots are drawn exactly as before", () => {
        expect(figErrorByLength(rows, {marks: makeMarks({}, rows)}).data).toEqual(figErrorByLength(rows).data);
        const dot = dotsOf(figErrorByLength(rows))[0];
        expect(dot.marker.symbol).toBeUndefined();
        expect(typeof dot.marker.size).toBe("number");
    });

    test("straightness comes from the turn level, else from the measured sensor turn", () => {
        expect(isStraightTrack({d_turnDeg: 0})).toBe(true);
        expect(isStraightTrack({d_turnDeg: 5, in_sensorTurnDeg: 0})).toBe(false);
        expect(isStraightTrack({in_sensorTurnDeg: 0.4})).toBe(true);
        expect(isStraightTrack({in_sensorTurnDeg: 3})).toBe(false);
        expect(isStraightTrack({})).toBeNull();
    });

    test("straight tracks are black squares with the area of the circle they replace", () => {
        const marks = makeMarks({markStraight: true}, rows);
        const straight = marks.style({d_turnDeg: 0}, 5, "#2a78d6");
        const curved = marks.style({d_turnDeg: 10}, 5, "#2a78d6");
        expect(straight).toMatchObject({symbol: "square", color: STRAIGHT_MARK_COLOR});
        expect(curved).toEqual({size: 5, symbol: "circle", color: "#2a78d6"});
        expect(straight.size ** 2).toBeCloseTo(Math.PI * (curved.size / 2) ** 2, 9);
        const symbols = dotsOf(figErrorByLength(rows, {marks})).flatMap((t) => t.marker.symbol);
        expect(symbols).toContain("square");
        expect(symbols).toContain("circle");
    });

    test("area is in proportion to clip length, and the middle length keeps the figure size", () => {
        const marks = makeMarks({sizeByLength: true}, rows);
        const area = (seconds) => Math.PI * (marks.style({d_durationSeconds: seconds, d_turnDeg: 10}, 5, "#000").size / 2) ** 2;
        expect(area(300) / area(20)).toBeCloseTo(15, 9);
        expect(marks.style({d_durationSeconds: 120, d_turnDeg: 10}, 5, "#000").size).toBeCloseTo(5, 12);
        // a straight track's square has the area of a curved track's circle at the same length
        const both = makeMarks({sizeByLength: true, markStraight: true}, rows);
        expect(both.style({d_durationSeconds: 300, d_turnDeg: 0}, 5, "#000").size ** 2).toBeCloseTo(area(300), 9);
    });

    test("buildAllFigures marks the dot figures on one scale and says so in their captions only", () => {
        const figures = buildAllFigures(rows, {marks: {sizeByLength: true, markStraight: true}});
        const byLength = figures.find((f) => f.key === "errorByLength");
        expect(byLength.layout.annotations.at(-1).text.replace(/<br>/g, " "))
            .toMatch(/Black squares .* area in proportion to its clip length, from 20 s to 300 s/);
        const within = figures.find((f) => f.key === "withinByLength");
        expect(within.layout.annotations.at(-1).text).not.toMatch(/Black squares/);
    });
});
