/** @jest-environment jsdom */
jest.mock("../../src/gpu/MonteCarloLOS", () => ({fitMonteCarloGPU: jest.fn()}));

import fixture from "../fixtures/monteCarloWheel.json";
import {setSit} from "../../src/Globals";
import {fitMonteCarloGPU} from "../../src/gpu/MonteCarloLOS";
import {fitMonteCarloReference, MONTE_CARLO_PRESETS} from "../../src/MonteCarloLOS";
import {fitBotBenchRecord, cacheableBotBenchBattery, searchBackendOf} from "../../src/analysis/BotBenchFit";
import {packForCache, unpackFromCache} from "../../src/analysis/BotBenchCacheCodec";
import {rowMemoStorable} from "../../src/analysis/BotBenchSolvers";
import {hypothesisCategory} from "../../src/TraverseRanking";
import {fitConstantAcceleration, fitConstantVelocity} from "../../src/LOSFitting";
import {openBotBenchDialog} from "../../src/analysis/BotBenchUI";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";

const d = fixture.dataset;
const record = {kind: "bot", dataset: {n: d.count, fps: 1.2,
    S: Float64Array.from(d.sensorPos), D: Float64Array.from(d.losDir), W: new Float64Array(d.count * 3)},
    losSamples: {times: Float64Array.from(d.times), maxRange: new Float64Array(d.count).fill(8000)},
    originLat: 0.5, originLon: -1, groundZ: 0, meta: {}};

beforeEach(() => {
    setSit({name: "botbench", frames: d.count, fps: 1.2, simSpeed: 1});
    fitMonteCarloGPU.mockReset().mockImplementation(async (dataset, excluded, options) => {
        const result = fitMonteCarloReference(dataset, excluded, {numTrials: 30});
        return {...result, params: {...result.params, ...MONTE_CARLO_PRESETS[options.preset], backend: "webgpu"}};
    });
});

test("GPU search starts enabled in the BOTBench dialog", () => {
    const state = openBotBenchDialog();
    expect(state.gpuSearchInput.checked).toBe(true);
    state.closeButton.onclick();
});

test("the BOTBench results dialog leaves wheel scrolling native", () => {
    const state = openBotBenchDialog();
    expect(state.overlay.dataset.interactionNative).toBe("true");
    state.closeButton.onclick();
});

test("BOT ingestion keeps each retained observation's time and range cap", () => {
    const lines = ["TrackID,TrackSource,Time,SensorPositionX,SensorPositionY,SensorPositionZ,LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ,MaxRange"];
    for (let i = 0; i < 15; i++) lines.push(`test,synthetic,${i},${i * 10},0,1000,0,${i < 2 ? 0 : 1},0,${i === 5 ? -1 : 100 + i}`);
    const ingested = ingestBotCSV(lines.join("\n"));
    expect(ingested.dataset.n).toBe(13);
    expect(Array.from(ingested.losSamples.times)).toEqual(Array.from({length: 13}, (_, i) => i + 2));
    expect(Array.from(ingested.losSamples.maxRange)).toEqual(Array.from({length: 13}, (_, i) => i === 3 ? -1 : 102 + i));
});

test("selected presets alone produce separate curve-fit candidates and replay exactly from cache", async () => {
    const solvers = ["mc_50k", "mc_250k", "mc_1M"];
    const fresh = await fitBotBenchRecord(record, {solvers});
    expect(Object.keys(fresh.units)).toEqual(solvers);
    expect(fresh.hypotheses.map(h => h.key)).toEqual(solvers);
    expect(fitMonteCarloGPU).toHaveBeenCalledTimes(3);
    expect(fitMonteCarloGPU.mock.calls[0][0]).toMatchObject(record.losSamples);
    expect(searchBackendOf(fresh)).toBe("webgpu");
    for (const h of fresh.hypotheses) {
        expect(hypothesisCategory(h).key).toBe("approximation");
        expect(h.params.mcPreset).toBe(h.key);
        expect(h.params.mcOrder).toBeUndefined();
        expect(h.applyContext).toBeDefined();
        expect(fresh.units[h.key].cacheable).toBe(true);
        expect(fresh.units[h.key].result.params.timing).toBeUndefined();
    }
    const cached = unpackFromCache(packForCache(fresh.units));
    fitMonteCarloGPU.mockClear();
    const replay = await fitBotBenchRecord(record, {solvers, units: {cached}});
    expect(fitMonteCarloGPU).not.toHaveBeenCalled();
    expect(packForCache(cacheableBotBenchBattery(replay)))
        .toEqual(packForCache(cacheableBotBenchBattery(fresh)));
});

test("direct CV and CA use the observation clock and range limits and replay from cache", async () => {
    const solvers = ["gfCV", "gfCA"];
    const fresh = await fitBotBenchRecord(record, {solvers});
    expect(Object.keys(fresh.units)).toEqual(solvers);
    expect(fresh.hypotheses.map(h => h.key)).toEqual(solvers);

    const directDataset = {
        sensorPos: record.dataset.S,
        losDir: record.dataset.D,
        count: record.dataset.n,
        ...record.losSamples,
    };
    const expectedCV = fitConstantVelocity(directDataset, new Set());
    const expectedCA = fitConstantAcceleration(directDataset, new Set());
    expect(Array.from(fresh.units.gfCV.result.positions)).toEqual(Array.from(expectedCV.positions));
    expect(Array.from(fresh.units.gfCA.result.positions)).toEqual(Array.from(expectedCA.positions));
    expect(fresh.hypotheses[0].params.methodLabel).toBe("Global Fit: Constant Velocity");
    expect(fresh.hypotheses[1].params.methodLabel).toBe("Global Fit: Const Acceleration");

    const cached = unpackFromCache(packForCache(fresh.units));
    const replay = await fitBotBenchRecord(record, {solvers, units: {cached}});
    expect(replay.units).toEqual({});
    expect(packForCache(cacheableBotBenchBattery(replay)))
        .toEqual(packForCache(cacheableBotBenchBattery(fresh)));
});

test("an unavailable preset reports its failure and cannot poison unit or row caches", async () => {
    fitMonteCarloGPU.mockRejectedValue(new Error("WebGPU unavailable"));
    const fitted = await fitBotBenchRecord(record, {solvers: ["mc_1M"]});
    expect(fitted.hypotheses).toEqual([]);
    expect(fitted.units.mc_1M.cacheable).toBe(false);
    expect(fitted.missingGpuSolvers).toEqual(["mc_1M"]);
    expect(fitted.failures).toContainEqual({method: "Monte Carlo 1M (GPU)", error: "WebGPU unavailable"});
    expect(rowMemoStorable({}, fitted)).toBe(false);
});

test("cancellation propagates out of the battery instead of becoming a missing solver", async () => {
    fitMonteCarloGPU.mockRejectedValue(new Error("cancelled"));
    await expect(fitBotBenchRecord(record, {solvers: ["mc_50k"]})).rejects.toThrow("cancelled");
});
