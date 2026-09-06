import {MotionReacquisition} from '../src/MotionReacquisition';

const camera = {
    transport: (p, from, to) => ({x: p.x + 2 * (to - from), y: p.y}),
    predict: (path, f) => {
        const last = path[path.length - 1], before = path[path.length - 2];
        return before ? {x: last.x + (last.x - before.x) * (f - last.frame) / (last.frame - before.frame),
            y: last.y + (last.y - before.y) * (f - last.frame) / (last.frame - before.frame)}
            : {x: last.x + 2 * (f - last.frame), y: last.y};
    },
};
const opts = {threshold: 9, scale: 1, speed: 5, interval: 5, coherence: 1};

test('a persistent target can win over a stronger background artifact', () => {
    const search = new MotionReacquisition();
    let hit;
    for (const f of [0, 5, 10]) {
        hit = search.update(f, [{x: 100 + 4 * f, y: 150, score: 18},
            {x: 300 + 2 * f, y: 250, score: 40}], camera, opts);
        if (f < 10) expect(hit).toBeNull();
    }
    expect(hit.x).toBe(140);
    expect(hit.y).toBe(150);
});

test('a fixed OSD peak never confirms itself during a pan', () => {
    const search = new MotionReacquisition();
    for (const f of [0, 5, 10, 15, 20]) {
        expect(search.update(f, [{x: 100, y: 200, score: 80}], camera, opts)).toBeNull();
    }
});

test('two comparably strong moving objects remain ambiguous', () => {
    const search = new MotionReacquisition();
    for (const f of [0, 5, 10]) {
        expect(search.update(f, [{x: 100 + 4 * f, y: 150, score: 18},
            {x: 300 + 4 * f, y: 250, score: 20}], camera, opts)).toBeNull();
    }
});

test('isolated peaks and stale candidates cannot invent a return', () => {
    const search = new MotionReacquisition();
    expect(search.update(0, [{x: 100, y: 100, score: 30}], camera, opts)).toBeNull();
    expect(search.update(5, [{x: 300, y: 300, score: 30}], camera, opts)).toBeNull();
    expect(search.update(40, [{x: 100, y: 100, score: 30}], camera, opts)).toBeNull();
    search.reset();
    expect(search.paths).toEqual([]);
});

test('a pan cannot strand a visible candidate at the initial velocity gate', () => {
    const search = new MotionReacquisition();
    const fastCamera = {...camera,
        transport: (p, from, to) => ({x: p.x + 14 * (to - from), y: p.y}),
        predict: (path, frame) => path.length > 1 ? camera.predict(path, frame) :
            {x: path[0].x + 14 * (frame - path[0].frame), y: path[0].y},
    };
    let hit;
    for (const frame of [0, 5, 10]) {
        hit = search.update(frame, [{x: 100 + frame, y: 200, score: 30}], fastCamera, {...opts, speed: 1});
    }
    expect(hit).toMatchObject({x: 110, y: 200});
});
