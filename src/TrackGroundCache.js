import {Box3, Raycaster, Sphere, Vector3} from "three";
import {LoadRegionPlugin} from "3d-tiles-renderer/plugins";
import {Globals, markShadowCastersDirty, NodeMan, setRenderOne} from "./Globals";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {getLocalUpVector} from "./SphericalMath";
import {getPointBelow} from "./threeExt";
import {isAGLLockActive} from "./AltitudeLock";
import {EventManager} from "./CEventManager";
import {RoadProfile, sampleRoadPath} from "./RoadProfile";
import {hasRoadGeometry, originalRoadGeometry, restoreRoadGeometry, smoothRoadGeometry} from "./RoadGeometry";

function columnKey(point, digits = 7) {
    const lla = ECEFToLLAVD_radii(point);
    return `${lla.x.toFixed(digits)},${lla.y.toFixed(digits)}`;
}

// True when a frame was added or removed, or moved more than 25 cm sideways.
// A chordal or centripetal spline moves its frames sideways by millimeters
// when the ground heights below it change. That is not an edit of the path.
function pathMoved(old, points) {
    if (!old || old.length !== points.length) return true;
    const delta = new Vector3();
    return points.some((point, i) => {
        delta.subVectors(point, old[i]);
        const rise = delta.dot(getLocalUpVector(old[i]));
        return delta.lengthSq() - rise * rise > 0.25 * 0.25;
    });
}

const SPHERES_PER_BLOCK = 24;
const _tileBox = new Box3();
const _sphereBox = new Box3();

// A tile that only the corridor needs: in the route region and outside every
// camera. The library then gives it error Infinity and, from the region's
// calculateDistance, distance Infinity. A tile in a camera view keeps its
// real distance, because the library keeps the smaller of the two.
function corridorOnly(tile) {
    const traversal = tile?.traversal;
    return !!traversal && traversal.error === Infinity && traversal.distanceFromCamera === Infinity;
}

// The shared download and parse queues run the end of their sorted list first,
// and the library sorts the highest error last. That put every corridor tile
// before every tile in view. Sort the corridor-only tiles first, so they run last.
function corridorLast(priority) {
    const sorted = (a, b) => {
        const corridor = corridorOnly(a);
        if (corridor !== corridorOnly(b)) return corridor ? -1 : 1;
        return priority(a, b);
    };
    sorted.corridorOriginal = priority;
    return sorted;
}

// The library's download and parse queues, which all renderers share.
function sharedQueues(renderer) {
    return [renderer.downloadQueue, renderer.parseQueue].filter(queue => queue?.priorityCallback);
}

// The union of small path volumes, not one sphere around the whole route. A
// curved road therefore cannot force-load the landscape enclosed by its bends.
export class TrackLoadRegion {
    constructor() {
        this.mask = false; this.spheres = []; this.blocks = []; this.box = new Box3();
        // revision counts path changes. results keeps the answer for each tile volume.
        this.revision = 0; this.results = new WeakMap();
    }
    setPaths(paths) {
        this.spheres = paths.flatMap(points => sampleRoadPath(points, 20).map(p => new Sphere(p, 45)));
        // Bound each run of consecutive spheres, so that a tile is tested only
        // against the spheres of the blocks it overlaps.
        this.blocks = [];
        this.box.makeEmpty();
        for (let start = 0; start < this.spheres.length; start += SPHERES_PER_BLOCK) {
            const block = {box: new Box3(), start, end: Math.min(start + SPHERES_PER_BLOCK, this.spheres.length)};
            for (let i = start; i < block.end; i++) block.box.union(this.spheres[i].getBoundingBox(_sphereBox));
            this.blocks.push(block);
            this.box.union(block.box);
        }
        this.revision++;
    }
    // The plugin asks about every tile in each traversal of both views. A tile's
    // bounding volume does not change, so keep its answer until the paths change.
    intersectsTile(volume) {
        let result = this.results.get(volume);
        if (!result) this.results.set(volume, result = {revision: -1, value: false});
        if (result.revision !== this.revision) {
            result.revision = this.revision;
            result.value = this.testVolume(volume);
        }
        return result.value;
    }
    testVolume(volume) {
        if (!this.spheres.length) return false;
        volume.getAABB(_tileBox);
        if (!this.box.intersectsBox(_tileBox)) return false;
        for (const {box, start, end} of this.blocks) {
            if (!box.intersectsBox(_tileBox)) continue;
            for (let i = start; i < end; i++) if (volume.intersectsSphere(this.spheres[i])) return true;
        }
        return false;
    }
    // Refine right down to the available leaves, including zero-error external
    // tilesets. Region-selected leaves stay used in the renderer's LRU cache.
    calculateError() { return Infinity; }
    // Infinity, not 0, so that a corridor tile in view keeps its camera
    // distance and a corridor-only tile can be told apart (corridorOnly).
    calculateDistance() { return Infinity; }
}

