// Bounded 2-D retrieval followed by independent, native-resolution refinement.
// Scores are correlations, not false-positive probabilities or authenticity verdicts.
import {confirmOffsetPatches, differenceResidual, gaussianImage, offsetSpectrum, patchCorrelation, patchTextureRank, translationPeaks} from "./NoiseOffsetMath";

function diverseShortlist(entries, limit) {
    const groups = new Map();
    for (const item of entries) {
        if (!groups.has(item.band)) groups.set(item.band, []);
        groups.get(item.band).push(item);
    }
    const lists = [...groups.values()].map(g => g.sort((a, b) => b.score - a.score));
    const result = [];
    for (let round = 0; result.length < limit; round++) {
        let added = false;
        for (const list of lists) if (list[round] && result.length < limit) { result.push(list[round]); added = true; }
        if (!added) break;
    }
    return result;
}

export function searchOffsets(frames, pairs, onProgress = () => {}) {
    const images = frames.map(f => differenceResidual(f.current, f.previous));
    const spectra = new Map();
    let proposals = [];
    const spectrum = index => {
        if (!spectra.has(index)) {
            // Bound FFT storage independently of the video length.
            if (spectra.size >= 24) spectra.delete(spectra.keys().next().value);
            spectra.set(index, offsetSpectrum(images[index]));
        }
        return spectra.get(index);
    };
    let tested = 0;
    for (const [a, b] of pairs) {
        const peaks = translationPeaks(spectrum(a), spectrum(b), 4);
        const lag = (frames[b].index ?? b) - (frames[a].index ?? a), band = Math.floor(Math.log2(Math.max(1, lag)));
        for (const peak of peaks) if (peak.score >= 0.04) proposals.push({a, b, band, ...peak});
        // A bounded shortlist prevents local refinement from growing with duration.
        if (proposals.length > 384) proposals = diverseShortlist(proposals, 192);
        if (++tested % 16 === 0) onProgress(tested);
    }
    // Reserve space across logarithmic lag ranges so short-term scene motion
    // cannot consume every long-lag retrieval slot.
    proposals = diverseShortlist(proposals, 48);
    const candidates = [];
    for (const p of proposals) {
        for (const patch of confirmOffsetPatches(images[p.a], images[p.b], p)) {
            candidates.push({...patch, a: p.a, b: p.b, band: p.band, scaleX: images[p.a].scaleX, scaleY: images[p.a].scaleY});
        }
        // These can be recreated cheaply if the image occurs in another proposal.
        for (const index of [p.a, p.b]) { delete images[index].sums; delete images[index].squares; }
    }
    const ranked = diverseShortlist(candidates, candidates.length);
    const kept = [];
    for (const c of ranked) {
        if (kept.filter(k => k.a === c.a && k.b === c.b).length >= 2) continue;
        if (kept.some(k => k.a === c.a && k.b === c.b && Math.abs(k.x - c.x) < c.width && Math.abs(k.y - c.y) < c.height)) continue;
        kept.push(c); if (kept.length >= 24) break;
    }
    onProgress(tested);
    return {candidates: kept, pairs: tested, proposals: proposals.length};
}

// Crop at native plane resolution, retaining padding for filtering and refinement.
export function offsetCrop(frame, request) {
    const d = frame.descriptors.planes[request.plane], sx = d.sx || 1, sy = d.sy || 1;
    const margin = 24, x = Math.max(0, Math.floor(request.x / sx) - margin), y = Math.max(0, Math.floor(request.y / sy) - margin);
    const right = Math.min(d.width, Math.ceil((request.x + request.width) / sx) + margin);
    const bottom = Math.min(d.height, Math.ceil((request.y + request.height) / sy) + margin);
    const width = right - x, height = bottom - y, pixels = new Float32Array(width * height);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
        pixels[j * width + i] = frame.data[d.offset + (y + j) * d.stride + (x + i) * d.step] / (2 ** (frame.descriptors.shift || 0));
    }
    return {width, height, pixels, x, y, scaleX: sx, scaleY: sy};
}

function nativeResidual(current, previous) {
    if (!current || !previous || current.width !== previous.width || current.height !== previous.height) return null;
    const delta = Float32Array.from(current.pixels, (v, i) => v - previous.pixels[i]);
    const fine = gaussianImage(delta, current.width, current.height, 1);
    const broad = gaussianImage(delta, current.width, current.height, 6);
    return {...current, pixels: Float32Array.from(fine, (v, i) => v - broad[i])};
}

function cropPixels(image, x, y, width, height) {
    const pixels = new Float32Array(width * height);
    for (let j = 0; j < height; j++) pixels.set(image.pixels.subarray((y + j) * image.width + x, (y + j) * image.width + x + width), j * width);
    return {width, height, pixels};
}

