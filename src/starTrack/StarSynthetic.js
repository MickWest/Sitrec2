// Synthetic night-sky video generator for developing and testing the Star Track analysis.
//
// Real night-sky clips give us no ground truth: we cannot tell a genuine miss from a correct
// rejection, and we cannot measure how accurately the camera motion was recovered. This module
// renders frames from a KNOWN star field, a KNOWN camera path, and a KNOWN set of confounders, so
// every stage can be scored numerically.
//
// It reproduces the properties measured on the real target clip, because those are what break
// naive implementations:
//   - stars bloom into saturated flat-topped disks (peak intensity stops carrying magnitude)
//   - the codec clips near ~245, not 255
//   - heavy per-channel chroma speckle on a low, slightly colored sky
//   - a bright green laser streak whose core saturates to white
//   - hot pixels, which are fixed in CAMERA coordinates while the sky moves
//
// Pure and deterministic: seeded PRNG only, no Math.random, no DOM.

/** Deterministic PRNG. Same seed always gives the same clip. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal via Box-Muller, driven by a supplied uniform generator. */
function gauss(rnd) {
    const u = Math.max(1e-12, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const SYNTH_DEFAULTS = {
    width: 640,
    height: 360,
    frames: 120,
    seed: 12345,

    // Sky
    skyLevel: 24,          // matches the measured 24.2 on the real clip
    skyTint: [0.88, 1.0, 0.92],
    noiseSigma: 3.1,       // matches the measured 3.13
    chromaSigma: 2.2,      // extra independent per-channel speckle

    // Sensor
    saturation: 245,       // the codec clips here, not at 255

    // Star field, defined in a reference plane larger than the frame so stars enter and leave
    starCount: 90,
    fieldMargin: 200,      // reference-plane margin around the frame, in pixels
    minMag: 0.5,           // brightest
    maxMag: 6.0,           // faintest
    psfSigma: 1.6,         // base PSF; bright stars bloom well past this once clipped
    // Peak amplitude above sky, per unit flux. Set so that the field spans the interesting
    // regime: the brightest stars clip hard (area, not peak, carries their magnitude) while the
    // faintest sit below the detection threshold and are SUPPOSED to be missed.
    fluxToAmplitude: 14,

    // Camera path (a similarity: pan + slow roll, fixed zoom)
    panX: -0.7,            // px/frame
    panY: -2.3,
    rollDegPerFrame: -0.011,
    jitterSigma: 0.35,     // handheld shake, px/frame

    // Confounders
    movingObject: true,
    movingObjectMag: 2.5,
    movingObjectVel: [1.9, -1.1],   // px/frame IN THE REFERENCE FRAME, i.e. real sky-relative motion
    laser: true,
    laserFrom: [0.05, 0.95],        // fractional frame coords of the beam origin
    // Peak amplitude on the beam axis. This must be high enough that even the small red and blue
    // leak fractions clip, because the bug worth reproducing is that a laser's CORE saturates all
    // three channels and therefore reads as white rather than green. With the leak fractions
    // below, the axis clips R and B out to ~2.3 px while green still clips out to ~6.9 px, giving
    // a white core inside a green beam - exactly what the real footage shows.
    laserAmplitude: 3000,
    laserLeak: [0.10, 0.12],        // red, blue fraction of the green amplitude
    laserHalfWidth: 3.0,
    hotPixels: 6,
};

/**
 * Build the ground-truth scene: star positions and magnitudes in a reference plane, the per-frame
 * camera transform, the moving object's reference-frame trajectory, and the hot pixel list.
 *
 * The camera transform maps REFERENCE plane coordinates to FRAME pixel coordinates as a complex
 * similarity: q = A*p + B. This is the same parameterisation the solver uses, so a test can
 * compare recovered transforms against truth directly.
 */
export function buildScene(opts = {}) {
    const P = {...SYNTH_DEFAULTS, ...opts};
    // The field bounds are derived from the frames' actual footprints, so with no frames the
    // bounding box stays at +/-Infinity and every star position comes out NaN - a scene that
    // silently renders nothing. A fractional count is just as bad in a quieter way: `frames: 1.5`
    // builds two transforms while params.frames stays 1.5, so anything iterating to params.frames
    // disagrees with the array it is indexing. Infinity never finishes building at all.
    if (!Number.isInteger(P.frames) || P.frames < 1) {
        throw new Error(`buildScene: frames must be an integer >= 1, got ${P.frames}`);
    }
    const rnd = mulberry32(P.seed);
    const {width: W, height: H, fieldMargin: M} = P;

    // Camera transforms FIRST, so the star field can be sized from the motion that actually
    // happens rather than from a closed-form guess about it.
    const transforms = [];
    let roll = 0, jx = 0, jy = 0;
    for (let f = 0; f < P.frames; f++) {
        roll += P.rollDegPerFrame * Math.PI / 180;
        jx += gauss(rnd) * P.jitterSigma;
        jy += gauss(rnd) * P.jitterSigma;
        const c = Math.cos(roll), s = Math.sin(roll);
        // Rotate about the frame centre so the pan stays interpretable.
        const cxr = W / 2, cyr = H / 2;
        const tx = P.panX * f + jx, ty = P.panY * f + jy;
        // q = A*(p - centre) + centre + t
        transforms.push({
            A: [c, s],
            B: [cxr + tx - (c * cxr - s * cyr), cyr + ty - (s * cxr + c * cyr)],
        });
    }

    // The star field spans the union of every frame's actual footprint, obtained by mapping each
    // frame's corners back into the reference plane.
    //
    // Deriving this from the pan parameters alone was wrong twice over: it ignored the roll (which
    // swings the corners by up to half the frame diagonal times sin(theta)) and the accumulated
    // jitter (a random walk, so unbounded in closed form). With the default margin those errors
    // were merely hidden; at zero margin the corners escaped the field by up to 22 px, silently
    // removing stars and making every downstream metric measure the generator instead of the
    // algorithm. Measuring the real footprint makes the invariant true by construction, and stays
    // true if the camera-path model is ever changed.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const T of transforms) {
        for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
            const [px, py] = inverseTransform(T, cx, cy);
            if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
            if (py < by0) by0 = py; if (py > by1) by1 = py;
        }
    }
    const x0 = bx0 - M, y0 = by0 - M;
    const spanX = (bx1 - bx0) + 2 * M, spanY = (by1 - by0) + 2 * M;

    const stars = [];
    for (let i = 0; i < P.starCount; i++) {
        // Magnitudes skewed faint, as a real field is.
        const u = rnd();
        const mag = P.minMag + (P.maxMag - P.minMag) * Math.pow(u, 0.55);
        stars.push({
            id: i,
            x: x0 + rnd() * spanX,
            y: y0 + rnd() * spanY,
            mag,
            // Flux on an arbitrary but self-consistent scale: 2.512x per magnitude.
            flux: Math.pow(2.512, P.maxMag - mag),
        });
    }

    const hotPixels = [];
    for (let i = 0; i < P.hotPixels; i++) {
        hotPixels.push({
            x: Math.floor(rnd() * W),
            y: Math.floor(rnd() * H),
            level: 120 + rnd() * 120,
        });
    }

    // The moving object lives in the reference plane and moves relative to the stars, which is
    // what makes it detectable as "not a star" no matter how the camera moves.
    const object = P.movingObject ? {
        x0: x0 + spanX * 0.45,
        y0: y0 + spanY * 0.55,
        vx: P.movingObjectVel[0],
        vy: P.movingObjectVel[1],
        mag: P.movingObjectMag,
        flux: Math.pow(2.512, P.maxMag - P.movingObjectMag),
    } : null;

    // The rectangle of the reference plane that stars were generated into. Exposed so tests can
    // check it against the camera footprint directly, rather than inferring coverage from where
    // randomly-placed stars happen to land - which is far too noisy to catch a bounds bug.
    const field = {x0, y0, spanX, spanY};

    return {params: P, stars, transforms, hotPixels, object, field};
}

