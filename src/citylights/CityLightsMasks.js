import {DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace} from "three";

// One worker and at most two GPU masks for the normal main/look view pair.
// Construction is lazy: a disabled city-lights node starts no worker or fetch.
export class CityLightsMasks {
    constructor(onChange) {
        this.onChange = onChange;
        this.views = new Map();
        this.sequence = 0;
        this.worker = null;
    }

    start() {
        if (this.worker) return;
        const worker = new Worker(new URL("./CityLightsWorker.js", import.meta.url));
        this.worker = worker;
        worker.onmessage = ({data}) => {
            if (worker !== this.worker) return;
            const state = this.views.get(data.view);
            if (!state || state.id !== data.id) return;
            if (data.progress) {
                this.onChange(data.progress);
                return;
            }
            state.loading = false;
            if (data.error) {
                state.error = data.error;
                this.onChange("City lights unavailable — use Reload Lights to retry");
                console.warn("City lights:", data.error);
                return;
            }
            const texture = new DataTexture(new Uint8Array(data.pixels), data.meta.size, data.meta.size);
            texture.minFilter = LinearMipmapLinearFilter;
            texture.magFilter = LinearFilter;
            texture.generateMipmaps = true;
            texture.colorSpace = NoColorSpace;
            texture.flipY = false;
            texture.needsUpdate = true;
            state.texture?.dispose();
            Object.assign(state, {texture, meta: data.meta, stats: data.stats, error: null});
            this.onChange("Ready");
        };
        worker.onerror = error => {
            if (worker !== this.worker) return;
            for (const state of this.views.values()) {
                state.loading = false;
                state.error = error.message;
            }
            this.onChange("City lights unavailable — use Reload Lights to retry");
            console.warn("City lights worker:", error.message);
        };
    }

    get(view, region, roads, paths) {
        let state = this.views.get(view);
        if (!state) {
            if (this.views.size >= 2) {
                const [id, oldest] = this.views.entries().next().value;
                oldest.texture?.dispose();
                this.views.delete(id);
                this.worker?.postMessage({view: id, id: ++this.sequence, cancel: true});
            }
            state = {};
            this.views.set(view, state);
        }
        const signature = `${region.key}/${roads}/${paths}`;
        if (state.signature !== signature) {
            this.start();
            Object.assign(state, {signature, region, id: ++this.sequence, loading: true, error: null});
            this.worker.postMessage({view, id: state.id, region, roadFraction: roads / 100, pathFraction: paths / 100});
            this.onChange("Loading city lights…");
        }
        return state;
    }

    invalidate() {
        for (const state of this.views.values()) state.signature = null;
    }

    dispose() {
        this.worker?.terminate();
        this.worker = null;
        for (const state of this.views.values()) state.texture?.dispose();
        this.views.clear();
    }
}
