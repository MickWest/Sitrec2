// Continuous-time kinematic examples. A fixed internal grid makes the motion
// and its reported peaks independent of the requested export sample rate.
import {makeStream} from "./rng";
import {buildExtremeV1Motion} from "./extremeV1Targets";

export const MOTION_G = 9.80665;
const INTERNAL_HZ = 1000;
const DEG = Math.PI / 180;
const zero = () => [0, 0, 0];
const clamp = u => Math.max(0, Math.min(1, u));
const smooth = u => { u = clamp(u); return u ** 3 * (10 + u * (-15 + 6 * u)); };
const slope = u => u > 0 && u < 1 ? 30 * u * u * (1 - u) ** 2 : 0;
const curvature = u => u > 0 && u < 1 ? 60 * u * (1 - u) * (1 - 2 * u) : 0;
const primitive = u => u <= 0 ? 0 : u >= 1 ? u - 0.5
    : 2.5 * u ** 4 - 3 * u ** 5 + u ** 6;

function legState(t, leg) {
    const u = (t - leg.start) / leg.duration;
    const d = leg.to.map((x, i) => x - leg.from[i]);
    return {
        p: leg.from.map((x, i) => x + d[i] * smooth(u)),
        v: d.map(x => x * slope(u) / leg.duration),
        a: d.map(x => x * curvature(u) / leg.duration ** 2),
    };
}

function waypointMotion(p, duration, drone) {
    const rng = makeStream(p.pathSeed);
    const legs = [];
    let start = 2, from = [0, 0, p.startAGL];
    while (start < duration - 2) {
        const angle = rng.uniform() * 2 * Math.PI;
        const r = drone ? 6 + 3 * rng.uniform() : 350 + 100 * rng.uniform();
        const to = [r * Math.cos(angle), r * Math.sin(angle),
            p.startAGL + (rng.uniform() - 0.5) * (drone ? 8 : 200)];
        const distance = Math.hypot(...to.map((x, i) => x - from[i]));
        const seconds = drone
            ? Math.max(1.875 * distance / p.maxSpeedMS,
                Math.sqrt((10 / Math.sqrt(3)) * distance / (p.maxAccelerationG * MOTION_G)), 0.3)
            : 0.5 + rng.uniform() * 0.5;
        if (start + seconds > duration - 2) break;
        legs.push({start, duration: seconds, from, to});
        from = to;
        start += seconds + (drone ? 0.15 : 0.1 + rng.uniform() * 0.35);
    }
    return {state(t) {
        const leg = legs.find(l => t <= l.start + l.duration) ?? legs[legs.length - 1];
        return legState(t, leg);
    }, windows: legs.map(l => ({startSeconds: l.start, endSeconds: l.start + l.duration})),
    details: {waypoints: legs, horizontalDiameterBoundM: drone ? 18 : 900,
        spatialDiameterBoundM: drone ? Math.hypot(18, 8) : Math.hypot(900, 200)}};
}

function turnMotion(p) {
    const turn = p.turnDeg * DEG;
    const seconds = p.transitionSeconds ?? 1.875 * turn * p.speedMS
        / (MOTION_G * Math.sqrt(p.peakLoadG ** 2 - 1));
    return {state(t) {
        const u = (t - p.onsetSeconds) / seconds;
        const theta = turn * smooth(u), rate = turn * slope(u) / seconds;
        return {v: [p.speedMS * Math.cos(theta), p.speedMS * Math.sin(theta), 0],
            a: [-p.speedMS * rate * Math.sin(theta), p.speedMS * rate * Math.cos(theta), 0]};
    }, windows: [{startSeconds: p.onsetSeconds, endSeconds: p.onsetSeconds + seconds}],
    details: {transitionSeconds: seconds, turnDeg: p.turnDeg}};
}

