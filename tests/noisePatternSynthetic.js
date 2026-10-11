// Synthetic test videos for Noise Pattern Detection (not a test file itself).
//
// Every frame is a function of its index only, so frames can be made in any order, by any
// number of lanes, and a held or looped frame is an exact copy of the frame it repeats.
//
//   scene   128 + 40 sin(2 pi (x + 0.7 p) / 97) cos(2 pi y / 61) plus a slow drift (p = picture)
//   fresh   new Gaussian noise (sigma 1.5) in every plane of every picture
//   layer   optional repeating noise layer in Cb (sigma 2.5), a clip of `clip` pictures:
//             xor        strips of 16 luma px; strip c of picture p shows bank strip
//                        c XOR (floor(p / clip) & 31)
//             translate  no permutation; the layer moves shiftX luma px right per block
//             vertical   no permutation; the layer moves shiftY luma px down per block
//             still      no permutation, no motion
//   codecLike  a fixed 16x16 block DC grid, fixed 8x8 ringing, and 16x16 noise blocks that
//              are copied from the previous picture with p = 0.85, refreshed every 120

import {gaussianSource, hash32, mulberry32, planeDescriptors} from "../src/videoNoisePattern/NoisePatternMath";

// Local names for the Math functions used in loops: global lookups are slow in some
// JavaScript sandboxes (Jest runs these tests in one).
const {abs, round, floor, ceil, min, max, cos, sin, PI} = Math;

