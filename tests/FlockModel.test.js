/**
 * Tests for the flock model (src/FlockModel.js): where each bird of a flock is,
 * relative to the path the flock follows.
 *
 * The property everything else rests on is that it is a PURE FUNCTION OF TIME. The
 * timeline is scrubbed, and the video export re-evaluates frames in its own order, so a
 * frame must come out the same however it was reached.
 */

import {armSlot, clusterPoints, FLOCK_FORMATIONS, FlockModel, lineSlots, nearestNeighbors} from "../src/FlockModel";

// The formations that hold a shape. A murmuration flies itself: see MurmurationSim.test.js.
const SHAPED_FORMATIONS = FLOCK_FORMATIONS.filter(formation => formation !== "Murmuration");
import {mulberry32} from "../src/DifferentialEvolution";

const SPEED = 15;       // m/s, a goose

function evaluate(model, t, speed = SPEED) {
    return Array.from(model.evaluate(t, speed, new Float64Array(3 * model.count)));
}

function nearestDistances(points, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        let best = Infinity;
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            best = Math.min(best, Math.hypot(points[3 * i] - points[3 * j],
                points[3 * i + 1] - points[3 * j + 1], points[3 * i + 2] - points[3 * j + 2]));
        }
        out.push(best);
    }
    return out;
}

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// Birds that do nothing but hold their slots, so a test can see the slots.
const STILL = {looseness: 0, snaking: 0, placeChange: 0, wheeling: 0};

describe("line formations", () => {
    test("a V puts the leader in front and fills both arms evenly", () => {
        const {positions, arm} = lineSlots(7, "V", 70, 0);
        for (let slot = 1; slot < 7; slot++) {
            expect(positions[0]).toBeGreaterThan(positions[3 * slot]);
        }
        expect(Array.from(arm)).toEqual([0, -1, 1, -1, 1, -1, 1]);
        // left arm is on the left: negative "right"
        expect(positions[3 * 1 + 1]).toBeLessThan(positions[1]);
        expect(positions[3 * 2 + 1]).toBeGreaterThan(positions[1]);
    });

    test("neighbors on an arm are one spacing apart ACROSS the flight, at half the V angle", () => {
        for (const angle of [34, 70, 120]) {
            const {positions} = lineSlots(7, "V", angle, 0);
            const dx = positions[3 * 3] - positions[3 * 1];
            const dy = positions[3 * 3 + 1] - positions[3 * 1 + 1];
            expect(Math.abs(dy)).toBeCloseTo(1, 10);
            expect(Math.atan2(-dy, -dx) * 180 / Math.PI).toBeCloseTo(angle / 2, 8);
        }
        // Gould & Heppner's geese: 4.1 m along the arm of a 34 degree V is 1.2 m across
        const {positions} = lineSlots(3, "Echelon", 34, 0);
        const along = Math.hypot(positions[3] - positions[0], positions[4] - positions[1]);
        expect(1.2 * along).toBeCloseTo(4.1, 1);
    });

    test("asymmetry makes a J, and an echelon is all one arm", () => {
        const countRight = (arm) => Array.from(arm).filter(side => side === 1).length;
        expect(countRight(lineSlots(11, "V", 70, 0).arm)).toBe(5);
        expect(countRight(lineSlots(11, "V", 70, 0.6).arm)).toBe(8);
        expect(countRight(lineSlots(11, "V", 70, -0.6).arm)).toBe(2);
        expect(countRight(lineSlots(11, "Echelon", 70, 0).arm)).toBe(10);
        expect(countRight(lineSlots(11, "Echelon", 70, -0.1).arm)).toBe(0);
    });

    test("line astern is a column and line abreast is a row", () => {
        const astern = lineSlots(5, "Line Astern", 70, 0).positions;
        const abreast = lineSlots(5, "Line Abreast", 70, 0).positions;
        for (let slot = 0; slot < 5; slot++) {
            expect(astern[3 * slot + 1]).toBeCloseTo(0, 10);
            expect(abreast[3 * slot]).toBeCloseTo(0, 10);
        }
    });

    test("the path runs through the middle of the formation, not its leader", () => {
        for (const formation of ["V", "Echelon", "Line Astern", "Line Abreast"]) {
            const {positions} = lineSlots(9, formation, 70, 0.3);
            for (let axis = 0; axis < 3; axis++) {
                let sum = 0;
                for (let slot = 0; slot < 9; slot++) sum += positions[3 * slot + axis];
                expect(sum).toBeCloseTo(0, 9);
            }
        }
    });
});

