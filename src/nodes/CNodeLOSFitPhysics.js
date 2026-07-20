// Physics-model trajectory fit to LOS rays.
// Integrates a physical dynamics model with RK4 and optimizes its parameters
// against the LOS data — global differential evolution + Nelder-Mead polish
// for both models (their cost landscapes are multi-modal; a single-start
// simplex reliably falls into the wrong basin). The fit runs asynchronously;
// while it is computing, the node serves its last computed track (if any).

import {CNodeTrack} from "./CNodeTrack";
import {fitPhysicsModel, fitKalmanFilter, buildLOSDataset, unpackFitPositions} from "../LOSFitting";
import {SkyLanternModel} from "../SkyLanternModel";
import {FixedWingModel} from "../FixedWingModel";
import {QuadcopterModel} from "../QuadcopterModel";
import {fixedWingById, quadcopterById, classifyFixedWing, classifyQuadcopter} from "../VehicleModels";
import {abFrameRange} from "../TraverseAnalysisData";
import {guiMenus, setRenderOne, Sit} from "../Globals";
import {t} from "../i18n";

// Registry of available physics models
const physicsModels = {
    "Sky Lantern": new SkyLanternModel(),
    "Fixed Wing Aircraft": new FixedWingModel(),
    "Quadcopter": new QuadcopterModel(),
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
        this.optionalInputs(["physicsModel", "maxIter", "windSpeed", "windFrom", "initialRange",
            "quadModel", "fixedWingModel"]);
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

        // Capture everything from the inputs synchronously, before any await.
        // Fit the In/Out (A-B) window — the same range the traverse-analysis
        // gallery fits — and hold the endpoint positions outside it.
        const {frame0, frame1} = abFrameRange(frames);
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS, frame0, frame1);

        const modelName = this.in.physicsModel ? this.in.physicsModel.v0 : "Sky Lantern";
        const model = physicsModels[modelName];
        if (!model) return;

        // Apply the airframe / drone envelope from the make/model sub-dropdown.
        // AUTO (or no dropdown wired) leaves the model's generic envelope in
        // place; a specific entry tightens the fit bounds to that type. Remember
        // whether AUTO so we can classify the solved trajectory to the nearest
        // real model afterwards, and remember the selected entry to display it.
        this._autoModel = true;
        this._selectedVehicle = null;
        if (model instanceof FixedWingModel) {
            const entry = fixedWingById(this.in.fixedWingModel ? this.in.fixedWingModel.v0 : "auto");
            this._autoModel = !entry || !!entry.auto;
            model.envelope = this._autoModel ? null : entry;
            this._selectedVehicle = entry;
        } else if (model instanceof QuadcopterModel) {
            const entry = quadcopterById(this.in.quadModel ? this.in.quadModel.v0 : "auto");
            this._autoModel = !entry || !!entry.auto;
            model.envelope = this._autoModel ? null : entry;
            this._selectedVehicle = entry;
        }

        const options = {};
        if (this.in.maxIter) options.maxIter = this.in.maxIter.v0;

        // Multi-modal cost landscapes (both models): global DE search then
        // polish. Strided cost sampling keeps the many DE evaluations fast.
        // Same settings as the traverse-analysis gallery's fits, so applying
        // a gallery physics tile starts from comparable deterministic assumptions.
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
        if (model instanceof FixedWingModel || model instanceof QuadcopterModel) {
            // pin the solved wind softly to the guess (or leave it free if
            // there is no wind guess wired)
            model.windPriorE = overrides.windE ?? null;
            model.windPriorN = overrides.windN ?? null;
        }
        if (this.in.initialRange) {
            overrides.initialRange = this.in.initialRange.v0;
        }
        // Sky Lantern parity with the analysis gallery (TA-05): the gallery
        // enables the model's time-varying wind (clipDuration) and seeds it from
        // the Kalman smoother, without which the extra wind freedom is
        // unsearchable and the fit REGRESSES. Mirror both here so applying or
        // re-running a gallery balloon uses the same forward model. The KS seed
        // only fills parameters the user has not explicitly overridden (their
        // wind guess / initial range still win).
        if (model instanceof SkyLanternModel) {
            model.clipDuration = dataset.count > 1
                ? (dataset.times[dataset.count - 1] - dataset.times[0]) : null;
            try {
                // Range floor on the CV seed so the smoother cannot collapse onto
                // the sensor path (see the gallery's KS_SEED_MIN_RANGE / TA-03).
                const ks = fitKalmanFilter({...dataset, minRange: 500}, new Set(), {});
                let ksFinite = !!(ks && ks.positions);
                if (ksFinite) for (let i = 0; i < ks.positions.length; i++) {
                    if (!Number.isFinite(ks.positions[i])) { ksFinite = false; break; }
                }
                if (ksFinite) {
                    // buildLOSDataset already exposes sensorPos/losDir/times/count,
                    // exactly what seedFromTrack reads.
                    model.seedFromTrack(Float64Array.from(ks.positions), dataset);
                    const sv = model.seedParams();
                    if (sv) model.getParameterDefs().forEach((d, i) => {
                        if (overrides[d.name] === undefined) overrides[d.name] = sv[i];
                    });
                }
            } catch (e) {
                console.warn("Sky Lantern KS seed failed; fitting unseeded:", e);
            }
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

            this.array = unpackFitPositions(result.positions, dataset.count, originLat, originLon,
                frame0, frames);
            this.frames = frames;
            this._fitFrames = dataset.count;   // fitted A-B window length (for GUI durations)

            // When the make/model dropdown is AUTO, name the nearest real
            // airframe/drone the solved trajectory is most like (from its
            // solved speed/climb), so the readout can report "Closest: F/A-18".
            this._classified = null;
            if (this._autoModel) {
                const s = result.params.solved;
                const T = dataset.count > 1 ? dataset.times[dataset.count - 1] - dataset.times[0] : 1;
                if (model instanceof FixedWingModel) {
                    const classified = classifyFixedWing(Math.hypot(s.tas, s.climb), s.climb);
                    this._classified = classified.compatible ? classified.model : null;
                } else if (model instanceof QuadcopterModel) {
                    const peakSpeed = Math.max(Math.abs(s.speed), Math.abs(s.speed + s.accel * T));
                    // Signed climb so descents are checked against maxDescent.
                    const classified = classifyQuadcopter(peakSpeed, s.climb);
                    this._classified = classified.compatible ? classified.model : null;
                }
            }

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

        // Which make/model constrained the fit (specific dropdown choice), or —
        // when AUTO — the nearest real airframe/drone the solution resembles.
        if (this._selectedVehicle && !this._autoModel) {
            this.guiDisplay._vehicle = this._selectedVehicle.name;
            this.guiFolder.add(this.guiDisplay, "_vehicle").name("Selected envelope prior").disable();
        } else if (this._classified) {
            this.guiDisplay._vehicle = "≈ " + this._classified.name;
            this.guiFolder.add(this.guiDisplay, "_vehicle").name("Closest compatible envelope").disable();
        }

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
            this.guiFolder.add(this.guiDisplay, "_heading").name("Heading (origin ENU)").disable();
            this.guiFolder.add(this.guiDisplay, "_tas").name("Horizontal airspeed").disable();
            this.guiFolder.add(this.guiDisplay, "_turnRate").name("Turn Rate").disable();
            this.guiFolder.add(this.guiDisplay, "_turnAccel").name("Turn Accel").disable();
            this.guiFolder.add(this.guiDisplay, "_climb").name("Climb").disable();
        } else if (model instanceof QuadcopterModel) {
            // Friendly readout for the multirotor solution. A quad's speed can
            // change over the clip (it can spin up from hover), so show both the
            // starting speed and the peak.
            const heading = ((solved.headingDeg % 360) + 360) % 360;
            const nFit = this._fitFrames ?? this.frames;
            const T = nFit > 1
                ? (nFit - 1) * (Sit.simSpeed ?? 1) / Sit.fps : 1;
            const peak = Math.max(Math.abs(solved.speed), Math.abs(solved.speed + solved.accel * T));
            this.guiDisplay._range = solved.initialRange.toFixed(0) + " m";
            this.guiDisplay._heading = heading.toFixed(1) + "°";
            this.guiDisplay._speed = (solved.speed / KTS_TO_MS).toFixed(1) + " kt / "
                + solved.speed.toFixed(1) + " m/s";
            this.guiDisplay._peak = peak.toFixed(1) + " m/s (peak)";
            this.guiDisplay._climb = solved.climb.toFixed(1) + " m/s ("
                + (solved.climb * MS_TO_FPM).toFixed(0) + " ft/min)";
            this.guiFolder.add(this.guiDisplay, "_range").name("Start Range").disable();
            this.guiFolder.add(this.guiDisplay, "_heading").name("Heading (origin ENU)").disable();
            this.guiFolder.add(this.guiDisplay, "_speed").name("Start Speed").disable();
            this.guiFolder.add(this.guiDisplay, "_peak").name("Peak Speed").disable();
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
