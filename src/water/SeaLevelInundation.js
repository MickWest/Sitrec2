import {DataTexture, NearestFilter, RedFormat, UnsignedByteType} from "three";
import {loadOceanMaskRegion} from "../WaterMaskGeo";
import {connectedInundation, inundationOceanSeeds, latitudeAtMercatorY} from "./InundationGrid";
import {loadInundationTerrain} from "./InundationTerrain";
import {InundationBuildings} from "./InundationBuildings";
import {inundationFlowRoutes} from "./InundationFlow";
import {createInundationWorker} from "./InundationWorkerClient";

const MAX_GRID_SIZE = 2048;
const TARGET_CELL_METERS = 10;
let nextTerrainId = 0;

export class SeaLevelInundation {
    constructor(onChange) {
        this.onChange = onChange;
        this.status = "Off";
        this.texture = null;
        this.generation = 0;
        this.fillToken = 0;
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.onChange?.();
    }

    setProgress(progress) {
        this.progress = progress;
        this.setStatus(`${progress.stage} ${Math.round(progress.fraction * 100)}%`);
    }

    update(geometry, map, widthMeters, level, buildingMeshes = null, showFlow = false) {
        this.level = level;
        if (this.showFlow !== showFlow) this.appliedLevel = undefined;
        this.showFlow = showFlow;
        if (geometry !== this.geometry || map !== this.map || this.scale !== map?.options.zScale) {
            this.dispose();
            this.geometry = geometry;
            this.map = map;
            this.scale = map?.options.zScale;
            this.controller = new AbortController();
            this.build(geometry.maskRect, widthMeters, this.generation, this.controller.signal);
        }
        const modeChanged = (this.buildingMeshes === null) !== (buildingMeshes === null);
        this.buildingMeshes = buildingMeshes;
        if (this.heights) {
            this.updateBuildings();
            if (modeChanged || this.appliedLevel !== level || this.appliedBarriers !== this.buildings?.barriers) this.fill();
        }
        if (this.worker) {
            // Keep the last completed surface visible while additional tiles
            // refine the same domain and level. A different level/source/grid
            // must never display a mask calculated for the previous inputs.
            return this.appliedLevel === level && this.appliedDomain === (this.buildings?.domain ?? null)
                && !this.fillError && !this.buildings?.error ? this.texture : null;
        }
        return buildingMeshes !== null && !this.buildings?.ready ? null : this.texture;
    }

    async build(rect, widthMeters, generation, signal) {
        this.setStatus("Loading ocean and terrain…");
        let oceanTexture;
        try {
            if (rect.v0 < 0 || rect.v0 + rect.du > 1) throw new Error("Inundation is outside the ocean map coverage.");
            const size = Math.max(64, Math.min(MAX_GRID_SIZE, Math.ceil(widthMeters / TARGET_CELL_METERS)));
            // Await the ocean map first: an unavailable source should not start
            // a large, unusable elevation download.
            oceanTexture = await loadOceanMaskRegion(rect, size);
            if (signal.aborted) return;
            const pixels = oceanTexture.image.getContext("2d").getImageData(0, 0, size, size).data;
            const ocean = new Uint8Array(size * size);
            let seeds = 0;
            for (let i = 0; i < ocean.length; i++) {
                ocean[i] = pixels[i * 4] >= 250 ? 1 : 0;
                seeds += ocean[i];
            }
            this.size = size;
            this.ocean = ocean;
            this.oceanSeeds = inundationOceanSeeds(ocean, size, size);
            if (!seeds || !this.oceanSeeds.some(Boolean)) {
                this.setStatus("No ocean interior in Coverage — increase Coverage.");
                return;
            }
            const terrain = await loadInundationTerrain(this.map, rect, size, signal, (done, total) => {
                if (!signal.aborted) this.setStatus(`Loading terrain ${done}/${total}…`);
            });
            if (signal.aborted || generation !== this.generation || !terrain) return;
            this.heights = terrain.heights;
            this.missing = terrain.missing;
            this.worker = createInundationWorker();
            this.terrainId = ++nextTerrainId;
            this.workerTerrainSent = false;
            this.cellMeters = rect.du * 40075016.686 * Math.cos(latitudeAtMercatorY(rect.v0 + rect.du / 2) * Math.PI / 180) / size;
            this.texture = new DataTexture(new Uint8Array(size * size), size, size, RedFormat, UnsignedByteType);
            this.texture.minFilter = this.texture.magFilter = NearestFilter;
            this.texture.generateMipmaps = false;
            this.updateBuildings();
            this.fill();
        } catch (error) {
            if (!signal.aborted && generation === this.generation) this.setStatus(error.message);
        } finally {
            oceanTexture?.dispose();
        }
    }

