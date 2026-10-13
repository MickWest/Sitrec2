// NoisePatternMath - the arithmetic of Video > Forensics > Noise Pattern Detection.
//
// Pure functions only: no DOM, no Sitrec globals, no three.js. The decode workers, the
// search workers, the GPU worker, the coordinator and the Jest tests all import this
// module, so every number the tool reports comes from one copy of each formula.
//
// Terms used below:
//   plane        Y (luma), Cb or Cr (the two color-difference planes) of a decoded frame
//   column       a bin of `colWidth` luma pixels (8 by default) across the whole frame
//   band         one of 45 horizontal bands of rows; a band of a 720-row frame is 16 rows
//   strip profile  the sum of the pixels of each (band, column) cell, band-passed along x,
//                quantized to Int8 and stored column-major: q[x * BAND_STRIDE + band]
//   probe        two adjacent columns (16 px) of a target frame, compared with every
//                position of a source frame (blind strip assignment)
//   NCC          normalized cross-correlation, in [-1, 1]

// Local names for the Math functions used in loops: global lookups are slow in some
// JavaScript sandboxes (Jest runs these tests in one).
const {abs, sqrt, round, floor, ceil, min, max, cos, sin, atan2, hypot, log, imul, PI} = Math;
const isNum = Number.isFinite;

export const BANDS = 45;
export const BAND_STRIDE = 48;          // 45 bands padded to 48: 4 Int8 values pack into one u32 on the GPU
export const SIG_COUNT = 4096;          // aligned signature samples per plane
export const THUMB_W = 32;
export const THUMB_H = 18;
export const THUMB_SIZE = THUMB_W * THUMB_H;
export const TEMPORAL_HALF = 8;         // temporal high-pass: mean of the frames within +-8
export const LAG_MIN = 2 * TEMPORAL_HALF + 1;   // 17: shorter lags share temporal windows
export const PROBE_COLUMNS = 2;
export const CONFIDENT_MARGIN = 0.10;
export const MIN_VALID_PROBES = 8;
export const PROBE_NORM_FRACTION = 0.25;
export const HELD_NCC = 0.90;
export const Q_SCALE = 32;
export const Q_CLIP = 3;
export const MAD_SCALE = 1.4826;
export const LIVE_THRESHOLD = 0.05;
export const LIVE_FRACTION = 0.2;
export const PLANES = ["Y", "Cb", "Cr"];
export const STRIP_CURVES = ["S-Y", "S-Cb", "S-Cr"];
export const ALIGNED_CURVES = ["A-Yfine", "A-Cbmid"];
export const CURVES = [...STRIP_CURVES, ...ALIGNED_CURVES];
export const SIGNIFICANT_Z = 6;
export const STRONG_Z = 12;
export const FINE_COLUMN_PX = 2;         // refine stage: 2-luma-px columns
export const FINE_PROBE_COLUMNS = 8;     // refine stage: 16-px dense probes

// ---------------------------------------------------------------------------------------
// Random numbers (seeded, so positions and test data are the same on every machine)

