// Cinematic rule checks. These are pure measurements over sampled shots, so they can be
// exercised without a scene.

const {apparentSizeFraction, sizeFractionFromAngle, angleBetweenDeg, sphereInFrustum,
       inferIntent, checkShot, checkScript,
       CINEMATIC_RULES} = require("../src/scriptedVideo/ScriptCinematics");

const AIM = {x: 0, y: 0, z: 1};
// build evenly spaced samples over a shot
const mk = (n, fn, t0 = 0, t1 = 1) => Array.from({length: n}, (_, i) => {
    const t = t0 + (t1 - t0) * (n === 1 ? 0 : i / (n - 1));
    return {t, inFrame: true, aim: AIM, sizeFrac: 0.4, ...fn(i, n, t)};
});
const rules = (r) => ({rules: r});
const has = (f, rule) => f.some(x => x.rule === rule);

describe("apparentSizeFraction", () => {
    test("a 30 m object at 900 m in a 30 deg lens is a small part of frame", () => {
        const s = apparentSizeFraction(15, 900, 30);
        expect(s).toBeGreaterThan(0.05);
        expect(s).toBeLessThan(0.07);          // ~1.9 deg of a 30 deg frame
    });

    test("halving the distance roughly doubles the apparent size", () => {
        const a = apparentSizeFraction(15, 900, 30), b = apparentSizeFraction(15, 450, 30);
        expect(b / a).toBeGreaterThan(1.9);
        expect(b / a).toBeLessThan(2.1);
    });

    test("narrowing the lens increases the fraction of frame", () => {
        expect(apparentSizeFraction(15, 900, 12)).toBeGreaterThan(apparentSizeFraction(15, 900, 30));
    });

    test("degenerate inputs are zero, not NaN", () => {
        for (const v of [apparentSizeFraction(0, 900, 30), apparentSizeFraction(15, 0, 30),
                         apparentSizeFraction(15, 900, 0)]) {
            expect(v).toBe(0);
        }
    });
});

describe("sizeFractionFromAngle", () => {
    // the primitive the whole size metric is stated in — an angular radius, not a sphere,
    // so an oriented box measured corner by corner reports in the same units
    test("half the fov in radius fills the frame", () => {
        expect(sizeFractionFromAngle((15 * Math.PI) / 180, 30)).toBeCloseTo(1);
    });

    test("scales linearly with the angle and inversely with the lens", () => {
        expect(sizeFractionFromAngle(0.05, 30)).toBeCloseTo(2 * sizeFractionFromAngle(0.025, 30));
        expect(sizeFractionFromAngle(0.05, 12)).toBeCloseTo(2.5 * sizeFractionFromAngle(0.05, 30));
    });

    test("degenerate inputs are zero, not NaN", () => {
        expect(sizeFractionFromAngle(0, 30)).toBe(0);
        expect(sizeFractionFromAngle(0.05, 0)).toBe(0);
    });
});

describe("angleBetweenDeg", () => {
    test("measures the turn between two aims", () => {
        expect(angleBetweenDeg({x:0,y:0,z:1}, {x:1,y:0,z:0})).toBeCloseTo(90, 6);
        expect(angleBetweenDeg({x:0,y:0,z:1}, {x:0,y:0,z:1})).toBeCloseTo(0, 6);
    });
    test("zero-length vectors give 0 rather than NaN", () => {
        expect(angleBetweenDeg({x:0,y:0,z:0}, AIM)).toBe(0);
    });
});

describe("rule 1 — a named subject must be visible", () => {
    test("passes when the subject stays in frame", () => {
        const f = checkShot({label: "a", screenIn: 0, screenOut: 4}, mk(10, () => ({})));
        expect(has(f, "SUBJECT_NOT_VISIBLE")).toBe(false);
    });

    test("fails when the subject leaves frame for much of the shot", () => {
        const f = checkShot({label: "drifty", screenIn: 0, screenOut: 4},
            mk(10, (i) => ({inFrame: i < 4})));
        const v = f.find(x => x.rule === "SUBJECT_NOT_VISIBLE");
        expect(v.severity).toBe("error");
        expect(v.message).toMatch(/only in frame for 40%/);
    });
});

