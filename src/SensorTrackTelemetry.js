// Read frame-aligned metadata through position smoothers and the selected switch.
// Raw MISB data rows use record indices, so do not index those with a video frame.
export function getTrackMISBRow(track, frame) {
    const visited = new Set();
    while (track && !visited.has(track)) {
        visited.add(track);
        if (track.choice !== undefined && track.inputs?.[track.choice]) {
            track = track.inputs[track.choice];
            continue;
        }
        const row = track.v(frame)?.misbRow;
        if (row) return row;
        track = track.inputs?.source;
    }
    return null;
}

// Null and empty CSV cells are unknown, not zero degrees.
export function telemetryNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function trackFrameSpan(frame, frames) {
    const last = Math.max(0, frames - 1);
    return [Math.max(0, Math.min(last, frame - 1)), Math.max(0, Math.min(last, frame + 1))];
}

// Track and wind vectors are ECEF metres per simulation frame. Convert both
// using the same clock, including simSpeed, and retain vertical air motion.
export function trackAirVelocity(track, wind, frame, frames, fps, simSpeed = 1) {
    if (!track || !(fps > 0) || !(simSpeed > 0)) return null;
    const [a, b] = trackFrameSpan(frame, frames);
    if (a === b) return null;
    const velocity = track.p(b).clone().sub(track.p(a)).divideScalar(b - a);
    if (wind) velocity.sub(wind.getValueFrame(frame, track.p(frame)));
    velocity.multiplyScalar(fps / simSpeed);
    return [velocity.x, velocity.y, velocity.z].every(Number.isFinite) ? velocity : null;
}

// Closing speed is minus the derivative of SLANT range. Positive means closing.
// Use one-sided differences at the clip ends, and never extrapolate a track.
export function closingSpeedKnots(cameraTrack, targetTrack, frame, frames, fps, simSpeed = 1) {
    if (!cameraTrack || !targetTrack || !(fps > 0) || !(simSpeed > 0)) return null;
    const [a, b] = trackFrameSpan(frame, frames);
    if (a === b) return null;
    const range = f => cameraTrack.p(f).distanceTo(targetTrack.p(f));
    return (range(a) - range(b)) * fps / ((b - a) * simSpeed) * 3600 / 1852;
}
