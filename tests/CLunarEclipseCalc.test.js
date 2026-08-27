import * as Astronomy from "astronomy-engine";
import {Vector3} from "three";
import {
    EARTH_MEAN_RADIUS_KM,
    MOON_MEAN_RADIUS_KM,
    NO_LUNAR_ECLIPSE,
    SUN_RADIUS_KM,
    danjonFromIllumination,
    directSunlightAt,
    getLunarEclipseState,
    getShadowGeometry,
    getUmbralProfile,
    lunarDiskIllumination,
    lunarEclipseDimming,
    lunarEclipseRender,
    sampleUmbralProfile,
    shadowRadiiKm,
} from "../src/CLunarEclipseCalc";
import {
    airNumberDensity,
    atmosphereFromClarity,
    buildUmbralProfile,
    tangentRayAirColumn,
    tangentRayBending,
} from "../src/atmosphere/umbralLight";

// The two events everything is checked against. The first is the sitch the
// feature was developed on; the second is a long central total.
const PARTIAL_2026 = "2026-08-28T04:12:49.076Z";   // obscuration 0.966
const TOTAL_2029 = "2029-06-26T03:22:06.538Z";     // 51 min of totality

const MINUTE = 60000;

function stateAt(ms) {
    return getLunarEclipseState(new Date(ms));
}

