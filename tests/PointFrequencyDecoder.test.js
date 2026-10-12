import {startTonalAnalysis} from '../src/videoTonal/VideoTonalAnalysis';

let workers;
beforeEach(() => {
    workers = [];
    global.Worker = class {
        constructor() { this.messages = []; this.terminate = jest.fn(); workers.push(this); }
        postMessage(message) {
            this.messages.push(message);
            if (message.type === 'init') this.options = message;
            queueMicrotask(() => {
                const items = (message.items ?? []).filter(item => !this.options.pointFrequency
                    || (item.index >= this.options.first && item.index <= this.options.last)).map(item => ({
                    index: item.index, flux: 100 + item.index, background: 50, area: 12, clippedFraction: 0,
                    count: 4, targetCount: 1, localCount: 3, mean: 25, histogram: new Uint32Array(256),
                }));
                this.onmessage({data: {type: 'result', items, mode: 'luma', bits: 8, width: 40, height: 40}});
            });
        }
    };
});
afterEach(() => { delete global.Worker; });

function video() {
    const order = [0, 3, 1, 2, 4, 7, 5, 6, 8];
    const chunks = order.map((index, n) => ({timestamp: index * 33333, type: n % 4 === 0 ? 'key' : 'delta',
        byteLength: 1, copyTo(data) { new Uint8Array(data)[0] = index; }}));
    return {chunks, config: {codec: 'avc1'}, timestampToChunkIndex: new Map(chunks.map((c, i) => [c.timestamp, order[i]]))};
}

test('point analysis sends the selected decode span and counts only requested presentation frames', async () => {
    const source = video();
    const job = startTonalAnalysis(source, {pointFrequency: true, first: 1, last: 2, targets: {}}, jest.fn());
    const result = await job.promise;
    expect(result).toMatchObject({frames: 2, done: 2, complete: true, error: null});
    expect(Array.from(result.flux)).toEqual([NaN, 101, 102, NaN, NaN, NaN, NaN, NaN, NaN]);
    expect(result.histograms).toBeUndefined();
    const batches = workers[0].messages.filter(message => message.type === 'chunks');
    expect(batches.flatMap(batch => batch.items.map(item => item.index))).toEqual([0, 3, 1, 2]);
    expect(batches.at(-1).last).toBe(true);
    expect(workers[0].terminate).toHaveBeenCalled();
});

test('the existing tonal analysis still measures the entire video and retains histograms', async () => {
    const source = video();
    const result = await startTonalAnalysis(source, {}, jest.fn()).promise;
    expect(result).toMatchObject({frames: 9, done: 9, complete: true, error: null});
    expect(result.histograms).toHaveLength(9 * 256);
    expect(Array.from(result.mean)).toEqual(new Array(9).fill(25));
});

test('closing a graph cancels the worker without publishing a completed analysis', async () => {
    const onUpdate = jest.fn();
    const job = startTonalAnalysis(video(), {pointFrequency: true, first: 1, last: 2}, onUpdate);
    job.cancel();
    await job.promise;
    expect(job.result.complete).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalled();
});
