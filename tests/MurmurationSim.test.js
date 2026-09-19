/**
 * Tests for the murmuration (src/MurmurationSim.js): the StarDisplay model of Hildenbrandt,
 * Carere & Hemelrijk (2010), and the timeline that lets a scrubbed sitch read it.
 *
 * The flock checks are against what was measured in real starling flocks (Ballerini et al.
 * 2008) and what the paper's own model gave. The flocks here are small, because Jest runs
 * this code many times slower than a browser does; the shape figures in the source were
 * measured on flocks of 500 to 2000 birds outside Jest.
 */

import {
    MurmurationSim,
    MurmurationTimeline,
    paddingSecondsFor,
    runMurmuration,
    runMurmurationHere,
    separationRadiusFor,
    WARM_UP_SECONDS,
} from "../src/MurmurationSim";
import {FlockModel} from "../src/FlockModel";

const STEPS_PER_SECOND = 200;

function flockStats(sim) {
    const n = sim.count;
    let speed = 0, ex = 0, ey = 0, ez = 0, neighbors = 0, maxBank = 0, cx = 0, cy = 0, nnd = 0, closest = Infinity;
    const heights = [], easts = [], norths = [];
    for (let i = 0; i < n; i++) {
        const v = Math.hypot(sim.vx[i], sim.vy[i], sim.vz[i]);
        speed += v / n;
        ex += sim.vx[i] / v; ey += sim.vy[i] / v; ez += sim.vz[i] / v;
        neighbors += sim.neighbors[i] / n;
        maxBank = Math.max(maxBank, Math.abs(sim.bank[i]));
        cx += sim.px[i] / n; cy += sim.py[i] / n;
        heights.push(sim.pz[i]); easts.push(sim.px[i]); norths.push(sim.py[i]);
        let best = Infinity;
        for (let j = 0; j < n; j++) {
            if (j !== i) best = Math.min(best, Math.hypot(sim.px[j] - sim.px[i], sim.py[j] - sim.py[i], sim.pz[j] - sim.pz[i]));
        }
        nnd += best / n;
        closest = Math.min(closest, best);
    }
    const extent = (values) => {
        values.sort((a, b) => a - b);
        return values[Math.floor(0.95 * (n - 1))] - values[Math.floor(0.05 * (n - 1))];
    };
    return {
        speed, polarization: Math.hypot(ex, ey, ez) / n, neighbors, maxBankDeg: maxBank * 180 / Math.PI,
        distanceFromRoost: Math.hypot(cx, cy), nnd, closest,
        height: extent(heights), width: Math.max(extent(easts), extent(norths)),
    };
}

