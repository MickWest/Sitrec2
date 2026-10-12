import {rotatedUV} from '../videoTonal/TonalStatistics';

export const FREQUENCY_FIELDS = ['flux', 'background', 'area', 'clippedFraction'];

// Signed, background-subtracted aperture flux. Fractional edge pixels reduce the
// brightness modulation caused by a small target crossing the pixel grid.
export function measurePointFlux(pixels, width, height, excluded, target, rotation = 0, limits = [0, 255]) {
    const empty = {flux: NaN, background: NaN, area: 0, clippedFraction: 0};
    if (!target) return empty;
    const [u, v] = rotatedUV(target.u, target.v, (360 - rotation) % 360);
    const swap = rotation === 90 || rotation === 270;
    const rx = (swap ? target.ry : target.rx) * width;
    const ry = (swap ? target.rx : target.ry) * height;
    const cx = u * width, cy = v * height;
    if (!(rx > 0 && ry > 0) || cx - rx < 0 || cy - ry < 0 || cx + rx > width || cy + ry > height) return empty;
    const ring = [];
    let sum = 0, area = 0, clipped = 0, masked = false;
    const edge = Math.hypot(.5 / rx, .5 / ry);
    for (let y = Math.max(0, Math.floor(cy - 2.5 * ry)); y < Math.min(height, Math.ceil(cy + 2.5 * ry)); y++) {
        for (let x = Math.max(0, Math.floor(cx - 2.5 * rx)); x < Math.min(width, Math.ceil(cx + 2.5 * rx)); x++) {
            const d = Math.hypot((x + .5 - cx) / rx, (y + .5 - cy) / ry);
            const i = y * width + x;
            if (d >= 1.75 && d <= 2.5 && !excluded?.[i]) ring.push(pixels[i]);
            if (d - edge >= 1) continue;
            let weight = 1;
            if (d + edge > 1) {
                let inside = 0;
                for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
                    const dx = (x + (sx + .5) / 8 - cx) / rx;
                    const dy = (y + (sy + .5) / 8 - cy) / ry;
                    if (dx * dx + dy * dy <= 1) inside++;
                }
                weight = inside / 64;
            }
            if (!weight) continue;
            if (excluded?.[i]) masked = true;
            sum += weight * pixels[i]; area += weight;
            if (pixels[i] <= limits[0] || pixels[i] >= limits[1]) clipped += weight;
        }
    }
    // A changing aperture caused by exclusions would introduce its own flicker.
    if (masked || !area || ring.length < 16) return empty;
    ring.sort((a, b) => a - b);
    const middle = ring.length >> 1;
    const background = ring.length % 2 ? ring[middle] : (ring[middle - 1] + ring[middle]) / 2;
    return {flux: sum - area * background, background, area, clippedFraction: clipped / area};
}

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let length = 2; length <= n; length *= 2) {
        const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
        for (let i = 0; i < n; i += length) {
            let ar = 1, ai = 0;
            for (let k = 0; k < length / 2; k++) {
                const a = i + k, b = a + length / 2;
                const br = re[b] * ar - im[b] * ai, bi = re[b] * ai + im[b] * ar;
                re[b] = re[a] - br; im[b] = im[a] - bi;
                re[a] += br; im[a] += bi;
                const next = ar * wr - ai * wi;
                ai = ar * wi + ai * wr; ar = next;
            }
        }
    }
}

