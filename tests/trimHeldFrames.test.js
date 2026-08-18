/**
 * Held-frame trimming at the ends of a traverse analysis window.
 *
 * A track node holds its last sample for every frame past the end of its data,
 * so a 20-second clip imported into a 30-second sitch ends in 10 seconds of a
 * sensor parked at its final position. Those frames are not neutral: measured
 * on a synthetic balloon clip, the held tail moved the balloon fit from 120 m
 * off truth to 888 m and its residual from 0.002 to 0.43 degrees, and the
 * verdict from "consistent with several conventional interpretations" to
 * "Unresolved".
 *
 * Both bugs this function had while it was being written are pinned below: the
 * cached-object comparison, and the both-position-and-heading rule that never
 * fired because the camera-centre sightline keeps rotating through the tail.
 */
import {trimHeldFrames} from "../src/TraverseAnalysisData";

// A LOS node in the shape the analysis reads: v(f) -> {position, heading}.
// `reuse` returns the SAME object every call, which is what several real nodes
// do — the trim must survive it.
function losNode(positions, headings, {reuse = false} = {}) {
    const shared = {position: {x: 0, y: 0, z: 0}, heading: {x: 0, y: 0, z: 1}};
    return {
        frames: positions.length,
        v(f) {
            const p = positions[f], h = headings[f];
            if (!reuse) return {position: {x: p[0], y: p[1], z: p[2]},
                heading: {x: h[0], y: h[1], z: h[2]}};
            shared.position.x = p[0]; shared.position.y = p[1]; shared.position.z = p[2];
            shared.heading.x = h[0]; shared.heading.y = h[1]; shared.heading.z = h[2];
            return shared;
        },
    };
}

// n frames: `moving` of real motion, then a frozen tail. The heading keeps
// turning throughout — including through the tail, which is what the real
// camera-centre sightline does.
function clipWithHeldTail(moving, total) {
    const pos = [], hdg = [];
    for (let f = 0; f < total; f++) {
        const t = Math.min(f, moving - 1);
        pos.push([t * 4.32, 0, 0]);
        const a = f * 2.6e-4;
        hdg.push([Math.sin(a), 0, Math.cos(a)]);
    }
    return losNode(pos, hdg);
}

const full = (n) => ({frame0: 0, frame1: n - 1});

test("a frozen tail is trimmed, and the moving part is kept", () => {
    const node = clipWithHeldTail(600, 900);
    const r = trimHeldFrames(node, full(900));
    expect(r.frame0).toBe(0);
    expect(r.frame1).toBe(599);
    expect(r.count).toBe(600);
    expect(r.trimmedEnd).toBe(300);
    expect(r.trimmedStart).toBe(0);
});

// THE RULE IS POSITION, NOT POSITION-AND-HEADING. The obvious version of this
// function required both to be still and never fired at all, because the
// camera-centre sightline keeps rotating (measured: 0.015 deg a frame) while
// the platform sits frozen.
test("a rotating sightline does not save a frozen tail from the trim", () => {
    const node = clipWithHeldTail(600, 900);
    const a = node.v(700), b = node.v(701);
    expect(Math.hypot(a.heading.x - b.heading.x, a.heading.z - b.heading.z))
        .toBeGreaterThan(0);          // the heading really is still moving
    expect(trimHeldFrames(node, full(900)).count).toBe(600);
});

// The cached-object trap: v() handing back one mutated object made every pair
// compare equal, and the trim ate the clip from the front (900 frames came back
// as frames 890-899).
test("a node that reuses its value object is handled", () => {
    const moving = clipWithHeldTail(600, 900);
    const pos = [], hdg = [];
    for (let f = 0; f < 900; f++) {
        const v = moving.v(f);
        pos.push([v.position.x, v.position.y, v.position.z]);
        hdg.push([v.heading.x, v.heading.y, v.heading.z]);
    }
    const r = trimHeldFrames(losNode(pos, hdg, {reuse: true}), full(900));
    expect(r.frame0).toBe(0);
    expect(r.frame1).toBe(599);
});

// A FIXED CAMERA IS NOT A HELD TAIL. Its position never changes and every frame
// is real data, so trimming must decline rather than eat the clip.
test("a sensor that never moves is left completely alone", () => {
    const pos = [], hdg = [];
    for (let f = 0; f < 300; f++) {
        pos.push([100, 200, 300]);
        const a = f * 1e-3;
        hdg.push([Math.sin(a), 0, Math.cos(a)]);
    }
    const r = trimHeldFrames(losNode(pos, hdg), full(300));
    expect(r.count).toBe(300);
    expect(r.trimmedStart).toBe(0);
    expect(r.trimmedEnd).toBe(0);
    expect(r.refusedTrim).toBe(true);
});

test("a held run at the START is trimmed too", () => {
    const pos = [], hdg = [];
    for (let f = 0; f < 400; f++) {
        pos.push([Math.max(0, f - 100) * 4.32, 0, 0]);
        hdg.push([0, 0, 1]);
    }
    const r = trimHeldFrames(losNode(pos, hdg), full(400));
    expect(r.trimmedStart).toBe(100);
    expect(r.frame0).toBe(100);
    expect(r.frame1).toBe(399);
});

// An interior hold is a real gap between real data. Cutting it out would splice
// two moments together and put a false jump into every velocity.
test("an interior hold is left in place", () => {
    const pos = [], hdg = [];
    for (let f = 0; f < 300; f++) {
        const t = f < 100 ? f : (f < 200 ? 100 : f - 100);
        pos.push([t * 4.32, 0, 0]);
        hdg.push([0, 0, 1]);
    }
    const r = trimHeldFrames(losNode(pos, hdg), full(300));
    expect(r.count).toBe(300);
    expect(r.trimmedStart).toBe(0);
    expect(r.trimmedEnd).toBe(0);
});

test("a window that is mostly frozen is refused rather than cut to a sliver", () => {
    const node = clipWithHeldTail(100, 900);   // 800 held frames of 900
    const r = trimHeldFrames(node, full(900));
    expect(r.count).toBe(900);
    expect(r.refusedTrim).toBe(true);
});

test("an existing A-B window is respected, not widened", () => {
    const node = clipWithHeldTail(600, 900);
    const r = trimHeldFrames(node, {frame0: 100, frame1: 800});
    expect(r.frame0).toBe(100);
    expect(r.frame1).toBe(599);
});
