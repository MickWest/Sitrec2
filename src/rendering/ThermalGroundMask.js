import {DataTexture, LinearFilter, NoColorSpace} from "three";
import {cityLightsRegion, cityLightsRegionContains} from "../citylights/CityLightsRegion";

// Texels of the thermal ground mask: 2048 over the 8-32 km region gives 4-16 m per texel; a narrower road becomes a
// fractional coverage, which is the weight the shader needs.
export const THERMAL_GROUND_MASK_SIZE = 2048;

// Mapped roads, paths and building footprints around the thermal camera's target, from the same open map vector tiles
// as City lights, rasterized in its worker. Lazy: no worker or fetch until a view asks for a mask.
export class ThermalGroundMask {
    constructor(onChange = () => {}) {
        this.onChange = onChange;
        this.worker = null;
        this.sequence = 0;
        this.state = {texture: null, rect: null, region: null, loading: false, error: null, stats: null};
    }

    _start() {
        if (this.worker) return;
        const worker = new Worker(new URL("../citylights/CityLightsWorker.js", import.meta.url));
        this.worker = worker;
        worker.onmessage = ({data}) => {
            if (worker !== this.worker || data.id !== this.sequence) return;
            if (data.progress) return;
            const state = this.state;
            state.loading = false;
            if (data.error) {
                state.error = data.error;
                console.warn("Thermal ground mask:", data.error);
                this.onChange();
                return;
            }
            const texture = new DataTexture(new Uint8Array(data.pixels), data.meta.size, data.meta.size);
            texture.minFilter = texture.magFilter = LinearFilter;
            texture.generateMipmaps = false;
            texture.colorSpace = NoColorSpace;
            texture.flipY = false;
            texture.needsUpdate = true;
            state.texture?.dispose();
            Object.assign(state, {texture, rect: state.region.rect, stats: data.stats, error: null});
            this.onChange();
        };
        worker.onerror = error => {
            if (worker !== this.worker) return;
            Object.assign(this.state, {loading: false, error: error.message});
            console.warn("Thermal ground mask worker:", error.message);
            this.onChange();
        };
    }

    // The mask state for a ground point (degrees) seen from heightM above it. A new region is requested only when the
    // point nears the current region's edge; the previous mask stays in use while the next one loads.
    get(lat, lon, heightM) {
        const state = this.state;
        if (state.region && (state.loading || state.texture || state.error) && cityLightsRegionContains(state.region, lat, lon)) return state;
        const region = {...cityLightsRegion(lat, lon, heightM), size: THERMAL_GROUND_MASK_SIZE};
        this._start();
        Object.assign(state, {region, loading: true, error: null});
        this.worker.postMessage({view: "thermalGround", id: ++this.sequence, region, thermalGround: true});
        return state;
    }

    dispose() {
        this.worker?.terminate();
        this.worker = null;
        this.state.texture?.dispose();
        this.state.texture = null;
    }
}
