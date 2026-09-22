import fs from "fs";
import path from "path";
import {generateScenario, DEFAULT_SITE} from "./generateScenario";
import {fovForFraction} from "./angularSize";
import {writeInterchange, invalidFrames} from "./exportInterchange";
import {EXTREME_V1_VERSION, EXTREME_V1_VARIANTS, extremeV1ReferencesMarkdown} from "./extremeV1";
import {MOTION_V1_PLATFORMS, motionV1PlatformsMarkdown} from "./motionV1Platforms";

export const MOTION_V1_VERSION = "motion-v1.1";
export const MOTION_V1_SEED = 901;
export const MOTION_V1_FPS = 10;

// Both target sets are crossed with the same ten platform programs.
export const MOTION_V1_SETS = {
    Extreme_v1: EXTREME_V1_VARIANTS,
    Anomalies_v1: [
        {kind: "high-g-turn", description: "Smooth 90-degree turn at 240 m/s, peaking at 50 g specific force.",
            parameters: {startAGL: 2000, speedMS: 240, turnDeg: 90, onsetSeconds: 5, peakLoadG: 50}},
        {kind: "acceleration-braking", description: "Accelerate from 20 to 1200 m/s in 0.4 seconds, hold for 1 second, then brake in 0.4 seconds.",
            parameters: {startAGL: 2000, speedMS: 20, peakSpeedMS: 1200, onsetSeconds: 5, transitionSeconds: 0.4, holdSeconds: 1}},
        {kind: "sharp-turn", description: "Finite 90-degree heading change at 300 m/s in 0.25 seconds.",
            parameters: {startAGL: 2000, speedMS: 300, turnDeg: 90, onsetSeconds: 5, transitionSeconds: 0.25}},
        {kind: "vertical-drop", sensorAGL: 11000, rangeM: 4000,
            description: "Rest-to-rest descent of 20,000 feet (6096 m) in 1 second.",
            parameters: {startAGL: 6800, onsetSeconds: 5, transitionSeconds: 1, dropM: 6096}},
        {kind: "ping-pong", description: "Seeded irregular 3D dashes and stops confined within a region less than 1 km across.",
            parameters: {startAGL: 2000, pathSeed: 90102}},
        {kind: "vertical-loop", description: "Complete vertical loop at 350 m/s with a 200 m radius (over 60 g inertial acceleration).",
            parameters: {startAGL: 2000, speedMS: 350, radiusM: 200, onsetSeconds: 5}},
        {kind: "j-hook", description: "Vertical 180-degree hook at 250 m/s with a 100 m radius; return along the same ground line, 200 m higher.",
            parameters: {startAGL: 2000, speedMS: 250, radiusM: 100, onsetSeconds: 5}},
        {kind: "transmedium", siteId: "ocean", description: "Air-to-water entry, 1 km submerged transit at 100 m depth, and re-emergence; underwater bearings are absent.",
            parameters: {startAGL: 100}},
    ],
};

export function motionV1Spec(setName, variant, fps = MOTION_V1_FPS, platformVariant) {
    if (!MOTION_V1_SETS[setName]?.includes(variant)) throw new Error(`motion-v1: unknown set/variant ${setName}`);
    platformVariant ??= MOTION_V1_PLATFORMS[0];
    if (!MOTION_V1_PLATFORMS.includes(platformVariant)) {
        throw new Error("motion-v1: unknown platform variant");
    }
    const rangeM = variant.rangeM ?? 5000;
    const sensorAGL = variant.sensorAGL ?? 7000;
    const diameterM = variant.diameterM ?? 5;
    return {
        siteId: variant.siteId ?? DEFAULT_SITE,
        durationSeconds: variant.durationSeconds ?? 20, fps,
        blockId: setName, initialHorizontalRangeM: rangeM,
        platform: {...platformVariant.spec, altitudeAGL: sensorAGL},
        target: {family: "motion-v1", kind: variant.kind, diameterM,
            parameters: {...variant.parameters, anomalous: setName === "Anomalies_v1"}},
        wind: {kind: "zero"},
        observation: {kind: "clean", fovFullDeg: fovForFraction(diameterM,
            Math.hypot(rangeM, sensorAGL - variant.parameters.startAGL)),
            ...(variant.kind === "transmedium" ? {visibility: "opaque-water"} : {})},
    };
}

