// Physics-model trajectory fit to LOS rays.
// Integrates a physical dynamics model with RK4 and optimizes its parameters
// against the LOS data — global differential evolution + Nelder-Mead polish
// for both models (their cost landscapes are multi-modal; a single-start
// simplex reliably falls into the wrong basin). The fit runs asynchronously;
// while it is computing, the node serves its last computed track (if any).

import {CNodeTrack} from "./CNodeTrack";
import {fitPhysicsModel, buildLOSDataset, unpackFitPositions} from "../LOSFitting";
import {ChineseLanternModel} from "../ChineseLanternModel";
import {FixedWingModel} from "../FixedWingModel";
import {guiMenus, setRenderOne} from "../Globals";
import {t} from "../i18n";

// Registry of available physics models
const physicsModels = {
    "Chinese Lantern": new ChineseLanternModel(),
    "Fixed Wing Aircraft": new FixedWingModel(),
};

export function getPhysicsModelNames() {
    return Object.keys(physicsModels);
}

const KTS_TO_MS = 0.514444;
const MS_TO_FPM = 60 / 0.3048; // m/s -> ft/min

export class CNodeLOSFitPhysics extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.optionalInputs(["physicsModel", "maxIter", "windSpeed", "windFrom", "initialRange"]);
        this.array = [];
        this.solvedParams = null;
        this.guiFolder = null;
        this.guiDisplay = {};
        this._dirty = true;
        this._computing = false;
    }

    recalculate() {
        if (!this.visible) { this._dirty = true; return; }
        this._doCompute();
    }

    // Async fit. Guarded against concurrent runs: a call while a fit is in
    // flight just flags the node dirty so the next access re-runs it with
    // fresh inputs. this.frames/this.array are only updated together when a
    // fit lands, so consumers always see a consistent (possibly stale) track.
    // Never rejects (errors are logged).
    async _doCompute() {
        if (this._computing) {
            this._dirty = true;
            return;
        }
        this._dirty = false;
        const frames = this.in.LOS.frames;
        if (frames < 2) {
            this.frames = 0;
            this.array = [];
            this.solvedParams = null;
            return;
        }

        // Capture everything from the inputs synchronously, before any await
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS);

        const modelName = this.in.physicsModel ? this.in.physicsModel.v0 : "Chinese Lantern";
        const model = physicsModels[modelName];
        if (!model) return;

        const options = {};
        if (this.in.maxIter) options.maxIter = this.in.maxIter.v0;

        // Multi-modal cost landscapes (both models): global DE search then
        // polish. Strided cost sampling keeps the many DE evaluations fast.
        // Same settings as the traverse-analysis gallery's fits, so applying
        // a gallery physics tile reproduces (statistically) the same track.
        options.optimizer = "de";
        options.sampleStride = 5;
        options.dePop = 48;
        options.deGens = 120;

        const overrides = {};
        if (this.in.windSpeed && this.in.windFrom) {
            const speedMs = this.in.windSpeed.v0 * KTS_TO_MS;
            const fromDeg = this.in.windFrom.v0;
            const towardRad = (fromDeg + 180) * Math.PI / 180;
            overrides.windE = speedMs * Math.sin(towardRad);
            overrides.windN = speedMs * Math.cos(towardRad);
        }
        if (model instanceof FixedWingModel) {
            // pin the solved wind softly to the guess (or leave it free if
            // there is no wind guess wired)
            model.windPriorE = overrides.windE ?? null;
            model.windPriorN = overrides.windN ?? null;
        }
        if (this.in.initialRange) {
            overrides.initialRange = this.in.initialRange.v0;
        }
        if (Object.keys(overrides).length > 0) {
            options.paramOverrides = overrides;
        }

        // The fit is async, but a recalculate cascade will read this node
        // synchronously (e.g. airTrack the instant this becomes the selected
        // traverse). If we have no previous fit to serve, fill the track with
        // a cheap placeholder — points along each ray at the initial-range
        // guess — so downstream consumers always see valid positions. The
        // real fit replaces it and triggers a re-render when it lands.
        if (this.array.length !== frames) {
            const placeholderRange = this.in.initialRange ? this.in.initialRange.v0 : 3000;
            const placeholder = [];
            for (let f = 0; f < frames; f++) {
                const los = this.in.LOS.v(f);
                placeholder.push({
                    position: los.position.clone()
                        .add(los.heading.clone().multiplyScalar(placeholderRange)),
                });
            }
            this.array = placeholder;
            this.frames = frames;
        }

        this._computing = true;
        try {
            const result = await fitPhysicsModel(dataset, new Set(), model, options);
            if (!result) {
                // keep serving the placeholder/stale track — clearing here
                // would crash synchronous downstream consumers
                this.solvedParams = null;
                return;
            }

            this.solvedParams = result.params;
            console.log("Physics fit:", model.getName(),
                "cost:", result.params.cost.toFixed(4),
                "errDeg:", result.params.errDeg.toFixed(6),
                "params:", result.params.solved);

            this.array = unpackFitPositions(result.positions, frames, originLat, originLon);
            this.frames = frames;

            this.updateGUI(model, result.params);

            // The fit ran asynchronously, so the traverse switch already
            // cascaded the PLACEHOLDER track to downstream consumers (airTrack,
            // display track, g-force / distance graphs) before the solution
            // existed — they baked the placeholder and setRenderOne alone would
            // just redraw that stale data. Recalculate from our consumers (the
            // switch etc.), NOT from this node, so the finished track propagates
            // without re-entering the fit.
            if (this.outputs && this.outputs.length) {
                this.outputs.forEach(o => o.recalculateCascade());
            } else {
                setRenderOne(true);
            }
        } catch (e) {
            console.warn("CNodeLOSFitPhysics fit failed:", e);
        } finally {
            this._computing = false;
        }
    }

    updateGUI(model, fitParams) {
        if (!guiMenus.traverse) return;

        // Destroy previous folder if it exists
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }

        this.guiFolder = guiMenus.traverse.addFolder(t("losFitPhysics.folder")).close();
        this.guiDisplay = {};

        // Use strings for all display values to avoid lil-gui NumberController step requirement
        this.guiDisplay._model = fitParams.model;
        this.guiFolder.add(this.guiDisplay, "_model").name(t("losFitPhysics.model.label")).disable();

        // Fit quality: mean angular error in degrees (full resolution),
        // separate from the composite cost (which includes plausibility terms)
        if (fitParams.errDeg !== undefined && !isNaN(fitParams.errDeg)) {
            this.guiDisplay._errDeg = fitParams.errDeg.toFixed(4) + "°";
            this.guiFolder.add(this.guiDisplay, "_errDeg").name(t("losFitPhysics.avgError.label")).disable();
        }
        this.guiDisplay._cost = fitParams.cost.toFixed(4);
        this.guiFolder.add(this.guiDisplay, "_cost").name("Fit Cost").disable();

        // Wind speed and direction derived from E/N components
        const solved = fitParams.solved;
        if (solved.windE !== undefined && solved.windN !== undefined) {
            const windSpeedMs = Math.sqrt(solved.windE ** 2 + solved.windN ** 2);
            const windSpeedKt = windSpeedMs / KTS_TO_MS;
            const windFromDeg = (Math.atan2(-solved.windE, -solved.windN) * 180 / Math.PI + 360) % 360;
            this.guiDisplay._windSpeed = windSpeedKt.toFixed(1);
            this.guiDisplay._windFrom = windFromDeg.toFixed(1);
            this.guiFolder.add(this.guiDisplay, "_windSpeed").name(t("losFitPhysics.windSpeed.label")).disable();
            this.guiFolder.add(this.guiDisplay, "_windFrom").name(t("losFitPhysics.windFrom.label")).disable();
        }

        if (model instanceof FixedWingModel) {
            // Friendly aviation units for the fixed-wing solution
            const heading = ((solved.headingDeg % 360) + 360) % 360;
            this.guiDisplay._range = (solved.initialRange / 1852).toFixed(2) + " NM";
            this.guiDisplay._heading = heading.toFixed(1) + "°";
            this.guiDisplay._tas = (solved.tas / KTS_TO_MS).toFixed(1) + " kt";
            this.guiDisplay._turnRate = solved.turnRate.toFixed(3) + " °/s";
            this.guiDisplay._turnAccel = solved.turnAccel.toFixed(4) + " °/s²";
            this.guiDisplay._climb = solved.climb.toFixed(1) + " m/s ("
                + (solved.climb * MS_TO_FPM).toFixed(0) + " ft/min)";
            this.guiFolder.add(this.guiDisplay, "_range").name("Start Range").disable();
            this.guiFolder.add(this.guiDisplay, "_heading").name("Heading").disable();
            this.guiFolder.add(this.guiDisplay, "_tas").name("TAS").disable();
            this.guiFolder.add(this.guiDisplay, "_turnRate").name("Turn Rate").disable();
            this.guiFolder.add(this.guiDisplay, "_turnAccel").name("Turn Accel").disable();
            this.guiFolder.add(this.guiDisplay, "_climb").name("Climb").disable();
        } else {
            // Generic dump of all solved parameters as strings
            const paramDefs = model.getParameterDefs();
            for (const def of paramDefs) {
                const val = solved[def.name];
                if (val !== undefined) {
                    const key = def.name;
                    this.guiDisplay[key] = val.toFixed(4);
                    this.guiFolder.add(this.guiDisplay, key).name(key).disable();
                }
            }
        }
    }

    // Kick off a deferred fit, but never block: while dirty/computing,
    // serve the last computed value (or undefined if none yet). The
    // async fit calls setRenderOne when it lands.
    getValue(f) {
        if (this._dirty && !this._computing) this._doCompute();
        // base getValue probes getValueFrame(0).position, which would throw
        // while an async fit is pending with no previous result
        if (this.array.length === 0) return undefined;
        return super.getValue(f);
    }

    getValueFrame(f) {
        if (this._dirty && !this._computing) this._doCompute();
        return this.array[Math.floor(f)];
    }

    dispose() {
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
        super.dispose();
    }
}