export class TrackGroundCache {
    constructor(buildings) {
        this.buildings = buildings;
        this.records = new Map();
        this.region = new TrackLoadRegion();
        this.renderers = [];
        this.tiles = [];
        this.roadTiles = [];
        this.tilesDirty = true;
        this.geometryQueue = [];
        this.modified = new Set();
        // profiles: the road profiles that the meshes are smoothed with, and
        // roadLocks the tracks they belong to. smoothed: the surfaceRevision at
        // which each mesh was last queued.
        this.profiles = [];
        this.roadLocks = [];
        this.smoothed = new WeakMap();
        this.surfaceRevision = 0;
        // A road surface change that waits for an edited road's new profile.
        this.roadsChanged = false;
        this.roadSettingsPending = false;
        this.lastLoad = 0;
        this.raycaster = new Raycaster();
        this.raycaster.layers.enableAll();
        this.raycaster.firstHitOnly = false;
        this.disposed = false;
        this.onElevationChanged = () => {
            // The first elevation tiles can arrive after a track is restored.
            // Update the corridor's vertical reference only if its OWN terrain
            // changed; unrelated map LOD must not restart road processing.
            let changed = false;
            for (const record of this.records.values()) {
                const route = record.route.map(p => getPointBelow(p));
                if (!route.some((p, i) => p.distanceToSquared(record.route[i]) > 0.0001)) continue;
                record.route = route;
                record.routeKeys = new Set(route.map(p => columnKey(p)));
                for (const entry of record.samples.values()) entry.point = getPointBelow(entry.point);
                changed = true;
            }
            if (changed) {
                this.region.setPaths([...this.records.values()].map(r => r.route));
                for (const {pv} of this.renderers) pv._needsLibUpdate = true;
                this.invalidate();
            }
        };
        EventManager.addEventListener("elevationChanged", this.onElevationChanged);
    }

    attach(pv) {
        const renderer = pv.renderer;
        const plugin = new LoadRegionPlugin({regions: [this.region]});
        renderer.registerPlugin(plugin);
        // Both views share these queues, so wrap them once.
        for (const queue of sharedQueues(renderer)) {
            if (!queue.priorityCallback.corridorOriginal) queue.priorityCallback = corridorLast(queue.priorityCallback);
        }
        const load = ({tile}) => {
            if (!tile?.engineData?.boundingVolume || !this.region.intersectsTile(tile.engineData.boundingVolume)) return;
            this.invalidate();
        };
        const unload = ({scene, tile}) => {
            const removed = new Set();
            scene.traverse(mesh => { restoreRoadGeometry(mesh); this.modified.delete(mesh); removed.add(mesh); });
            this.geometryQueue = this.geometryQueue.filter(mesh => !removed.has(mesh));
            load({tile});
        };
        renderer.addEventListener("load-model", load);
        renderer.addEventListener("dispose-model", unload);
        this.renderers.push({pv, renderer, plugin, load, unload});
    }

    invalidate() {
        this.tilesDirty = true;
        this.lastLoad = performance.now();
        for (const record of this.records.values()) {
            for (const entry of record.samples.values()) { entry.pending = true; record.pending.add(entry); }
            record.profileDirty = true;
        }
        setRenderOne(true);
    }

