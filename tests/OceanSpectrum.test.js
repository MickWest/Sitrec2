// Acceptance tests for the ocean wave spectrum.
//
// These are not smoke tests. The whole approach rests on the claim that the
// Elfouhaily spectrum, integrated correctly, reproduces the slope statistics Cox and
// Munk measured from sun-glitter photographs in 1954. If that is not true, every
// downstream number — glitter path width, horizon gloss, moonglade extent — is wrong
// in a way that still looks superficially plausible on screen.
//
// The two convention traps called out in OceanSpectrum.js are asserted here too: the
// 1-D/2-D spectrum split (a silent factor of k) and the azimuthal weights summing to
// unity (a silent factor of 2).

import {
    CAPILLARY_C,
    CAPILLARY_K,
    CASCADE_ROTATIONS_DEG,
    CASCADE_SIZES,
    CASCADE_SIZES_CLOSEUP,
    K_MAX,
    angularFrequency,
    buildWaveComponents,
    coxMunkSlopeVariance,
    curvatureSpectrum,
    describeCascades,
    directionalSpectrum,
    dragCoefficient,
    erfcApprox,
    fresnelReflectance,
    frictionVelocity,
    limitedAngularFrequency,
    omniSpectrum,
    phaseSpeed,
    slopeSigmaInAzimuth,
    slopeVarianceInBand,
    smithG,
    smithLambda,
    spectrumParams,
    spreadingDelta,
    tilingRiskShare,
    totalSlopeVariance,
    u10ToU125,
    waterLeavingReflectance,
    whitecapCoverage,
} from '../src/ocean/OceanSpectrum';

const WINDS = [3, 5, 7, 10, 15];

describe('wave kinematics', () => {

    test('phase speed is minimised at the capillary wavenumber', () => {
        const cMin = phaseSpeed(CAPILLARY_K);
        expect(cMin).toBeCloseTo(CAPILLARY_C, 2);
        // It is a genuine minimum, not just a value we happen to quote.
        expect(phaseSpeed(CAPILLARY_K * 0.5)).toBeGreaterThan(cMin);
        expect(phaseSpeed(CAPILLARY_K * 2.0)).toBeGreaterThan(cMin);
    });

    test('long waves follow the deep-water gravity relation', () => {
        // At k well below km the capillary term is negligible: c -> sqrt(g/k).
        const k = 0.1;
        expect(phaseSpeed(k)).toBeCloseTo(Math.sqrt(9.81 / k), 3);
    });

    test('dispersion is consistent with phase speed, omega = c k', () => {
        for (const k of [0.01, 1, 50, 370, 2000]) {
            expect(angularFrequency(k)).toBeCloseTo(phaseSpeed(k) * k, 6);
        }
    });

    test('angular frequency is capped below the render temporal Nyquist', () => {
        // At k ~ 800 the true frequency is ~34 Hz, above the 30 Hz Nyquist of a
        // 60 fps render, and the finest cascade would boil.
        const raw = angularFrequency(800);
        expect(raw).toBeGreaterThan(Math.PI * 60 * 0.5);
        const limited = limitedAngularFrequency(800, 60);
        expect(limited).toBeLessThan(Math.PI * 60);
        expect(limited).toBeLessThan(raw);
        // Below the knee it must be untouched, or slow waves would be slowed further.
        expect(limitedAngularFrequency(1, 60)).toBeCloseTo(angularFrequency(1), 9);
    });
});

describe('wind profile', () => {

    test('drag coefficient and friction velocity are in the expected range', () => {
        // C10 of order 1e-3, u* roughly 3-4% of U10 for ordinary winds.
        for (const u10 of WINDS) {
            expect(dragCoefficient(u10)).toBeGreaterThan(0.5e-3);
            expect(dragCoefficient(u10)).toBeLessThan(3e-3);
            const ratio = frictionVelocity(u10) / u10;
            expect(ratio).toBeGreaterThan(0.025);
            expect(ratio).toBeLessThan(0.06);
        }
    });

    test('U12.5 exceeds U10 by a small amount', () => {
        // The log profile only gains a few percent over 2.5 m of extra height. If this
        // ever returned something wildly different the Cox-Munk comparison would be
        // biased without any other test noticing.
        for (const u10 of WINDS) {
            const u125 = u10ToU125(u10);
            expect(u125).toBeGreaterThan(u10);
            expect(u125 / u10).toBeLessThan(1.06);
        }
    });
});

