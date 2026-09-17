import {Vector3} from "three";
import {setSit} from "../src/Globals";
import {trackGForce} from "../src/trackUtils";

function track(positionAtTime, {frames = 120, fps = 30, simSpeed = 1} = {}) {
    setSit({frames, fps, simSpeed});
    const positions = Array.from({length: frames}, (_, f) => positionAtTime(f * simSpeed / fps));
    return {frames, fps, positions, p: (f) => positions[f]};
}

describe("track g-force for custom graphs", () => {
    test("stationary and constant-velocity tracks have zero acceleration", () => {
        const stationary = track(() => new Vector3(100, 200, 300));
        expect(trackGForce(stationary, 20)).toBe(0);
        const moving = track((t) => new Vector3(100 + 10 * t, 200 - 20 * t, 300 + 30 * t));
        expect(trackGForce(moving, 20)).toBeCloseTo(0, 9);
    });

    test.each([[10, 1], [30, 1], [30, 2], [30, 0.5]])(
        "measures full 3D acceleration at %s fps and simulation speed %s", (fps, simSpeed) => {
            const source = track((t) => new Vector3(3, 4, 12).multiplyScalar(0.5 * t * t), {fps, simSpeed});
            const before = source.positions.map((p) => p.clone());
            expect(trackGForce(source, 20)).toBeCloseTo(13 / 9.81, 9);
            expect(source.positions).toEqual(before);
        });

    test("a constant-speed turn still produces centripetal acceleration", () => {
        const radius = 100, speed = 50;
        const source = track((t) => new Vector3(
            radius * Math.cos(t * speed / radius), radius * Math.sin(t * speed / radius), 0));
        expect(trackGForce(source, 30)).toBeCloseTo(speed * speed / radius / 9.81, 3);
    });

    test("uses the track's frame rate and clamps the end like the existing g-force graph", () => {
        const source = track((t) => new Vector3(0.5 * 9.81 * t * t, 0, 0), {frames: 10, fps: 10});
        setSit({frames: 100, fps: 30, simSpeed: 1});
        source.positions[9].set(1e9, 1e9, 1e9); // unreliable final point
        expect(trackGForce(source, -1)).toBeCloseTo(1, 9);
        expect(trackGForce(source, 99)).toBeCloseTo(1, 9);
    });

    test("missing samples and tracks too short for acceleration give no value", () => {
        expect(trackGForce(null, 0)).toBeNaN();
        const short = track(() => new Vector3(), {frames: 2});
        expect(trackGForce(short, 0)).toBeNaN();
        const source = track(() => new Vector3(), {frames: 3});
        expect(trackGForce(source, 2)).toBe(0);
        source.positions[1] = null;
        expect(trackGForce(source, 0)).toBeNaN();
    });
});