describe("cluster formations", () => {
    const ROUND = {elongation: 1, longAxisDegrees: 0, verticalSpread: 0.3};
    const extent = (points, n, axis) => {
        let low = Infinity, high = -Infinity;
        for (let i = 0; i < n; i++) {
            low = Math.min(low, points[3 * i + axis]);
            high = Math.max(high, points[3 * i + axis]);
        }
        return high - low;
    };
    // for each bird, the offset to its nearest neighbor
    const toNearest = (points, n) => {
        const nearest = nearestNeighbors(points, n);
        return Array.from(nearest, (j, i) => [0, 1, 2].map(axis => points[3 * j + axis] - points[3 * i + axis]));
    };

    test.each([2, 6, 40, 250, 2000])("%i birds are about one spacing from their neighbor", (n) => {
        const points = clusterPoints(n, ROUND, mulberry32(7));
        const distances = nearestDistances(points, n);
        expect(mean(distances)).toBeGreaterThan(0.85);
        expect(mean(distances)).toBeLessThan(1.15);
        // and no two birds start on top of each other
        expect(Math.min(...distances)).toBeGreaterThan(n <= 300 ? 0.5 : 0.25);
    });

    test.each([2, 40, 2000])("a flock of %i with no height at all is one flat layer, and is made at once", (n) => {
        // Vertical Spread 0 is on the slider. It once made a grid of cells of no size, which never ended.
        const points = clusterPoints(n, {elongation: 2, longAxisDegrees: 30, verticalSpread: 0}, mulberry32(6));
        expect(extent(points, n, 2)).toBe(0);
        expect(mean(nearestDistances(points, n))).toBeGreaterThan(0.85);
        expect(mean(nearestDistances(points, n))).toBeLessThan(1.15);
    });

    test("the flock is thin, by the vertical spread", () => {
        const points = clusterPoints(500, ROUND, mulberry32(3));
        expect(extent(points, 500, 2) / extent(points, 500, 1)).toBeGreaterThan(0.22);
        expect(extent(points, 500, 2) / extent(points, 500, 1)).toBeLessThan(0.38);
    });

    test("a starling flock measures 1 : 2.8 : 5.6, with its long axis where it is put", () => {
        const starling = {elongation: 2, verticalSpread: 0.36};
        const along = clusterPoints(3000, {...starling, longAxisDegrees: 0}, mulberry32(5));
        expect(extent(along, 3000, 0) / extent(along, 3000, 2)).toBeGreaterThan(4.6);
        expect(extent(along, 3000, 0) / extent(along, 3000, 2)).toBeLessThan(6.6);
        expect(extent(along, 3000, 1) / extent(along, 3000, 2)).toBeGreaterThan(2.3);
        expect(extent(along, 3000, 1) / extent(along, 3000, 2)).toBeLessThan(3.3);
        const across = clusterPoints(3000, {...starling, longAxisDegrees: 90}, mulberry32(5));
        expect(extent(across, 3000, 1) / extent(across, 3000, 0)).toBeGreaterThan(1.6);
    });

    test("a thin flock's nearest neighbors are beside it: not above or below, nor ahead or behind", () => {
        const n = 3000;
        const offsets = toNearest(clusterPoints(n, {elongation: 2, longAxisDegrees: 45, verticalSpread: 0.36},
            mulberry32(9)), n);
        const share = (test) => offsets.filter(test).length / n;
        // With no bias each axis would hold a third. Squashing a ball of points to make the
        // flock thin put over half of them above or below.
        expect(share(([x, y, z]) => Math.abs(z) > Math.abs(x) && Math.abs(z) > Math.abs(y))).toBeLessThan(0.36);
        expect(share(([x, y, z]) => Math.abs(y) > Math.abs(x) && Math.abs(y) > Math.abs(z)))
            .toBeGreaterThan(share(([x, y, z]) => Math.abs(x) > Math.abs(y) && Math.abs(x) > Math.abs(z)) + 0.05);
    });

    test("the border of the flock is denser than its core", () => {
        const n = 4000;
        const points = clusterPoints(n, {elongation: 1, longAxisDegrees: 0, verticalSpread: 1}, mulberry32(4));
        const distances = nearestDistances(points, n);
        // The pull along the flight makes this "sphere" an ellipsoid, so measure how far out
        // each bird is against the extent on each axis.
        const half = [0, 1, 2].map(axis => extent(points, n, axis) / 2);
        const out = (i) => Math.hypot(points[3 * i] / half[0], points[3 * i + 1] / half[1], points[3 * i + 2] / half[2]);
        const core = [], border = [];
        for (let i = 0; i < n; i++) {
            if (out(i) < 0.5) core.push(distances[i]);
            if (out(i) > 0.8) border.push(distances[i]);
        }
        expect(mean(border)).toBeLessThan(mean(core));
    });

    test("an irregular front is much wider than it is deep", () => {
        const model = new FlockModel({...STILL, count: 60, formation: "Irregular Front", frontDepth: 0.25});
        const birds = evaluate(model, 10);
        const forward = birds.filter((_, k) => k % 3 === 0), across = birds.filter((_, k) => k % 3 === 1);
        const depth = Math.max(...forward) - Math.min(...forward);
        const width = Math.max(...across) - Math.min(...across);
        expect(width / depth).toBeGreaterThan(2.5);
    });

    test("nearestNeighbors agrees with checking every pair", () => {
        const n = 400;
        const points = clusterPoints(n, {elongation: 4, longAxisDegrees: 90, verticalSpread: 0.3}, mulberry32(11));
        const nearest = nearestNeighbors(points, n);
        const distances = nearestDistances(points, n);
        for (let i = 0; i < n; i++) {
            const j = nearest[i];
            const d = Math.hypot(points[3 * i] - points[3 * j], points[3 * i + 1] - points[3 * j + 1],
                points[3 * i + 2] - points[3 * j + 2]);
            expect(d).toBeCloseTo(distances[i], 10);
        }
    });
});