/** Apply a complex-similarity transform: q = A*p + B. */
export function applyTransform(T, x, y) {
    return [T.A[0] * x - T.A[1] * y + T.B[0], T.A[1] * x + T.A[0] * y + T.B[1]];
}

/** Invert a complex-similarity transform: p = (q - B) / A. */
export function inverseTransform(T, x, y) {
    const [ax, ay] = T.A;
    const d = ax * ax + ay * ay;
    const qx = x - T.B[0], qy = y - T.B[1];
    return [(qx * ax + qy * ay) / d, (qy * ax - qx * ay) / d];
}

/** Add a Gaussian point source to the accumulation buffers, before clipping. */
function splat(acc, W, H, cx, cy, amp, sigma, tint) {
    // A bright star's visible disk is much wider than its PSF sigma, because everything above the
    // clip level reads as flat white. Extend the footprint until the wings are genuinely
    // negligible relative to the noise, or the disk gets a hard edge.
    const reach = Math.max(3, Math.ceil(sigma * Math.sqrt(2 * Math.log(Math.max(2, amp / 0.5)))));
    const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(W - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(H - 1, Math.ceil(cy + reach));
    const inv = 1 / (2 * sigma * sigma);
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            const v = amp * Math.exp(-(dx * dx + dy * dy) * inv);
            if (v < 0.05) continue;
            const i = (y * W + x) * 3;
            acc[i] += v * tint[0]; acc[i + 1] += v * tint[1]; acc[i + 2] += v * tint[2];
        }
    }
}