function loopMotion(p, half) {
    const end = p.onsetSeconds + (half ? Math.PI : 2 * Math.PI) * p.radiusM / p.speedMS;
    const x0 = p.speedMS * p.onsetSeconds;
    return {state(t) {
        if (t < p.onsetSeconds) return {p: [p.speedMS * t, 0, p.startAGL], v: [p.speedMS, 0, 0], a: zero()};
        if (t > end) return {
            p: [x0 + (half ? -1 : 1) * p.speedMS * (t - end), 0, p.startAGL + (half ? 2 * p.radiusM : 0)],
            v: [half ? -p.speedMS : p.speedMS, 0, 0], a: zero(),
        };
        const angle = (t - p.onsetSeconds) * p.speedMS / p.radiusM;
        return {p: [x0 + p.radiusM * Math.sin(angle), 0, p.startAGL + p.radiusM * (1 - Math.cos(angle))],
            v: [p.speedMS * Math.cos(angle), 0, p.speedMS * Math.sin(angle)],
            a: [-(p.speedMS ** 2) / p.radiusM * Math.sin(angle), 0, p.speedMS ** 2 / p.radiusM * Math.cos(angle)]};
    }, windows: [{startSeconds: p.onsetSeconds, endSeconds: end}],
    details: {radiusM: p.radiusM, angleDeg: half ? 180 : 360,
        note: half ? "Returns along the same ground line, 2 radii higher; not an exact 3D retrace."
            : "Complete vertical circle at constant speed. Velocity is continuous; acceleration steps at entry and exit."}};
}

function motionFor(kind, p, duration) {
    switch (kind) {
        case "agile-drone": return waypointMotion(p, duration, true);
        case "ping-pong": return waypointMotion(p, duration, false);
        case "fast-aircraft": case "high-g-turn": case "sharp-turn": return turnMotion(p);
        case "hypersonic": return {state(t) {
            const u = (t - p.onsetSeconds) / p.transitionSeconds;
            const active = u > 0 && u < 1;
            const angle = active ? -p.pitchDeg * DEG * (1 - Math.cos(2 * Math.PI * u)) / 2 : 0;
            const rate = active ? -p.pitchDeg * DEG * Math.PI * Math.sin(2 * Math.PI * u) / p.transitionSeconds : 0;
            return {v: [p.speedMS * Math.cos(angle), 0, p.speedMS * Math.sin(angle)],
                a: [-p.speedMS * rate * Math.sin(angle), 0, p.speedMS * rate * Math.cos(angle)]};
        }, windows: [{startSeconds: p.onsetSeconds, endSeconds: p.onsetSeconds + p.transitionSeconds}],
        details: {speedMS: p.speedMS, pitchExcursionDeg: p.pitchDeg}};
        case "acceleration-braking": {
            const brake = p.onsetSeconds + p.transitionSeconds + p.holdSeconds;
            const dv = p.peakSpeedMS - p.speedMS, tau = p.transitionSeconds;
            return {state(t) {
                const u = (t - p.onsetSeconds) / tau, w = (t - brake) / tau;
                return {p: [p.speedMS * t + dv * tau * (primitive(u) - primitive(w)), 0, p.startAGL],
                    v: [p.speedMS + dv * (smooth(u) - smooth(w)), 0, 0],
                    a: [dv * (slope(u) - slope(w)) / tau, 0, 0]};
            }, windows: [{startSeconds: p.onsetSeconds, endSeconds: p.onsetSeconds + tau, phase: "accelerate"},
                {startSeconds: brake, endSeconds: brake + tau, phase: "brake"}],
            details: {baselineSpeedMS: p.speedMS, peakSpeedMS: p.peakSpeedMS, transitionSeconds: tau}};
        }
        case "vertical-drop": return {
            state: t => legState(t, {start: p.onsetSeconds, duration: p.transitionSeconds,
                from: [0, 0, p.startAGL], to: [0, 0, p.startAGL - p.dropM]}),
            windows: [{startSeconds: p.onsetSeconds, endSeconds: p.onsetSeconds + p.transitionSeconds}],
            details: {dropM: p.dropM, dropFeet: p.dropM / 0.3048, transitionSeconds: p.transitionSeconds,
                endpointVelocityMS: 0},
        };
        case "vertical-loop": return loopMotion(p, false);
        case "j-hook": return loopMotion(p, true);
        case "transmedium": {
            const legs = [
                {start: 4, duration: 1, from: [0, 0, 100], to: [0, 0, -100]},
                {start: 5, duration: 6, from: [0, 0, -100], to: [1000, 0, -100]},
                {start: 11, duration: 1, from: [1000, 0, -100], to: [1000, 0, 100]},
            ];
            return {state(t) { return legState(t, legs.find(l => t <= l.start + l.duration) ?? legs[2]); },
                windows: legs.map((l, i) => ({startSeconds: l.start, endSeconds: l.start + l.duration,
                    phase: ["water-entry", "submerged-transit", "water-exit"][i]})),
                details: {surfaceAltitudeAGL: 0, waterEntrySeconds: 4.5, waterExitSeconds: 11.5,
                    submergedDepthM: 100, underwaterDistanceM: 1000,
                    note: "Synthetic prescribed motion; no hydrodynamic model. Submerged bearings are unobserved."}};
        }
        default: throw new Error(`motion-v1: unknown motion ${kind}`);
    }
}

