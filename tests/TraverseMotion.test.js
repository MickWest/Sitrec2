import {accelerationPeaks} from "../src/TraverseMotion";

test("acceleration peaks exclude trimmed ends and separate neighbouring maxima in time", () => {
    const gLoad = new Float64Array(100);
    for (const [f, g] of [[0, 100], [20, 5], [23, 4.9], [50, 4], [80, 3], [99, 100]]) gLoad[f] = g;
    const peaks = accelerationPeaks({series: {gLoad}, sampleWindow: {lo: 5, hi: 95, frameOffset: 200}}, 10);
    expect(peaks).toEqual([{frame: 220, value: 5}, {frame: 250, value: 4}, {frame: 280, value: 3}]);
});

test("a flat peak supplies one label at its midpoint", () => {
    expect(accelerationPeaks({series: {gLoad: [0, 1, 3, 3, 3, 1, 0]}}, 1))
        .toEqual([{frame: 3, value: 3}]);
    expect(accelerationPeaks({series: {gLoad: [2, 2, 2, 2, 2]}}, 1))
        .toEqual([{frame: 2, value: 2}]);
});

test("missing, invalid and zero acceleration samples do not invent peaks", () => {
    expect(accelerationPeaks(null, 30)).toEqual([]);
    expect(accelerationPeaks({series: {gLoad: [NaN, 0, Infinity, 0]}}, 30)).toEqual([]);
});