describe("MurmurationSim", () => {
    test("the spacing asked for is turned into the separation radius that gives it", () => {
        // points of the measured curve, and between them
        expect(separationRadiusFor(0.863)).toBeCloseTo(3, 6);
        expect(separationRadiusFor(1.094)).toBeCloseTo(4, 6);
        expect(separationRadiusFor(1.0)).toBeGreaterThan(3);
        expect(separationRadiusFor(1.0)).toBeLessThan(4);
        // and it keeps rising, beyond the ends, within bounds
        expect(separationRadiusFor(2)).toBeGreaterThan(separationRadiusFor(1.5));
        expect(separationRadiusFor(0.1)).toBeGreaterThanOrEqual(0.4);
        expect(separationRadiusFor(10)).toBeLessThanOrEqual(20);
    });

    test("a flock flies like the starlings of Rome", () => {
        const sim = new MurmurationSim({count: 150, spacing: 1.1, cruiseSpeed: 10, roostRadius: 150, seed: 4});
        for (let step = 0; step < WARM_UP_SECONDS * STEPS_PER_SECOND; step++) sim.advance();
        for (let sample = 0; sample < 4; sample++) {
            for (let step = 0; step < 3 * STEPS_PER_SECOND; step++) sim.advance();
            const stats = flockStats(sim);
            expect(stats.speed).toBeGreaterThan(9);           // about the cruise speed
            expect(stats.speed).toBeLessThan(11.5);
            expect(stats.neighbors).toBeGreaterThan(5.5);     // n_c = 6.5
            expect(stats.neighbors).toBeLessThan(7.5);
            expect(stats.polarization).toBeGreaterThan(0.8);  // all flying the same way
            expect(stats.maxBankDeg).toBeLessThan(60);        // banked into turns, never rolled over
            expect(stats.distanceFromRoost).toBeLessThan(150 + 60);
            // thin, as real flocks are (a flock this small is rounder than a big one)
            expect(stats.height).toBeLessThan(0.7 * stats.width);
            expect(stats.nnd).toBeGreaterThan(0.6);           // 1.1 asked for; a small flock is looser
            expect(stats.nnd).toBeLessThan(1.6);
            expect(stats.closest).toBeGreaterThan(0.1);       // birds do not fly into each other
        }
    });

    test("the neighbor search counts each bird once, however many searches have been made", () => {
        const sim = new MurmurationSim({count: 120, spacing: 1.1, seed: 2});
        for (let step = 0; step < 400; step++) sim.advance();
        const cell = sim.radius.reduce((sum, r) => sum + r, 0) / sim.count;
        sim.buildGrid(cell);
        const found = () => Array.from({length: sim.count}, (_, i) => sim.gather(i, 3 * sim.radius[i], cell));
        const before = found();
        sim.searches = 2 ** 31 - 3;         // about to pass what a 32-bit stamp can hold
        expect(found()).toEqual(before);
        expect(found()).toEqual(before);
    });

    test("the same seed flies the same flight, and another seed another", () => {
        const run = (seed) => {
            const chunks = [];
            runMurmuration({count: 40, spacing: 1.1, cruiseSpeed: 10, roostRadius: 60, seed, duration: 1},
                (first, chunk) => chunks.push(...chunk));
            return chunks;
        };
        const a = run(1);
        expect(run(1)).toEqual(a);
        expect(run(2)).not.toEqual(a);
        expect(a.every(Number.isFinite)).toBe(true);
    });
});

