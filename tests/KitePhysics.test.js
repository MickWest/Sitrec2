/**
 * Tests for the kite-track bake (src/KitePhysics.js) behind CNodeKiteTrack
 * ("Add Kite"): where the wind puts the kite, the altitude-dependent wind,
 * the calm, and seeded gust determinism.
 *
 * Uses the real ECEF/ENU math, with a flat geoid (no geoid grid is loaded in Jest).
 */

import {setSit} from "../src/Globals";
import {FLAT_GEOID} from "../src/BalloonPhysics";
import {integrateKiteStates, kiteAnchorFrame, kitePointECEF} from "../src/KitePhysics";
import {ecefDisplacementToENU} from "../src/TrackExportMath";
import {solveKiteLine} from "../tools/vehicles/kiteFlight.js";

const LAT = 61.2, LON = -149.8;
const FPS = 30, DT = 1 / FPS;
const properties = {massKg: 0.25, areaM2: 1, liftCoefficient: 0.9, dragCoefficient: 0.45};

function base(params = {}) {
    return {
        anchorLat: LAT, anchorLon: LON, anchorAltMSL: 50,
        lineLength: 100, lineMassPerMetre: 0, lineDiameter: 0,
        properties, variabilityPct: 0, seed: 1,
        frames: 10 * FPS, dt: DT, geoidOffset: FLAT_GEOID,
        ...params,
    };
}
const fromWest = speed => () => ({u: speed, v: 0});
// The kite's offset from the anchor in metres, {e, n, u}.
function offset(state, params = base()) {
    const frame = kiteAnchorFrame(params.anchorLat, params.anchorLon, params.anchorAltMSL, FLAT_GEOID);
    const {east, north, up} = ecefDisplacementToENU(frame.anchor, state.position, params.anchorLat, params.anchorLon);
    return {e: east, n: north, u: up};
}

beforeEach(() => {
    // getLocalNorthVector asserts Sit.lat/Sit.lon are defined
    setSit({name: "test", frames: 300, fps: FPS, simSpeed: 1, lat: LAT, lon: LON});
});