describe("sphereInFrustum", () => {
    const F = {x: 0, y: 0, z: 1};          // aim: down +z
    const UP = {x: 0, y: 1, z: 0};
    // a target at 100 m, offset sideways by `x` and vertically by `y`
    const at = (x, y) => ({x, y, z: 100});

    test("straight ahead is in frame; straight behind is not", () => {
        expect(sphereInFrustum(F, UP, at(0, 0), 1, 30, 16 / 9)).toBe(true);
        expect(sphereInFrustum(F, UP, {x: 0, y: 0, z: -100}, 1, 30, 16 / 9)).toBe(false);
    });

    test("the frame is a RECTANGLE — a wide frame holds what a cone rejects", () => {
        // 20 deg off-axis horizontally in a 30 deg (vertical) 16:9 frame: outside the
        // 15 deg half-cone the old centre-angle test used, but well inside the picture,
        // whose horizontal half-angle is ~26 deg
        const off = at(100 * Math.tan(20 * Math.PI / 180), 0);
        expect(sphereInFrustum(F, UP, off, 1, 30, 16 / 9)).toBe(true);
        // the same offset VERTICALLY really is out of frame
        expect(sphereInFrustum(F, UP, at(0, off.x), 1, 30, 16 / 9)).toBe(false);
    });

    test("a large subject counts as in frame while its centre is just outside", () => {
        const justOut = at(0, 100 * Math.tan(17 * Math.PI / 180));   // 17 > 15 deg
        expect(sphereInFrustum(F, UP, justOut, 0.1, 30, 16 / 9)).toBe(false);
        expect(sphereInFrustum(F, UP, justOut, 20, 30, 16 / 9)).toBe(true);
    });

    test("a narrower lens frames less", () => {
        const off = at(0, 100 * Math.tan(10 * Math.PI / 180));
        expect(sphereInFrustum(F, UP, off, 1, 30, 16 / 9)).toBe(true);
        expect(sphereInFrustum(F, UP, off, 1, 12, 16 / 9)).toBe(false);
    });

    test("degenerate inputs are false, not NaN", () => {
        expect(sphereInFrustum({x: 0, y: 0, z: 0}, UP, at(0, 0), 1, 30, 1.7)).toBe(false);
        expect(sphereInFrustum(F, UP, null, 1, 30, 1.7)).toBe(false);
        expect(sphereInFrustum(F, UP, at(0, 0), 1, 0, 1.7)).toBe(false);
    });

    test("an up vector parallel to the aim still resolves a basis", () => {
        // looking straight down the up axis: no roll is defined, so any basis will do,
        // but it must not return NaN or throw
        expect(sphereInFrustum(UP, UP, {x: 0, y: 100, z: 0}, 1, 30, 1.7)).toBe(true);
    });
});

describe("rule 2 — apparent size must suit the shot's intent", () => {
    test("a speck is an error whatever the intent", () => {
        const f = checkShot({label: "tiny", screenIn: 0, screenOut: 4},
            mk(6, () => ({sizeFrac: 0.001})));
        expect(f.find(x => x.rule === "SPECK").severity).toBe("error");
    });

    test("an establishing shot may keep the subject small", () => {
        const f = checkShot({label: "wide", screenIn: 0, screenOut: 4, intent: "establish"},
            mk(6, () => ({sizeFrac: 0.02})));
        expect(has(f, "SPECK")).toBe(false);
        expect(has(f, "WEAK_CLOSEUP")).toBe(false);
    });

    test("a push-in that ends small is a failed close-up", () => {
        // grows 0.02 -> 0.08: inferred as `feature`, but ends under the floor
        const f = checkShot({label: "push", screenIn: 0, screenOut: 4},
            mk(6, (i, n) => ({sizeFrac: 0.02 + (0.06 * i) / (n - 1)})));
        const v = f.find(x => x.rule === "WEAK_CLOSEUP");
        expect(v).toBeTruthy();
        expect(v.message).toMatch(/aim for 30-50%/);
    });

    test("a push-in landing in the 30-50% band is clean", () => {
        const f = checkShot({label: "good push", screenIn: 0, screenOut: 4},
            mk(6, (i, n) => ({sizeFrac: 0.05 + (0.33 * i) / (n - 1)}), 0, 4));
        expect(f).toEqual([]);
    });

    test("a feature shot settling under 30% is under-framed, not merely small", () => {
        // 20% of frame height: readable, above the 15% floor, but not the close-up asked for
        const f = checkShot({label: "shy", screenIn: 0, screenOut: 4, intent: "feature"},
            mk(6, () => ({sizeFrac: 0.20}), 0, 4));
        const v = f.find(x => x.rule === "UNDER_FRAMED");
        expect(v).toBeTruthy();
        expect(v.message).toMatch(/under the 30-50%/);
        expect(has(f, "WEAK_CLOSEUP")).toBe(false);      // it is not a FAILED close-up
    });

    test("a feature shot settling over 50% crowds the frame", () => {
        const f = checkShot({label: "crowd", screenIn: 0, screenOut: 4, intent: "feature"},
            mk(6, () => ({sizeFrac: 0.70}), 0, 4));
        expect(f.find(x => x.rule === "OVER_FRAMED").settledSizeFraction).toBeCloseTo(0.70);
    });

    test("both edges of the band are clean between them", () => {
        for (const size of [0.30, 0.40, 0.50]) {
            const f = checkShot({label: "band", screenIn: 0, screenOut: 4, intent: "feature"},
                mk(6, () => ({sizeFrac: size}), 0, 4));
            expect(f).toEqual([]);
        }
    });

    test("framing is judged where the shot SETTLES, not at its peak", () => {
        // pushes in to a good 40%, then pulls back out to 20% — what the shot leaves the
        // viewer with is the 20%, so the peak must not excuse it
        const f = checkShot({label: "in and out", screenIn: 0, screenOut: 8, intent: "feature"},
            mk(9, (i, n) => ({sizeFrac: i < n / 2 ? 0.40 : 0.20}), 0, 8));
        expect(has(f, "UNDER_FRAMED")).toBe(true);
    });

    test("an establishing shot is held to none of the band", () => {
        const f = checkShot({label: "wide", screenIn: 0, screenOut: 4, intent: "establish"},
            mk(6, () => ({sizeFrac: 0.05}), 0, 4));
        expect(has(f, "UNDER_FRAMED")).toBe(false);
    });

    test("intent is inferred: growing => feature, steady => establish", () => {
        const grow = mk(4, (i, n) => ({sizeFrac: 0.02 + 0.2 * i / (n - 1)}));
        const flat = mk(4, () => ({sizeFrac: 0.02}));
        expect(inferIntent(grow)).toBe("feature");
        expect(inferIntent(flat)).toBe("establish");
        expect(inferIntent(grow, "establish")).toBe("establish");   // author wins
    });
});