// Bisect the time at which rKm crosses a fixed radius limit, mirroring
// astronomy-engine's ShadowSemiDurationMinutes: it too holds the shadow radius
// at its PEAK value and searches only on the miss distance r(t). The UNGATED
// geometry is needed here, because the crossing we are looking for is exactly
// the moment the gated state switches to NO_LUNAR_ECLIPSE.
function crossingTime(limitKm, fromMs, toMs) {
    let lo = fromMs, hi = toMs;
    const missAt = (ms) => getShadowGeometry(new Date(ms)).rKm;
    const loInside = missAt(lo) < limitKm;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if ((missAt(mid) < limitKm) === loInside) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

// astronomy-engine's own Search() runs to dt_tolerance_seconds = 1.0, so its
// published semi-durations are themselves only good to about a second. Two
// seconds is therefore "as close as the reference can be checked".
const CONTACT_TOL_MIN = 2 / 60;

describe("shadowRadiiKm (astronomy-engine's cone model)", () => {
    test("both radii equal the Earth's shadow radius at the Earth itself", () => {
        const R = EARTH_MEAN_RADIUS_KM + 88;
        const {umbraKm, penumbraKm} = shadowRadiiKm(0, R);
        expect(umbraKm).toBeCloseTo(R, 6);
        expect(penumbraKm).toBeCloseTo(R, 6);
    });

    test("the umbral cone closes at the textbook 1.38 million km", () => {
        const R = EARTH_MEAN_RADIUS_KM;
        const D = 1.496e8;
        // k = 0  =>  z = D*Re/(Rsun-Re)
        const apex = D * R / (SUN_RADIUS_KM - R);
        expect(apex / 1e6).toBeGreaterThan(1.35);
        expect(apex / 1e6).toBeLessThan(1.40);
        expect(shadowRadiiKm(apex / D, R).umbraKm).toBeCloseTo(0, 6);
    });

    test("at the Moon the radii match the standard ~4600 / ~8300 km", () => {
        const {umbraKm, penumbraKm} = shadowRadiiKm(384400 / 1.496e8, EARTH_MEAN_RADIUS_KM + 88);
        expect(umbraKm).toBeGreaterThan(4400);
        expect(umbraKm).toBeLessThan(4800);
        expect(penumbraKm).toBeGreaterThan(8100);
        expect(penumbraKm).toBeLessThan(8450);
    });
});

describe("getLunarEclipseState", () => {
    test("hard no-op: the frozen NO_LUNAR_ECLIPSE object away from any eclipse", () => {
        // A new Moon: the Moon is on the sunward side, nowhere near the shadow.
        const s = stateAt(Date.parse("2026-08-12T00:00:00Z"));
        expect(s).toBe(NO_LUNAR_ECLIPSE);
        expect(s.kind).toBe("none");
        expect(s.obscuration).toBe(0);
    });

    test("results are cached per time", () => {
        const t = Date.parse(PARTIAL_2026);
        expect(stateAt(t)).toBe(stateAt(t));
    });

    test.each([
        ["partial 2026-08-28", PARTIAL_2026],
        ["total 2029-06-26", TOTAL_2029],
    ])("%s: kind and peak obscuration match the library", (_name, iso) => {
        const lib = Astronomy.SearchLunarEclipse(new Date(Date.parse(iso) - 6 * 3600e3));
        expect(lib.peak.date.toISOString()).toBe(iso);

        const s = stateAt(Date.parse(iso));
        expect(s.kind).toBe(lib.kind);
        expect(s.obscuration).toBeCloseTo(lib.obscuration, 6);
    });

    test.each([
        ["partial 2026-08-28", PARTIAL_2026],
        ["total 2029-06-26", TOTAL_2029],
    ])("%s: contact times match the library's semi-durations to ~1 s", (_name, iso) => {
        const peakMs = Date.parse(iso);
        const lib = Astronomy.SearchLunarEclipse(new Date(peakMs - 6 * 3600e3));
        const peak = stateAt(peakMs);

        // Penumbral contacts: r == p + Rmoon.
        const pLimit = peak.penumbraKm + MOON_MEAN_RADIUS_KM;
        const p1 = crossingTime(pLimit, peakMs - 400 * MINUTE, peakMs);
        const p4 = crossingTime(pLimit, peakMs, peakMs + 400 * MINUTE);
        expect(Math.abs((peakMs - p1) / MINUTE - lib.sd_penum)).toBeLessThan(CONTACT_TOL_MIN);
        expect(Math.abs((p4 - peakMs) / MINUTE - lib.sd_penum)).toBeLessThan(CONTACT_TOL_MIN);

        // Umbral (partial) contacts: r == k + Rmoon.
        const kLimit = peak.umbraKm + MOON_MEAN_RADIUS_KM;
        const u1 = crossingTime(kLimit, peakMs - 400 * MINUTE, peakMs);
        const u4 = crossingTime(kLimit, peakMs, peakMs + 400 * MINUTE);
        expect(Math.abs((peakMs - u1) / MINUTE - lib.sd_partial)).toBeLessThan(CONTACT_TOL_MIN);
        expect(Math.abs((u4 - peakMs) / MINUTE - lib.sd_partial)).toBeLessThan(CONTACT_TOL_MIN);

        if (lib.sd_total > 0) {
            // Totality: r == k - Rmoon.
            const tLimit = peak.umbraKm - MOON_MEAN_RADIUS_KM;
            const t2 = crossingTime(tLimit, peakMs - 400 * MINUTE, peakMs);
            const t3 = crossingTime(tLimit, peakMs, peakMs + 400 * MINUTE);
            expect(Math.abs((peakMs - t2) / MINUTE - lib.sd_total)).toBeLessThan(CONTACT_TOL_MIN);
            expect(Math.abs((t3 - peakMs) / MINUTE - lib.sd_total)).toBeLessThan(CONTACT_TOL_MIN);
        }
    });

    test("magnitudes are consistent with the classification", () => {
        const partial = stateAt(Date.parse(PARTIAL_2026));
        expect(partial.umbralMag).toBeGreaterThan(0);
        expect(partial.umbralMag).toBeLessThan(1);      // partial: never fully immersed
        expect(partial.penumbralMag).toBeGreaterThan(1);

        const total = stateAt(Date.parse(TOTAL_2029));
        expect(total.umbralMag).toBeGreaterThan(1);     // total: fully immersed
        expect(total.obscuration).toBe(1);
    });

    test("the geocentric geometry is physically sensible", () => {
        const s = stateAt(Date.parse(TOTAL_2029));
        expect(s.moonDistKm).toBeGreaterThan(356000);
        expect(s.moonDistKm).toBeLessThan(407000);
        expect(s.sunDistKm / 1.496e8).toBeCloseTo(1, 1);
        // The shadow axis points away from the Sun.
        expect(s.axisEQJ.dot(s.sunEQJ.clone().normalize())).toBeCloseTo(-1, 9);
        // The Moon is a hair short of the axis distance, being slightly off-axis.
        expect(s.alongKm).toBeLessThanOrEqual(s.moonDistKm + 1e-6);
    });
});

describe("directSunlightAt (the feathered shadow)", () => {
    const s = getLunarEclipseState(new Date(Date.parse(TOTAL_2029)));
    // A point at perpendicular offset `r` from the axis, at the Moon's distance.
    const axisPoint = (rKm) => {
        const n = s.axisEQJ;
        const a = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
        const e1 = new Vector3().crossVectors(n, a).normalize();
        return n.clone().multiplyScalar(s.alongKm).addScaledVector(e1, rKm);
    };

    test("full sunlight well outside the penumbra", () => {
        expect(directSunlightAt(axisPoint(s.penumbraKm * 1.5), s.sunEQJ, s.shadowRadiusKm)).toBe(1);
    });

    test("zero on the shadow axis, and everywhere inside the umbra", () => {
        expect(directSunlightAt(axisPoint(0), s.sunEQJ, s.shadowRadiusKm)).toBe(0);
        expect(directSunlightAt(axisPoint(s.umbraKm * 0.9), s.sunEQJ, s.shadowRadiusKm)).toBe(0);
    });

    test("the zero crossing IS the cone's umbral radius, to 1 km", () => {
        // Bisect the outermost radius at which no direct sunlight survives.
        let lo = s.umbraKm * 0.5, hi = s.penumbraKm;
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            if (directSunlightAt(axisPoint(mid), s.sunEQJ, s.shadowRadiusKm) === 0) lo = mid;
            else hi = mid;
        }
        expect((lo + hi) / 2).toBeCloseTo(s.umbraKm, 0);
    });

    test("the full-sunlight boundary IS the cone's penumbral radius, to 1 km", () => {
        let lo = s.umbraKm, hi = s.penumbraKm * 1.2;
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            if (directSunlightAt(axisPoint(mid), s.sunEQJ, s.shadowRadiusKm) < 1) lo = mid;
            else hi = mid;
        }
        expect((lo + hi) / 2).toBeCloseTo(s.penumbraKm, 0);
    });

    test("monotonically increasing outward across the penumbra", () => {
        let prev = -1;
        for (let f = 0; f <= 1.0001; f += 0.02) {
            const r = s.umbraKm + f * (s.penumbraKm - s.umbraKm);
            const v = directSunlightAt(axisPoint(r), s.sunEQJ, s.shadowRadiusKm);
            expect(v).toBeGreaterThanOrEqual(prev);
            prev = v;
        }
        expect(prev).toBeCloseTo(1, 6);
    });

    test("the gradient spans about two lunar radii - the classic soft edge", () => {
        expect(s.penumbraKm - s.umbraKm).toBeGreaterThan(1.7 * MOON_MEAN_RADIUS_KM);
        expect(s.penumbraKm - s.umbraKm).toBeLessThan(2.4 * MOON_MEAN_RADIUS_KM);
    });
});

