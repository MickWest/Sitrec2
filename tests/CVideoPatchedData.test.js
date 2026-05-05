/**
 * @jest-environment jsdom
 */
jest.mock('../src/Globals', () => ({Globals: {}}));
jest.mock('../src/assert', () => ({
    assert: (cond, msg) => { if (!cond) throw new Error("assert: " + msg); },
}));

import {CVideoPatchedData} from '../src/CVideoPatchedData';

// Build a fake source CVideoData with explicit framePTSus[] in microseconds.
// We override only what the wrapper actually reads from source.
function fakeSource(framePTSus, opts = {}) {
    return {
        id: 'fake-source',
        frames: framePTSus.length,
        framePTSus,
        framePTSFromPES: opts.framePTSFromPES !== false,
        videoWidth: 1920,
        videoHeight: 1080,
        originalVideoWidth: 1920,
        originalVideoHeight: 1080,
        metadataRotation: 0,
        hasRealFramePTS() { return this.framePTSFromPES; },
        getImage(S) { return {sourceFrame: S, _kind: 'image'}; },
        isFrameLoaded(S) { return S >= 0 && S < this.frames; },
        async waitForFrame(S) { return true; },
    };
}

// Build a CFR PTS array at a given fps, with optional dropped-frame bursts.
// drops: array of {at, count} — at = source frame index AFTER which to drop
// `count` slots. The dropped slots are simply absent from the produced array
// (their PTS would lie between the kept neighbors), so the source's
// framePTSus shows a 1×, 2×, 3×... bigger gap there.
function makePTS(fps, totalSlots, drops = []) {
    const dt = 1e6 / fps;
    const dropMap = new Map();
    for (const {at, count} of drops) dropMap.set(at, count);
    const out = [];
    for (let i = 0; i < totalSlots; i++) {
        out.push(i * dt);
    }
    // Now remove the dropped slots. We index from the end so removing doesn't
    // shift earlier indices.
    const sortedDrops = [...drops].sort((a, b) => b.at - a.at);
    for (const {at, count} of sortedDrops) {
        out.splice(at + 1, count);
    }
    return out;
}

