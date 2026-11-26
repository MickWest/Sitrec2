const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the shipped standalone page's rules without a DOM or WebGL mock.
// Page wiring starts after the marker; parsing the rest also catches accidental
// startup dependencies added to the otherwise standalone recommendation code.
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "tools/benchmark.html"), "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const wiring = inlineScript?.indexOf("// Wire the page.") ?? -1;
if (wiring < 0) throw new Error("Standalone benchmark script/wiring marker missing");
const script = new vm.Script(inlineScript.slice(0, wiring)
    + "\n;({stats, passes, recommendation, planCases, chooseCustom, PRESETS, REFERENCE, parseBrowserGPUReport});",
{filename: "tools/benchmark.html"});

let bench;
beforeEach(() => { bench = script.runInNewContext({}); });

function report(graphics = [], observedHz = 60, targetFPS = 60) {
    return {options: {targetFPS, depth: "full"}, baseline: {observedHz}, graphics};
}

function result({id = "combined", group = "custom", preset, config = {},
    intervals = Array(80).fill(1000 / 60), cpuMs = 2, gpuMs = 7, gpuSamples = 80,
    status = "ok", actualSamples} = {}) {
    const settings = {...bench.REFERENCE, fps: 60, ...config};
    const frames = bench.stats(intervals);
    return {id, group, preset, status, config: settings,
        actual: {actualSamples: actualSamples ?? settings.samples},
        fps: 1000 / frames.mean, frames,
        cpu: bench.stats(Array(intervals.length).fill(cpuMs)),
        gpu: bench.stats(Array(gpuSamples).fill(gpuMs)),
        raw: {frameIntervalsMs: intervals}};
}

test("timing summaries exclude invalid samples without mutating captured timings", () => {
    const values = [20, NaN, 10, Infinity, 40, 30];
    const summary = bench.stats(values);
    expect(summary).toMatchObject({n: 4, mean: 25, min: 10, max: 40});
    expect(values).toEqual([20, NaN, 10, Infinity, 40, 30]);
    expect(bench.stats([NaN, Infinity])).toEqual({n: 0});
});

test("a 30 Hz display cannot validate a requested 60 fps combination", () => {
    const custom = result({intervals: Array(40).fill(1000 / 30)});
    const measured = report([custom], 30, 60);
    expect(bench.passes(custom, 60, .85, measured)).toBe(false);
    expect(bench.recommendation(measured)).toMatchObject({status: "inconclusive", settings: null});

    // A lower preset can still be useful, but must not validate the requested target.
    const balanced = result({group: "presets", preset: "Balanced",
        config: {...bench.PRESETS.Balanced}, intervals: Array(40).fill(1000 / 30)});
    measured.graphics.push(balanced);
    const recommendation = bench.recommendation(measured);
    expect(recommendation.settings.fpsLimit).toBe(30);
    expect(recommendation.requestedTargetValidated).toBe(false);
    expect(recommendation.title).toBe("Display cadence limited");
});

test("60 fps scheduled on a 75 Hz display accepts its normal alternating frame gaps", () => {
    // Four frames over five refreshes: 13.33, 13.33, 13.33, 26.67 ms.
    const intervals = Array.from({length: 80}, (_, i) => (i % 4 === 3 ? 2 : 1) * 1000 / 75);
    const run = result({intervals});
    expect(run.fps).toBeCloseTo(60);
    expect(run.frames.p95).toBeCloseTo(2000 / 75);
    expect(bench.passes(run, 60, .85, report([run], 75))).toBe(true);
});

test.each(["cpuMs", "gpuMs"])("a slow %s rejects good presentation cadence", key => {
    const run = result({[key]: 16});
    expect(run.fps).toBeCloseTo(60);
    expect(bench.passes(run, 60, .85, report([run]))).toBe(false);
});

test("recurring stalls reject a run whose average frame rate nearly meets the target", () => {
    const intervals = Array.from({length: 100}, (_, i) => i % 10 === 0 ? 26 : 1000 / 60);
    const run = result({intervals});
    expect(run.fps).toBeGreaterThan(60 * .94);
    expect(bench.passes(run, 60, .85, report([run]))).toBe(false);
});