    fill() {
        if (this.buildingMeshes !== null && !this.buildings?.ready) {
            if (this.pendingFill) { this.fillToken++; this.pendingFill = null; }
            if (!this.buildings?.progress) this.setStatus(this.buildings?.error ?? "Calculating 3D geometry…");
            return;
        }
        const barriers = this.buildings?.barriers;
        if (this.worker) {
            this.fillInWorker(barriers);
            return;
        }
        const trace = this.showFlow ? {} : null;
        connectedInundation(this.heights, this.ocean, this.size, this.size, this.level, this.texture.image.data, barriers, trace, this.oceanSeeds);
        this.flowRoutes = trace ? inundationFlowRoutes(trace, this.heights, this.ocean, this.size, this.cellMeters, barriers?.surfaceHeights) : [];
        this.texture.needsUpdate = true;
        this.appliedLevel = this.level;
        this.appliedBarriers = barriers;
        this.appliedDomain = this.buildings?.domain ?? null;
        this.finishFill();
    }

    fillInWorker(barriers) {
        const level = this.level, showFlow = this.showFlow;
        const failed = this.fillError;
        if (failed?.level === level && failed.barriers === barriers && failed.showFlow === showFlow) return;
        this.fillError = null;
        const previous = this.pendingFill;
        if (previous?.level === level && previous.barriers === barriers && previous.showFlow === showFlow) return;
        const token = ++this.fillToken, generation = this.generation;
        this.pendingFill = {level, barriers, showFlow};
        this.setProgress({stage: "Flood fill", fraction: 0, done: 0, total: 1});
        const payload = {terrainId: this.terrainId, level, showFlow, useBuildings: !!this.buildings,
            geometryId: this.buildings?.geometryId};
        if (!this.workerTerrainSent) payload.terrain = {id: this.terrainId, heights: this.heights,
            ocean: this.ocean, seeds: this.oceanSeeds, size: this.size, cellMeters: this.cellMeters};
        this.worker.request("fill", payload, [], progress => this.setProgress(progress)).then(result => {
            if (token !== this.fillToken || generation !== this.generation || this.level !== level
                || this.buildings?.barriers !== barriers || (this.buildings && !this.buildings.ready)) return;
            this.workerTerrainSent = true;
            this.texture.image.data = result.wet;
            this.texture.needsUpdate = true;
            this.flowRoutes = result.flowRoutes;
            this.lastFillMs = result.elapsedMs;
            this.appliedLevel = level;
            this.appliedBarriers = barriers;
            this.appliedDomain = this.buildings?.domain ?? null;
            this.pendingFill = null;
            this.finishFill();
        }).catch(error => {
            if (token !== this.fillToken || generation !== this.generation) return;
            this.pendingFill = null;
            this.progress = null;
            if (error.name !== "AbortError") {
                this.fillError = {level, barriers, showFlow};
                this.setStatus(`Inundation calculation failed: ${error.message}. Recalculate to retry.`);
            }
        });
    }

    finishFill() {
        this.progress = null;
        this.fillError = null;
        const status3D = this.buildings
            ? (this.buildings.requireCoverage ? "Ready — missing 3D coverage blocks flow"
                : this.buildings.meshCount ? "Ready — terrain + loaded 3D geometry" : "Ready — no 3D geometry loaded; using terrain") : "Ready";
        this.setStatus(this.missing ? `${status3D} — missing terrain blocks flow; recalculate to retry.` : status3D);
    }

