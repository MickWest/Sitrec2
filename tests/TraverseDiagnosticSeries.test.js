import {losErrorSeriesDeg, truthDiagnosticSeries} from "../src/TraverseDiagnosticSeries";
import {datasetWithConstantWind} from "../src/TraverseWind";

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

test("a passively drifting balloon has vertical air speed and larger 3D ground speed", () => {
    const {dataset, truth} = risingBalloon();
    const series = truthDiagnosticSeries(dataset, truth);
    expect(series.airSpeed[60]).toBeCloseTo(2.86, 8);
    expect(series.groundSpeed[60]).toBeCloseTo(Math.hypot(-0.909, 1.959, 2.86), 8);
    expect(series.gLoad[60]).toBeLessThan(1e-10);
    expect(series.losError[60]).toBeLessThan(1e-5);
    const differentWind = truthDiagnosticSeries(datasetWithConstantWind(dataset, 0, 5), truth);
    expect(differentWind.airSpeed[60]).toBeCloseTo(Math.hypot(-0.909, 1.959 - 5, 2.86), 8);
    expect(differentWind.groundSpeed[60]).toEqual(series.groundSpeed[60]);
});

test("truth derivatives do not bridge gaps or turn held endpoints into motion evidence", () => {
    const {dataset, truth} = risingBalloon();
    truth.valid.fill(0, 0, 10);
    truth.valid.fill(0, 50, 70);
    truth.valid.fill(0, 110);
    const series = truthDiagnosticSeries(dataset, truth);
    expect(series.airSpeed[30]).toBeCloseTo(2.86, 8);
    expect(series.airSpeed[90]).toBeCloseTo(2.86, 8);
    for (const f of [0, 9, 10, 49, 50, 60, 70, 109, 110, 119]) {
        expect(Number.isNaN(series.airSpeed[f])).toBe(true);
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