describe("MurmurationTimeline", () => {
    // A fake run, so the timeline can be tested without flying anything: bird i is at
    // [k, i, 0] in sample k, 0.1 s apart, delivered in the chunks asked for.
    function fakeRunner(chunkSizes, count = 3) {
        const pending = [];
        let first = 0;
        for (const size of chunkSizes) {
            const chunk = new Float32Array(size * count * 3);
            for (let k = 0; k < size; k++) {
                for (let i = 0; i < count; i++) {
                    chunk[(k * count + i) * 3] = first + k;
                    chunk[(k * count + i) * 3 + 1] = i;
                }
            }
            pending.push([first, chunk]);
            first += size;
        }
        const samples = first;
        const runner = (params, onChunk) => {
            runner.deliver = () => {
                const [start, chunk] = pending.shift();
                onChunk(start, chunk, {sampleSeconds: 0.1, samples, count});
            };
            return () => { runner.stopped = true; };
        };
        return runner;
    }

    test("it has nothing to show until the first samples arrive, then fills in", () => {
        const runner = fakeRunner([10, 10, 10]);
        let told = 0;
        const timeline = new MurmurationTimeline({count: 3, duration: 1}, runner, (fraction) => { told = fraction; });
        const out = new Float64Array(9).fill(-7);
        expect(timeline.ready).toBe(false);
        expect(Array.from(timeline.evaluate(0, out))).toEqual(new Array(9).fill(-7));

        runner.deliver();
        expect(timeline.ready).toBe(true);
        expect(told).toBeCloseTo(1 / 3, 9);
        // a time not simulated yet shows the last one that has been
        timeline.evaluate(2.5, out);
        expect(out[0]).toBeCloseTo(9, 6);

        runner.deliver();
        runner.deliver();
        expect(timeline.progress).toBe(1);
    });

    test("it passes through the samples and is smooth between them", () => {
        const runner = fakeRunner([30]);
        const timeline = new MurmurationTimeline({count: 3, duration: 1}, runner);
        runner.deliver();
        const out = new Float64Array(9);
        // sample k is at t = -1 s + 0.1 k (samples start a second before time 0)
        timeline.evaluate(-1 + 0.1 * 12, out);
        expect(out[0]).toBeCloseTo(12, 5);
        expect(out[4]).toBeCloseTo(1, 5);
        timeline.evaluate(-1 + 0.1 * 12.5, out);
        expect(out[0]).toBeCloseTo(12.5, 5);        // straight-line samples stay straight
    });

    test("a run that fails is reported, and not taken for one that is still going", () => {
        let told = 0;
        const failing = (params, onChunk) => {
            onChunk(null);
            return () => {};
        };
        const timeline = new MurmurationTimeline({count: 3, duration: 1}, failing, () => told++);
        expect(timeline.failed).toBe(true);
        expect(timeline.ready).toBe(false);
        expect(told).toBe(1);

        const model = new FlockModel({formation: "Murmuration", count: 10}, {murmurationRunner: failing});
        model.duration = 1;
        expect(model.failed).toBe(true);
        expect(model.running).toBe(false);
        model.duration = 1;             // not tried again on every frame
        expect(model.failed).toBe(true);
    });

    test("widely spaced samples are padded by two intervals, so the first frame is between samples", () => {
        expect(paddingSecondsFor(0.1)).toBe(1);
        expect(paddingSecondsFor(1.5)).toBe(3);
        // a run whose samples start 3 s before time 0
        const runner = (params, onChunk) => {
            const chunk = new Float32Array(20 * 3);
            for (let k = 0; k < 20; k++) chunk[3 * k] = k;
            onChunk(0, chunk, {sampleSeconds: 1.5, samples: 20, padding: 3, count: 1});
            return () => {};
        };
        const timeline = new MurmurationTimeline({count: 1, duration: 20}, runner);
        const out = new Float64Array(3);
        expect(timeline.evaluate(-3, out)[0]).toBeCloseTo(0, 6);
        expect(timeline.evaluate(0, out)[0]).toBeCloseTo(2, 6);        // two samples in
    });

    test("disposing it stops the run, and a late message from the run is ignored", () => {
        const runner = fakeRunner([5]);
        let told = 0;
        const timeline = new MurmurationTimeline({count: 3, duration: 1}, runner, () => told++);
        timeline.dispose();
        expect(runner.stopped).toBe(true);
        runner.deliver();
        expect(timeline.ready).toBe(false);
        expect(told).toBe(0);
    });
});

describe("FlockModel, Murmuration formation", () => {
    test("it runs the simulation, and a frame is the same however it was reached", () => {
        const model = new FlockModel({formation: "Murmuration", count: 30, roostRadius: 50, seed: 3},
            {murmurationRunner: runMurmurationHere});
        model.duration = 2;
        expect(model.ready).toBe(true);
        expect(model.progress).toBe(1);
        const out = (t) => Array.from(model.evaluate(t, 0, new Float64Array(3 * model.count)));
        const at1 = out(1);
        out(0.2);
        out(1.9);
        expect(out(1)).toEqual(at1);
        expect(at1.every(Number.isFinite)).toBe(true);
        // no wheeling for a flock that flies itself
        expect(new FlockModel({formation: "Murmuration", wheeling: 50}).wheelOffset(3)).toEqual([0, 0, 0]);
    });

    test("it is started again when it has to be, and not otherwise", () => {
        let runs = 0;
        const runner = (params, onChunk) => {
            runs++;
            return runMurmurationHere(params, onChunk);
        };
        const model = new FlockModel({formation: "Murmuration", count: 20, roostRadius: 40, seed: 1},
            {murmurationRunner: runner});
        expect(runs).toBe(0);           // not until the length of the sitch is known
        model.duration = 1;
        expect(runs).toBe(1);
        model.duration = 1;             // the same
        model.duration = 0.5;           // shorter: already covered
        model.setParams({looseness: 0.9});      // means nothing to a murmuration
        model.duration = 1;
        expect(runs).toBe(1);
        model.duration = 1.5;           // longer
        expect(runs).toBe(2);
        model.setParams({seed: 2});
        model.duration = 1.5;
        expect(runs).toBe(3);
        model.setParams({formation: "V"});
        expect(model.ready).toBe(true);
    });
});
