// Pupil mask rasteriser - the "maskulator" half of the job.
//
// A stop is described parametrically rather than drawn, because the whole point of the
// exercise is to vary the geometry and watch what happens to the spikes. Every length is a
// fraction of the pupil RADIUS (so the pupil edge sits at 1.0), which keeps the description
// independent of the grid size: the same stop re-rasterises at 256 or 2048 unchanged.
//
// WHAT EACH FEATURE DOES TO THE PSF, since that is the reason to expose it:
//   outer shape       a straight edge throws a spike PERPENDICULAR to itself; a circle
//                     throws the Airy rings instead. The flats on the housing window are
//                     why the pattern has structure the vanes alone cannot explain.
//   central obstruction  pushes energy out of the core into the first rings.
//   spider vanes      each vane throws ONE spike pair perpendicular to it, so N vanes give
//                     2N spikes - unless they pair up into parallel lines, which is why 4
//                     vanes at 90 degrees give 4 spikes, not 8.
//   apodisation       a serrated or wavy vane edge has no single orientation, so its spike
//                     smears sideways into the broad "feather" (aigrette) the Chandelier
//                     shows instead of a hairline. This is the feature the PDF had to add
//                     before its model resembled the real image.

/** Defaults for one stop. Anything omitted from a spec falls back to these. */
export const DEFAULT_STOP = {
    enabled: true,
    shape: "truncatedCircle",   // circle | truncatedCircle | square | polygon
    sides: 8,                   // polygon only
    rotationDeg: 0,             // whole stop, degrees clockwise on screen
    flatTop: 0.88,              // truncatedCircle: top/bottom chord distance, in radii
    flatSide: 1.0,              // truncatedCircle: left/right chord distance, in radii
    obstruction: 0.30,          // central circular obstruction, fraction of pupil DIAMETER
    vanes: {
        count: 4,
        rotationDeg: 45,        // 0 puts the first vane along +x
        width: 0.055,           // fraction of pupil DIAMETER
        taper: 1.0,             // outer half-width / inner half-width
        apodize: "sawtooth",    // none | sawtooth | sine
        apodAmplitude: 0.55,    // wave depth, as a fraction of the local half-width
        apodPeriod: 0.10,       // one wave per this many pupil RADII along the vane
        apodPhase: 0,           // 0..1 of a period
        edgeMode: "width",      // width (serrated, both edges) | meander (centreline waves)
        oppositePhase: false,   // give the two edges opposite phase (diamond serration)
    },
};

function mergeStop(spec = {}) {
    return { ...DEFAULT_STOP, ...spec, vanes: { ...DEFAULT_STOP.vanes, ...(spec.vanes || {}) } };
}

/** Unit-radius outer boundary test in the stop's own rotated frame. */
function insideOuter(s, x, y) {
    switch (s.shape) {
        case "square":
            return Math.abs(x) <= 1 && Math.abs(y) <= 1;

        case "polygon": {
            // Inscribed regular polygon: inside iff it is on the inner side of every edge.
            // The flat-to-centre distance is 1, so a polygon and a circle of the same
            // nominal size are directly comparable.
            const n = Math.max(3, s.sides | 0);
            for (let i = 0; i < n; i++) {
                const a = (2 * Math.PI * i) / n;
                if (x * Math.cos(a) + y * Math.sin(a) > 1) return false;
            }
            return true;
        }

        case "circle":
            return x * x + y * y <= 1;

        case "truncatedCircle":
        default:
            // The housing window: a circle with the top and bottom (and optionally the
            // sides) sliced off by chords. flat* = 1 means the chord is tangent, i.e. no cut.
            return x * x + y * y <= 1 && Math.abs(y) <= s.flatTop && Math.abs(x) <= s.flatSide;
    }
}

/** Wave shape along a vane, returning -1..1. */
function apodWave(kind, t) {
    switch (kind) {
        case "sine":     return Math.sin(2 * Math.PI * t);
        // Triangle wave. Named "sawtooth" to match the serrated look of the real vanes;
        // a true discontinuous sawtooth rasterises into stair-steps that alias badly.
        case "sawtooth": return 4 * Math.abs(t - Math.floor(t + 0.75) + 0.25) - 1;
        case "none":
        default:         return 0;
    }
}