describe("rule 3 — motion must be deliberate", () => {
    test("a whip pan is flagged", () => {
        const s = [
            {t: 0,   sizeFrac: 0.4, inFrame: true, aim: {x: 0, y: 0, z: 1}},
            {t: 0.5, sizeFrac: 0.4, inFrame: true, aim: {x: 1, y: 0, z: 0}},   // 90 deg in 0.5 s
        ];
        const v = checkShot({label: "whip", screenIn: 0, screenOut: 0.5}, s)
            .find(x => x.rule === "WHIP_PAN");
        expect(v.degPerSec).toBe(180);
    });

    test("a steady pan is not", () => {
        const s = [
            {t: 0, sizeFrac: 0.4, inFrame: true, aim: {x: 0, y: 0, z: 1}},
            {t: 4, sizeFrac: 0.4, inFrame: true, aim: {x: 1, y: 0, z: 0}},     // 90 deg over 4 s
        ];
        expect(has(checkShot({label: "pan", screenIn: 0, screenOut: 4}, s), "WHIP_PAN")).toBe(false);
    });

    test("the same angular rate is a whip through a long lens and not through a wide one", () => {
        // 40 deg/s: a fifth of a frame per second at 200 deg, but three frames a second
        // through a 12 deg telephoto
        const pan = (fov) => [
            {t: 0, sizeFrac: 0.4, inFrame: true, fov, aim: {x: 0, y: 0, z: 1}},
            {t: 1, sizeFrac: 0.4, inFrame: true, fov,
             aim: {x: Math.sin(40 * Math.PI / 180), y: 0, z: Math.cos(40 * Math.PI / 180)}},
        ];
        const shot = {label: "pan", screenIn: 0, screenOut: 1};
        expect(has(checkShot(shot, pan(12)), "WHIP_PAN")).toBe(true);
        expect(has(checkShot(shot, pan(200)), "WHIP_PAN")).toBe(false);
    });

    test("a sample with no lens is judged at the nominal 30 deg", () => {
        // 90 deg in 1 s = 3 frame-heights/s at 30 deg — over the limit either way
        const s = [
            {t: 0, sizeFrac: 0.4, inFrame: true, aim: {x: 0, y: 0, z: 1}},
            {t: 1, sizeFrac: 0.4, inFrame: true, aim: {x: 1, y: 0, z: 0}},
        ];
        expect(checkShot({label: "p", screenIn: 0, screenOut: 1}, s)
            .find(x => x.rule === "WHIP_PAN").screensPerSec).toBe(3);
    });

    test("a zoom that snaps in and back out is caught, not cancelled out", () => {
        // ends where it began, so an end-to-end measurement reads a placid 1x/s; the
        // 4x jump in the middle second is what the viewer actually sees
        const sizes = [0.1, 0.1, 0.4, 0.4, 0.1, 0.1];
        const s = sizes.map((sizeFrac, i) => (
            {t: i, sizeFrac, inFrame: true, fov: 30, aim: {x: 0, y: 0, z: 1}}));
        const v = checkShot({label: "pump", screenIn: 0, screenOut: 5, intent: "establish"}, s)
            .find(x => x.rule === "SNAP_ZOOM");
        expect(v).toBeTruthy();
        expect(v.ratePerSec).toBeCloseTo(4, 1);
    });

    test("a snap zoom is flagged, a gradual one is not", () => {
        const snap = [{t: 0, sizeFrac: 0.05, inFrame: true, aim: AIM},
                      {t: 0.5, sizeFrac: 0.4, inFrame: true, aim: AIM}];
        expect(has(checkShot({label: "snap", screenIn: 0, screenOut: 0.5}, snap), "SNAP_ZOOM")).toBe(true);

        const slow = [{t: 0, sizeFrac: 0.05, inFrame: true, aim: AIM},
                      {t: 6, sizeFrac: 0.4, inFrame: true, aim: AIM}];
        expect(has(checkShot({label: "slow", screenIn: 0, screenOut: 6}, slow), "SNAP_ZOOM")).toBe(false);
    });
});