function comparisonFields(current, previous, residual) {
    const mean = Float32Array.from(current.pixels, (v, i) => (v + previous.pixels[i]) / 2);
    const broad = gaussianImage(mean, current.width, current.height, 6);
    const fine = gaussianImage(mean, current.width, current.height, 1);
    const band = Float32Array.from(fine, (v, i) => v - broad[i]);
    const image = pixels => ({...current, pixels});
    return {broad: image(broad), band: image(band),
        current: image(Float32Array.from(band, (v, i) => v + residual.pixels[i] / 2)),
        previous: image(Float32Array.from(band, (v, i) => v - residual.pixels[i] / 2))};
}

// Compare the surrounding photograph, excluding the proposed patch. Use only
// offsets available in BOTH padded crops, including at image edges.
function contextCorrelation(a, b, x, y, tx, ty, width, height) {
    const left = Math.min(20, x, tx), top = Math.min(20, y, ty);
    const right = Math.min(20, a.width - x - width, b.width - tx - width);
    const bottom = Math.min(20, a.height - y - height, b.height - ty - height);
    let n = 0, sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
    for (let j = -top; j < height + bottom; j++) for (let i = -left; i < width + right; i++) {
        if (i >= 0 && i < width && j >= 0 && j < height) continue;
        const av = a.pixels[(y + j) * a.width + x + i], bv = b.pixels[(ty + j) * b.width + tx + i];
        n++; sa += av; sb += bv; aa += av * av; bb += bv * bv; ab += av * bv;
    }
    const va = aa - sa * sa / n, vb = bb - sb * sb / n;
    return n >= 64 && va > 1e-8 && vb > 1e-8 ? (ab - sa * sb / n) / Math.sqrt(va * vb) : NaN;
}

function screenOffset(crops, source, target, x, y, tx, ty, width, height) {
    const a = comparisonFields(crops[0], crops[1], source), b = comparisonFields(crops[2], crops[3], target);
    const correlate = (a, b) => patchCorrelation(a, b, x, y, tx, ty, width, height);
    const background = {band: correlate(a.band, b.band), broad: correlate(a.broad, b.broad),
        context: contextCorrelation(a.broad, b.broad, x, y, tx, ty, width, height)};
    const samePhase = [correlate(a.current, b.current), correlate(a.previous, b.previous)];
    const crossPhase = [correlate(a.current, b.previous), correlate(a.previous, b.current)];
    const phaseGain = Math.min(...samePhase) - Math.max(...crossPhase);
    // Conservative screening, not a noise classifier or significance test. A
    // matching photograph is ambiguous even when its temporal difference matches.
    // This can also hide genuine grain on repeated backgrounds; keep every raw
    // candidate for explicit review/export, separately from the default shortlist.
    const scene = Math.abs(background.band) >= 0.6 || background.broad >= 0.9 || background.context >= 0.9;
    const phase = samePhase.every(r => r > 0) && phaseGain >= 0.15;
    return {version: 1, passed: !scene && phase, reason: scene ? "background" : phase ? "passed" : "phase",
        background, samePhase, crossPhase, phaseGain};
}

export function verifyOffset(candidate, crops) {
    const source = nativeResidual(crops[0], crops[1]), target = nativeResidual(crops[2], crops[3]);
    if (!source || !target) return null;
    const sx = source.scaleX, sy = source.scaleY;
    const x = Math.round(candidate.x / sx) - source.x, y = Math.round(candidate.y / sy) - source.y;
    const tx = Math.round(candidate.tx / sx) - target.x, ty = Math.round(candidate.ty / sy) - target.y;
    const width = Math.round(candidate.width / sx), height = Math.round(candidate.height / sy);
    const rx = Math.ceil(candidate.step / sx), ry = Math.ceil(candidate.step / sy);
    let best = null;
    for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
        const score = patchCorrelation(source, target, x, y, tx + dx, ty + dy, width, height);
        if (!Number.isFinite(score) || best && score <= best.score) continue;
        best = {score, dx, dy};
    }
    if (!best || best.score < 0.6) return null;
    const bx = tx + best.dx, by = ty + best.dy;
    const hw = width >= height ? Math.floor(width / 2) : width, hh = height > width ? Math.floor(height / 2) : height;
    const first = patchCorrelation(source, target, x, y, bx, by, hw, hh);
    const ox = width - hw, oy = height - hh;
    const second = patchCorrelation(source, target, x + ox, y + oy, bx + ox, by + oy, hw, hh);
    if (!(first >= 0.4 && second >= 0.4)) return null;
    const textureRank = [patchTextureRank(source, x, y, width, height), patchTextureRank(target, bx, by, width, height)];
    if (textureRank.some(rank => rank < 1.5)) return null;
    const outX = (source.x + x) * sx, outY = (source.y + y) * sy;
    const outTX = (target.x + bx) * sx, outTY = (target.y + by) * sy;
    const screening = screenOffset(crops, source, target, x, y, bx, by, width, height);
    return {...candidate, x: outX, y: outY, tx: outTX, ty: outTY, width: width * sx, height: height * sy,
        dx: outTX - outX, dy: outTY - outY, score: best.score, halves: [first, second], textureRank, screening,
        sourceCrop: cropPixels(source, x, y, width, height), targetCrop: cropPixels(target, bx, by, width, height)};
}