describe("integrateKiteStates", () => {
    test("a steady wind holds the kite still, downwind, at the height of the force balance", () => {
        const out = integrateKiteStates(base(), fromWest(8));
        const line = solveKiteLine({windSpeed: 8, lineLength: 100, properties});
        expect(out).toHaveLength(300);
        for (const f of [0, 150, 299]) {
            const {e, n, u} = offset(out[f]);
            expect(e).toBeCloseTo(line.downwind, 3);
            expect(n).toBeCloseTo(0, 3);
            expect(u).toBeCloseTo(line.height, 3);
            expect(out[f].kite.flying).toBe(true);
            expect(out[f].kite.windSpeed).toBeCloseTo(8, 9);
            expect(out[f].kite.tension).toBeCloseTo(line.tension, 9);
        }
        // the line is 100 m long and straight, so the kite is 100 m from the anchor
        const {e, u} = offset(out[0]);
        expect(Math.hypot(e, u)).toBeCloseTo(100, 3);
    });

    test("the kite is downwind for any wind direction", () => {
        // u = east, v = north: this wind blows toward the south-west
        const out = integrateKiteStates(base(), () => ({u: -6, v: -6}));
        const {e, n} = offset(out[10]);
        expect(e).toBeLessThan(0);
        expect(n).toBeCloseTo(e, 3);
        expect(out[10].kite.windToward).toBeCloseTo(Math.atan2(-6, -6), 9);
    });

    test("the air that has passed the kite adds up with time", () => {
        const out = integrateKiteStates(base(), fromWest(8));
        expect(out[0].kite.air).toBe(0);
        expect(out[150].kite.air).toBeCloseTo(8 * 5, 6);
    });

    test("a wind that grows with height is sampled at the kite's own height", () => {
        // 4 m/s at the anchor, and 1 m/s more for each 10 m above it
        const sheared = (lat, lon, altMSL) => ({u: 4 + (altMSL - 50) / 10, v: 0});
        const out = integrateKiteStates(base({frames: 60}), sheared);
        const state = out[59].kite;
        expect(state.windSpeed).toBeCloseTo(4 + state.height / 10, 2);
        expect(state.height).toBeCloseTo(solveKiteLine({windSpeed: state.windSpeed, lineLength: 100, properties}).height, 2);
    });

    test("in a calm the kite is on the ground, and light air does not move it", () => {
        const out = integrateKiteStates(base({variabilityPct: 50}), () => ({u: 0, v: 0}));
        expect(out.every(state => !state.kite.flying && state.kite.height === 0)).toBe(true);
        expect(out[299].position.equals(out[0].position)).toBe(true);
    });

    test("a wind too light to fly leaves the kite on the ground, downwind", () => {
        const out = integrateKiteStates(base(), fromWest(0.4));
        const {e, n, u} = offset(out[0]);
        expect(out[0].kite.flying).toBe(false);
        expect(e).toBeCloseTo(100, 3); expect(n).toBeCloseTo(0, 3); expect(u).toBeCloseTo(0, 3);
    });

    test("gusts move the kite, and the same seed gives the same flight", () => {
        // One minute: a kite follows a gust with a delay (7 seconds here), and in a sitch of a
        // few seconds the gusts are small, because the slow part of them is the mean of the sitch.
        const minute = {variabilityPct: 30, frames: 60 * FPS};
        const one = integrateKiteStates(base({...minute, seed: 7}), fromWest(8));
        const two = integrateKiteStates(base({...minute, seed: 7}), fromWest(8));
        const other = integrateKiteStates(base({...minute, seed: 8}), fromWest(8));
        expect(one[200].position.equals(two[200].position)).toBe(true);
        expect(one[200].position.equals(other[200].position)).toBe(false);
        expect(Math.max(...one.map(state => state.position.distanceTo(one[0].position)))).toBeGreaterThan(2);
        // a gust changes the wind a little on each frame, not in a jump
        for (let f = 1; f < one.length; f++) expect(Math.abs(one[f].kite.windSpeed - one[f - 1].kite.windSpeed)).toBeLessThan(0.1);
        // and the kite does not change its motion in a jump: no sharp corner in its path
        const step = f => one[f].position.clone().sub(one[f - 1].position);
        for (let f = 2; f < one.length; f++) expect(step(f).distanceTo(step(f - 1)) / DT).toBeLessThan(0.2);
    });

    test("over the sitch the gusts have no mean: the mean wind at the kite is the wind of the wind source", () => {
        // 30 seconds is less than one slow gust. With a mean, one gust holds the wind to one
        // side for the whole sitch, and the kite flies as if the wind came from another direction.
        const pct = 20;
        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        // A light kite in a good wind. And a heavy kite in a wind near its lowest wind (4.0 m/s):
        // it sinks in each lull, so it is at other heights in each run of the bake.
        const heavy = {massKg: 4, areaM2: 7.39, liftCoefficient: 0.55, dragCoefficient: 0.6};
        for (const [wind, kiteProperties] of [[8, properties], [4.47, heavy]]) {
            for (const seed of [1, 2, 3, 7, 11, 23]) {
                const out = integrateKiteStates(base({variabilityPct: pct, seed, frames: 30 * FPS, properties: kiteProperties}), fromWest(wind));
                const along = out.map(({kite}) => kite.windSpeed * Math.sin(kite.windToward));
                const across = out.map(({kite}) => kite.windSpeed * Math.cos(kite.windToward));
                expect(mean(along)).toBeCloseTo(wind, 9);
                expect(mean(across)).toBeCloseTo(0, 9);
                // the wind still changes in the sitch, and it is on each side of its mean direction
                expect(Math.max(...across)).toBeGreaterThan(0.05 * wind);
                expect(Math.min(...across)).toBeLessThan(-0.05 * wind);
                expect(Math.max(...along) - Math.min(...along)).toBeGreaterThan(0.05 * wind);
            }
        }
    });

    test("in the gusts, the kite starts where the wind of the wind source puts it, and its mean position is near there", () => {
        // A kite follows the wind with a delay, so a kite that starts in balance with the gust
        // of the first frame stays to that side for most of a short sitch.
        const steady = integrateKiteStates(base({frames: 30 * FPS}), fromWest(8));
        const sideways = [];
        for (let seed = 1; seed <= 30; seed++) {
            const out = integrateKiteStates(base({variabilityPct: 20, seed, frames: 30 * FPS}), fromWest(8));
            expect(out[0].position.distanceTo(steady[0].position)).toBeLessThan(1e-6);
            // the mean of the kite's bearing from the anchor, in degrees from downwind (east)
            sideways.push(out.reduce((sum, {kite}) => sum + kite.bearing, 0) / out.length * 180 / Math.PI - 90);
        }
        const size = Math.sqrt(sideways.reduce((sum, value) => sum + value * value, 0) / sideways.length);
        // The wind direction changes by about 9 degrees at this Wind Variability
        expect(size).toBeLessThan(1.5);
    });

    test("the gusts have the size of Wind Variability, and the crosswind gusts are 0.8 of the along-wind gusts", () => {
        // Three hours on a short line: the gusts are short near the ground, so this is many gusts.
        const pct = 20, wind = 8;
        const out = integrateKiteStates(base({variabilityPct: pct, lineLength: 20, frames: 54000, dt: 0.2}), fromWest(wind));
        const deviation = values => {
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
        };
        const along = deviation(out.map(({kite}) => kite.windSpeed * Math.sin(kite.windToward)));
        const across = deviation(out.map(({kite}) => kite.windSpeed * Math.cos(kite.windToward)));
        expect(along / wind * 100).toBeGreaterThan(pct * 0.9);
        expect(along / wind * 100).toBeLessThan(pct * 1.1);
        expect(across / along).toBeGreaterThan(0.72);
        expect(across / along).toBeLessThan(0.88);
    });

    test("the kite follows a turn of the wind with a delay: the time the wind takes from the anchor to the kite", () => {
        // 8 m/s toward the east for one second, and then the same wind 20 degrees to one side
        const turn = 20 * Math.PI / 180;
        const turned = (lat, lon, altMSL, f) => f < FPS ? {u: 8, v: 0} : {u: 8 * Math.cos(turn), v: 8 * Math.sin(turn)};
        const out = integrateKiteStates(base({frames: 60 * FPS}), turned);
        const line = solveKiteLine({windSpeed: 8, lineLength: 100, properties});
        const delay = line.downwind / 8;
        const end = out[60 * FPS - 1].position;
        const left = f => out[f].position.distanceTo(end) / out[0].position.distanceTo(end);
        // after one delay, about 1/e of the distance is left (0.368)
        const after = FPS + Math.round(delay * FPS);
        expect(left(after)).toBeGreaterThan(0.34);
        expect(left(after)).toBeLessThan(0.38);
        // the kite is fastest when the wind turns, and then it slows down: it does not move at one speed and stop
        const speed = f => out[f].position.distanceTo(out[f - 1].position) / DT;
        expect(speed(FPS)).toBeCloseTo(out[0].position.distanceTo(end) / delay, 0);
        for (let f = FPS + 1; f < out.length; f++) expect(speed(f)).toBeLessThanOrEqual(speed(f - 1) + 1e-6);
        expect(out[60 * FPS - 1].kite.bearing).toBeCloseTo(Math.PI / 2 - turn, 3);
    });

    test("a kite that flies moves at no more than half the wind speed", () => {
        // the wind turns a quarter of a circle in one frame, which is a long way for the kite to go
        const turned = (lat, lon, altMSL, f) => f < FPS ? {u: 8, v: 0} : {u: 0, v: 8};
        const out = integrateKiteStates(base({frames: 20 * FPS}), turned);
        let fastest = 0;
        for (let f = 1; f < out.length; f++) fastest = Math.max(fastest, out[f].position.distanceTo(out[f - 1].position) / DT);
        expect(fastest).toBeCloseTo(4, 3);
    });

    test("a kite sinks to the ground at 1 m/s when the wind becomes too light to hold it", () => {
        // 8 m/s for one second, and then 1 m/s, which is below this kite's minimum wind
        const lull = (lat, lon, altMSL, f) => ({u: f < FPS ? 8 : 1, v: 0});
        const out = integrateKiteStates(base({frames: 120 * FPS}), lull);
        for (let f = FPS; f < out.length; f++) {
            expect(out[f].position.distanceTo(out[f - 1].position) / DT).toBeLessThanOrEqual(1 + 1e-6);
        }
        // one second after the lull starts it is still most of the way up, and in the end it is on the ground
        expect(out[2 * FPS].kite.height).toBeGreaterThan(out[0].kite.height - 2);
        expect(out[2 * FPS].kite.flying).toBe(true);
        expect(out[120 * FPS - 1].kite.height).toBeCloseTo(0, 3);
        expect(out[120 * FPS - 1].kite.flying).toBe(false);
    });

    test("kitePointECEF puts a point downwind and up from the anchor", () => {
        const frame = kiteAnchorFrame(LAT, LON, 50, FLAT_GEOID);
        const point = kitePointECEF(frame, Math.PI / 2, 30, 40);      // the wind blows toward the east
        const {east, north, up} = ecefDisplacementToENU(frame.anchor, point, LAT, LON);
        expect(east).toBeCloseTo(30, 6); expect(north).toBeCloseTo(0, 6); expect(up).toBeCloseTo(40, 6);
    });
});
