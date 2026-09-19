import {angularSizeRankingCheck, physicalClassChecks} from "../src/TraverseMundaneness";
import {angularSizeFitCost, compileAngularSizeFit, remapAngularSize} from "../src/AngularSize";
import {fitPhysicsModel} from "../src/LOSFitting";
import {PhysicsModel} from "../src/PhysicsModel";
import {trackMetrics} from "../src/TraverseAnalysis";
import {rankAllHypotheses} from "../src/TraverseRanking";
import {unitOptions, selectionKey} from "../src/analysis/BotBenchSolvers";

const n = 11;
const path = speed => Float64Array.from(Array.from({length: n}, (_, f) => [100 + f * speed, 0, 0]).flat());
const data = () => ({n, fps: 1, S: new Float64Array(n * 3),
    D: Float64Array.from(Array.from({length: n}, () => [1, 0, 0]).flat()), W: new Float64Array(n * 3)});
const angle = range => 2 * Math.atan(1 / (2 * range)) * 180 / Math.PI;

test("size judging changes order without changing BOT, LOS or truth-blind results", () => {
    const ds = {...data(), angularSize: {relative: [{frame: 10, referenceFrame: 0, minRatio: .49, maxRatio: .51}]}};
    const make = (name, speed) => ({key: "quadcopter", name, track: path(speed), errDeg: .02,
        metricsFull: trackMetrics(ds, path(speed)), params: {}});
    const hs = [make("Flat range", 0), make("Double range", 10)];
    const before = rankAllHypotheses(hs, {dataset: ds, useTruth: false});
    expect(before[0].h.name).toBe("Flat range");
    ds.angularSizeOptions = {judge: true, constantProjectedSize: true};
    const after = rankAllHypotheses(hs, {dataset: ds, useTruth: false});
    expect(after[0].h.name).toBe("Double range");
    expect(after[1].r.angularSize.status).toBe("conflict");
    expect(after[1].r.coLeader).not.toBe(true);
    for (const x of after) expect(x.r.secondaryScore).toBe(before.find(y => y.h === x.h).r.secondaryScore);
    hs[0].truthComparison = {comparable: true, score: 0};
    expect(rankAllHypotheses(hs, {dataset: ds, useTruth: false})[0].h.name).toBe("Double range");
    ds.angularSizeOptions.constantProjectedSize = false;
    expect(rankAllHypotheses(hs, {dataset: ds, useTruth: false})[0].h.name).toBe("Flat range");
});

test("compiled optimizer loss matches the independent reporting calculation", () => {
    const ds = {...data(), angularSizeOptions: {fit: true, constantProjectedSize: true}, angularSize: {
        samples: [0, 5, 10].map(frame => ({frame, minDeg: .98 * angle(100 + frame * 10), maxDeg: 1.02 * angle(100 + frame * 10)})),
        relative: [{frame: 10, referenceFrame: 0, minRatio: .49, maxRatio: .51}]}};
    for (const speed of [-5, 0, 5, 10, 30]) {
        expect(compileAngularSizeFit(ds)(path(speed))).toBeCloseTo(angularSizeFitCost(ds, path(speed)), 8);
    }
    ds.angularSizeOptions.constantProjectedSize = false;
    expect(compileAngularSizeFit(ds)(path(0))).toBe(0);
});

class RadialModel extends PhysicsModel {
    maxDt = 1;
    getParameterDefs() { return [{name: "speed", min: -5, max: 30, default: 0, scale: 2}]; }
    getInitialState(p) { return [100, 0, 0, p[0], 0, 0]; }
}

test("size changes constrain a radial model even when LOS has no range information", async () => {
    const ds = data();
    const fitData = {sensorPos: ds.S, losDir: ds.D, count: n,
        times: Float64Array.from({length: n}, (_, f) => f),
        // The first measurement is AFTER frame zero: integration must still start at zero.
        angularSize: {samples: [5, 10].map(frame => ({frame,
            minDeg: .999 * angle(100 + 10 * frame), maxDeg: 1.001 * angle(100 + 10 * frame)}))}};
    const before = await fitPhysicsModel(fitData, new Set(), new RadialModel(), {maxIter: 180});
    fitData.angularSizeOptions = {fit: true, constantProjectedSize: true};
    const after = await fitPhysicsModel(fitData, new Set(), new RadialModel(), {maxIter: 180});
    expect(before.params.solved.speed).toBeLessThan(5);
    expect(after.params.solved.speed).toBeCloseTo(10, 0);
    expect(after.params.errDeg).toBeCloseTo(0, 8);
    expect(after.positions[30]).toBeCloseTo(100 + 10 * after.params.solved.speed, 6);
});

test("crop drops missing reference frames and never interpolates sparse samples", () => {
    const obs = {samples: [{frame: 2, minDeg: 1, maxDeg: 2}, {frame: 4, minDeg: 1, maxDeg: 2}],
        relative: [{frame: 4, referenceFrame: 0, minRatio: .5, maxRatio: 1.5}]};
    expect(remapAngularSize(obs, [2, 3, 4])).toMatchObject({samples: [
        {frame: 0, minDeg: 1, maxDeg: 2}, {frame: 2, minDeg: 1, maxDeg: 2}], relative: []});
});

test("judging reuses fits; fitting options separate cache entries", () => {
    const off = unitOptions("quadcopter", {});
    expect(unitOptions("quadcopter", {angularSizeOptions: {judge: true}})).toEqual(off);
    const fit = {angularSizeOptions: {judge: true, fit: true, constantProjectedSize: true}};
    expect(unitOptions("quadcopter", fit)).not.toEqual(off);
    expect(unitOptions("quadcopter", fit)).toEqual(unitOptions("quadcopter", {
        angularSizeOptions: {...fit.angularSizeOptions, judge: false}}));
    expect(selectionKey(["quadcopter"], fit)).not.toEqual(selectionKey(["quadcopter"], {}));
});

test("recorded upper bounds reject too-small class sizes only when judging is enabled", () => {
    const ds = {...data(), angularDiameterMaxDeg: .01, angularSize: {samples: [
        {frame: 0, minDeg: 0, maxDeg: .01}, {frame: 10, minDeg: 0, maxDeg: .02}]}};
    const track = path(10);
    const h = {key: "horizontalSpeed", name: "Near path", track, errDeg: .02, metricsFull: trackMetrics(ds, track)};
    const before = physicalClassChecks(ds, h);
    expect(before.sizeOff).toBe(true);
    expect(before.classes.some(c => c.compatible)).toBe(true);
    const scoreBefore = rankAllHypotheses([h], {dataset: ds})[0].r.secondaryScore;
    ds.angularSizeOptions = {judge: true, constantProjectedSize: false};
    const check = physicalClassChecks(ds, h);
    expect(check.angularSize.absoluteCount).toBe(2);
    expect(check.impliedM.lo).toBe(0);
    expect(check.classes.some(c => c.compatible)).toBe(false);
    expect(angularSizeRankingCheck(ds, h).status).toBe("conflict");
    expect(rankAllHypotheses([h], {dataset: ds})[0].r.secondaryScore).toBe(scoreBefore);
    expect(h.errDeg).toBe(.02);
});
