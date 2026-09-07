import {PerspectiveCamera, Vector3} from "three";
import {MQ9TrackingSimulation} from "../src/MQ9TrackingSimulation";
jest.mock("../src/raycastGround", () => ({raycastGroundElevationFast: jest.fn()}));

function simulation(overrides = {}) {
    const radius = 6378137, camera = new PerspectiveCamera(5, 4/3, .1, 1e7);
    camera.position.set(radius+1000, 0, 0); camera.up.set(1,0,0); camera.lookAt(new Vector3(radius+500,0,0));
    camera.updateMatrixWorld(true);
    const target = f => [radius+500, f/30*2, f >= 180 ? (f-180)**2*.02 : 0];
    return new MQ9TrackingSimulation({camera, fps: 30,
        sensorAt: f => [radius+1000,f/30*20,0], manualAimAt: target,
        observationAt: f => ({id: "balloon", position: target(f), diameterM: 1, confidence: f<180?1:0}),
        commands: [{timeSeconds:0,action:"acquire"},{timeSeconds:5.2,action:"offset",pixels:[20,0]}],
        groundAt: (origin, direction) => {
            const distance = (radius-origin.x)/direction.x;
            return distance>0 ? origin.clone().addScaledVector(direction,distance) : null;
        }, ...overrides});
}

test("camera slews relative to the tracked object and coasts on accepted motion only", () => {
    const s = simulation(); s.applyFrame(160);
    expect(s.current.state).toBe("tracking"); expect(s.current.targetPixel.x).toBeCloseTo(300, 3);
    s.applyFrame(190); expect(s.current.state).toBe("coasting");
    expect(s.current.estimatedPosition[2]).toBe(0);
    const predicted = s.project(s.current.estimatedPosition);
    expect(Math.hypot(s.current.targetPixel.x - predicted.x, s.current.targetPixel.y - predicted.y)).toBeGreaterThan(1);
    s.applyFrame(225); expect(s.current.state).toBe("ground"); expect(s.current.box).toBeNull();
    const anchor = [...s.current.groundAnchor]; s.applyFrame(260);
    expect(s.current.groundAnchor).toEqual(anchor);
    const forward = s.camera.getWorldDirection(new Vector3());
    expect(forward.angleTo(new Vector3(...anchor).sub(s.camera.position))).toBeLessThan(1e-7);
});

test("lock retains its acquired pixel despite moving geometry, FOV changes and manual wobble", () => {
    const s = simulation({
        observationAt: f => ({id: "balloon", position: [6378637, f/15, 0], diameterM: 1, confidence: 1}),
        wobbleAt: f => [8*Math.sin(f/40), 6*Math.cos(f/30)],
        lensAt: f => f < 180 ? 5 : 2.5,
        commands: [{frame: 0, action: "offset", pixels: [25, -18]}, {frame: 0, action: "acquire"}],
    });
    s.applyFrame(27);
    const acquired = {...s.current.targetPixel};
    expect(Math.hypot(acquired.x-320, acquired.y-240)).toBeGreaterThan(20);
    for (let f=28; f<240; f++) {
        s.applyFrame(f);
        expect(s.current.targetPixel.x).toBeCloseTo(acquired.x, 6);
        expect(s.current.targetPixel.y).toBeCloseTo(acquired.y, 6);
        if (["refining", "tracking"].includes(s.current.state)) {
            expect(s.current.box.x).toBeCloseTo(acquired.x, 6);
            expect(s.current.box.y).toBeCloseTo(acquired.y, 6);
        }
    }
    s.command("center", 240); s.applyFrame(255);
    expect(s.current.targetPixel.x).toBeCloseTo((acquired.x+320)/2, 6);
    expect(s.current.targetPixel.y).toBeCloseTo((acquired.y+240)/2, 6);
    const midway = JSON.stringify(s.current);
    s.applyFrame(300);
    expect(s.current.targetPixel.x).toBeCloseTo(320, 6);
    expect(s.current.targetPixel.y).toBeCloseTo(240, 6);
    s.applyFrame(255); expect(JSON.stringify(s.current)).toBe(midway);
});

test("scrubbing and repeated background renders neither advance state nor change the prediction", () => {
    const s = simulation(); s.applyFrame(230); const end = JSON.stringify(s.current);
    s.applyFrame(185); const first = JSON.stringify(s.current);
    s.applyFrame(185); expect(JSON.stringify(s.current)).toBe(first);
    s.applyFrame(230); expect(JSON.stringify(s.current)).toBe(end);
    const fresh = simulation(); fresh.applyFrame(230);
    expect(JSON.stringify(fresh.current)).toBe(end);
});

test("ground slew moves from the current ground hold, preserving screen-relative drag distance", () => {
    const s = simulation(); s.applyFrame(240);
    const anchor = [...s.current.groundAnchor];
    s.command("slew", 240, {pixels: [12, 0]}); s.applyFrame(240);
    expect(s.project(anchor).x).toBeCloseTo(308, 3);
    const moved = [...s.current.groundAnchor];
    expect(moved).not.toEqual(anchor);
    s.applyFrame(250); expect(s.current.groundAnchor).toEqual(moved);
});