describe("FlockModel", () => {
    test.each(SHAPED_FORMATIONS)("%s: a frame is the same however it was reached", (formation) => {
        const params = {count: 40, formation, placeChange: 7, wheeling: 10, seed: 5};
        const played = new FlockModel(params);
        for (let t = 0; t <= 200; t += 0.5) evaluate(played, t);
        const atEnd = evaluate(played, 200);

        // jumped straight there, in a model that has seen nothing else
        expect(evaluate(new FlockModel(params), 200)).toEqual(atEnd);

        // scrubbed back, then forward again
        const early = evaluate(played, 33.3);
        expect(evaluate(new FlockModel(params), 33.3)).toEqual(early);
        expect(evaluate(played, 200)).toEqual(atEnd);
    });

    test("the seed changes the flock, and the same seed repeats it", () => {
        const params = {count: 12, formation: "Cluster"};
        expect(evaluate(new FlockModel({...params, seed: 1}), 12))
            .toEqual(evaluate(new FlockModel({...params, seed: 1}), 12));
        expect(evaluate(new FlockModel({...params, seed: 1}), 12))
            .not.toEqual(evaluate(new FlockModel({...params, seed: 2}), 12));
    });

    test("one bird wavers about the path, within the sizes of its two wanders", () => {
        const spacing = 2, looseness = 0.3, snaking = 0.5, verticalSpread = 0.3;
        const model = new FlockModel({count: 1, spacing, looseness, snaking, verticalSpread});
        // its own wander (half as much sideways, in a line formation) plus the snaking
        const mostAlong = looseness * spacing;
        const mostAcross = (0.5 * looseness + snaking) * spacing;
        const mostUp = (looseness + snaking) * spacing * verticalSpread;
        let furthest = 0, moved = 0;
        let last = evaluate(model, 0);
        for (let t = 0.1; t < 300; t += 0.1) {
            const bird = evaluate(model, t);
            expect(Math.abs(bird[0])).toBeLessThanOrEqual(mostAlong + 1e-9);
            expect(Math.abs(bird[1])).toBeLessThanOrEqual(mostAcross + 1e-9);
            expect(Math.abs(bird[2])).toBeLessThanOrEqual(mostUp + 1e-9);
            furthest = Math.max(furthest, Math.abs(bird[1]));
            moved += Math.hypot(bird[0] - last[0], bird[1] - last[1]);
            last = bird;
        }
        expect(furthest).toBeGreaterThan(0.5);
        expect(moved).toBeGreaterThan(10);
    });

    test("spacing scales the whole formation", () => {
        const near = evaluate(new FlockModel({...STILL, count: 9, spacing: 2}), 5);
        const far = evaluate(new FlockModel({...STILL, count: 9, spacing: 6}), 5);
        near.forEach((v, k) => expect(far[k]).toBeCloseTo(3 * v, 9));
    });

    test.each(SHAPED_FORMATIONS)("%s: no bird ever jumps, through every change of place", (formation) => {
        const model = new FlockModel({count: 30, formation, placeChange: 6, groupSize: 8, seed: 9});
        const dt = 1 / 30;
        let last = evaluate(model, 0);
        let fastest = 0;
        for (let t = dt; t < 120; t += dt) {
            const birds = evaluate(model, t);
            for (let i = 0; i < model.count; i++) {
                fastest = Math.max(fastest, Math.hypot(birds[3 * i] - last[3 * i],
                    birds[3 * i + 1] - last[3 * i + 1], birds[3 * i + 2] - last[3 * i + 2]) / dt);
            }
            last = birds;
        }
        // Relative to the flock, which cruises at 15 m/s: a bird easing back by a third of
        // its speed. A jump of one spacing in one frame would be 45 m/s.
        expect(fastest).toBeLessThan(6);
    });

    test("every bird keeps a slot of its own, and each arm stays whole, through the changes", () => {
        const model = new FlockModel({...STILL, count: 23, formation: "V", placeChange: 5, groupSize: 8,
            shapeDrift: 0.8});
        for (let t = 0; t < 3000; t += 5) {
            evaluate(model, t);
            for (const group of model.groups) {
                const {slot, left} = group.state;
                const right = group.size - 1 - left;
                // the leader, then ranks 1..left on the left arm and 1..right on the right
                const wanted = [0];
                for (let rank = 1; rank <= left; rank++) wanted.push(armSlot(group.size, -1, rank));
                for (let rank = 1; rank <= right; rank++) wanted.push(armSlot(group.size, 1, rank));
                expect(Array.from(slot).sort((a, b) => a - b)).toEqual(wanted.sort((a, b) => a - b));
            }
        }
    });

    test("Shape Drift 0 keeps the arms as they were; above 0 the flock slides from V to J to echelon", () => {
        const shares = (shapeDrift, seed) => {
            const model = new FlockModel({...STILL, count: 13, formation: "V", placeChange: 20, shapeDrift, seed});
            const seen = new Set();
            for (let t = 0; t < 6000; t += 5) {
                evaluate(model, t);
                seen.add(model.groups[0].state.left);
            }
            return seen;
        };
        expect(Array.from(shares(0, 1))).toEqual([6]);
        const drifting = shares(0.8, 1);
        expect(drifting.size).toBeGreaterThan(5);
        expect(Math.min(...drifting)).toBeLessThanOrEqual(3);      // a J, or nearly an echelon
        expect(Math.max(...drifting)).toBeGreaterThanOrEqual(9);
        // and a flock is met part way through its flight: not always as the shape it formed up in
        const first = new Set();
        for (let seed = 1; seed <= 12; seed++) {
            const model = new FlockModel({...STILL, count: 13, formation: "V", placeChange: 20, shapeDrift: 0.8, seed});
            evaluate(model, 0);
            first.add(model.groups[0].state.left);
        }
        expect(first.size).toBeGreaterThan(3);
    });

    test("the path runs through the middle of the formation, whatever the birds are doing", () => {
        const model = new FlockModel({...STILL, count: 13, formation: "V", placeChange: 5, shapeDrift: 0.8});
        for (let t = 0; t < 3000; t += 1.7) {
            const birds = evaluate(model, t);
            for (let axis = 0; axis < 2; axis++) {
                let sum = 0;
                for (let i = 0; i < 13; i++) sum += birds[3 * i + axis];
                expect(sum / 13).toBeCloseTo(0, 9);
            }
        }
    });

    test("a bird changes place about as often as it is asked to, and with its neighbor", () => {
        // Voelkl et al. 2015, ibis: one swap per bird in about 45 s
        const model = new FlockModel({...STILL, count: 14, formation: "V", placeChange: 45, groupSize: 14,
            shapeDrift: 0});
        const group = model.groups[0];
        let moves = 0, furthest = 0;
        let last = null;
        for (let t = 0; t < 43 * 60; t += 5) {
            evaluate(model, t);
            const slots = Array.from(group.state.slot);
            if (last) {
                slots.forEach((slot, bird) => {
                    if (slot === last[bird]) return;
                    moves++;
                    furthest = Math.max(furthest, Math.hypot(group.line[3 * slot] - group.line[3 * last[bird]],
                        group.line[3 * slot + 1] - group.line[3 * last[bird] + 1]));
                });
            }
            last = slots;
        }
        const perBird = moves / 14;
        expect(perBird).toBeGreaterThan(40);        // 57 measured
        expect(perBird).toBeLessThan(75);
        // one rank along an arm, or from the head of one arm to the leader: never the length of the line
        expect(furthest).toBeLessThan(2.5);
    });

    test("the lead changes hands", () => {
        const model = new FlockModel({...STILL, count: 7, formation: "V", placeChange: 10});
        const leaders = new Set();
        for (let t = 9; t < 300; t += 10) {
            const birds = evaluate(model, t);
            let leader = 0;
            for (let i = 1; i < 7; i++) if (birds[3 * i] > birds[3 * leader]) leader = i;
            leaders.add(leader);
        }
        expect(leaders.size).toBeGreaterThan(3);
    });

    test("snaking: a follower repeats the leader's swing, later by depth / speed", () => {
        const params = {count: 5, formation: "Line Astern", spacing: 3, looseness: 0, placeChange: 0, snaking: 1};
        const model = new FlockModel(params);
        const slots = evaluate(new FlockModel({...params, snaking: 0}), 0);
        const delay = 3 / SPEED;        // one spacing behind
        for (let t = 20; t < 60; t += 1.7) {
            const now = evaluate(model, t), earlier = evaluate(model, t - delay);
            for (let bird = 1; bird < 5; bird++) {
                const swing = now[3 * bird + 1] - slots[3 * bird + 1];
                const swingAhead = earlier[3 * (bird - 1) + 1] - slots[3 * (bird - 1) + 1];
                expect(swing).toBeCloseTo(swingAhead, 9);
            }
        }
    });

    test("no bird flies sideways: a wander too big for its period is slowed to fit", () => {
        // 7.5 m of wander in 5 s would be about 8 m/s, twice the speed of this flock.
        const model = new FlockModel({count: 7, spacing: 25, looseness: 0.3, placeChange: 0});
        model.cruiseSpeed = 4;
        const dt = 0.05;
        let last = evaluate(model, 0, 4);
        let fastestAcross = 0;
        for (let t = dt; t < 300; t += dt) {
            const birds = evaluate(model, t, 4);
            for (let i = 0; i < 7; i++) {
                fastestAcross = Math.max(fastestAcross, Math.abs(birds[3 * i + 1] - last[3 * i + 1]) / dt);
            }
            last = birds;
        }
        // its own wander and the snaking are each held to 0.75 m/s (the floor, for a slow flock)
        expect(fastestAcross).toBeLessThan(1.5);
        expect(Math.atan2(fastestAcross, 4) * 180 / Math.PI).toBeLessThan(21);
    });

    test("a bird changing place in a slow flock takes its time, and is not turned side on", () => {
        const model = new FlockModel({...STILL, count: 9, formation: "V", spacing: 12, placeChange: 10, shapeDrift: 0.8});
        model.cruiseSpeed = 4;
        const dt = 0.05;
        let last = evaluate(model, 0, 4);
        let fastest = 0;
        for (let t = dt; t < 600; t += dt) {
            const birds = evaluate(model, t, 4);
            for (let i = 0; i < 9; i++) {
                fastest = Math.max(fastest, Math.hypot(birds[3 * i] - last[3 * i], birds[3 * i + 1] - last[3 * i + 1]) / dt);
            }
            last = birds;
        }
        // 0.75 m/s, the floor for a slow flock, and a little for the swing round the other bird
        // and for the rest of the flock closing up about a bird that has left
        expect(fastest).toBeLessThan(1.3);
        expect(fastest).toBeGreaterThan(0.5);       // and birds DID change place
    });

    test("V-ness 0 is a cluster: no bird holds the line", () => {
        const loose = evaluate(new FlockModel({...STILL, count: 15, formation: "Line Astern", vNess: 0}), 0);
        const across = loose.filter((_, k) => k % 3 === 1);
        expect(Math.max(...across) - Math.min(...across)).toBeGreaterThan(1.5);
    });

    test("a large line flock flies as several formations", () => {
        const model = new FlockModel({count: 130, formation: "V", groupSize: 25});
        expect(model.groups.length).toBe(6);
        expect(model.groups.reduce((sum, group) => sum + group.size, 0)).toBe(130);
        expect(new FlockModel({count: 130, formation: "Cluster"}).groups.length).toBe(1);
    });

    test("wheeling is zero unless asked for, and then stays within its size", () => {
        expect(new FlockModel({wheeling: 0}).wheelOffset(12)).toEqual([0, 0, 0]);
        const model = new FlockModel({wheeling: 40, wheelPeriod: 20});
        for (let t = 0; t < 200; t += 0.7) {
            const [forward, across] = model.wheelOffset(t);
            expect(Math.hypot(forward, across)).toBeLessThanOrEqual(40 * Math.SQRT2 + 1e-9);
        }
    });

    test("a sample just before a step of the history costs no replay of it", () => {
        // ObjectFlock samples a quarter of a second each side of every frame, so around each
        // 5 s step it asks for this step, the last one, and this one again, on every frame.
        const model = new FlockModel({count: 2000, formation: "Cluster", placeChange: 17});
        const out = new Float64Array(3 * 2000);
        let advances = 0;
        const advance = model.advance.bind(model);
        model.advance = (...args) => { advances++; return advance(...args); };
        model.evaluate(100, SPEED, out);
        advances = 0;
        for (let frame = 0; frame < 300; frame++) {         // 10 s of play: two steps of the history
            const t = 100 + frame / 30;
            for (const sample of [t - 0.25, t, t + 0.25]) model.evaluate(sample, SPEED, out);
        }
        expect(advances).toBeLessThan(40);      // it was 120 and more on every frame near a step
    });

    test("five thousand birds lay out and evaluate quickly", () => {
        const start = performance.now();
        const model = new FlockModel({count: 5000, formation: "Cluster"});
        const layout = performance.now() - start;
        const out = new Float64Array(3 * 5000);
        const evalStart = performance.now();
        for (let k = 0; k < 30; k++) model.evaluate(k / 30, SPEED, out);
        const perEvaluate = (performance.now() - evalStart) / 30;
        expect(layout).toBeLessThan(2000);
        expect(perEvaluate).toBeLessThan(20);
    });
});