describe("atmospheric ray model", () => {
    test("a surface-grazing ray bends about a degree", () => {
        const deg = tangentRayBending(0) * 180 / Math.PI;
        // The US Standard Atmosphere gives ~1.0 deg for the full in-and-out
        // path. The larger value implied by the empirical 34.5' of horizon
        // refraction comes from near-surface temperature gradients that the
        // standard atmosphere does not carry - and umbral rays perigee well
        // above the boundary layer anyway.
        expect(deg).toBeGreaterThan(0.9);
        expect(deg).toBeLessThan(1.2);
    });

    test("bending falls off with roughly the density scale height", () => {
        const r = tangentRayBending(8) / tangentRayBending(0);
        expect(r).toBeGreaterThan(0.2);
        expect(r).toBeLessThan(0.55);
        // Negligible by the top of the modelled atmosphere: this is what makes
        // the 88 km split between the refracted and geometric terms exact.
        expect(384400 * tangentRayBending(88)).toBeLessThan(1);   // km at the Moon
    });

    test("the density profile stays finite and falling to the top of the model", () => {
        // Extrapolating the standard atmosphere's last lapse rate runs the
        // temperature through zero near 178 km and produces NaN. It must not.
        let prev = Infinity;
        for (let z = 0; z <= 300; z += 5) {
            const n = airNumberDensity(z);
            expect(Number.isFinite(n)).toBe(true);
            expect(n).toBeGreaterThan(0);
            expect(n).toBeLessThan(prev);
            prev = n;
        }
    });

    test("a grazing ray sees ~70x the vertical air column", () => {
        expect(tangentRayAirColumn(0) / 2.152e25).toBeGreaterThan(60);
        expect(tangentRayAirColumn(0) / 2.152e25).toBeLessThan(80);
    });

    test("rays that reach the umbra perigee in the troposphere", () => {
        const s = getLunarEclipseState(new Date(Date.parse(TOTAL_2029)));
        // The perigee altitude whose ray lands exactly on the umbral edge.
        let lo = 0, hi = 40;
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            const rho = EARTH_MEAN_RADIUS_KM + mid - s.alongKm * tangentRayBending(mid);
            if (rho < s.umbraKm) lo = mid; else hi = mid;
        }
        const hEdge = (lo + hi) / 2;
        expect(hEdge).toBeGreaterThan(8);
        expect(hEdge).toBeLessThan(18);
    });
});