// Long coverage clips retain the original maneuver, then remove residual
// descent/climb at the same acceleration limit. In particular, extrapolating a
// hypersonic -5 degree descent to 300 s would pass through the ground.
function fullCoverageMotion(motion, p) {
    const start = p.fullCoverage.recoveryStartSeconds;
    if (!p.extremeClass) return motion;
    const initial = motion.state(start), v0 = initial.v;
    if (Math.abs(v0[2]) < 1e-8) return motion;
    const hypersonic = p.extremeClass === "hypersonic";
    const speed = Math.hypot(...v0), pitch = Math.asin(v0[2] / speed);
    const heading = Math.atan2(v0[1], v0[0]);
    const seconds = 1.875 * (hypersonic ? Math.abs(pitch) * speed : Math.abs(v0[2]))
        / (p.accelerationG * MOTION_G);
    return {...motion,
        windows: [...motion.windows, {startSeconds: start, endSeconds: start + seconds, phase: "extended-level-out"}],
        details: {...motion.details, longClipRecovery: {startSeconds: start, endSeconds: start + seconds,
            policy: hypersonic ? "Level out at constant speed within the inertial-g limit."
                : "Remove vertical velocity within the inertial-g limit; retain horizontal velocity."}},
        state(t) {
            if (t <= start) return motion.state(t);
            const u = (t - start) / seconds;
            if (!hypersonic) return {v: [v0[0], v0[1], v0[2] * (1 - smooth(u))],
                a: [0, 0, -v0[2] * slope(u) / seconds]};
            const angle = pitch * (1 - smooth(u)), rate = -pitch * slope(u) / seconds;
            const c = Math.cos, s = Math.sin;
            return {v: [speed * c(angle) * c(heading), speed * c(angle) * s(heading), speed * s(angle)],
                a: [-speed * s(angle) * rate * c(heading), -speed * s(angle) * rate * s(heading), speed * c(angle) * rate]};
        },
    };
}

function fullCoverageApproach(motion, p) {
    const initial = motion.state(0);
    if (p.extremeClass !== "hypersonic" || Math.abs(initial.v[2]) < 1e-8) return motion;
    const speed = Math.hypot(...initial.v), pitch = Math.asin(initial.v[2] / speed);
    const heading = Math.atan2(initial.v[1], initial.v[0]);
    const steps = Math.ceil(1.875 * Math.abs(pitch) * speed / (p.accelerationG * MOTION_G) * INTERNAL_HZ);
    const seconds = steps / INTERNAL_HZ;
    function entryState(t) {
        const u = (t + seconds) / seconds, angle = pitch * smooth(u), rate = pitch * slope(u) / seconds;
        const c = Math.cos, s = Math.sin;
        return {v: [speed * c(angle) * c(heading), speed * c(angle) * s(heading), speed * s(angle)],
            a: [-speed * s(angle) * rate * c(heading), -speed * s(angle) * rate * s(heading), speed * c(angle) * rate]};
    }
    const origin = initial.p ?? [0, 0, p.startAGL], entryPosition = [...origin];
    for (let i = 0; i < steps; i++) {
        const v = entryState((i + 0.5) / INTERNAL_HZ - seconds).v;
        for (let j = 0; j < 3; j++) entryPosition[j] -= v[j] / INTERNAL_HZ;
    }
    const approachV = entryState(-seconds).v;
    return {...motion, windows: [{startSeconds: -seconds, endSeconds: 0, phase: "extended-descent-entry"}, ...motion.windows],
        details: {...motion.details, longClipApproach: {startSeconds: -seconds, endSeconds: 0,
            policy: "Level approach with a smooth descent entry at constant speed within the inertial-g limit."}},
        state(t) {
            if (t >= 0) return motion.state(t);
            if (t > -seconds) return entryState(t);
            return {p: entryPosition.map((x, j) => x + approachV[j] * (t + seconds)), v: approachV, a: zero()};
        }};
}

