// An additional translation search. Column-period detection remains independent.
// FFT peaks only propose offsets; every reported patch is checked without wrapping,
// on local pixels, at its own source and destination coordinates.

const plans = new Map();
const pow2 = n => { let p = 1; while (p < n) p *= 2; return p; };

function fftPlan(n) {
    if (plans.has(n)) return plans.get(n);
    const rev = new Uint32Array(n), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
        let a = i, b = 0;
        for (let k = 0; k < bits; k++, a >>>= 1) b = (b << 1) | (a & 1);
        rev[i] = b;
    }
    for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
    const p = {rev, cs, sn}; plans.set(n, p); return p;
}

function fftLine(re, im, start, stride, n, inverse) {
    const {rev, cs, sn} = fftPlan(n);
    for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j <= i) continue;
        const a = start + i * stride, b = start + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t; t = im[a]; im[a] = im[b]; im[b] = t;
    }
    for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let a = 0; a < n; a += size) for (let k = 0; k < half; k++) {
            const p = start + (a + k) * stride, q = p + half * stride;
            const wr = cs[k * step], wi = (inverse ? 1 : -1) * sn[k * step];
            const tr = re[q] * wr - im[q] * wi, ti = re[q] * wi + im[q] * wr;
            re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        }
    }
    if (inverse) for (let i = 0, p = start; i < n; i++, p += stride) { re[p] /= n; im[p] /= n; }
}

export function fft2(re, im, width, height, inverse = false) {
    for (let y = 0; y < height; y++) fftLine(re, im, y * width, 1, width, inverse);
    for (let x = 0; x < width; x++) fftLine(re, im, x, width, height, inverse);
}

export function gaussianImage(a, width, height, sigma) {
    const radius = Math.ceil(3 * sigma), kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let x = -radius; x <= radius; x++) { const v = Math.exp(-x * x / (2 * sigma * sigma)); kernel[x + radius] = v; sum += v; }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const temp = new Float32Array(a.length), out = new Float32Array(a.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let v = 0;
        for (let d = -radius; d <= radius; d++) v += a[y * width + Math.max(0, Math.min(width - 1, x + d))] * kernel[d + radius];
        temp[y * width + x] = v;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let v = 0;
        for (let d = -radius; d <= radius; d++) v += temp[Math.max(0, Math.min(height - 1, y + d)) * width + x] * kernel[d + radius];
        out[y * width + x] = v;
    }
    return out;
}

// Area averages are computed on the native plane, with its actual row stride and
// subsampling. Values remain in equivalent 8-bit sample units, including 10/12-bit input.
export function offsetPlane(frame, plane, lumaStep = 4) {
    const d = frame.descriptors.planes[plane], shift = frame.descriptors.shift || 0;
    const sx = d.sx || 1, sy = d.sy || 1;
    const bx = Math.max(1, Math.round(lumaStep / sx)), by = Math.max(1, Math.round(lumaStep / sy));
    const width = Math.floor(d.width / bx), height = Math.floor(d.height / by), pixels = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let j = 0; j < by; j++) {
            let pos = d.offset + (y * by + j) * d.stride + x * bx * d.step;
            for (let i = 0; i < bx; i++, pos += d.step) sum += frame.data[pos] / (2 ** shift);
        }
        pixels[y * width + x] = sum / (bx * by);
    }
    return {width, height, scaleX: bx * sx, scaleY: by * sy, pixels};
}

function integral(a, w, h, square = false) {
    const out = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) { const v = a[y * w + x]; row += square ? v * v : v; out[(y + 1) * (w + 1) + x + 1] = out[y * (w + 1) + x + 1] + row; }
    }
    return out;
}

function rectSum(ii, width, x, y, w, h) {
    const stride = width + 1, a = y * stride + x, b = (y + h) * stride + x;
    return ii[b + w] - ii[b] - ii[a + w] + ii[a];
}

export function differenceResidual(current, previous) {
    const {width: w, height: h, pixels} = current;
    if (previous.width !== w || previous.height !== h) throw new Error('Offset frame dimensions differ');
    const delta = Float32Array.from(pixels, (v, i) => v - previous.pixels[i]);
    const small = gaussianImage(delta, w, h, 0.5), broad = gaussianImage(delta, w, h, 1.5);
    const residual = Float32Array.from(small, (v, i) => v - broad[i]);
    const samples = [];
    for (let i = 0; i < delta.length; i += Math.max(1, Math.floor(delta.length / 4096))) samples.push(Math.abs(delta[i]));
    samples.sort((a, b) => a - b);
    const cutoff = Math.max(7, 6 * (samples[samples.length >> 1] || 0));
    const bad = Uint8Array.from(delta, v => Math.abs(v) > cutoff ? 1 : 0), badII = integral(bad, w, h);
    const valid = new Uint8Array(delta.length), border = 4, radius = 3;
    for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
        valid[y * w + x] = rectSum(badII, w, x - radius, y - radius, 2 * radius + 1, 2 * radius + 1) === 0 ? 1 : 0;
    }
    return {...current, pixels: residual, valid, cutoff};
}