describe('spectrum conventions', () => {

    test('omnidirectional spectrum is the curvature spectrum over k^3', () => {
        const params = spectrumParams(7);
        for (const k of [0.05, 1, 40, 370, 1500]) {
            expect(omniSpectrum(k, params)).toBeCloseTo(
                curvatureSpectrum(k, params) / k ** 3, 12);
        }
    });

    test('the 2-D spectrum integrates azimuthally back to the 1-D spectrum', () => {
        // INT Psi(k,phi) k dphi = S1(k). This is the factor-of-k trap: if Psi were
        // built without the 1/k the two would differ by exactly k.
        const params = spectrumParams(7);
        for (const k of [0.2, 5, 200]) {
            const steps = 720;
            let integral = 0;
            for (let step = 0; step < steps; step++) {
                const phi = (step + 0.5) * 2 * Math.PI / steps;
                integral += directionalSpectrum(k, phi, params) * k * (2 * Math.PI / steps);
            }
            expect(integral).toBeCloseTo(omniSpectrum(k, params), 10);
        }
    });

    test('spreading Delta stays within [0,1] across the whole spectrum', () => {
        for (const u10 of WINDS) {
            const params = spectrumParams(u10);
            for (const k of [1e-3, 0.1, 1, 10, 100, CAPILLARY_K, K_MAX]) {
                const delta = spreadingDelta(k, params);
                expect(delta).toBeGreaterThanOrEqual(0);
                expect(delta).toBeLessThanOrEqual(1);
            }
        }
    });

    test('up and cross slope variance sum to the total', () => {
        // The azimuthal weights are (1/2 + Delta/4) and (1/2 - Delta/4), which sum to
        // 1 for any Delta. A factor of 2 slipped into either one would show here.
        const params = spectrumParams(10);
        const band = slopeVarianceInBand(0.01, 500, params);
        expect(band.up + band.cross).toBeCloseTo(band.total, 12);
    });
});

describe('the spectrum stays physical across the whole control range', () => {

    // The wind slider allows 0.5 to 20 m/s. Elfouhaily's alpha_m fit is a log and goes
    // NEGATIVE below about 2.7 m/s of wind, which turns the capillary half of the
    // spectrum negative and, under roughly 0.9 m/s, the total slope variance negative.
    // A negative variance is not a small error: it propagates into a Gaussian PDF and
    // a square root. The whole low end of the slider was affected.
    const FULL_RANGE = [0.5, 1, 1.5, 2, 2.5, 2.7, 3, 5, 10, 15, 20];

    test.each(FULL_RANGE)('curvature spectrum is non-negative at U10 = %p m/s', (u10) => {
        const params = spectrumParams(u10);
        for (const k of [1e-3, 0.01, 0.1, 1, 10, 100, CAPILLARY_K, 1000, K_MAX]) {
            expect(curvatureSpectrum(k, params)).toBeGreaterThanOrEqual(0);
        }
    });

    test.each(FULL_RANGE)('slope variance is positive and finite at U10 = %p m/s', (u10) => {
        const variance = totalSlopeVariance(spectrumParams(u10));
        for (const value of [variance.total, variance.up, variance.cross]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThan(0);
        }
    });

    test('a very light air gives a nearly glassy sea rather than a broken one', () => {
        // Clamping alpha_m at zero is the physically right answer, not just a safe
        // one: capillary-gravity waves need a friction velocity above a threshold, and
        // below it the surface stays smooth.
        const calm = totalSlopeVariance(spectrumParams(1)).total;
        const breeze = totalSlopeVariance(spectrumParams(5)).total;
        expect(calm).toBeLessThan(breeze);
        expect(calm).toBeGreaterThan(0);
    });

    test.each(FULL_RANGE)('wave components are finite and positive at U10 = %p m/s', (u10) => {
        for (const wave of buildWaveComponents(spectrumParams(u10)).components) {
            expect(Number.isFinite(wave.amplitude)).toBe(true);
            expect(wave.amplitude).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(wave.omega)).toBe(true);
        }
    });
});

