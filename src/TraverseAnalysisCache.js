/**
 * Stable cache helpers for traversal analysis.
 *
 * The terrain quadtree is driven by render cameras. Its revision, active tile
 * count, and tile keys therefore describe what is currently on screen, not an
 * analysis input. Keep only user/model configuration in the main fingerprint,
 * then compare the ground samples actually consumed by the cached result.
 */

export function terrainAnalysisConfigScalars(terrain, equatorRadius, polarRadius, dataEpoch = 0) {
    if (!terrain) return ["no-terrain", equatorRadius, polarRadius, dataEpoch];
    const ui = terrain.UI || {};
    return [
        terrain.loaded ? 1 : 0,
        ui.mapType ?? "",
        ui.elevationType ?? "",
        ui.zoom ?? 0,
        ui.nTiles ?? 0,
        ui.elevationScale ?? 1,
        equatorRadius,
        polarRadius,
        dataEpoch,
    ];
}

/**
 * Compare ordered elevation dependency records.
 *
 * A render-camera move may evict a high-resolution tile and expose a coarser
 * fallback. That loss of display cache must not invalidate an analysis already
 * computed with the better sample. Equal or higher current resolution is
 * authoritative: if its effective ground height changed, the cached terrain
 * grading is stale and must be recomputed.
 */
// Adjacent terrain LODs routinely interpolate the same source surface a few
// millimetres or centimetres apart. That numerical/rendering noise is far below
// every terrain-dependent analysis threshold (40 m underground, 150 m ground
// contact), and must not turn an immediate rerun into another full fit battery.
// A decimetre remains small enough to preserve meaningful grading changes while
// absorbing the observed sub-centimetre/centimetre LOD jitter.
export const TERRAIN_DEPENDENCY_TOLERANCE_M = 0.1;

export function terrainDependencyMismatch(cached, current,
    toleranceM = TERRAIN_DEPENDENCY_TOLERANCE_M) {
    if (!Array.isArray(cached) || !Array.isArray(current) || cached.length !== current.length) {
        return {reason: "record-count", cachedCount: cached?.length, currentCount: current?.length};
    }
    for (let i = 0; i < cached.length; i++) {
        const a = cached[i], b = current[i];
        if (!a || !b || a.key !== b.key) return {reason: "record-key", index: i, cached: a, current: b};
        const az = Number.isFinite(a.tileZ) ? a.tileZ : -1;
        const bz = Number.isFinite(b.tileZ) ? b.tileZ : -1;
        // Current data are a camera-driven lower-resolution fallback. Preserve
        // the result made with the stronger cached terrain observation.
        if (bz < az) continue;
        if (!Number.isFinite(a.groundAltitudeM) || !Number.isFinite(b.groundAltitudeM)) {
            return {reason: "non-finite-height", index: i, cached: a, current: b};
        }
        if (Math.abs(a.groundAltitudeM - b.groundAltitudeM) > toleranceM) {
            return {reason: "ground-height", index: i, cached: a, current: b};
        }
    }
    return null;
}

export function terrainDependencyRecordsMatch(cached, current,
    toleranceM = TERRAIN_DEPENDENCY_TOLERANCE_M) {
    return terrainDependencyMismatch(cached, current, toleranceM) === null;
}
