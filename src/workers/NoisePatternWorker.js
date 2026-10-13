// Worker for Video > Forensics > Noise Pattern Detection.
//
// It runs its own VideoDecoder on the encoded chunks it is sent, so the playback decoder,
// the playhead and the frame cache are not touched, and frames are read at their native
// size. Native planes come from VideoFrame.copyTo(); a decoder output without planes is
// drawn to a canvas and converted with the BT.709 matrix (labeled "display RGB").
// The analysis itself is NoisePatternWorkerCore, which the Jest tests also run.

import {createNoisePatternCore} from "../videoNoisePattern/NoisePatternWorkerCore";
import {planeDescriptors, rgbaToI420} from "../videoNoisePattern/NoisePatternMath";

const NATIVE_FORMAT = /^(I4(20|22|44)A?(P(10|12))?|NV12)$/;
const MAX_IN_FLIGHT = 12;
const now = () => performance.now();

const support = new Map();
async function chooseAcceleration(config, preferred) {
    const key = `${config.codec}|${config.codedWidth}x${config.codedHeight}|${preferred}`;
    if (support.has(key)) return support.get(key);
    let chosen = null;
    for (const candidate of [preferred, "no-preference"]) {
        try {
            const answer = await VideoDecoder.isConfigSupported({...config, hardwareAcceleration: candidate});
            if (answer.supported) { chosen = candidate; break; }
        } catch { /* try the next */ }
    }
    support.set(key, chosen);
    return chosen;
}

const spareBuffers = [];
function takeBuffer(size) {
    for (let i = 0; i < spareBuffers.length; i++) if (spareBuffers[i].byteLength >= size) return spareBuffers.splice(i, 1)[0];
    return new ArrayBuffer(size);
}
function returnBuffer(buffer) {
    if (buffer && spareBuffers.length < MAX_IN_FLIGHT + 4) spareBuffers.push(buffer);
}

async function readFrame(frame, index) {
    const width = frame.visibleRect?.width ?? frame.displayWidth;
    const height = frame.visibleRect?.height ?? frame.displayHeight;
    if (frame.format && NATIVE_FORMAT.test(frame.format)) {
        const size = frame.allocationSize();
        const buffer = takeBuffer(size);
        const layout = await frame.copyTo(buffer);
        const descriptors = planeDescriptors(frame.format, layout, width, height);
        const data = descriptors.wide ? new Uint16Array(buffer, 0, size >> 1) : new Uint8Array(buffer, 0, size);
        return {index, data, descriptors, mode: "native", bits: descriptors.bits, buffer};
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.drawImage(frame, 0, 0, width, height);
    const {data, descriptors} = rgbaToI420(context.getImageData(0, 0, width, height).data, width, height);
    return {index, data, descriptors, mode: "display", bits: 8};
}

// Decodes items (in decode order) and calls onFrame for each frame whose display index is in
// [keepFrom, keepTo). more() gives further items of a large segment. A frame that does not
// come out of the decoder is counted as failed; it does not stop the analysis.
async function decodeSegment(message, onFrame, more) {
    const started = now();
    const {config, keepFrom, keepTo} = message;
    const accel = await chooseAcceleration(config, message.accel ?? "prefer-software");
    if (!accel) throw new Error("This browser cannot decode this video codec");
    let decoded = 0, failure = null, inFlight = 0, wake = null, expected = 0;
    const indexOf = new Map();
    const tasks = new Set();
    const signal = () => { const resolve = wake; wake = null; resolve?.(); };
    const decoder = new VideoDecoder({
        output(frame) {
            inFlight++;
            const index = indexOf.get(frame.timestamp);
            const task = (async () => {
                let info = null;
                try {
                    if (index === undefined || index < keepFrom || index >= keepTo) return;
                    info = await readFrame(frame, index);
                } finally {
                    frame.close();
                }
                try {
                    onFrame(info);
                    decoded++;
                } finally {
                    returnBuffer(info.buffer);
                }
            })().catch(error => { failure = failure ?? error; })
                .finally(() => { inFlight--; tasks.delete(task); signal(); });
            tasks.add(task);
        },
        error(error) { failure = failure ?? error; signal(); },
    });
    decoder.ondequeue = signal;
    decoder.configure({...config, hardwareAcceleration: accel});
    const feed = async (items) => {
        for (const item of items) {
            if (failure) return;
            indexOf.set(item.timestamp, item.index);
            if (item.index >= keepFrom && item.index < keepTo) expected++;
            try {
                decoder.decode(new EncodedVideoChunk({type: item.type, timestamp: item.timestamp,
                    duration: item.duration ?? undefined, data: item.data}));
            } catch (error) {
                failure = failure ?? error;
                return;
            }
            while (!failure && decoder.decodeQueueSize + inFlight > MAX_IN_FLIGHT) {
                await new Promise(resolve => { wake = resolve; });
            }
        }
    };
    await feed(message.items);
    let last = message.last !== false;
    while (!last && !failure) {
        const next = await more();
        await feed(next.items);
        last = next.last;
    }
    if (!failure && decoder.state === "configured") {
        try { await decoder.flush(); } catch (error) { failure = failure ?? error; }
    }
    await Promise.allSettled([...tasks]);
    if (decoder.state !== "closed") decoder.close();
    if (failure && !decoded) throw failure;
    return {decoded, failed: Math.max(0, expected - decoded), accel, decodeMs: now() - started,
        error: failure ? String(failure.message ?? failure) : null};
}

async function decodeFrames(message, onFrame) {
    const keepFrom = Math.min(...message.targets), keepTo = Math.max(...message.targets) + 1;
    return decodeSegment({...message, keepFrom, keepTo, last: true}, onFrame, async () => ({items: [], last: true}));
}

const core = createNoisePatternCore({
    post: (data, transfer) => self.postMessage(data, transfer ?? []),
    decoder: {decodeSegment, decodeFrames},
});

self.onmessage = ({data}) => { core.handle(data); };