describe('slope variance against Cox & Munk (1954)', () => {

    // The headline claim. Cox and Munk's own error bars are large (sigma_u^2 is
    // +-0.004, comparable to the value itself at low wind), so 15% is the right gate
    // and tightening it would be fitting noise.
    test.each(WINDS)('total mss is within 15%% of Cox & Munk at U10 = %i m/s', (u10) => {
        const params = spectrumParams(u10);
        const modelled = totalSlopeVariance(params).total;
        const measured = coxMunkSlopeVariance(u10ToU125(u10)).total;
        const ratio = modelled / measured;
        // U10 = 3 is the known weak point: Cox and Munk's crosswind fit carries a
        // 0.003 constant that is a small-sample artefact at the low-wind end.
        const tolerance = u10 <= 3 ? 0.30 : 0.15;
        expect(Math.abs(ratio - 1)).toBeLessThan(tolerance);
    });

    test('upwind slope variance exceeds crosswind, as measured', () => {
        for (const u10 of WINDS) {
            const band = totalSlopeVariance(spectrumParams(u10));
            expect(band.up).toBeGreaterThan(band.cross);
        }
    });

    test('the anisotropy ratio tracks Cox & Munk for moderate and strong wind', () => {
        // This one comes out of Elfouhaily's Delta(k) with no tuning at all, which is
        // a strong independent check that the spreading function is right.
        for (const u10 of [7, 10, 15]) {
            const band = totalSlopeVariance(spectrumParams(u10));
            const measured = coxMunkSlopeVariance(u10ToU125(u10));
            const modelledRatio = band.up / band.cross;
            const measuredRatio = measured.up / measured.cross;
            expect(Math.abs(modelledRatio / measuredRatio - 1)).toBeLessThan(0.15);
        }
    });

    test('slope variance rises monotonically with wind speed', () => {
        let previous = 0;
        for (const u10 of WINDS) {
            const total = totalSlopeVariance(spectrumParams(u10)).total;
            expect(total).toBeGreaterThan(previous);
            previous = total;
        }
    });
});

describe('numerical truncation', () => {

    test('the mss integral has converged by K_MAX', () => {
        // K_MAX is a numerical truncation, not a physical cutoff, so it has to be
        // demonstrably past the point where the answer stops moving. Doubling it must
        // change nothing.
        const params = spectrumParams(7);
        const toKMax = slopeVarianceInBand(2 * Math.PI / K_MAX, 1e5, params, 8192).total;
        const toDouble = slopeVarianceInBand(2 * Math.PI / (2 * K_MAX), 1e5, params, 8192).total;
        expect(Math.abs(toDouble / toKMax - 1)).toBeLessThan(0.01);
    });

    test('stopping at the capillary peak measurably under-reads', () => {
        // Guards against someone "simplifying" K_MAX down to km. It is the peak of
        // the curvature spectrum, not the end of it.
        const params = spectrumParams(7);
        const full = slopeVarianceInBand(2 * Math.PI / K_MAX, 1e5, params, 8192).total;
        const truncated = slopeVarianceInBand(2 * Math.PI / CAPILLARY_K, 1e5, params, 8192).total;
        expect(truncated).toBeLessThan(full * 0.95);
    });

    test('band integrals partition the spectrum without gap or overlap', () => {
        const params = spectrumParams(7);
        const edges = [2 * Math.PI / K_MAX, 0.01, 0.1, 1, 10, 100, 1000];
        let summed = 0;
        for (let edge = 0; edge + 1 < edges.length; edge++) {
            summed += slopeVarianceInBand(edges[edge], edges[edge + 1], params).total;
        }
        const whole = slopeVarianceInBand(edges[0], edges[edges.length - 1], params).total;
        expect(summed).toBeCloseTo(whole, 6);
    });

    test('most of the slope variance lives below one metre of wavelength', () => {
        // The quantitative statement of why a 33 m sinusoid cannot make a sea. If this
        // ever stops being true the spectrum has been broken.
        const params = spectrumParams(5);
        const whole = totalSlopeVariance(params).total;
        const longWaves = slopeVarianceInBand(6.3, 1e5, params).total;
        expect(longWaves / whole).toBeLessThan(0.20);
    });
});

