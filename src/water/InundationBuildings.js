import {Matrix4, Vector3} from "three";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {mercatorX, mercatorY} from "../WaterMaskGeo";
import {addInundationTriangle, addInundationCoverageTriangle} from "./InundationGrid";

function displayed(object) {
    for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
    return true;
}

// Use the finest cached tiles, including tiles outside the camera frustum.
// A cached parent cannot stand in for missing children: its simplified coast
// can omit the very seawall being tested. Missing detailed coverage is unknown.
// Synthetic buildings contribute only their solid mesh, not editing handles.
export function inundationBuildingMeshes(renderers = [], syntheticMeshes = [], maxError = Infinity) {
    const meshes = [];
    const loaded = [], ancestors = new Set(), ancestorKeys = new Set(), seen = new Set();
    const tileKey = tile => {
        const uri = tile.content?.uri ?? tile.content?.url;
        return uri ? `${tile.internal?.basePath ?? ""}|${uri}` : null;
    };
    for (const renderer of renderers) {
        renderer.forEachLoadedModel((scene, tile) => {
            loaded.push({renderer, scene, tile});
            for (let parent = tile.parent; parent && !ancestors.has(parent); parent = parent.parent) {
                ancestors.add(parent);
                const key = tileKey(parent);
                if (key) ancestorKeys.add(key);
            }
        });
        renderer.group.updateWorldMatrix(true, false);
    }
    for (const {renderer, scene, tile} of loaded) {
        const key = tileKey(tile);
        if (ancestors.has(tile) || (key && (ancestorKeys.has(key) || seen.has(key))) || tile.geometricError > maxError) continue;
        if (key) seen.add(key);
        // Inactive tile scenes are detached by TilesRenderer. Resolve the
        // same world transform without reattaching or displaying them.
        scene.updateWorldMatrix(false, true);
        scene.traverse(object => {
            if (!scene.parent) object.matrixWorld.premultiply(renderer.group.matrixWorld);
            if (object.isMesh && object.geometry?.attributes.position) meshes.push(object);
        });
    }
    for (const mesh of syntheticMeshes) if (mesh && displayed(mesh)) {
        mesh.updateWorldMatrix(true, false);
        meshes.push(mesh);
    }
    return meshes;
}

function snapshot(mesh) {
    const geometry = mesh.geometry;
    return {mesh, geometry, position: geometry.attributes.position, index: geometry.index,
        positionVersion: geometry.attributes.position.version ?? geometry.attributes.position.data?.version,
        indexVersion: geometry.index?.version, start: geometry.drawRange.start, count: geometry.drawRange.count,
        instanceVersion: mesh.instanceMatrix?.version, instances: mesh.isInstancedMesh ? mesh.count : 1,
        matrix: mesh.matrixWorld.clone()};
}

function same(a, b) {
    return a?.mesh === b.mesh && a.geometry === b.geometry && a.position === b.position && a.index === b.index
        && a.positionVersion === b.positionVersion && a.indexVersion === b.indexVersion
        && a.instanceVersion === b.instanceVersion && a.instances === b.instances
        && a.start === b.start && a.count === b.count && a.matrix.equals(b.matrix);
}

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

export class InundationBuildings {
    constructor(onReady) {
        this.onReady = onReady;
        this.cache = new WeakMap();
        this.ready = false;
        this.generation = 0;
    }

    update(meshes, rect, size, level, requireCoverage = false) {
        const inputs = meshes.map(snapshot);
        if (this.rect === rect && this.size === size && this.level === level && this.requireCoverage === requireCoverage
            && inputs.length === this.inputs?.length && inputs.every((s, i) => same(this.inputs[i], s))) return;
        this.cancel();
        if (this.rect !== rect || this.size !== size) this.cache = new WeakMap();
        this.inputs = inputs;
        this.rect = rect;
        this.size = size;
        this.level = level;
        this.requireCoverage = requireCoverage;
        this.ready = false;
        this.error = null;
        const generation = this.generation;
        // Let slider drags and tile fades settle, rather than starting a new
        // geometry scan for every intermediate state. No idle polling timer.
        this.timer = setTimeout(() => {
            this.timer = null;
            this.build(inputs, rect, size, level, generation, requireCoverage);
        }, 200);
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

    async build(inputs, rect, size, level, generation, requireCoverage) {
        try {
            const barriers = {east: new Uint8Array(size * size), south: new Uint8Array(size * size)};
            if (requireCoverage) barriers.coverage = new Uint8Array(size * size);
            let triangles = 0;
            for (const input of inputs) {
                const projected = await this.project(input, rect, size, generation);
                if (generation !== this.generation || !projected) return;
                for (const {vertices, minHeight, maxHeight} of projected) {
                    if (!requireCoverage && (minHeight > level || maxHeight <= level)) continue;
                    const count = input.index?.count ?? input.position.count;
                    const end = Math.min(count, input.start + input.count);
                    for (let j = input.start; j + 2 < end; j += 3) {
                        const a = input.index ? input.index.getX(j) : j;
                        const b = input.index ? input.index.getX(j + 1) : j + 1;
                        const c = input.index ? input.index.getX(j + 2) : j + 2;
                        if (requireCoverage) addInundationCoverageTriangle(vertices, a, b, c, barriers.coverage, size, size);
                        addInundationTriangle(vertices, a, b, c, level, barriers, size, size);
                        if (++triangles % 16384 === 0) {
                            await yieldToUI();
                            if (generation !== this.generation) return;
                        }
                    }
                }
            }
            if (generation !== this.generation) return;
            this.barriers = barriers;
            this.meshCount = inputs.length;
            this.ready = true;
            this.onReady?.();
        } catch (error) {
            if (generation !== this.generation) return;
            this.error = `3D geometry calculation failed: ${error.message}`;
            this.onReady?.();
        }
    }

    cancel() {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = null;
    }

    dispose() {
        this.cancel();
        this.cache = new WeakMap();
        this.inputs = null;
        this.barriers = null;
        this.ready = false;
    }
}
