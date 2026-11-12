import {KITE_REFERENCE_WIND} from "./kiteFlight.js";

export function registerVehicleSpinners(parts) {
    for (const part of parts) {
        const axis = part.userData.spinAxis ?? "z";
        part.userData.vehicleSpin = {axis, speed:part.userData.spinSpeed ?? 18,
            direction:part.userData.spinDirection ?? 1, rest:part.rotation[axis]};
    }
}

// The moving parts of a model: spinning rotors, propellers and wheels, the
// joints of kite tails that wave in the wind, and the wing joints of a bird.
export function collectVehicleSpinners(root) {
    const parts = [];
    root.traverse(part => {
        const s = part.userData?.vehicleSpin, w = part.userData?.vehicleWave, f = part.userData?.vehicleFlap;
        if (s && ["x", "y", "z"].includes(s.axis) && [s.speed, s.direction, s.rest].every(Number.isFinite)) parts.push(part);
        else if (w && Number.isFinite(w.airPerCycle) && w.airPerCycle > 0 && Array.isArray(w.rest) && Array.isArray(w.terms)) parts.push(part);
        else if (f && Number.isFinite(f.rate) && f.rate > 0 && Array.isArray(f.rest) && Array.isArray(f.home) && Array.isArray(f.terms)) parts.push(part);
    });
    return parts;
}

// The wingbeat of a bird at a time. `beats` is the number of wingbeats since the
// wings were last still, and `strength` is 1 in steady flapping and 0 in a glide.
// `flap` is the record on a wing joint. With `burst` = [wingbeats, glide seconds]
// the bird flaps that many times and then glides, again and again.
export function wingbeatAt(flap, seconds) {
    if (!flap.burst) return {beats: seconds * flap.rate, strength: 1};
    const [count, glide] = flap.burst, flapping = count / flap.rate, period = flapping + glide;
    const time = ((seconds % period) + period) % period;
    if (time >= flapping) return {beats: 0, strength: 0};
    // The wings leave the glide position, and go back to it, in half a wingbeat.
    const ramp = Math.min(1, time * flap.rate * 2, (flapping - time) * flap.rate * 2);
    return {beats: time * flap.rate, strength: ramp * ramp * (3 - 2 * ramp)};
}

// The editor supplies its preview clock; Sitrec supplies simulation-frame time.
// `flow` is the wind on a kite: {air, wind}, where air is the metres of wind
// that have passed the kite and wind is its speed in m/s. Without it the tails
// move as in a steady reference wind. `flow.beats` holds a bird at one moment
// of its wingbeat (0 = wings up, 0.5 = wings down), for a still picture.
export function poseVehicleSpinners(parts, seconds, enabled, flow) {
    const wind = flow?.wind ?? KITE_REFERENCE_WIND, air = flow?.air ?? seconds * KITE_REFERENCE_WIND;
    for (const part of parts ?? []) {
        const s = part.userData.vehicleSpin;
        if (s) {part.rotation[s.axis] = s.rest + (enabled ? seconds * s.speed * s.direction : 0); continue;}
        const f = part.userData.vehicleFlap;
        if (f) {
            // Each term is [channel, size, lag, offset]. Channels 0 to 2 are the rotation about
            // x, y and z, and 3 to 5 are the position. With the animation off, the wings are in the glide position.
            const angles = [...f.rest], place = [...f.home];
            if (enabled) {
                const {beats, strength} = Number.isFinite(flow?.beats) ? {beats: flow.beats, strength: 1} : wingbeatAt(f, seconds);
                for (const [channel, size, lag, offset] of f.terms) {
                    const value = strength * (size * Math.cos(Math.PI * 2 * beats - lag) + offset);
                    if (channel < 3) angles[channel] += value; else place[channel - 3] += value;
                }
            }
            part.rotation.set(angles[0], angles[1], angles[2], f.order); part.position.set(place[0], place[1], place[2]);
            continue;
        }
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
