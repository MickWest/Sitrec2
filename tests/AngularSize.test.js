import {angularExtentFactor, angularSizeFromUpperBounds, assessAngularSize, angularSizeFitCost, angularSizeFitEnabled,
    validateAngularSize} from "../src/AngularSize";

const dataset = ranges => ({n: ranges.length, fps: 1, S: new Float64Array(ranges.length * 3)});
const path = ranges => Float64Array.from(ranges.flatMap(r => [r, 0, 0]));
const angle = (d, r) => 2 * Math.atan(d / (2 * r)) * 180 / Math.PI;

test("one absolute angle determines implied size, not distance with unknown size", () => {
    const ds = {...dataset([100, 200]), angularSize: {samples: [{frame: 0, minDeg: 1, maxDeg: 1.1}]}};
    for (const ranges of [[100, 200], [1000, 2000]]) {
        const c = assessAngularSize(ds, {track: path(ranges)}, {constantProjectedSize: true});
        expect(c.status).toBe("compatible");
        expect(c.impliedM.lo).toBeCloseTo(ranges[0] * angularExtentFactor(1));
    }
});

test("endpoint size distinguishes range change but leaves global scale ambiguous", () => {
    const ds = {...dataset([100, 200]), angularSize: {samples: [100, 200].map((r, frame) =>
        ({frame, minDeg: angle(1, r) * .99, maxDeg: angle(1, r) * 1.01}))}};
    for (const ranges of [[100, 200], [1000, 2000]]) {
        expect(assessAngularSize(ds, {track: path(ranges)}, {constantProjectedSize: true}).status).toBe("compatible");
    }
    const h = {track: path([100, 100])};
    expect(assessAngularSize(ds, h).status).toBe("compatible");
    expect(assessAngularSize(ds, h, {constantProjectedSize: true}).status).toBe("conflict");
});

test("relative-only bounds require the explicit assumption, with inverse range ratio", () => {
    const ds = {...dataset([100, 100, 100]), angularSize: {relativeBound:
        {referenceFrame: 0, startFrame: 0, endFrame: 2, minRatio: .5, maxRatio: 1.5}}};
    expect(assessAngularSize(ds, {track: path([100, 300, 100])}).status).toBe("unavailable");
    expect(assessAngularSize(ds, {track: path([100, 200, 100])}, {constantProjectedSize: true}).status).toBe("compatible");
    expect(assessAngularSize(ds, {track: path([100, 300, 100])}, {constantProjectedSize: true}).status).toBe("conflict");
});

test("sparse observations do not fabricate intermediate measurements", () => {
    const ds = {...dataset([100, 100, 100]), angularSize: {relative:
        [{referenceFrame: 0, frame: 2, minRatio: .9, maxRatio: 1.1}]}};
    expect(assessAngularSize(ds, {track: path([100, 10000, 100])}, {constantProjectedSize: true}).status).toBe("compatible");
});

test("unresolved upper bounds stay one-sided and per-frame", () => {
    const obs = angularSizeFromUpperBounds([.002, NaN, .004], {fovFullDeg: 1, pixelsAcross: 1000});
    expect(obs.samples).toEqual([{frame: 0, minDeg: 0, maxDeg: .002}, {frame: 2, minDeg: 0, maxDeg: .004}]);
    expect(angularSizeFromUpperBounds([.002]).samples[0].minDeg).toBe(0);
});

test("missing and angular-only paths do not pass; malformed evidence is rejected", () => {
    const ds = {...dataset([100, 200]), angularSize: {samples: [{frame: 0, minDeg: 1, maxDeg: 2}]}};
    expect(assessAngularSize(ds, {track: path([NaN, 200])}).status).toBe("unavailable");
    expect(assessAngularSize(ds, {track: path([100, 200]), atInfinity: true}).status).toBe("unavailable");
    expect(() => validateAngularSize({samples: [{frame: 2, minDeg: 1, maxDeg: 2}]}, 2)).toThrow();
});

test("truth attachments have no effect; optional fit cost is zero when off", () => {
    const ds = {...dataset([100, 200]), angularSize: {relative: [{frame: 1, referenceFrame: 0, minRatio: .4, maxRatio: .6}]}};
    const h = {track: path([100, 100])};
    expect(assessAngularSize(ds, {...h, truthComparison: {score: 0}})).toEqual(assessAngularSize(ds, h));
    expect(angularSizeFitCost(ds, h.track)).toBe(0);
    ds.angularSizeOptions = {fit: true, constantProjectedSize: true};
    expect(angularSizeFitCost(ds, h.track)).toBeGreaterThan(0);
    expect(angularSizeFitCost(ds, path([100, 200]))).toBe(0);
});

test("changing projected size can reject the true path only under the optional assumption", () => {
    const ds = {...dataset([100, 100]), angularSize: {samples: [1, 2].map((d, frame) =>
        ({frame, minDeg: angle(d, 100) * .99, maxDeg: angle(d, 100) * 1.01}))}};
    const truth = {track: path([100, 100])};
    expect(assessAngularSize(ds, truth).status).toBe("compatible");
    expect(assessAngularSize(ds, truth, {constantProjectedSize: true}).status).toBe("conflict");
});

test("upper bounds alone with unknown diameter do not constrain range changes during fitting", () => {
    const ds = {...dataset([100, 200]), angularSize: angularSizeFromUpperBounds([1, 2]),
        angularSizeOptions: {fit: true, constantProjectedSize: true}};
    expect(angularSizeFitEnabled(ds)).toBe(false);
});