export function mulberry32(seed) {
    let s = seed >>> 0;
    return function next() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = imul(t ^ (t >>> 15), t | 1);
        t ^= t + imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Standard normal samples by the Box-Muller method.
export function gaussianSource(rng) {
    let spare = null;
    return function gaussian() {
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u = 0;
        while (u <= 1e-12) u = rng();
        const v = rng();
        const r = sqrt(-2 * log(u));
        spare = r * sin(2 * PI * v);
        return r * cos(2 * PI * v);
    };
}

export function hash32(n) {
    n = imul(n ^ (n >>> 16), 0x7feb352d);
    n = imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------------------
// Small numeric helpers

// k-th smallest of values[0..n) (0-based). Reorders values.
function selectKth(values, n, k) {
    let lo = 0, hi = n - 1;
    while (hi > lo) {
        const pivot = values[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
            while (values[i] < pivot) i++;
            while (values[j] > pivot) j--;
            if (i <= j) { const t = values[i]; values[i] = values[j]; values[j] = t; i++; j--; }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return values[k];
    }
    return values[k];
}

// Median of values[0..n), as numpy computes it (the mean of the two middle values when n
// is even). Reorders values.
export function medianOf(values, n = values.length) {
    if (n <= 0) return NaN;
    const upper = selectKth(values, n, n >> 1);
    if (n & 1) return upper;
    let lower = -Infinity;
    for (let i = 0; i < (n >> 1); i++) if (values[i] > lower) lower = values[i];
    return (lower + upper) / 2;
}

// Linear-interpolation percentile (numpy's default). Reorders values.
export function percentileOf(values, n, p) {
    if (n <= 0) return NaN;
    const sorted = Array.from(values.subarray ? values.subarray(0, n) : values.slice(0, n)).sort((a, b) => a - b);
    const pos = (p / 100) * (n - 1);
    const lo = floor(pos);
    const hi = min(n - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// Centered box mean of radius r along a row, edges repeated. src and dst may not alias.
export function boxFilter1D(src, n, r, dst) {
    const k = 2 * r + 1;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[i < 0 ? 0 : i >= n ? n - 1 : i];
    for (let x = 0; x < n; x++) {
        dst[x] = acc / k;
        const add = x + r + 1, sub = x - r;
        acc += src[add >= n ? n - 1 : add] - src[sub < 0 ? 0 : sub];
    }
    return dst;
}

// ---------------------------------------------------------------------------------------
// Frame geometry

// Width in luma pixels of one strip-profile column. 8 px, scaled up for frames wider than
// 1920 px; the "4 px" strip detail halves it.
export function stripColumnWidth(width, detail = 8) {
    const base = 8 * max(1, ceil(width / 1920));
    return detail === 4 ? base / 2 : base;
}

export function stripColumns(width, detail = 8) {
    return floor(width / stripColumnWidth(width, detail));
}

export function probeCount(columns) {
    return floor(columns / PROBE_COLUMNS);
}

const PLANAR_FORMAT = /^(I420|I422|I444)(A)?(P(10|12))?$/;

// Where each plane of a decoded VideoFrame is, from the layout returned by frame.copyTo().
// Offsets and strides are in SAMPLES of the returned typed array (bytes for 8-bit formats,
// 16-bit words for P10 / P12). step is the distance between horizontally adjacent samples
// (2 in the interleaved CbCr plane of NV12). Returns null for formats without planes.
export function planeDescriptors(format, layout, width, height) {
    if (!layout) return null;
    if (format === "NV12") {
        const cw = ceil(width / 2), ch = ceil(height / 2);
        return {bits: 8, wide: false, shift: 0, planes: [
            {offset: layout[0].offset, stride: layout[0].stride, step: 1, width, height, sx: 1, sy: 1},
            {offset: layout[1].offset, stride: layout[1].stride, step: 2, width: cw, height: ch, sx: 2, sy: 2},
            {offset: layout[1].offset + 1, stride: layout[1].stride, step: 2, width: cw, height: ch, sx: 2, sy: 2},
        ]};
    }
    const match = PLANAR_FORMAT.exec(format ?? "");
    if (!match) return null;
    const bits = match[4] ? Number(match[4]) : 8;
    const wide = bits > 8;
    const unit = wide ? 2 : 1;
    const sx = match[1] === "I444" ? 1 : 2;
    const sy = match[1] === "I420" ? 2 : 1;
    const cw = ceil(width / sx), ch = ceil(height / sy);
    const plane = (entry, w, h, px, py) => {
        if (wide && (entry.offset % 2 || entry.stride % 2)) throw new Error("Unaligned 16-bit plane");
        return {offset: entry.offset / unit, stride: entry.stride / unit, step: 1, width: w, height: h, sx: px, sy: py};
    };
    return {bits, wide, shift: bits - 8, planes: [
        plane(layout[0], width, height, 1, 1), plane(layout[1], cw, ch, sx, sy), plane(layout[2], cw, ch, sx, sy),
    ]};
}

// Display RGBA (full range) -> 8-bit I420 planes with the BT.709 limited-range matrix. Used
// only for decoder outputs that have no planes; the result is labeled "display RGB".
// Chroma is the mean of each 2x2 block.
export function rgbaToI420(rgba, width, height) {
    const cw = ceil(width / 2), ch = ceil(height / 2);
    const data = new Uint8Array(width * height + 2 * cw * ch);
    const cbOffset = width * height, crOffset = cbOffset + cw * ch;
    const cbSum = new Float32Array(cw * ch), crSum = new Float32Array(cw * ch), count = new Uint8Array(cw * ch);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
            const luma = 16 + (46.559 * r + 156.629 * g + 15.812 * b) / 255;
            data[y * width + x] = luma < 0 ? 0 : luma > 255 ? 255 : round(luma);
            const c = (y >> 1) * cw + (x >> 1);
            cbSum[c] += 128 + (-25.664 * r - 86.336 * g + 112 * b) / 255;
            crSum[c] += 128 + (112 * r - 101.730 * g - 10.270 * b) / 255;
            count[c]++;
        }
    }
    for (let c = 0; c < cw * ch; c++) {
        const n = count[c] || 1;
        data[cbOffset + c] = max(0, min(255, round(cbSum[c] / n)));
        data[crOffset + c] = max(0, min(255, round(crSum[c] / n)));
    }
    const layout = [{offset: 0, stride: width}, {offset: cbOffset, stride: cw}, {offset: crOffset, stride: cw}];
    return {data, descriptors: planeDescriptors("I420", layout, width, height)};
}

// 4096 seeded positions [y0, x0, y1, x1, ...] at least `margin` px from every edge.
export function signaturePositions(width, height, count = SIG_COUNT, seed = 0x5eed, margin = 5) {
    const rng = mulberry32(seed ^ hash32(width * 65537 + height));
    const out = new Int32Array(count * 2);
    const w = max(1, width - 2 * margin), h = max(1, height - 2 * margin);
    for (let i = 0; i < count; i++) {
        out[2 * i] = margin + floor(rng() * h);
        out[2 * i + 1] = margin + floor(rng() * w);
    }
    return out;
}

// ---------------------------------------------------------------------------------------
// Per-frame features

// Scratch buffers and fixed tables for one frame size. Each worker keeps one.
export function createFeatureContext(width, height, detail = 8) {
    const colWidth = stripColumnWidth(width, detail);
    const columns = floor(width / colWidth);
    return {
        width, height, detail, colWidth, columns,
        sums: new Int32Array(BANDS * columns),
        row: new Float64Array(columns), tmp: new Float64Array(columns), hp: new Float64Array(BANDS * columns),
        absScratch: new Float64Array(max(columns, SIG_COUNT)),
        sigValues: new Float32Array(SIG_COUNT),
        thumbCount: new Float32Array(THUMB_SIZE),
        positions: new Map(),
        thumbColumn: null,
    };
}

function positionsFor(ctx, width, height) {
    const key = width + "x" + height;
    let pos = ctx.positions.get(key);
    if (!pos) { pos = signaturePositions(width, height); ctx.positions.set(key, pos); }
    return pos;
}

// Integer sum of each (band, column) cell of one plane. binW = plane samples per column.
function bandSums(data, d, shift, binW, columns, sums) {
    sums.fill(0);
    const hb = floor(d.height / BANDS);
    const step = d.step;
    for (let b = 0; b < BANDS; b++) {
        const sOff = b * columns;
        for (let r = 0; r < hb; r++) {
            let p = d.offset + (b * hb + r) * d.stride;
            if (shift) {
                for (let x = 0; x < columns; x++) {
                    let acc = 0;
                    for (let k = 0; k < binW; k++, p += step) acc += data[p] >> shift;
                    sums[sOff + x] += acc;
                }
            } else if (step === 1 && binW === 8) {
                for (let x = 0; x < columns; x++, p += 8) {
                    sums[sOff + x] += data[p] + data[p + 1] + data[p + 2] + data[p + 3]
                        + data[p + 4] + data[p + 5] + data[p + 6] + data[p + 7];
                }
            } else if (step === 1 && binW === 4) {
                for (let x = 0; x < columns; x++, p += 4) {
                    sums[sOff + x] += data[p] + data[p + 1] + data[p + 2] + data[p + 3];
                }
            } else {
                for (let x = 0; x < columns; x++) {
                    let acc = 0;
                    for (let k = 0; k < binW; k++, p += step) acc += data[p];
                    sums[sOff + x] += acc;
                }
            }
        }
    }
    return hb;
}

// A column is live when its band sums are not perfectly flat: the mean over bands of
// |S - box3(S)| is above 0.05. Black borders and black frames are dead.
function liveColumns(sums, columns, live) {
    let liveCount = 0;
    for (let x = 0; x < columns; x++) {
        const xl = x > 0 ? x - 1 : 0, xr = x < columns - 1 ? x + 1 : columns - 1;
        let tex = 0;
        for (let b = 0; b < BANDS; b++) {
            const o = b * columns;
            const s = sums[o + x];
            tex += abs(s - (sums[o + xl] + s + sums[o + xr]) / 3);
        }
        const isLive = tex / BANDS > LIVE_THRESHOLD ? 1 : 0;
        live[x] = isLive;
        liveCount += isLive;
    }
    return liveCount;
}

// Removes a component that repeats every `period` columns (the 16-px macroblock grid of
// the codec): from each column, the mean of the live columns with the same x mod period.
function notchRow(row, live, columns, period) {
    if (period <= 1) return;
    const sum = new Float64Array(period), count = new Float64Array(period);
    for (let x = 0; x < columns; x++) if (live[x]) { sum[x % period] += row[x]; count[x % period]++; }
    for (let m = 0; m < period; m++) sum[m] = count[m] ? sum[m] / count[m] : 0;
    for (let x = 0; x < columns; x++) row[x] -= sum[x % period];
}

// round(clip(v / sigma, +-3) * 32), sigma = 1.4826 * median |v| over the live columns.
// Writes out[base + x * stride + band].
function quantizeRow(row, live, columns, out, base, band, stride, scratch) {
    let n = 0;
    for (let x = 0; x < columns; x++) if (live[x]) scratch[n++] = abs(row[x]);
    const sigma = n ? MAD_SCALE * medianOf(scratch, n) + 1e-6 : 0;
    for (let x = 0; x < columns; x++) {
        let v = 0;
        if (live[x] && sigma > 0) {
            v = row[x] / sigma;
            v = v > Q_CLIP ? Q_CLIP : v < -Q_CLIP ? -Q_CLIP : v;
            v = round(v * Q_SCALE);
        }
        out[base + x * stride + band] = v;
    }
}

// Band-pass of one band row in place: S - box(box(S)) with radius hpRadius, then the
// macroblock notch (period ceil(16 / colWidth) columns).
export function bandPassRow(row, live, columns, colWidth, hpRadius = 2, tmp = new Float64Array(columns), smooth = new Float64Array(columns)) {
    boxFilter1D(row, columns, hpRadius, tmp);
    boxFilter1D(tmp, columns, hpRadius, smooth);
    for (let x = 0; x < columns; x++) row[x] -= smooth[x];
    notchRow(row, live, columns, ceil(16 / colWidth));
    return row;
}

// Strip profile of one plane: band sums -> live columns -> band-pass along x
// (S - box5(box5(S)), about 2 to 5 columns) -> macroblock notch -> Int8.
// hpRadius 2 is the coarse profile; the refine stage uses 4.
export function stripProfile(data, d, shift, colWidth, columns, ctx, outQ, outLive, hpRadius = 2) {
    const binW = colWidth / d.sx;
    const sums = ctx.sums.length >= BANDS * columns ? ctx.sums : new Int32Array(BANDS * columns);
    bandSums(data, d, shift, binW, columns, sums);
    const liveCount = liveColumns(sums, columns, outLive);
    const row = ctx.row.length >= columns ? ctx.row : new Float64Array(columns);
    const tmp = ctx.tmp.length >= columns ? ctx.tmp : new Float64Array(columns);
    const smooth = new Float64Array(columns);
    const scratch = ctx.absScratch.length >= columns ? ctx.absScratch : new Float64Array(columns);
    for (let b = 0; b < BANDS; b++) {
        const o = b * columns;
        for (let x = 0; x < columns; x++) row[x] = sums[o + x];
        bandPassRow(row, outLive, columns, colWidth, hpRadius, tmp, smooth);
        quantizeRow(row, outLive, columns, outQ, 0, b, BAND_STRIDE, scratch);
    }
    for (let x = 0; x < columns; x++) for (let b = BANDS; b < BAND_STRIDE; b++) outQ[x * BAND_STRIDE + b] = 0;
    return liveCount / max(1, columns);
}

// Normalizes raw signature samples to Int8: minus their mean, divided by 1.4826 * MAD,
// clipped to +-3, times 32.
export function quantizeSignature(values, count, out, scratch) {
    let mean = 0;
    for (let i = 0; i < count; i++) mean += values[i];
    mean /= count || 1;
    for (let i = 0; i < count; i++) scratch[i] = abs(values[i] - mean);
    const sigma = MAD_SCALE * medianOf(scratch, count) + 1e-6;
    for (let i = 0; i < count; i++) {
        let v = (values[i] - mean) / sigma;
        v = v > Q_CLIP ? Q_CLIP : v < -Q_CLIP ? -Q_CLIP : v;
        out[i] = round(v * Q_SCALE);
    }
}

// Aligned signature, fine luma: P minus the mean of its 3x3 block (1-3 px band). The 3x3
// mean (not the 4-neighbor mean) is what the held-frame threshold of 0.90 was measured with.
function fineSignature(data, d, shift, pos, out) {
    const stride = d.stride, step = d.step;
    for (let i = 0; i < SIG_COUNT; i++) {
        const o = d.offset + pos[2 * i] * stride + pos[2 * i + 1] * step;
        let block = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) block += data[o + dy * stride + dx * step] >> shift;
        out[i] = (data[o] >> shift) - block / 9;
    }
}

// Aligned signature, mid band: 3x3 mean minus the mean of the 9 samples at {-4,0,4}^2
// (2-8 px band).
function midSignature(data, d, shift, pos, out) {
    const stride = d.stride, step = d.step;
    for (let i = 0; i < SIG_COUNT; i++) {
        const o = d.offset + pos[2 * i] * stride + pos[2 * i + 1] * step;
        let near = 0, far = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near += data[o + dy * stride + dx * step] >> shift;
        for (let dy = -4; dy <= 4; dy += 4) for (let dx = -4; dx <= 4; dx += 4) far += data[o + dy * stride + dx * step] >> shift;
        out[i] = (near - far) / 9;
    }
}

// 32x18 mean luma (every second row and column), for the picture-repeat test.
function thumbnail(data, d, shift, ctx, out) {
    if (!ctx.thumbColumn || ctx.thumbColumn.length !== d.width) {
        ctx.thumbColumn = new Int32Array(d.width);
        for (let x = 0; x < d.width; x++) ctx.thumbColumn[x] = min(THUMB_W - 1, floor(x * THUMB_W / d.width));
    }
    const count = ctx.thumbCount;
    count.fill(0);
    out.fill(0);
    for (let y = 0; y < d.height; y += 2) {
        const ty = min(THUMB_H - 1, floor(y * THUMB_H / d.height)) * THUMB_W;
        let p = d.offset + y * d.stride;
        for (let x = 0; x < d.width; x += 2, p += 2 * d.step) {
            const c = ty + ctx.thumbColumn[x];
            out[c] += data[p] >> shift;
            count[c]++;
        }
    }
    for (let i = 0; i < THUMB_SIZE; i++) out[i] = count[i] ? out[i] / count[i] : 0;
}

// All features of one decoded frame.
//   frame: {data, descriptors: {planes, shift}}
//   out: {strips: [Int8Array(columns * 48) x3], live: [Uint8Array(columns) x3],
//         sigY: Int8Array(4096), sigCb: Int8Array(4096), thumb: Float32Array(576)}
// Returns the live fraction of each plane.
export function extractFrameFeatures(frame, ctx, out) {
    const {data, descriptors} = frame;
    const shift = descriptors.shift || 0;
    const liveFraction = [0, 0, 0];
    for (let p = 0; p < 3; p++) {
        liveFraction[p] = stripProfile(data, descriptors.planes[p], shift, ctx.colWidth, ctx.columns, ctx,
            out.strips[p], out.live[p]);
    }
    const dY = descriptors.planes[0], dCb = descriptors.planes[1];
    fineSignature(data, dY, shift, positionsFor(ctx, dY.width, dY.height), ctx.sigValues);
    quantizeSignature(ctx.sigValues, SIG_COUNT, out.sigY, ctx.absScratch);
    midSignature(data, dCb, shift, positionsFor(ctx, dCb.width, dCb.height), ctx.sigValues);
    quantizeSignature(ctx.sigValues, SIG_COUNT, out.sigCb, ctx.absScratch);
    thumbnail(data, dY, shift, ctx, out.thumb);
    return liveFraction;
}

// Fine strip profile of one plane for the refine stage: 2-luma-px columns, band-pass
// radius 4 (S - box9(box9(S))), macroblock notch, Int8.
export function fineProfile(frame, planeIndex) {
    const {data, descriptors} = frame;
    const d = descriptors.planes[planeIndex];
    const width = descriptors.planes[0].width;
    const columns = floor(width / FINE_COLUMN_PX);
    const ctx = createFeatureContext(width, descriptors.planes[0].height);
    const q = new Int8Array(columns * BAND_STRIDE), live = new Uint8Array(columns);
    const sums = new Int32Array(BANDS * columns);
    ctx.sums = sums; ctx.row = new Float64Array(columns); ctx.tmp = new Float64Array(columns);
    ctx.absScratch = new Float64Array(columns);
    stripProfile(data, d, descriptors.shift || 0, FINE_COLUMN_PX, columns, ctx, q, live, 4);
    return {q, live, columns, colWidth: FINE_COLUMN_PX};
}

// Noise residual image of one plane for the pair viewer: 3x3 mean minus 9x9 mean, scaled
// to +-3 sigma around mid gray.
export function residualImage(frame, planeIndex) {
    const {data, descriptors} = frame;
    const d = descriptors.planes[planeIndex];
    const shift = descriptors.shift || 0;
    const w = d.width, h = d.height;
    // integral image
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let rowSum = 0;
        let p = d.offset + y * d.stride;
        for (let x = 0; x < w; x++, p += d.step) {
            rowSum += data[p] >> shift;
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
        }
    }
    const boxMean = (x, y, r) => {
        const x0 = max(0, x - r), x1 = min(w, x + r + 1);
        const y0 = max(0, y - r), y1 = min(h, y + r + 1);
        const s = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        return s / ((x1 - x0) * (y1 - y0));
    };
    const values = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = boxMean(x, y, 1) - boxMean(x, y, 4);
    const sampleCount = min(values.length, 20000);
    const scratch = new Float64Array(sampleCount);
    const stepSample = max(1, floor(values.length / sampleCount));
    let n = 0;
    for (let i = 0; i < values.length && n < sampleCount; i += stepSample) scratch[n++] = abs(values[i]);
    const sigma = MAD_SCALE * medianOf(scratch, n) + 1e-6;
    const pixels = new Uint8ClampedArray(w * h);
    for (let i = 0; i < values.length; i++) {
        let v = values[i] / (3 * sigma);
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        pixels[i] = round(128 + 127 * v);
    }
    return {width: w, height: h, pixels, sx: d.sx, sy: d.sy};
}

// ---------------------------------------------------------------------------------------
// Held frames: a frame whose fine luma signature (with the mean signature of the whole
// video removed, so a static overlay does not count) has NCC >= 0.90 with the previous
// frame is a held (repeated) picture.

// sigs: Int8Array(n * 4096), decoded: Uint8Array(n), meanSig: Float64Array(4096) of sig/32.
// Returns Float32Array(n): NCC of row i with row i-1, NaN where either is not decoded.
export function heldScores(sigs, decoded, meanSig, n) {
    const scores = new Float32Array(n).fill(NaN);
    let previous = null;
    const unit = () => new Float64Array(SIG_COUNT);
    let current = unit();
    for (let i = 0; i < n; i++) {
        if (!decoded[i]) { previous = null; continue; }
        const o = i * SIG_COUNT;
        let norm = 0;
        for (let k = 0; k < SIG_COUNT; k++) {
            const v = sigs[o + k] / Q_SCALE - meanSig[k];
            current[k] = v;
            norm += v * v;
        }
        norm = sqrt(norm);
        if (norm > 0) for (let k = 0; k < SIG_COUNT; k++) current[k] /= norm;
        if (previous && norm > 0) {
            let dot = 0;
            for (let k = 0; k < SIG_COUNT; k++) dot += current[k] * previous[k];
            scores[i] = dot;
        }
        if (norm > 0) {
            const swap = previous ?? unit();
            previous = current;
            current = swap;
        } else previous = null;
    }
    return scores;
}

// ---------------------------------------------------------------------------------------
// Temporal high-pass: each profile minus the mean of the valid profiles within +-8 (frames,
// or pictures in picture mode), then quantized again. This removes what does not change
// over about 17 frames: burned-in overlays, a static scene, and noise that the codec copies
// forward from frame to frame.

// raw: Int8Array(m * columns * 48) for elements 0..m-1 of a window; valid: Uint8Array(m);
// live: Uint8Array(m * columns). Writes elements lo..hi-1 to out (Int8, (hi-lo) rows) and
// their column energies (sum over bands of q^2) to energies.
export function temporalHighPass(raw, live, valid, m, columns, lo, hi, out, energies, half = TEMPORAL_HALF) {
    const rowSize = columns * BAND_STRIDE;
    const sum = new Float64Array(rowSize);
    const values = new Float64Array(rowSize);
    const scratch = new Float64Array(columns);
    const rowBuf = new Float64Array(columns);
    let count = 0;
    const add = (i, sign) => {
        if (i < 0 || i >= m || !valid[i]) return;
        const o = i * rowSize;
        for (let k = 0; k < rowSize; k++) sum[k] += sign * raw[o + k];
        count += sign;
    };
    for (let i = lo - half; i <= lo + half; i++) add(i, 1);
    for (let q = lo; q < hi; q++) {
        const outRow = (q - lo) * rowSize;
        const eRow = (q - lo) * columns;
        if (!valid[q] || count <= 0) {
            out.fill(0, outRow, outRow + rowSize);
            energies.fill(0, eRow, eRow + columns);
        } else {
            const o = q * rowSize;
            for (let k = 0; k < rowSize; k++) values[k] = raw[o + k] - sum[k] / count;
            const liveRow = live.subarray(q * columns, (q + 1) * columns);
            for (let b = 0; b < BANDS; b++) {
                for (let x = 0; x < columns; x++) rowBuf[x] = values[x * BAND_STRIDE + b];
                quantizeRow(rowBuf, liveRow, columns, out, outRow, b, BAND_STRIDE, scratch);
            }
            for (let x = 0; x < columns; x++) {
                let e = 0;
                for (let b = BANDS; b < BAND_STRIDE; b++) out[outRow + x * BAND_STRIDE + b] = 0;
                for (let b = 0; b < BANDS; b++) { const v = out[outRow + x * BAND_STRIDE + b]; e += v * v; }
                energies[eRow + x] = e;
            }
        }
        add(q - half, -1);
        add(q + half + 1, 1);
    }
}

// The same for aligned signatures: sig/32 minus the window mean, quantized to Int8, with
// the norm of each result.
export function temporalHighPassSignatures(sigs, valid, m, lo, hi, out, norms, half = TEMPORAL_HALF) {
    const sum = new Float64Array(SIG_COUNT);
    const values = new Float32Array(SIG_COUNT);
    const scratch = new Float64Array(SIG_COUNT);
    const tmp = new Int8Array(SIG_COUNT);
    let count = 0;
    const add = (i, sign) => {
        if (i < 0 || i >= m || !valid[i]) return;
        const o = i * SIG_COUNT;
        for (let k = 0; k < SIG_COUNT; k++) sum[k] += sign * sigs[o + k];
        count += sign;
    };
    for (let i = lo - half; i <= lo + half; i++) add(i, 1);
    for (let q = lo; q < hi; q++) {
        const outRow = (q - lo) * SIG_COUNT;
        if (!valid[q] || count <= 0) {
            out.fill(0, outRow, outRow + SIG_COUNT);
            norms[q - lo] = 0;
        } else {
            const o = q * SIG_COUNT;
            for (let k = 0; k < SIG_COUNT; k++) values[k] = (sigs[o + k] - sum[k] / count) / Q_SCALE;
            quantizeSignature(values, SIG_COUNT, tmp, scratch);
            let e = 0;
            for (let k = 0; k < SIG_COUNT; k++) { out[outRow + k] = tmp[k]; e += tmp[k] * tmp[k]; }
            norms[q - lo] = sqrt(e);
        }
        add(q - half, -1);
        add(q + half + 1, 1);
    }
}

// ---------------------------------------------------------------------------------------
// Blind strip assignment of one frame pair

export function createMatchScratch(columns) {
    const probes = probeCount(columns);
    return {
        columns,
        cross: new Float64Array(columns * columns),
        r: new Float64Array(max(1, columns)),
        rAll: null,
        eT: new Float64Array(columns), eS: new Float64Array(columns),
        c1: new Float32Array(probes), c2: new Float32Array(probes), sBest: new Int16Array(probes),
        dyBest: new Int8Array(probes), norm: new Float32Array(probes),
        normScratch: new Float64Array(probes), offsets: new Int32Array(probes),
    };
}

// Per-probe results of matching target T against source S (strip profiles of one plane,
// column-major, stride 48). For each probe k (target columns 2k, 2k+1) and every source
// position s (columns s, s+1) and band shift dy in [-V, V]:
//     r = sum(qT * qS) / sqrt(ET * ES) over the overlapping bands
// c1 = the largest r (at s*, dy*), c2 = the largest r with |s - s*| >= 2.
// eT, eS: column energies over all 45 bands (used when V = 0).
export function matchProbes(T, S, eT, eS, columns, V, scratch) {
    const P = probeCount(columns), ns = columns - 1;
    const {c1, c2, sBest, dyBest, norm} = scratch;
    for (let k = 0; k < P; k++) {
        norm[k] = sqrt(eT[2 * k] + eT[2 * k + 1]);
        c1[k] = 0; c2[k] = 0; sBest[k] = 0; dyBest[k] = 0;
    }
    if (ns < 1) return P;
    const cross = scratch.cross;
    const shifts = 2 * V + 1;
    if (V > 0 && (!scratch.rAll || scratch.rAll.length < shifts * ns)) scratch.rAll = new Float64Array(shifts * ns);
    const best = new Float64Array(P).fill(-Infinity);
    for (let dy = -V; dy <= V; dy++) {
        const b0 = max(0, -dy), b1 = min(BANDS, BANDS - dy);
        // energies over the overlapping bands
        let eTd = eT, eSd = eS;
        if (dy !== 0) {
            eTd = scratch.eT; eSd = scratch.eS;
            for (let x = 0; x < columns; x++) {
                let et = 0, es = 0;
                const o = x * BAND_STRIDE;
                for (let b = b0; b < b1; b++) { const t = T[o + b], s = S[o + b + dy]; et += t * t; es += s * s; }
                eTd[x] = et; eSd[x] = es;
            }
        }
        // cross products of every target column with every source column
        for (let xt = 0; xt < columns; xt++) {
            const row = xt * columns;
            if (eTd[xt] <= 0) { cross.fill(0, row, row + columns); continue; }
            const tb = xt * BAND_STRIDE;
            for (let xs = 0; xs < columns; xs++) {
                if (eSd[xs] <= 0) { cross[row + xs] = 0; continue; }
                const sb = xs * BAND_STRIDE + dy;
                let acc = 0;
                for (let b = b0; b < b1; b++) acc += T[tb + b] * S[sb + b];
                cross[row + xs] = acc;
            }
        }
        for (let k = 0; k < P; k++) {
            const t0 = 2 * k;
            const eTk = eTd[t0] + eTd[t0 + 1];
            const r = V > 0 ? scratch.rAll.subarray((dy + V) * ns, (dy + V + 1) * ns) : scratch.r;
            const row0 = t0 * columns, row1 = (t0 + 1) * columns;
            for (let s = 0; s < ns; s++) {
                const den = eTk * (eSd[s] + eSd[s + 1]);
                const v = den > 0 ? (cross[row0 + s] + cross[row1 + s + 1]) / sqrt(den) : 0;
                r[s] = v;
                if (v > best[k]) { best[k] = v; sBest[k] = s; dyBest[k] = dy; }
            }
            if (V === 0) {
                c1[k] = best[k];
                const sb = sBest[k];
                let second = -Infinity;
                for (let s = 0; s < ns; s++) if ((s <= sb - 2 || s >= sb + 2) && r[s] > second) second = r[s];
                c2[k] = second === -Infinity ? best[k] : second;
            } else {
                // keep all shifts of this probe for the second-best search after the last dy
                if (!scratch.probeR) scratch.probeR = [];
                if (!scratch.probeR[k] || scratch.probeR[k].length < shifts * ns) scratch.probeR[k] = new Float64Array(shifts * ns);
                scratch.probeR[k].set(r.subarray(0, ns), (dy + V) * ns);
            }
        }
    }
    if (V > 0) {
        for (let k = 0; k < P; k++) {
            c1[k] = best[k];
            const sb = sBest[k];
            const all = scratch.probeR[k];
            let second = -Infinity;
            for (let i = 0; i < shifts * ns; i++) {
                const s = i % ns;
                if ((s <= sb - 2 || s >= sb + 2) && all[i] > second) second = all[i];
            }
            c2[k] = second === -Infinity ? best[k] : second;
        }
    }
    return P;
}

// Pair statistics from per-probe results. A probe is valid when its norm is at least 0.25
// times the median of the positive probe norms of the target; confident when c1 - c2 >= 0.10.
//   Q = mean c1 of the valid probes, C = confident / valid (the pair score),
//   shift = how far the layer moved from the source frame to the target frame, in luma px
//           (positive = right): the mode of (2k - s*) * colWidth over the confident probes,
//           reported when at least 60% of them agree within +-1 column.
// Fewer than 8 valid probes: no pair (Q, C and shift are NaN).
export function reducePair(c1, c2, sBest, norm, P, colWidth, scratch, out, o = 0) {
    const tmp = scratch.normScratch;
    let n = 0;
    for (let k = 0; k < P; k++) if (norm[k] > 0) tmp[n++] = norm[k];
    let nValid = 0, nConf = 0, sum = 0;
    if (n > 0) {
        const threshold = PROBE_NORM_FRACTION * medianOf(tmp, n);
        const offsets = scratch.offsets;
        for (let k = 0; k < P; k++) {
            if (norm[k] > 0 && norm[k] >= threshold) {
                nValid++;
                sum += c1[k];
                if (c1[k] - c2[k] >= CONFIDENT_MARGIN) offsets[nConf++] = 2 * k - sBest[k];
            }
        }
        if (nValid >= MIN_VALID_PROBES) {
            out[o] = sum / nValid;
            out[o + 1] = nConf / nValid;
            out[o + 2] = nValid;
            out[o + 3] = nConf ? shiftMode(offsets, nConf) * colWidth : NaN;
            return;
        }
    }
    out[o] = NaN; out[o + 1] = NaN; out[o + 2] = nValid; out[o + 3] = NaN;
}

// The offset (in columns) shared by the most confident probes within +-1 column; NaN unless
// at least 60% agree. Ties go to the smaller |offset|.
function shiftMode(offsets, n) {
    let bestCount = 0, bestOffset = NaN;
    for (let i = 0; i < n; i++) {
        const o = offsets[i];
        let count = 0;
        for (let j = 0; j < n; j++) if (abs(offsets[j] - o) <= 1) count++;
        if (count > bestCount || (count === bestCount && abs(o) < abs(bestOffset))) {
            bestCount = count; bestOffset = o;
        }
    }
    return bestCount >= 0.6 * n ? bestOffset : NaN;
}

// One pair, start to finish: [Q, C, nValid, shift] written to out[o..o+3].
export function matchPair(T, S, eT, eS, columns, colWidth, V, scratch, out, o = 0) {
    const P = matchProbes(T, S, eT, eS, columns, V, scratch);
    reducePair(scratch.c1, scratch.c2, scratch.sBest, scratch.norm, P, colWidth, scratch, out, o);
}

// Aligned score of two prepared signatures: rho = dot / (norm_a * norm_b), at zero offset.
export function alignedScore(a, ao, na, b, bo, nb) {
    if (!(na > 0) || !(nb > 0)) return NaN;
    let dot = 0;
    for (let k = 0; k < SIG_COUNT; k++) dot += a[ao + k] * b[bo + k];
    return dot / (na * nb);
}

// Zero-mean NCC of two thumbnails.
export function thumbNCC(a, ao, b, bo) {
    let ma = 0, mb = 0;
    for (let k = 0; k < THUMB_SIZE; k++) { ma += a[ao + k]; mb += b[bo + k]; }
    ma /= THUMB_SIZE; mb /= THUMB_SIZE;
    let ab = 0, aa = 0, bb = 0;
    for (let k = 0; k < THUMB_SIZE; k++) {
        const x = a[ao + k] - ma, y = b[bo + k] - mb;
        ab += x * y; aa += x * x; bb += y * y;
    }
    return aa > 0 && bb > 0 ? ab / sqrt(aa * bb) : NaN;
}

// ---------------------------------------------------------------------------------------
// Lag scan

// R reference positions at the quantiles (k + 0.5) / R of the valid elements.
export function referenceIndices(valid, n, R) {
    const list = [];
    for (let i = 0; i < n; i++) if (valid[i]) list.push(i);
    if (!list.length) return [];
    const refs = [];
    for (let k = 0; k < R; k++) {
        const i = min(list.length - 1, max(0, round((k + 0.5) * list.length / R)));
        refs.push(list[i]);
    }
    return refs;
}

// 0..R-1 in bit-reversed order, so that a partial scan already covers the whole video.
export function bitReversedOrder(R) {
    let bits = 0;
    while ((1 << bits) < R) bits++;
    const order = [];
    for (let i = 0; i < (1 << bits); i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        if (r < R) order.push(r);
    }
    return order;
}

// The pair for reference r at lag L: target r+L and source r when r+L is valid, else
// target r and source r-L. null when neither exists.
export function lagPair(r, L, n, valid) {
    if (r + L < n && valid[r + L]) return [r + L, r];
    if (r - L >= 0 && valid[r - L]) return [r, r - L];
    return null;
}

// Robust z-score of a lag curve against its own null:
//   baseline b(L) = median of the curve over L+-12, without L-1..L+1
//   e = curve - b; z = (e - median e) / (1.4826 * MAD e) over the lags >= lagMin
//   A second pass recomputes the baseline without the lags whose first z was above 4.
//   Quantized, sparse curves can have zero MAD. Use their RMS deviation instead;
//   a completely flat residual has no measurable scale and cannot have a z-score.
// values[i] is lag i + 1. Lags below lagMin get NaN.
export function detrendZ(values, lagMin = LAG_MIN, half = 12) {
    const n = values.length;
    const z = new Float64Array(n).fill(NaN);
    const baseOf = (q) => {
        const base = new Float64Array(n).fill(NaN);
        const windowValues = new Float64Array(2 * half + 1);
        for (let i = 0; i < n; i++) {
            const lo = max(0, i - half), hi = min(n, i + half + 1);
            let k = 0;
            for (let j = lo; j < hi; j++) {
                if (j >= i - 1 && j <= i + 1) continue;
                if (isNum(q[j])) windowValues[k++] = q[j];
            }
            if (k >= 4) base[i] = medianOf(windowValues, k);
        }
        return base;
    };
    const stats = (e) => {
        const okValues = [];
        for (let i = 0; i < n; i++) if (isNum(e[i]) && i + 1 >= lagMin) okValues.push(e[i]);
        if (okValues.length < 10) return null;
        const arr = Float64Array.from(okValues);
        const med = medianOf(arr.slice(), arr.length);
        const dev = arr.map(v => abs(v - med));
        let scale = MAD_SCALE * medianOf(dev, dev.length);
        const largest = dev.reduce((a, b) => max(a, b), 0);
        if (scale <= Number.EPSILON * max(1, largest) * 32) {
            scale = sqrt(dev.reduce((sum, v) => sum + v * v, 0) / dev.length);
        }
        if (!(scale > Number.EPSILON * max(1, largest) * 32)) return null;
        return {med, scale};
    };
    let base = baseOf(values);
    let e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = values[i] - base[i];
    let s = stats(e);
    if (!s) return z;
    const second = Float64Array.from(values);
    for (let i = 0; i < n; i++) {
        if (isNum(e[i]) && i + 1 >= lagMin && (e[i] - s.med) / s.scale > 4) second[i] = NaN;
    }
    base = baseOf(second);
    for (let i = 0; i < n; i++) e[i] = values[i] - base[i];
    s = stats(e);
    if (!s) return z;
    for (let i = 0; i < n; i++) {
        if (i + 1 >= lagMin && isNum(e[i])) z[i] = (e[i] - s.med) / s.scale;
    }
    return z;
}

// The loop period of a z curve: the smallest P in [2, lmax/2] with at least 2 multiples in
// [lagMin, lmax], z >= 3 at >= 70% of them, and >= 80% of the significant lags (z >= 6)
// multiples of P. Strength = the median z at the multiples.
export function findPeriod(z, lmax, lagMin = LAG_MIN) {
    const zz = (L) => { const v = z[L - 1]; return isNum(v) ? v : -99; };
    const significant = [];
    for (let L = lagMin; L <= lmax; L++) if (zz(L) >= SIGNIFICANT_Z) significant.push(L);
    if (!significant.length) return {period: null, strength: 0, significant, multiples: []};
    for (let P = 2; P <= floor(lmax / 2); P++) {
        const multiples = [];
        for (let L = P; L <= lmax; L += P) if (L >= lagMin) multiples.push(L);
        if (multiples.length < 2) continue;
        let hit = 0;
        for (const L of multiples) if (zz(L) >= 3) hit++;
        let explained = 0;
        for (const L of significant) if (L % P === 0) explained++;
        if (hit / multiples.length >= 0.7 && explained / significant.length >= 0.8) {
            const zs = Float64Array.from(multiples.map(zz));
            return {period: P, strength: medianOf(zs, zs.length), significant, multiples};
        }
    }
    return {period: null, strength: 0, significant, multiples: []};
}

// References whose own detrended curve averages z >= 3 at the multiples of P.
export function periodCoverage(rows, R, lmax, period, lagMin = LAG_MIN) {
    if (!period) return 0;
    let covered = 0;
    for (let a = 0; a < R; a++) {
        const row = rows.subarray(a * lmax, (a + 1) * lmax);
        let finite = 0;
        for (let i = 0; i < lmax; i++) if (isNum(row[i])) finite++;
        if (finite < 30) continue;
        const zr = detrendZ(row, lagMin);
        let sum = 0, count = 0;
        for (let L = period; L <= lmax; L += period) {
            if (L < lagMin) continue;
            if (isNum(zr[L - 1])) { sum += zr[L - 1]; count++; }
        }
        if (count && sum / count >= 3) covered++;
    }
    return covered;
}

// Mean of each lag over the references (NaN-aware). rows: Float32Array(R * lmax).
export function curveMean(rows, R, lmax) {
    const out = new Float64Array(lmax).fill(NaN);
    for (let i = 0; i < lmax; i++) {
        let sum = 0, count = 0;
        for (let a = 0; a < R; a++) {
            const v = rows[a * lmax + i];
            if (isNum(v)) { sum += v; count++; }
        }
        if (count) out[i] = sum / count;
    }
    return out;
}

// Full analysis of the lag curves: z, peaks, period, strength and coverage of each curve,
// and the verdict curve (the one with the highest strength).
export function analyzeCurves(curves, R, lmax, lagMin = LAG_MIN) {
    const out = {};
    let best = null;
    for (const [name, rows] of Object.entries(curves)) {
        const values = curveMean(rows, R, lmax);
        const z = detrendZ(values, lagMin);
        const found = findPeriod(z, lmax, lagMin);
        const coverage = found.period ? periodCoverage(rows, R, lmax, found.period, lagMin) : 0;
        const peaks = [];
        for (let L = lagMin; L <= lmax; L++) if (z[L - 1] >= SIGNIFICANT_Z) peaks.push({lag: L, z: z[L - 1]});
        peaks.sort((a, b) => b.z - a.z);
        out[name] = {values, z, period: found.period, strength: found.strength, coverage,
            significant: found.significant, multiples: found.multiples, peaks};
        if (found.period && (!best || found.strength > out[best].strength)) best = name;
    }
    return {curves: out, verdictCurve: best};
}

// ---------------------------------------------------------------------------------------
// Precise pass

// tau(q) = max(floor, 95th percentile of the control scores within +-window + 0.10).
// NaN where fewer than 5 controls are near.
export function preciseThresholds(controls, n, floorValue = 0.25, window = 100, add = 0.10, minCount = 5) {
    const tau = new Float32Array(n).fill(NaN);
    const values = new Float64Array(2 * window + 1);
    for (let q = 0; q < n; q++) {
        let k = 0;
        const lo = max(0, q - window), hi = min(n - 1, q + window);
        for (let j = lo; j <= hi; j++) if (isNum(controls[j])) values[k++] = controls[j];
        if (k >= minCount) tau[q] = max(floorValue, percentileOf(values, k, 95) + add);
    }
    return tau;
}

// Runs of matched elements: gaps of up to `gap` merged, runs shorter than minLength dropped.
export function matchedRuns(matched, n, gap, minLength) {
    const runs = [];
    let start = -1, last = -1;
    for (let q = 0; q < n; q++) {
        if (!matched[q]) continue;
        if (start < 0) { start = q; last = q; continue; }
        if (q - last <= gap) last = q;
        else { runs.push([start, last]); start = q; last = q; }
    }
    if (start >= 0) runs.push([start, last]);
    return runs.filter(([a, b]) => b - a + 1 >= minLength);
}

// ---------------------------------------------------------------------------------------
// Refine: dense offset map, strip lattice and the re-ordering rule

// Dense blind assignment at fine resolution: target probes of 8 columns (16 px) at every
// column, matched against every source position. Returns per-probe arrays and, in luma px,
// the probe center x and the offset dl (source position - target position).
export function denseMatch(T, S, columns, colWidth = FINE_COLUMN_PX, wp = FINE_PROBE_COLUMNS) {
    const nT = columns - wp + 1;
    if (nT < 2) return null;
    const energy = (Q) => {
        const e = new Float64Array(columns);
        for (let x = 0; x < columns; x++) {
            let s = 0;
            for (let b = 0; b < BANDS; b++) { const v = Q[x * BAND_STRIDE + b]; s += v * v; }
            e[x] = s;
        }
        const prefix = new Float64Array(columns + 1);
        for (let x = 0; x < columns; x++) prefix[x + 1] = prefix[x] + e[x];
        return {e, prefix};
    };
    const eT = energy(T), eS = energy(S);
    const cross = new Float64Array(columns * columns);
    for (let xt = 0; xt < columns; xt++) {
        if (eT.e[xt] <= 0) continue;
        const tb = xt * BAND_STRIDE, row = xt * columns;
        for (let xs = 0; xs < columns; xs++) {
            if (eS.e[xs] <= 0) continue;
            const sb = xs * BAND_STRIDE;
            let acc = 0;
            for (let b = 0; b < BANDS; b++) acc += T[tb + b] * S[sb + b];
            cross[row + xs] = acc;
        }
    }
    const c1 = new Float32Array(nT), c2 = new Float32Array(nT), sBest = new Int32Array(nT);
    const nj = new Float64Array(nT);
    const r = new Float64Array(nT);
    for (let t = 0; t < nT; t++) {
        nj[t] = sqrt(max(0, eT.prefix[t + wp] - eT.prefix[t]));
        let best = -Infinity, bi = 0;
        for (let s = 0; s < nT; s++) {
            const ni = sqrt(max(0, eS.prefix[s + wp] - eS.prefix[s]));
            const den = nj[t] * ni;
            let v = 0;
            if (den > 1e-9) {
                let acc = 0;
                for (let k = 0; k < wp; k++) acc += cross[(t + k) * columns + s + k];
                v = acc / den;
            }
            r[s] = v;
            if (v > best) { best = v; bi = s; }
        }
        let second = -Infinity;
        for (let s = 0; s < nT; s++) if (abs(s - bi) >= wp && r[s] > second) second = r[s];
        c1[t] = best; c2[t] = second === -Infinity ? best : second; sBest[t] = bi;
    }
    const positive = [];
    for (let t = 0; t < nT; t++) if (nj[t] > 0) positive.push(nj[t]);
    const threshold = positive.length ? PROBE_NORM_FRACTION * medianOf(Float64Array.from(positive), positive.length) : Infinity;
    const x = new Float32Array(nT), dl = new Float32Array(nT), margin = new Float32Array(nT);
    const valid = new Uint8Array(nT), confident = new Uint8Array(nT);
    for (let t = 0; t < nT; t++) {
        x[t] = (t + wp / 2) * colWidth;
        dl[t] = (sBest[t] - t) * colWidth;
        margin[t] = c1[t] - c2[t];
        valid[t] = nj[t] > 0 && nj[t] >= threshold ? 1 : 0;
        confident[t] = valid[t] && margin[t] >= CONFIDENT_MARGIN ? 1 : 0;
    }
    return {count: nT, x, dl, c1, margin, valid, confident, colWidth, wp};
}

// Strip boundaries seen in offset maps: midpoints between confident probes at most 3
// columns apart whose offsets differ by more than 4 px.
export function boundariesOf(maps) {
    const bounds = [];
    for (const map of maps) {
        if (!map) continue;
        let previous = -1;
        for (let t = 0; t < map.count; t++) {
            if (!map.confident[t]) continue;
            if (previous >= 0 && t - previous <= 3 && abs(map.dl[t] - map.dl[previous]) > 4) {
                bounds.push((map.x[previous] + map.x[t]) / 2);
            }
            previous = t;
        }
    }
    return bounds;
}

// Strip lattice from boundary positions: R(w) = |mean exp(2 pi i b / w)| for w = 8..256 px
// in steps of 0.02; w = argmax n R^2. Accepted when n >= 30 and n R^2 >= 10. The origin is
// the phase of the mean.
export function latticeFold(bounds, wMin = 8, wMax = 256, step = 0.02) {
    const n = bounds.length;
    if (!n) return {accepted: false, n: 0, w: NaN, origin: NaN, R: 0, score: 0};
    let bestW = NaN, bestR = -1;
    const steps = round((wMax - wMin) / step);
    for (let i = 0; i <= steps; i++) {
        const w = wMin + i * step;
        let re = 0, im = 0;
        const k = 2 * PI / w;
        for (let j = 0; j < n; j++) { re += cos(k * bounds[j]); im += sin(k * bounds[j]); }
        const R = hypot(re, im) / n;
        if (R > bestR + 1e-12) { bestR = R; bestW = w; }
    }
    let re = 0, im = 0;
    for (let j = 0; j < n; j++) { re += cos(2 * PI * bounds[j] / bestW); im += sin(2 * PI * bounds[j] / bestW); }
    let origin = (atan2(im, re) / (2 * PI)) * bestW;
    origin = ((origin % bestW) + bestW) % bestW;
    const score = n * bestR * bestR;
    return {accepted: n >= 30 && score >= 10, n, w: bestW, origin, R: bestR, score};
}

// Probes inside a strip (at least `inset` px from both of its edges), with their target
// strip number ct and source strip number cs for lattice (w, o) and numbering offset k0.
function stripNumbers(map, w, o, k0, inset) {
    const ct = [], cs = [], idx = [];
    for (let t = 0; t < map.count; t++) {
        if (!map.confident[t]) continue;
        const x = map.x[t];
        const phase = (((x - o) % w) + w) % w;
        if (abs(phase - w / 2) > w / 2 - inset) continue;
        const a = floor((x - o) / w) + k0, b = floor((x + map.dl[t] - o) / w) + k0;
        if (a < 0 || b < 0) continue;
        ct.push(a); cs.push(b); idx.push(t);
    }
    return {ct, cs, idx};
}

// Confident probes of a map as flat arrays: target x and source x (= x + dl), in luma px.
function confidentProbes(map) {
    let n = 0;
    for (let t = 0; t < map.count; t++) if (map.confident[t]) n++;
    const xt = new Float64Array(n), xs = new Float64Array(n);
    n = 0;
    for (let t = 0; t < map.count; t++) {
        if (!map.confident[t]) continue;
        xt[n] = map.x[t]; xs[n] = map.x[t] + map.dl[t]; n++;
    }
    return {xt, xs, n};
}

// XOR fit of every map for one lattice (w, o), for all numbering offsets k0 in 0..63 at
// once. For each k0: how many maps have one XOR value d that explains >= 70% of their
// in-strip probes, the summed fit, and per map {d, fit, probes}.
function xorFitAllOffsets(probes, w, o, inset, scratch) {
    const K0 = 64;
    const good = new Int32Array(K0), fitSum = new Float64Array(K0);
    const perMap = [];
    const {a, b, counts} = scratch;
    for (const p of probes) {
        let m = 0;
        for (let i = 0; i < p.n; i++) {
            const rel = p.xt[i] - o;
            const phase = ((rel % w) + w) % w;
            if (abs(phase - w / 2) > w / 2 - inset) continue;
            a[m] = floor(rel / w);
            b[m] = floor((p.xs[i] - o) / w);
            m++;
        }
        const fits = new Array(K0);
        for (let k0 = 0; k0 < K0; k0++) {
            let used = 0, bestCount = 0, bestD = 0;
            for (let i = 0; i < m; i++) {
                const ct = a[i] + k0, cs = b[i] + k0;
                if (ct < 0 || cs < 0) continue;
                const d = (ct ^ cs) & 1023;
                const c = ++counts[d];
                used++;
                if (c > bestCount || (c === bestCount && d < bestD)) { bestCount = c; bestD = d; }
            }
            for (let i = 0; i < m; i++) {
                const ct = a[i] + k0, cs = b[i] + k0;
                if (ct >= 0 && cs >= 0) counts[(ct ^ cs) & 1023] = 0;
            }
            if (used >= 10) {
                const fit = bestCount / used;
                fits[k0] = {d: bestD, fit, probes: used};
                fitSum[k0] += fit;
                if (fit >= 0.7) good[k0]++;
            } else fits[k0] = null;
        }
        perMap.push(fits);
    }
    return {good, fitSum, perMap};
}

// Pure translation: the fraction of confident probes whose offset is within +-tolerance px
// of the most common offset.
function translationFit(map, tolerance) {
    const offsets = [];
    for (let t = 0; t < map.count; t++) if (map.confident[t]) offsets.push(map.dl[t]);
    if (offsets.length < 10) return null;
    let best = 0, bestCount = 0;
    for (const o of offsets) {
        let c = 0;
        for (const p of offsets) if (abs(p - o) <= tolerance) c++;
        if (c > bestCount || (c === bestCount && abs(o) < abs(best))) { bestCount = c; best = o; }
    }
    // the layer moved from source to target by -dl
    return {shift: -best, fit: bestCount / offsets.length, probes: offsets.length};
}

// Cyclic strip shift: cs = ct + k (mod strips).
function cyclicFit(map, w, o, strips, inset) {
    const {ct, cs} = stripNumbers(map, w, o, 0, inset);
    if (ct.length < 10 || strips < 2) return null;
    const counts = new Map();
    let bestK = 0, bestCount = 0;
    for (let i = 0; i < ct.length; i++) {
        const k = (((cs[i] - ct[i]) % strips) + strips) % strips;
        const c = (counts.get(k) ?? 0) + 1;
        counts.set(k, c);
        if (c > bestCount) { bestCount = c; bestK = k; }
    }
    return {k: bestK, fit: bestCount / ct.length, probes: ct.length};
}

// The re-ordering rule that explains the most pairs: XOR of strip numbers (searching the
// strip width within +-0.15 px, the origin in 0.5-px steps and the numbering offset k0 in
// 0..63), a cyclic strip shift, or a translation. A pair fits when one parameter explains
// >= 70% of its probes; a rule is reported when it fits >= 70% of the pairs.
export function fitRule(maps, lattice, {frameWidth = 0, inset = 6, colWidth = FINE_COLUMN_PX} = {}) {
    const usable = maps.filter(Boolean);
    const result = {kind: "none", fitPairs: 0, total: usable.length, pairs: usable.map(() => null), w: lattice?.w, origin: lattice?.origin, k0: 0};
    if (!usable.length) return result;
    // translation needs no lattice
    const translation = usable.map(map => translationFit(map, colWidth));
    const translationPairs = translation.filter(f => f && f.fit >= 0.7).length;
    let xor = null, cyclic = null;
    if (lattice?.accepted) {
        let best = null;
        const w0 = lattice.w;
        const probes = usable.map(confidentProbes);
        const maxProbes = max(1, ...probes.map(p => p.n));
        const scratch = {a: new Int32Array(maxProbes), b: new Int32Array(maxProbes), counts: new Int32Array(1024)};
        // The origin is searched near the phase of the strip edges at each width (+-2.5 px):
        // a change of width moves the edges far from x = 0, so the origin moves with it.
        const bounds = boundariesOf(usable);
        for (let wi = -15; wi <= 15; wi++) {
            const w = w0 + wi * 0.01;
            let center = lattice.origin;
            if (bounds.length) {
                let re = 0, im = 0;
                for (const b of bounds) { re += cos(2 * PI * b / w); im += sin(2 * PI * b / w); }
                center = atan2(im, re) / (2 * PI) * w;
            }
            for (let oi = -5; oi <= 5; oi++) {
                const o = (((round(center * 2) / 2 + oi * 0.5) % w) + w) % w;
                const all = xorFitAllOffsets(probes, w, o, inset, scratch);
                for (let k0 = 0; k0 < 64; k0++) {
                    const key = [all.good[k0], all.fitSum[k0], -abs(w - w0)];
                    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] + 1e-9
                        || (abs(key[1] - best.key[1]) <= 1e-9 && key[2] > best.key[2])))) {
                        best = {key, w, o, k0, fits: all.perMap.map(fits => fits[k0])};
                    }
                }
            }
        }
        xor = best;
        const strips = frameWidth > 0 ? max(2, round(frameWidth / w0)) : 0;
        cyclic = usable.map(map => cyclicFit(map, w0, lattice.origin, strips, inset));
    }
    const meanFit = (fits) => fits ? fits.reduce((s, f) => s + (f?.fit ?? 0), 0) / fits.length : 0;
    const total = usable.length;
    // The rule that explains the most pairs, then the higher mean fit (a cyclic shift also
    // looks like a translation for most strips), then the simpler rule.
    const candidates = [
        {name: "translation", count: translationPairs, mean: meanFit(translation)},
        {name: "cyclic", count: cyclic ? cyclic.filter(f => f && f.fit >= 0.7).length : 0, mean: meanFit(cyclic)},
        {name: "xor", count: xor ? xor.key[0] : 0, mean: xor ? xor.key[1] / total : 0},
    ];
    let kind = "none", fitPairs = 0, bestMean = -1;
    for (const c of candidates) {
        if (c.count > fitPairs || (c.count === fitPairs && c.count > 0 && c.mean > bestMean + 1e-9)) {
            kind = c.name; fitPairs = c.count; bestMean = c.mean;
        }
    }
    if (fitPairs < 0.7 * total) kind = "none";
    result.kind = kind;
    result.fitPairs = fitPairs;
    result.translation = translation;
    result.cyclic = cyclic;
    if (xor) {
        result.xor = xor.fits;
        result.w = xor.w; result.origin = xor.o; result.k0 = xor.k0;
    }
    result.pairs = usable.map((_, i) => ({
        translation: translation[i], xor: xor ? xor.fits[i] : null, cyclic: cyclic ? cyclic[i] : null,
    }));
    return result;
}

