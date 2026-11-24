import {Matrix4, Vector3} from "three";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {ensureGeoidLoaded, meanSeaLevelOffset} from "../EGM96Geoid";
import {Globals} from "../Globals";
import {mercatorX, mercatorY} from "../WaterMaskGeo";
import {InundationRasterCache} from "./InundationRaster";
import {createInundationWorker} from "./InundationWorkerClient";
export {inundationCoverageAtLevel} from "./InundationRaster";

function displayed(object) {
    for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
    return true;
}

// Retain cached tiles outside the camera frustum. Select the finest available
// sample at each grid cell, so one loaded child does not discard its parent's
// entire footprint. Coarse or uncertain coastal cells remain closed.
// Synthetic buildings contribute only their solid mesh, not editing handles.
function inundationScenes(renderers, maxError) {
    const loaded = [], seen = new Set();
    const tileKey = tile => {
        const uri = tile.content?.uri ?? tile.content?.url;
        return uri ? `${tile.internal?.basePath ?? ""}|${uri}` : null;
    };
    for (const renderer of renderers) {
        renderer.forEachLoadedModel((scene, tile) => {
            loaded.push({renderer, scene, tile});
        });
    }
    const scenes = [];
    for (const {renderer, scene, tile} of loaded) {
        const key = tileKey(tile);
        if ((key && seen.has(key)) || tile.geometricError > maxError) continue;
        if (key) seen.add(key);
        scenes.push({renderer, scene, error: tile.geometricError ?? 0, key: key ?? scene.uuid});
    }
    return scenes;
}

function meshesFromScenes(scenes, syntheticMeshes) {
    const meshes = [];
    meshes.errors = new Map();
    meshes.meshKeys = new Map();
    for (const {renderer, scene, error, key} of scenes) {
        let meshIndex = 0;
        renderer.group.updateWorldMatrix(true, false);
        // Inactive tile scenes are detached by TilesRenderer. Resolve the
        // same world transform without reattaching or displaying them.
        scene.updateWorldMatrix(false, true);
        scene.traverse(object => {
            if (!scene.parent) object.matrixWorld.premultiply(renderer.group.matrixWorld);
            if (object.isMesh && object.geometry?.attributes.position) {
                meshes.push(object); meshes.errors.set(object, error); meshes.meshKeys.set(object, `${key}/${meshIndex++}`);
            }
        });
    }
    for (const mesh of syntheticMeshes) if (mesh && displayed(mesh)) {
        mesh.updateWorldMatrix(true, false);
        meshes.push(mesh);
    }
    return meshes;
}

export function inundationBuildingMeshes(renderers = [], syntheticMeshes = [], maxError = Infinity) {
    return meshesFromScenes(inundationScenes(renderers, maxError), syntheticMeshes);
}

export class InundationMeshCollector {
    constructor() {
        this.renderers = [];
        this.invalidate = () => { this.dirty = true; };
    }

    collect(renderers, syntheticMeshes, maxError) {
        if (renderers.length !== this.renderers.length || renderers.some((r, i) => r !== this.renderers[i])) {
            this.dispose();
            this.renderers = renderers;
            for (const renderer of renderers) {
                renderer.addEventListener("load-model", this.invalidate);
                renderer.addEventListener("dispose-model", this.invalidate);
            }
        }
        if (this.dirty || this.maxError !== maxError || !this.scenes) {
            this.scenes = inundationScenes(renderers, maxError);
            this.maxError = maxError;
            this.dirty = false;
        }
        // Matrix/attribute edits still reach the geometry cache every frame;
        // only the expensive tile-tree/ancestor selection is cached.
        return meshesFromScenes(this.scenes, syntheticMeshes);
    }

    dispose() {
        for (const renderer of this.renderers) {
            renderer.removeEventListener("load-model", this.invalidate);
            renderer.removeEventListener("dispose-model", this.invalidate);
        }
        this.renderers = [];
        this.scenes = null;
    }
}

