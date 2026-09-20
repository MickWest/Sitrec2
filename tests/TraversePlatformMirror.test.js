/** Same-time sustained acceleration pattern matching; no truth is used to grade. */
import {
    detrendUniformMotion, platformMirrorStat, platformMirrorRank,
    platformMirrorSignificant, platformMirrorSummary, platformMirrorExplanation,
    gradeHypotheses, PLATFORM_MIRROR_METHOD,
} from "../src/TraversePlatformMirror";
import {hypothesisFitKind, plausibilityRating, assessExecutiveVerdict} from "../src/TraverseRanking";

const FPS = 10, N = 1201;
function pathFrom(fn, fps = FPS, duration = 120) {
    return Float64Array.from(Array.from({length: Math.round(fps * duration) + 1}, (_, f) => fn(f / fps)).flat());
}
function platformPath() {
    // Positive but varying eastward acceleration, with a clear timing pattern.
    return pathFrom(t => [1.5 * t * t - 2 / 0.04 * Math.sin(0.2 * t), 50 * t, 1000]);
}
function truthPath() { return pathFrom(t => [500 + 20 * t, 2400 + 5 * t, 250]); }
function blend(truth, platform, k) { return truth.map((v, i) => k * v + (1 - k) * platform[i]); }
function meanRange(track, platform) {
    let sum = 0;
    for (let f = 0; f < track.length / 3; f++) sum += Math.hypot(...[0,1,2].map(c => track[3*f+c] - platform[3*f+c]));
    return sum / (track.length / 3);
}
const stat = (x, p, options = {}) => platformMirrorStat(x, p, x?.length / 3,
    {fps: FPS, rangeM: 1000, errDeg: 0.01, ...options});

// Integrate declared acceleration events. This defines trajectories, not the
// correlation calculation under test.
function eventPath(at, axis = 0, scale = 1, baseline = 0.2) {
    const out = new Float64Array(N * 3);
    let x = 0, v = 0;
    for (let f = 0; f < N; f++) {
        const t = f / FPS, a = scale * (baseline + 2 * Math.exp(-(((t-at)/3)**2)));
        x += v / FPS + a / (2 * FPS * FPS); v += a / FPS;
        out[3*f+axis] = x;
    }
    return out;
}

