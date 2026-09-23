// Recommending a Point Track method from what Analyse Object measures at the seed.
//
// Each method answers a different question about the object, and on the wrong kind of clip it
// fails within a few dozen frames. Measured on five reference clips (see
// private/notes/PointTrackMethodComparison.md):
//
//   small object over textured, moving ground (aircraft over farmland, blob among rocks)
//       only Motion (Background) tracks it
//   a light on a dark sky
//       High Peak tracks it; Motion (Background) has no background to register and picks the
//       wrong polarity
//   a large object with structure (a truck seen from an aircraft)
//       only Template Match tracks it; Motion (Background) refuses, the object cancels itself
//
// So the recommendation asks, in order: did the motion measurement find the object, with the
// polarity the raw image shows? Is the object an isolated peak against a smooth background?
// Otherwise it is a structured object, for Template Match.

/**
 * @param {object} m
 * @param {boolean} m.motionFound     Analyse Object's motion calibration succeeded
 * @param {string}  [m.motionPolarity] 'bright' | 'dark', the polarity it chose
 * @param {string}  m.rawPolarity     'bright' | 'dark', what the raw image shows at the seed
 * @param {boolean} m.peakAtSeed      a clear (unambiguous) raw-image peak lies at the seed
 * @param {number}  m.isolation       the object's raw contrast in units of background spread
 * @param {number}  [isolated]        isolation above which a peak counts as isolated
 * @returns {{method: string, reason: string}}
 */
export function recommendMethod(m, isolated = ISOLATED_PEAK) {
    if (m.motionFound && m.motionPolarity === m.rawPolarity) {
        return {method: 'motion', reason: 'moves against its background'};
    }
    if (m.peakAtSeed && m.isolation >= isolated) {
        return m.rawPolarity === 'dark'
            ? {method: 'lowPeak', reason: 'isolated dark point'}
            : {method: 'highPeak', reason: 'isolated bright point'};
    }
    return {method: 'template', reason: m.motionFound ? 'motion result disagrees with the image'
        : 'too large or too still for Motion'};
}

// Set from the reference clips; see private/notes/PointTrackMethodComparison.md.
export const ISOLATED_PEAK = 8;

/**
 * Measure the raw appearance at the seed: which polarity the object has, and how far it stands
 * out from the spread of its surroundings.
 *
 * @param {Float32Array} luma   grey values of a square region centred on the seed
 * @param {number} size         side of that region, in pixels
 * @param {number} core         radius around the centre that holds the object
 * @returns {{rawPolarity: string, contrast: number, spread: number, isolation: number}}
 */
export function measureAppearance(luma, size, core) {
    const sorted = Float32Array.from(luma).sort();
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const median = q(0.5);
    const spread = Math.max(1, (q(0.75) - q(0.25)) / 1.349);
    const c = (size - 1) / 2;
    let high = -Infinity, low = Infinity;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((x - c) ** 2 + (y - c) ** 2 > core * core) continue;
        const v = luma[y * size + x];
        if (v > high) high = v;
        if (v < low) low = v;
    }
    const bright = high - median, dark = median - low;
    const rawPolarity = bright >= dark ? 'bright' : 'dark';
    const contrast = Math.max(bright, dark);
    return {rawPolarity, contrast, spread, isolation: contrast / spread};
}