export function offsetSpectrum(image) {
    // Linear correlation: pad beyond 2*size-1 in BOTH axes. No circular matches.
    const w = Math.floor(image.width / 2), h = Math.floor(image.height / 2);
    const fw = pow2(2 * w - 1), fh = pow2(2 * h - 1);
    const re = new Float32Array(fw * fh), im = new Float32Array(fw * fh);
    let energy = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 0, n = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
            const k = (2 * y + j) * image.width + 2 * x + i;
            if (image.valid[k]) { v += image.pixels[k]; n++; }
        }
        v = n === 4 ? v / 4 : 0;
        re[y * fw + x] = v; energy += v * v;
    }
    fft2(re, im, fw, fh);
    return {re, im, width: w, height: h, fw, fh, energy};
}

export function translationPeaks(source, target, count = 4) {
    if (source.fw !== target.fw || source.fh !== target.fh) throw new Error('Offset spectrum dimensions differ');
    const {fw, fh, width: w, height: h} = source;
    const re = new Float32Array(fw * fh), im = new Float32Array(fw * fh);
    const norm = Math.sqrt(source.energy * target.energy);
    if (!(norm > 0.01)) return [];
    for (let i = 0; i < re.length; i++) {
        re[i] = target.re[i] * source.re[i] + target.im[i] * source.im[i];
        im[i] = target.im[i] * source.re[i] - target.re[i] * source.im[i];
    }
    fft2(re, im, fw, fh, true);
    const peaks = [];
    for (let k = 0; k < count; k++) {
        let best = 0, bx = 0, by = 0;
        for (let dy = -h + 8; dy <= h - 8; dy++) for (let dx = -w + 8; dx <= w - 8; dx++) {
            const x = dx < 0 ? fw + dx : dx, y = dy < 0 ? fh + dy : dy;
            const v = re[y * fw + x];
            if (v > best) { best = v; bx = dx; by = dy; }
        }
        if (!(best > 0)) break;
        peaks.push({dx: 2 * bx, dy: 2 * by, score: best / norm});
        for (let y = by - 2; y <= by + 2; y++) for (let x = bx - 2; x <= bx + 2; x++) {
            re[((y + fh) % fh) * fw + ((x + fw) % fw)] = -Infinity;
        }
    }
    return peaks;
}

export function patchCorrelation(a, b, ax, ay, bx, by, w, h) {
    if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax + w > a.width || bx + w > b.width || ay + h > a.height || by + h > b.height) return NaN;
    let sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const va = a.pixels[(ay + y) * a.width + ax + x], vb = b.pixels[(by + y) * b.width + bx + x];
        sa += va; sb += vb; aa += va * va; bb += vb * vb; ab += va * vb;
    }
    const n = w * h, va = aa - sa * sa / n, vb = bb - sb * sb / n;
    if (va / n < 0.005 || vb / n < 0.005) return NaN;
    return (ab - sa * sb / n) / Math.sqrt(va * vb);
}

// Participation rank of a mean-centered patch. A smooth edge or separable ramp
// can correlate almost perfectly yet contain very little texture. This screening
// measure treats horizontal and vertical patches symmetrically; it is not a test
// for synthetic noise, and it is not invariant to arbitrary image rotation.
export function patchTextureRank(image, x, y, width, height) {
    const rows = Math.max(width, height), cols = Math.min(width, height);
    const a = new Float64Array(rows * cols);
    let mean = 0;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) mean += image.pixels[(y + j) * image.width + x + i];
    mean /= width * height;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
        a[width <= height ? j * cols + i : i * cols + j] = image.pixels[(y + j) * image.width + x + i] - mean;
    }
    let energy = 0, gramEnergy = 0;
    for (let i = 0; i < cols; i++) for (let j = i; j < cols; j++) {
        let dot = 0;
        for (let k = 0; k < rows; k++) dot += a[k * cols + i] * a[k * cols + j];
        if (i === j) energy += dot;
        gramEnergy += dot * dot * (i === j ? 1 : 2);
    }
    return gramEnergy > 1e-12 ? energy * energy / gramEnergy : 0;
}

