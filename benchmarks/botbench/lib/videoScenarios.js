import {generateScenario} from "./generateScenario";
import {platformSpec, platformSet, PLATFORM_VARIANTS, PLATFORM_SEED} from "./botsetPlatform";
import {BOTSET_ERROR_LEVELS} from "./botsetErrors";
import {TRACKING_VIDEO_CASES, trackingVideoProgram} from "./videoTrackingScenarios";

// Video is opt-in, and uses the existing platform/balloon truth generator.
// Keep the original starter identities stable; opt into additional geometries.
export function generateVideoScenarios({count, set = "starter", zoomFactor, durationSeconds = ["offscreen", "tracking"].includes(set) || zoomFactor !== undefined ? 30 : 20, wobblePercent, wobbleDegrees,
    scenarioName, recenterSpeedScale = 1, driftSpeed, recenterSpeed, wobbleSeed} = {}) {
    const geometries = {
        starter: [[5, .25]],
        extended: [[5, .5], [10, .25]],
        offscreen: [[5, .25]],
        tracking: [[5, .25]],
    };
    if (!Object.hasOwn(geometries, set)) throw new Error(`Unknown video set: ${set}`);
    let definitions = geometries[set].flatMap(([gKm, depth]) =>
        [["party-neutral", "orbit"], ["party-rising", "orbit"], ["party-neutral", "straight"]]
            .map(([kind, path]) => ({path, variant: PLATFORM_VARIANTS.find(v =>
                v.cell.gKm === gKm && v.cell.f === depth && v.obj.kind === kind)})));
    if (set === "offscreen") definitions = definitions.flatMap(d => [{...d, losses: 1}, {...d, losses: 2}]);
    if (set === "tracking") definitions = TRACKING_VIDEO_CASES.map((tracking, i) => ({...definitions[i % 3], tracking}));
    count ??= definitions.length;
    if (!Number.isInteger(count) || count < 1 || count > definitions.length) throw new Error(`count must be 1..${definitions.length}`);
    if (wobbleSeed !== undefined && (!Number.isInteger(wobbleSeed) || wobbleSeed < 0 || wobbleSeed > 0xffffffff)) {
        throw new Error("wobble seed must be an unsigned 32-bit integer");
    }
    if (!(Math.round(durationSeconds * 30) >= 1 && durationSeconds <= 90)) throw new Error("duration must contain at least one frame and be <=90 seconds");
    if (set === "offscreen" && durationSeconds < 27) throw new Error("offscreen clips need at least 27 seconds to finish reacquisition");
    if (set === "tracking" && durationSeconds < 27) throw new Error("tracking demonstrations need at least 27 seconds");
    if (zoomFactor !== undefined && (!Number.isFinite(zoomFactor) || zoomFactor <= 1 || zoomFactor > 10 || Math.round(durationSeconds * 30) <= 600)) {
        throw new Error("zoom factor must be >1 and <=10, with at least one frame at or after 20 seconds");
    }
    if (!Number.isFinite(recenterSpeedScale) || recenterSpeedScale <= 0 || recenterSpeedScale > 10) throw new Error("recenter speed scale must be >0 and <=10");
    if (driftSpeed !== undefined && (!Number.isFinite(driftSpeed) || driftSpeed < 0 || driftSpeed > 3)) throw new Error("drift speed must be 0..3 degrees/s");
    if (recenterSpeed !== undefined && (!Number.isFinite(recenterSpeed) || recenterSpeed < 0.1 || recenterSpeed > 10)) throw new Error("recenter speed must be 0.1..10 degrees/s");
    if (recenterSpeed !== undefined && recenterSpeedScale !== 1) throw new Error("Choose an absolute recenter speed or a scale, not both");
    if (wobblePercent !== undefined && wobbleDegrees !== undefined) throw new Error("Choose wobble percent or degrees, not both");
    if (wobbleDegrees !== undefined) {
        if (!Number.isFinite(wobbleDegrees) || wobbleDegrees < 0 || wobbleDegrees > 5) throw new Error("wobble degrees must be 0..5");
    } else {
        wobblePercent ??= 0.1;
        if (!Number.isFinite(wobblePercent) || wobblePercent < 0 || wobblePercent > 10) throw new Error("wobble percent must be 0..10");
    }
    const scenarios = definitions.map(({variant, path, losses, tracking}, i) => {
        const spec = platformSpec(variant, platformSet(path), BOTSET_ERROR_LEVELS[0]);
        const scenario = generateScenario(spec, {scenarioSeed: PLATFORM_SEED});
        // Resample the original 10 Hz truth, rather than changing fps in the
        // seed key and silently generating a different balloon trajectory.
        const sample = (a, t) => {
            const f = t * scenario.fps, lo = Math.floor(f), hi = Math.min(lo + 1, scenario.n - 1);
            return [0, 1, 2].map(k => a[lo * 3 + k] + (a[hi * 3 + k] - a[lo * 3 + k]) * (f - lo));
        };
        const frames = Math.round(durationSeconds * 30);
        return {
            name: `${String(i + ({starter: 1, extended: 4, offscreen: 10, tracking: 16})[set]).padStart(2, "0")}-${spec.target.kind}-${path}`
                + (set === "extended" ? `-g${variant.cell.gKm}km-f${variant.cell.depthPct}` : "")
                + (losses ? `-loss-${losses === 1 ? "once" : "twice"}` : "") + (tracking ? `-${tracking.id}` : ""),
            sourceScenarioId: scenario.scenarioId, sourceSpec: spec, scenarioSeed: PLATFORM_SEED,
            site: scenario.site, width: 640, height: 480, fps: 30, frames,
            durationSeconds: frames / 30, diameterM: 1, targetPixels: 6, recenterSpeedScale,
            ...(driftSpeed !== undefined ? {driftSpeed} : {}),
            ...(recenterSpeed !== undefined ? {recenterSpeed} : {}),
            ...(wobbleDegrees !== undefined ? {wobbleDegrees} : {wobblePercent}),
            ...(zoomFactor !== undefined ? {zoomEvents: [{timeSeconds: 10, magnification: zoomFactor},
                {timeSeconds: 20, magnification: 1}]} : {}),
            ...(tracking ? {trackingSimulation: trackingVideoProgram(tracking)} : {}),
            ...(losses ? {offscreenEvents: losses === 1
                ? [{startSeconds: 10, durationSeconds: 7, direction: 1}]
                : [{startSeconds: 4, durationSeconds: 5, direction: 1},
                    {startSeconds: 16, durationSeconds: 10, direction: -1}]} : {}),
            wobbleSeed: wobbleSeed ?? scenario.rngSeeds.observation,
            sensorENU: Array.from({length: frames}, (_, f) => sample(scenario.platform.positionENU, f / 30)),
            targetENU: Array.from({length: frames}, (_, f) => sample(scenario.target.positionENU, f / 30)),
        };
    });
    if (scenarioName !== undefined) {
        const scenario = scenarios.find(s => s.name === scenarioName);
        if (!scenario) throw new Error(`Unknown video scenario: ${scenarioName}`);
        return [scenario];
    }
    return scenarios.slice(0, count);
}