test.each([0, 4])("%i GPU samples validate pacing only, with GPU headroom unknown", gpuSamples => {
    const run = result({gpuSamples});
    const measured = report([run]);
    expect(bench.passes(run, 60, .85, measured)).toBe(true);
    expect(bench.recommendation(measured)).toMatchObject({
        status: "validated-pacing", gpuHeadroom: "unknown", requestedTargetValidated: true,
        validatedTestId: run.id,
    });
});

test("independent passing tweaks need a successful combined run before recommendation", () => {
    const sweeps = [];
    for (const [group, key, values] of [
        ["scale", "scale", [1, .85, .7, .5, .35]],
        ["aa", "samples", [4, 2, 0]],
        ["grid", "segments", [64, 32, 16]],
    ]) {
        for (const [i, value] of values.entries()) {
            sweeps.push(result({id: `${group}-${value}`, group, config: {[key]: value}, gpuMs: i ? 7 : 16}));
        }
    }
    const measured = report(sweeps);
    const selected = bench.chooseCustom(measured);
    expect(selected).toMatchObject({scale: .85, samples: 2, segments: 32, fps: 60});
    expect(bench.recommendation(measured)).toMatchObject({status: "inconclusive", settings: null});

    measured.graphics.push(result({id: "combined-failed", config: selected, gpuMs: 20}));
    expect(bench.recommendation(measured)).toMatchObject({status: "inconclusive", settings: null});

    measured.graphics.push(result({id: "combined-passed", config: selected}));
    expect(bench.recommendation(measured)).toMatchObject({
        status: "validated-synthetic", validatedTestId: "combined-passed",
        settings: {performancePreset: "Custom", renderScale: .85, msaaSamples: 2,
            tileSegments: 32, fpsLimit: 60},
    });
});

test.each(["unsupported", "skipped", "error", "insufficient-samples", "interrupted"])(
    "%s measurements cannot produce a validated recommendation", status => {
        // Even if timing fields survived an interrupted or failed measurement,
        // they cannot be promoted into a successful graphics recommendation.
        const run = result({status});
        const measured = report([run]);
        expect(bench.passes(run, 60, .85, measured)).toBe(false);
        expect(bench.recommendation(measured)).toMatchObject({status: "inconclusive", settings: null});
    });

test("a CPU-only or empty graphics report does not invent recommended settings", () => {
    expect(bench.recommendation(report())).toMatchObject({status: "inconclusive", settings: null});
});

test("unsupported MSAA results are excluded while actual fallback samples remain visible", () => {
    const measured = report([
        result({group: "aa", config: {samples: 4}, status: "unsupported", actualSamples: 2}),
        result({group: "aa", config: {samples: 2}}),
    ]);
    expect(bench.chooseCustom(measured).samples).toBe(2);
    const fallback = result({config: {samples: 4}, actualSamples: 2});
    measured.graphics.push(fallback);
    expect(bench.recommendation(measured)).toMatchObject({actualMSAA: 2, settings: {msaaSamples: 4}});
});

test("single-variable sweeps hold all other reference workload controls fixed", () => {
    const plan = bench.planCases();
    expect(new Set(plan.map(test => test.id)).size).toBe(plan.length);
    for (const [group, allowed] of [
        ["scale", ["scale"]], ["aa", ["samples"]], ["grid", ["segments"]],
        ["draws", ["partitions"]], ["layers", ["shader", "layers"]],
        ["uploads", ["upload"]], ["tiles", ["tiles"]], ["pacing", ["fps"]],
    ]) {
        const cases = plan.filter(test => test.group === group);
        expect(cases.length).toBeGreaterThan(1);
        for (const test of cases) {
            const changed = Object.keys(test.config).filter(key => test.config[key] !== bench.REFERENCE[key]);
            expect(changed.length).toBeLessThanOrEqual(1);
            expect(changed.every(key => allowed.includes(key))).toBe(true);
            if (group === "aa") expect(test.exactSamples).toBe(true);
        }
    }
});