export function confirmOffsetPatches(source, target, peak, limit = 3) {
    const w = source.width, h = source.height, candidates = [];
    // Only the few proposed pairs need integral images; do not retain these for
    // every sampled frame and every color plane.
    for (const image of [source, target]) {
        image.sums ??= integral(image.pixels, w, h);
        image.squares ??= integral(image.pixels, w, h, true);
    }
    // Narrow horizontal/vertical tiles plus a square; no case-specific region.
    const shapes = [[4, 32], [32, 4], [12, 12]];
    for (let dy = peak.dy - 1; dy <= peak.dy + 1; dy++) for (let dx = peak.dx - 1; dx <= peak.dx + 1; dx++) {
        const products = new Float32Array(w * h), overlap = new Uint8Array(w * h);
        for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
            const a = y * w + x, b = (y + dy) * w + x + dx;
            products[a] = source.pixels[a] * target.pixels[b]; overlap[a] = source.valid[a] && target.valid[b] ? 1 : 0;
        }
        const cross = integral(products, w, h), valid = integral(overlap, w, h);
        for (const [pw, ph] of shapes) {
            const n = pw * ph;
            for (let y = 4; y + ph < h - 4; y += 4) for (let x = 4; x + pw < w - 4; x += 4) {
                const tx = x + dx, ty = y + dy;
                if (tx < 4 || ty < 4 || tx + pw >= w - 4 || ty + ph >= h - 4 || rectSum(valid, w, x, y, pw, ph) < n) continue;
                const sa = rectSum(source.sums, w, x, y, pw, ph), sb = rectSum(target.sums, w, tx, ty, pw, ph);
                const va = rectSum(source.squares, w, x, y, pw, ph) - sa * sa / n;
                const vb = rectSum(target.squares, w, tx, ty, pw, ph) - sb * sb / n;
                if (va / n < 0.02 || vb / n < 0.02) continue;
                const score = (rectSum(cross, w, x, y, pw, ph) - sa * sb / n) / Math.sqrt(va * vb);
                if (score < 0.62) continue;
                const halfW = pw >= ph ? pw / 2 : pw, halfH = ph > pw ? ph / 2 : ph;
                const first = patchCorrelation(source, target, x, y, tx, ty, halfW, halfH);
                const ox = pw - halfW, oy = ph - halfH;
                const second = patchCorrelation(source, target, x + ox, y + oy, tx + ox, ty + oy, halfW, halfH);
                if (!(first > 0.35 && second > 0.35)) continue;
                if (patchTextureRank(source, x, y, pw, ph) < 1.5 || patchTextureRank(target, tx, ty, pw, ph) < 1.5) continue;
                candidates.push({x, y, tx, ty, width: pw, height: ph, dx, dy, score, halves: [first, second], proposal: peak.score});
            }
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of candidates) {
        if (kept.some(k => Math.abs(k.x - c.x) < Math.max(k.width, c.width) && Math.abs(k.y - c.y) < Math.max(k.height, c.height))) continue;
        kept.push(c); if (kept.length === limit) break;
    }
    return kept;
}

// Sample genuine picture transitions, retaining the LAST decoded frame of each hold.
// Neighbors used for differencing are always the preceding distinct picture, even
// when the sampled pictures themselves are widely separated.
export function planOffsetFrames(decoded, held, from = 0, maxPictures = 128) {
    const starts = [];
    for (let i = 0; i < decoded.length; i++) if (decoded[i] && (!held[i] || !starts.length)) starts.push(i);
    const ends = starts.map((s, i) => {
        let e = (starts[i + 1] ?? decoded.length) - 1;
        while (e > s && !decoded[e]) e--;
        return e + from;
    });
    const n = Math.min(maxPictures, Math.max(0, ends.length - 1)), selected = [];
    // A uniform-only grid can alias a loop period. Reserve a contiguous pilot
    // for nearby phases, then distribute the remaining budget through the clip.
    const pilot = Math.min(64, Math.floor(n / 2)), spread = n - pilot;
    for (let k = 0; k < n; k++) {
        const index = k < pilot ? k + 1 : pilot + 1 + Math.floor((k - pilot) * (ends.length - 1 - pilot) / spread);
        selected.push({index, frame: ends[index], previous: ends[index - 1]});
    }
    return {pictures: ends.length, pilot, selected, targets: [...new Set(selected.flatMap(s => [s.previous, s.frame]))].sort((a, b) => a - b)};
}

export function offsetPairs(frames, longestLag, pictures = false) {
    const out = [];
    for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
        const lag = pictures ? frames[b].index - frames[a].index : frames[b].frame - frames[a].frame;
        // Adjacent differences share a picture. Skip those, but do not inherit
        // the column filter's 17-frame exclusion: this filter has no such window.
        if (frames[b].index - frames[a].index >= 2 && lag > 0 && lag <= longestLag) out.push([a, b]);
    }
    return out;
}
