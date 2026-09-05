import {BotBenchAnalysisPool} from "../../src/analysis/BotBenchAnalysisPool";
import {runBotBenchAnalysis} from "../../src/analysis/BotBenchRunner";
import {Globals} from "../../src/Globals";

jest.mock("../../src/analysis/BotBenchRunner", () => ({runBotBenchAnalysis: jest.fn()}));

const originalWorker = global.Worker;
afterEach(() => { global.Worker = originalWorker; jest.clearAllMocks(); });

test("worker receives only fitting inputs and the current Earth model, then uses the shared result builder", async () => {
    const workers = [];
    global.Worker = jest.fn(() => {
        const worker = {postMessage: jest.fn(), terminate: jest.fn()};
        workers.push(worker); return worker;
    });
    const record = {dataset: {n: 10}, originLat: 40, originLon: -105, groundZ: 0,
        kind: 'bot', clipStartMs: 123, meta: {maxRangeM: 10000}, truth: {answer: 1}, labels: {answer: 2}};
    runBotBenchAnalysis.mockResolvedValue({row: 'built'});
    const pool = new BotBenchAnalysisPool(1);
    const result = pool.run(record, {anchorM: 9000, solutionFamilies: true});
    workers[0].onmessage({data: {ready: true}});
    const sent = workers[0].postMessage.mock.calls[0][0];
    expect(sent.record.truth).toBeUndefined();
    expect(sent.record.labels).toBeUndefined();
    expect(sent.record.meta.maxRangeM).toBe(10000);
    expect(sent.earthRadii).toEqual({equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius});
    expect(sent.options).toEqual({anchorM: 9000, solutionFamilies: true});
    workers[0].onmessage({data: {id: sent.id, battery: {fitted: true}, elapsedMs: 1234}});
    expect(await result).toEqual({row: 'built'});
    expect(runBotBenchAnalysis).toHaveBeenCalledWith(record, expect.objectContaining({
        battery: {fitted: true}, fitElapsedMs: 1234, anchorM: 9000, solutionFamilies: true,
    }));
    pool.dispose();
});

test("blocked workers fall back one fit at a time and disposal prevents queued fallback work", async () => {
    global.Worker = jest.fn(() => { throw new Error('blocked'); });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let finish;
    runBotBenchAnalysis.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pool = new BotBenchAnalysisPool(2);
    const results = Promise.allSettled([pool.run({id: 1}), pool.run({id: 2})]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(runBotBenchAnalysis).toHaveBeenCalledTimes(1);
    pool.dispose();
    finish('first');
    const settled = await results;
    expect(settled.filter(r => r.status === 'fulfilled').map(r => r.value)).toEqual(['first']);
    expect(settled.filter(r => r.status === 'rejected').map(r => r.reason.message)).toEqual(['cancelled']);
    expect(runBotBenchAnalysis).toHaveBeenCalledTimes(1);
    warning.mockRestore();
});
