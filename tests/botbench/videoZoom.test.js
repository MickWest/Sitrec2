import {videoLensAtFrame} from "../../benchmarks/botbench/lib/videoZoom";

test("zoom switches at exact frames and doubles projected size at fixed range", () => {
    const plan = {fps: 30, zoomEvents: [{timeSeconds: 10, magnification: 2}, {timeSeconds: 20, magnification: 1}]};
    const base = {hfov: 60, vfov: 45};
    for (let frame = 0; frame < 900; frame++) {
        const lens = videoLensAtFrame(base.hfov, base.vfov, plan, frame);
        const expected = frame >= 300 && frame < 600 ? 2 : 1;
        expect(lens.magnification).toBe(expected);
        for (const axis of ["hfov", "vfov"]) {
            expect(Math.tan(base[axis] * Math.PI / 360) / Math.tan(lens[axis] * Math.PI / 360)).toBeCloseTo(expected, 12);
        }
    }
    expect(videoLensAtFrame(60, 45, {fps: 30}, 450).magnification).toBe(1);
});
