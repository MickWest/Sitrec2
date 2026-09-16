// Async, fixed-budget blind Monte Carlo traverses. The switch remains synchronous:
// it reads a labelled temporary ray path until the GPU fit lands, then its
// consumers recalculate. A generation token prevents obsolete fits being applied.
import {CNodeTrack} from "./CNodeTrack";
import {abFrameRange, buildAnalysisDataset} from "../TraverseAnalysisData";
import {unpackFitPositions} from "../LOSFitting";
import {fitMonteCarloGPU} from "../gpu/MonteCarloLOS";
import {MONTE_CARLO_IDS, monteCarloName} from "../MonteCarloLOS";
import {guiMenus, setRenderOne} from "../Globals";

export class CNodeLOSFitMonteCarloGPU extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.preset = v.preset ?? "mc_50k";
        if (!MONTE_CARLO_IDS.includes(this.preset)) throw new Error(`Unknown Monte Carlo preset: ${this.preset}`);
        this.frames = this.in.LOS.frames;
        this.array = [];
        this.visible = false;
        this._dirty = true;
        this._computing = false;
        this._generation = 0;
        this._disposed = false;
        this.solvedParams = null;
        this.guiDisplay = {status: "Not fitted", error: "—", duration: "—"};
        this.guiFolder = null;
    }

    _status(text) {
        this.guiDisplay.status = text;
        if (!this.visible || !guiMenus.traverse) return;
        if (!this.guiFolder) {
            this.guiFolder = guiMenus.traverse.addFolder(monteCarloName(this.preset)).open();
            this.guiControllers = [
                this.guiFolder.add(this.guiDisplay, "status").name("Status").disable(),
                this.guiFolder.add(this.guiDisplay, "error").name("Mean error (deg)").disable(),
                this.guiFolder.add(this.guiDisplay, "duration").name("Fit time (ms)").disable(),
            ];
        }
        for (const control of this.guiControllers) control.updateDisplay();
        this.guiControllers[0].tooltip(text);
    }

    _clearGUI() {
        this.guiFolder?.destroy();
        this.guiFolder = null;
    }

    show(visible = true) {
        const wasVisible = this.visible;
        super.show(visible);
        if (!visible) {
            if (this._computing) { this._generation++; this._dirty = true; }
            this._clearGUI();
        } else if (this.guiDisplay) {
            // Hidden switch inputs do not receive every upstream recalculate.
            // Selecting this solver again must fit the current LOS and timebase.
            if (!wasVisible) {
                this._generation++;
                this._dirty = true;
                this.solvedParams = null;
                this.guiDisplay.status = "Not fitted";
            }
            this._status(this.guiDisplay.status);
        }
    }

    recalculate() {
        this._generation++;
        this._dirty = true;
        this.solvedParams = null;
        if (this.visible) this._ensureFit();
    }

    _ensureFit() {
        if (this._dirty && !this._computing && !this._disposed) this._fitPromise = this._compute();
    }

    async _compute() {
        this._computing = true;
        this._dirty = false;
        const generation = this._generation;
        const stale = () => this._disposed || generation !== this._generation;
        try {
            this.frames = this.in.LOS.frames;
            this.solvedParams = null;
            this.guiDisplay.error = "—";
            this.guiDisplay.duration = "—";
            this.array = Array.from({length: this.frames}, (_, f) => {
                const los = this.in.LOS.v(f);
                return {position: los.position.clone().addScaledVector(los.heading, 1000)};
            });
            this._status("Fitting — temporary 1 km path");
            const {frame0, frame1} = abFrameRange(this.frames);
            const {dataset, originLat, originLon} = buildAnalysisDataset(this.in.LOS, null, undefined, {frame0, frame1});
            const result = await fitMonteCarloGPU(dataset, new Set(), {
                preset: this.preset, shouldCancel: stale,
                onProgress: fraction => { if (!stale()) this._status(`Fitting ${Math.round(100 * fraction)}% — temporary 1 km path`); },
            });
            if (stale()) return;
            if (!result) throw new Error("Too few observations");
            this.array = unpackFitPositions(result.positions, dataset.n, originLat, originLon, frame0, this.frames);
            this.solvedParams = result.params;
            this.guiDisplay.error = (result.params.bestScore * 180 / Math.PI).toFixed(6);
            this.guiDisplay.duration = result.params.timing.totalMs.toFixed(1);
            this._status("Ready (WebGPU)");
            for (const output of this.outputs) output.recalculateCascade();
            setRenderOne(true);
        } catch (e) {
            if (!stale()) {
                this._status(`Unavailable: ${e.message} — temporary 1 km path`);
                console.warn(`${monteCarloName(this.preset)}: ${e.message}`);
            }
        } finally {
            this._computing = false;
            if (this._dirty && this.visible && !this._disposed) queueMicrotask(() => this._ensureFit());
        }
    }

    getValue(f) {
        this._ensureFit();
        if (!this.array.length) return undefined;
        return super.getValue(f);
    }

    getValueFrame(f) {
        this._ensureFit();
        return this.array[Math.floor(f)];
    }

    dispose() {
        this._disposed = true;
        this._generation++;
        this._clearGUI();
        super.dispose();
    }
}
