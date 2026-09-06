import {generateScenario} from "./generateScenario";
import {platformSpec, platformSet, PLATFORM_VARIANTS, PLATFORM_SEED} from "./botsetPlatform";
import {BOTSET_ERROR_LEVELS} from "./botsetErrors";

// Video is opt-in, and uses the existing platform/balloon truth generator.
// Keep the starter set small: level/orbit, rising/orbit, level/straight.
export function generateVideoScenarios({count = 3, durationSeconds = 20, wobblePercent, wobbleDegrees,
    scenarioName, recenterSpeedScale = 1, driftSpeed, recenterSpeed} = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error("count must be 1..3");
    if (!(Math.round(durationSeconds * 30) >= 1 && durationSeconds <= 90)) throw new Error("duration must contain at least one frame and be <=90 seconds");
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
    const scenarios = [[0, "orbit"], [1, "orbit"], [0, "straight"]].map(([index, path], i) => {
        const spec = platformSpec(PLATFORM_VARIANTS[index], platformSet(path), BOTSET_ERROR_LEVELS[0]);
        const scenario = generateScenario(spec, {scenarioSeed: PLATFORM_SEED});
        // Resample the original 10 Hz truth, rather than changing fps in the
        // seed key and silently generating a different balloon trajectory.
        const sample = (a, t) => {
            const f = t * scenario.fps, lo = Math.floor(f), hi = Math.min(lo + 1, scenario.n - 1);
            return [0, 1, 2].map(k => a[lo * 3 + k] + (a[hi * 3 + k] - a[lo * 3 + k]) * (f - lo));
        };
        const frames = Math.round(durationSeconds * 30);
        return {
            name: `${String(i + 1).padStart(2, "0")}-${spec.target.kind}-${path}`,
            sourceScenarioId: scenario.scenarioId, sourceSpec: spec, scenarioSeed: PLATFORM_SEED,
            site: scenario.site, width: 640, height: 480, fps: 30, frames,
            durationSeconds: frames / 30, diameterM: 1, targetPixels: 6, recenterSpeedScale,
            ...(driftSpeed !== undefined ? {driftSpeed} : {}),
            ...(recenterSpeed !== undefined ? {recenterSpeed} : {}),
            ...(wobbleDegrees !== undefined ? {wobbleDegrees} : {wobblePercent}),
            wobbleSeed: scenario.rngSeeds.observation,
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