describe('CVideoPatchedData mapping algorithm', () => {

    test('clean CFR -> identity-like mapping (one virtual slot per source slot)', () => {
        const fps = 30;
        const N = 100;
        const pts = makePTS(fps, N);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        expect(wrapper.frames).toBe(N);
        for (let V = 0; V < N; V++) {
            expect(wrapper.virtualToSource(V)).toBe(V);
            expect(wrapper.sourceToVirtual(V)).toBe(V);
            expect(wrapper.isHeldFrame(V)).toBe(false);
        }
    });

    test('single 5-frame burst -> 5 held virtual slots, source frame count unchanged', () => {
        const fps = 30;
        // 100 nominal slots, drop 5 slots after source frame 49.
        const pts = makePTS(fps, 100, [{at: 49, count: 5}]);
        // Source has 95 frames; PTS span is still ~99 frames worth.
        expect(pts.length).toBe(95);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        // Virtual frame count should match the *original* nominal count.
        expect(wrapper.frames).toBe(100);

        // Frames before the burst map identity.
        for (let V = 0; V <= 49; V++) {
            expect(wrapper.virtualToSource(V)).toBe(V);
            expect(wrapper.isHeldFrame(V)).toBe(false);
        }
        // Held burst: virtual 50..54 all hold source frame 49.
        for (let V = 50; V <= 54; V++) {
            expect(wrapper.virtualToSource(V)).toBe(49);
            expect(wrapper.isHeldFrame(V)).toBe(true);
        }
        // After burst: virtual 55 -> source 50, then identity offset by 5.
        expect(wrapper.virtualToSource(55)).toBe(50);
        expect(wrapper.isHeldFrame(55)).toBe(false);
        expect(wrapper.virtualToSource(99)).toBe(94);
    });

    test('source-to-virtual returns first virtual slot for a held source frame', () => {
        const fps = 30;
        const pts = makePTS(fps, 50, [{at: 19, count: 3}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        expect(wrapper.sourceToVirtual(19)).toBe(19);
        // Source 20 lives at virtual 23 (after 3 held slots).
        expect(wrapper.sourceToVirtual(20)).toBe(23);
        expect(wrapper.virtualToSource(23)).toBe(20);
    });

    test('multiple bursts accumulate hold counts', () => {
        const fps = 30;
        // Drops: 2 frames after source 10, then 4 frames after source 30
        // (note: `at` indexes the source frame after the drop, so we order
        // by original-slot logic).
        const pts = makePTS(fps, 60, [{at: 10, count: 2}, {at: 30, count: 4}]);
        // Source frames: 60 - 6 = 54.
        expect(pts.length).toBe(54);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});
        expect(wrapper.frames).toBe(60);

        // Before either burst.
        expect(wrapper.virtualToSource(5)).toBe(5);
        // Inside first burst.
        expect(wrapper.isHeldFrame(11)).toBe(true);
        expect(wrapper.isHeldFrame(12)).toBe(true);
        // After first, before second.
        expect(wrapper.isHeldFrame(13)).toBe(false);
        // Source 30 in original numbering is at virtual 30 (since we dropped
        // 2 between, source 28 = virtual 30).
        expect(wrapper.virtualToSource(30)).toBe(28);
        // Inside second burst.
        expect(wrapper.isHeldFrame(31)).toBe(true);
        expect(wrapper.isHeldFrame(34)).toBe(true);
        // After both bursts: virtual 60 - 1 = 59 -> source 53.
        expect(wrapper.virtualToSource(59)).toBe(53);
    });

    test('framePTSus is uniform on virtual axis with original PCR origin', () => {
        const fps = 30;
        const pts = makePTS(fps, 50, [{at: 24, count: 3}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});
        const dt = 1e6 / fps;

        expect(wrapper.framePTSus[0]).toBe(pts[0]);
        for (let V = 1; V < wrapper.frames; V++) {
            expect(wrapper.framePTSus[V] - wrapper.framePTSus[V - 1]).toBeCloseTo(dt);
        }
    });

    test('getFrameTimeMs matches V * 1000/fps', () => {
        const fps = 30;
        const pts = makePTS(fps, 50, [{at: 24, count: 3}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        expect(wrapper.getFrameTimeMs(0)).toBe(0);
        expect(wrapper.getFrameTimeMs(30)).toBeCloseTo(30 * 1000 / fps);
        expect(wrapper.getFrameTimeMs(49)).toBeCloseTo(49 * 1000 / fps);
    });

    test('getImage delegates with mapped source frame', () => {
        const fps = 30;
        const pts = makePTS(fps, 20, [{at: 9, count: 2}]);
        // Source returns objects without width/height so the held-marker
        // canvas path is skipped (returns underlying object as-is).
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        expect(wrapper.getImage(9).sourceFrame).toBe(9);
        // Held virtual 10 and 11 still resolve to source 9.
        expect(wrapper.getImage(10).sourceFrame).toBe(9);
        expect(wrapper.getImage(11).sourceFrame).toBe(9);
        // Virtual 12 advances to source 10.
        expect(wrapper.getImage(12).sourceFrame).toBe(10);
    });

    test('shouldWrap predicate: no-wrap on clean CFR, wrap on burst', () => {
        const fps = 30;
        const clean = fakeSource(makePTS(fps, 100));
        const burst = fakeSource(makePTS(fps, 100, [{at: 50, count: 5}]));
        const noPTS = {...clean, hasRealFramePTS: () => false};

        expect(CVideoPatchedData.shouldWrap(clean, fps)).toBe(false);
        expect(CVideoPatchedData.shouldWrap(burst, fps)).toBe(true);
        expect(CVideoPatchedData.shouldWrap(noPTS, fps)).toBe(false);
    });

    test('shouldWrap: tiny jitter (1.5×) does not trigger wrap', () => {
        // Construct a stream where the worst gap is 1.5x — should NOT wrap.
        const fps = 30;
        const dt = 1e6 / fps;
        const pts = [];
        for (let i = 0; i < 50; i++) pts.push(i * dt);
        // Insert a 1.5x gap by stretching one interval.
        pts[25] = pts[24] + 1.5 * dt;
        for (let i = 26; i < pts.length; i++) pts[i] = pts[25] + (i - 25) * dt;

        expect(CVideoPatchedData.shouldWrap(fakeSource(pts), fps)).toBe(false);
    });

    test('round-trip sourceToVirtual(virtualToSource(V)) == canonical V', () => {
        const fps = 30;
        const pts = makePTS(fps, 80, [{at: 30, count: 4}, {at: 60, count: 2}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        // For non-held V, round-trip is identity.
        for (let V = 0; V < wrapper.frames; V++) {
            const S = wrapper.virtualToSource(V);
            const V2 = wrapper.sourceToVirtual(S);
            // V2 is the canonical (first) V for that S.
            expect(wrapper.virtualToSource(V2)).toBe(S);
        }
    });

    test('held-frame detection at boundaries', () => {
        const fps = 30;
        const pts = makePTS(fps, 30, [{at: 9, count: 2}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});
        // V=0 never held by definition.
        expect(wrapper.isHeldFrame(0)).toBe(false);
        // First held slot is V=10 (right after V=9 = source 9).
        expect(wrapper.isHeldFrame(9)).toBe(false);
        expect(wrapper.isHeldFrame(10)).toBe(true);
        expect(wrapper.isHeldFrame(11)).toBe(true);
        expect(wrapper.isHeldFrame(12)).toBe(false);
    });

    test('getPatchStats reports hold totals correctly', () => {
        const fps = 30;
        const pts = makePTS(fps, 100, [{at: 20, count: 2}, {at: 50, count: 5}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});
        const stats = wrapper.getPatchStats();
        expect(stats.sourceFrames).toBe(93);
        expect(stats.virtualFrames).toBe(100);
        expect(stats.heldFrames).toBe(7);
        expect(stats.longestHoldFrames).toBe(5);
        expect(stats.fps).toBe(30);
    });

    test('hasRealFramePTS delegates to source', () => {
        const fps = 30;
        const pts = makePTS(fps, 30, [{at: 14, count: 2}]);
        const w1 = new CVideoPatchedData(fakeSource(pts), {fps});
        expect(w1.hasRealFramePTS()).toBe(true);
    });

    test('setStabilizationData canonicalizes held-run keys (no jitter on holds)', () => {
        const fps = 30;
        const pts = makePTS(fps, 30, [{at: 9, count: 3}]);
        const wrapper = new CVideoPatchedData(fakeSource(pts), {fps});

        // Tracker writes data at V=9 (canonical for source 9) and at V=10
        // (a held frame for source 9). The held entry must collapse onto V=9.
        const data = new Map([
            [9, {x: 100, y: 100}],
            [10, {x: 200, y: 200}],   // bogus held entry
            [13, {x: 300, y: 300}],   // canonical for source 10
        ]);
        wrapper.setStabilizationData(data, {x: 0, y: 0});

        // Internal stabilizationData should have collapsed entries.
        const keys = [...wrapper.stabilizationData.keys()].sort((a, b) => a - b);
        expect(keys).toEqual([9, 13]);
        // Last-write-wins on collapse: V=10's value won over V=9's.
        expect(wrapper.stabilizationData.get(9)).toEqual({x: 200, y: 200});
        expect(wrapper.stabilizationData.get(13)).toEqual({x: 300, y: 300});
    });
});