describe('cascade design', () => {

    test('no two tile sizes are close to an integer ratio', () => {
        // The repetition guarantee. Bruneton's widely copied 5488/392/28/2 fails this
        // outright — every ratio is exactly 14 — and the summed field then repeats
        // every 5488 m. Near-integer is nearly as bad as integer, because the beat
        // between two almost-commensurate lattices is itself a visible periodicity.
        for (let outer = 0; outer < CASCADE_SIZES.length; outer++) {
            for (let inner = outer + 1; inner < CASCADE_SIZES.length; inner++) {
                const ratio = CASCADE_SIZES[outer] / CASCADE_SIZES[inner];
                expect(Math.abs(ratio - Math.round(ratio))).toBeGreaterThan(0.15);
            }
        }
    });

    test('every cascade has its own lattice rotation', () => {
        const unique = new Set(CASCADE_ROTATIONS_DEG.slice(0, CASCADE_SIZES.length));
        expect(unique.size).toBe(CASCADE_SIZES.length);
    });

    test('default cascades keep visible-repeat exposure low across the wind range', () => {
        // NOT a cap on how much variance a cascade carries — the finest cascade always
        // carries the most, because that is where the slope variance physically lives,
        // and capping that would be fighting the ocean rather than the artefact.
        //
        // What matters is how much it can show as a REPEATING PATTERN: the band
        // lambda in [L/4, L], which is the only part still resolved by the time the
        // tile period has narrowed to a mere four pixels.
        //
        // The budget is wind-dependent on purpose, and the measured numbers are:
        //
        //     U10 (m/s)     3     5     7    10    12    15
        //     lambda_p (m)  8.2  22.7  44.5  90.8 130.7 204.2
        //     risk, 113 m   0.0%  0.3%  3.5%  7.3%  8.1%  7.9%
        //     risk, 422 m   0.0%  0.0%  0.0%  0.3%  1.1%  2.6%
        //
        // The spectral peak moves to longer waves as the wind rises, so somewhere
        // around 7-10 m/s it drifts INTO the 113 m tile's at-risk band [28, 113] m and
        // no fixed tile size can dodge it — it peaks near 8% and then falls again as
        // the peak passes on through. That residue is what the lattice rotation and the
        // long-wave advection of short waves are there to break up.
        for (const wind of [3, 5, 7]) {
            for (const cascade of describeCascades(spectrumParams(wind)).cascades) {
                expect(cascade.tilingRisk).toBeLessThan(0.05);
            }
        }
        for (const wind of [10, 12, 15]) {
            for (const cascade of describeCascades(spectrumParams(wind)).cascades) {
                expect(cascade.tilingRisk).toBeLessThan(0.10);
            }
        }
    });

    test('tiling risk grows with wind, which is why rotation and advection exist', () => {
        // Documents the trend rather than letting it be rediscovered as a bug.
        const risk = (wind) => Math.max(
            ...describeCascades(spectrumParams(wind)).cascades.map(c => c.tilingRisk));
        expect(risk(15)).toBeGreaterThan(risk(5));
    });

    test('tiling risk falls monotonically as the tile grows', () => {
        // The property the sizing rests on, and the reason the usual four-or-five
        // cascade recipe running down to a 2 m tile is the wrong trade here: a 2 m tile
        // can expose ~23% of the variance as a repeat, a 113 m tile ~0.3%.
        const params = spectrumParams(5);
        const total = totalSlopeVariance(params).total;
        const sizes = [2, 4, 8.9, 20, 31.7, 50, 113.3, 421.7];
        let previous = Infinity;
        for (const size of sizes) {
            const risk = tilingRiskShare(size, params, total);
            expect(risk).toBeLessThanOrEqual(previous);
            previous = risk;
        }
        expect(tilingRiskShare(2, params, total)).toBeGreaterThan(0.15);
        expect(tilingRiskShare(113.3, params, total)).toBeLessThan(0.01);
    });

    test('the close-up cascade set trades tiling risk for near-field detail', () => {
        // Documents the cost of the opt-in third cascade rather than letting it be
        // added later as if it were free.
        const params = spectrumParams(5);
        const base = describeCascades(params, {sizes: CASCADE_SIZES});
        const closeup = describeCascades(params, {sizes: CASCADE_SIZES_CLOSEUP});
        const worst = (d) => Math.max(...d.cascades.map(c => c.tilingRisk));
        expect(worst(closeup)).toBeGreaterThan(worst(base));
        // ...and it does buy something: a finer resolvable wavelength.
        const finest = (d) => d.cascades[d.cascades.length - 1].nyquistWavelength;
        expect(finest(closeup)).toBeLessThan(finest(base));
    });

    test('the default set still resolves waves worth resolving', () => {
        // 0.44 m at a 512 grid. Shorter waves are only resolvable within a few hundred
        // metres of the camera, which is why they are left to the statistical term.
        const described = describeCascades(spectrumParams(5), {fftSize: 512});
        const finest = described.cascades[described.cascades.length - 1];
        expect(finest.nyquistWavelength).toBeLessThan(0.5);
    });

    test('cascade bands plus head and tail account for the whole spectrum', () => {
        const described = describeCascades(spectrumParams(7));
        const summed = described.cascades.reduce((acc, c) => acc + c.variance.total, 0)
            + described.headVariance.total + described.tailVariance.total;
        expect(summed).toBeCloseTo(described.total.total, 6);
    });

    test('the unresolvable tail is significant and must not be dropped', () => {
        // At a 2 m tile on a 512 grid the finest resolvable wave is 8 mm, and the
        // curvature spectrum is still substantial there. Silently discarding this band
        // makes close water too glossy.
        const described = describeCascades(spectrumParams(7), {fftSize: 512});
        expect(described.tailVariance.total / described.total.total).toBeGreaterThan(0.02);
    });

    test('a coarser FFT grid moves variance from cascades into the tail', () => {
        const fine = describeCascades(spectrumParams(7), {fftSize: 512});
        const coarse = describeCascades(spectrumParams(7), {fftSize: 256});
        expect(coarse.tailVariance.total).toBeGreaterThan(fine.tailVariance.total);
        // ...and the total is conserved either way, which is the property that lets
        // resolution be a pure performance dial.
        const fineSum = fine.cascades.reduce((a, c) => a + c.variance.total, 0)
            + fine.headVariance.total + fine.tailVariance.total;
        const coarseSum = coarse.cascades.reduce((a, c) => a + c.variance.total, 0)
            + coarse.headVariance.total + coarse.tailVariance.total;
        expect(fineSum).toBeCloseTo(coarseSum, 6);
    });
});