// Fit of one map at a fixed strip numbering (w, o, k0) — the numbering found for the whole
// run — so that the XOR value d of a single pair is comparable across pairs.
export function pairRuleFit(map, {w, o, k0 = 0, inset = 6, colWidth = FINE_COLUMN_PX} = {}) {
    if (!map) return {xor: null, translation: null};
    let xor = null;
    if (w > 0 && isNum(o)) {
        const {ct, cs} = stripNumbers(map, w, o, k0, inset);
        if (ct.length) {
            const counts = new Map();
            let bestD = 0, bestCount = 0;
            for (let i = 0; i < ct.length; i++) {
                const d = ct[i] ^ cs[i];
                const c = (counts.get(d) ?? 0) + 1;
                counts.set(d, c);
                if (c > bestCount || (c === bestCount && d < bestD)) { bestCount = c; bestD = d; }
            }
            xor = {d: bestD, fit: bestCount / ct.length, probes: ct.length};
        }
    }
    return {xor, translation: translationFit(map, colWidth)};
}

// Strip-by-strip assignment of one pair for display: for each target strip j of the
// lattice, the source strip k most of its confident probes point to, their share and mean
// margin, and the mean source x.
export function assignmentMap(map, w, o, k0 = 0, inset = 0) {
    if (!map || !(w > 0)) return [];
    const strips = new Map();
    for (let t = 0; t < map.count; t++) {
        if (!map.confident[t]) continue;
        const x = map.x[t];
        const phase = (((x - o) % w) + w) % w;
        if (abs(phase - w / 2) > w / 2 - inset) continue;
        const j = floor((x - o) / w) + k0;
        const k = floor((x + map.dl[t] - o) / w) + k0;
        let entry = strips.get(j);
        if (!entry) { entry = {target: j, votes: new Map(), margins: 0, sourceX: 0, count: 0}; strips.set(j, entry); }
        entry.votes.set(k, (entry.votes.get(k) ?? 0) + 1);
        entry.margins += map.margin[t];
        entry.sourceX += x + map.dl[t];
        entry.count++;
    }
    const rows = [];
    for (const entry of strips.values()) {
        let best = 0, bestK = 0;
        for (const [k, c] of entry.votes) if (c > best) { best = c; bestK = k; }
        rows.push({target: entry.target, source: bestK, share: best / entry.count, margin: entry.margins / entry.count,
            sourceX: entry.sourceX / entry.count, probes: entry.count,
            x0: (entry.target - k0) * w + o, x1: (entry.target - k0 + 1) * w + o,
            sx0: (bestK - k0) * w + o, sx1: (bestK - k0 + 1) * w + o});
    }
    rows.sort((a, b) => a.target - b.target);
    return rows;
}

