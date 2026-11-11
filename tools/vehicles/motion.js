import {KITE_REFERENCE_WIND} from "./kiteFlight.js";

export function registerVehicleSpinners(parts) {
    for (const part of parts) {
        const axis = part.userData.spinAxis ?? "z";
        part.userData.vehicleSpin = {axis, speed:part.userData.spinSpeed ?? 18,
            direction:part.userData.spinDirection ?? 1, rest:part.rotation[axis]};
    }
}

// The moving parts of a model: spinning rotors, propellers and wheels, and the
// joints of kite tails that wave in the wind.
export function collectVehicleSpinners(root) {
    const parts = [];
    root.traverse(part => {
        const s = part.userData?.vehicleSpin, w = part.userData?.vehicleWave;
        if (s && ["x", "y", "z"].includes(s.axis) && [s.speed, s.direction, s.rest].every(Number.isFinite)) parts.push(part);
        else if (w && Number.isFinite(w.airPerCycle) && w.airPerCycle > 0 && Array.isArray(w.rest) && Array.isArray(w.terms)) parts.push(part);
    });
    return parts;
}

// The editor supplies its preview clock; Sitrec supplies simulation-frame time.
// `flow` is the wind on a kite: {air, wind}, where air is the metres of wind
// that have passed the kite and wind is its speed in m/s. Without it the tails
// move as in a steady reference wind.
export function poseVehicleSpinners(parts, seconds, enabled, flow) {
    const wind = flow?.wind ?? KITE_REFERENCE_WIND, air = flow?.air ?? seconds * KITE_REFERENCE_WIND;
    for (const part of parts ?? []) {
        const s = part.userData.vehicleSpin;
        if (s) {part.rotation[s.axis] = s.rest + (enabled ? seconds * s.speed * s.direction : 0); continue;}
        const w = part.userData.vehicleWave, angles = [...w.rest];
        if (enabled) {
            // A tail hangs lower in a light wind: its weight is constant and its drag goes with the wind speed squared.
            if (w.droop > 0) angles[0] += w.droop - Math.min(1.5, Math.atan(Math.tan(w.droop) * Math.pow(KITE_REFERENCE_WIND / Math.max(wind, 0.1), 2)));
            const strength = Math.min(1, wind / 3);         // the motion stops in a calm
            for (const [axis, angle, lag, rate] of w.terms)
                angles[axis] += strength * angle * Math.sin(Math.PI * 2 * air * rate / w.airPerCycle - lag);
        }
        part.rotation.set(angles[0], angles[1], angles[2]);
    }
}