describe('wave components', () => {

    const params = spectrumParams(7);

    test('the component set reproduces the spectrum slope variance it claims to cover', () => {
        // The whole point of sampling the spectrum rather than inventing waves: the
        // sum of (a*k)^2/2 over components must equal the band integral. A factor of
        // two in the amplitude formula lands here and nowhere else.
        const built = buildWaveComponents(params, {lambdaMin: 0.35, lambdaMax: 420});
        const direct = slopeVarianceInBand(0.35, 420, params);
        const summed = built.components.reduce(
            (sum, wave) => sum + 0.5 * (wave.amplitude * wave.k) ** 2, 0);
        expect(summed / direct.total).toBeCloseTo(1.0, 1);
    });

    test('per-axis variances sum to the per-component total', () => {
        for (const wave of buildWaveComponents(params).components) {
            const componentTotal = 0.5 * (wave.amplitude * wave.k) ** 2;
            expect(wave.varianceUp + wave.varianceCross).toBeCloseTo(componentTotal, 9);
        }
    });

    test('represented plus residual variance equals the whole spectrum', () => {
        // Nothing may be silently dropped: waves outside the represented band are real
        // roughness and have to reach the BRDF term.
        const built = buildWaveComponents(params);
        expect(built.represented.up + built.residual.up).toBeCloseTo(built.total.up, 6);
        expect(built.represented.cross + built.residual.cross).toBeCloseTo(built.total.cross, 6);
    });

    test('the residual is a large share, which is correct not a defect', () => {
        // Most of the slope variance lives in waves under 35 cm, which no camera in
        // these scenes is close enough to resolve. It belongs in the statistical term.
        const built = buildWaveComponents(params);
        const residualShare = built.residual.up / built.total.up;
        expect(residualShare).toBeGreaterThan(0.2);
        expect(residualShare).toBeLessThan(0.95);
    });

    test('components are deterministic for a given seed', () => {
        // Required for the visual regression suite and for exported images to match
        // the preview that produced them.
        const first = buildWaveComponents(params, {seed: 99});
        const second = buildWaveComponents(params, {seed: 99});
        expect(first.components.map(w => w.kx)).toEqual(second.components.map(w => w.kx));
        expect(first.components.map(w => w.phase)).toEqual(second.components.map(w => w.phase));
        const other = buildWaveComponents(params, {seed: 100});
        expect(other.components.map(w => w.phase))
            .not.toEqual(first.components.map(w => w.phase));
    });

    test('there is no periodic domain — wavelengths are mutually incommensurate', () => {
        // The structural reason this cannot repeat. A grid-based method hands back a
        // tile; a sum of wave trains has no tile to hand back. Guard against anyone
        // "tidying" the wavenumbers into a harmonic series, which would reintroduce a
        // common period.
        const lengths = buildWaveComponents(params).components.map(w => w.wavelength);
        const unique = new Set(lengths.map(l => l.toFixed(6)));
        expect(unique.size).toBeGreaterThan(1);
        for (const wavelength of lengths) {
            const ratio = lengths[0] / wavelength;
            if (Math.abs(ratio - 1) < 1e-9) continue;
            expect(Math.abs(ratio - Math.round(ratio))).toBeGreaterThan(1e-6);
        }
    });

    test('gravity waves all travel downwind, capillary waves may go either way', () => {
        // A centro-symmetric spreading function describes the SPREAD, not the
        // direction of travel. Taken literally it sends half the gravity-wave energy
        // upwind, and the sea visibly streams the wrong way.
        const built = buildWaveComponents(params);
        const gravity = built.components.filter(w => w.k <= CAPILLARY_K * 0.25);
        expect(gravity.length).toBeGreaterThan(0);
        for (const wave of gravity) expect(wave.kx).toBeGreaterThan(0);
    });

    test('the residual must be ADDED to the trains, not replace them', () => {
        // The shader keeps two pieces of roughness: what each train leaves unresolved
        // at this pixel, and the band no train covers at all. Assigning only the first
        // — which the first version did — silently drops about two fifths of the sea's
        // slope variance at EVERY distance, making far water too glossy and the
        // glitter path too narrow. That is the exact symptom this method exists to
        // cure, so it would have looked like the method simply not working.
        //
        // This asserts the two pieces are both large enough to matter and that they
        // sum to the whole.
        const built = buildWaveComponents(params);
        const trainsWhenFullyUnresolved = built.components.reduce(
            (sum, wave) => sum + wave.varianceUp, 0);
        expect(trainsWhenFullyUnresolved).toBeGreaterThan(0.1 * built.total.up);
        expect(built.residual.up).toBeGreaterThan(0.1 * built.total.up);
        expect(trainsWhenFullyUnresolved + built.residual.up)
            .toBeCloseTo(built.total.up, 6);
    });

    test('component count follows the band and direction settings', () => {
        const built = buildWaveComponents(params, {bands: 12, directionsPerBand: 3});
        expect(built.components.length).toBe(36);
    });

    test('stronger wind gives larger amplitudes at the same wavelength', () => {
        const calm = buildWaveComponents(spectrumParams(4), {bands: 8, directionsPerBand: 1});
        const windy = buildWaveComponents(spectrumParams(12), {bands: 8, directionsPerBand: 1});
        const calmTotal = calm.components.reduce((sum, w) => sum + w.amplitude, 0);
        const windyTotal = windy.components.reduce((sum, w) => sum + w.amplitude, 0);
        expect(windyTotal).toBeGreaterThan(calmTotal);
    });
});