describe("acceleration pattern timing", () => {
    test.each([0.3, 2.5])("same-time scaled events pass for range factor %s", k => {
        const p = platformPath(), x = blend(truthPath(), p, k);
        const s = stat(x, p);
        expect(s.method).toBe(PLATFORM_MIRROR_METHOD);
        expect(s.beta).toBeCloseTo(1-k, 8);
        expect(s.share).toBeGreaterThan(0.999);
        expect(s.scaleStable).toBe(true);
        expect(s.scales).toHaveLength(3);
        expect(platformMirrorRank(s)).toBe(1);
        expect(s.referenceRangeM).toBeUndefined();
    });

    test("a brief shared manoeuvre remains assessable during a mostly straight clip", () => {
        const p=eventPath(50,0,1,0),x=eventPath(50,0,2,0),s=stat(x,p);
        expect(s.scales.every(c=>c.activeFrames<N/2)).toBe(true);
        expect(s.share).toBeGreaterThan(0.99);
        expect(platformMirrorRank(s)).toBe(1);
    });

    test("same event magnitudes in perpendicular directions do not copy the platform", () => {
        const p = eventPath(45), x = eventPath(45, 1, 2);
        const s = stat(x, p);
        expect(s.share).toBeLessThan(0.05);
        expect(platformMirrorSignificant(s)).toBe(false);
    });

    test("the same event at a different time is not shifted into a match", () => {
        const s = stat(eventPath(80, 1), eventPath(35));
        expect(s.assessable).toBe(true);
        expect(s.share).toBeLessThan(0.05);
        expect(platformMirrorRank(s)).toBe(3);
    });

    test("independent motion for part of the clip does not erase a sustained match", () => {
        const p=platformPath(), x=blend(truthPath(),p,0.3);
        // Add a strong northward acceleration for 35 seconds. Its squared
        // magnitude dominates a least-squares score, but most of the clip
        // still follows exactly the same platform acceleration pattern.
        for (let f=0;f<N;f++) {
            const t=f/FPS;
            x[3*f+1] += 10*(Math.max(0,t-30)**2 - Math.max(0,t-65)**2);
        }
        const s=stat(x,p);
        expect(s.share).toBeGreaterThan(0.5);
        expect(s.share).toBeLessThan(0.85);
        expect(s.temporalMatch).toBe(true);
        expect(platformMirrorRank(s)).toBe(2);
    });

    test("opposite changes in magnitude are not simultaneous matching events", () => {
        const x = pathFrom(t => [2*t*t + 0.8/0.04*Math.sin(0.2*t), 0, 0]);
        const s = stat(x, platformPath());
        expect(s.temporalMatch).toBe(false);
        expect(platformMirrorRank(s)).toBe(3);
    });

    test("a copied steady turn is detected through its rotating acceleration vector", () => {
        const p = pathFrom(t => [4000*Math.cos(70*t/4000),4000*Math.sin(70*t/4000),7000]);
        const s = stat(blend(truthPath(), p, 0.3), p);
        expect(s.assessable).toBe(true);
        expect(s.temporalMatch).toBe(true);
        expect(platformMirrorRank(s)).toBe(1);
        expect(platformMirrorExplanation(s)).toContain("including a steady turn");
    });

    test("independent speed step against a steady orbit is not mirroring", () => {
        const p = pathFrom(t => [4000*Math.cos(70*t/4000),4000*Math.sin(70*t/4000),7000]);
        const x = pathFrom(t => [20*t + 180*Math.max(0,t-36.4),0,3000]);
        const oldP = detrendUniformMotion(p, N), oldX = detrendUniformMotion(x, N);
        // There can be substantial position correlation without simultaneous
        // acceleration events; never use it as the new score.
        let pp=0,xx=0,xp=0;
        for(let i=0;i<oldP.length;i++){pp+=oldP[i]**2;xx+=oldX[i]**2;xp+=oldP[i]*oldX[i];}
        expect(xp*xp/(pp*xx)).toBeGreaterThan(0.1);
        const s = stat(x,p);
        expect(s.assessable).toBe(true);
        expect(platformMirrorSignificant(s)).toBe(false);
    });

    test("similar constant acceleration cannot masquerade as following a turn", () => {
        const w=Math.PI/240,r=2/w**2;
        const p=pathFrom(t=>[r*Math.cos(w*t),r*Math.sin(w*t),0]);
        const x=pathFrom(t=>[-t*t/Math.sqrt(2),-t*t/Math.sqrt(2),0]);
        const s=stat(x,p);
        expect(s.assessable).toBe(true);
        expect(s.share).toBeGreaterThan(0.5);
        expect(s.temporalMatch).toBe(false);
        expect(platformMirrorRank(s)).toBe(3);
    });

    test("same-speed turns with different phases are not rotated into agreement", () => {
        const w=70/4000;
        const p=pathFrom(t=>[4000*Math.cos(w*t),4000*Math.sin(w*t),0]);
        const x=pathFrom(t=>[4000*Math.cos(w*t+Math.PI/4),4000*Math.sin(w*t+Math.PI/4),0]);
        const s=stat(x,p);
        expect(s.assessable).toBe(true);
        expect(s.share).toBeLessThan(0.05);
        expect(platformMirrorRank(s)).toBe(3);
    });

    test("straight or uniformly accelerating platforms are unassessed", () => {
        for (const p of [truthPath(), pathFrom(t => [t*t,0,0])]) {
            const s = stat(platformPath(),p);
            expect(s.assessable).toBe(false);
            expect(platformMirrorRank(s)).toBe(3);
        }
    });

    test("constant-velocity candidates match no acceleration events", () => {
        expect(platformMirrorRank(stat(truthPath(),platformPath()))).toBe(3);
    });

    test("an unresolved tiny matching motion gets no penalty", () => {
        const p=platformPath(),s=stat(blend(truthPath(),p,0.999),p);
        expect(s.share).toBeGreaterThan(0.99);
        expect(s.snr).toBeLessThan(3);
        expect(platformMirrorRank(s)).toBe(3);
        expect(platformMirrorSummary(s)).toBeNull();
    });

    test("the complete signal must agree across smoothing scales", () => {
        // A fast unrelated oscillation disappears only in the widest window.
        const p=platformPath(),x=p.map((v,i)=>v+(i%3===0 ? 3*Math.sin(2*Math.PI*(Math.floor(i/3)/FPS)/3) : 0));
        const s=stat(x,p);
        expect(s.scales.some(c=>c.share < 0.5)).toBe(true);
        expect(platformMirrorRank(s)).toBe(3);
    });

    test.each([10,30,60])("physical windows are stable at %s fps", fps => {
        const p=pathFrom(t=>[0.5*t*t-20*Math.sin(0.2*t),0,0],fps);
        const s=stat(p.map(v=>2*v),p,{fps});
        expect(s.scales.map(c=>c.windowSeconds)).toEqual([2,4,8]);
        expect(s.beta).toBeCloseTo(2,8);
        expect(platformMirrorRank(s)).toBe(1);
    });

    test("missing timing, invalid samples and short tracks are unassessed", () => {
        expect(stat(null, platformPath())).toBeNull();
        expect(stat(truthPath(),platformPath(),{fps:undefined})).toBeNull();
        expect(platformMirrorStat(new Float64Array(30),new Float64Array(30),10,{fps:30,rangeM:1000,errDeg:0.01})).toBeNull();
        const bad=truthPath();bad[30]=NaN;
        expect(stat(bad,platformPath())).toBeNull();
    });

    test.each([undefined,"acceleration-magnitude-v1"])("old records (%s) cannot penalize a path", method => {
        const old={method,assessable:true,scaleStable:true,temporalMatch:true,share:1,beta:1,snr:100};
        expect(platformMirrorRank(old)).toBe(3);
        expect(platformMirrorSummary(old)).toBeNull();
    });

    test("summary describes the actual test without a range claim", () => {
        const s=stat(eventPath(45,0,2),eventPath(45));
        const text=platformMirrorSummary(s);
        expect(text).toContain("assessed time");
        expect(text).toContain("at the same timestamps");
        expect(text).toContain("same");
        expect(text).not.toContain("vanishes");
    });
});

