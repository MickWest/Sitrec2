import {MotionTrackingRegime} from '../src/MotionTrackingRegime';
import {MotionTrackPath} from '../src/MotionTrackPath';
import {MotionReacquisition} from '../src/MotionReacquisition';

const step = (dx, inliers = 50) => Object.assign([1, 0, dx, 0, 1, 0, 0, 0, 1], {inliers});

test('pan, ground lock and resumed pan retain the target velocity relative to the ground', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    let x = 500;
    for (let f = 1; f <= 30; f++) {
        const dx = f <= 5 || f > 23 ? 12 : 0;
        camera.record(f, step(dx));
        x += dx - 10;
        regime.updateCamera(camera, f, 1000, 600);
        regime.observeTarget({frame: f, x, y: 300}, camera);
        if (f === 5) expect(regime.state).toBe('moving');
        if (f === 18) {
            expect(regime.state).toBe('stationary');
            expect(regime.stationaryPrediction({frame: f, x, y: 300}, f + 2)).toEqual({x: x - 20, y: 300});
            expect(regime.transitionUntil).toBeGreaterThan(f);
        }
        if (f === 30) expect(regime.state).toBe('moving');
    }
    expect(regime.relativeVelocity).toEqual({x: -10, y: 0});
});

test('a failed registration is unknown, not a stationary camera', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    for (let f = 1; f <= 4; f++) {
        camera.record(f, step(0, f === 4 ? 0 : 50));
        regime.updateCamera(camera, f, 1000, 600);
    }
    expect(regime.state).toBe('unknown');
    expect(regime.stationaryPrediction({frame: 3, x: 500, y: 300}, 4)).toBeNull();
});

test('target velocity recovers from a newer measured interval after registration fails', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    for (let f = 1; f <= 5; f++) {
        camera.record(f, step(-10, f === 2 ? 0 : 50));
        regime.observeTarget({frame: f, x: 100 - 6 * f, y: 300}, camera);
        if (f < 5) expect(regime.relativeVelocity).toBeNull();
    }
    // The oldest observation still crosses the failed fit. The valid 2–5
    // interval already supplies three frames of +4 px/frame target motion.
    expect(regime.relativeVelocity).toEqual({x: 4, y: 0});
});

test('repeated video frames during a pan do not imply a ground lock', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    for (let f = 1; f <= 9; f++) {
        camera.record(f, step(f % 3 === 0 ? 12 : 0));
        regime.updateCamera(camera, f, 1000, 600);
        if (f >= 3) expect(regime.state).toBe('moving');
    }
});

test('repeated observations do not erase target velocity relative to the ground', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    for (let f = 1; f <= 15; f++) {
        camera.record(f, step(f % 3 === 0 ? 36 : 0));
        regime.observeTarget({frame: f, x: 500 + 6 * Math.floor(f / 3), y: 300}, camera);
    }
    expect(regime.relativeSpeed).toBeGreaterThan(8);
    expect(regime.relativeVelocity.x).toBeLessThan(-8);
});

test.each([6, 10])('a new image every %i frames never turns a continuing pan into ground lock', period => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    for (let f = 1; f <= 5 * period; f++) {
        camera.record(f, step(f % period === 0 ? 4 * period : 0));
        regime.updateCamera(camera, f, 1000, 600);
        expect(regime.state).not.toBe('stationary');
        if (f >= period) expect(regime.state).toBe('moving');
    }
});

test('a moving target reacquires against stationary ground after the camera stops following it', () => {
    const regime = new MotionTrackingRegime(), camera = new MotionTrackPath();
    const search = new MotionReacquisition();
    let x = 500;
    for (let f = 1; f <= 20; f++) {
        camera.record(f, step(f <= 5 ? 12 : 0));
        x += (f <= 5 ? 12 : 0) - 10;
        regime.updateCamera(camera, f, 1000, 600);
        // Tracking is lost at the transition. No new observations are allowed
        // to teach the search how fast the visible target now crosses the image.
        if (f <= 5) regime.observeTarget({frame: f, x, y: 300}, camera);
        if (f > 5 && f % 5 === 0) {
            const hit = search.update(f, [{x, y: 300, score: 25}], camera,
                {threshold: 9, scale: 1, speed: regime.relativeSpeed, interval: 5, coherence: 4});
            if (f < 20) expect(hit).toBeNull();
            else expect(hit).toMatchObject({x, y: 300});
        }
    }
    expect(regime.state).toBe('stationary');
    expect(regime.relativeSpeed).toBe(10);
});