function snapshot(mesh, error = 0, coverageSource = false) {
    const geometry = mesh.geometry;
    return {mesh, geometry, error, coverageSource, position: geometry.attributes.position, index: geometry.index,
        positionVersion: geometry.attributes.position.version ?? geometry.attributes.position.data?.version,
        indexVersion: geometry.index?.version, start: geometry.drawRange.start, count: geometry.drawRange.count,
        instanceVersion: mesh.instanceMatrix?.version, instances: mesh.isInstancedMesh ? mesh.count : 1,
        matrix: mesh.matrixWorld.clone()};
}

function same(a, b) {
    return a?.mesh === b.mesh && a.error === b.error && a.coverageSource === b.coverageSource
        && a.geometry === b.geometry && a.position === b.position && a.index === b.index
        && a.positionVersion === b.positionVersion && a.indexVersion === b.indexVersion
        && a.instanceVersion === b.instanceVersion && a.instances === b.instances
        && a.start === b.start && a.count === b.count && a.matrix.equals(b.matrix);
}

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));
let nextDomain = 0;

export class InundationBuildings {
    constructor(onReady, options = {}) {
        this.onReady = onReady;
        this.onProgress = options.onProgress;
        this.ownsWorker = !("worker" in options);
        this.worker = this.ownsWorker ? createInundationWorker() : options.worker;
        this.cache = new WeakMap();
        this.sent = new WeakMap();
        this.raster = new InundationRasterCache();
        this.records = new Map();
        this.ready = false;
        this.generation = 0;
        this.domain = 0;
    }

    update(meshes, rect, size, level, requireCoverage = false, fineError = Infinity) {
        const inputs = meshes.map(mesh => snapshot(mesh, meshes.errors?.get(mesh) ?? 0, meshes.errors?.has(mesh) ?? false));
        const earthKey = `${Globals.equatorRadius}/${Globals.polarRadius}`;
        const sameGeometry = this.earthKey === earthKey && this.rect === rect && this.size === size && this.sourceKey === meshes.sourceKey
            && inputs.length === this.inputs?.length && inputs.every((s, i) => same(this.inputs[i], s));
        if (sameGeometry && this.level === level && this.requireCoverage === requireCoverage && this.fineError === fineError) return;
        if (this.ready && this.inputs && meshes.sourceKey && this.earthKey === earthKey && this.rect === rect && this.size === size
            && this.sourceKey === meshes.sourceKey && this.level === level && this.requireCoverage === requireCoverage && this.fineError === fineError) {
            const previous = new Map(this.inputs?.map(input => [input.mesh, input]));
            const current = new Set(inputs.map(input => input.mesh));
            if (inputs.every(input => same(previous.get(input.mesh), input))
                && this.inputs.every(input => current.has(input.mesh) || (input.coverageSource && input.key))) {
                // Display eviction does not change the retained calculation.
                // Keep the completed mask without rerasterizing or transferring it.
                for (const input of inputs) input.key = meshes.meshKeys?.get(input.mesh);
                this.inputs = inputs;
                return;
            }
        }
        if ((this.running || this.timer) && this.earthKey === earthKey && this.rect === rect && this.size === size && this.sourceKey === meshes.sourceKey
            && this.level === level && this.requireCoverage === requireCoverage && this.fineError === fineError) {
            const previous = new Map(this.inputs.map(input => [input.mesh, input]));
            if (inputs.every(input => !previous.has(input.mesh) || same(previous.get(input.mesh), input))) {
                // Start and finish this batch while tiles stream in. Restarting
                // the delay for each arrival can prevent any coverage from
                // ever being published.
                return;
            }
        }
        this.cancel();
        const domainChanged = this.earthKey !== earthKey || this.rect !== rect || this.size !== size || this.sourceKey !== meshes.sourceKey;
        this.earthKey = earthKey;
        if (domainChanged || !meshes.sourceKey) this.records.clear();
        this.sourceKey = meshes.sourceKey;
        if (domainChanged) {
            this.coverage = null; this.surfaceHeights = null; this.surfaceErrors = null;
            this.cache = new WeakMap(); this.sent = new WeakMap();
            this.raster = new InundationRasterCache();
            this.domain = ++nextDomain;
        }
        this.inputs = inputs;
        for (const input of inputs) input.key = meshes.meshKeys?.get(input.mesh);
        this.rect = rect;
        this.size = size;
        this.level = level;
        this.requireCoverage = requireCoverage;
        this.fineError = fineError;
        this.ready = false;
        this.error = null;
        this.reportProgress({stage: "Waiting for tiles", done: 0, total: 1, fraction: 0});
        const generation = this.generation;
        // Let slider drags and tile fades settle, rather than starting a new
        // geometry scan for every intermediate state. No idle polling timer.
        this.timer = setTimeout(() => {
            this.timer = null;
            this.running = true;
            this.build(inputs, rect, size, level, generation, requireCoverage, fineError);
        }, 200);
    }

