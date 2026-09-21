import {TONAL_FIELDS} from './TonalStatistics';
import {sourceVideoOf} from '../videoQP/VideoQPAnalysis';

// A separate sequential decoder leaves the playback decoder, playhead and image cache alone.
export function startTonalAnalysis(videoData, options, onUpdate) {
    const source = sourceVideoOf(videoData);
    const chunks = source.chunks;
    const frames = chunks.length;
    const result = {frames, done: 0, complete: false, error: null, version: 0,
        masked: !!options.mask, hasTargets: !!options.targets,
        counts: new Uint32Array(frames), targetCounts: new Uint32Array(frames),
        localCounts: new Uint32Array(frames), histograms: new Uint32Array(frames * 256)};
    for (const field of TONAL_FIELDS) result[field] = new Float32Array(frames).fill(NaN);
    const worker = new Worker(new URL('../workers/VideoTonalWorker.js', import.meta.url));
    const measured = new Uint8Array(frames);
    let cancelled = false, waiting = null;
    const notify = () => { result.version++; onUpdate?.(result); };
    const request = message => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video analysis timed out')), 60000);
        waiting = {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); },
        };
        try {
            worker.postMessage(message, message.items?.map(item => item.data) ?? []);
        } catch (error) { waiting.reject(error); }
    });
    worker.onmessage = ({data}) => data.type === 'error'
        ? waiting?.reject(new Error(data.message)) : waiting?.resolve(data);
    worker.onerror = event => waiting?.reject(new Error(event.message || 'Video analysis worker failed'));
    const job = {
        result,
        cancel() {
            cancelled = true;
            waiting?.reject(new Error('Cancelled'));
            worker.terminate();
        },
    };
    job.promise = (async () => {
        const started = performance.now();
        try {
            await request({type: 'init', config: source.config, ...options});
            for (let next = 0; next < frames;) {
                if (cancelled) return;
                if (source.disposed || source.chunks !== chunks || chunks.length !== frames) {
                    throw new Error('The video changed during analysis');
                }
                const items = [];
                let bytes = 0;
                while (next < frames && items.length < 64 && bytes < 4 * 1024 * 1024) {
                    const chunk = chunks[next];
                    const data = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(data);
                    items.push({data, type: chunk.type, timestamp: chunk.timestamp,
                        duration: chunk.duration ?? undefined,
                        index: source.timestampToChunkIndex?.get(chunk.timestamp) ?? next});
                    next++;
                    bytes += data.byteLength;
                }
                const reply = await request({type: 'chunks', items, last: next === frames});
                if (cancelled) return;
                Object.assign(result, {mode: reply.mode, bits: reply.bits, width: reply.width, height: reply.height});
                for (const item of reply.items) {
                    if (item.index < 0 || item.index >= frames) throw new Error('Invalid decoded frame index');
                    if (measured[item.index]) throw new Error('Duplicate decoded frame index');
                    measured[item.index] = 1;
                    for (const field of TONAL_FIELDS) result[field][item.index] = item[field];
                    result.counts[item.index] = item.count;
                    result.targetCounts[item.index] = item.targetCount;
                    result.localCounts[item.index] = item.localCount;
                    result.histograms.set(item.histogram, item.index * 256);
                    result.done++;
                }
                notify();
            }
            if (result.done !== frames) throw new Error(`Decoded ${result.done} of ${frames} frames`);
        } catch (error) {
            if (!cancelled) result.error = error.message;
        } finally {
            worker.terminate();
            waiting = null;
            if (!cancelled) {
                result.complete = true;
                result.elapsedMs = performance.now() - started;
                notify();
            }
        }
        return result;
    })();
    return job;
}