describe("umbral radiance (the blood moon)", () => {
    const s = getLunarEclipseState(new Date(Date.parse(TOTAL_2029)));

    test("deep umbra is red, and orders of magnitude below sunlight", () => {
        const profile = getUmbralProfile(s, atmosphereFromClarity(0.5));
        const c = sampleUmbralProfile(profile, 0);
        expect(c[0]).toBeGreaterThan(0);
        expect(c[0]).toBeLessThan(1e-3);
        expect(c[0]).toBeGreaterThan(c[1]);      // red beats green
        expect(c[1]).toBeGreaterThanOrEqual(c[2]);
    });

    test("brightens outward: the umbra's edge is far brighter than its centre", () => {
        const profile = getUmbralProfile(s, atmosphereFromClarity(0.5));
        const centre = sampleUmbralProfile(profile, 0);
        const edge = sampleUmbralProfile(profile, s.umbraKm * 0.92);
        expect(edge[0]).toBeGreaterThan(4 * centre[0]);
    });

    test("an ozone-blue fringe appears just inside the umbral edge", () => {
        const profile = getUmbralProfile(s, atmosphereFromClarity(0.5));
        // Blue/red ratio must rise sharply toward the edge - that turquoise
        // rim is the Chappuis band winning over Rayleigh once the ray path
        // climbs into the stratosphere.
        const deep = sampleUmbralProfile(profile, s.umbraKm * 0.3);
        const rim = sampleUmbralProfile(profile, s.umbraKm * 0.97);
        expect(rim[2] / rim[0]).toBeGreaterThan(20 * (deep[2] / deep[0] + 1e-9));
        expect(rim[2] / rim[0]).toBeGreaterThan(0.3);
    });

    test("disc-mean brightness lands on the observed Danjon range", () => {
        const profile = getUmbralProfile(s, atmosphereFromClarity(0.5));
        const mean = lunarDiskIllumination(s, profile);
        const mag = -12.74 - 2.5 * Math.log10(mean);
        // Real total eclipses run about V = -3 (L4) to +3 (L0), clustered
        // around -1 to +1.
        expect(mag).toBeGreaterThan(-3);
        expect(mag).toBeLessThan(3);
        const L = danjonFromIllumination(mean);
        expect(L).toBeGreaterThan(0.5);
        expect(L).toBeLessThan(4);
    });

    test("clarity spans the Danjon scale monotonically", () => {
        const dark = danjonFromIllumination(lunarDiskIllumination(s, getUmbralProfile(s, atmosphereFromClarity(0.05))));
        const mid = danjonFromIllumination(lunarDiskIllumination(s, getUmbralProfile(s, atmosphereFromClarity(0.5))));
        const clear = danjonFromIllumination(lunarDiskIllumination(s, getUmbralProfile(s, atmosphereFromClarity(0.95))));
        expect(dark).toBeLessThan(mid);
        expect(mid).toBeLessThan(clear);
        expect(dark).toBeLessThan(1.5);
        expect(clear).toBeGreaterThan(2.5);
    });

    test("the split altitude follows the shadow enlargement, with no gap or overlap", () => {
        // The refracted term must stop exactly where the geometric shadow's
        // blocking disc starts. Enlargement 0 therefore means a bare geometric
        // shadow: no refracted light in the umbra at all.
        const bare = buildUmbralProfile({
            moonDistKm: s.alongKm, sunDistKm: s.sunDistKm, sunRadiusKm: SUN_RADIUS_KM,
            penumbraKm: s.penumbraKm, umbraKm: s.umbraKm, topKm: 0,
            atmo: atmosphereFromClarity(0.5),
        });
        expect(bare.peak).toBe(0);

        // A larger enlargement admits rays with a higher perigee, which are
        // less extinguished, so the umbra gets brighter - monotonically.
        const build = (topKm) => buildUmbralProfile({
            moonDistKm: s.alongKm, sunDistKm: s.sunDistKm, sunRadiusKm: SUN_RADIUS_KM,
            penumbraKm: s.penumbraKm, umbraKm: s.umbraKm, topKm,
            atmo: atmosphereFromClarity(0.5),
        }).meanUmbra;
        expect(build(40)).toBeGreaterThan(0);
        expect(build(88)).toBeGreaterThan(build(40));
        expect(build(130)).toBeGreaterThanOrEqual(build(88));
    });

    test("a state built with a different enlargement gets its own profile", () => {
        const t = new Date(Date.parse(TOTAL_2029));
        const wide = getLunarEclipseState(t, {atmosphereKm: 127});
        const narrow = getLunarEclipseState(t, {atmosphereKm: 75});
        expect(wide.umbraKm).toBeGreaterThan(narrow.umbraKm);
        expect(getUmbralProfile(wide, atmosphereFromClarity(0.5)))
            .not.toBe(getUmbralProfile(narrow, atmosphereFromClarity(0.5)));
    });

    test("the profile is cached across calls with the same geometry", () => {
        const a = getUmbralProfile(s, atmosphereFromClarity(0.5));
        const b = getUmbralProfile(s, atmosphereFromClarity(0.5));
        expect(a).toBe(b);
    });
});

