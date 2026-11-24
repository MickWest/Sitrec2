import {DataTexture, NearestFilter, RedFormat, UnsignedByteType} from "three";
import {loadOceanMaskRegion} from "../WaterMaskGeo";
import {connectedInundation, latitudeAtMercatorY} from "./InundationGrid";
import {loadInundationTerrain} from "./InundationTerrain";

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
        this.status = status;
        this.onChange?.();
    }

    update(geometry, map, widthMeters, level) {
        this.level = level;
        if (geometry !== this.geometry || map !== this.map || this.scale !== map?.options.zScale) {
            this.dispose();
            this.geometry = geometry;
            this.map = map;
            this.scale = map?.options.zScale;
            this.controller = new AbortController();
            this.build(geometry.maskRect, widthMeters, this.generation, this.controller.signal);
        }
        if (this.heights && this.appliedLevel !== level) this.fill();
        return this.texture;
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
            this.fill();
        } catch (error) {
            if (!signal.aborted && generation === this.generation) this.setStatus(error.message);
        } finally {
            oceanTexture?.dispose();
        }
    }

    fill() {
        connectedInundation(this.heights, this.ocean, this.size, this.size, this.level, this.texture.image.data);
        this.texture.needsUpdate = true;
        this.appliedLevel = this.level;
        this.setStatus(this.missing ? "Ready — missing terrain blocks flow; recalculate to retry." : "Ready");
    }

    suspend() {
        // Keep a completed grid for instant before/after comparisons. Cancel
        // unfinished work so hiding the water does not keep downloading tiles.
        if (!this.heights) this.dispose();
    }

    dispose() {
        this.generation++;
        this.controller?.abort();
        this.texture?.dispose();
        this.texture = null;
        this.geometry = null;
        this.map = null;
        this.heights = null;
        this.ocean = null;
        this.appliedLevel = undefined;
    }
}
