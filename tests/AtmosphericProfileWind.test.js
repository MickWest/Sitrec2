// Wind from a sounding profile (CNodeAtmosphericProfile): interpolated by its east and north
// components, only between levels that carry a wind, and held above and below them.
// Before 2026-11-02 the angle and the speed were interpolated apart, so two opposite winds of the
// same speed gave a full-speed wind at right angles to both, and a level with no wind had been
// filled with the wind of the level below before the profile saw it.
import {CNodeAtmosphericProfile, interpolateWind} from "../src/nodes/CNodeAtmosphericProfile";

// A profile with these levels, without the node graph: getAtAltitude and windAtAltitude read
// only `levels` and `windLevels`, which buildProfile() sets from the track rows.
function profileOf(levels) {
    const profile = Object.create(CNodeAtmosphericProfile.prototype);
    profile.levels = levels.map(([alt, windDir, windSpeed, temp = null]) =>
        ({alt, windDir, windSpeed, temp, pressure: null, rh: null}));
    profile.windLevels = profile.levels.filter(l => l.windDir != null && l.windSpeed != null);
    return profile;
}

describe("interpolateWind", () => {
    test("two opposite winds of the same speed give a calm half way", () => {
        const w = interpolateWind({windDir: 90, windSpeed: 20}, {windDir: 270, windSpeed: 20}, 0.5);
        expect(w.windSpeed).toBeCloseTo(0, 9);
    });

    test("the short way through north: 350 and 10 give 0 (or 360)", () => {
        const w = interpolateWind({windDir: 350, windSpeed: 10}, {windDir: 10, windSpeed: 10}, 0.5);
        expect(Math.min(w.windDir, 360 - w.windDir)).toBeCloseTo(0, 6);
        expect(w.windSpeed).toBeCloseTo(10 * Math.cos(10 * Math.PI / 180), 6);
    });

    test("at the ends it gives each level's own wind", () => {
        const lo = {windDir: 200, windSpeed: 6}, hi = {windDir: 280, windSpeed: 30};
        expect(interpolateWind(lo, hi, 0).windDir).toBeCloseTo(200, 6);
        expect(interpolateWind(lo, hi, 1).windSpeed).toBeCloseTo(30, 6);
    });
});

describe("profile wind", () => {
    // metres MSL, FROM degrees, m/s
    const profile = profileOf([
        [0, 180, 2.5],
        [457, null, null, 15],      // a level with a temperature but no wind
        [914, 220, 15.4],
        [3048, 270, 20.6],
    ]);

    test("a level with no wind gets the wind interpolated from the levels around it", () => {
        const at = profile.getAtAltitude(457);
        const expected = interpolateWind({windDir: 180, windSpeed: 2.5}, {windDir: 220, windSpeed: 15.4}, 457 / 914);
        expect(at.windDir).toBeCloseTo(expected.windDir, 6);
        expect(at.windSpeed).toBeCloseTo(expected.windSpeed, 6);
        expect(at.temp).toBe(15);   // the other fields still come from the levels
    });

    test("below the lowest and above the highest wind level, that level's wind is held", () => {
        expect(profile.getAtAltitude(-100).windDir).toBe(180);
        expect(profile.getAtAltitude(9000).windSpeed).toBeCloseTo(20.6);
    });

    test("a profile with no wind at all gives no wind", () => {
        const empty = profileOf([[0, null, null, 15], [1000, null, null, 5]]);
        expect(empty.getAtAltitude(500).windDir).toBeNull();
        expect(empty.windAtAltitude(500)).toBeNull();
    });
});
