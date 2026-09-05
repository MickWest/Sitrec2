import {BotBenchWorkerPool, botBenchConcurrency, runBotBenchQueue,
    transferableBuffers} from "../../src/analysis/BotBenchWorkerPool";

function fakeWorkers() {
    const workers = [];
    const createWorker = () => {
        const worker = {postMessage: jest.fn(), terminate: jest.fn()};
        workers.push(worker);
        return worker;
    };
    const ready = w => w.onmessage({data: {ready: true}});
    const finish = (w, battery) => w.onmessage({data: {
        id: w.postMessage.mock.calls.at(-1)[0].id, battery, elapsedMs: 123,
    }});
    return {workers, createWorker, ready, finish};
}

test("bounds active work and returns out-of-order results to the right caller", async () => {
    const f = fakeWorkers();
    const pool = new BotBenchWorkerPool({size: 2, createWorker: f.createWorker});
    const a = pool.run({label: 'a'}, {}, {});
    const b = pool.run({label: 'b'}, {}, {});
    const c = pool.run({label: 'c'}, {}, {});
    expect(f.workers).toHaveLength(2);
    f.workers.forEach(f.ready);
    expect(f.workers[0].postMessage.mock.calls[0][0].record.label).toBe('a');
    f.finish(f.workers[1], 'b-result');
    expect((await b).battery).toBe('b-result');
    expect(f.workers[1].postMessage.mock.calls[1][0].record.label).toBe('c');
    f.finish(f.workers[1], 'c-result');
    f.finish(f.workers[0], 'a-result');
    expect((await a).battery).toBe('a-result');
    expect((await c).battery).toBe('c-result');
    pool.dispose();
});

test("cancellation terminates active workers and rejects queued work", async () => {
    const f = fakeWorkers();
    const pool = new BotBenchWorkerPool({size: 1, createWorker: f.createWorker});
    const jobs = [pool.run({}, {}, {}), pool.run({}, {}, {})];
    const finished = Promise.allSettled(jobs);
    pool.dispose();
    expect((await finished).map(r => r.reason.message)).toEqual(['cancelled', 'cancelled']);
    expect(f.workers[0].terminate).toHaveBeenCalledTimes(1);
    await expect(pool.run({}, {}, {})).rejects.toThrow('cancelled');
});

test("a failed worker rejects all work so the caller can fall back", async () => {
    const f = fakeWorkers();
    const pool = new BotBenchWorkerPool({size: 2, createWorker: f.createWorker});
    const finished = Promise.allSettled([pool.run({}, {}, {}), pool.run({}, {}, {}), pool.run({}, {}, {})]);
    f.workers[0].onerror({message: 'blocked'});
    expect((await finished).map(r => r.reason.message)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(f.workers.every(w => w.terminate.mock.calls.length === 1)).toBe(true);
});

test("a file-specific error leaves the worker usable", async () => {
    const f = fakeWorkers();
    const pool = new BotBenchWorkerPool({size: 1, createWorker: f.createWorker});
    const failed = pool.run({}, {}, {}).catch(e => e.message);
    f.ready(f.workers[0]);
    f.workers[0].onmessage({data: {id: 0, error: 'bad input'}});
    expect(await failed).toBe('bad input');
    const next = pool.run({}, {}, {});
    f.finish(f.workers[0], 'ok');
    expect((await next).battery).toBe('ok');
    pool.dispose();
});

test("transfer lists include each shared buffer only once, including Map values and array properties", () => {
    const track = new Float64Array([1, 2, 3]);
    const rows = Object.assign([], {track});
    const data = {rows, map: new Map([['track', track]]), alias: track.subarray(1)};
    data.self = data;
    expect(transferableBuffers(data)).toEqual([track.buffer]);
});

test("queue starts in input order, never exceeds its limit, and stops claiming after cancel", async () => {
    const starts = [], releases = [];
    let cancelled = false;
    const done = runBotBenchQueue([0, 1, 2, 3], 2, (e) => {
        starts.push(e);
        return new Promise(resolve => releases.push(resolve));
    }, () => cancelled);
    expect(starts).toEqual([0, 1]);
    releases[1]();
    await Promise.resolve();
    expect(starts).toEqual([0, 1, 2]);
    cancelled = true;
    releases[0](); releases[2]();
    await done;
    expect(starts).toEqual([0, 1, 2]);
});

test("concurrency leaves a logical core for the UI and caps large machines", () => {
    expect(botBenchConcurrency(128, 14)).toBe(13);
    expect(botBenchConcurrency(2, 14)).toBe(2);
    expect(botBenchConcurrency(128, 128)).toBe(16);
    expect(botBenchConcurrency(128, 1)).toBe(1);
});

test("an unexpected queue error waits for active jobs before rejecting", async () => {
    let release;
    const completed = [];
    const done = runBotBenchQueue([0, 1, 2], 2, async value => {
        if (value === 0) throw new Error('failed');
        await new Promise(resolve => { release = resolve; });
        completed.push(value);
    }).catch(error => error.message);
    await Promise.resolve();
    expect(completed).toEqual([]);
    release();
    expect(await done).toBe('failed');
    expect(completed).toEqual([1]);
});
