/**
 * Tests for the balloon-track integrator (src/BalloonPhysics.js) behind
 * CNodeBalloonTrack ("Add Balloon"): launch-delay hold, buoyancy ascent,
 * wind advection (injected wind sampler), altitude-dependent wind, and
 * seeded gust determinism.
 *
 * Uses the real ECEF/ENU math (sphere model from Globals defaults; the EGM96
 * geoid is not loaded in Jest so MSL == HAE here, which the assertions rely
 * on only for consistency, not absolute values).
 */

import {setSit} from "../src/Globals";
import {FLAT_GEOID, integrateBalloonPositions} from "../src/BalloonPhysics";
import {ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {ecefDisplacementToENU} from "../src/TrackExportMath";

const LAT = 40, LON = -100;
const FPS = 30;
const DT = 1 / FPS;

const noWind = () => ({u: 0, v: 0});

function base(params = {}) {
    return {
        startLat: LAT,
        startLon: LON,
        startAltMSL: 100,
        launchDelay: 0,
        ascentRate: 5,
        variabilityPct: 0,
        seed: 1,
        frames: 20 * FPS,
        dt: DT,
        // Kinematics only: no geoid grid is loaded under Jest, so say so rather
        // than letting the production lookup fall back to 0 with a warning.
        geoidOffset: FLAT_GEOID,
        ...params,
    };
}

beforeEach(() => {
    // getLocalNorthVector asserts Sit.lat/Sit.lon are defined
    setSit({name: "test", frames: 600, fps: FPS, simSpeed: 1, lat: LAT, lon: LON});
});

describe("integrateBalloonPositions", () => {
    test("holds at the start point until launchDelay", () => {
        const out = integrateBalloonPositions(base({launchDelay: 2}), noWind);
        const p0 = out[0].position;
        // frames strictly before t=2s (f*dt < 2 → f < 60) are identical
        for (let f = 0; f < 60; f++) {
            expect(out[f].position.equals(p0)).toBe(true);
        }
        // and afterwards it moves
        expect(out[90].position.equals(p0)).toBe(false);
    });

    test("no wind → pure vertical ascent at the buoyancy rate", () => {
        const frames = 10 * FPS;
        const out = integrateBalloonPositions(base({frames, ascentRate: 5}), noWind);
        const startLLA = ECEFToLLAVD_radii(out[0].position);
        const endLLA = ECEFToLLAVD_radii(out[frames - 1].position);
        // (frames-1) integration steps of 5 m/s
        const expectedClimb = 5 * DT * (frames - 1);
        expect(endLLA.z - startLLA.z).toBeCloseTo(expectedClimb, 1);
        // horizontally it stays put
        const enu = ecefDisplacementToENU(out[0].position, out[frames - 1].position, LAT, LON);
        expect(Math.abs(enu.east)).toBeLessThan(0.01);
        expect(Math.abs(enu.north)).toBeLessThan(0.01);
    });

    test("constant wind advects the balloon downwind", () => {
        const frames = 10 * FPS;
        const out = integrateBalloonPositions(
            base({frames, ascentRate: 0}),
            () => ({u: 10, v: 0}));          // 10 m/s toward the east
        const enu = ecefDisplacementToENU(out[0].position, out[frames - 1].position, LAT, LON);
        const expectedEast = 10 * DT * (frames - 1);
        expect(enu.east).toBeCloseTo(expectedEast, 0);
        expect(Math.abs(enu.north)).toBeLessThan(0.5);
    });

    test("altitude-dependent wind kicks in as the balloon climbs", () => {
        // calm below 500 m MSL, strong easterly-drift above
        const shear = (lat, lon, altMSL) => (altMSL > 500 ? {u: 20, v: 0} : {u: 0, v: 0});
        const frames = 60 * FPS;
        const out = integrateBalloonPositions(
            base({frames, startAltMSL: 400, ascentRate: 10}), shear);
        // balloon crosses 500m after 10s; before that, no horizontal motion
        const early = ecefDisplacementToENU(out[0].position, out[5 * FPS].position, LAT, LON);
        expect(Math.abs(early.east)).toBeLessThan(0.01);
        const late = ecefDisplacementToENU(out[0].position, out[frames - 1].position, LAT, LON);
        expect(late.east).toBeGreaterThan(500);   // ~50s in the 20 m/s layer
    });

    test("gusts are deterministic per seed, different across seeds", () => {
        const wind = () => ({u: 5, v: 5});
        const p = base({variabilityPct: 50, frames: 10 * FPS});
        const a = integrateBalloonPositions(p, wind);
        const b = integrateBalloonPositions({...p}, wind);
        const c = integrateBalloonPositions({...p, seed: 2}, wind);
        for (let f = 0; f < a.length; f++) {
            expect(b[f].position.equals(a[f].position)).toBe(true);
        }
        const differ = a.some((o, f) => !o.position.equals(c[f].position));
        expect(differ).toBe(true);
    });

    test("zero variability ignores the gust PRNG entirely", () => {
        // same seed vs different seed with variability 0 → identical paths
        const wind = () => ({u: 5, v: 0});
        const a = integrateBalloonPositions(base({seed: 1}), wind);
        const b = integrateBalloonPositions(base({seed: 999}), wind);
        for (let f = 0; f < a.length; f++) {
            expect(b[f].position.equals(a[f].position)).toBe(true);
        }
    });
});