// Runs of confident probes with one offset, for display when no lattice was found.
export function offsetSegments(map, tolerance = 4) {
    const segments = [];
    if (!map) return segments;
    let current = null;
    for (let t = 0; t < map.count; t++) {
        if (!map.confident[t]) continue;
        const half = map.wp * map.colWidth / 2;
        if (current && abs(map.dl[t] - current.dl) <= tolerance && map.x[t] - half <= current.x1 + map.colWidth * 3) {
            current.x1 = map.x[t] + half;
            current.marginSum += map.margin[t];
            current.count++;
        } else {
            if (current) segments.push(current);
            current = {x0: map.x[t] - half, x1: map.x[t] + half, dl: map.dl[t], marginSum: map.margin[t], count: 1};
        }
    }
    if (current) segments.push(current);
    return segments.map(s => ({...s, margin: s.marginSum / s.count, sx0: s.x0 + s.dl, sx1: s.x1 + s.dl}));
}

// ---------------------------------------------------------------------------------------
// Decode planning

// H.264 random access. The MP4 sync-sample table can mark a chunk as a key frame when it
// holds a non-IDR I slice (NAL type 1) and not an IDR (type 5). Playback survives a cold
// start there because the hardware decoder conceals the missing references, but a decoder
// started cold fails on the frames that follow (they reference pictures before the chunk),
// and the software decoder reports "Decoding error". So a decode segment may only start at
// a chunk that holds an IDR. For avc1/avc3 the chunk data is NAL units with a length
// prefix of lengthSize bytes (avcC byte 4, low two bits, plus one).
export function avcNalLengthSize(description) {
    if (!description) return 4;
    const bytes = description instanceof Uint8Array ? description
        : new Uint8Array(description.buffer ?? description, description.byteOffset ?? 0, description.byteLength);
    return bytes.length > 4 ? (bytes[4] & 3) + 1 : 4;
}