    recordFor(lock) {
        let record = this.records.get(lock);
        if (!record) {
            // pending: the entries still to sample. passes: the columns that each
            // consumer track used in its latest recalculation. epoch: counts path
            // edits, for the columns that callers without a consumer use.
            record = {lock, samples: new Map(), pending: new Set(), passes: new Map(), epoch: 0,
                route: [], routeKeys: new Set(), path: null, profile: null, profileDirty: true};
            this.records.set(lock, record);
        }
        return record;
    }

    // A new column starts at the elevation map's height until it is sampled.
    entryAt(record, key, point) {
        let entry = record.samples.get(key);
        if (!entry) {
            const ground = getPointBelow(point);
            entry = {point: ground, value: ground, pending: true, epoch: -Infinity};
            record.samples.set(key, entry);
            record.pending.add(entry);
            setRenderOne(true);
        }
        return entry;
    }

    // A consumer track calls this before it locks all its frames to the ground.
    // Its columns from the previous recalculation are released at the next update().
    beginPass(lock, consumer) {
        const target = this.recordFor(lock);
        for (const record of this.records.values()) {
            if (record !== target && record.passes.delete(consumer)) record.prune = true;
        }
        // While Road Track answers, a smoothed track's frames move a little with the
        // road heights, and its columns are not read. Keep its last pass without Road
        // Track, so those columns keep their tile heights for when Road Track is off.
        if (lock.roadTrack && target.profile && target.passes.has(consumer)) return;
        if (target.passes.has(consumer)) target.prune = true;
        target.passes.set(consumer, new Set());
    }

    requestRoadUpdate(lock) {
        // An existing route already has the terrain samples for a settings edit.
        // updateRoutes coalesces edits, and update rebuilds the track with the new profile.
        if (!this.records.has(lock)) lock.recalculateCascade();
        this.roadSettingsPending = true;
        this.buildings.updateWhilePaused = true;
        setRenderOne(true);
    }

    pointBelow(point, lock, consumer) {
        const record = this.recordFor(lock);
        const key = columnKey(point);
        if (lock.roadTrack && record.profile) {
            const road = record.profile.pointBelow(point);
            if (road) return road;
        }
        if (consumer) {
            let keys = record.passes.get(consumer);
            if (!keys) record.passes.set(consumer, keys = new Set());
            keys.add(key);
        }
        const entry = this.entryAt(record, key, point);
        if (!consumer) {
            entry.epoch = record.epoch;
            record.anonymousUse = true;
        }
        // Preserve the query's horizontal position, rather than snapping it to
        // the centimetre-sized cache cell (which would introduce heading steps).
        const up = getLocalUpVector(point);
        return point.clone().addScaledVector(up, entry.value.clone().sub(point).dot(up));
    }

    // Release the columns that nothing uses: not on the route (Road Track reads
    // every route column), not in a live consumer's latest pass, and not used by
    // a caller without a consumer in this epoch or the previous one. The epoch
    // advances only at a path edit after such a use, so those callers' columns
    // stay while they do not recalculate.
    prune(record) {
        record.prune = false;
        for (const consumer of record.passes.keys()) {
            if (NodeMan.get(consumer.id, false) !== consumer) record.passes.delete(consumer);
        }
        const live = [record.routeKeys, ...record.passes.values()];
        for (const [key, entry] of record.samples) {
            if (entry.epoch >= record.epoch - 1 || live.some(keys => keys.has(key))) continue;
            record.samples.delete(key);
            record.pending.delete(entry);
        }
    }

