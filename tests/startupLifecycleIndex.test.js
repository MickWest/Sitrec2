// Two sitch-loading problems in src/index.js. index.js cannot be imported under Jest
// (it runs the whole app at module scope), so the functions under test are lifted from
// the source and run with their collaborators stubbed.
//
// 1. An unknown ?sitch= (a typo, a renamed sitch, or one this build leaves out, such as
//    ?sitch=gimbal when serverless). The only guard was an assert, which the production
//    build strips, so new CSituation(null) threw during startup and the page stayed on
//    "Loading" with no message.
//
// 2. Overlapping sitch loads. The sitch menus call newSitch() without awaiting it, and
//    newSitch() never checked for a transition already in progress. A sitch picked while
//    another was still loading disposed and replaced the global Sit, NodeMan etc. while
//    the first load was parked at an await, and the first load then carried on building
//    on the second sitch.

import fs from "fs";
import path from "path";

const indexSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf-8");

// From the line that starts with `startText` to the closing brace at column 0.
function sourceFrom(startText) {
    const start = indexSource.indexOf(startText);
    if (start < 0) throw new Error("Not found in src/index.js: " + startText);
    return indexSource.slice(start, indexSource.indexOf("\n}\n", start) + 2);
}

// Run `code` with `env` as its free variables, returning the values named in `exports`.
function load(code, env, exports) {
    const names = Object.keys(env);
    return new Function(...names, code + "\nreturn {" + exports.join(", ") + "};")(...names.map(n => env[n]));
}