/** True if (x, y) falls on any spider vane. Coordinates are in the stop's rotated frame. */
function insideVane(v, x, y, innerR) {
    const n = v.count | 0;
    if (n <= 0 || v.width <= 0) return false;

    const halfW = v.width;          // width is a fraction of DIAMETER, so half of it in radii
    const base = (v.rotationDeg * Math.PI) / 180;

    for (let i = 0; i < n; i++) {
        const a = base + (2 * Math.PI * i) / n;
        const ca = Math.cos(a), sa = Math.sin(a);
        // Rotate into the vane frame: u runs outward along the vane, w is across it.
        const u = x * ca + y * sa;
        const w = -x * sa + y * ca;
        // Vanes run from the obstruction edge to past the rim. Nothing beyond the outer
        // boundary matters - insideOuter has already rejected it.
        if (u < innerR || u > 1.6) continue;

        const span = Math.max(1e-6, 1 - innerR);
        const taper = 1 + (v.taper - 1) * Math.min(1, (u - innerR) / span);
        const h = halfW * taper;

        if (v.apodize === "none" || v.apodAmplitude === 0 || v.apodPeriod <= 0) {
            if (Math.abs(w) <= h) return true;
            continue;
        }

        const t = u / v.apodPeriod + v.apodPhase;
        const amp = v.apodAmplitude * h;
        if (v.edgeMode === "meander") {
            // Constant width, wandering centreline.
            if (Math.abs(w - amp * apodWave(v.apodize, t)) <= h) return true;
        } else {
            // Serrated: each edge carries its own wave, so the width itself breathes.
            const top = h + amp * apodWave(v.apodize, t);
            const bot = -h - amp * apodWave(v.apodize, v.oppositePhase ? t + 0.5 : t);
            if (w <= top && w >= bot) return true;
        }
    }
    return false;
}

/** Rasterise one stop to an n x n transmission map in [0, 1].
 *
 *  `fill` is the pupil DIAMETER as a fraction of the grid, i.e. the zero padding. It sets
 *  the trade every FFT-based PSF has to make: a small fill samples the core finely but
 *  covers little field, a large fill covers a wide field with a core only a pixel or two
 *  across. See psf.js `describeSampling` for the numbers that fall out of it.
 *
 *  Edges are supersampled. Hard 0/1 edges ring in the transform - that ringing is real
 *  diffraction from a real step, but at a pixel-quantised edge that step is in the wrong
 *  place, and the error shows up as spurious low-level structure between the spikes.
 */
export function rasterStop(spec, n, fill = 0.65, supersample = 3) {
    const s = mergeStop(spec);
    const mask = new Float32Array(n * n);
    if (!s.enabled) return mask;

    const radiusPx = (fill * n) / 2;
    const centre = n / 2;
    const rot = (-s.rotationDeg * Math.PI) / 180;   // screen-clockwise -> maths frame
    const cr = Math.cos(rot), sr = Math.sin(rot);
    // The obstruction is a fraction of the pupil DIAMETER, and coordinates here are in pupil
    // RADII - but the ratio is the same either way (obstruction radius / pupil radius equals
    // obstruction diameter / pupil diameter), so it converts one for one. Doubling it, as an
    // earlier version did, makes every obstruction twice the size it claims to be.
    const innerR = Math.max(0, s.obstruction);
    const ss = Math.max(1, supersample | 0);
    const invSS = 1 / ss, weight = 1 / (ss * ss);

    // Everything outside the pupil circumscription is zero; skipping it is most of the work.
    const lo = Math.max(0, Math.floor(centre - radiusPx * 1.02));
    const hi = Math.min(n - 1, Math.ceil(centre + radiusPx * 1.02));

    for (let py = lo; py <= hi; py++) {
        for (let px = lo; px <= hi; px++) {
            let acc = 0;
            for (let sy = 0; sy < ss; sy++) {
                const fy = (py + (sy + 0.5) * invSS - 0.5 - centre) / radiusPx;
                for (let sx = 0; sx < ss; sx++) {
                    const fx = (px + (sx + 0.5) * invSS - 0.5 - centre) / radiusPx;
                    const x = fx * cr - fy * sr;
                    const y = fx * sr + fy * cr;
                    if (!insideOuter(s, x, y)) continue;
                    if (x * x + y * y < innerR * innerR) continue;
                    if (insideVane(s.vanes, x, y, innerR)) continue;
                    acc += weight;
                }
            }
            if (acc > 0) mask[py * n + px] = acc;
        }
    }
    return mask;
}

/** Fraction of the grid the stop actually transmits - the pupil's clear area. Used to
 *  normalise across stops so a small iris does not simply look dimmer than a big mirror. */
export function maskThroughput(mask) {
    let sum = 0;
    for (let i = 0; i < mask.length; i++) sum += mask[i];
    return sum;
}