    updateRoutes() {
        let changed = false;
        for (const [lock, record] of this.records) {
            if (!isAGLLockActive(lock) || NodeMan.get(lock.id, false) !== lock) {
                this.records.delete(lock); changed = true; continue;
            }
            const track = lock.groundTrack ?? lock;
            if (!track.array?.length) continue;
            const settings = `${!!lock.roadTrack}:${lock.roadSmoothing ?? 20}:${lock.roadWidth ?? 8}`;
            if (record.array === track.array && settings === record.settings) continue;
            record.array = track.array;
            const points = track.array.filter(e => e?.position).map(e => e.position);
            // Compare with the path of the last route, so that small moves
            // cannot add up without a route rebuild.
            const pathChanged = pathMoved(record.path, points);
            if (!pathChanged && settings === record.settings) continue;
            record.settings = settings;
            record.profileDirty = true;
            record.changed = true;
            if (pathChanged) {
                record.path = points.map(p => p.clone());
                record.route = sampleRoadPath(points, 2).map(p => getPointBelow(p));
                record.routeKeys = new Set(record.route.map(p => {
                    const key = columnKey(p);
                    this.entryAt(record, key, p);
                    return key;
                }));
                record.profile = null;
                // Keep the sampled columns. A kept column holds its tile height
                // while it is resampled; clearing them made a chordal track fall
                // back to the elevation map and move again, without end.
                // prune() releases the columns that are no longer used.
                if (record.anonymousUse) { record.epoch++; record.anonymousUse = false; }
                record.prune = true;
                changed = true;
            } else if (!lock.roadTrack) {
                record.profile = null;
            }
        }
        if (changed) {
            this.region.setPaths([...this.records.values()].map(r => r.route));
            for (const {pv} of this.renderers) pv._needsLibUpdate = true;
            // An edit of another track does not move a road surface, and an
            // edited road keeps its old smoothing until updateRoads() replaces
            // it. Restore the meshes here only when no road remains.
            if (![...this.records.values()].some(r => r.lock.roadTrack)) this.restoreRoads();
            this.invalidate();
        }
    }