describe("gradeHypotheses", () => {
    // The bug this exists to prevent: the grading was attached by ONE caller,
    // after runTraverseBattery had already frozen the executive assessment —
    // so the headline could declare a class viable while its own tile rejected
    // it — and the benchmark's verdict runner, which builds hypotheses without
    // the battery, never got the grading at all.
    const S = platformPath();
    const truth = truthPath();

    function hyp(key, track, errFloor = 0.1403) {
        return {
            key, name: key, track, errDeg: 0.01,
            params: {errFloor},
            metricsFull: {
                range: {min: 1, max: 1, mean: meanRange(track, S), rms: 1, std: 0},
                gLoad: {min: 0, max: 0.4, mean: 0.2, rms: 0.2, std: 0},
                airSpeed: {min: 0, max: 30, mean: 25, rms: 25, std: 0},
                verticalSpeed: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
                turnRate: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
                altitude: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
            },
        };
    }

    test("attaches the scene scale and the mirror record to every fitted candidate", () => {
        const mirroring = hyp("constAlt", blend(truth, S, 0.3));
        const clean = hyp("lantern", truth);
        gradeHypotheses([mirroring, clean], {S, n: N, fps: FPS}, hypothesisFitKind);

        expect(mirroring.fitScaleDeg).toBeCloseTo(0.1403, 6);
        expect(clean.fitScaleDeg).toBeCloseTo(0.1403, 6);
        expect(mirroring.platformMirror.share).toBeGreaterThan(0.99);
        expect(clean.platformMirror.share).toBeLessThan(0.01);
    });

    test("the grading is what makes the tier and the executive verdict agree", () => {
        // Ungraded, both readers see an ordinary, close-fitting aircraft.
        const aircraft = hyp("aircraft", blend(truth, S, 0.3));
        expect(plausibilityRating(aircraft).rank).toBe(3);
        expect(assessExecutiveVerdict([aircraft]).classes
            .find((c) => c.key === "fixedWing").viable).toBe(true);

        // Graded, both reject it — and they must move together: a headline
        // calling a class viable while its own tile is badged "Mirrors the
        // platform" is the inconsistency this ordering exists to prevent.
        gradeHypotheses([aircraft], {S, n: N, fps: FPS}, hypothesisFitKind);
        expect(plausibilityRating(aircraft).label).toBe("Strong platform acceleration match");
        expect(assessExecutiveVerdict([aircraft]).classes
            .find((c) => c.key === "fixedWing").viable).toBe(false);
    });

    test("a catalogue identification is judged on angle alone and is never graded", () => {
        const sat = hyp("satellite", blend(truth, S, 0.3));
        sat.params = {...sat.params, satellite: "STARLINK-1", sunlit: true};
        gradeHypotheses([sat], {S, n: N, fps: FPS}, hypothesisFitKind);
        expect(sat.platformMirror).toBeUndefined();
    });

    test("an at-infinity check carries an arbitrary helper range and is never graded", () => {
        const inf = hyp("fixedPoint", blend(truth, S, 0.3));
        inf.atInfinity = true;
        gradeHypotheses([inf], {S, n: N, fps: FPS}, hypothesisFitKind);
        expect(inf.platformMirror).toBeUndefined();
    });

    test("no reference residual leaves the absolute ladder in charge", () => {
        const h = hyp("lantern", truth, NaN);
        gradeHypotheses([h], {S, n: N, fps: FPS}, hypothesisFitKind);
        expect(h.fitScaleDeg).toBeUndefined();
    });
});