describe("selectInitialSitch with an unknown sitch name", () => {
    const code = "let situation = 'custom';\nlet toTest;\nlet testing = false;\n"
        + sourceFrom("function selectInitialSitch(force) {")
        + "\nfunction getSituation() { return situation; }";

    const SITCHES = {
        custom: {data: {name: "custom", isCustom: true}},
        nightsky: {data: {name: "nightsky"}},
    };

    function run(search) {
        const env = {
            urlParams: new URLSearchParams(search),
            par: {},
            sortedSitches: {},
            localSituation: "custom",
            SITREC_SHARE_APP: "https://example.test/sitrec/",
            // findFirstData as in CManager: the first match's data, or null.
            SitchMan: {
                findFirstData: test => Object.values(SITCHES).find(test)?.data ?? null,
                exists: name => name in SITCHES,
            },
            // As in production, where Terser strips assert().
            assert: () => {},
            showError: jest.fn(),
            CSituation: jest.fn(function (props) { this.name = props.name; this.isCustom = props.isCustom; }),
            setSit: jest.fn(),
            markSitrecReady: jest.fn(),
        };
        const {selectInitialSitch, getSituation} = load(code, env, ["selectInitialSitch", "getSituation"]);
        return {env, selectInitialSitch, getSituation};
    }

    beforeEach(() => jest.spyOn(console, "log").mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    test("a known ?sitch= loads that sitch", () => {
        const {env, selectInitialSitch} = run("?sitch=NightSky");
        selectInitialSitch();
        expect(env.CSituation).toHaveBeenCalledWith(SITCHES.nightsky.data);
        expect(env.showError).not.toHaveBeenCalled();
    });

    test.each(["?sitch=gimbl", "?sitch=gimbal", "?sit=removedSitch"])(
        "%s says so and loads the default sitch", search => {
            const {env, selectInitialSitch, getSituation} = run(search);
            expect(() => selectInitialSitch()).not.toThrow();
            expect(env.showError).toHaveBeenCalledTimes(1);
            expect(env.showError.mock.calls[0][0]).toContain(search.split("=")[1]);
            expect(env.CSituation).toHaveBeenCalledTimes(1);
            expect(env.CSituation).toHaveBeenCalledWith(SITCHES.custom.data);
            expect(env.setSit).toHaveBeenCalledTimes(1);
            expect(env.markSitrecReady).toHaveBeenCalledTimes(1);
            expect(env.par.name).toBe("custom");
            expect(getSituation()).toBe("custom");
        });

    test("an unknown name from the sitch menus (newSitch) falls back the same way", () => {
        const {env, selectInitialSitch} = run("");
        selectInitialSitch("noSuchSitch");
        expect(env.showError).toHaveBeenCalledTimes(1);
        expect(env.CSituation).toHaveBeenCalledWith(SITCHES.custom.data);
    });
});

describe("newSitch serializes sitch transitions", () => {
    // The state declarations and newSitch() itself, as they are in index.js.
    const declarations = indexSource.slice(
        indexSource.indexOf("let sitchTransition"),
        indexSource.indexOf("let latestSitchRequest = 0;") + "let latestSitchRequest = 0;".length);
    const code = declarations + "\n" + sourceFrom("async function newSitch(");

    // transitionToSitch() stand-in: records what overlaps, and finishes on demand.
    function setup({approve = true} = {}) {
        const log = [];
        const running = new Set();
        const finishers = {};
        let maxConcurrent = 0;
        const transitionToSitch = jest.fn(situation => {
            running.add(situation);
            maxConcurrent = Math.max(maxConcurrent, running.size);
            log.push("start " + situation);
            return new Promise((resolve, reject) => {
                finishers[situation] = {
                    resolve: () => { running.delete(situation); log.push("end " + situation); resolve(); },
                    reject: e => { running.delete(situation); log.push("fail " + situation); reject(e); },
                };
            });
        });
        const env = {transitionToSitch, approveSitchChannel: jest.fn(async () => approve)};
        const {newSitch} = load(code, env, ["newSitch"]);
        return {newSitch, transitionToSitch, finishers, log, maxConcurrent: () => maxConcurrent};
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    test("a sitch picked during a load waits for that load to finish", async () => {
        const {newSitch, finishers, log, maxConcurrent} = setup();
        const first = newSitch("agua");
        await settle();
        const second = newSitch("gimbal");
        await settle();
        expect(log).toEqual(["start agua"]);

        finishers.agua.resolve();
        await settle();
        expect(log).toEqual(["start agua", "end agua", "start gimbal"]);
        finishers.gimbal.resolve();
        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
        expect(maxConcurrent()).toBe(1);
    });

    test("of several picks made during a load, only the latest runs", async () => {
        const {newSitch, finishers, log} = setup();
        newSitch("agua");
        await settle();
        const skipped = newSitch("gimbal");
        const latest = newSitch("gofast");
        await settle();

        finishers.agua.resolve();
        await settle();
        finishers.gofast.resolve();
        await expect(skipped).resolves.toBe(false);
        await expect(latest).resolves.toBeUndefined();
        expect(log).toEqual(["start agua", "end agua", "start gofast", "end gofast"]);
    });

    test("a failed transition does not block the next one", async () => {
        const {newSitch, finishers, log} = setup();
        const failing = newSitch("agua");
        await settle();
        const next = newSitch("gimbal");
        await settle();

        finishers.agua.reject(new Error("terrain failed"));
        await expect(failing).rejects.toThrow("terrain failed");
        await settle();
        expect(log).toEqual(["start agua", "fail agua", "start gimbal"]);
        finishers.gimbal.resolve();
        await expect(next).resolves.toBeUndefined();
    });

    test("a custom sitch the user declines does not queue a transition", async () => {
        const {newSitch, transitionToSitch} = setup({approve: false});
        await expect(newSitch({name: "custom"}, true)).resolves.toBe(false);
        expect(transitionToSitch).not.toHaveBeenCalled();
    });

    test("the startup setup is registered as the running transition", () => {
        // Sitch menus exist from initializeOnce() on, so a pick during the first load
        // has to wait for it too.
        expect(indexSource).toMatch(/const startupSetup = setupFunctions\(\);\s*\nsitchTransition = startupSetup\.catch\(\(\) => \{\}\);\s*\nawait startupSetup;/);
    });
});
