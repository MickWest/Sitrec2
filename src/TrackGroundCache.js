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

// The union of small path volumes, not one sphere around the whole route. A
// curved road therefore cannot force-load the landscape enclosed by its bends.
export class TrackLoadRegion {
    constructor() { this.mask = false; this.spheres = []; this.box = new Box3(); }
    setPaths(paths) {
        this.spheres = paths.flatMap(points => sampleRoadPath(points, 20).map(p => new Sphere(p, 45)));
        this.box.makeEmpty();
        for (const sphere of this.spheres) this.box.union(sphere.getBoundingBox(new Box3()));
    }
    intersectsTile(volume) {
        const box = new Box3();
        volume.getAABB(box);
        if (!this.spheres.length || !this.box.intersectsBox(box)) return false;
        return this.spheres.some(sphere => volume.intersectsSphere(sphere));
    }
    // Refine right down to the available leaves, including zero-error external
    // tilesets. Region-selected leaves stay used in the renderer's LRU cache.
    calculateError() { return Infinity; }
    calculateDistance() { return 0; }
}

export class TrackGroundCache {
    constructor(buildings) {
        this.buildings = buildings;
        this.records = new Map();
        this.region = new TrackLoadRegion();
        this.renderers = [];
        this.tiles = [];
        this.tilesDirty = true;
        this.geometryQueue = [];
        this.modified = new Set();
        this.surfaceRevision = 0;
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
            for (const entry of record.samples.values()) entry.pending = true;
            record.profileDirty = true;
        }
        setRenderOne(true);
    }

    pointBelow(point, lock) {
        let record = this.records.get(lock);
        if (!record) {
            record = {lock, samples: new Map(), route: [], signature: null, profile: null, profileDirty: true};
            this.records.set(lock, record);
        }
        if (lock.roadTrack && record.profile) {
            const road = record.profile.pointBelow(point);
            if (road) return road;
        }
        const key = columnKey(point);
        let entry = record.samples.get(key);
        if (!entry) {
            const ground = getPointBelow(point);
            entry = {point: ground, value: ground, pending: true};
            record.samples.set(key, entry);
            setRenderOne(true);
        }
        // Preserve the query's horizontal position, rather than snapping it to
        // the centimetre-sized cache cell (which would introduce heading steps).
        const up = getLocalUpVector(point);
        return point.clone().addScaledVector(up, entry.value.clone().sub(point).dot(up));
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
            const signature = points.map(p => columnKey(p, 6)).join(";");
            if (signature === record.signature && settings === record.settings) continue;
            const pathChanged = signature !== record.signature;
            record.signature = signature;
            record.settings = settings;
            record.profileDirty = true;
            record.changed = true;
            if (pathChanged) {
                record.route = sampleRoadPath(points, 2).map(p => getPointBelow(p));
                record.profile = null;
                // Drop old coordinates after a PATH edit. Changing road width or
                // smoothing can reuse the already sampled source heights.
                record.samples.clear();
                for (const point of record.route) this.pointBelow(point, lock);
                changed = true;
            } else if (!lock.roadTrack) {
                record.profile = null;
            }
        }
        if (changed) {
            this.region.setPaths([...this.records.values()].map(r => r.route));
            for (const {pv} of this.renderers) pv._needsLibUpdate = true;
            this.restoreRoads();
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
                    this.tiles.push({scene, tile});
                }
            });
        }
        this.tiles.sort((a, b) => a.tile.geometricError - b.tile.geometricError);
        this.tilesDirty = false;
    }

    sample(point) {
        const up = getLocalUpVector(point);
        this.raycaster.set(point.clone().addScaledVector(up, 1000), up.clone().negate());
        // Query retained meshes, independent of visibility. Prefer the finest
        // available tile, never the coarser ancestor closest to the elevation map.
        let error = Infinity, best = null, deviation = Infinity;
        for (const {scene, tile} of this.tiles) {
            if (best && tile.geometricError > error) break;
            if (!tile.engineData.boundingVolume.intersectsRay(this.raycaster.ray)) continue;
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

    rebuildRoads() {
        this.restoreRoads();
        this.surfaceRevision++;
        const profiles = [...this.records.values()].filter(r => r.lock.roadTrack && r.profile).map(r => r.profile);
        this.profiles = profiles;
        this.geometryQueue = [];
        if (profiles.length) {
            for (const {scene} of this.tiles) scene.traverse(mesh => {
                if (mesh.isMesh) this.geometryQueue.push(mesh);
            });
        }
    }

    restoreRoads() {
        if (this.modified.size) markShadowCastersDirty("road surface restored");
        for (const mesh of this.modified) restoreRoadGeometry(mesh);
        this.modified.clear();
        this.geometryQueue = [];
    }

    hasPendingWork() {
        return this.geometryQueue.length > 0 || [...this.records.values()].some(record =>
            record.scheduled || (record.profileDirty && record.route.length > 1)
            || [...record.samples.values()].some(entry => entry.pending));
    }

    update() {
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
        // Let a burst of arriving corridor tiles finish before sampling. Camera
        // visibility events do not invalidate this cache or restart this timer.
        if (performance.now() - this.lastLoad < 300) return true;
        if (this.tilesDirty) this.collectTiles();
        const deadline = performance.now() + 6;
        let pending = false, rebuild = false;
        for (const record of this.records.values()) {
            for (const entry of record.samples.values()) {
                if (!entry.pending) continue;
                if (performance.now() > deadline) { pending = true; break; }
                const value = this.sample(entry.point);
                if (value.distanceToSquared(entry.value) > 0.000001) record.changed = true;
                entry.value = value; entry.pending = false;
            }
            if ([...record.samples.values()].some(e => e.pending)) { pending = true; continue; }
            if (record.profileDirty && record.route.length > 1) {
                if (record.lock.roadTrack) {
                    const points = record.route.map(p => record.samples.get(columnKey(p)).value);
                    const profile = new RoadProfile(points, record.lock.roadSmoothing ?? 20, record.lock.roadWidth ?? 8);
                    const old = record.profile;
                    record.profile = profile;
                    if (!old || points.some(p => old.pointBelow(p)?.distanceToSquared(profile.pointBelow(p)) > 0.000001)) record.changed = true;
                }
                record.profileDirty = false;
                rebuild = true;
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
        if (rebuild) this.rebuildRoads();
        // Geometry work is also incremental. Most leaf meshes are small; only
        // corridor meshes are considered and each is processed once per profile.
        while (this.geometryQueue.length && performance.now() < deadline) {
            const mesh = this.geometryQueue.shift();
            if (smoothRoadGeometry(mesh, this.profiles)) {
                this.modified.add(mesh);
                markShadowCastersDirty("road surface smoothed");
            }
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
        }
        this.records.clear();
    }
}
