// OceanSpectrum.js
//
// The wind-driven sea surface, as published physics rather than as a ripple hack.
//
// This module is deliberately PURE: no three.js, no Sitrec globals, no imports at
// all. Everything here is a function of numbers. That keeps it testable under Jest
// (importing three/addons into a Jest-tested src file breaks the runner) and it
// keeps the physics separable from the rendering, which is where it belongs.
//
// What lives here:
//
//   * the Elfouhaily et al. (1997) unified directional spectrum, which is the only
//     widely used model that runs continuously from the gravity peak all the way
//     into the capillary band — and the capillary band is where nearly all of the
//     SLOPE variance lives, which is the part a renderer actually needs;
//   * the Cox & Munk (1954) sun-glitter slope statistics, used as the measured
//     ground truth the spectrum is validated against;
//   * the band-limited slope variance integrals that split "waves big enough for
//     this pixel to resolve" from "waves that have to become a BRDF";
//   * whitecap coverage and water-leaving radiance, the two terms that stop a sea
//     surface from looking like grey glass.
//
// TWO CONVENTIONS, FIXED HERE ONCE. Both are classic factor-of-two/factor-of-k
// traps in this literature, and both are asserted in OceanSpectrum.test.js:
//
//  1. SPECTRUM DIMENSIONALITY. Three related objects, never interchangeable:
//
//        B(k)      curvature spectrum, dimensionless
//        S1(k)     omnidirectional elevation spectrum = B(k)/k^3
//                  INT S1 dk = <h^2>                       (1-D density, per dk)
//        Psi(k,phi) 2-D directional spectrum = S1(k)/k * Phi(k,phi)
//                  INT INT Psi k dk dphi = <h^2>           (2-D density, per dk^2)
//
//     so mean square slope is
//
//        mss = INT k^2 S1(k) dk = INT B(k) dlnk
//
//     Feeding S1 where Psi belongs (or vice versa) costs exactly a factor of k and
//     is invisible until the sea is uniformly too rough or too smooth.
//
//  2. SLOPE VARIANCE vs BECKMANN ROUGHNESS. We store SLOPE VARIANCE, sigma^2, the
//     quantity Cox & Munk measured. The Beckmann/microfacet roughness parameter is
//     alpha = sigma * sqrt(2). Anything consuming these for a BRDF must convert.
//
// References:
//   Cox, C. & Munk, W. (1954). Measurement of the Roughness of the Sea Surface from
//     Photographs of the Sun's Glitter. JOSA 44(11), 838-850.
//   Elfouhaily, T., Chapron, B., Katsaros, K. & Vandemark, D. (1997). A Unified
//     Directional Spectrum for Long and Short Wind-Driven Waves. JGR 102(C7),
//     15781-15796.
//   Monahan, E. C. & O'Muircheartaigh, I. (1980). Optimal power-law description of
//     oceanic whitecap coverage dependence on wind speed. J. Phys. Oceanogr. 10.
//   Lee, Z. et al. Deriving inherent optical properties from water color
//     (the quadratic r_rs relation used below).

// Physical constants.
export const GRAVITY = 9.81;

// Capillary/gravity crossover. k_m = sqrt(rho g / T) with T the surface tension of
// sea water: the wavenumber of MINIMUM phase speed, and the peak of the curvature
// spectrum. c_m is that minimum phase speed.
export const CAPILLARY_K = 370.0;      // rad/m  (lambda = 1.70 cm)
export const CAPILLARY_C = 0.23;       // m/s

// Numerical truncation for "the whole spectrum". NOT a physical cutoff: Cox & Munk's
// optical mss is the full-spectrum value. Verified by convergence — the integral is
// identical to four decimal places at 3000 and at 10000 rad/m, and under-reads by
// 5-10% at 1000. See OceanSpectrum.test.js.
export const K_MAX = 3000.0;           // rad/m  (lambda = 2.09 mm)
export const K_MIN = 1e-4;             // rad/m  (lambda = 63 km)

// Inverse wave age. 0.84 is a fully developed sea; 1 is "mature"; up to 5 is a young,
// short-fetch, steep sea. Elfouhaily's spectrum is only defined on [0.84, 5].
export const OMEGA_FULLY_DEVELOPED = 0.84;
export const OMEGA_MIN = 0.84;
export const OMEGA_MAX = 5.0;

