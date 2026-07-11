import {CNode, CNodeOrigin} from "./CNode";
import {metersPerSecondFromKnots, radians} from "../utils";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {DebugArrowAB} from "../threeExt";
import {GlobalScene} from "../LocalFrame";
import {getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {assert} from "../assert";
import {V3} from "../threeUtils";
import {t} from "../i18n";
import {MISB} from "../MISBUtils";
import {normalizeWindTimestampMs} from "./WindHelpers";

export class CNodeWind extends CNode {
    constructor(v, _guiMenu) {
        super(v);

        
        this.setGUI(v, _guiMenu)

        this.from = v.from;  // true heading of the wind soruce. North = 0
        this.knots = v.knots
        this.name = v.name ?? v.id // if no name is supplied, use the id

        this.max = v.max ?? 200;

        // this.input("pos")
        // this.input("radius")

        if(this.gui) {
            const onManualWindEdit = () => {
                this.recalculateCascade();
                // In manual mode, the windField grid is built from this
                // node's from/knots (see _fillFromManual). Changing the
                // values here doesn't propagate via the CNode graph (the
                // wind field doesn't have us as an input — that would
                // create a circular dependency with track-driven winds),
                // so re-fill the grid + streamlines explicitly. Skip if
                // the wind field hasn't materialized yet (no windU): the
                // first Show Wind Lines toggle will pick up the latest
                // values anyway.
                if (NodeMan.exists("windField")) {
                    const wf = NodeMan.get("windField");
                    if (wf.source === "manual" && wf.windU) {
                        wf.fetchWindForAltitude(wf.windAltFt);
                    }
                }
            };
            this.guiFrom = this.gui.add (this, "from", 0,359,1).name(this.name+" Wind From").tooltip(t("misc.windFrom.tooltip")).onChange(onManualWindEdit).wrap()
            this.guiKnots = this.gui.add (this, "knots", 0, this.max, 1).name(this.name+" Wind Knots").tooltip(t("misc.windKnots.tooltip")).onChange(onManualWindEdit)
        }

       // this.optionalInputs(["originTrack"])
        // wind defaults to being in the frame of reference of the ECEF origin (Earth center)
        this.position=V3(0,0,0);



        // we can't use originTrack as an input as typically it's going to be something like the
        // target position, which then depends on the wind, which depends on the target position
        // so in the update function we can just get the zero frame position of the origin track
        // the zero frame will NOT have any wind applied, as that time dependent (and the zero frame has t=0)
        this.originTrack = v.originTrack; // optional, if supplied, the wind is in the frame of reference of the track
        // Manual per-node Open-Meteo fetch used to live here as a "[BETA]
        // Fetch ... Wind" button. Superseded by the Wind Data folder
        // (Source=open-meteo + Refresh) which drives this node via
        // propagateToWindNodes.

        // Optional MISB-track source. When set to a TrackData_<shortName> id,
        // update(f) reads MISB WindDirection/WindSpeed at frame f and writes
        // them into from/knots — overriding the manual GUI value. Cleared
        // when the user picks any non-track source from the wind GUI.
        this.trackSource = v.trackSource ?? null;
        this._ptsAxisCache = null;
        this.simpleSerials.push("trackSource");

        // forcing extra intial recalculate cascades (only of there's an origin track)
        // this is to ensure that the wind is in the correct frame of reference
        // bit of a patch, but it works. Really need to sort out the initialization order here
        this.extraRecalculate = 2;

        this.lock = v.lock;

        this.recalculate()
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            from: this.from,
            knots: this.knots,
            name: this.name,
            max: this.max,
            lock: this.lock,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.from = v.from;
        this.knots = v.knots;
        this.name = v.name;
        this.max = v.max;
        this.lock = v.lock;
        this.guiFrom.updateDisplay()
        this.guiKnots.updateDisplay()
    }

    // // hide and show will be called from a switch node
    // hide() {
    //     super.hide()
    //     this.guiFrom.hide()
    //     this.guiKnots.hide()
    //     return this;
    //
    // }

    show(visible=true) {
        super.show(visible)
        this.guiFrom.show(visible)
        this.guiKnots.show(visible)
        return this;
    }

    // The "hide inactive inputs" cascade walks downward from each Switch
    // and hides any input whose downstream consumers are all hidden. For
    // wind nodes that's the wrong behavior — Target / Local Wind From/
    // Knots are user-facing fields the user expects to see *and edit*
    // even when no current Switch happens to be reading the node (e.g.
    // when the camera-track switch picks a non-track-driven choice).
    //
    // Make hide() a no-op so the cascade can't hide us. The Lock Target
    // Wind to Local logic uses show(false) directly to hide targetWind
    // when locked — that explicit user-driven path still works because
    // show() is unaffected.
    hide() {
        // intentionally empty — see comment above
    }

    setPosition(pos) {
        assert(!isNaN(pos.x) && !isNaN(pos.y) && !isNaN(pos.z), "Setting Wind position has NaNs");
        this.position = pos.clone();
    }

    // returns a pre-frame wind vector, indicating wind motion for that frame
    // in ECEF coordinates
    // optionally supply a position to get the wind at that position
    // with reference to local north and up vectors
    getValueFrame(f, position) {

        // if no position is supplied, use the current position
        // fine for a target that does not move much, but if the target moves a lot, then
        // we should supply the position of the target at the time of the frame
        if (position === undefined) {
            position = this.position;
        }

        //let wind = V3(0, 0, -metersPerSecondFromKnots(this.knots) / Sit.fps);
        //const posUp = V3(0, 1, 0)
        const hist = this.trackWindAt(f);
        const from = hist ? hist.from : this.from;
        const knots = hist ? hist.knots : this.knots;
        let wind = getLocalNorthVector(position)
        wind.multiplyScalar(metersPerSecondFromKnots(knots)
            * (Sit.simSpeed ?? 1) / Sit.fps)
        const posUp = getLocalUpVector(position)
        wind.applyAxisAngle(posUp, radians(180-from))

        // assert no NaNs in the wind vector
        assert(!isNaN(wind.x) && !isNaN(wind.y) && !isNaN(wind.z), "Wind vector has NaNs");

        return wind;
    }


    // PURE historical lookup of the track-driven wind at frame f, or null when
    // no track drives this node. Same misb-row mapping as update(f), but with
    // no mutation/cascade side effects. The traverse analysis samples the whole
    // clip through this — getValueFrame ignores its frame argument and always
    // returns the CURRENT playhead wind, which silently repeated one wind value
    // across the entire analysed clip for track-driven winds.
    trackWindAt(f) {
        if (this.trackSource && NodeMan.exists(this.trackSource)) {
            const td = NodeMan.get(this.trackSource);
            const misb = td?.misb;
            if (Array.isArray(misb) && misb.length > 0) {
                // Match CNodeMISBData.getTime(): ST 0601 timestamps are usually
                // microseconds, while converted CSV tracks may contain seconds
                // or milliseconds. Comparing raw microseconds with the sitch's
                // millisecond clock otherwise pins every lookup to row zero.
                const wallTimeOf = (row, index) => {
                    if (typeof td.getTime === "function") {
                        const value = td.getTime(index);
                        if (Number.isFinite(value)) return value;
                    }
                    return normalizeWindTimestampMs(row && row[MISB.UnixTimeStamp]);
                };

                // Synchronous MISB/video pairs are associated on their shared
                // PES clock elsewhere in Sitrec. Use that same axis for wind so
                // dropped frames or encoder-clock drift do not move the wind to
                // a different sample than the platform track.
                const videoData = NodeMan.get("video", false)?.videoData;
                const framePTSus = videoData?.framePTSus;
                const recordPTSus = misb.pesPTSus;
                const realVideoPTS = framePTSus && framePTSus.length > 0
                    && (typeof videoData.hasRealFramePTS !== "function" || videoData.hasRealFramePTS());
                if (!this._ptsAxisCache || this._ptsAxisCache.values !== recordPTSus
                    || this._ptsAxisCache.length !== recordPTSus?.length) {
                    let monotonic = Array.isArray(recordPTSus) && recordPTSus.length === misb.length;
                    if (monotonic) {
                        for (let i = 0; i < recordPTSus.length; i++) {
                            if (!Number.isFinite(recordPTSus[i])
                                || (i > 0 && recordPTSus[i] < recordPTSus[i - 1])) {
                                monotonic = false;
                                break;
                            }
                        }
                    }
                    this._ptsAxisCache = {values: recordPTSus, length: recordPTSus?.length, monotonic};
                }
                const usePTS = !!(realVideoPTS && this._ptsAxisCache.monotonic
                    && recordPTSus.length > 1
                    && recordPTSus[recordPTSus.length - 1] > recordPTSus[0]);
                const timeOf = usePTS
                    ? (_row, index) => recordPTSus[index] / 1000
                    : wallTimeOf;
                const firstT = timeOf(misb[0], 0);
                const lastT = timeOf(misb[misb.length - 1], misb.length - 1);
                // The PES axis is monotonicity-validated above; the wall-clock
                // axis needs the same guard or a merged/multi-source track
                // with out-of-order timestamps feeds an unsorted axis to the
                // bisection below and returns an arbitrary row. Non-finite
                // rows are tolerated (sparse data); a finite value moving
                // backwards drops this track to the frame-mapped fallback.
                let wallMonotonic = true;
                if (!usePTS) {
                    if (!this._wallAxisCache || this._wallAxisCache.misb !== misb
                        || this._wallAxisCache.length !== misb.length) {
                        let monotonic = true;
                        let prev = -Infinity;
                        for (let i = 0; i < misb.length; i++) {
                            const t = wallTimeOf(misb[i], i);
                            if (!Number.isFinite(t)) continue;
                            if (t < prev) { monotonic = false; break; }
                            prev = t;
                        }
                        this._wallAxisCache = {misb, length: misb.length, monotonic};
                    }
                    wallMonotonic = this._wallAxisCache.monotonic;
                }
                let lo;
                let hi;
                let alpha = 0;
                if ((usePTS || (GlobalDateTimeNode && wallMonotonic))
                    && Number.isFinite(firstT) && lastT > firstT) {
                    const frameIndex = usePTS
                        ? Math.max(0, Math.min(framePTSus.length - 1, Math.round(f)))
                        : 0;
                    const targetT = usePTS
                        ? (framePTSus[frameIndex] - framePTSus[0]) / 1000
                        : GlobalDateTimeNode.frameToMS(f);
                    if (targetT <= firstT) lo = hi = 0;
                    else if (targetT >= lastT) lo = hi = misb.length - 1;
                    else {
                        let a = 0, b = misb.length - 1;
                        while (b - a > 1) {
                            const m = (a + b) >> 1;
                            const tm = timeOf(misb[m], m);
                            if (!Number.isFinite(tm) || tm > targetT) b = m;
                            else a = m;
                        }
                        lo = a; hi = b;
                        const ta = timeOf(misb[lo], lo), tb = timeOf(misb[hi], hi);
                        alpha = tb > ta ? (targetT - ta) / (tb - ta) : 0;
                    }
                } else {
                    // Timestamp-free fallback for synthetic/plain arrays.
                    const denom = Math.max(1, (Sit.frames ?? 1) - 1);
                    const slotF = Math.max(0, Math.min(misb.length - 1,
                        (f / denom) * (misb.length - 1)));
                    lo = Math.floor(slotF);
                    hi = Math.min(misb.length - 1, lo + 1);
                    alpha = slotF - lo;
                }
                const sample = (row) => {
                    const from = row && row[MISB.WindDirection];
                    const knots = row && row[MISB.WindSpeed];
                    return Number.isFinite(from) && Number.isFinite(knots) ? {from, knots} : null;
                };
                // Tracks with no wind columns at all: bail out once (cached)
                // instead of scanning for a nearest valid row on every frame.
                if (!this._hasWindCache || this._hasWindCache.misb !== misb
                    || this._hasWindCache.length !== misb.length) {
                    let has = false;
                    for (let i = 0; i < misb.length; i++) {
                        if (sample(misb[i])) { has = true; break; }
                    }
                    this._hasWindCache = {misb, length: misb.length, has};
                }
                if (!this._hasWindCache.has) return null;
                const a = sample(misb[lo]);
                const b = sample(misb[hi]);
                if (a && b) {
                    // Interpolate the meteorological TO vector, not the angle,
                    // so 359°→1° follows the short path through north.
                    const ar = radians(180 - a.from), br = radians(180 - b.from);
                    const e = Math.sin(ar) * a.knots * (1 - alpha)
                        + Math.sin(br) * b.knots * alpha;
                    const n = Math.cos(ar) * a.knots * (1 - alpha)
                        + Math.cos(br) * b.knots * alpha;
                    return {
                        from: (180 - Math.atan2(e, n) * 180 / Math.PI + 360) % 360,
                        knots: Math.hypot(e, n),
                        row: lo,
                    };
                }
                if (a) return {...a, row: lo};
                if (b) return {...b, row: hi};
                // Neither bracketing row carries wind data (partial wind-field
                // coverage). Use the NEAREST row that does — still a pure
                // frame-indexed lookup. Returning null here would fall back to
                // this.from/this.knots, which update(f) rewrites to the
                // PLAYHEAD's wind for track-driven nodes, making analysis
                // results for the gap frames depend on where playback sat.
                for (let d = 1; d < misb.length; d++) {
                    const before = lo - d >= 0 ? sample(misb[lo - d]) : null;
                    if (before) return {...before, row: lo - d};
                    const after = hi + d < misb.length ? sample(misb[hi + d]) : null;
                    if (after) return {...after, row: hi + d};
                }
            }
        }
        return null;
    }

    // Per-frame wind displacement vector at frame f for an ECEF position,
    // using the HISTORICAL track wind when this node is track-driven (falling
    // back to the current values otherwise). Pure — no node-state side effects.
    windVectorAt(f, position) {
        const hist = this.trackWindAt(f);
        const from = hist ? hist.from : this.from;
        const knots = hist ? hist.knots : this.knots;
        let wind = getLocalNorthVector(position);
        wind.multiplyScalar(metersPerSecondFromKnots(knots)
            * (Sit.simSpeed ?? 1) / Sit.fps);
        const posUp = getLocalUpVector(position);
        wind.applyAxisAngle(posUp, radians(180 - from));
        return wind;
    }

    update(f) {
        // Track-driven wind: pull WindDirection/WindSpeed from the bound
        // MISB track each frame. When set, this overrides whatever the
        // user has in the GUI (the GUI fields just track the live value).
        // Falls through silently if the track is missing (was removed,
        // not yet loaded) — the previous value stays put rather than
        // jumping to zero.
        {
            const hist = this.trackWindAt(f);
            if (hist && (this.from !== hist.from || this.knots !== hist.knots)) {
                this.from = hist.from;
                this.knots = hist.knots;
                if (this.guiFrom) this.guiFrom.updateDisplay();
                if (this.guiKnots) this.guiKnots.updateDisplay();
                // Consumers sample track-driven wind per frame through the
                // PURE trackWindAt/windVectorAt/getValueFrame(f) paths, so the
                // interpolated value changing every rendered frame must NOT
                // cascade a graph-wide rebake per frame (the rebaked arrays
                // are identical). Cascade only when the underlying track ROW
                // changes — the pre-interpolation cadence — which keeps any
                // legacy consumer that reads this.from at bake time as fresh
                // as it was before interpolation.
                if (hist.row !== this._lastCascadeRow) {
                    this._lastCascadeRow = hist.row;
                    this.recalculateCascade();
                }
            }
        }

        // if we have a lock, then hide the gui of the wind we lock to
        if (this.lock !== undefined) {
            if (NodeMan.exists("lockWind")) {
                const lock = NodeMan.get("lockWind");
                const target = NodeMan.get(this.lock);

                if (lock.value) {
                    this.updateLockedWind()
                }

                if (lock.value !== target.visible) {
                    target.recalculate();
                }

                target.show(!lock.value)
            }
        }

        // if we have an origin track, then update the position to be the zero frame position of that track
        // so we have an accurate frame of reference for the wind

        // if the originTrack is a string, then get the node from NodeMan
        // this allows to make the wind position depended on a track that has not been created yet
        // (i.e. the target position, which depends on the wind)
        if (typeof this.originTrack === "string") {
            this.originTrack = NodeMan.get(this.originTrack);
        }

        if (this.originTrack !== undefined) {
            const newPosition = this.originTrack.p(0);
            assert(newPosition.x !== undefined, "Wind origin track did not return a valid position");

            // Only re-arm the cascade when the *originTrack's* frame-0
            // position actually changes (e.g. user swaps the origin track).
            // Comparing against this.position would re-arm every frame,
            // because consumer nodes (CNodeJetTrack, CNodeLOSTraverse...)
            // legitimately overwrite this.position each frame with the
            // current target/jet position — wind values are unchanged but
            // this.position is, so the previous comparison fought a battle
            // it could never win.
            if (!this.appliedOriginTrackP0 || !newPosition.equals(this.appliedOriginTrackP0)) {
                this.appliedOriginTrackP0 = newPosition.clone();
                this.setPosition(newPosition);
                // Force TWO recalculate cycles so the new frame-of-reference
                // propagates through dependent nodes.
                this.extraRecalculate = 2;
            }

            if (this.extraRecalculate) {
                this.extraRecalculate--;
                this.recalculateCascade();
            }
        }
    }

    updateLockedWind() {
        const target = NodeMan.get(this.lock);
        target.from = this.from;
        target.knots = this.knots;
        target.guiFrom.updateDisplay()
        target.guiKnots.updateDisplay()
    }

    recalculate() {
         if (this.dontRecurse) return;
         this.dontRecurse = true;

        if (this.lock !== undefined) {
            if (NodeMan.exists("lockWind")) {
                const lock = NodeMan.get("lockWind");
                if (lock.value) {
                    this.updateLockedWind()
                }
            }
        }

        this.dontRecurse = false;

        // var A = Sit.jetOrigin.clone()
        //
        // var B = A.clone().add(this.p().multiplyScalar(Sit.frames))
        // DebugArrowAB(this.id+" Wind",A,B,this.arrowColor,true,GlobalScene)
    }

}

export class CNodeDisplayWindArrow extends CNode {
    constructor(v) {
        super(v)
        this.input("source")
        this.input("displayOrigin",true)
        if (!this.in.displayOrigin) {
            this.addInput("displayOrigin", new CNodeOrigin({id:"displayOrigin"}))
        }
        this.arrowColor = v.arrowColor ?? "white"
        this.recalculate();
    }

    recalculate() {
    //    var A = Sit.jetOrigin.clone()
        var A = this.in.displayOrigin.p(0);
        var B = A.clone().add(this.in.source.p().multiplyScalar(10000))
        DebugArrowAB(this.id+" Wind",A,B,this.arrowColor,true,GlobalScene)
    }
}
