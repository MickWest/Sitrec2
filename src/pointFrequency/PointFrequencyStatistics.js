import {rotatedUV} from '../videoTonal/TonalStatistics';
import {
    isTrackedStatus, lineTrialError, positionBetween, sortedTrackFrames, TRACK_FRAME, trackFrameStatus,
} from '../PointTrackCoverage';

export const FREQUENCY_FIELDS = ['flux', 'background', 'area', 'clippedFraction'];

// The aperture's centre and radii in decoded pixels, and the box [x0, x1) ×
// [y0, y1) that holds it and its background ring: the only pixels that
// measurePointFlux reads. Null when the aperture leaves the image.
export function pointFluxGeometry(width, height, target, rotation = 0) {
    if (!target) return null;
    const [u, v] = rotatedUV(target.u, target.v, (360 - rotation) % 360);
    const swap = rotation === 90 || rotation === 270;
    const rx = (swap ? target.ry : target.rx) * width;
    const ry = (swap ? target.rx : target.ry) * height;
    const cx = u * width, cy = v * height;
    if (!(rx > 0 && ry > 0) || cx - rx < 0 || cy - ry < 0 || cx + rx > width || cy + ry > height) return null;
    return {cx, cy, rx, ry,
        x0: Math.max(0, Math.floor(cx - 2.5 * rx)), x1: Math.min(width, Math.ceil(cx + 2.5 * rx)),
        y0: Math.max(0, Math.floor(cy - 2.5 * ry)), y1: Math.min(height, Math.ceil(cy + 2.5 * ry))};
}

// Signed, background-subtracted aperture flux. Fractional edge pixels reduce the
// brightness modulation caused by a small target crossing the pixel grid.
export function measurePointFlux(pixels, width, height, excluded, target, rotation = 0, limits = [0, 255]) {
    const empty = {flux: NaN, background: NaN, area: 0, clippedFraction: 0};
    const box = pointFluxGeometry(width, height, target, rotation);
    if (!box) return empty;
    const {cx, cy, rx, ry} = box;
    const ring = [];
    let sum = 0, area = 0, clipped = 0, masked = false;
    const edge = Math.hypot(.5 / rx, .5 / ry);
    for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) {
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

// Fourier transform of samples at fractional positions p, at the same padded
// bins as fft(): X[k] = Σ s·exp(−2πi·k·p/size) for k = 0…size/2. Each sample
// keeps its real time; interpolating to even steps would attenuate fast
// signals (half-way between frames, a 10 Hz signal at 25 fps keeps about 0.3
// of its amplitude). A direct sum costs samples × size, which freezes the page
// for long clips, so this is a non-uniform FFT (Greengard & Lee 2004, Gaussian
// gridding): spread each sample onto a 2× oversampled grid with a Gaussian,
// run one FFT, then divide out the Gaussian's transform. The Gaussian is
// 5×10⁻¹³ of its peak at the edge of the spread, so the result matches the
// direct sum to about 1e-12 of its largest term.
export function irregularTransform(samples, positions, re, im) {
    const size = re.length, grid = 2 * size, spread = 12;
    const tau = Math.PI * spread / (size * size * 2 * 1.5);
    const step = 2 * Math.PI / grid;
    const gridRe = new Float64Array(grid), gridIm = new Float64Array(grid);
    for (let i = 0; i < samples.length; i++) {
        const x = 2 * Math.PI * positions[i] / size, nearest = Math.round(x / step);
        for (let m = nearest - spread; m <= nearest + spread; m++) {
            const d = x - m * step;
            gridRe[((m % grid) + grid) % grid] += samples[i] * Math.exp(-d * d / (4 * tau));
        }
    }
    fft(gridRe, gridIm);
    const scale = Math.sqrt(Math.PI / tau) / grid;
    for (let k = 0; k <= size / 2; k++) {
        const factor = scale * Math.exp(k * k * tau);
        re[k] = gridRe[k] * factor; im[k] = gridIm[k] * factor;
    }
}

// times (seconds) are given only for irregular frame timing. Each sample is
// then placed at its real time, in units of the mean frame step 1/fps.
// minPeakHz is the lowest frequency the peak search considers. Slow brightness
// drift that the linear detrend and Hann window leave can otherwise be labeled
// as the peak. The spectrum itself is the same for every floor. A floor at or
// above Nyquist leaves nothing to search: peak is null and peakFloorAboveNyquist
// is set.
export function amplitudeSpectrum(values, fps, times = null, {minPeakHz = 0} = {}) {
    const count = values.length;
    if (count < 16 || !(fps > 0) || !Number.isFinite(fps)) throw new Error('At least 16 timed samples are required');
    const positions = times ? Array.from(times, time => (time - times[0]) * fps) : null;
    const position = i => positions ? positions[i] : i;
    let mean = 0, center = 0, covariance = 0, variance = 0;
    for (let i = 0; i < count; i++) {
        if (!Number.isFinite(values[i])) throw new Error('The selected range contains missing brightness samples');
        mean += values[i] / count; center += position(i) / count;
    }
    for (let i = 0; i < count; i++) {
        const x = position(i) - center;
        covariance += x * (values[i] - mean); variance += x * x;
    }
    const slope = covariance / variance;
    // Padding interpolates the spectrum; the independent bin spacing is fps/N.
    let size = 1;
    while (size < 4 * count) size *= 2;
    const re = new Float64Array(size), im = new Float64Array(size);
    const samples = new Float64Array(count);
    let weight = 0;
    for (let i = 0; i < count; i++) {
        const window = .5 - .5 * Math.cos(2 * Math.PI * position(i) / (count - 1));
        samples[i] = (values[i] - mean - slope * (position(i) - center)) * window;
        weight += window;
    }
    if (positions) irregularTransform(samples, positions, re, im);
    else { re.set(samples); fft(re, im); }
    const frequencies = new Float64Array(size / 2 + 1), amplitude = new Float64Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
        frequencies[i] = i * fps / size;
        amplitude[i] = Math.hypot(re[i], im[i]) * (i === 0 || i === size / 2 ? 1 : 2) / weight;
    }
    const nyquist = fps / 2, peakFloor = Math.max(0, Number(minPeakHz) || 0);
    const peakFloorAboveNyquist = peakFloor >= nyquist;
    // The search starts about one independent bin above 0 Hz, or at the floor.
    let peak = Math.ceil(size / count);
    while (peak < frequencies.length && frequencies[peak] < peakFloor) peak++;
    const peakSearchStart = peak;
    for (let i = peak + 1; i < amplitude.length; i++) if (amplitude[i] > amplitude[peak]) peak = i;
    return {frequencies, amplitude, mean, count, fps, duration: count / fps,
        binSpacing: fps / count, nyquist, peakFloor, peakFloorAboveNyquist, peakSearchStart,
        peak: !peakFloorAboveNyquist && amplitude[peak] > 1e-9 ? {frequency: frequencies[peak], amplitude: amplitude[peak]} : null};
}

