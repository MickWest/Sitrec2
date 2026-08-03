// The parallel spherical solve must return what the synchronous one returns - IDENTICALLY, not
// approximately, and for any number of workers.
//
// That bar is not pedantry. Several regression tests compare rendered pixels of sitches that draw
// star overlays, and the solve feeds them; an answer that differs in the sixth decimal is a
// failing screenshot on somebody's machine and an afternoon finding out why. It is also the kind
// of property that is easy to have by accident today and lose silently tomorrow, so it is pinned
// here rather than reasoned about.
//
// Jest has no Worker, so these drive `localLane()` - the same createChunkResponder the worker
// wraps, minus postMessage. That covers the orchestration (chunking, work stealing, gather,
// reduction order, the ref write-back) and the kernels. What it cannot cover is structured clone
// and the worker transport itself, which is why the payloads are all plain objects and typed
// arrays, and why the transport shim in StarSphereWorker.js is kept to nothing but forwarding.

import {buildSphericalScene} from "../src/starTrack/StarSyntheticSphere";
import {
    buildTrackletsSpherical, refineGlobalSpherical, statesFromChain2D,
    packObservations, packMap, unpackMap, packStates, unpackStates,
} from "../src/starTrack/StarSolveSphere";
import {refineGlobalSphericalAsync, localLane} from "../src/starTrack/StarSphereSolvePool";
import {solveFrameChain} from "../src/starTrack/StarMatch";

jest.setTimeout(120000);

/** A scene big enough that chunk boundaries fall in interesting places. */
function buildCase(opts = {}) {
    const scene = buildSphericalScene({
        frames: 40, starCount: 160, rotationDeg: 3.28, poleOffsetDeg: 49,
        noise: 0.25, dropoutRate: 0.08, hotPixels: 3, moverSpeedPx: 2.6, seed: 4242, ...opts,
    });
    const chain = solveFrameChain(scene.perFrame);
    const states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
    const tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size);
    return {scene, states, tracks};
}

/** Deep copies, because every solve writes `ref` back into the tracks it is given. */
function cloneTracks(tracks) {
    return tracks.map((t) => ({
        obs: t.obs.map((o) => ({...o})),
        rays: (t.rays || []).map((r) => r.slice()),
        rayFrames: (t.rayFrames || []).slice(),
        ref: t.ref, first: t.first, last: t.last,
    }));
}

function expectIdentical(a, b) {
    expect(a.iterations).toBe(b.iterations);
    expect(a.converged).toBe(b.converged);
    expect(a.rms).toBe(b.rms);                       // the exact double, not a tolerance
    expect(a.states.length).toBe(b.states.length);
    for (let f = 0; f < a.states.length; f++) {
        if (!a.states[f]) { expect(b.states[f]).toBeFalsy(); continue; }
        expect(b.states[f].q).toEqual(a.states[f].q);
        expect(b.states[f].inliers).toBe(a.states[f].inliers);
    }
    expect(a.map.length).toBe(b.map.length);
    for (let i = 0; i < a.map.length; i++) expect(b.map[i]).toEqual(a.map[i]);
}

describe("packing round-trips", () => {
    test("observations flatten in track order and then observation order", () => {
        const {tracks} = buildCase({frames: 12, starCount: 20, seed: 7});
        const obs = packObservations(tracks);
        expect(obs.n).toBe(tracks.length);
        expect(obs.off[tracks.length]).toBe(obs.f.length);
        for (let i = 0; i < tracks.length; i++) {
            expect(obs.off[i + 1] - obs.off[i]).toBe(tracks[i].obs.length);
            for (let k = 0; k < tracks[i].obs.length; k++) {
                const o = tracks[i].obs[k], j = obs.off[i] + k;
                expect(obs.f[j]).toBe(o.f);
                expect(obs.x[j]).toBe(o.x);          // exact: a Float64Array holds a double
                expect(obs.y[j]).toBe(o.y);
            }
        }
    });

    test("a map round-trips exactly, with null distinguished from a direction", () => {
        const dirs = [[0.1, 0.2, 0.9737], null, [-0.5, 0.5, 0.7071]];
        const back = unpackMap(packMap(dirs), dirs.length);
        expect(back[0]).toEqual(dirs[0]);
        expect(back[1]).toBeNull();
        expect(back[2]).toEqual(dirs[2]);
    });

    test("states round-trip, and an absent frame stays absent", () => {
        const states = [{q: [0.1, 0.2, 0.3, 0.9273], s: 1}, null, {q: [0, 0, 0, 1], s: 0.7}];
        const back = unpackStates(packStates(states));
        expect(back[0].q).toEqual(states[0].q);
        expect(back[0].s).toBe(1);
        expect(back[1]).toBeNull();
        expect(back[2].s).toBe(0.7);
    });
});