// True when the chunk holds an IDR slice, or when it holds no slice that can be read (an
// Annex B stream or malformed data: keep the sync-sample table's word). False when it holds
// only non-IDR slices.
export function avcChunkHasIdr(bytes, lengthSize = 4) {
    let p = 0, sawSlice = false;
    while (p + lengthSize <= bytes.length) {
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = len * 256 + bytes[p + i];
        p += lengthSize;
        if (len <= 0 || p + len > bytes.length) return !sawSlice;
        const type = bytes[p] & 0x1f;
        if (type === 5) return true;
        if (type === 1) sawSlice = true;
        p += len;
    }
    return !sawSlice;
}

// Splits the video into decode segments of whole key-frame groups.
//   groupStarts[g]  decode index of the key chunk of group g (ascending)
//   displayOf[c]    display index of chunk c (-1 when unknown)
//   range           [from, to] display indices to keep (inclusive)
// A segment keeps display indices [D(g0), D(g1)), where D(g) is the display index of the
// key chunk of group g. For an open GOP it also decodes the next key chunk and the chunks
// after it that are shown before it. Chunks before the first key chunk cannot be decoded.
export function planSegments(groupStarts, displayOf, chunkCount, range, segmentCount) {
    const G = groupStarts.length;
    if (!G) return [];
    const D = groupStarts.map(c => displayOf[c]);
    let maxDisplay = -1;
    for (let c = 0; c < chunkCount; c++) if (displayOf[c] > maxDisplay) maxDisplay = displayOf[c];
    const keepEnd = (g) => g + 1 < G ? D[g + 1] : maxDisplay + 1;
    const decodeEnd = (g1) => {
        if (g1 >= G) return chunkCount;
        let extra = 0;
        const start = groupStarts[g1];
        const limit = g1 + 1 < G ? groupStarts[g1 + 1] : chunkCount;
        for (let c = start + 1; c < limit && displayOf[c] >= 0 && displayOf[c] < D[g1]; c++) extra++;
        return extra ? start + 1 + extra : start;
    };
    const from = range?.from ?? 0, to = range?.to ?? maxDisplay;
    const groups = [];
    for (let g = 0; g < G; g++) if (keepEnd(g) > from && D[g] <= to) groups.push(g);
    if (!groups.length) return [];
    const per = max(1, round(groups.length / max(1, segmentCount)));
    const segments = [];
    for (let i = 0; i < groups.length; i += per) {
        const g0 = groups[i], g1 = groups[min(groups.length, i + per) - 1] + 1;
        const keepFrom = max(D[g0], from), keepTo = min(keepEnd(g1 - 1), to + 1);
        if (keepTo <= keepFrom) continue;
        segments.push({g0, g1, decodeFrom: groupStarts[g0], decodeTo: decodeEnd(g1), keepFrom, keepTo});
    }
    return segments;
}