describe("lunarDiskIllumination", () => {
    test("exactly 1 with no eclipse", () => {
        expect(lunarDiskIllumination(NO_LUNAR_ECLIPSE)).toBe(1);
    });

    test("a deep partial keeps a lit sliver, so stays brighter than totality", () => {
        const partial = getLunarEclipseState(new Date(Date.parse(PARTIAL_2026)));
        const total = getLunarEclipseState(new Date(Date.parse(TOTAL_2029)));
        // 96.6% obscured: only 3.4% of the disc is outside the umbra, and that
        // lune only reaches ~250 km past the umbral edge, where the surviving
        // flux is still ~2%. So the whole Moon is ~4000x down on full - dim in
        // absolute terms even though the sliver looks bright in a photograph.
        const partialLit = lunarDiskIllumination(partial);
        const totalLit = lunarDiskIllumination(total, getUmbralProfile(total, atmosphereFromClarity(0.5)));
        expect(partialLit).toBeGreaterThan(1e-5);
        expect(partialLit).toBeLessThan(1e-2);
        expect(partialLit).toBeGreaterThan(5 * totalLit);
        expect(totalLit).toBeLessThan(1e-3);
    });

    test("falls monotonically as the Moon enters the umbra", () => {
        const peak = Date.parse(TOTAL_2029);
        let prev = Infinity;
        for (let m = 200; m >= 0; m -= 20) {
            const st = getLunarEclipseState(new Date(peak - m * MINUTE));
            const lit = lunarDiskIllumination(st);
            expect(lit).toBeLessThanOrEqual(prev + 1e-12);
            prev = lit;
        }
    });
});