    reportProgress(progress) {
        this.progress = progress;
        this.onProgress?.(progress);
    }

    async buildInWorker(inputs, rect, size, level, generation, requireCoverage, fineError) {
        const changes = [], transfer = [], active = [];
        let lastYield = performance.now();
        const matrix = new Matrix4(), instance = new Matrix4();
        for (let n = 0; n < inputs.length; n++) {
            const input = inputs[n], key = input.key ?? input.mesh.uuid;
            active.push(key);
            if (same(this.sent.get(input.mesh), input)) continue;
            // Copy decoded attributes, including interleaved/normalized ones.
            // The live render buffers must never be detached by postMessage.
            const positions = new Float64Array(input.position.count * 3);
            for (let i = 0; i < input.position.count; i++) {
                positions[i * 3] = input.position.getX(i);
                positions[i * 3 + 1] = input.position.getY(i);
                positions[i * 3 + 2] = input.position.getZ(i);
                if (i % 8192 === 8191 && performance.now() - lastYield >= 12) {
                    await yieldToUI(); lastYield = performance.now();
                    if (generation !== this.generation) return null;
                }
            }
            const index = input.index ? new Uint32Array(input.index.count) : null;
            if (index) for (let i = 0; i < index.length; i++) index[i] = input.index.getX(i);
            const matrices = [];
            for (let i = 0; i < input.instances; i++) {
                matrix.copy(input.matrix);
                if (input.mesh.isInstancedMesh) { input.mesh.getMatrixAt(i, instance); matrix.multiply(instance); }
                matrices.push(matrix.toArray());
            }
            changes.push({key, positions, matrices, retained: !!(this.sourceKey && input.coverageSource && input.key),
                input: {index, position: {count: input.position.count}, start: input.start, count: input.count,
                    error: input.error, coverageSource: input.coverageSource}});
            transfer.push(positions.buffer);
            if (index) transfer.push(index.buffer);
            if (performance.now() - lastYield >= 12) {
                this.reportProgress({stage: "Preparing tiles", done: n + 1, total: inputs.length, fraction: (n + 1) / inputs.length});
                await yieldToUI(); lastYield = performance.now();
                if (generation !== this.generation) return null;
            }
        }
        const context = {rect, size, equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius};
        if (!this.worker.geoidSent) context.geoid = await ensureGeoidLoaded();
        if (generation !== this.generation) return null;
        const result = await this.worker.request("geometry", {domain: this.domain, context, changes, active,
            level, requireCoverage, fineError, geometryId: generation}, transfer, progress => this.reportProgress(progress));
        if (generation !== this.generation) return null;
        this.worker.geoidSent = true;
        this.sent = new WeakMap();
        for (const input of inputs) this.sent.set(input.mesh, input);
        // Only lightweight bookkeeping remains on the UI thread. The worker
        // retains projection and raster data when the display cache evicts a tile.
        for (const input of inputs) if (input.coverageSource && input.key) this.records.set(input.key, true);
        this.lastCalculationMs = result.elapsedMs;
        this.cacheStats = result.cacheStats;
        this.geometryId = result.geometryId;
        return result;
    }