export function motionV1CoveragePlan(spec, originalDuration, masterDurationSeconds = 300) {
    const p = spec.parameters;
    const motion = p.extremeClass ? buildExtremeV1Motion(p) : motionFor(spec.kind, p, masterDurationSeconds);
    const first = motion.windows[0], last = motion.windows[motion.windows.length - 1];
    const middle = (first.startSeconds + last.endSeconds) / 2;
    // Select an active phase near the middle, so a short clip contains a change
    // instead of spending its entire duration on a long intervening straight.
    // Water entry is the informative observable transition. Centering on the
    // submerged leg leaves fewer than ten consecutive visible samples in the
    // 20 s / 1 Hz crop, which the BOT importer cannot analyze.
    const selected = spec.kind === "transmedium" ? first : motion.windows.reduce((best, w) =>
        Math.abs((w.startSeconds + w.endSeconds) / 2 - middle)
            < Math.abs((best.startSeconds + best.endSeconds) / 2 - middle) ? w : best);
    const representativeSeconds = Math.round((selected.startSeconds + selected.endSeconds) * 500) / 1000;
    return {masterDurationSeconds, representativeSeconds,
        motionShiftSeconds: Math.round((masterDurationSeconds / 2 - representativeSeconds) * 1000) / 1000,
        recoveryStartSeconds: originalDuration,
        representativePhase: selected.phase ?? spec.kind};
}

// One master is retained at a time. Batch generation visits all lengths/rates
// of a target together, avoiding repeated 1000 Hz integration or unbounded caches.
let coverageCache;
function coverageMaster(spec) {
    const p = spec.parameters, {clipStartSeconds, ...plan} = p.fullCoverage;
    const key = JSON.stringify({kind: spec.kind, parameters: {...p, fullCoverage: plan}});
    if (coverageCache?.key === key) return coverageCache;
    const base = p.extremeClass ? buildExtremeV1Motion(p) : motionFor(spec.kind, p, plan.masterDurationSeconds);
    const motion = fullCoverageApproach(fullCoverageMotion(base, p), p);
    const steps = plan.masterDurationSeconds * INTERNAL_HZ;
    const position = new Float64Array((steps + 1) * 3);
    const speed = new Float64Array(steps + 1), inertial = new Float64Array(steps + 1);
    const specific = new Float64Array(steps + 1), distance = new Float64Array(steps + 1);
    const shiftSteps = Math.round(plan.motionShiftSeconds * INTERNAL_HZ);
    const first = motion.state(-shiftSteps / INTERNAL_HZ);
    let integrated = first.p ?? first.v.map((v, j) => v * -shiftSteps / INTERNAL_HZ + (j === 2 ? p.startAGL : 0));
    for (let i = 0; i <= steps; i++) {
        const state = motion.state((i - shiftSteps) / INTERNAL_HZ);
        const mid = i ? motion.state((i - shiftSteps - 0.5) / INTERNAL_HZ) : state;
        if (state.p) integrated = state.p;
        else if (i) integrated = integrated.map((x, j) => x + mid.v[j] / INTERNAL_HZ);
        position.set(integrated, i * 3);
        speed[i] = Math.hypot(...state.v);
        inertial[i] = Math.hypot(...state.a) / MOTION_G;
        specific[i] = Math.hypot(state.a[0], state.a[1], state.a[2] + MOTION_G) / MOTION_G;
        if (i) distance[i] = distance[i - 1] + Math.hypot(...mid.v) / INTERNAL_HZ;
    }
    // Place the representative point over the local origin without changing
    // velocity, altitude, or any spacing between samples.
    const centerIndex = steps / 2 * 3, x = position[centerIndex], y = position[centerIndex + 1];
    let altitudeOffsetM = 0;
    if (plan.altitudePolicy === "prefer-below-platform"
        && ["jet-drone", "fast-aircraft"].includes(p.extremeClass)) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i <= steps; i++) {
            min = Math.min(min, position[i * 3 + 2]); max = Math.max(max, position[i * 3 + 2]);
        }
        // Prefer a 3000 m baseline and a 6000 m ceiling, but never translate
        // a large vertical maneuver below the 1000 m ground-clearance floor.
        altitudeOffsetM = Math.max(1000 - min, Math.min(3000 - p.startAGL, 6000 - max));
    }
    for (let i = 0; i <= steps; i++) {
        position[i * 3] -= x; position[i * 3 + 1] -= y; position[i * 3 + 2] += altitudeOffsetM;
    }
    coverageCache = {key, plan, motion, position, altitudeOffsetM, speed, inertial, specific, distance, metrics: new Map()};
    return coverageCache;
}

