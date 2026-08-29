// Global "Wind Tracer" fit — the drifting, slowly descending object reading of
// the sightlines, fitted with the camera's own pointing motion modelled rather
// than believed.
//
// The algorithm, why it is different from the existing Physics fit, and what it
// does and does not establish are all in src/WindTracerFit.js. In short: the
// trajectory's anchor is eliminated in closed form instead of being searched as
// an "initial range", and the operator's boresight wobble is absorbed by a
// band-limited nuisance basis that provably cannot represent the trajectory.
//
// The fit is synchronous and fast (a deterministic wind-rose seed plus a few
// Nelder-Mead passes, all with a closed-form inner solve), so unlike
// CNodeLOSFitPhysics there is no async guard here.

import {CNodeTrack} from "./CNodeTrack";
import {buildLOSDataset, unpackFitPositions} from "../LOSFitting";
import {fitWindTracer} from "../WindTracerFit";
import {abFrameRange} from "../TraverseAnalysisData";
import {guiMenus, NodeMan} from "../Globals";

const MS_TO_KTS = 1 / 0.514444;

export class CNodeLOSFitWindTracer extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        // NOTE the wind is deliberately NOT an input — see _windPrior().
        this.optionalInputs(["pointingSigma", "looseShear"]);
        this.array = [];
        this.solvedParams = null;
        this.guiFolder = null;
        this.guiDisplay = {};
        this._dirty = true;
        // Signature of the wind prior the last fit actually used, so a manual
        // wind edit or a change of wind source can re-trigger the fit without
        // the wind being a graph input. See _windSignature.
        this._windSignature = null;
    }

    // The wind is not an input (see _windPrior), so nothing cascades when the
    // user edits it. Poll instead: the prior is sampled at a FIXED reference
    // frame, so this signature does not move during playback for a track-driven
    // wind — it changes only when the wind itself does. trackWindAt caches its
    // time axis and bisects, so the per-frame cost is negligible.
    update(f) {
        super.update(f);
        if (!this.visible || this._dirty) return;
        if (this._windSignature !== null && this._windSignature !== this._windSignature_current()) {
            this._dirty = true;
        }
    }

    _windSignature_current() {
        const {signature} = this._resolveWind();
        return signature;
    }

    recalculate() {
        if (!this.visible) { this._dirty = true; return; }
        this._doCompute();
    }

    _doCompute() {
        this._dirty = false;
        this.array = [];
        this.frames = this.in.LOS.frames;
        if (this.frames < 1) { this.solvedParams = null; return; }
        // fitWindTracer needs 8 frames; below that there is nothing to fit.
        if (this.frames < 8) { this._fallbackTrack("fewer than 8 frames"); return; }

        const {frame0, frame1} = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS, frame0, frame1);

        const options = {
            sigmaPointDeg: this.in.pointingSigma ? this.in.pointingSigma.v0 : 0.4,
            looseShear: this.in.looseShear ? !!this.in.looseShear.v0 : false,
        };
        const {prior, signature} = this._resolveWind(frame0, frame1);
        this._windSignature = signature;
        if (prior) options.windPrior = prior;

        const result = fitWindTracer(dataset, options);
        if (!result) { this._fallbackTrack("the fit did not converge"); return; }

        this.solvedParams = result.params;
        this.array = unpackFitPositions(result.positions, dataset.count,
            originLat, originLon, dataset.frame0, this.frames)
            .map((p) => ({position: p.position}));
        this.updateGUI();
    }

    /**
     * The soft wind prior, sampled ONCE at a fixed reference frame.
     *
     * A measured wind pins the fitted drift loosely to the known winds aloft
     * rather than letting it slide slow to trade against range — the same
     * policy as SkyLanternModel.windPrior*. But the wind node must NOT be a
     * graph input here, for two reasons that both bite on a track-driven wind:
     *
     *  - CNodeWind.update(f) rewrites this.from/this.knots to the PLAYHEAD's
     *    wind and cascades on every MISB row change. As an input, that would
     *    fire a synchronous multi-second refit repeatedly during playback.
     *  - Reading those mutable fields would make the fitted trajectory depend on
     *    where playback happened to sit when the fit ran.
     *
     * So resolve the node by name (no dependency edge) and sample it with the
     * PURE frame-indexed accessor at the middle of the fitted window. CNodeWind
     * declines to take its own originTrack as an input for the same reason.
     *
     * The consequence, stated plainly: changing the wind does not re-fit on its
     * own. Nudge a Tracer slider, or re-select the method, to pick it up.
     */
    _resolveWind(frame0 = null, frame1 = null) {
        const wind = NodeMan.get("targetWind", false);
        if (!wind) return {prior: null, signature: "none"};
        if (frame0 === null) {
            const r = abFrameRange(this.in.LOS.frames);
            frame0 = r.frame0; frame1 = r.frame1;
        }
        const fRef = Math.round((frame0 + frame1) / 2);
        const hist = wind.trackWindAt ? wind.trackWindAt(fRef) : null;

        // TRACK-DRIVEN state is `trackSource`, not `originTrack`. The two are
        // unrelated: originTrack is only the frame of reference the wind is
        // expressed in (usually the target track), and a manual wind can have
        // one. Testing it would have let a track-driven node fall through to
        // this.from/this.knots — which update(f) rewrites to the PLAYHEAD's
        // wind — which is exactly the dependence this method exists to avoid.
        //
        // And trackWindAt() legitimately returns null on a track-driven node:
        // a track carrying wind SPEED but no DIRECTION has no usable sample at
        // any row. In that case there is no defensible prior at all, so take
        // none rather than silently reading the playhead.
        const trackDriven = !!wind.trackSource;
        if (trackDriven && !hist) {
            return {prior: null, signature: `track:${wind.trackSource}:nodata`};
        }
        const knots = hist ? hist.knots : (wind.knots ?? 0);
        const fromDeg = hist ? hist.from : (wind.from ?? 0);
        const signature = `${trackDriven ? `track:${wind.trackSource}` : "manual"}`
            + `:${Math.round(knots * 100)}:${Math.round(fromDeg * 100)}`;
        if (!(knots > 0)) return {prior: null, signature};
        const spd = knots * 0.514444;
        return {
            prior: [-spd * Math.sin(fromDeg * Math.PI / 180),
                    -spd * Math.cos(fromDeg * Math.PI / 180)],
            signature,
        };
    }

    /**
     * Every traverse node must serve a position for every frame — a menu option
     * that returns undefined breaks the display track, the graphs and the
     * export rather than showing a bad answer. When the fit cannot run (too few
     * frames) or cannot converge (a singular anchor solve), fall back to the
     * sightlines themselves at a nominal range, which is a valid track that is
     * obviously not a fit, and clear solvedParams so the result folder does not
     * report stale numbers.
     */
    _fallbackTrack(why) {
        this.solvedParams = null;
        const nominal = 5000;
        const points = new Array(this.frames).fill(null);
        let firstValid = -1;
        for (let f = 0; f < this.frames; f++) {
            const los = this.in.LOS.v(f);
            if (!los || !los.position || !los.heading) continue;
            points[f] = {position: los.position.clone().addScaledVector(los.heading, nominal)};
            if (firstValid < 0) firstValid = f;
        }
        if (firstValid < 0) {
            // The LOS yields nothing at any frame. There is genuinely no track
            // to serve; an array of nulls would be worse than an empty one.
            this.array = [];
            return;
        }
        // Hold across gaps, and back-fill any leading ones, so every frame has
        // a real position rather than a hole.
        for (let f = 0; f < firstValid; f++) points[f] = points[firstValid];
        for (let f = firstValid + 1; f < this.frames; f++) {
            if (!points[f]) points[f] = points[f - 1];
        }
        this.array = points;
        // The folder is created here as well as on success: a first-run failure
        // would otherwise display the 5 km fallback with no warning at all,
        // because updateGUI() only ever ran when there was a result to show.
        this._ensureGUI();
        if (this.guiFolder) {
            for (const key of Object.keys(this.guiDisplay)) this.guiDisplay[key] = "";
            this.guiDisplay.caveat = `no fit: ${why} — showing the sightlines at ${nominal} m`;
            this.guiFolder.open();
        }
    }

    /** Build the read-only result folder once, whatever the outcome. */
    _ensureGUI() {
        if (this.guiFolder || !guiMenus.traverse) return;
        this.guiFolder = guiMenus.traverse.addFolder("Wind Tracer Result").close();
        this.guiDisplay = {
            wind: "", drift: "", vertical: "", buoyancy: "",
            range: "", residual: "", pointing: "", caveat: "",
        };
        for (const key of Object.keys(this.guiDisplay)) {
            this.guiFolder.add(this.guiDisplay, key).listen().disable();
        }
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }

    // A read-only folder reporting what the fit solved for. Everything here is
    // a DERIVED quantity of the fit, not an input: it exists so the numbers a
    // reader would otherwise have to take on trust are visible, including the
    // ones that say the answer is weak.
    updateGUI() {
        const p = this.solvedParams;
        if (!p) return;
        this._ensureGUI();
        if (!this.guiFolder) return;
        const d = this.guiDisplay;
        d.wind = `${(p.windSpeed * MS_TO_KTS).toFixed(0)} kt from ${p.windFrom.toFixed(0)}°`;
        d.drift = `ground ${p.groundSpeedStart.toFixed(1)} → ${p.groundSpeedEnd.toFixed(1)} m/s`;
        d.vertical = `descends ${p.descentM.toFixed(0)} m, ${(-p.descentRateEnd).toFixed(2)} m/s at end`;
        d.buoyancy = `beta ${p.beta0.toFixed(3)}, vTerm ${p.vTerm.toFixed(2)} m/s, `
            + (p.flameOutInClip ? `flame-out at ${p.tOut.toFixed(0)} s` : "lit throughout");
        d.range = `${(p.rangeStart / 1000).toFixed(2)} → ${(p.rangeEnd / 1000).toFixed(2)} km`;
        d.residual = `${p.errDeg.toFixed(3)}° (${p.errRawDeg.toFixed(3)}° to boresight)`;
        d.pointing = p.operatorBand
            ? `modelled ≤ ${p.maxPointingDeg.toFixed(2)}°, band ${p.operatorBand[0]}-${p.operatorBand[1]} cyc `
              + `(sweep ${p.azimuthSweepCycles.toFixed(2)} cyc)`
            : "operator model off";
        // The one thing a reader must not miss.
        d.caveat = p.boundPinned.length
            ? `search incomplete: ${p.boundPinned.join(", ")}`
            : (p.azimuthSweepCycles < 0.25
                ? "narrow sweep: range rests on the priors"
                : "slow pointing drift is NOT removable");
    }
}