describe("lunarEclipseDimming (the lighting path)", () => {
    // The lighting node updates BEFORE the lunar-eclipse node, so on the first
    // frame after a jump into an eclipse nothing has been synced yet. These
    // tests deliberately never touch `active`, `state` or `profile` - if the
    // answer depended on them, the very first frame of an eclipse would be lit
    // by an uneclipsed full Moon, ten magnitudes too bright, and that frame is
    // the whole image when exporting a single one.
    const publish = (enabled) => {
        lunarEclipseRender.enabled = enabled;
        lunarEclipseRender.atmo = atmosphereFromClarity(0.5);
        // Explicitly the un-synced state a jump would leave behind.
        lunarEclipseRender.active = false;
        lunarEclipseRender.state = NO_LUNAR_ECLIPSE;
        lunarEclipseRender.profile = null;
    };

    afterAll(() => publish(true));

    test("exactly 1 when the shading is switched off", () => {
        publish(false);
        expect(lunarEclipseDimming(new Date(Date.parse(TOTAL_2029)))).toBe(1);
    });

    test("exactly 1 away from any eclipse", () => {
        publish(true);
        expect(lunarEclipseDimming(new Date(Date.parse("2026-08-12T00:00:00Z")))).toBe(1);
    });

    test("dims totality by ~10 magnitudes with NOTHING synced", () => {
        publish(true);
        const f = lunarEclipseDimming(new Date(Date.parse(TOTAL_2029)));
        expect(f).toBeLessThan(1e-3);
        expect(f).toBeGreaterThan(0);
        const drop = -2.5 * Math.log10(f);
        expect(drop).toBeGreaterThan(8);
        expect(drop).toBeLessThan(16);
    });

    test("a partial dims less than totality, also with nothing synced", () => {
        publish(true);
        const partial = lunarEclipseDimming(new Date(Date.parse(PARTIAL_2026)));
        const total = lunarEclipseDimming(new Date(Date.parse(TOTAL_2029)));
        expect(partial).toBeLessThan(1);
        expect(partial).toBeGreaterThan(total);
    });

    test("follows the atmosphere setting rather than a cached answer", () => {
        publish(true);
        lunarEclipseRender.atmo = atmosphereFromClarity(0.05);
        const dark = lunarEclipseDimming(new Date(Date.parse(TOTAL_2029)));
        lunarEclipseRender.atmo = atmosphereFromClarity(0.95);
        const clear = lunarEclipseDimming(new Date(Date.parse(TOTAL_2029)));
        expect(clear).toBeGreaterThan(dark * 10);
    });

    test("non-finite times are refused rather than propagated", () => {
        publish(true);
        expect(lunarEclipseDimming(undefined)).toBe(1);
        expect(lunarEclipseDimming(NaN)).toBe(1);
    });
});
