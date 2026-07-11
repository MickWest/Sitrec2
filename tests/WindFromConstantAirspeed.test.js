import {Vector3} from "three";
import {setSit} from "../src/Globals";
import {estimateWindFromConstantAirspeed} from "../src/WindFromConstantAirspeed";

function makeTrack(simSpeed, frames = 121, fps = 30) {
    const positions = [new Vector3(6371000, 0, 0)];
    const windE = 12, windN = -6, airspeed = 90;
    const dt = simSpeed / fps;
    for (let f = 1; f < frames; f++) {
        const angle = 2 * Math.PI * (f - 1) / (frames - 1);
        const east = windE + airspeed * Math.sin(angle);
        const north = windN + airspeed * Math.cos(angle);
        const prev = positions[f - 1];
        // At ECEF (R,0,0), local east is +Y and local north is +Z.
        positions.push(new Vector3(prev.x, prev.y + east * dt, prev.z + north * dt));
    }
    return {
        fps,
        p(f) { return positions[f].clone(); },
    };
}

describe("estimateWindFromConstantAirspeed", () => {
    test("recovers the ground-truth wind bearing and speed", () => {
        setSit({frames: 121, fps: 30, simSpeed: 1, lat: 0, lon: 0});
        const r = estimateWindFromConstantAirspeed(makeTrack(1));
        // Truth: wind (E=+12, N=-6) m/s blows TO 116.57°, i.e. FROM 296.57°
        // at 26.08 kt. A mirrored east basis reports the E/W reflection
        // (63.4°) with identical speed and cost, so pin the bearing itself.
        const bearingErr = Math.abs(((r.from - 296.565) % 360 + 540) % 360 - 180);
        expect(bearingErr).toBeLessThan(2);
        expect(r.knots).toBeCloseTo(26.08, 1);
    });

    test("is bit-repeatable for identical inputs", () => {
        setSit({frames: 121, fps: 30, simSpeed: 1, lat: 0, lon: 0});
        const track = makeTrack(1);
        const a = estimateWindFromConstantAirspeed(track);
        const b = estimateWindFromConstantAirspeed(track);
        expect(b).toEqual(a);
    });

    test("uses physical time, so simSpeed-equivalent tracks estimate the same wind", () => {
        setSit({frames: 121, fps: 30, simSpeed: 1, lat: 0, lon: 0});
        const normal = estimateWindFromConstantAirspeed(makeTrack(1));
        setSit({frames: 121, fps: 30, simSpeed: 5, lat: 0, lon: 0});
        const accelerated = estimateWindFromConstantAirspeed(makeTrack(5));
        expect(accelerated.from).toBeCloseTo(normal.from, 6);
        expect(accelerated.knots).toBeCloseTo(normal.knots, 6);
        expect(accelerated.finalCost).toBeCloseTo(normal.finalCost, 6);
    });
});