describe("the parallel solve is the synchronous solve", () => {
    test("one lane reproduces it bit for bit, including the ref write-back", async () => {
        const {scene, states, tracks} = buildCase();
        const sync = refineGlobalSpherical(cloneTracks(tracks), states, scene.lens, scene.size);

        const parTracks = cloneTracks(tracks);
        const par = await refineGlobalSphericalAsync(parTracks, states, scene.lens, scene.size,
            {lanes: [localLane()]});

        expectIdentical(sync, par);
        // The write-back is the thing a worker CANNOT do for itself - the tracks it mutates are
        // its own copies - so the async path has to apply it, and everything downstream
        // (gnomonicChart, classifyTracksSpherical, the identify chart) reads `ref`, not `map`.
        const syncTracks = cloneTracks(tracks);
        refineGlobalSpherical(syncTracks, states, scene.lens, scene.size);
        for (let i = 0; i < syncTracks.length; i++) {
            expect(parTracks[i].ref).toEqual(syncTracks[i].ref);
        }
        expect(parTracks.some((t) => t.ref)).toBe(true);   // and it actually wrote something
    });

    test.each([1, 2, 3, 5, 8, 13])("%i lanes give the same answer", async (n) => {
        const {scene, states, tracks} = buildCase();
        const sync = refineGlobalSpherical(cloneTracks(tracks), states, scene.lens, scene.size);

        const parTracks = cloneTracks(tracks);
        const lanes = Array.from({length: n}, () => localLane());
        const par = await refineGlobalSphericalAsync(parTracks, states, scene.lens, scene.size,
            {lanes});

        expectIdentical(sync, par);
    });

    test("an exclude set survives the boundary as a set, not as an empty object", async () => {
        const {scene, states, tracks} = buildCase();
        // A Set structured-clones, but only if it is passed as one - and `exclude` is the
        // difference between "this artifact shaped the orientations" and "it did not", which is
        // the whole reason the second pass exists.
        const exclude = new Set([0, 3, 7, tracks.length - 1]);
        const sync = refineGlobalSpherical(cloneTracks(tracks), states, scene.lens, scene.size,
            {exclude});
        const par = await refineGlobalSphericalAsync(cloneTracks(tracks), states, scene.lens,
            scene.size, {exclude, lanes: [localLane(), localLane(), localLane()]});

        expectIdentical(sync, par);
        for (const i of exclude) expect(par.map[i]).toBeNull();
        // Excluded tracks are still given a settled direction - they are classified like
        // everything else, they just did not get a vote.
        for (const i of exclude) expect(par.refs[i]).not.toBeNull();
    });

    test("a solve that converges early stops at the same iteration in both paths", async () => {
        const {scene, states, tracks} = buildCase({noise: 0.05, dropoutRate: 0, moverSpeedPx: 0});
        const sync = refineGlobalSpherical(cloneTracks(tracks), states, scene.lens, scene.size);
        const par = await refineGlobalSphericalAsync(cloneTracks(tracks), states, scene.lens,
            scene.size, {lanes: [localLane(), localLane(), localLane(), localLane()]});
        expect(sync.converged).toBe(true);
        expectIdentical(sync, par);
    });
});

describe("cancellation and fallback", () => {
    test("an abort returns null and leaves the tracks' directions untouched", async () => {
        const {scene, states, tracks} = buildCase();
        const parTracks = cloneTracks(tracks);
        const before = parTracks.map((t) => t.ref);

        let calls = 0;
        const out = await refineGlobalSphericalAsync(parTracks, states, scene.lens, scene.size, {
            lanes: [localLane(), localLane()],
            shouldAbort: () => ++calls > 3,       // let a couple of phases through, then stop
        });

        expect(out).toBeNull();
        // A half-written map is worse than no map: everything downstream reads `ref` and has no
        // way to tell a stale direction from a fresh one.
        for (let i = 0; i < parTracks.length; i++) expect(parTracks[i].ref).toBe(before[i]);
    });

    test("with no lanes and no Worker it falls back to the synchronous solve", async () => {
        // Jest has no Worker, which is exactly the condition the fallback exists for.
        expect(typeof Worker).toBe("undefined");
        const {scene, states, tracks} = buildCase();
        const sync = refineGlobalSpherical(cloneTracks(tracks), states, scene.lens, scene.size);
        const par = await refineGlobalSphericalAsync(cloneTracks(tracks), states, scene.lens,
            scene.size, {});
        expectIdentical(sync, par);
    });

    test("a lane that throws does not silently return a partial answer", async () => {
        const {scene, states, tracks} = buildCase();
        const bad = localLane();
        const realChunk = bad.chunk;
        let n = 0;
        bad.chunk = async (msg) => {
            if (++n === 3) throw new Error("simulated worker failure");
            return realChunk(msg);
        };
        await expect(refineGlobalSphericalAsync(cloneTracks(tracks), states, scene.lens,
            scene.size, {lanes: [bad]})).rejects.toThrow("simulated worker failure");
    });
});
