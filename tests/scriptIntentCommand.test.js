// The `intent` command: how a shot declares what it is FOR.
//
// The cinematic check holds a `feature` shot to the 30-50% framing band and lets an
// `establish` shot keep its subject small. Without a declaration the intent is inferred
// from the move, which cannot tell a push-in from a subject flying towards a locked-off
// camera — so saying so outright is always better, and this is how.

const {resolveCommand, buildEvent, eventLabel} =
    require("../src/scriptedVideo/ScriptCommands");
const {inferIntent, checkShot} = require("../src/scriptedVideo/ScriptCinematics");

const build = (...argv) => {
    const r = resolveCommand("intent");
    let err = null;
    const e = buildEvent("intent", r.def, argv, (m) => { err = m; return null; }, {});
    return {e, err};
};

describe("intent command", () => {
    test("is a resolvable, non-camera command", () => {
        const r = resolveCommand("intent");
        expect(r).not.toBeNull();
        expect(r.def.cameraBeat).toBe(false);
    });

    test("takes no screen time — it annotates the shot it is attached to", () => {
        expect(build("feature").e.dur).toBe(0);
    });

    test("accepts the two intents, in any case", () => {
        expect(build("feature").e.intent).toBe("feature");
        expect(build("establish").e.intent).toBe("establish");
        expect(build("Feature").e.intent).toBe("feature");
    });

    test("anything else is an error naming what was given", () => {
        const {e, err} = build("closeup");
        expect(e).toBeNull();
        expect(err).toMatch(/"closeup" is not one of establish, feature/);
    });

    test("a missing intent is an error, not a silent default", () => {
        const {e, err} = build();
        expect(e).toBeNull();
        expect(err).toMatch(/missing <intent>/);
    });

    test("labels itself on the timeline", () => {
        expect(eventLabel({type: "intent", ...build("feature").e})).toBe("intent feature");
    });
});

describe("a declaration beats inference", () => {
    // a shot whose subject holds steady at 20% of frame: inferred as `establish`, which
    // asks nothing of it. Declaring it a feature shot is what makes the band apply.
    const samples = Array.from({length: 6}, (_, i) => (
        {t: i * 0.8, sizeFrac: 0.20, inFrame: true, fov: 30, aim: {x: 0, y: 0, z: 1}}));

    test("inference alone would let this pass", () => {
        expect(inferIntent(samples)).toBe("establish");
        expect(checkShot({label: "s", screenIn: 0, screenOut: 4}, samples)).toEqual([]);
    });

    test("declaring it a feature shot holds it to the band", () => {
        const f = checkShot({label: "s", screenIn: 0, screenOut: 4, intent: "feature"}, samples);
        expect(f.some(x => x.rule === "UNDER_FRAMED")).toBe(true);
    });

    test("declaring `establish` overrides an inferred push-in", () => {
        // grows 2% -> 22%, which infers as `feature` and would be under-framed
        const push = samples.map((s, i) => ({...s, sizeFrac: 0.02 + 0.04 * i}));
        expect(inferIntent(push)).toBe("feature");
        expect(inferIntent(push, "establish")).toBe("establish");
        const f = checkShot({label: "s", screenIn: 0, screenOut: 4, intent: "establish"}, push);
        expect(f.some(x => x.rule === "UNDER_FRAMED")).toBe(false);
    });
});
