// Star trails from a synthetic timelapse stack: arcs about a known centre, some dotted, one
// crossed by a satellite line, on a noisy sky.
import {extractStarTrails} from "../src/starTrack/StarTrails";
import {mulberry32} from "../src/starTrack/StarSyntheticSphere";

const W = 480, H = 320;
const CENTRE = [250, 70];
const SPAN = 5 * Math.PI / 180;

/** Render the scene; returns the RGBA buffer and the true trails (start/end in time order). */
function scene({sense = -1, seed = 3} = {}) {
    const rand = mulberry32(seed);
    const img = new Float32Array(W * H).fill(20);
    const splat = (x, y, a) => {
        const x0 = Math.floor(x), y0 = Math.floor(y);
        for (let yy = y0 - 2; yy <= y0 + 3; yy++) {
            for (let xx = x0 - 2; xx <= x0 + 3; xx++) {
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                const d2 = (xx - x) ** 2 + (yy - y) ** 2;
                img[yy * W + xx] += a * Math.exp(-d2 / (2 * 0.8 * 0.8));
            }
        }
    };
    const truth = [];
    while (truth.length < 45) {
        const r = 60 + 380 * rand();
        const phiA = Math.PI * rand();          // the trail's high-angle end, below the centre
        const phiB = phiA - SPAN;
        const a = 20 + 60 * rand();
        const dotted = rand() < 0.3;
        const pts = [];
        const steps = Math.ceil(r * SPAN * 4);
        let inside = true;
        for (let k = 0; k <= steps; k++) {
            const phi = phiA - SPAN * k / steps;
            const x = CENTRE[0] + r * Math.cos(phi), y = CENTRE[1] + r * Math.sin(phi);
            if (x < 6 || y < 6 || x > W - 7 || y > H - 7) { inside = false; break; }
            pts.push([x, y]);
        }
        if (!inside) continue;
        // Keep trails apart, so each truth has one answer.
        const mid = pts[pts.length >> 1];
        if (truth.some((t) => Math.hypot(t.mid[0] - mid[0], t.mid[1] - mid[1]) < 30)) continue;
        pts.forEach(([x, y], k) => {
            // Dotted: 6 px on, 2 px off (in quarter-pixel steps).
            if (dotted && (k % 32) >= 24) return;
            splat(x, y, a / 4);
        });
        const hi = pts[0], lo = pts[pts.length - 1];
        // sense -1: counterclockwise on screen, so the trail STARTS at its high-angle end.
        truth.push(sense < 0 ? {start: hi, end: lo, mid} : {start: lo, end: hi, mid});
    }
    // A satellite crossing everything at an angle.
    for (let t = 0; t < 1; t += 0.0005) splat(10 + 460 * t, 300 - 260 * t, 18);
    // Noise.
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const u = Math.max(1e-9, rand()), v = rand();
        const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 3;
        const val = img[i] + n;
        rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = val;
        rgba[4 * i + 3] = 255;
    }
    return {rgba, truth};
}

/** How many of the trails long enough to have two measurable ends came back. */
function recovered(res, truth, tol) {
    let ok = 0;
    for (const t of measurable(truth)) {
        const hit = res.trails.find((d) =>
            Math.hypot(d.startPx[0] - t.start[0], d.startPx[1] - t.start[1]) < tol
            && Math.hypot(d.endPx[0] - t.end[0], d.endPx[1] - t.end[1]) < tol);
        if (hit) ok++;
    }
    return ok;
}

function measurable(truth) {
    return truth.filter((t) => Math.hypot(t.end[0] - t.start[0], t.end[1] - t.start[1]) >= 12);
}

describe("extractStarTrails", () => {
    test("finds the centre of rotation, and each trail's start and end in time order", () => {
        const {rgba, truth} = scene();
        const res = extractStarTrails(rgba, W, H, {sense: -1});
        expect(Math.hypot(res.centre[0] - CENTRE[0], res.centre[1] - CENTRE[1])).toBeLessThan(2);
        // Most trails come back with both ends within a pixel and a half - the dotted ones and
        // the ones the satellite crosses included.
        expect(recovered(res, truth, 1.5)).toBeGreaterThanOrEqual(Math.round(0.85 * measurable(truth).length));
        // The typical turn is the stack's 5 degrees.
        expect(res.spanRad * 180 / Math.PI).toBeCloseTo(5, 0);
    });

    test("the opposite sense swaps start and end", () => {
        const {rgba, truth} = scene({sense: 1});
        const res = extractStarTrails(rgba, W, H, {sense: 1});
        expect(recovered(res, truth, 1.5)).toBeGreaterThanOrEqual(Math.round(0.85 * measurable(truth).length));
    });

    test("an empty sky has no centre and says why", () => {
        const rgba = new Uint8ClampedArray(W * H * 4).fill(20);
        const res = extractStarTrails(rgba, W, H, {});
        expect(res.centre).toBeNull();
        expect(res.reason).toMatch(/centre/);
    });
});
