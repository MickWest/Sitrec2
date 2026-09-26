export function registerVehicleSpinners(parts) {
    for (const part of parts) {
        const axis = part.userData.spinAxis ?? "z";
        part.userData.vehicleSpin = {axis, speed:part.userData.spinSpeed ?? 18,
            direction:part.userData.spinDirection ?? 1, rest:part.rotation[axis]};
    }
}

export function collectVehicleSpinners(root) {
    const parts = [];
    root.traverse(part => {
        const s = part.userData?.vehicleSpin;
        if (s && ["x", "y", "z"].includes(s.axis) && [s.speed, s.direction, s.rest].every(Number.isFinite)) parts.push(part);
    });
    return parts;
}

// The editor supplies its preview clock; Sitrec supplies simulation-frame time.
export function poseVehicleSpinners(parts, seconds, enabled) {
    for (const part of parts ?? []) {
        const s = part.userData.vehicleSpin;
        part.rotation[s.axis] = s.rest + (enabled ? seconds * s.speed * s.direction : 0);
    }
}