// The chunks to decode for random access to some display indices: for each needed frame,
// from the key chunk of its group up to the last chunk shown at or before it in that group
// (plus the open-GOP chunks). Frames of one group share one run.
export function planFrameDecodes(groupStarts, displayOf, chunkCount, wanted) {
    const G = groupStarts.length;
    const D = groupStarts.map(c => displayOf[c]);
    let maxDisplay = -1;
    for (let c = 0; c < chunkCount; c++) if (displayOf[c] > maxDisplay) maxDisplay = displayOf[c];
    const chunkOf = new Int32Array(maxDisplay + 1).fill(-1);
    for (let c = 0; c < chunkCount; c++) if (displayOf[c] >= 0) chunkOf[displayOf[c]] = c;
    const byGroup = new Map();
    for (const d of wanted) {
        if (d < 0 || d > maxDisplay || chunkOf[d] < 0) continue;
        // the group whose keep range [D(g), D(g+1)) holds d
        let g = -1;
        for (let i = 0; i < G; i++) if (D[i] <= d) g = i; else break;
        if (g < 0) continue;
        let run = byGroup.get(g);
        if (!run) { run = {group: g, decodeFrom: groupStarts[g], decodeTo: groupStarts[g] + 1, targets: []}; byGroup.set(g, run); }
        // decoding in decode order up to the frame's own chunk includes all its references
        run.decodeTo = max(run.decodeTo, chunkOf[d] + 1);
        if (!run.targets.includes(d)) run.targets.push(d);
    }
    return [...byGroup.values()].map(run => ({...run, targets: run.targets.sort((a, b) => a - b)}))
        .sort((a, b) => a.decodeFrom - b.decodeFrom);
}