test("standalone presets stay aligned with Sitrec's actual user settings", () => {
    const source = fs.readFileSync(path.join(root, "src/CustomSupport.js"), "utf8");
    const literal = source.match(/const PERFORMANCE_PRESETS = (\{[\s\S]*?\n\});/)?.[1];
    expect(literal).toBeDefined();
    const presets = vm.runInNewContext(`(${literal})`, {});
    const expected = Object.fromEntries(Object.entries(presets).map(([name, preset]) => [name, {
        scale: preset.renderScale, samples: preset.msaaSamples, fps: preset.fpsLimit,
        segments: preset.tileSegments, maxDetails: preset.maxDetails, video: preset.videoMaxSize,
    }]));
    expect(bench.PRESETS).toEqual(expected);
});


function syntheticBrowserGPUReport({eol = "\n", browserKey = "Chrome version", features,
    drivers, versions = [], extra = []} = {}) {
    return [
        "Graphics Feature Status", "=======================",
        ...(features || ["* Canvas: Hardware accelerated", "* WebGL: Hardware accelerated"]), "",
        "Version Information", "===================",
        "Data exported : 01/02/2000, 03:04:05",
        `${browserKey} : Example Browser/100.0`, ...versions,
        "Operating system : Example OS", "",
        "Driver Information", "==================",
        ...(drivers || [
            "GPU0 : VENDOR=0x0000, DEVICE=0x0000 *ACTIVE*",
            "GL_RENDERER : ANGLE (Example Renderer, backend: example)",
            "GPU process crash count : 0",
        ]), "", ...extra,
    ].join(eol);
}