describe('Fresnel', () => {

    test('normal incidence matches the analytic F0 for sea water', () => {
        const f0 = ((1.34 - 1) / (1.34 + 1)) ** 2;
        expect(fresnelReflectance(1.0)).toBeCloseTo(f0, 6);
        expect(f0).toBeCloseTo(0.0211, 4);
    });

    test('reflectance reaches unity at grazing and rises monotonically', () => {
        expect(fresnelReflectance(0.0)).toBeCloseTo(1.0, 6);
        let previous = -1;
        for (let step = 20; step >= 0; step--) {
            const value = fresnelReflectance(step / 20);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
        }
    });

    test('Schlick is close but not exact, which is why we use the real thing', () => {
        // Documents the actual size of the error rather than asserting a slogan.
        const cosTheta = Math.cos(70 * Math.PI / 180);
        const exact = fresnelReflectance(cosTheta);
        const f0 = 0.0211;
        const schlick = f0 + (1 - f0) * (1 - cosTheta) ** 5;
        expect(Math.abs(schlick - exact)).toBeLessThan(0.05);
    });
});

describe('Smith shadowing-masking', () => {

    test('erfc approximation matches known values', () => {
        expect(erfcApprox(0)).toBeCloseTo(1.0, 6);
        expect(erfcApprox(0.5)).toBeCloseTo(0.4795, 3);
        expect(erfcApprox(1.0)).toBeCloseTo(0.1573, 3);
        expect(erfcApprox(2.0)).toBeCloseTo(0.00468, 4);
    });

    test('Lambda vanishes at normal incidence and grows towards grazing', () => {
        const sigma = 0.2;
        // cot(theta) is large near normal incidence, small near grazing.
        expect(smithLambda(20, sigma)).toBeCloseTo(0, 5);
        expect(smithLambda(1.0, sigma)).toBeGreaterThan(0);
        expect(smithLambda(0.1, sigma)).toBeGreaterThan(smithLambda(1.0, sigma));
    });

    test('G is bounded in (0,1] and falls towards grazing', () => {
        const sigma = 0.2;
        const nearNormal = smithG(20, 20, sigma, sigma);
        const nearGrazing = smithG(0.05, 0.05, sigma, sigma);
        expect(nearNormal).toBeLessThanOrEqual(1.0);
        expect(nearNormal).toBeCloseTo(1.0, 3);
        expect(nearGrazing).toBeGreaterThan(0);
        expect(nearGrazing).toBeLessThan(nearNormal);
    });

    test('rougher surfaces shadow more', () => {
        expect(smithG(0.2, 0.2, 0.30, 0.30)).toBeLessThan(smithG(0.2, 0.2, 0.05, 0.05));
    });

    test('azimuthal sigma interpolates between the wind-frame axes', () => {
        const up = 0.25, cross = 0.15;
        expect(slopeSigmaInAzimuth(up, cross, 1, 0)).toBeCloseTo(up, 9);
        expect(slopeSigmaInAzimuth(up, cross, 0, 1)).toBeCloseTo(cross, 9);
        const diagonal = slopeSigmaInAzimuth(up, cross, Math.SQRT1_2, Math.SQRT1_2);
        expect(diagonal).toBeGreaterThan(cross);
        expect(diagonal).toBeLessThan(up);
    });
});