export function createSyntheticVideo(spec = {}) {
    const frames = spec.frames ?? 384;
    const width = spec.width ?? 320, height = spec.height ?? 180;
    const cw = ceil(width / 2), ch = ceil(height / 2);
    const seed = spec.seed ?? 1;
    const fresh = spec.fresh ?? 1.5;
    const framesPerPicture = spec.framesPerPicture ?? 1;
    const pictureLoop = spec.pictureLoop ?? 0;
    const layer = spec.layer ?? null;
    const codecLike = !!spec.codecLike;
    const pictureOf = (f) => pictureLoop ? f % pictureLoop : floor(f / framesPerPicture);
    const pictures = pictureOf(frames - 1) + 1;

    // the layer bank or canvas, made once
    let bank = null, canvasW = 0, canvasH = 0, stripC = 0;
    if (layer) {
        const clip = layer.clip ?? 32;
        const rng = gaussianSource(mulberry32(seed * 7919 + 17));
        stripC = (layer.stripPx ?? 16) / 2;
        const blocks = ceil(pictures / clip) + 1;
        if (layer.kind === "xor") {
            const bankStrips = layer.bankStrips ?? 32;
            bank = new Float32Array(clip * bankStrips * stripC * ch);
            canvasW = bankStrips;
        } else {
            canvasW = cw + abs((layer.shiftX ?? 0) / 2) * blocks + 16;
            canvasH = ch + abs((layer.shiftY ?? 0) / 2) * blocks + 16;
            bank = new Float32Array(clip * canvasW * canvasH);
        }
        for (let i = 0; i < bank.length; i++) bank[i] = rng();
    }

    function layerValue(p, x, y) {
        const clip = layer.clip ?? 32;
        const u = floor(p / clip), phase = p % clip;
        const sigma = layer.sigma ?? 2.5;
        if (layer.kind === "xor") {
            const c = floor(x / stripC);
            const bankStrips = layer.bankStrips ?? 32;
            const visible = layer.visible ?? floor(cw / stripC);
            if (c >= visible) return 0;
            const k = c ^ (u & (bankStrips - 1));
            const xs = x - c * stripC;
            return sigma * bank[((phase * bankStrips + k) * stripC + xs) * ch + y];
        }
        let sx = x, sy = y;
        if (layer.kind === "translate") sx = x - u * (layer.shiftX / 2);
        if (layer.kind === "vertical") sy = y - u * (layer.shiftY / 2);
        sx = ((round(sx) % canvasW) + canvasW) % canvasW;
        sy = ((round(sy) % canvasH) + canvasH) % canvasH;
        return sigma * bank[(phase * canvasH + sy) * canvasW + sx];
    }

    // codec-like fixed patterns
    let dcY = null, dcC = null, ring = null;
    if (codecLike) {
        const rng = gaussianSource(mulberry32(seed * 104729 + 3));
        dcY = new Float32Array(ceil(width / 16) * ceil(height / 16)).map(() => 3 * rng());
        dcC = new Float32Array(ceil(cw / 8) * ceil(ch / 8)).map(() => 2 * rng());
        ring = new Float32Array(ceil(width / 8) * ceil(height / 8)).map(() => 2 * rng());
    }
    // most recent picture <= p at which block (bx, by) of a plane got new noise
    function refreshedAt(p, bx, by, plane) {
        for (let g = p; g > 0; g--) {
            if (g % 120 === 0) return g;
            if (hash32(hash32(seed * 31 + g) ^ (bx * 7349 + by * 913 + plane * 104651)) / 4294967296 >= 0.85) return g;
        }
        return 0;
    }

    function planeNoise(p, plane, w, h, out, base) {
        if (!codecLike) {
            const g = gaussianSource(mulberry32(hash32(seed * 1000003 + p * 7 + plane)));
            for (let i = 0; i < w * h; i++) out[base + i] = fresh * g();
            return;
        }
        const block = plane === 0 ? 16 : 8;
        for (let by = 0; by * block < h; by++) {
            for (let bx = 0; bx * block < w; bx++) {
                const g0 = refreshedAt(p, bx, by, plane);
                const g = gaussianSource(mulberry32(hash32(seed * 1000003 + g0 * 7 + plane) ^ (bx * 92821 + by * 68917)));
                for (let y = by * block; y < min(h, (by + 1) * block); y++) {
                    for (let x = bx * block; x < min(w, (bx + 1) * block); x++) out[base + y * w + x] = fresh * g();
                }
            }
        }
    }

    function frame(index) {
        const p = pictureOf(index);
        const data = new Uint8Array(width * height + 2 * cw * ch);
        const values = new Float32Array(data.length);
        planeNoise(p, 0, width, height, values, 0);
        planeNoise(p, 1, cw, ch, values, width * height);
        planeNoise(p, 2, cw, ch, values, width * height + cw * ch);
        const drift = 6 * sin(2 * PI * p / 150);
        const sinX = new Float32Array(width);
        for (let x = 0; x < width; x++) sinX[x] = sin(2 * PI * (x + 0.7 * p) / 97);
        for (let y = 0; y < height; y++) {
            const cy = cos(2 * PI * y / 61);
            for (let x = 0; x < width; x++) {
                let v = 128 + 40 * sinX[x] * cy + drift + values[y * width + x];
                if (codecLike) {
                    v += dcY[floor(y / 16) * ceil(width / 16) + floor(x / 16)];
                    v += ring[floor(y / 8) * ceil(width / 8) + floor(x / 8)]
                        * cos(PI * (x % 8) / 4) * cos(PI * (y % 8) / 4);
                }
                data[y * width + x] = max(0, min(255, round(v)));
            }
        }
        for (let plane = 1; plane <= 2; plane++) {
            const base = width * height + (plane - 1) * cw * ch;
            for (let y = 0; y < ch; y++) {
                const cy = cos(2 * PI * (2 * y) / 61 + plane);
                for (let x = 0; x < cw; x++) {
                    let v = 128 + 12 * sinX[min(width - 1, 2 * x)] * cy + drift / 3 + values[base + y * cw + x];
                    if (codecLike) v += dcC[floor(y / 8) * ceil(cw / 8) + floor(x / 8)];
                    if (layer && plane === (layer.plane === "Cr" ? 2 : 1)) v += layerValue(p, x, y);
                    data[base + y * cw + x] = max(0, min(255, round(v)));
                }
            }
        }
        const layout = [{offset: 0, stride: width}, {offset: width * height, stride: cw},
            {offset: width * height + cw * ch, stride: cw}];
        return {data, descriptors: planeDescriptors("I420", layout, width, height), format: "I420", width, height};
    }

    return {frames, width, height, frame, pictureOf};
}

// A fake source video for the job: chunk objects carrying their display index, key-frame
// groups of `gop` frames (closed GOPs, display order = decode order).
export function createFakeVideoData(video, {gop = 32} = {}) {
    const chunks = [];
    const timestampToChunkIndex = new Map();
    const groups = [];
    for (let i = 0; i < video.frames; i++) {
        const timestamp = 1000 + i * 41667;
        const type = i % gop === 0 ? "key" : "delta";
        chunks.push({timestamp, type, byteLength: 4, duration: 41667, copyTo(buffer) { new Uint8Array(buffer).set([i & 255, i >> 8, 0, 0]); }});
        timestampToChunkIndex.set(timestamp, i);
        if (type === "key") groups.push({frame: i, length: 0});
        groups[groups.length - 1].length++;
    }
    return {
        id: "synthetic", chunks, groups, timestampToChunkIndex, videoSpeed: 1, frames: video.frames,
        config: {codec: "avc1.test", codedWidth: video.width, codedHeight: video.height},
        videoWidth: video.width, videoHeight: video.height, originalVideoWidth: video.width, originalVideoHeight: video.height,
        filename: "synthetic.mp4",
    };
}