// The largest amplitude among the frequencies that the peak search considers
// (from peakSearchStart up). The graph sets its vertical scale from this, so
// slow drift below the search floor cannot flatten the labeled peak: that
// drift can be ten times the peak and would leave it a few pixels high. With
// nothing to search (a floor at or above Nyquist) it covers every frequency,
// so the curve stays in view.
export function searchedMaximum(spectrum) {
    let maximum = 0;
    for (let i = spectrum.peakFloorAboveNyquist ? 0 : spectrum.peakSearchStart; i < spectrum.amplitude.length; i++) {
        if (spectrum.amplitude[i] > maximum) maximum = spectrum.amplitude[i];
    }
    return maximum;
}

// Presentation timestamps, rather than scene playback speed, set the frequency
// scale. Held duplicate frames are measured once; skipped source frames fail.
// Irregular timing (a variable frame rate) is returned as irregular, with the
// local frame-rate range; the spectrum then uses each sample's real time.
export function frequencySampling(source, indices) {
    if (indices.length < 16) throw new Error('Select at least 16 source frames with the In/Out markers');
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1) throw new Error('The selected range skips source frames');
    }
    const timestamps = new Map();
    source.chunks.forEach((chunk, index) => timestamps.set(source.timestampToChunkIndex?.get(chunk.timestamp) ?? index, chunk.timestamp));
    const times = indices.map(i => timestamps.get(i));
    if (times.some(time => !Number.isFinite(time))) throw new Error('The selected range has frames without timestamps');
    const step = (times[times.length - 1] - times[0]) / (times.length - 1);
    let minStep = Infinity, maxStep = 0, irregular = false;
    for (let i = 1; i < times.length; i++) {
        const delta = times[i] - times[i - 1];
        if (!(delta > 0)) throw new Error('The selected range has frames out of time order');
        minStep = Math.min(minStep, delta); maxStep = Math.max(maxStep, delta);
        if (Math.abs(delta - step) > Math.max(2, step * .01)) irregular = true;
    }
    return {fps: 1e6 / step, times: times.map(time => (time - times[0]) / 1e6),
        irregular, minFps: 1e6 / maxStep, maxFps: 1e6 / minStep};
}

