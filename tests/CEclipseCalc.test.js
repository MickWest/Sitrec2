import * as Astronomy from "astronomy-engine";
import {
    NO_ECLIPSE,
    eclipseLightFraction,
    eclipseVisualGates,
    getEclipseState,
    sunDiskObscuration,
} from "../src/CEclipseCalc";
import {RLLAToECEF_radii} from "../src/LLA-ECEF-ENU";

const DEG = Math.PI / 180;

// Palma de Mallorca — inside the totality path of the 2026-08-12 eclipse.
const MALLORCA_LAT = 39.57;
const MALLORCA_LON = 2.65;
const MALLORCA_ECEF = RLLAToECEF_radii(MALLORCA_LAT * DEG, MALLORCA_LON * DEG, 20);

// Albuquerque — on the centerline of the 2023-10-14 ANNULAR eclipse.
const ABQ_LAT = 35.08;
const ABQ_LON = -106.65;
const ABQ_ECEF = RLLAToECEF_radii(ABQ_LAT * DEG, ABQ_LON * DEG, 1600);

// Bisect a boolean predicate's false→true (or true→false) transition time.
// loMs must evaluate differently from hiMs. Returns ms accurate to tolMs.
function bisectTransition(predicate, loMs, hiMs, tolMs = 50) {
    let lo = loMs, hi = hiMs;
    const loVal = predicate(lo);
    while (hi - lo > tolMs) {
        const mid = (lo + hi) / 2;
        if (predicate(mid) === loVal) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

describe("sunDiskObscuration (two-circle overlap)", () => {
    const rs = 0.00465; // ~Sun angular radius (rad)

    test("zero at and beyond first contact", () => {
        const rm = rs * 1.03;
        expect(sunDiskObscuration(rs, rm, rs + rm)).toBe(0);
        expect(sunDiskObscuration(rs, rm, rs * 5)).toBe(0);
    });

    test("total when the Moon disk contains the Sun disk", () => {
        expect(sunDiskObscuration(rs, rs * 1.03, 0)).toBe(1);
        expect(sunDiskObscuration(rs, rs * 1.03, rs * 0.02)).toBe(1);
    });

    test("annular: capped at the area ratio when the Moon is smaller", () => {
        const rm = rs * 0.97;
        expect(sunDiskObscuration(rs, rm, 0)).toBeCloseTo(0.97 * 0.97, 10);
    });

    test("equal disks, concentric: fully covered", () => {
        expect(sunDiskObscuration(rs, rs, 0)).toBe(1);
    });

    test("half-overlap sanity: equal disks at d = r cover ~39%", () => {
        // Standard lens-area result for d = r: 1 - (3*sqrt(3))/(4*pi) ≈ 0.3910
        expect(sunDiskObscuration(rs, rs, rs)).toBeCloseTo(0.391, 3);
    });

    test("monotonically increasing as separation shrinks", () => {
        const rm = rs * 1.03;
        let prev = -1;
        for (let i = 0; i <= 50; i++) {
            const d = (rs + rm) * (1 - i / 50);
            const o = sunDiskObscuration(rs, rm, d);
            expect(o).toBeGreaterThanOrEqual(prev);
            prev = o;
        }
        expect(prev).toBe(1);
    });
});

describe("eclipseLightFraction (limb-darkened flux)", () => {
    test("endpoints are exact", () => {
        expect(eclipseLightFraction(0)).toBe(1);
        expect(eclipseLightFraction(1)).toBe(0);
    });

    test("limb covered first: flux falls SLOWER than area early on", () => {
        expect(eclipseLightFraction(0.25)).toBeGreaterThan(0.75);
    });

    test("limb uncovered last: flux falls FASTER than area near totality", () => {
        expect(eclipseLightFraction(0.75)).toBeLessThan(0.25);
        expect(eclipseLightFraction(0.99)).toBeLessThan(0.01);
    });

    test("smooth and strictly decreasing", () => {
        let prev = 1.1;
        for (let o = 0; o <= 1.0001; o += 0.01) {
            const f = eclipseLightFraction(o);
            expect(f).toBeLessThan(prev);
            prev = f;
        }
    });
});

describe("getEclipseState", () => {
    test("hard no-op: returns the frozen NO_ECLIPSE object away from any eclipse", () => {
        // New moon is nowhere near the Sun on this date.
        const state = getEclipseState(MALLORCA_ECEF, new Date(Date.UTC(2026, 7, 4, 12, 0, 0)));
        expect(state).toBe(NO_ECLIPSE);
        expect(state.obscuration).toBe(0);
        expect(state.lightFraction).toBe(1);
    });

    test("matches astronomy-engine's own local eclipse solution for Mallorca 2026-08-12", () => {
        const observer = new Astronomy.Observer(MALLORCA_LAT, MALLORCA_LON, 20);
        const info = Astronomy.SearchLocalSolarEclipse(new Date(Date.UTC(2026, 7, 1)), observer);

        // The library should find the total eclipse of 2026-08-12 for this spot.
        expect(info.kind).toBe(Astronomy.EclipseKind.Total);
        const peakDate = info.peak.time.date;
        expect(peakDate.getUTCFullYear()).toBe(2026);
        expect(peakDate.getUTCMonth()).toBe(7);
        expect(peakDate.getUTCDate()).toBe(12);

        // At peak our geometric obscuration must agree it is total.
        const peakState = getEclipseState(MALLORCA_ECEF, peakDate);
        expect(peakState.obscuration).toBeCloseTo(info.obscuration, 2);
        expect(peakState.obscuration).toBe(1);
        expect(peakState.lightFraction).toBe(0);
        expect(peakState.ratio).toBeGreaterThan(1);       // total, not annular
        expect(peakState.exposedFrac).toBeLessThan(0);    // photosphere fully hidden

        // Our second/third contact (exposedFrac crossing zero) should bracket
        // the library's totality window to within a few seconds.
        const totalBegin = info.total_begin.time.date.getTime();
        const totalEnd = info.total_end.time.date.getTime();
        const justBefore = getEclipseState(MALLORCA_ECEF, new Date(totalBegin - 5000));
        const justInside = getEclipseState(MALLORCA_ECEF, new Date(totalBegin + 5000));
        const stillInside = getEclipseState(MALLORCA_ECEF, new Date(totalEnd - 5000));
        const justAfter = getEclipseState(MALLORCA_ECEF, new Date(totalEnd + 5000));
        expect(justBefore.exposedFrac).toBeGreaterThan(0);
        expect(justInside.exposedFrac).toBeLessThan(0);
        expect(stillInside.exposedFrac).toBeLessThan(0);
        expect(justAfter.exposedFrac).toBeGreaterThan(0);

        // Mid-partial phase: meaningfully obscured but not total.
        const partialBegin = info.partial_begin.time.date.getTime();
        const midPartial = getEclipseState(
            MALLORCA_ECEF,
            new Date((partialBegin + totalBegin) / 2)
        );
        expect(midPartial.obscuration).toBeGreaterThan(0.05);
        expect(midPartial.obscuration).toBeLessThan(1);
        expect(midPartial.lightFraction).toBeGreaterThan(0);
        expect(midPartial.lightFraction).toBeLessThan(1);
    });

    test("angular radii are physically sensible during the eclipse", () => {
        const state = getEclipseState(MALLORCA_ECEF, new Date(Date.UTC(2026, 7, 12, 18, 28, 0)));
        // Sun ~0.262-0.271°, Moon within ~10% of the Sun.
        expect(state.sunRad / DEG).toBeGreaterThan(0.25);
        expect(state.sunRad / DEG).toBeLessThan(0.28);
        expect(state.moonRad / DEG).toBeGreaterThan(0.24);
        expect(state.moonRad / DEG).toBeLessThan(0.30);
    });

    test("results are cached per (time, position)", () => {
        const date = new Date(Date.UTC(2026, 7, 12, 18, 28, 0));
        const a = getEclipseState(MALLORCA_ECEF, date);
        const b = getEclipseState(MALLORCA_ECEF, date);
        expect(b).toBe(a);
    });

    // Pins all four contact times to sub-second agreement with the library's
    // own eclipse solution. This is the regression tripwire for the physical
    // constants: the pre-fix Sun radius (696,000 km instead of the IAU
    // 695,700 km) shifted every contact by ~0.6-0.7 s and would FAIL here.
    test("C1-C4 contact times match the library eclipse solution to <0.5 s", () => {
        const observer = new Astronomy.Observer(MALLORCA_LAT, MALLORCA_LON, 20);
        const info = Astronomy.SearchLocalSolarEclipse(new Date(Date.UTC(2026, 7, 1)), observer);

        const obscured = (ms) => getEclipseState(MALLORCA_ECEF, new Date(ms)).obscuration > 0;
        const hidden = (ms) => getEclipseState(MALLORCA_ECEF, new Date(ms)).exposedFrac < 0;

        const c1Lib = info.partial_begin.time.date.getTime();
        const c2Lib = info.total_begin.time.date.getTime();
        const c3Lib = info.total_end.time.date.getTime();
        const c4Lib = info.partial_end.time.date.getTime();

        const c1 = bisectTransition(obscured, c1Lib - 120000, c1Lib + 120000);
        const c2 = bisectTransition(hidden, c2Lib - 60000, c2Lib + 30000);
        const c3 = bisectTransition(hidden, c3Lib - 30000, c3Lib + 60000);
        const c4 = bisectTransition(obscured, c4Lib - 120000, c4Lib + 120000);

        expect(Math.abs(c1 - c1Lib)).toBeLessThan(500);
        expect(Math.abs(c2 - c2Lib)).toBeLessThan(500);
        expect(Math.abs(c3 - c3Lib)).toBeLessThan(500);
        expect(Math.abs(c4 - c4Lib)).toBeLessThan(500);
    });
});

describe("annular eclipse (Albuquerque 2023-10-14)", () => {
    const observer = new Astronomy.Observer(ABQ_LAT, ABQ_LON, 1600);
    const info = Astronomy.SearchLocalSolarEclipse(new Date(Date.UTC(2023, 9, 1)), observer);

    test("library finds the annular eclipse", () => {
        expect(info.kind).toBe(Astronomy.EclipseKind.Annular);
    });

    test("peak state: annular geometry, obscuration matches, photosphere exposed", () => {
        const peak = getEclipseState(ABQ_ECEF, info.peak.time.date);
        expect(peak.ratio).toBeLessThan(1);          // Moon too small — annular
        expect(peak.exposedFrac).toBeGreaterThan(0); // ring of photosphere remains
        expect(peak.obscuration).toBeLessThan(1);
        // Library uses the Moon's polar radius for obscuration; we use the
        // mean radius — agree to a few parts per thousand.
        expect(Math.abs(peak.obscuration - info.obscuration)).toBeLessThan(0.005);
    });

    test("totality-only visuals NEVER fire during annularity", () => {
        // Sweep the whole annular phase (plus margins): no corona, no
        // diamond ring, and no beads during the stable ring.
        const t1 = info.total_begin.time.date.getTime();
        const t2 = info.total_end.time.date.getTime();
        for (let ms = t1 - 30000; ms <= t2 + 30000; ms += 5000) {
            const gates = eclipseVisualGates(getEclipseState(ABQ_ECEF, new Date(ms)));
            expect(gates.corona).toBe(0);
            expect(gates.diamond).toBe(0);
        }
        // Beads OFF at maximum annularity (the ring is stable there)...
        const peakGates = eclipseVisualGates(getEclipseState(ABQ_ECEF, info.peak.time.date));
        expect(peakGates.beads).toBeLessThan(0.01);
        // ...but ON at the internal contacts where the limbs are tangent.
        const beadsBegin = eclipseVisualGates(getEclipseState(ABQ_ECEF, info.total_begin.time.date));
        const beadsEnd = eclipseVisualGates(getEclipseState(ABQ_ECEF, info.total_end.time.date));
        expect(beadsBegin.beads).toBeGreaterThan(0.5);
        expect(beadsEnd.beads).toBeGreaterThan(0.5);
    });
});

describe("eclipseVisualGates (total geometry)", () => {
    const totalState = (exposedFrac) => ({
        obscuration: 0.999,
        lightFraction: 0.001,
        exposedFrac,
        ratio: 1.03,
    });

    test("hard zero away from contact and for no-eclipse states", () => {
        expect(eclipseVisualGates(NO_ECLIPSE).corona).toBe(0);
        expect(eclipseVisualGates(null).beads).toBe(0);
        expect(eclipseVisualGates(totalState(0.5)).corona).toBe(0);
    });

    test("corona full and beads/diamond dead in deep totality", () => {
        const deep = eclipseVisualGates(totalState(-0.03));
        expect(deep.corona).toBe(1);
        expect(deep.beads).toBe(0);
        expect(deep.diamond).toBe(0);
    });

    test("beads and diamond peak around second/third contact", () => {
        const atContact = eclipseVisualGates(totalState(0.001));
        expect(atContact.beads).toBeGreaterThan(0.9);
        const diamondMoment = eclipseVisualGates(totalState(0.015));
        expect(diamondMoment.diamond).toBeGreaterThan(0.9);
    });
});