describe('whitecaps', () => {

    test('coverage is negligible in light wind and a few percent in a gale', () => {
        expect(whitecapCoverage(3)).toBeLessThan(0.0005);
        expect(whitecapCoverage(10)).toBeGreaterThan(0.005);
        expect(whitecapCoverage(10)).toBeLessThan(0.02);
        expect(whitecapCoverage(15)).toBeGreaterThan(0.02);
        expect(whitecapCoverage(15)).toBeLessThan(0.08);
    });

    test('coverage is zero at zero wind and never exceeds unity', () => {
        expect(whitecapCoverage(0)).toBe(0);
        expect(whitecapCoverage(100)).toBeLessThanOrEqual(1);
    });
});

describe('water-leaving reflectance', () => {

    test('open ocean is blue-dominant', () => {
        const [red, green, blue] = waterLeavingReflectance('ocean');
        expect(blue).toBeGreaterThan(green);
        expect(green).toBeGreaterThan(red);
        // Deep blue means a large blue-to-red ratio, not merely an ordering.
        expect(blue / red).toBeGreaterThan(10);
    });

    test('turbid water is green-dominant', () => {
        const [red, green, blue] = waterLeavingReflectance('turbid');
        expect(green).toBeGreaterThan(blue);
        expect(green).toBeGreaterThan(red);
    });

    test('coastal water sits between the two', () => {
        const ocean = waterLeavingReflectance('ocean');
        const coastal = waterLeavingReflectance('coastal');
        const turbid = waterLeavingReflectance('turbid');
        const blueness = (rgb) => rgb[2] / rgb[1];
        expect(blueness(coastal)).toBeLessThan(blueness(ocean));
        expect(blueness(coastal)).toBeGreaterThan(blueness(turbid));
    });

    test('reflectance stays in a physically plausible range', () => {
        // Water-leaving reflectance is a few percent at most; anything approaching a
        // Lambertian white would mean the interface conversion had been applied twice
        // or not at all.
        for (const type of ['ocean', 'coastal', 'turbid']) {
            for (const channel of waterLeavingReflectance(type)) {
                expect(channel).toBeGreaterThan(0);
                expect(channel).toBeLessThan(0.05);
            }
        }
    });

    test('an unknown water type falls back to open ocean rather than throwing', () => {
        expect(waterLeavingReflectance('lava')).toEqual(waterLeavingReflectance('ocean'));
    });
});