    collectTiles() {
        this.tiles = [];
        for (const {renderer} of this.renderers) {
            renderer.forEachLoadedModel((scene, tile) => {
                if (this.region.intersectsTile(tile.engineData.boundingVolume)) {
                    // Newly loaded offscreen scenes may never have participated
                    // in a render traversal. Their mesh matrices must be current
                    // before raycasting, or the finest tile appears to have no
                    // ground and a coarse ancestor gets cached permanently.
                    scene.updateWorldMatrix(true, true, true);
                    // At tile seams the published volume can exclude a strip of
                    // the mesh. Cull ground rays against the geometry we sample.
                    const bounds = new Box3();
                    scene.traverse(mesh => {
                        const geometry = originalRoadGeometry(mesh);
                        if (!geometry?.attributes?.position) return;
                        if (!geometry.boundingBox) geometry.computeBoundingBox();
                        bounds.union(_tileBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
                    });
                    this.tiles.push({scene, tile, bounds});
                }
            });
        }
        this.tiles.sort((a, b) => a.tile.geometricError - b.tile.geometricError);
        // Road Track smooths only the tiles on screen. A tile with a loaded
        // corridor descendant is replaced by its children only when all the
        // children the library uses are loaded (REPLACE refinement with
        // loadAncestors). Until then the library shows the tile, so it is
        // smoothed too. Each renderer has its own tile objects, so each view
        // gets its own smoothed copy.
        const ancestors = new Set();
        for (const {tile} of this.tiles) {
            for (let parent = tile.parent; parent && !ancestors.has(parent); parent = parent.parent) ancestors.add(parent);
        }
        this.roadTiles = this.tiles.filter(({tile}) => !ancestors.has(tile) || tile.traversal?.allChildrenLoaded === false);
        this.tilesDirty = false;
    }

    sample(point) {
        const up = getLocalUpVector(point);
        this.raycaster.set(point.clone().addScaledVector(up, 1000), up.clone().negate());
        // Query retained meshes, independent of visibility. Prefer the finest
        // available tile, never the coarser ancestor closest to the elevation map.
        let error = Infinity, best = null, deviation = Infinity;
        for (const {scene, tile, bounds} of this.tiles) {
            if (best && tile.geometricError > error) break;
            if (!this.raycaster.ray.intersectsBox(bounds)) continue;
            const swapped = [];
            scene.traverse(mesh => {
                const original = originalRoadGeometry(mesh);
                if (original !== mesh.geometry) { swapped.push([mesh, mesh.geometry]); mesh.geometry = original; }
            });
            let hits;
            try { hits = this.raycaster.intersectObject(scene, true); }
            finally { for (const [mesh, geometry] of swapped) mesh.geometry = geometry; }
            for (const hit of hits) {
                const delta = Math.abs(hit.point.clone().sub(point).dot(up));
                if (delta > 40 || delta >= deviation) continue;
                error = tile.geometricError; best = hit.point; deviation = delta;
            }
        }
        return best?.clone() ?? point.clone();
    }

    // Smooth all road meshes again only when a road surface changed: a road was
    // added or removed, its settings changed, or its centerline heights moved.
    // A new profile with the same heights keeps the smoothed meshes. Returns
    // true when all meshes must be queued again.
    updateRoads(profileChanged) {
        const records = [...this.records.values()];
        // A road whose path was edited has no profile until its columns are
        // sampled again. Keep the current smoothing until then, so that its
        // surface does not go back to the raw tiles in between.
        if (records.some(r => r.lock.roadTrack && !r.profile && r.route.length > 1)) {
            if (profileChanged) this.roadsChanged = true;
            return false;
        }
        if (this.roadsChanged) { profileChanged = true; this.roadsChanged = false; }
        const roads = records.filter(r => r.lock.roadTrack && r.profile);
        const locks = roads.map(r => r.lock);
        this.profiles = roads.map(r => r.profile);
        if (!profileChanged && locks.length === this.roadLocks.length
            && locks.every((lock, i) => lock === this.roadLocks[i])) return false;
        if (!this.profiles.length) { this.restoreRoads(); return false; }
        // Do not restore first: smoothRoadGeometry() replaces a mesh's old
        // smoothing in one step, so the road does not go back to the raw tiles.
        this.roadLocks = locks;
        this.surfaceRevision++;
        this.geometryQueue = [];
        // The meshes of the tiles on screen are smoothed again in place.
        // Restore the others: tiles that left the corridor after a road path
        // edit, and hidden tiles that are replaced by their children.
        const shown = new Set();
        for (const {scene} of this.roadTiles) scene.traverse(mesh => shown.add(mesh));
        let restored = false;
        for (const mesh of this.modified) {
            if (shown.has(mesh)) continue;
            restoreRoadGeometry(mesh);
            this.modified.delete(mesh);
            restored = true;
        }
        if (restored) {
            markShadowCastersDirty("road surface restored");
            setRenderOne(true);
        }
        return true;
    }

    // Queue the meshes of the finest corridor tiles that the current roads have
    // not processed, for example those of a newly loaded tile.
    queueRoadMeshes() {
        if (!this.profiles.length) return;
        for (const {scene} of this.roadTiles) scene.traverse(mesh => {
            if (!mesh.isMesh || this.smoothed.get(mesh) === this.surfaceRevision) return;
            this.smoothed.set(mesh, this.surfaceRevision);
            this.geometryQueue.push(mesh);
        });
    }

    restoreRoads() {
        if (this.modified.size) {
            markShadowCastersDirty("road surface restored");
            setRenderOne(true);
        }
        for (const mesh of this.modified) restoreRoadGeometry(mesh);
        this.modified.clear();
        this.geometryQueue = [];
        // Nothing is smoothed now, so the next road profiles queue every mesh.
        this.profiles = [];
        this.roadLocks = [];
        this.surfaceRevision++;
    }

    hasPendingWork() {
        return this.roadSettingsPending || this.geometryQueue.length > 0 || [...this.records.values()].some(record =>
            record.scheduled || (record.profileDirty && record.route.length > 1) || record.pending.size > 0);
    }

    update() {
        this.roadSettingsPending = false;
        if (NodeMan.get("TerrainModel", false)?.group?.visible !== false) {
            if (this.records.size) {
                this.records.clear();
                this.region.setPaths([]);
                this.restoreRoads();
                for (const {pv} of this.renderers) pv._needsLibUpdate = true;
            }
            return false;
        }
        this.updateRoutes();
        if (!this.records.size) return false;
        for (const record of this.records.values()) if (record.prune) this.prune(record);
        // Let a burst of arriving corridor tiles finish before sampling. Camera
        // visibility events do not invalidate this cache or restart this timer.
        if (performance.now() - this.lastLoad < 300) return true;
        let queueRoads = false;
        if (this.tilesDirty) { this.collectTiles(); queueRoads = true; }
        const deadline = performance.now() + 6;
        let pending = false, profilesUpdated = false, profileChanged = false;
        for (const record of this.records.values()) {
            for (const entry of record.pending) {
                if (performance.now() > deadline) { pending = true; break; }
                const value = this.sample(entry.point);
                if (value.distanceToSquared(entry.value) > 0.000001) record.changed = true;
                entry.value = value; entry.pending = false;
                record.pending.delete(entry);
            }
            if (record.pending.size) { pending = true; continue; }
            if (record.profileDirty && record.route.length > 1) {
                if (record.lock.roadTrack) {
                    const points = record.route.map(p => record.samples.get(columnKey(p)).value);
                    const profile = new RoadProfile(points, record.lock.roadSmoothing ?? 20, record.lock.roadWidth ?? 8);
                    const old = record.profile;
                    record.profile = profile;
                    const moved = !old || points.some(p => old.pointBelow(p)?.distanceToSquared(profile.pointBelow(p)) > 0.000001);
                    if (moved) record.changed = true;
                    // Road Width changes the surface but not the centerline heights.
                    if (moved || record.profileSettings !== record.settings) profileChanged = true;
                    record.profileSettings = record.settings;
                }
                record.profileDirty = false;
                profilesUpdated = true;
            }
            if (record.changed && !record.scheduled) {
                record.changed = false;
                record.scheduled = true;
                Globals.pendingActions++;
                requestAnimationFrame(() => {
                    record.scheduled = false;
                    try {
                        if (this.disposed || NodeMan.get(record.lock.id, false) !== record.lock) return;
                        record.lock.syncControlPointsToAltitudeLock?.();
                        record.lock.makeArrayForTrackDisplay?.();
                        record.lock.recalculateCascade();
                    } finally { Globals.pendingActions--; }
                });
            }
        }
        if (profilesUpdated && this.updateRoads(profileChanged)) queueRoads = true;
        if (queueRoads) this.queueRoadMeshes();
        // Geometry work is also incremental. Most leaf meshes are small; only
        // corridor meshes are considered and each is processed once per profile.
        let geometryChanged = false;
        while (this.geometryQueue.length && performance.now() < deadline) {
            const mesh = this.geometryQueue.shift();
            if (smoothRoadGeometry(mesh, this.profiles)) {
                this.modified.add(mesh);
                geometryChanged = true;
            } else if (this.modified.delete(mesh)) {
                // smoothRoadGeometry() removed the old smoothing: no road touches this mesh now.
                geometryChanged = true;
            }
        }
        if (geometryChanged) {
            markShadowCastersDirty("road surface changed");
            setRenderOne(true);
        }
        // A tree edit can restore our layer before modifying its own source.
        for (const mesh of this.modified) {
            if (!hasRoadGeometry(mesh)) {
                this.modified.delete(mesh);
                this.geometryQueue.push(mesh);
            }
        }
        return pending || this.geometryQueue.length > 0;
    }

    dispose() {
        this.disposed = true;
        EventManager.removeEventListener("elevationChanged", this.onElevationChanged);
        this.restoreRoads();
        for (const {renderer, plugin, load, unload} of this.renderers) {
            renderer.removeEventListener("load-model", load);
            renderer.removeEventListener("dispose-model", unload);
            renderer.unregisterPlugin(plugin);
            for (const queue of sharedQueues(renderer)) {
                const original = queue.priorityCallback.corridorOriginal;
                if (original) queue.priorityCallback = original;
            }
        }
        this.records.clear();
    }
}