function cropCoverageTruth(spec, {n, fps}) {
    const p = spec.parameters, plan = p.fullCoverage, duration = (n - 1) / fps;
    const start = plan.clipStartSeconds * INTERNAL_HZ, end = start + duration * INTERNAL_HZ;
    if (!Number.isInteger(start) || start < 0 || end > plan.masterDurationSeconds * INTERNAL_HZ) {
        throw new Error("motion-v1: crop outside master timeline");
    }
    const master = coverageMaster(spec), positionENU = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const index = (start + f * INTERNAL_HZ / fps) * 3;
        positionENU.set(master.position.subarray(index, index + 3), f * 3);
    }
    const metricKey = `${start}:${end}`;
    let metrics = master.metrics.get(metricKey);
    if (!metrics) {
        metrics = {peakSpeedMS: 0, peakInertialAccelerationG: 0, peakSpecificForceG: 0,
            minAltitudeAGL: Infinity, maxAltitudeAGL: -Infinity, maxHorizontalRadiusM: 0,
            pathLengthM: master.distance[end] - master.distance[start], evaluationHz: INTERNAL_HZ};
        for (let i = start; i <= end; i++) {
            metrics.peakSpeedMS = Math.max(metrics.peakSpeedMS, master.speed[i]);
            metrics.peakInertialAccelerationG = Math.max(metrics.peakInertialAccelerationG, master.inertial[i]);
            metrics.peakSpecificForceG = Math.max(metrics.peakSpecificForceG, master.specific[i]);
            metrics.minAltitudeAGL = Math.min(metrics.minAltitudeAGL, master.position[i * 3 + 2]);
            metrics.maxAltitudeAGL = Math.max(metrics.maxAltitudeAGL, master.position[i * 3 + 2]);
            metrics.maxHorizontalRadiusM = Math.max(metrics.maxHorizontalRadiusM,
                Math.hypot(master.position[i * 3], master.position[i * 3 + 1]));
        }
        master.metrics.set(metricKey, metrics);
    }
    const events = master.motion.windows.map((w, i) => {
        const startSeconds = w.startSeconds + plan.motionShiftSeconds - plan.clipStartSeconds;
        const endSeconds = w.endSeconds + plan.motionShiftSeconds - plan.clipStartSeconds;
        return {...w, id: `${spec.kind}-${i + 1}`, kind: w.phase ?? spec.kind, anomalous: p.anomalous,
            startSeconds, onsetSeconds: startSeconds, endSeconds,
            startFrame: Math.max(0, Math.ceil(startSeconds * fps)), endFrame: Math.min(n - 1, Math.floor(endSeconds * fps)),
            observedStartSeconds: Math.max(0, startSeconds), observedEndSeconds: Math.min(duration, endSeconds),
            completeInClip: startSeconds >= 0 && endSeconds <= duration};
    }).filter(e => e.endSeconds > 0 && e.startSeconds < duration);
    return {target: {kind: "track", family: p.anomalous ? "hypothetical-anomaly" : "aviation-extreme",
        positionENU, valid: new Uint8Array(n).fill(1), profile: {
            anomalous: p.anomalous, motion: spec.kind, details: master.motion.details, metrics,
            fullCoverage: {...plan, clipEndSeconds: plan.clipStartSeconds + duration,
                altitudeOffsetM: master.altitudeOffsetM,
                detailsTimeBasis: "Original motion seconds; add motionShiftSeconds and subtract clipStartSeconds for clip time."},
            ...(p.extremeClass ? {extremeClass: p.extremeClass, envelope: p.envelope} : {}),
            accelerationDefinition: "Inertial acceleration = |dV/dt| / g; specific force = |dV/dt - gravity| / g.",
            model: "Centered crops of one prescribed flat-plane ENU trajectory; not an aerodynamic or curved-Earth simulation.",
        }}, events};
}

