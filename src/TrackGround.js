import {NodeMan} from "./Globals";
import {getVisiblePointBelow} from "./threeExt";
import {isAGLLockActive} from "./AltitudeLock";

// Ground-locked tracks use a retained surface, independent of either view's LOD.
export function trackGroundCache() {
    if (NodeMan.get("TerrainModel", false)?.group?.visible !== false) return null;
    return NodeMan.get("buildings3DTiles", false)?.trackGround ?? null;
}

// Road Track smooths the road only where the track ground cache exists. A saved
// Road Track over the elevation map does nothing, and its controls are hidden.
export function isRoadTrackActive(lock) {
    return !!lock?.roadTrack && isAGLLockActive(lock) && !!trackGroundCache();
}

// A consumer is a track that locks all its frames in one recalculation and
// calls beginTrackGroundPass first, so the cache can release its old columns.
export function getTrackGroundPoint(position, lock, consumer) {
    return trackGroundCache()?.pointBelow(position, lock, consumer) ?? getVisiblePointBelow(position);
}

export function beginTrackGroundPass(lock, consumer) {
    trackGroundCache()?.beginPass(lock, consumer);
}