    async project(input, rect, size, generation) {
        const old = this.cache.get(input.mesh);
        if (old && same(old.input, input)) return old.projected;
        const projected = [], point = new Vector3(), instance = new Matrix4(), matrix = new Matrix4();
        for (let n = 0; n < input.instances; n++) {
            matrix.copy(input.matrix);
            if (input.mesh.isInstancedMesh) {
                input.mesh.getMatrixAt(n, instance);
                matrix.multiply(instance);
            }
            const vertices = new Float32Array(input.position.count * 3);
            let minHeight = Infinity, maxHeight = -Infinity;
            for (let i = 0; i < input.position.count; i++) {
                point.fromBufferAttribute(input.position, i).applyMatrix4(matrix);
                const lla = ECEFToLLAVD_radii(point);
                let u = mercatorX(lla.y) - rect.u0;
                u -= Math.round(u - rect.du / 2);
                vertices[i * 3] = u / rect.du * size - 0.5;
                vertices[i * 3 + 1] = (mercatorY(lla.x) - rect.v0) / rect.du * size - 0.5;
                const h = lla.z - meanSeaLevelOffset(lla.x, lla.y);
                vertices[i * 3 + 2] = h;
                minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h);
                if (i % 8192 === 8191) {
                    await yieldToUI();
                    if (generation !== this.generation) return null;
                }
            }
            projected.push({vertices, minHeight, maxHeight});
        }
        this.cache.set(input.mesh, {input, projected});
        return projected;
    }

    async build(inputs, rect, size, level, generation, requireCoverage, fineError) {
        try {
            let result;
            if (this.worker) result = await this.buildInWorker(inputs, rect, size, level, generation, requireCoverage, fineError);
            else {
                const projections = [];
                for (let i = 0; i < inputs.length; i++) {
                    const input = inputs[i];
                    this.reportProgress({stage: "Projecting tiles", done: i, total: inputs.length, fraction: i / inputs.length});
                    const projected = await this.project(input, rect, size, generation);
                    if (generation !== this.generation || !projected) return;
                    if (input.coverageSource && input.key) {
                        const old = this.records.get(input.key);
                        if (old?.projected !== projected) {
                            this.records.set(input.key, {projected, input: {
                                index: input.index?.clone(), position: {count: input.position.count},
                                start: input.start, count: input.count, error: input.error, coverageSource: true,
                            }});
                        }
                    } else projections.push({input, projected});
                }
                for (const record of this.records.values()) projections.push(record);
                let lastYield = performance.now();
                const checkpoint = async () => {
                    if (generation !== this.generation) throw new Error("cancelled");
                    if (performance.now() - lastYield >= 12) {
                        await yieldToUI(); lastYield = performance.now();
                        if (generation !== this.generation) throw new Error("cancelled");
                    }
                };
                const barriers = await this.raster.build(projections, size, level, requireCoverage, fineError, {
                    checkpoint,
                    onProgress: (stage, done, total) => this.reportProgress({stage, done, total, fraction: total ? done / total : 1}),
                });
                result = {barriers, meshCount: projections.length};
            }
            if (generation !== this.generation || !result) return;
            this.barriers = result.barriers;
            this.coverage = this.barriers.rawCoverage;
            this.surfaceHeights = this.barriers.surfaceHeights;
            this.surfaceErrors = this.barriers.surfaceErrors;
            this.meshCount = result.meshCount;
            this.running = false;
            this.ready = true;
            this.progress = null;
            this.onReady?.();
        } catch (error) {
            if (generation !== this.generation) return;
            this.running = false;
            this.progress = null;
            this.error = `3D geometry calculation failed: ${error.message}`;
            this.onReady?.();
        }
    }

    cancel() {
        // The worker may have committed a result whose reply has not reached
        // us yet. Resend active inputs after cancellation to reconcile edits.
        if (this.running && this.worker) this.sent = new WeakMap();
        this.worker?.cancel();
        this.generation++;
        this.progress = null;
        this.running = false;
        clearTimeout(this.timer);
        this.timer = null;
    }

    dispose() {
        this.cancel();
        if (this.ownsWorker) { this.worker?.dispose(); this.worker = null; }
        else this.worker?.clearGeometry();
        this.sent = new WeakMap();
        this.raster = new InundationRasterCache();
        this.cache = new WeakMap();
        this.records.clear();
        this.sourceKey = null;
        this.inputs = null;
        this.barriers = null;
        this.coverage = null;
        this.surfaceHeights = null;
        this.surfaceErrors = null;
        this.coverageParts = null;
        this.ready = false;
    }
}
