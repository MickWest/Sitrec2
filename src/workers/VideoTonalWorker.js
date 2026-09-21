import {exclusionMask, measureTonalFrame} from '../videoTonal/TonalStatistics';

let decoder, options, failure, representation, mode, bits, frameSize, excluded;
let results = [], pending = new Set(), indices = new Map();
const delay = () => new Promise(resolve => setTimeout(resolve, 2));

async function measure(frame) {
    try {
        const index = indices.get(frame.timestamp);
        if (index === undefined) throw new Error('Decoded frame has no presentation index');
        const width = frame.visibleRect.width, height = frame.visibleRect.height;
        const native = /^(I4(20|22|44)A?(P(10|12))?|NV12)$/.test(frame.format ?? '');
        const frameMode = native ? 'luma' : 'display';
        const frameBits = native ? Number(frame.format.match(/P(10|12)$/)?.[1] ?? 8) : 8;
        const identity = `${frameMode}:${frameBits}:${width}:${height}`;
        if (representation && representation !== identity) throw new Error('The pixel format changed during analysis');
        representation = identity;
        mode = frameMode; bits = frameBits;
        if (!frameSize) {
            frameSize = {width, height};
            excluded = exclusionMask(width, height, options.mask, options.rotation);
        }
        let pixels;
        if (native) {
            const bytes = new Uint8Array(frame.allocationSize());
            const layout = await frame.copyTo(bytes);
            const plane = layout[0];
            pixels = new Uint8Array(width * height);
            const words = bits > 8 ? new DataView(bytes.buffer) : null;
            const scale = 255 / (2 ** bits - 1);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const offset = plane.offset + y * plane.stride + x * (words ? 2 : 1);
                pixels[y * width + x] = words ? Math.round(words.getUint16(offset, true) * scale) : bytes[offset];
            }
        } else {
            // A consistent, explicitly labeled fallback for decoder outputs without Y planes.
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d', {willReadFrequently: true});
            ctx.drawImage(frame, 0, 0, width, height);
            const rgba = ctx.getImageData(0, 0, width, height).data;
            pixels = new Uint8Array(width * height);
            for (let i = 0; i < pixels.length; i++) {
                pixels[i] = Math.round(.299 * rgba[4 * i] + .587 * rgba[4 * i + 1] + .114 * rgba[4 * i + 2]);
            }
        }
        results.push({index, ...measureTonalFrame(pixels, width, height, excluded, options.targets?.[index], options.rotation)});
    } finally {
        frame.close();
    }
}

function check() { if (failure) throw failure; }

self.onmessage = async ({data}) => {
    try {
        if (data.type === 'init') {
            options = data;
            decoder = new VideoDecoder({
                output(frame) {
                    const job = measure(frame).catch(error => { failure = error; })
                        .finally(() => pending.delete(job));
                    pending.add(job);
                },
                error(error) { failure = error; },
            });
            decoder.configure({...data.config, hardwareAcceleration: 'prefer-software'});
            self.postMessage({type: 'ready'});
            return;
        }
        if (data.type !== 'chunks') return;
        for (const item of data.items) {
            check();
            indices.set(item.timestamp, item.index);
            decoder.decode(new EncodedVideoChunk(item));
            while (decoder.decodeQueueSize + pending.size > 12) { check(); await delay(); }
        }
        if (data.last) await decoder.flush();
        while (decoder.decodeQueueSize || pending.size) { check(); await delay(); }
        check();
        const items = results;
        results = [];
        self.postMessage({type: 'result', items, mode, bits, ...frameSize}, items.map(item => item.histogram.buffer));
        if (data.last) decoder.close();
    } catch (error) {
        failure = error;
        if (decoder && decoder.state !== 'closed') decoder.close();
        self.postMessage({type: 'error', message: error.message});
    }
};