// The aperture target of each source frame from frame0 to frame1.
//
// A frame with a measured point gets its target there. A frame with no
// measured point but with a position (the line between the points on each
// side, or a point that the tracker estimated; see PointTrackCoverage) is
// untracked: the brightness can be measured there, but the place is a guess.
// Such a frame gets its target at that position, and the plan describes those
// frames in `untracked`, so that the graph can warn about them. A frame with
// no position at all (outside the track, or where the object was not found)
// stops the analysis; the error then has the number of those frames in
// `unpositioned`.
export function captureFrequencyTargets({frame0, frame1, positions, rawPositions = positions, width, height, radius, displayIndex}) {
    if (!(width > 0 && height > 0)) throw new Error('Video dimensions are unavailable');
    const selected = new Set(), targets = {}, guesses = {};
    const sorted = positions ? sortedTrackFrames(positions) : [];
    // To the end of the track, not only to frame1: the trial of a gap also uses the frames after it.
    const status = rawPositions ? trackFrameStatus(rawPositions, null, Math.max(frame1, sorted.at(-1) ?? 0) + 1) : [];
    const targetAt = point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
        ? {u: point.x / width, v: point.y / height, rx: radius / width, ry: radius / height} : null;
    for (let frame = frame0; frame <= frame1; frame++) {
        const index = displayIndex(frame);
        selected.add(index);
        if (rawPositions?.unmeasuredFrames?.has(frame)) continue;
        const kind = status[frame];
        const measured = isTrackedStatus(kind) ? targetAt(positions?.get(frame)) : null;
        if (measured) { targets[index] ??= measured; continue; }
        const guess = targetAt(kind === TRACK_FRAME.estimated ? positions?.get(frame)
            : kind === TRACK_FRAME.interpolated ? positionBetween(positions, sorted, frame) : null);
        if (guess) guesses[index] ??= {target: guess, frame, estimated: kind === TRACK_FRAME.estimated};
    }
    // Preserve order so reversed or cut/held timelines cannot masquerade as an
    // evenly sampled signal. Duplicate playback slots contribute only once.
    const indices = Array.from(selected);
    const unpositioned = indices.filter(index => !targets[index] && !guesses[index]).length;
    if (unpositioned) {
        const error = new Error(`${unpositioned} source frame(s) have no Point Track position. Track them or narrow In/Out`);
        error.unpositioned = {count: unpositioned, total: indices.length};
        throw error;
    }
    const untracked = untrackedStatistics(indices, targets, guesses, width, height, positions, status);
    if (untracked) for (const index of untracked.indices) targets[index] = guesses[index].target;
    return {targets, indices, untracked};
}

// What the user needs to judge an analysis that uses positions that were not
// measured, in original video pixels: how many source frames, in how many
// runs, how long the longest run is, how far the track moves across a run
// (`move`), and how far a straight line is from the track when it replaces as
// many tracked frames beside a run (`trial`; see lineTrialError; null when no
// run has enough tracked frames beside it). The trial is the one that shows
// whether the object is likely to be inside the aperture: a fast object on a
// straight path has a large move and a trial near zero. Null when every frame
// has a measured point.
function untrackedStatistics(indices, targets, guesses, width, height, positions, status) {
    const place = index => targets[index] ?? guesses[index].target;
    const runs = [];
    let run = null;
    indices.forEach((index, order) => {
        if (targets[index]) { run = null; return; }
        if (!run) runs.push(run = {start: order, end: order});
        run.end = order;
    });
    if (!runs.length) return null;
    const untracked = {count: 0, total: indices.length, runs: runs.length, estimated: 0, longest: 0, move: 0, trial: null, indices: []};
    for (const {start, end} of runs) {
        const length = end - start + 1;
        // The points on each side of the run; at an end of the region, the run's own end.
        const from = place(indices[Math.max(0, start - 1)]), to = place(indices[Math.min(indices.length - 1, end + 1)]);
        untracked.move = Math.max(untracked.move, Math.hypot((to.u - from.u) * width, (to.v - from.v) * height));
        const trial = lineTrialError(positions, status, guesses[indices[start]].frame, guesses[indices[end]].frame);
        if (trial !== null) untracked.trial = Math.max(untracked.trial ?? 0, trial);
        untracked.count += length;
        if (length > untracked.longest) {
            untracked.longest = length;
            untracked.longestFirst = guesses[indices[start]].frame;
            untracked.longestLast = guesses[indices[end]].frame;
        }
        for (let order = start; order <= end; order++) {
            untracked.indices.push(indices[order]);
            if (guesses[indices[order]].estimated) untracked.estimated++;
        }
    }
    return untracked;
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