export function generateMotionV1Truth(spec, {n, fps}) {
    if (!Number.isInteger(fps) || fps <= 0 || INTERNAL_HZ % fps !== 0) {
        throw new Error("motion-v1: export Hz must be a positive integer divisor of 1000");
    }
    if (spec.parameters.fullCoverage) return cropCoverageTruth(spec, {n, fps});
    const p = spec.parameters, duration = (n - 1) / fps;
    const motion = p.extremeClass ? buildExtremeV1Motion(p) : motionFor(spec.kind, p, duration);
    const stride = INTERNAL_HZ / fps, steps = (n - 1) * stride;
    const positionENU = new Float64Array(n * 3);
    let integrated = [0, 0, p.startAGL];
    const metrics = {peakSpeedMS: 0, peakInertialAccelerationG: 0, peakSpecificForceG: 0,
        minAltitudeAGL: Infinity, maxAltitudeAGL: -Infinity, maxHorizontalRadiusM: 0,
        pathLengthM: 0, evaluationHz: INTERNAL_HZ};
    for (let i = 0; i <= steps; i++) {
        const state = motion.state(i / INTERNAL_HZ);
        if (!state.p && i > 0) {
            const mid = motion.state((i - 0.5) / INTERNAL_HZ);
            integrated = integrated.map((x, j) => x + mid.v[j] / INTERNAL_HZ);
        }
        const pos = state.p ?? integrated;
        if (i % stride === 0) positionENU.set(pos, (i / stride) * 3);
        const speed = Math.hypot(...state.v);
        metrics.peakSpeedMS = Math.max(metrics.peakSpeedMS, speed);
        metrics.peakInertialAccelerationG = Math.max(metrics.peakInertialAccelerationG, Math.hypot(...state.a) / MOTION_G);
        metrics.peakSpecificForceG = Math.max(metrics.peakSpecificForceG,
            Math.hypot(state.a[0], state.a[1], state.a[2] + MOTION_G) / MOTION_G);
        metrics.minAltitudeAGL = Math.min(metrics.minAltitudeAGL, pos[2]);
        metrics.maxAltitudeAGL = Math.max(metrics.maxAltitudeAGL, pos[2]);
        metrics.maxHorizontalRadiusM = Math.max(metrics.maxHorizontalRadiusM, Math.hypot(pos[0], pos[1]));
        if (i > 0) metrics.pathLengthM += Math.hypot(...motion.state((i - 0.5) / INTERNAL_HZ).v) / INTERNAL_HZ;
    }
    const events = motion.windows.map((w, i) => ({...w, onsetSeconds: w.startSeconds, id: `${spec.kind}-${i + 1}`,
        kind: w.phase ?? spec.kind, anomalous: p.anomalous,
        startFrame: Math.ceil(w.startSeconds * fps), endFrame: Math.floor(w.endSeconds * fps),
        completeInClip: w.startSeconds >= 0 && w.endSeconds <= duration}));
    if (!events.length || events.some(e => !e.completeInClip)) {
        throw new Error(`motion-v1: ${spec.kind} needs a clip containing its complete maneuver`);
    }
    return {target: {kind: "track", family: p.anomalous ? "hypothetical-anomaly" : "aviation-extreme",
        positionENU, valid: new Uint8Array(n).fill(1), profile: {
            anomalous: p.anomalous, motion: spec.kind, details: motion.details, metrics,
            ...(p.extremeClass ? {extremeClass: p.extremeClass, envelope: p.envelope} : {}),
            accelerationDefinition: "Inertial acceleration = |dV/dt| / g; specific force = |dV/dt - gravity| / g, gravity = [0,0,-9.80665] m/s².",
            model: "Prescribed kinematics in the existing flat-plane ENU frame; not a vehicle, propulsion, or atmospheric simulation.",
        }}, events};
}
