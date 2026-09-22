// Preserve rock_v3's 10 Hz target integrations, then crop/subsample that master.
// Integrating a sheared-wind balloon again at 1 Hz would change its path.
import {generateTargetTruth} from "./targets";

export const MUNDANE_MASTER_SECONDS = 300;
export const MUNDANE_MASTER_FPS = 10;

export function generateMundaneV1Truth(targetSpec, options, masterTruth) {
    const {n, fps, wind} = options;
    const {mundaneCoverage, ...parameters} = targetSpec.parameters;
    const start = mundaneCoverage.clipStartSeconds * MUNDANE_MASTER_FPS;
    const stride = MUNDANE_MASTER_FPS / fps;
    if (![1, 10].includes(fps) || !Number.isInteger(start) || start < 0
        || start + (n - 1) * stride > MUNDANE_MASTER_SECONDS * MUNDANE_MASTER_FPS) {
        throw new Error("mundane-v1: invalid master crop");
    }
    // The rock population is deterministic: no gusts or stochastic target motion.
    if (wind.variabilityPct !== 0 || !["party-rising", "weather-rising", "drone-circle",
        "drone-square", "drone-racetrack"].includes(targetSpec.kind)) {
        throw new Error("mundane-v1: expected a deterministic rock_v3 target");
    }
    const master = masterTruth ?? generateTargetTruth({...targetSpec, parameters},
        {...options, n: MUNDANE_MASTER_SECONDS * MUNDANE_MASTER_FPS + 1, fps: MUNDANE_MASTER_FPS});
    const positionENU = new Float64Array(n * 3), valid = new Uint8Array(n);
    for (let f = 0; f < n; f++) {
        const source = start + f * stride;
        positionENU.set(master.target.positionENU.subarray(source * 3, source * 3 + 3), f * 3);
        valid[f] = master.target.valid[source];
    }
    return {target: {...master.target, positionENU, valid,
        profile: {...master.target.profile, mundaneCoverage: {masterDurationSeconds: MUNDANE_MASTER_SECONDS,
            masterFps: MUNDANE_MASTER_FPS, clipStartSeconds: mundaneCoverage.clipStartSeconds,
            clipEndSeconds: mundaneCoverage.clipStartSeconds + (n - 1) / fps}}}, events: []};
}