describe("imported browser GPU text", () => {
    test.each(["\n", "\r\n", "\r"])("preserves the exact raw report and sections with %j endings", eol => {
        const rawText = syntheticBrowserGPUReport({eol});
        const parsed = bench.parseBrowserGPUReport(rawText, "example-gpu.txt");
        expect(parsed.rawText).toBe(rawText);
        expect(parsed.filename).toBe("example-gpu.txt");
        expect(parsed.exportedAt).toBe("01/02/2000, 03:04:05");
        expect(parsed.summary).toMatchObject({browser: "Example Browser/100.0", os: "Example OS",
            glRenderer: "ANGLE (Example Renderer, backend: example)", crashCount: 0});
        expect(parsed.sections.map(section => section.title)).toEqual([
            "Graphics Feature Status", "Version Information", "Driver Information",
        ]);
        expect(parsed.sections[0].text).toBe(
            ["* Canvas: Hardware accelerated", "* WebGL: Hardware accelerated", "", ""].join(eol));
        expect(parsed.summary.activeGPUs).toEqual([{id: "GPU0",
            description: "VENDOR=0x0000, DEVICE=0x0000 *ACTIVE*", section: "Driver Information"}]);
    });

    test.each(["Chrome version", "Chromium version", "Edge version", "Microsoft Edge version"])(
        "accepts the %s browser field without interpreting its version", browserKey => {
            const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({browserKey}));
            expect(parsed.summary.browser).toBe("Example Browser/100.0");
        });

    test("indented URL and colon continuations stay attached to the previous value", () => {
        const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({versions: [
            "Command line : --example",
            "  https://example.invalid/path:detail",
            "    continued: literal value",
        ]}));
        const entries = parsed.sections.find(section => section.title === "Version Information").entries;
        expect(entries.find(entry => entry.key === "Command line").value)
            .toBe("--example\nhttps://example.invalid/path:detail\ncontinued: literal value");
        expect(entries.some(entry => entry.key === "https" || entry.key === "continued")).toBe(false);
        expect(parsed.summary.os).toBe("Example OS");
    });

    test("duplicate keys and sections are retained without replacing the first summary value", () => {
        const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({features: [
            "* Canvas: First result", "* Canvas: Second result",
            '* __proto__: {"polluted":true}', "* constructor: literal constructor", "* toString: literal string",
        ], extra: ["Graphics Feature Status", "=======================", "* Canvas: Third result", ""]}));
        const featureStatus = parsed.summary.featureStatus;
        expect(Object.getPrototypeOf(featureStatus)).toBeNull();
        expect(featureStatus.Canvas).toBe("First result");
        expect(featureStatus.__proto__).toBe('{"polluted":true}');
        expect(featureStatus.constructor).toBe("literal constructor");
        expect(featureStatus.toString).toBe("literal string");
        expect(Object.prototype.polluted).toBeUndefined();
        const values = parsed.sections.flatMap(section => section.entries)
            .filter(entry => entry.key === "Canvas").map(entry => entry.value);
        expect(values).toEqual(["First result", "Second result", "Third result"]);
        const exported = JSON.parse(JSON.stringify(parsed));
        expect(Object.prototype.hasOwnProperty.call(exported.summary.featureStatus, "__proto__")).toBe(true);
        expect(exported.rawText).toBe(parsed.rawText);
    });

    test("recognizes explicit active flags without matching inactive GPU names", () => {
        const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({drivers: [
            "GPU0 : Example Adapter *ACTIVE*",
            "GPU1 : Example Adapter, ACTIVE",
            "GPU2 : Example Adapter, INACTIVE",
            "GPU3 : SuperACTIVE Example Adapter",
            "GPU4 : Example Adapter; ACTIVE; driver=example",
            "Device0 : Example Adapter *ACTIVE*",
            "GPU process crash count : 12",
        ], extra: ["Driver Information for Hardware GPU", "===================================",
            "GPU0 : Hardware Example *ACTIVE*", ""]}));
        expect(parsed.summary.activeGPUs.map(gpu => [gpu.id, gpu.section])).toEqual([
            ["GPU0", "Driver Information"], ["GPU1", "Driver Information"],
            ["GPU4", "Driver Information"], ["GPU0", "Driver Information for Hardware GPU"],
        ]);
        expect(parsed.summary.crashCount).toBe(12);
    });

    test("invalid or unsafe crash counts remain unknown instead of becoming numbers", () => {
        for (const count of ["", "-1", "1.5", "1e2", "Infinity", "unknown", "9007199254740992"]) {
            const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({drivers: [
                `GPU process crash count : ${count}`,
            ]}));
            expect(parsed.summary.crashCount).toBeNull();
        }
        const absent = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({drivers: ["GPU0 : Example Adapter"]}));
        expect(absent.summary.crashCount).toBeNull();
        expect(absent.summary.activeGPUs).toEqual([]);
        expect(absent.summary.glRenderer).toBeNull();
    });

    test("workarounds and warning continuations remain readable report data", () => {
        const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({extra: [
            "Driver Bug Workarounds", "======================",
            "* example_workaround", "* another_example_workaround", "",
            "Problems Detected", "=================",
            "* Example limitation", "  Reference: https://example.invalid/issue:1", "",
            "* Another limitation", "",
        ]}));
        expect(parsed.summary.workarounds).toEqual(["example_workaround", "another_example_workaround"]);
        expect(parsed.summary.warnings).toEqual([
            "Example limitation\nReference: https://example.invalid/issue:1", "Another limitation",
        ]);
    });

    test("unbulleted warning paragraphs split correctly with CR-only line endings", () => {
        const parsed = bench.parseBrowserGPUReport(syntheticBrowserGPUReport({eol: "\r", extra: [
            "Warnings", "========", "First warning", "", "Second warning", "",
        ]}));
        expect(parsed.summary.warnings).toEqual(["First warning", "Second warning"]);
    });

    test("rejects nontext, empty, malformed and oversized imports", () => {
        for (const input of [null, undefined, 3, {}]) {
            expect(() => bench.parseBrowserGPUReport(input)).toThrow(/must be text/i);
        }
        for (const input of ["", " \r\n\t"]) {
            expect(() => bench.parseBrowserGPUReport(input)).toThrow(/empty/i);
        }
        expect(() => bench.parseBrowserGPUReport("unrelated text")).toThrow(/expected.*headings/i);
        expect(() => bench.parseBrowserGPUReport(syntheticBrowserGPUReport()
            .replace("Driver Information", "Other Information"))).toThrow(/expected.*headings/i);
        expect(() => bench.parseBrowserGPUReport(syntheticBrowserGPUReport()
            .replace("Chrome version", "Browser build"))).toThrow(/browser version field/i);
        expect(() => bench.parseBrowserGPUReport("x".repeat(1024 * 1024 + 1))).toThrow(/exceeds the limit/i);
    });
});
