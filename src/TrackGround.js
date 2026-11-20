import {NodeMan} from "./Globals";
import {getVisiblePointBelow} from "./threeExt";

// Ground-locked tracks use a retained surface, independent of either view's LOD.
export function trackGroundCache() {
    if (NodeMan.get("TerrainModel", false)?.group?.visible !== false) return null;
    return NodeMan.get("buildings3DTiles", false)?.trackGround ?? null;
}

export function getTrackGroundPoint(position, lock) {
    return trackGroundCache()?.pointBelow(position, lock) ?? getVisiblePointBelow(position);
}