/** Draw the laser: a thick green line whose core is bright enough to clip to white. */
function drawLaser(acc, W, H, ax, ay, bx, by, amp, halfWidth, leak) {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - halfWidth - 3));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + halfWidth + 3));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - halfWidth - 3));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by) + halfWidth + 3));
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            let t = ((x - ax) * vx + (y - ay) * vy) / len2;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * vx, py = ay + t * vy;
            const d = Math.hypot(x - px, y - py);
            const v = amp * Math.exp(-(d * d) / (2 * halfWidth * halfWidth));
            if (v < 0.05) continue;
            const i = (y * W + x) * 3;
            // A green laser is overwhelmingly green, but on the beam axis it is bright enough
            // that even the small red and blue leaks clip - which is exactly the case that
            // defeats a naive color test measured over the whole blob.
            acc[i] += v * leak[0]; acc[i + 1] += v; acc[i + 2] += v * leak[1];
        }
    }
}

/**
 * Render one frame of the synthetic clip.
 *
 * @returns {{rgba: Uint8ClampedArray, truth: object}} truth lists the frame-space position of
 *   every star that actually landed inside the frame, plus the object and hot pixels, so a test
 *   can score recall and astrometric error directly.
 */
export function renderFrame(scene, frameIndex) {
    const P = scene.params;
    const W = P.width, H = P.height;
    const T = scene.transforms[frameIndex];
    const rnd = mulberry32(P.seed * 7919 + frameIndex);

    const acc = new Float32Array(W * H * 3);

    // Sky
    for (let i = 0, n = W * H; i < n; i++) {
        const j = i * 3;
        acc[j] = P.skyLevel * P.skyTint[0];
        acc[j + 1] = P.skyLevel * P.skyTint[1];
        acc[j + 2] = P.skyLevel * P.skyTint[2];
    }

    // Stars. Amplitude is deliberately allowed to exceed the clip level: that is what produces
    // the flat-topped saturated disks whose AREA, not peak, carries the magnitude.
    const visible = [];
    for (const s of scene.stars) {
        const [fx, fy] = applyTransform(T, s.x, s.y);
        if (fx < -40 || fy < -40 || fx > W + 40 || fy > H + 40) continue;
        // Brighter stars bloom wider, as real optics and sensors do. Blooming REDISTRIBUTES light,
        // it does not create it, so the amplitude is divided by the area growth to keep the total
        // integrated flux exactly proportional to `flux`. Without that normalisation a star's
        // rendered light scales as flux*sigma^2, the magnitude scale is stretched by ~6%, and any
        // photometry test measures the generator's inconsistency rather than the photometry.
        const sigma = P.psfSigma * (1 + 0.08 * Math.log10(1 + s.flux));
        const widening = (sigma / P.psfSigma) ** 2;
        const amp = P.fluxToAmplitude * s.flux / widening;
        splat(acc, W, H, fx, fy, amp, sigma, [0.90, 0.98, 1.0]);
        if (fx >= 0 && fy >= 0 && fx < W && fy < H) {
            // peakSNR is what the detector can hope to see: amplitude above sky, in noise sigmas.
            // Tests use it to score recall only over stars that are detectable in principle -
            // counting undetectable stars as misses would just measure the noise floor.
            const noise = Math.hypot(P.noiseSigma, P.chromaSigma);
            visible.push({
                id: s.id, x: fx, y: fy, mag: s.mag, flux: s.flux,
                amp, sigma, peakSNR: amp / noise,
            });
        }
    }

    // Moving object
    let objTruth = null;
    if (scene.object) {
        const o = scene.object;
        const rx = o.x0 + o.vx * frameIndex, ry = o.y0 + o.vy * frameIndex;
        const [fx, fy] = applyTransform(T, rx, ry);
        if (fx > -40 && fy > -40 && fx < W + 40 && fy < H + 40) {
            splat(acc, W, H, fx, fy, P.fluxToAmplitude * o.flux, P.psfSigma * 1.05, [1.0, 0.97, 0.92]);
            if (fx >= 0 && fy >= 0 && fx < W && fy < H) objTruth = {x: fx, y: fy, refX: rx, refY: ry};
        }
    }

    // Laser: origin fixed to the frame (it comes from the ground, not the sky), sweeping tip.
    if (P.laser) {
        const ax = P.laserFrom[0] * W, ay = P.laserFrom[1] * H;
        const phase = frameIndex / Math.max(1, P.frames);
        const bx = W * (0.35 + 0.5 * Math.sin(phase * 5.0));
        const by = H * (0.25 + 0.3 * Math.cos(phase * 4.0));
        drawLaser(acc, W, H, ax, ay, bx, by, P.laserAmplitude, P.laserHalfWidth, P.laserLeak);
    }

    // Hot pixels are fixed in CAMERA coordinates - the discriminator that separates them from sky.
    for (const hp of scene.hotPixels) {
        splat(acc, W, H, hp.x, hp.y, hp.level, 0.8, [1.0, 0.85, 0.8]);
    }

    // Noise, then clip.
    const rgba = new Uint8ClampedArray(W * H * 4);
    const sat = P.saturation;
    for (let i = 0, n = W * H; i < n; i++) {
        const j = i * 3, k = i * 4;
        const shared = gauss(rnd) * P.noiseSigma;
        for (let c = 0; c < 3; c++) {
            const v = acc[j + c] + shared + gauss(rnd) * P.chromaSigma;
            rgba[k + c] = Math.max(0, Math.min(sat, v));
        }
        rgba[k + 3] = 255;
    }

    // Hot pixels are part of the ground truth: they are real points of light that the detector is
    // expected to FIND (Stage 3 identifies them by being fixed in camera coordinates), so a test
    // scoring "unexplained" detections needs them here.
    return {
        rgba,
        truth: {
            stars: visible,
            object: objTruth,
            hotPixels: scene.hotPixels.map((h) => ({x: h.x, y: h.y, level: h.level})),
            transform: T,
        },
    };
}