export function generateMotionV1Scenario(setName, variant, fps = MOTION_V1_FPS, platformVariant) {
    return generateScenario(motionV1Spec(setName, variant, fps, platformVariant), {
        scenarioSeed: MOTION_V1_SEED,
        generatorVersion: setName === "Extreme_v1" ? EXTREME_V1_VERSION : MOTION_V1_VERSION,
    });
}

export function validateMotionV1Scenario(scenario, {allowPartialEvents = false} = {}) {
    if (![scenario.target.positionENU, scenario.platform.positionENU,
        scenario.observation.observedDirectionENU].every(a => a.every(Number.isFinite))) {
        throw new Error("motion-v1: nonfinite coordinates or bearings");
    }
    if (!scenario.platform.feasibility.valid || scenario.observation.outOfFrameCount) {
        throw new Error("motion-v1: invalid platform or unexpected field-of-view loss");
    }
    const m = scenario.target.profile.metrics, e = scenario.target.profile.envelope;
    if (e) {
        const g = e.accelerationMetric === "inertial" ? m.peakInertialAccelerationG : m.peakSpecificForceG;
        if (m.peakSpeedMS > e.speedLimitMS + 1e-6 || g > e.accelerationLimitG + 1e-6 || m.minAltitudeAGL <= 0) {
            throw new Error(`motion-v1: ${scenario.spec.target.kind} exceeded its intended envelope or reached the ground`);
        }
    }
    if (!allowPartialEvents && scenario.events.some(e => !e.completeInClip)) throw new Error("motion-v1: incomplete event");
    const p = scenario.platform.profile;
    if (p) {
        if (p.segments.some(s => s.startSeconds < 0 || s.endSeconds > scenario.durationSeconds
            || s.endSeconds <= s.startSeconds)
            || (p.category === "random" && (p.turnCount < 1 || p.straightCount < 1))
            || (p.category === "s-turn" && (!p.segments.some(s => s.turnRateDegS < 0)
                || !p.segments.some(s => s.turnRateDegS > 0)))) {
            throw new Error("motion-v1: incomplete platform maneuver coverage");
        }
    }
}

function readme(setName, manifest) {
    const motions = [...new Map(manifest.map(row => [row.kind, row])).values()];
    return `# ${setName}\n\n`
        + (setName === "Extreme_v1"
            ? "20 target maneuvers across four classes, each with 10 platform variants: 200 scenarios at 10 Hz. Clip lengths follow target maneuver duration so each event completes, with clean bearings and zero wind.\n\n"
            : "8 target maneuvers, each with 10 platform variants: 80 scenarios at 10 Hz. Every clip is 20 seconds (201 samples), with clean bearings and zero wind.\n\n")
        + (setName === "Extreme_v1"
            ? "These are prescribed kinematic examples of aviation extremes, with separate speed and acceleration limits. They are not validated models of particular vehicles or proof that a single aircraft can sustain every combination of these parameters.\n\n"
            : "These are hypothetical synthetic trajectories inspired by descriptions of UAP motion, not reconstructions or evidence of reported events. Anomaly labels refer to the specified dynamics, not merely to a mathematical track shape.\n\n")
        + (setName === "Extreme_v1" ? extremeV1ReferencesMarkdown() : "")
        + motionV1PlatformsMarkdown(setName, motions.length)
        + "| Motion | Peak speed (m/s) | Peak inertial acceleration (g) | Peak specific force (g) |\n|---|---:|---:|---:|\n"
        + motions.map(r => `| ${r.kind} | ${r.profile.metrics.peakSpeedMS.toFixed(2)} | ${r.profile.metrics.peakInertialAccelerationG.toFixed(2)} | ${r.profile.metrics.peakSpecificForceG.toFixed(2)} |`).join("\n")
        + "\n\n" + motions.map(r => `- **${r.kind}:** ${r.description}`).join("\n")
        + "\n\n`Input/` contains measurements, `Truth/` positions, `All/` both, and `meta/` their scenario and truth sidecars. Descriptive names and the manifest make this an open development set, not a blinded evaluation.\n\n"
        + "All timing is in physical seconds. Smooth transitions use continuous velocity; loops have finite acceleration steps at entry/exit. Peaks are evaluated from analytic velocity/acceleration at 1000 Hz, independently of the 10 Hz export. Very short events have only a few exported samples; differencing those samples underestimates their peaks. Inertial acceleration is |dV/dt|/g. Specific force is |dV/dt - gravity|/g, with downward gravity of 9.80665 m/s²; it includes the 1 g support needed for level unaccelerated flight.\n\n"
        + "The existing flat-plane ENU convention is retained. Altitude equals U plus site ground elevation; Earth curvature, terrain occlusion, aerodynamics, heating, propulsion, and sensor slew limits are not simulated. The clean sensor is an ideal tracker, with no pointing lag or noise. High-speed clips are short to limit spatial extent.\n\n"
        + (setName === "Anomalies_v1"
            ? "For transmedium motion, the ocean surface is opaque: submerged truth remains, but LOS and angular-size fields are blank and the sidecar marks those frames invalid. The current Sitrec BOT importer analyzes the longest continuous visible span when a track contains a gap; it does not fit across the submerged interval. The J-hook retraces a ground line at a different altitude, not the exact 3D path.\n\n" : "")
        + "Regenerate from the repository root with `npm run bench-bot-motion-v1 -- --out <new-output-directory>`. The default output root is `benchmarks/botbench/results`. Existing nonempty set folders are protected against accidental replacement. Specs, seeds, event windows, measured profiles, and file hashes are in the manifest and truth sidecars.\n";
}

