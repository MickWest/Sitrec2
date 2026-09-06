import {MotionBackgroundTracker, motionPixelMasked} from '../src/MotionBackgroundTracker';

test('motion masks retain their image position across analysis resolutions', () => {
    const imageData = {width: 4, height: 2, data: new Uint8ClampedArray(32)};
    imageData.data[(1 * 4 + 2) * 4 + 3] = 255;
    const mask = {imageData, revision: 1};
    expect(motionPixelMasked(mask, 400, 200, 800, 400)).toBe(true);
    expect(motionPixelMasked(mask, 200, 100, 400, 200)).toBe(true);
    expect(motionPixelMasked(mask, 199, 100, 400, 200)).toBe(false);
    expect(motionPixelMasked(null, 400, 200, 800, 400)).toBe(false);
});

test('editing or disabling a mask invalidates the registered camera path', () => {
    const tracker = new MotionBackgroundTracker({});
    const video = {videoWidth: 800, videoHeight: 400};
    const mask = {imageData: {}, revision: 1};
    tracker.syncVideoContext(video, {mask});
    tracker.cameraPath.poses.set(10, {});
    mask.revision++;
    tracker.syncVideoContext(video, {mask});
    expect(tracker.cameraPath.poses.size).toBe(0);
    tracker.cameraPath.poses.set(10, {});
    tracker.syncVideoContext(video, {});
    expect(tracker.cameraPath.poses.size).toBe(0);
});

function apply(m, [x, y]) {
    const z = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / z,
        (m[3] * x + m[4] * y + m[5]) / z];
}

test('future-frame registration reverses a changing camera transform', () => {
    const tracker = new MotionBackgroundTracker({});
    // Translation and rotation do not commute; a translation-only fixture
    // would hide a reversed composition order.
    tracker.stepHomography = (_, f) => [
        [1, 0, 15, 0, 1, -7, 0, 0, 1],
        [0.8, -0.6, 0, 0.6, 0.8, 0, 0, 0, 1],
        [1, 0.03, 4, 0.02, 1, 2, 0.0001, 0, 1],
    ][f];
    const start = [400, 250];
    const end = apply(tracker.between({}, 0, 3, {}), start);
    const restored = apply(tracker.between({}, 3, 0, {}), end);
    restored.forEach((v, i) => expect(v).toBeCloseTo(start[i], 9));
});

test.each([[640, 480, 300], [320, 180, 100], [1920, 1080, 40]])(
    'a search on a %sx%s video still measures the target with gate %s', (width, height, gate) => {
        const tracker = new MotionBackgroundTracker({});
        tracker.frameImage = () => ({width, height});
        const target = [width / 2 + 8, height / 2 - 3];
        tracker.computeResponse = (_, frame, rect) => {
            const {x0, y0, w, h} = rect;
            expect(x0 + w).toBeLessThanOrEqual(width - 10);
            expect(y0 + h).toBeLessThanOrEqual(height - 10);
            const response = new Float32Array(w * h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                response[y * w + x] = 40 * Math.exp(-((x + x0 - target[0]) ** 2
                    + (y + y0 - target[1]) ** 2) / 8);
            }
            return {...rect, response, usable: new Uint8Array(w * h).fill(1), samples: 8};
        };
        const hit = tracker.measure({}, 50, width / 2, height / 2, {gate, featureScale: 1});
        expect(hit).not.toBeNull();
        expect(hit.x).toBeCloseTo(target[0], 3);
        expect(hit.y).toBeCloseTo(target[1], 3);
        expect(hit.score).toBeGreaterThan(6);
    });

test('viewing the motion field releases registration frames outside its history', () => {
    const tracker = new MotionBackgroundTracker({});
    const old = {mat: {delete: jest.fn()}};
    const recent = {mat: {delete: jest.fn()}};
    tracker.smallGray.set(0, old);
    tracker.smallGray.set(95, recent);
    tracker.step.set(0, []);
    tracker.frameImage = () => ({width: 640, height: 480});
    tracker.computeResponse = () => ({waiting: true});
    tracker.field({}, 100);
    expect(old.mat.delete).toHaveBeenCalledTimes(1);
    expect(recent.mat.delete).not.toHaveBeenCalled();
    expect(tracker.step.has(0)).toBe(false);
});

test('a new decode resolution invalidates registration geometry even at the same frame', () => {
    const tracker = new MotionBackgroundTracker({});
    const video = {frameCacheGeneration: 1, videoWidth: 1280, videoHeight: 720};
    tracker.frameImage = () => null;
    tracker.measure(video, 20, 500, 300);
    const old = {mat: {delete: jest.fn()}};
    tracker.smallGray.set(19, old);
    tracker.step.set(19, [1, 0, 2, 0, 1, 3, 0, 0, 1]);
    video.videoWidth = 1920; video.videoHeight = 1080; video.frameCacheGeneration++;
    tracker.field(video, 20);
    expect(old.mat.delete).toHaveBeenCalledTimes(1);
    expect(tracker.step.size).toBe(0);
});

test('a large cursor does not hide a competing small point inside the search gate', () => {
    const tracker = new MotionBackgroundTracker({});
    tracker.frameImage = () => ({width: 640, height: 480});
    tracker.computeResponse = (_, frame, rect) => {
        const {x0, y0, w, h} = rect;
        const response = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const X = x + x0, Y = y + y0;
            response[y * w + x] = 40 * Math.exp(-((X - 320) ** 2 + (Y - 240) ** 2) / 4)
                + 38 * Math.exp(-((X - 344) ** 2 + (Y - 240) ** 2) / 4);
        }
        return {...rect, response, usable: new Uint8Array(w * h).fill(1), samples: 8};
    };
    const hit = tracker.measure({}, 20, 320, 240, {gate: 50, targetRadius: 30, featureScale: 1});
    expect(hit.second / hit.score).toBeGreaterThan(0.9);
});

test('reacquisition ignores a stronger registration artifact with no object in the raw image', () => {
    const tracker = new MotionBackgroundTracker({});
    tracker.frameImage = () => ({width: 640, height: 480});
    tracker.computeResponse = (_, frame, rect) => {
        const {x0, y0, w, h} = rect;
        const response = new Float32Array(w * h), current = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const X = x + x0, Y = y + y0;
            const target = Math.exp(-((X - 320) ** 2 + (Y - 240) ** 2) / 8);
            const artifact = Math.exp(-((X - 365) ** 2 + (Y - 240) ** 2) / 8);
            response[y * w + x] = 30 * target + 90 * artifact;
            current[y * w + x] = 128 - 60 * target;
        }
        return {...rect, response, current, usable: new Uint8Array(w * h).fill(1), samples: 8};
    };
    const opts = {gate: 100, targetRadius: 11, featureScale: 1, polarity: 'dark'};
    expect(tracker.measure({}, 20, 320, 240, opts).x).toBeCloseTo(365, 3);
    const hit = tracker.measure({}, 20, 320, 240, {...opts, requireAppearance: true});
    expect(hit.x).toBeCloseTo(320, 3);
    expect(hit.score).toBeGreaterThan(6);
    expect(hit.second).toBeLessThan(hit.score / 1.6);
});