export function amplitudeSpectrum(values, fps) {
    const count = values.length;
    if (count < 16 || !(fps > 0) || !Number.isFinite(fps)) throw new Error('At least 16 uniformly timed samples are required');
    let mean = 0, covariance = 0, variance = 0;
    for (const value of values) {
        if (!Number.isFinite(value)) throw new Error('The selected range contains missing brightness samples');
        mean += value / count;
    }
    for (let i = 0; i < count; i++) {
        const x = i - (count - 1) / 2;
        covariance += x * (values[i] - mean); variance += x * x;
    }
    const slope = covariance / variance;
    // Padding interpolates the spectrum; the independent bin spacing is fps/N.
    let size = 1;
    while (size < 4 * count) size *= 2;
    const re = new Float64Array(size), im = new Float64Array(size);
    let weight = 0;
    for (let i = 0; i < count; i++) {
        const window = .5 - .5 * Math.cos(2 * Math.PI * i / (count - 1));
        re[i] = (values[i] - mean - slope * (i - (count - 1) / 2)) * window;
        weight += window;
    }
    fft(re, im);
    const frequencies = new Float64Array(size / 2 + 1), amplitude = new Float64Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
        frequencies[i] = i * fps / size;
        amplitude[i] = Math.hypot(re[i], im[i]) * (i === 0 || i === size / 2 ? 1 : 2) / weight;
    }
    let peak = Math.ceil(size / count);
    for (let i = peak + 1; i < amplitude.length; i++) if (amplitude[i] > amplitude[peak]) peak = i;
    return {frequencies, amplitude, mean, count, fps, duration: count / fps,
        binSpacing: fps / count, nyquist: fps / 2,
        peak: amplitude[peak] > 1e-9 ? {frequency: frequencies[peak], amplitude: amplitude[peak]} : null};
}

// Presentation timestamps, rather than scene playback speed, set the frequency
// scale. Held duplicate frames are measured once; skipped/nonuniform frames fail.
export function frequencySampling(source, indices) {
    if (indices.length < 16) throw new Error('Select at least 16 source frames with the In/Out markers');
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1) throw new Error('The selected range skips source frames');
    }
    const timestamps = new Map();
    source.chunks.forEach((chunk, index) => timestamps.set(source.timestampToChunkIndex?.get(chunk.timestamp) ?? index, chunk.timestamp));
    const times = indices.map(i => timestamps.get(i));
    const step = (times[times.length - 1] - times[0]) / (times.length - 1);
    if (!(step > 0) || times.some((time, i) => !Number.isFinite(time)
        || (i > 0 && Math.abs(time - times[i - 1] - step) > Math.max(2, step * .01)))) {
        throw new Error('The selected range has irregular frame timing; choose a continuous section');
    }
    return {fps: 1e6 / step, times: times.map(time => (time - times[0]) / 1e6)};
}

export function captureFrequencyTargets({frame0, frame1, positions, rawPositions = positions, width, height, radius, displayIndex}) {
    if (!(width > 0 && height > 0)) throw new Error('Video dimensions are unavailable');
    const selected = new Set(), targets = {};
    for (let frame = frame0; frame <= frame1; frame++) {
        const index = displayIndex(frame);
        selected.add(index);
        const raw = rawPositions?.get(frame), point = positions?.get(frame);
        if (!raw || raw.estimated || rawPositions.unmeasuredFrames?.has(frame)
            || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
        targets[index] ??= {u: point.x / width, v: point.y / height, rx: radius / width, ry: radius / height};
    }
    // Preserve order so reversed or cut/held timelines cannot masquerade as an
    // evenly sampled signal. Duplicate playback slots contribute only once.
    const indices = Array.from(selected);
    const missing = indices.filter(index => !targets[index]).length;
    if (missing) throw new Error(`${missing} source frame(s) lack measured Point Track positions. Track them or narrow In/Out`);
    return {targets, indices};
}

export function frequencyDecodeRange(source, first, last) {
    let start = Infinity, end = -1;
    source.chunks.forEach((chunk, index) => {
        const display = source.timestampToChunkIndex?.get(chunk.timestamp) ?? index;
        if (display >= first && display <= last) { start = Math.min(start, index); end = Math.max(end, index); }
    });
    if (end < 0) throw new Error('No encoded frames in the selected range');
    while (start > 0 && source.chunks[start].type !== 'key') start--;
    return {start, end: end + 1};
}
