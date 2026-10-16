import {exclusionMask, measureTonalFrame} from '../videoTonal/TonalStatistics';
import {measurePointFlux, pointFluxGeometry} from '../pointFrequency/PointFrequencyStatistics';
import {chooseDecoderAcceleration} from '../VideoDecoderAcceleration';

let decoder, options, failure, representation, mode, bits, frameSize, excluded;
let results = [], pending = new Set(), indices = new Map();
const delay = () => new Promise(resolve => setTimeout(resolve, 2));

async function measure(frame) {
    try {
        const index = indices.get(frame.timestamp);
        if (index === undefined) throw new Error('Decoded frame has no presentation index');
        if (options.pointFrequency && (index < options.first || index > options.last)) return;
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
        // Point frequency reads only the box its aperture uses: a 4K frame has
        // 8 million pixels, an aperture and its ring a few hundred. Even box
        // edges keep a native read on the 4:2:0 chroma sample grid.
        const box = options.pointFrequency
            ? pointFluxGeometry(width, height, options.targets?.[index], options.rotation) : null;
        const read = box ? evenBox(box, width, height) : {x: 0, y: 0, width, height};
        const pixels = new Uint8Array(width * height);
        if (options.pointFrequency && !box) {
            // The aperture leaves the image; measurePointFlux reports it as missing.
        } else if (native) {
            const copy = box ? {rect: {x: frame.visibleRect.x + read.x, y: frame.visibleRect.y + read.y,
                width: read.width, height: read.height}} : undefined;
            const bytes = new Uint8Array(frame.allocationSize(copy));
            const layout = await frame.copyTo(bytes, copy);
            const plane = layout[0];
            const words = bits > 8 ? new DataView(bytes.buffer) : null;
            const scale = 255 / (2 ** bits - 1);
            for (let y = 0; y < read.height; y++) for (let x = 0; x < read.width; x++) {
                const offset = plane.offset + y * plane.stride + x * (words ? 2 : 1);
                pixels[(read.y + y) * width + read.x + x] = words ? Math.round(words.getUint16(offset, true) * scale) : bytes[offset];
            }
        } else {
            // A consistent, explicitly labeled fallback for decoder outputs without Y planes.
            // A VideoFrame's source coordinates are in its display size.
            const canvas = new OffscreenCanvas(read.width, read.height);
            const ctx = canvas.getContext('2d', {willReadFrequently: true});
            const kx = frame.displayWidth / width, ky = frame.displayHeight / height;
            ctx.drawImage(frame, read.x * kx, read.y * ky, read.width * kx, read.height * ky, 0, 0, read.width, read.height);
            const rgba = ctx.getImageData(0, 0, read.width, read.height).data;
            for (let y = 0; y < read.height; y++) for (let x = 0; x < read.width; x++) {
                const i = y * read.width + x;
                pixels[(read.y + y) * width + read.x + x] = Math.round(.299 * rgba[4 * i] + .587 * rgba[4 * i + 1] + .114 * rgba[4 * i + 2]);
            }
        }
        // Limited-range luma reserves codes outside its black/white endpoints.
        // The display-gray fallback has already converted those to full range.
        const scale = 255 / (2 ** bits - 1);
        const limits = native && frame.colorSpace?.fullRange === false
            ? [Math.round(16 * 2 ** (bits - 8) * scale), Math.round(235 * 2 ** (bits - 8) * scale)] : [0, 255];
        const values = options.pointFrequency
            ? measurePointFlux(pixels, width, height, excluded, options.targets?.[index], options.rotation, limits)
            : measureTonalFrame(pixels, width, height, excluded, options.targets?.[index], options.rotation);
        results.push({index, ...values});
    } finally {
        frame.close();
    }
}

function check() { if (failure) throw failure; }

// The pointFluxGeometry box widened to even edges.
function evenBox(box, width, height) {
    const x = box.x0 & ~1, y = box.y0 & ~1;
    const x1 = Math.min(width, box.x1 + (box.x1 & 1)), y1 = Math.min(height, box.y1 + (box.y1 & 1));
    return {x, y, width: x1 - x, height: y1 - y};
}

self.onmessage = async ({data}) => {
    try {
        if (data.type === 'init') {
            options = data;
            const hardwareAcceleration = await chooseDecoderAcceleration(data.config);
            if (!hardwareAcceleration) throw new Error('This browser cannot decode this video codec');
            decoder = new VideoDecoder({
                output(frame) {
                    const job = measure(frame).catch(error => { failure = error; })
                        .finally(() => pending.delete(job));
                    pending.add(job);
                },
                error(error) { failure = error; },
            });
            decoder.configure({...data.config, hardwareAcceleration});
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
        self.postMessage({type: 'result', items, mode, bits, ...frameSize}, items.filter(item => item.histogram).map(item => item.histogram.buffer));
        if (data.last) decoder.close();
    } catch (error) {
        failure = error;
        if (decoder && decoder.state !== 'closed') decoder.close();
        self.postMessage({type: 'error', message: error.message});
    }
};
