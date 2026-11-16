import {Globals} from "./Globals";

// Test the finite sight line, not an infinite ray: the globe behind a near-side
// ground point must not hide it. Coordinates are ECEF, with the polar axis at Z.
export function isPointOccludedByGlobe(observer, point,
    equatorRadius = Globals.equatorRadius, polarRadius = Globals.polarRadius) {
    let ox = observer.x / equatorRadius, oy = observer.y / equatorRadius, oz = observer.z / polarRadius;
    let px = point.x / equatorRadius, py = point.y / equatorRadius, pz = point.z / polarRadius;
    const observerRadius = Math.hypot(ox, oy, oz);
    const pointRadius = Math.hypot(px, py, pz);
    if (!(observerRadius > 0) || !(pointRadius > 0)
        || !Number.isFinite(observerRadius) || !Number.isFinite(pointRadius)) return false;

    // Sea level/terrain can be below the reference ellipsoid. Move submerged
    // endpoints to its surface so nearby objects remain usable from ground level.
    if (observerRadius < 1) { ox /= observerRadius; oy /= observerRadius; oz /= observerRadius; }
    if (pointRadius < 1) { px /= pointRadius; py /= pointRadius; pz /= pointRadius; }
    const dx = px - ox, dy = py - oy, dz = pz - oz;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if (lengthSq === 0) return false;
    const t = Math.max(0, Math.min(1, -(ox * dx + oy * dy + oz * dz) / lengthSq));
    const x = ox + t * dx, y = oy + t * dy, z = oz + t * dz;
    // A tangent or endpoint touching the surface is visible; tolerate roundoff.
    return x * x + y * y + z * z < 1 - 1e-9;
}
