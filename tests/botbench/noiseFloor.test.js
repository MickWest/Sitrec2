/**
 * The residual NOISE FLOOR that BotBenchRunner reports beside every |err|.
 *
 * WHY THIS EXISTS. A bulk run over ten real-track scenarios showed three files
 * tied at a 0.039 deg top residual whose separations from truth were 0.2%, 1.4%
 * and 97.5% of range. The residual had been the only quality number on the row,
 * and it cannot carry range: bearings are nearly invariant to how far along the
 * sightline a track is placed. The floor gives the residual the one honest
 * reading it does support — "is this better than a perfect answer would score,
 * i.e. is it fitting the noise?"
 *
 * The claim under test is that a PERFECT track does not score zero. Its mean
 * angular residual is sigma * sqrt(pi/2), because the per-frame pointing error
 * is two independent Gaussians in the tangent plane and the MAGNITUDE of such a
 * pair is Rayleigh-distributed. Getting this constant wrong (sigma, or
 * sigma*sqrt(2)) moves the floor by 20-40% and silently changes which rows are
 * flagged, so it is pinned here by Monte Carlo rather than by restating it.
 */

const RAYLEIGH_MEAN = Math.sqrt(Math.PI / 2);
const RAYLEIGH_SD = Math.sqrt(2 - Math.PI / 2);

// Deterministic normal deviates: Box-Muller over mulberry32. A plain LCG was
// tried first and its low bits correlate badly enough with Box-Muller's paired
// draws to bias the mean by a quarter of a percent — small, but larger than the
// sampling error, which would have read as the constant being wrong.
function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function normalPair(rnd) {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

describe("residual noise floor", () => {
    test("a perfect track's mean angular residual is sigma * 1.2533, not sigma", () => {
        const sigma = 0.03;
        const rnd = makeRandom(12345);
        const N = 200000;
        let sum = 0, sumSq = 0;
        for (let i = 0; i < N; i++) {
            // Truth is exact, so the whole residual IS the pointing error: two
            // independent Gaussian components in the tangent plane.
            const [a, b] = normalPair(rnd);
            const mag = Math.hypot(a * sigma, b * sigma);
            sum += mag;
            sumSq += mag * mag;
        }
        const mean = sum / N;
        const sd = Math.sqrt(sumSq / N - mean * mean);

        // Relative, not absolute: the quantity scales with sigma, so a fixed
        // number of decimal places would silently tighten or loosen if the
        // declared noise of a scenario set ever changed.
        expect(Math.abs(mean - sigma * RAYLEIGH_MEAN) / (sigma * RAYLEIGH_MEAN))
            .toBeLessThan(0.005);
        expect(Math.abs(sd - sigma * RAYLEIGH_SD) / (sigma * RAYLEIGH_SD))
            .toBeLessThan(0.01);

        // The two constants a reader might reach for instead, both wrong, and
        // wrong by enough to change which rows the report flags.
        expect(Math.abs(mean - sigma) / mean).toBeGreaterThan(0.15);
        expect(Math.abs(mean - sigma * Math.SQRT2) / mean).toBeGreaterThan(0.10);
    });

    test("the floor matches the truth residuals a real run measured", () => {
        // Measured by the shipping analysis over the nine white-noise files of
        // the real-track arm, which all declare sigma = 0.03 deg. These are the
        // truth track's OWN residuals — the empirical floor — and the predicted
        // value has to land inside them or the model behind the column is wrong.
        const measured = [0.03812, 0.03705, 0.03705, 0.03761, 0.03652,
            0.03829, 0.04006, 0.04006, 0.03715];
        const predicted = 0.03 * RAYLEIGH_MEAN;

        expect(predicted).toBeGreaterThan(Math.min(...measured));
        expect(predicted).toBeLessThan(Math.max(...measured));
        const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
        // Within 2.5% of the mean of nine realisations. It measures 1.0% low,
        // which is what nine clips of 31 to 721 frames should give: the two
        // 31-frame files sit highest in the list, and a short clip's residual
        // mean is the noisiest estimate of the floor in the set.
        expect(Math.abs(predicted - mean) / mean).toBeLessThan(0.025);
    });

    test("the sampling error shrinks as 1/sqrt(n), so long clips separate more", () => {
        // The report calls a winner's lead "inside the noise" when it is under
        // 2 standard errors of a residual MEAN over n frames. That threshold is
        // only meaningful if the standard error carries n correctly.
        const sigma = 0.03;
        const se = (n) => sigma * RAYLEIGH_SD / Math.sqrt(n);

        expect(se(301) / se(31)).toBeCloseTo(Math.sqrt(31 / 301), 6);
        // The two extremes of the measured run: a 31-frame clip cannot resolve
        // residual differences a 301-frame clip can.
        expect(se(31)).toBeCloseTo(0.00353, 5);
        expect(se(301)).toBeCloseTo(0.00113, 5);

        // The dash case, which is the reason the flag exists: the winner led by
        // 0.0001 deg over 301 frames. That is a fourteenth of one standard
        // error, so the ranking there was decided by the noise draw.
        expect(0.0001).toBeLessThan(2 * se(301));
    });
});