    updateBuildings() {
        if (this.buildingMeshes !== null) {
            this.buildings ??= new InundationBuildings(() => {
                this.progress = null;
                this.onChange?.();
            }, {worker: this.worker, onProgress: progress => this.setProgress(progress)});
            this.buildings.update(this.buildingMeshes ?? [], this.geometry.maskRect, this.size, this.level,
                this.buildingMeshes?.requireCoverage ?? false, this.buildingMeshes?.fineError ?? Infinity);
            if (!this.buildings.ready && !this.buildings.progress) this.setStatus(this.buildings.error ?? "Calculating 3D geometry…");
        } else if (this.buildings) {
            this.buildings.dispose();
            this.buildings = null;
        }
    }

    detailCoverage(radiusMeters) {
        const coverage = this.buildings?.barriers?.coverage;
        if (!coverage || !this.heights || this.buildings.barriers.level !== this.level) return null;
        const old = this.coverageSummary;
        if (old?.coverage === coverage && old.level === this.level && old.radiusMeters === radiusMeters) return old;
        const radius = radiusMeters / this.cellMeters, center = this.size / 2;
        let total = 0, covered = 0;
        const start = Math.max(0, Math.floor(center - radius)), end = Math.min(this.size - 1, Math.ceil(center + radius));
        for (let y = start; y <= end; y++) for (let x = start; x <= end; x++) {
            if ((x + 0.5 - center) ** 2 + (y + 0.5 - center) ** 2 > radius * radius) continue;
            const i = y * this.size + x;
            if (this.ocean[i] ? !this.oceanSeeds[i] : Number.isFinite(this.heights[i]) && this.heights[i] <= this.level + 5) {
                total++; if (coverage[i]) covered++;
            }
        }
        return this.coverageSummary = {coverage, level: this.level, radiusMeters, total, covered,
            percent: total ? Math.floor(100 * covered / total) : 100};
    }

    pauseCalculation() {
        // Preserve the rendered result, but prevent pending async work from
        // publishing new terrain, barriers or routes while the view is locked.
        this.generation++;
        this.fillToken++;
        this.pendingFill = null;
        this.progress = null;
        this.worker?.cancel();
        this.controller?.abort();
        if (this.buildings) {
            this.buildings.cancel();
            // A cancelled batch must restart even if its meshes are unchanged.
            this.buildings.inputs = null;
        }
        // update() must restart a cancelled initial download after unlocking.
        if (!this.heights) this.geometry = null;
    }

    suspend() {
        this.fillToken++;
        this.pendingFill = null;
        this.progress = null;
        this.worker?.cancel();
        // Keep a completed grid for instant before/after comparisons. Cancel
        // unfinished work so hiding the water does not keep downloading tiles.
        if (!this.heights) this.dispose();
        else if (this.buildings) {
            this.buildings.dispose();
            this.buildings = null;
            this.buildingMeshes = null;
            this.appliedBarriers = undefined;
            this.appliedLevel = undefined;
            this.coverageSummary = null;
            this.flowRoutes = null;
        }
    }

    dispose() {
        this.generation++;
        this.fillToken++;
        this.pendingFill = null;
        this.progress = null;
        this.fillError = null;
        this.controller?.abort();
        this.buildings?.dispose();
        this.worker?.dispose();
        this.worker = null;
        this.buildings = null;
        this.buildingMeshes = null;
        this.texture?.dispose();
        this.texture = null;
        this.geometry = null;
        this.map = null;
        this.heights = null;
        this.ocean = null;
        this.oceanSeeds = null;
        this.flowRoutes = null;
        this.coverageSummary = null;
        this.appliedLevel = undefined;
        this.appliedBarriers = undefined;
        this.appliedDomain = undefined;
    }
}