// von Karman constant, for the log wind profile.
const VON_KARMAN = 0.4;

// ---------------------------------------------------------------------------
// Wave kinematics
// ---------------------------------------------------------------------------

// Phase speed including surface tension. Getting the capillary term right matters
// for animation, not just for the spectrum: short ripples travel far faster than the
// deep-water gravity formula predicts, and a sea whose small waves crawl reads as
// syrup.
export function phaseSpeed(k) {
    return Math.sqrt((GRAVITY / k) * (1 + (k / CAPILLARY_K) ** 2));
}

// Dispersion relation, omega^2 = g k (1 + (k/km)^2).
export function angularFrequency(k) {
    return Math.sqrt(GRAVITY * k * (1 + (k / CAPILLARY_K) ** 2));
}

// Temporal Nyquist guard. At k ~ 800 rad/m omega is ~211 rad/s ~ 34 Hz, above the
// 30 Hz Nyquist of a 60 fps render, so the finest waves alias into a boil. Compress
// frequencies above half Nyquist onto an asymptote instead of clamping hard, so
// there is no discontinuity partway up a cascade.
export function limitedAngularFrequency(k, frameRate = 60) {
    const omega = angularFrequency(k);
    const nyquist = Math.PI * frameRate;      // rad/s
    const knee = nyquist * 0.5;
    if (omega <= knee) return omega;
    // Smooth saturation: approaches nyquist asymptotically, matches value and slope
    // at the knee.
    return knee + (nyquist - knee) * (1 - Math.exp(-(omega - knee) / (nyquist - knee)));
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

// Neutral-stability drag coefficient at 10 m (Wu's empirical closure, the one
// Elfouhaily's paper uses).
export function dragCoefficient(u10) {
    return 1e-3 * (0.8 + 0.065 * u10);
}

export function frictionVelocity(u10) {
    return u10 * Math.sqrt(dragCoefficient(u10));
}

// Neutral log wind profile. Needed because Cox & Munk measured wind at their ship's
// 12.5 m mast while every modern spectrum is parameterised on U10, and quietly
// treating the two as equal biases the comparison by a few percent.
export function windAtHeight(u10, height) {
    const uStar = frictionVelocity(u10);
    const roughness = 10 * Math.exp(-VON_KARMAN * u10 / uStar);
    return (uStar / VON_KARMAN) * Math.log(height / roughness);
}

export function u10ToU125(u10) {
    return windAtHeight(u10, 12.5);
}

// ---------------------------------------------------------------------------
// Cox & Munk (1954) — the measured ground truth
// ---------------------------------------------------------------------------

// Slope variance from sun-glitter photographs. `u125` is wind speed at 12.5 m, the
// height Cox & Munk actually measured at. Their fits cover 1-14 m/s.
//
// Note the total is their own independent fit (5.12e-3), not the sum of the two
// component fits (5.08e-3). Both are quoted here as published rather than forced to
// agree, because forcing them hides which one a caller is relying on.
export function coxMunkSlopeVariance(u125, {slick = false} = {}) {
    if (slick) {
        return {
            up: 0.005 + 7.8e-4 * u125,
            cross: 0.003 + 8.4e-4 * u125,
            total: 0.008 + 1.56e-3 * u125,
        };
    }
    return {
        up: 3.16e-3 * u125,
        cross: 3.00e-3 + 1.92e-3 * u125,
        total: 0.003 + 5.12e-3 * u125,
    };
}

// Gram-Charlier shape coefficients. These are what make a real glitter pattern lean
// downwind rather than sitting symmetrically about the specular point. Kept available
// for the statistical method; the spectral method runs Gaussian by default because
// the skew is a few degrees of centroid shift and the series can go negative in the
// tails.
export function coxMunkGramCharlier(u125, {slick = false} = {}) {
    if (slick) return {c21: 0.0, c03: 0.02, c40: 0.36, c22: 0.10, c04: 0.26};
    return {
        c21: 0.01 - 0.0086 * u125,
        c03: 0.04 - 0.033 * u125,
        c40: 0.40, c22: 0.12, c04: 0.23,
    };
}

// ---------------------------------------------------------------------------
// Elfouhaily et al. (1997) unified directional spectrum
// ---------------------------------------------------------------------------

// Cache the wind-dependent terms: every spectrum evaluation needs them and the
// integrals call the spectrum tens of thousands of times.
export function spectrumParams(u10, omega = OMEGA_FULLY_DEVELOPED) {
    const clampedOmega = Math.min(OMEGA_MAX, Math.max(OMEGA_MIN, omega));
    const kp = (GRAVITY / (u10 * u10)) * clampedOmega * clampedOmega;
    const uStar = frictionVelocity(u10);
    return {
        u10,
        omega: clampedOmega,
        kp,
        cp: phaseSpeed(kp),
        uStar,
        // Peak enhancement, Elfouhaily eq. 34: JONSWAP's gamma, extended above
        // fully-developed.
        gamma: clampedOmega <= 1.0 ? 1.7 : 1.7 + 6.0 * Math.log10(clampedOmega),
        sigma: 0.08 * (1.0 + 4.0 / clampedOmega ** 3),
        alphaP: 6e-3 * Math.sqrt(clampedOmega),
        // Elfouhaily eq. 44. Clamped at zero, which the paper does not state but the
        // physics requires: below u* of about 0.085 m/s the log term drives alphaM
        // negative, which would make the whole capillary half of the spectrum
        // negative — and below roughly 0.9 m/s of wind, the TOTAL slope variance
        // negative. The formula is a fit over 1-20 m/s and simply has no content
        // below that.
        //
        // Zero is also the physically right value there rather than merely a safe
        // one: generating capillary-gravity waves needs a friction velocity above a
        // threshold, and under it the surface stays smooth. So a very light air gives
        // a glassy sea with only the long swell on it, which is what one looks like.
        alphaM: Math.max(0, uStar <= CAPILLARY_C
            ? 1e-2 * (1.0 + Math.log(uStar / CAPILLARY_C))
            : 1e-2 * (1.0 + 3.0 * Math.log(uStar / CAPILLARY_C))),
    };
}

// Curvature spectrum B(k) = k^3 S1(k). Dimensionless, and the natural quantity to
// work in: mss is just its integral in log k, so a plot of B against log k IS the
// distribution of slope variance across scales.
export function curvatureSpectrum(k, params) {
    const {kp, cp, gamma, sigma, alphaP, alphaM} = params;
    const c = phaseSpeed(k);

    // Pierson-Moskowitz low-wavenumber cutoff and the JONSWAP peak enhancement.
    // Both multiply BOTH halves of the spectrum — omitting them from the short-wave
    // part is a common transcription slip, though it changes the answer by under 1%
    // because both tend to 1 well before the capillary band.
    const lpm = Math.exp(-1.25 * (kp / k) ** 2);
    const gammaExp = Math.exp(-((Math.sqrt(k / kp) - 1) ** 2) / (2 * sigma * sigma));
    const jp = Math.pow(gamma, gammaExp);

    // Long-wave (gravity) side.
    const fp = lpm * jp * Math.exp(-(params.omega / Math.sqrt(10)) * (Math.sqrt(k / kp) - 1));
    const bLong = 0.5 * alphaP * (cp / c) * fp;

    // Short-wave (capillary-gravity) side.
    const fm = lpm * jp * Math.exp(-0.25 * (k / CAPILLARY_K - 1) ** 2);
    const bShort = 0.5 * alphaM * (CAPILLARY_C / c) * fm;

    return bLong + bShort;
}

// Just the gravity half, so the cascades can apply the downwind reweight to gravity
// waves only — capillary waves genuinely do run both ways relative to the wind, but
// gravity waves do not, and a centro-symmetric spreading function sends half of them
// upwind.
export function curvatureSpectrumSplit(k, params) {
    const {kp, cp, gamma, sigma, alphaP, alphaM} = params;
    const c = phaseSpeed(k);
    const lpm = Math.exp(-1.25 * (kp / k) ** 2);
    const jp = Math.pow(gamma, Math.exp(-((Math.sqrt(k / kp) - 1) ** 2) / (2 * sigma * sigma)));
    const fp = lpm * jp * Math.exp(-(params.omega / Math.sqrt(10)) * (Math.sqrt(k / kp) - 1));
    const fm = lpm * jp * Math.exp(-0.25 * (k / CAPILLARY_K - 1) ** 2);
    return {
        gravity: 0.5 * alphaP * (cp / c) * fp,
        capillary: 0.5 * alphaM * (CAPILLARY_C / c) * fm,
    };
}

// Omnidirectional elevation spectrum. INT S1(k) dk = mean square wave height.
export function omniSpectrum(k, params) {
    return curvatureSpectrum(k, params) / (k * k * k);
}

// Directional spreading, Elfouhaily eqs. 56-57. Phi(k,phi) = (1/2pi)(1 + Delta cos2phi),
// so Delta runs 0 (isotropic) to 1 (fully wind-aligned). It is centro-symmetric by
// construction, which is correct for the SPREAD but says nothing about which way the
// waves travel — see curvatureSpectrumSplit.
export function spreadingDelta(k, params) {
    const c = phaseSpeed(k);
    return Math.tanh(
        Math.LN2 / 4
        + 4.0 * Math.pow(c / params.cp, 2.5)
        + 0.13 * (params.uStar / CAPILLARY_C) * Math.pow(CAPILLARY_C / c, 2.5)
    );
}

// Full 2-D directional spectrum. INT INT Psi k dk dphi = <h^2>. This is the density
// the FFT amplitudes are drawn from — see the h0 normalisation note in the header.
export function directionalSpectrum(k, phi, params) {
    const phiSpread = (1 + spreadingDelta(k, params) * Math.cos(2 * phi)) / (2 * Math.PI);
    return (omniSpectrum(k, params) / k) * phiSpread;
}

// ---------------------------------------------------------------------------
// Slope variance — the quantity the renderer actually consumes
// ---------------------------------------------------------------------------

// Slope variance carried by waves with wavelength in [lambdaMin, lambdaMax], split
// into wind-aligned components.
//
//   mss       = INT k^2 S1(k) dk         = INT B(k) dlnk
//   mss_up    = INT k^2 S1(k) (1/2 + Delta/4) dk
//   mss_cross = INT k^2 S1(k) (1/2 - Delta/4) dk
//
// The (1/2 +- Delta/4) factors are the azimuthal integrals of cos^2 phi and sin^2 phi
// against Phi; they sum to 1, which is asserted in the tests.
//
// Integrated in log k because B is naturally flat-ish there, so a modest sample count
// is accurate across five decades of wavenumber.
export function slopeVarianceInBand(lambdaMin, lambdaMax, params, samples = 2048) {
    const kLo = 2 * Math.PI / lambdaMax;
    const kHi = 2 * Math.PI / lambdaMin;
    if (!(kHi > kLo)) return {total: 0, up: 0, cross: 0};

    const dLogK = (Math.log(kHi) - Math.log(kLo)) / samples;
    const logKLo = Math.log(kLo);
    let total = 0, up = 0, cross = 0;
    for (let sample = 0; sample < samples; sample++) {
        const k = Math.exp(logKLo + (sample + 0.5) * dLogK);
        const contribution = curvatureSpectrum(k, params) * dLogK;
        const delta = spreadingDelta(k, params);
        total += contribution;
        up += contribution * (0.5 + delta * 0.25);
        cross += contribution * (0.5 - delta * 0.25);
    }
    return {total, up, cross};
}

// Whole-spectrum slope variance, over the full numerical range.
export function totalSlopeVariance(params, samples = 4096) {
    return slopeVarianceInBand(2 * Math.PI / K_MAX, 2 * Math.PI / K_MIN, params, samples);
}

// ---------------------------------------------------------------------------
// Cascades
// ---------------------------------------------------------------------------

// Tile sizes for the FFT cascades, in metres.
//
// Two rules decided these, and both are load-bearing:
//
//  1. NO INTEGER RATIOS between any pair. Bruneton's widely copied 5488/392/28/2
//     set has every ratio exactly 14, so the summed field repeats every 5488 m —
//     six or seven repeats across a wide sea view. These are detuned so the combined
//     lattice has no period a viewer will ever travel far enough to see.
//
//  2. NO SINGLE CASCADE DOMINATES. The slope variance peaks around lambda 0.6-6 m,
//     which needs a small tile to sample — and small tiles repeat often. Splitting
//     that band across two cascades keeps the worst single lattice under about a
//     third of the variance instead of over a half.
//
// TWO cascades, both large. This is the least obvious decision in the module, and it
// came out of measuring rather than from the literature — the usual recipe is four or
// five cascades running down to a 2 m tile.
//
// Tiling risk (see tilingRiskShare) falls monotonically with tile size, and steeply:
// at U10 = 5 m/s a 2 m tile can expose 22.7% of the slope variance as a visible
// repeat, a 31.7 m tile 12.0%, and a 113 m tile only 0.3%. Meanwhile a 113 m tile on a
// 512 grid still resolves down to lambda = 0.44 m, and waves that short are only
// resolvable within a few hundred metres of the camera in the first place.
//
// So the small cascades that the standard recipe adds buy detail almost nobody is
// close enough to see, and pay for it with the entire tiling problem. Dropping them
// costs 42% of the variance to the analytic tail — which is not a loss, because that
// is exactly where unresolved variance is supposed to go — and halves the FFT cost.
//
// A kilometre-scale cascade is deliberately absent too: the wind-sea peak sits at
// lambda ~23 m at 5 m/s and ~200 m even at 15 m/s, so a cascade that big carries no
// wind-sea energy at all. It is a swell cascade, and adding it before swell exists
// buys an FFT that transforms noise.
export const CASCADE_SIZES = [421.7, 113.3];

// For a camera close enough to the water that lambda = 0.44 m is several pixels
// across — under roughly 500 m — this adds back the finer detail. It carries a real
// 12% tiling risk, so it is opt-in rather than the default.
export const CASCADE_SIZES_CLOSEUP = [421.7, 113.3, 31.7];

// Each cascade's sampling frame is rotated by its own angle. The directional spectrum
// is generated pre-rotated by the negative of this, so wind alignment stays physically
// exact while the tile lattices no longer share an orientation — two lattices at an
// incommensurate relative rotation cannot reinforce each other's periodicity.
export const CASCADE_ROTATIONS_DEG = [0, 37, 71, 113, 149];

// Widest tile period, in pixels, that still reads as a repeating pattern rather than
// as texture. Below about four pixels a repeat is indistinguishable from noise.
const TILING_VISIBLE_PIXELS = 4;

// How much slope variance a cascade can actually expose as a VISIBLE repeating
// pattern — which is not the same thing as how much it carries, and is the number
// that should drive the choice of tile sizes.
//
// A tile of size L only reads as a repeat while its period spans more than a few
// pixels. At the distance where the period is exactly TILING_VISIBLE_PIXELS across,
// the pixel footprint on the water is L/TILING_VISIBLE_PIXELS by definition — and
// waves shorter than the footprint are not resolved, so they cannot contribute to a
// visible pattern at all.
//
// The at-risk band is therefore lambda in [L/TILING_VISIBLE_PIXELS, L], with no
// dependence on camera height, field of view or resolution. Any wave shorter than
// that has dissolved into the statistical term before its lattice could be seen, and
// any wave longer belongs to a coarser cascade.
//
// Two consequences, both of which shaped CASCADE_SIZES:
//
//   * risk depends ONLY on the tile size, not on how the cascades are spaced or how
//     many there are — so there is no clever packing that avoids it;
//   * it falls steeply as the tile grows, because [L/4, L] slides off the top of the
//     slope-variance distribution. Big tiles are safe almost for free.
export function tilingRiskShare(size, params, totalVariance) {
    const risky = slopeVarianceInBand(size / TILING_VISIBLE_PIXELS, size, params);
    return totalVariance > 0 ? risky.total / totalVariance : 0;
}

// Describe the cascade set for a given wind: band limits, variance carried, and the
// analytic tail that no grid can resolve.
//
// `fftSize` sets each cascade's Nyquist wavelength (2 * size / fftSize). The finest
// cascade cannot reach K_MAX, and the variance beyond its Nyquist is REAL — at a 2 m
// tile on a 512 grid the unresolvable band still carries a meaningful share of the
// capillary slope variance. It is returned as `tailVariance` and must be added to the
// unresolved (BRDF) variance, never dropped and never papered over with a floor.
export function describeCascades(params, {
    sizes = CASCADE_SIZES,
    rotationsDeg = CASCADE_ROTATIONS_DEG,
    fftSize = 512,
} = {}) {
    const total = totalSlopeVariance(params);
    const cascades = [];

    for (let index = 0; index < sizes.length; index++) {
        const size = sizes[index];
        // Bands tile the spectrum: this cascade owns wavelengths from the next
        // cascade's tile size (or its own Nyquist, for the finest) up to its own.
        const lambdaMax = size;
        const lambdaMin = index + 1 < sizes.length
            ? sizes[index + 1]
            : 2 * size / fftSize;
        const variance = slopeVarianceInBand(lambdaMin, lambdaMax, params);
        cascades.push({
            index,
            size,
            rotationDeg: rotationsDeg[index % rotationsDeg.length],
            nyquistWavelength: 2 * size / fftSize,
            lambdaMin,
            lambdaMax,
            variance,
            share: total.total > 0 ? variance.total / total.total : 0,
            // The number that matters for repetition. See tilingRiskShare.
            tilingRisk: tilingRiskShare(size, params, total.total),
        });
    }

    // Everything longer than the biggest tile, and everything shorter than the finest
    // grid can resolve. Both go straight into the statistical term.
    const headVariance = slopeVarianceInBand(sizes[0], 2 * Math.PI / K_MIN, params);
    const finestNyquist = 2 * sizes[sizes.length - 1] / fftSize;
    const tailVariance = slopeVarianceInBand(2 * Math.PI / K_MAX, finestNyquist, params);

    return {total, cascades, headVariance, tailVariance};
}

// ---------------------------------------------------------------------------
// Wave components — the resolved surface
// ---------------------------------------------------------------------------

// Deterministic RNG (mulberry32). The wave field must be identical every time the
// same frame is rendered, or the visual regression suite flakes and an exported image
// never matches the preview that produced it.
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Build a set of travelling wave trains whose statistics match the spectrum.
//
// WHY A DIRECT SUM RATHER THAN AN FFT. The standard method inverse-transforms the
// spectrum on a periodic grid, which buys thousands of components cheaply but hands
// back a TILE — and a tile repeats. The usual answers (several cascades at
// non-commensurate sizes, rotated lattices, domain warping) all reduce the visibility
// of that repeat without ever removing it.
//
// A sum of wave trains has no periodic domain at all, so repetition is not suppressed,
// it is structurally impossible. That matters here because the surface has to hold up
// over tens of kilometres in one frame. The cost is being limited to tens of
// components rather than thousands — which turns out not to bind, because the band a
// given pixel can actually RESOLVE is narrow, and everything outside it belongs in the
// statistical term anyway.
//
// Two more things fall out for free:
//
//   * it is stateless — the surface is a closed-form function of time, so frame N is
//     identical however you arrive at it, and regression determinism needs no care;
//   * the resolved/unresolved split becomes exact. A component is either included in
//     the slope sum or its variance is added to the BRDF roughness, with a smooth
//     weight across the transition and no double counting. There are no mip-level
//     variance tables to get subtly wrong.
//
// Components are laid out as `bands` logarithmic wavenumber bands, each carrying its
// own slope variance, split across `directionsPerBand` directions drawn from the
// spreading function. One direction per band would give long-crested swell rather than
// a wind sea; four or six reads as real water.
export function buildWaveComponents(params, {
    bands = 16,
    directionsPerBand = 4,
    lambdaMin = 0.35,
    lambdaMax = 420,
    seed = 12345,
} = {}) {
    const random = seededRandom(seed);
    const components = [];

    const logLo = Math.log(2 * Math.PI / lambdaMax);
    const logHi = Math.log(2 * Math.PI / lambdaMin);
    const dLogK = (logHi - logLo) / bands;

    for (let band = 0; band < bands; band++) {
        const kLo = Math.exp(logLo + band * dLogK);
        const kHi = Math.exp(logLo + (band + 1) * dLogK);
        const k = Math.sqrt(kLo * kHi);                 // log-centre of the band
        const wavelength = 2 * Math.PI / k;

        // Slope variance this band carries, straight from the spectrum. Splitting it
        // between the directions keeps the total exactly right however many are used.
        const bandVariance = slopeVarianceInBand(2 * Math.PI / kHi, 2 * Math.PI / kLo, params, 256);
        const delta = spreadingDelta(k, params);

        for (let dir = 0; dir < directionsPerBand; dir++) {
            // Sample the spreading function Phi = (1 + Delta cos2phi)/2pi by rejection,
            // over the DOWNWIND half only. Cheap: the density is at most (1 + Delta),
            // so acceptance never drops below 1/(1+Delta) >= 1/2.
            //
            // Restricting to [-pi/2, pi/2] is not an approximation. cos2phi has period
            // pi, so the spreading function assigns identical density to phi and to
            // phi+pi — it describes the SPREAD about the wind axis and says nothing
            // about which way along that axis a wave travels. Sampling the full circle
            // and treating the result as a heading sends half the energy upwind, and
            // the sea visibly streams the wrong way.
            let phi = 0;
            for (let attempt = 0; attempt < 32; attempt++) {
                phi = (random() - 0.5) * Math.PI;
                const density = (1 + delta * Math.cos(2 * phi)) / (1 + delta);
                if (random() <= density) break;
            }

            // Long gravity waves run downwind. Short capillary waves genuinely do
            // travel both ways relative to the wind, so those get the other half back.
            const upwind = k > CAPILLARY_K * 0.25 && random() < 0.5;
            const heading = upwind ? phi + Math.PI : phi;

            // Amplitude from the variance it must carry. For a cosine of amplitude a,
            // elevation variance is a^2/2 and slope variance is (a*k)^2/2 — so
            // a = sqrt(2 * V / directions) / k.
            const variance = bandVariance.total / directionsPerBand;
            const amplitude = Math.sqrt(2 * variance) / k;

            components.push({
                // Wavevector in the wind-aligned frame: x along the wind, y across it.
                kx: k * Math.cos(heading),
                ky: k * Math.sin(heading),
                k,
                wavelength,
                amplitude,
                phase: random() * 2 * Math.PI,
                omega: limitedAngularFrequency(k),
                // What this component contributes to each axis of the slope variance,
                // for the partition the shader performs.
                varianceUp: variance * Math.cos(heading) ** 2,
                varianceCross: variance * Math.sin(heading) ** 2,
            });
        }
    }

    // Everything the component set does not represent — longer than lambdaMax, shorter
    // than lambdaMin — is real variance and has to go somewhere. It goes into the
    // statistical term, which is exactly where unresolvable roughness belongs.
    const total = totalSlopeVariance(params);
    const represented = components.reduce(
        (sum, wave) => ({
            up: sum.up + wave.varianceUp,
            cross: sum.cross + wave.varianceCross,
        }), {up: 0, cross: 0});

    return {
        components,
        total,
        represented,
        residual: {
            up: Math.max(0, total.up - represented.up),
            cross: Math.max(0, total.cross - represented.cross),
        },
    };
}

// ---------------------------------------------------------------------------
// Whitecaps
// ---------------------------------------------------------------------------

// Fractional whitecap coverage. Monahan & O'Muircheartaigh's robust-biweight fit,
// which is the one their paper puts forward as optimal — the more widely copied
// 2.95e-6 U^3.52 is their ordinary-least-squares fit. The two agree within about 10%
// over 5-15 m/s.
//
// ~0.03% at 5 m/s, ~1% at 10, ~4% at 15: below roughly 7 m/s this is not worth
// drawing, and above 15 it starts to dominate the look of the sea.
export function whitecapCoverage(u10) {
    if (u10 <= 0) return 0;
    return Math.min(1, 3.84e-6 * Math.pow(u10, 3.41));
}

// Effective reflectance of a whitecap in the visible. Fresh foam is 0.5-0.6, but what
// matters for a sea surface is the mixture of active breaker and decaying residual
// foam, which Koepke's efficiency factor brings down to ~0.22. Uncertain to about
// +-50%, and not spectrally flat in better measurements.
export const WHITECAP_REFLECTANCE = 0.22;

// ---------------------------------------------------------------------------
// Water-leaving (upwelling) radiance
// ---------------------------------------------------------------------------

// Representative inherent optical properties at RGB wavelengths (650/550/450 nm),
// in m^-1: total absorption `a` and backscatter `bb`, including the pure-water terms.
//
// These are representative literature values for three water classes rather than the
// output of a full bio-optical model. That is the right level of fidelity here: the
// renderer needs plausible, distinguishable water colors driven by one control, not
// an ocean-color inversion.
export const WATER_TYPES = {
    // Oligotrophic open ocean, chlorophyll well under 0.1 mg/m^3. Deep blue: red is
    // absorbed within a metre, blue is scattered back.
    ocean: {a: [0.360, 0.0650, 0.0190], bb: [0.00080, 0.00150, 0.00280]},
    // Coastal, ~1 mg/m^3 chlorophyll plus dissolved organic matter, which absorbs
    // strongly in the blue and pulls the color towards green.
    coastal: {a: [0.420, 0.130, 0.150], bb: [0.00350, 0.00450, 0.00600]},
    // Turbid: heavy non-algal particles, high backscatter across the board, and
    // enough blue absorption to leave green-brown.
    turbid: {a: [0.600, 0.450, 0.900], bb: [0.0200, 0.0240, 0.0260]},
};

// Remote-sensing reflectance just above the surface, from the inherent optical
// properties, using Lee's quadratic relation.
//
//   u     = bb / (a + bb)
//   r_rs  = 0.0895 u + 0.1247 u^2        just BELOW the interface
//   R_rs  = 0.52 r_rs / (1 - 1.7 r_rs)   just ABOVE it
//
// The second line IS the air-water interface conversion — it already carries the
// transmission out of the water and the internal reflection back down. Multiplying
// the result by (1 - Fresnel) again, in either direction, double-counts the interface
// and makes the water implausibly dark.
export function waterLeavingReflectance(waterType = "ocean") {
    const iop = WATER_TYPES[waterType] ?? WATER_TYPES.ocean;
    const rrs = [0, 0, 0];
    for (let channel = 0; channel < 3; channel++) {
        const u = iop.bb[channel] / (iop.a[channel] + iop.bb[channel]);
        const belowSurface = 0.0895 * u + 0.1247 * u * u;
        rrs[channel] = 0.52 * belowSurface / (1 - 1.7 * belowSurface);
    }
    return rrs;
}

// ---------------------------------------------------------------------------
// Fresnel — shared by every method, so it lives with the physics
// ---------------------------------------------------------------------------

// Refractive index of sea water at 550 nm. Note that the familiar F0 = 0.0204 belongs
// to fresh water at n = 1.333; sea water's 1.34 gives 0.0211. The difference is
// invisible, but the two are quoted interchangeably in the literature and it is worth
// being clear which one is in use here.
export const WATER_IOR = 1.34;

// Exact unpolarised Fresnel reflectance. Schlick is within 2-3% of this for a
// dielectric, so the motive is not accuracy at moderate angles — it is that a sea
// surface viewed near the horizon lives entirely in the last few degrees before
// grazing, where being exactly right is free.
export function fresnelReflectance(cosIncident, ior = WATER_IOR) {
    const cosI = Math.min(1, Math.max(0, cosIncident));
    const sinT2 = (1 - cosI * cosI) / (ior * ior);
    if (sinT2 >= 1) return 1;                       // total internal reflection
    const cosT = Math.sqrt(1 - sinT2);
    const rs = (cosI - ior * cosT) / (cosI + ior * cosT);
    const rp = (ior * cosI - cosT) / (ior * cosI + cosT);
    return 0.5 * (rs * rs + rp * rp);
}

// ---------------------------------------------------------------------------
// Smith shadowing-masking for a Gaussian slope surface
// ---------------------------------------------------------------------------

// Abramowitz & Stegun 7.1.26. Enough precision for shading, and it is the same
// approximation the GLSL side uses, so CPU and GPU agree.
export function erfcApprox(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const poly = t * (0.254829592
        + t * (-0.284496736
            + t * (1.421413741
                + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-ax * ax);
    return 1 - sign * erf;
}

// Slope standard deviation in a given azimuth, for an anisotropic surface. The Smith
// term must use the roughness ALONG THE RAY, not the total: using the isotropic value
// makes a wind-aligned view too dark and a crosswind view too bright.
export function slopeSigmaInAzimuth(sigmaUp, sigmaCross, cosAzimuth, sinAzimuth) {
    return Math.sqrt(
        sigmaUp * sigmaUp * cosAzimuth * cosAzimuth
        + sigmaCross * sigmaCross * sinAzimuth * sinAzimuth
    );
}

// Smith's Lambda for a Gaussian surface. cotTheta is measured from the macroscopic
// normal; sigma is the slope standard deviation in that ray's azimuth.
export function smithLambda(cotTheta, sigma) {
    if (sigma <= 0) return 0;
    const nu = cotTheta / (sigma * Math.SQRT2);
    if (nu > 6) return 0;                            // saturated; avoids 0/0 below
    return 0.5 * (Math.exp(-nu * nu) / (nu * Math.sqrt(Math.PI)) - erfcApprox(nu));
}

// Height-correlated Smith masking-shadowing.
export function smithG(cotIncident, cotReflected, sigmaIncident, sigmaReflected) {
    return 1 / (1 + smithLambda(cotIncident, sigmaIncident)
        + smithLambda(cotReflected, sigmaReflected));
}
