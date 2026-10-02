// Frame-based graph measurements. All positions are ECEF metres; callers supply
// the current unit conversions and Earth geometry so the sampling stays testable.
export function graphPosition(source, frame) {
    if (!source || typeof source.p !== "function") return null;
    try {
        if (source.validPoint && !source.validPoint(frame)) return null;
        const p = source.p(frame);
        return p && [p.x, p.y, p.z].every(Number.isFinite) ? p : null;
    } catch (e) { return null; }
}

export function graphVelocity(source, frame, {frames, fps, simSpeed = 1}) {
    const count = source?.frames > 0 ? source.frames : frames;
    // These sources are sampled on the sitch timeline. CNode.fps defaults to
    // 30 even in other-rate videos, so it must not supply the interval here.
    const rate = fps / simSpeed;
    if (count < 2 || !Number.isFinite(rate) || rate <= 0) return null;
    const end = Math.max(1, Math.min(Math.floor(frame), count - 1));
    const p0 = graphPosition(source, end - 1);
    const p1 = graphPosition(source, end);
    if (!p0 || !p1) return null;
    return {p0, p1, velocity: p1.clone().sub(p0).multiplyScalar(rate), rate};
}

export function graphGroundSpeed(source, frame, context, localUp) {
    const sample = graphVelocity(source, frame, context);
    if (!sample) return NaN;
    const up = localUp(sample.p1);
    return sample.velocity.sub(up.clone().multiplyScalar(sample.velocity.dot(up))).length();
}

export function graphVerticalSpeed(source, frame, context, altitude) {
    const sample = graphVelocity(source, frame, context);
    return sample ? (altitude(sample.p1) - altitude(sample.p0)) * sample.rate : NaN;
}

export function graphSlantRange(source, observer, frame) {
    const p = graphPosition(source, frame);
    const camera = graphPosition(observer, frame);
    return p && camera ? p.distanceTo(camera) : NaN;
}

export function graphHeading(source, frame, context, localUp, localNorth, localEast) {
    const sample = graphVelocity(source, frame, context);
    if (!sample) return NaN;
    const up = localUp(sample.p1);
    const horizontal = sample.velocity.sub(up.clone().multiplyScalar(sample.velocity.dot(up)));
    if (horizontal.lengthSq() < 1e-12) return NaN;
    return Math.atan2(horizontal.dot(localEast(sample.p1)), horizontal.dot(localNorth(sample.p1))) * 180 / Math.PI;
}

// Magnitude of the second position derivative, in g; no gravity offset.
export function graphAcceleration(source, frame, {frames, fps, simSpeed = 1}) {
    const count = source?.frames > 0 ? source.frames : frames;
    const rate = fps / simSpeed;
    if (count < 3 || !Number.isFinite(rate) || rate <= 0) return NaN;
    const start = Math.max(0, Math.min(Math.floor(frame) - 1, count - 3));
    const p0 = graphPosition(source, start);
    const p1 = graphPosition(source, start + 1);
    const p2 = graphPosition(source, start + 2);
    if (!p0 || !p1 || !p2) return NaN;
    return p2.clone().sub(p1.clone().multiplyScalar(2)).add(p0).length() * rate * rate / 9.81;
}