export function generateMotionV1Sets({outRoot, sets = Object.keys(MOTION_V1_SETS)}) {
    if (!sets.length || new Set(sets).size !== sets.length || sets.some(name => !MOTION_V1_SETS[name])) {
        throw new Error("motion-v1: select unique set names from Extreme_v1, Anomalies_v1");
    }
    // Check all selected folders before writing any, so an existing dataset cannot be
    // silently mixed with regenerated files or stale variants.
    for (const name of sets) {
        const dir = path.join(outRoot, name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`motion-v1: output already exists: ${dir}`);
    }
    const results = [];
    for (const name of sets) {
        const variants = MOTION_V1_SETS[name];
        const dir = path.join(outRoot, name), manifest = [];
        for (const variant of variants) {
            for (const platformVariant of MOTION_V1_PLATFORMS) {
                const scenario = generateMotionV1Scenario(name, variant, MOTION_V1_FPS, platformVariant);
                validateMotionV1Scenario(scenario);
                const platformSuffix = `__plat-${platformVariant.id}`;
                const basename = `${variant.kind}${platformSuffix}_${scenario.durationSeconds}s-10hz_clean`;
                const out = writeInterchange(scenario, dir, {basename, sidecarDir: "meta",
                    designIntent: `${name}: ${variant.description}`
                        + ` Platform: ${platformVariant.description}`});
                const files = Object.fromEntries(["inputFile", "scenarioFile", "truthFile", "truthJsonFile", "allFile"]
                    .map(key => [key, path.relative(dir, out[key])]));
                manifest.push({set: name, kind: variant.kind, basename, description: variant.description,
                    anomalous: scenario.target.profile.anomalous, scenarioId: scenario.scenarioId,
                    fps: scenario.fps, durationSeconds: scenario.durationSeconds, frames: scenario.n,
                    invalidFrames: invalidFrames(scenario), profile: scenario.target.profile,
                    platformVariant: platformVariant.id, platformCategory: platformVariant.category,
                    platform: {spec: scenario.spec.platform, profile: scenario.platform.profile,
                        feasibility: scenario.platform.feasibility},
                    events: scenario.events, files, digests: out.digests});
            }
        }
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        fs.writeFileSync(path.join(dir, "README.md"), readme(name, manifest));
        results.push({set: name, dir, scenarios: manifest.length, fps: MOTION_V1_FPS,
            files: manifest.length * 5 + 2});
    }
    return results;
}
