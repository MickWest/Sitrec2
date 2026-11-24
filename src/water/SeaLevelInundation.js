import {DataTexture, NearestFilter, RedFormat, UnsignedByteType} from "three";
import {loadOceanMaskRegion} from "../WaterMaskGeo";
import {connectedInundation, latitudeAtMercatorY} from "./InundationGrid";
import {loadInundationTerrain} from "./InundationTerrain";
import {InundationBuildings} from "./InundationBuildings";
import {inundationFlowRoutes} from "./InundationFlow";

const MAX_GRID_SIZE = 2048;
const TARGET_CELL_METERS = 10;

export class SeaLevelInundation {
    constructor(onChange) {
        this.onChange = onChange;
        this.status = "Off";
        this.texture = null;
        this.generation = 0;
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.onChange?.();
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
            if (!seeds) {
                this.setStatus("No ocean in Coverage — increase Coverage.");
                return;
            }
            const terrain = await loadInundationTerrain(this.map, rect, size, signal, (done, total) => {
                if (!signal.aborted) this.setStatus(`Loading terrain ${done}/${total}…`);
            });
            if (signal.aborted || generation !== this.generation || !terrain) return;
            this.heights = terrain.heights;
            this.missing = terrain.missing;
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
            this.setStatus(this.buildings?.error ?? "Calculating 3D geometry…");
            return;
        }
        const barriers = this.buildings?.barriers;
        const trace = this.showFlow ? {} : null;
        connectedInundation(this.heights, this.ocean, this.size, this.size, this.level, this.texture.image.data, barriers, trace);
        this.flowRoutes = trace ? inundationFlowRoutes(trace, this.heights, this.ocean, this.size, this.cellMeters) : [];
        this.texture.needsUpdate = true;
        this.appliedLevel = this.level;
        this.appliedBarriers = barriers;
        const status3D = this.buildings
            ? (this.buildings.requireCoverage ? "Ready — missing 3D coverage blocks flow"
                : this.buildings.meshCount ? "Ready — terrain + loaded 3D geometry" : "Ready — no 3D geometry loaded; using terrain") : "Ready";
        this.setStatus(this.missing ? `${status3D} — missing terrain blocks flow; recalculate to retry.` : status3D);
    }

    updateBuildings() {
        if (this.buildingMeshes !== null) {
            this.buildings ??= new InundationBuildings(() => {
                this.appliedLevel = undefined;
                this.onChange?.();
            });
            this.buildings.update(this.buildingMeshes ?? [], this.geometry.maskRect, this.size, this.level,
                this.buildingMeshes?.requireCoverage ?? false);
            if (!this.buildings.ready) this.setStatus(this.buildings.error ?? "Calculating 3D geometry…");
        } else if (this.buildings) {
            this.buildings.dispose();
            this.buildings = null;
        }
    }

    suspend() {
        // Keep a completed grid for instant before/after comparisons. Cancel
        // unfinished work so hiding the water does not keep downloading tiles.
        if (!this.heights) this.dispose();
        else if (this.buildings && !this.buildings.ready) {
            this.buildings.dispose();
            this.buildings = null;
        }
    }

    dispose() {
        this.generation++;
        this.controller?.abort();
        this.buildings?.dispose();
        this.buildings = null;
        this.buildingMeshes = null;
        this.texture?.dispose();
        this.texture = null;
        this.geometry = null;
        this.map = null;
        this.heights = null;
        this.ocean = null;
        this.flowRoutes = null;
        this.appliedLevel = undefined;
        this.appliedBarriers = undefined;
    }
}