describe("rule 4 — a cut should read as a cut", () => {
    const shot = {label: "next", screenIn: 4, screenOut: 8};
    test("cutting to nearly the same framing is a jump cut", () => {
        const f = checkShot(shot, mk(4, () => ({sizeFrac: 0.4})), {
            isCut: true, prevEndAim: {x: 0, y: 0, z: 1}, prevEndSize: 0.4});
        expect(has(f, "JUMP_CUT")).toBe(true);
    });

    test("a genuinely different angle is fine", () => {
        const f = checkShot(shot, mk(4, () => ({sizeFrac: 0.4, aim: {x: 1, y: 0, z: 1}})), {
            isCut: true, prevEndAim: {x: 0, y: 0, z: 1}, prevEndSize: 0.4});
        expect(has(f, "JUMP_CUT")).toBe(false);
    });

    test("same angle but a big size change is a legitimate cut-in", () => {
        const f = checkShot(shot, mk(4, () => ({sizeFrac: 0.4})), {
            isCut: true, prevEndAim: {x: 0, y: 0, z: 1}, prevEndSize: 0.05});
        expect(has(f, "JUMP_CUT")).toBe(false);
    });

    test("a continuous move is never judged as a cut", () => {
        const f = checkShot(shot, mk(4, () => ({sizeFrac: 0.4})), {
            isCut: false, prevEndAim: {x: 0, y: 0, z: 1}, prevEndSize: 0.4});
        expect(has(f, "JUMP_CUT")).toBe(false);
    });
});

describe("rule 5 — no flash frames", () => {
    test("a very short shot is flagged", () => {
        expect(has(checkShot({label: "blink", screenIn: 0, screenOut: 0.2},
            mk(3, () => ({}), 0, 0.2)), "FLASH_FRAME")).toBe(true);
    });
    test("a normal shot is not", () => {
        expect(has(checkShot({label: "ok", screenIn: 0, screenOut: 3},
            mk(3, () => ({}), 0, 3)), "FLASH_FRAME")).toBe(false);
    });
});

describe("checkScript", () => {
    test("threads each shot's end into the next shot's cut test", () => {
        const shots = [
            {shot: {label: "one", screenIn: 0, screenOut: 4}, isCut: false,
             samples: mk(4, () => ({sizeFrac: 0.4}), 0, 4)},
            {shot: {label: "two", screenIn: 4, screenOut: 8}, isCut: true,
             samples: mk(4, () => ({sizeFrac: 0.4}), 4, 8)},
        ];
        const f = checkScript(shots);
        expect(f.some(x => x.rule === "JUMP_CUT" && x.shot === "two")).toBe(true);
    });

    test("a clean script produces no findings", () => {
        const shots = [{shot: {label: "one", screenIn: 0, screenOut: 4}, isCut: false,
                        samples: mk(6, () => ({sizeFrac: 0.4}), 0, 4)}];
        expect(checkScript(shots)).toEqual([]);
    });

    test("thresholds are overridable", () => {
        const s = mk(4, () => ({sizeFrac: 0.02}), 0, 4);
        const shot = {label: "x", screenIn: 0, screenOut: 4, intent: "feature"};
        expect(has(checkShot(shot, s), "WEAK_CLOSEUP")).toBe(true);
        expect(has(checkShot(shot, s, rules({featureFloor: 0.01})), "WEAK_CLOSEUP")).toBe(false);
    });

    test("the published thresholds match the stated 30-50% band", () => {
        expect(CINEMATIC_RULES.featureTargetMin).toBe(0.30);
        expect(CINEMATIC_RULES.featureTargetMax).toBe(0.50);
        expect(CINEMATIC_RULES.minCutAngleDeg).toBe(30);
    });
});
