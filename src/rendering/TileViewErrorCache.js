// Tile bounds and geometric error are fixed when a tile is preprocessed. Tile
// arrivals change traversal/visibility, but not the answer for existing bounds
// viewed through the same cameras. Keep this cache per TilesRenderer (per view).
export class TileViewErrorCache {
    constructor() {
        this.entries = new WeakMap();
        this.version = 0;
        this.previous = [];
        this.current = [];
    }

    begin(renderer, lift, warped = false) {
        const key = this.current;
        key.length = 0;
        key.push(...renderer.group.matrixWorld.elements, renderer.cameraInfo.length);
        for (const info of renderer.cameraInfo) {
            key.push(info.isOrthographic, info.sseDenominator, info.pixelSize,
                info.position.x, info.position.y, info.position.z);
            for (const plane of info.frustum.planes) {
                key.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
            }
        }
        key.push(!!lift);
        if (lift) {
            key.push(lift.k, lift.obsAlt, lift.R, lift.maxBendRad, lift.scaleHeightM, lift.maxLiftM,
                lift.observer.x, lift.observer.y, lift.observer.z,
                lift.zenith.x, lift.zenith.y, lift.zenith.z);
        }
        // The flat projection has mutable settings outside cameraInfo. Keep its
        // existing calculation until those settings have an explicit revision.
        if (warped || key.length !== this.previous.length
            || key.some((value, i) => value !== this.previous[i])) this.version++;
        this.current = this.previous;
        this.previous = key;
    }

    read(tile, target) {
        const entry = this.entries.get(tile);
        if (!entry || entry.version !== this.version
            || entry.bounds !== tile.engineData.boundingVolume
            || entry.geometricError !== tile.geometricError) return false;
        target.inView = entry.inView;
        target.error = entry.error;
        target.distanceFromCamera = entry.distanceFromCamera;
        return true;
    }

    write(tile, target) {
        let entry = this.entries.get(tile);
        if (!entry) this.entries.set(tile, entry = {});
        entry.version = this.version;
        entry.bounds = tile.engineData.boundingVolume;
        entry.geometricError = tile.geometricError;
        entry.inView = target.inView;
        entry.error = target.error;
        entry.distanceFromCamera = target.distanceFromCamera;
    }
}
