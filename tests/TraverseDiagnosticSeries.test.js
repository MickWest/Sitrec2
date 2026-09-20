import {losErrorSeriesDeg, truthDiagnosticSeries} from "../src/TraverseDiagnosticSeries";
import {datasetWithConstantWind} from "../src/TraverseWind";
import {trackMetrics} from "../src/TraverseAnalysis";
import {airMotionRows, candidateAirMetrics} from "../src/TraverseAirMotion";

function risingBalloon() {
    const n = 120, fps = 10;
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps, p = [-0.909 * t, 100 + 1.959 * t, 1000 + 2.86 * t];
        track.set(p, f * 3);
        D.set(p.map(v => v / Math.hypot(...p)), f * 3);
    }
    return {dataset: datasetWithConstantWind({n, fps, S, D}, -0.909, 1.959),
        truth: {usable: true, track, valid: new Uint8Array(n).fill(1)}};
}

test("a passively drifting balloon separates horizontal drift from vertical air speed", () => {
    const {dataset, truth} = risingBalloon();
    const series = truthDiagnosticSeries(dataset, truth);
    expect(series.horizontalAirSpeed[60]).toBeCloseTo(0, 8);
    expect(series.verticalAirSpeed[60]).toBeCloseTo(2.86, 8);
    expect(series.gLoad[60]).toBeLessThan(1e-10);
    expect(series.losError[60]).toBeLessThan(1e-5);
    const differentWind = truthDiagnosticSeries(datasetWithConstantWind(dataset, 0, 5), truth);
    expect(differentWind.horizontalAirSpeed[60]).toBeCloseTo(Math.hypot(-0.909, 1.959 - 5), 8);
    expect(differentWind.verticalAirSpeed[60]).toEqual(series.verticalAirSpeed[60]);
});

test("vertical air speed subtracts vertical wind and preserves descending signs", () => {
    const {dataset, truth} = risingBalloon();
    for (let f = 0; f < dataset.n; f++) dataset.W[f * 3 + 2] = 4 / dataset.fps;
    const metrics = trackMetrics(dataset, truth.track);
    expect(metrics.verticalSpeed.mean).toBeGreaterThan(0); // ascending over the ground
    expect(metrics.verticalAirSpeed.mean).toBeCloseTo(-1.14, 8); // descending through rising air
    expect(metrics.series.verticalAirSpeed[60]).toBeCloseTo(-1.14, 8);
    expect(truthDiagnosticSeries(dataset, truth).verticalAirSpeed[60]).toBeCloseTo(-1.14, 8);
    expect(airMotionRows(dataset, {track: truth.track, metricsFull: metrics})[1][1]).toBe("-224 fpm / -224 to -224 fpm");
});

test("ground-frame and older cached results display the supplied-wind air components", () => {
    const {dataset, truth} = risingBalloon();
    const metricsFull = trackMetrics(datasetWithConstantWind(dataset, 0, 0), truth.track);
    const groundFit = {track: truth.track, metricsFull, params: {motionFrame: "ground"}};
    const air = candidateAirMetrics(dataset, groundFit);
    expect(air.horizontalAirSpeed.mean).toBeCloseTo(0, 8);
    expect(air.verticalAirSpeed.mean).toBeCloseTo(2.86, 8);
    expect(metricsFull.horizontalAirSpeed.mean).toBeGreaterThan(2); // original fit left intact
    const oldFit = {track: truth.track, metricsFull: {airSpeed: metricsFull.airSpeed, series: {}}};
    expect(airMotionRows(dataset, oldFit)).toEqual(airMotionRows(dataset, groundFit));
    expect(candidateAirMetrics(dataset, {...groundFit, atInfinity: true})).toBeNull();
    expect(airMotionRows(null, {})).toEqual([
        ["Horizontal air speed (mean / max)", "Unavailable"],
        ["Vertical air speed (mean / range)", "Unavailable"],
    ]);
});

test.each(["fitted", "corrected"])("component display uses the %s candidate wind", windMode => {
    const {dataset, truth} = risingBalloon();
    const h = {key: "lantern", windMode, track: truth.track,
        params: {windE: 0, windN: 5, windCorrectionE: 0.909, windCorrectionN: 5 - 1.959}};
    const air = candidateAirMetrics(dataset, h);
    expect(air.horizontalAirSpeed.mean).toBeCloseTo(Math.hypot(-0.909, 1.959 - 5), 8);
    expect(air.verticalAirSpeed.mean).toBeCloseTo(2.86, 8);
});

test("truth derivatives do not bridge gaps or turn held endpoints into motion evidence", () => {
    const {dataset, truth} = risingBalloon();
    truth.valid.fill(0, 0, 10);
    truth.valid.fill(0, 50, 70);
    truth.valid.fill(0, 110);
    const series = truthDiagnosticSeries(dataset, truth);
    expect(series.verticalAirSpeed[30]).toBeCloseTo(2.86, 8);
    expect(series.verticalAirSpeed[90]).toBeCloseTo(2.86, 8);
    for (const f of [0, 9, 10, 49, 50, 60, 70, 109, 110, 119]) {
        expect(Number.isNaN(series.horizontalAirSpeed[f])).toBe(true);
        expect(Number.isNaN(series.verticalAirSpeed[f])).toBe(true);
        expect(Number.isNaN(series.gLoad[f])).toBe(true);
    }
    expect(Number.isNaN(series.losError[60])).toBe(true);
    expect(series.losError[10]).toBeLessThan(1e-5);
    expect(truthDiagnosticSeries(dataset, null)).toBeNull();
});

test("LOS truth is compared with observed bearings, retaining observation error", () => {
    const {dataset, truth} = risingBalloon();
    const f = 60, b = f * 3, a = 0.02 * Math.PI / 180;
    const y = dataset.D[b + 1], z = dataset.D[b + 2];
    dataset.D[b + 1] = y * Math.cos(a) - z * Math.sin(a);
    dataset.D[b + 2] = y * Math.sin(a) + z * Math.cos(a);
    expect(losErrorSeriesDeg(dataset, truth.track)[f]).toBeCloseTo(0.02, 5);
});
