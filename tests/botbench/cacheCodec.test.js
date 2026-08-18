/**
 * The BOTBench cache codec, on the four things plain JSON gets wrong.
 *
 * Each case here is a value the traverse analysis really produces, and each one
 * round-trips through JSON.stringify as something else entirely — silently.
 */
import {packForCache, unpackFromCache} from "../../src/analysis/BotBenchCacheCodec";

const roundTrip = (v) => unpackFromCache(JSON.parse(JSON.stringify(packForCache(v))));

test("a Float64Array comes back as a Float64Array, not an object", () => {
    const track = new Float64Array([1.5, -2.25, 1e300, 0]);
    // What plain JSON does with it, for contrast: {"0":1.5,...}
    expect(JSON.parse(JSON.stringify(track))).toEqual({0: 1.5, 1: -2.25, 2: 1e300, 3: 0});
    const out = roundTrip(track);
    expect(out).toBeInstanceOf(Float64Array);
    expect(Array.from(out)).toEqual([1.5, -2.25, 1e300, 0]);
});

test("other array types keep their own type", () => {
    expect(roundTrip(new Uint8Array([0, 255]))).toBeInstanceOf(Uint8Array);
    expect(Array.from(roundTrip(new Uint8Array([0, 255])))).toEqual([0, 255]);
    expect(roundTrip(new Float32Array([0.5]))).toBeInstanceOf(Float32Array);
    expect(roundTrip(new Int32Array([-7]))).toBeInstanceOf(Int32Array);
});

// An at-infinity hypothesis really does report Infinity for its range, and an
// unscored metric really is NaN. JSON turns both into null, which reads as
// "no value" — the opposite of what each one means.
test("NaN and Infinity survive, where JSON turns them into null", () => {
    expect(JSON.parse(JSON.stringify({a: NaN, b: Infinity}))).toEqual({a: null, b: null});
    const out = roundTrip({a: NaN, b: Infinity, c: -Infinity, d: 0});
    expect(Number.isNaN(out.a)).toBe(true);
    expect(out.b).toBe(Infinity);
    expect(out.c).toBe(-Infinity);
    expect(out.d).toBe(0);
});

// rangeProfile returns its rows as an array and hangs boundaryLimited,
// bestIndex and friends off the array object. Dropping those inverted a
// manifest completeness flag on a cached run while every track stayed identical.
test("fields hung off an array survive", () => {
    const profile = [{score: 1}, {score: 2}];
    profile.boundaryLimited = true;
    profile.bestIndex = 0;
    profile.boundarySides = {lo: true, hi: false};
    expect(JSON.parse(JSON.stringify(profile))).toEqual([{score: 1}, {score: 2}]);  // lost
    const out = roundTrip(profile);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(2);
    expect(out[1].score).toBe(2);
    expect(out.boundaryLimited).toBe(true);
    expect(out.bestIndex).toBe(0);
    expect(out.boundarySides).toEqual({lo: true, hi: false});
});

// runTraverseBattery returns the solution families as a Map keyed by
// "key|windEvidenceRole" and the gallery reads it with .get(). Refusing Maps
// made every cache write fail whenever Solution Families was enabled — safely,
// but silently, so the cache simply never worked in that mode.
test("a Map keeps its type and its contents", () => {
    const m = new Map([["a|", {score: 1}], ["b|wind", {track: new Float64Array([7])}]]);
    const out = roundTrip({families: m});
    expect(out.families).toBeInstanceOf(Map);
    expect(out.families.get("a|")).toEqual({score: 1});
    expect(Array.from(out.families.get("b|wind").track)).toEqual([7]);
    expect(out.families.size).toBe(2);
});

test("undefined stays undefined rather than becoming absent", () => {
    const out = roundTrip({a: undefined, b: 1});
    expect("a" in out).toBe(true);
    expect(out.a).toBeUndefined();
});

test("nesting and null are unchanged", () => {
    const v = {a: [1, {b: null, c: [new Float64Array([3])]}], d: "x", e: true};
    const out = roundTrip(v);
    expect(out.a[1].b).toBeNull();
    expect(Array.from(out.a[1].c[0])).toEqual([3]);
    expect(out.d).toBe("x");
    expect(out.e).toBe(true);
});

// THE POINT OF FAILING LOUDLY. A cache write that quietly dropped a field would
// produce a run that differs from a fresh one in a way nothing downstream could
// detect. Refusing the write costs one re-analysis; a wrong hit costs a wrong
// answer nobody questions.
describe("anything it cannot represent exactly is refused, with the path", () => {
    test("a function", () => {
        expect(() => packForCache({a: {b: () => 1}})).toThrow(/function at \$\.a\.b/);
    });
    test("a class instance", () => {
        class Model { constructor() { this.x = 1; } }
        expect(() => packForCache({fit: new Model()})).toThrow(/Model at \$\.fit/);
    });
    test("a Set and a Date", () => {
        expect(() => packForCache({s: new Set()})).toThrow(/Set at \$\.s/);
        expect(() => packForCache({d: new Date()})).toThrow(/Date at \$\.d/);
    });
    test("a field that would collide with the encoding", () => {
        expect(() => packForCache({__ta: 1})).toThrow(/reserved key/);
    });
});
