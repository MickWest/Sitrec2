import {CNode, CNodeOrigin} from "./CNode";
import {metersPerSecondFromKnots, radians} from "../utils";
import {GlobalDateTimeNode, Globals, NodeMan, Sit, Units} from "../Globals";
import {DebugArrowAB} from "../threeExt";
import {GlobalScene} from "../LocalFrame";
import {getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {assert} from "../assert";
import {V3} from "../threeUtils";
import {t} from "../i18n";
import {MISB} from "../MISBUtils";
import {fromUVToDirKnots, knotsFromMISBWindSpeed, normalizeWindTimestampMs, windSpeedUnit} from "./WindHelpers";
import {altitudeProfileForSourceKey, trackSourceKey} from "./WindSources";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";

// The role of a wind node in a custom sitch: the source it reads is the wind
// field's source for that role (CNodeDisplayWindField.sourceKeyFor).
const WIND_ROLES = {targetWind: "target", localWind: "local"};

export class CNodeWind extends CNode {
    constructor(v, _guiMenu) {
        super(v);

        
        this.setGUI(v, _guiMenu)

        this.from = v.from;  // true heading of the wind soruce. North = 0
        this.knots = v.knots
        this.name = v.name ?? v.id // if no name is supplied, use the id

        this.max = v.max ?? 200;

        // Target or Local Wind (null for any other wind node). Under a Wind
        // Source other than Manual, such a node READS the wind field: at each
        // user's position, height and time, on every frame (windStateAt). Its
        // From and Knots then show the value at its own track, read-only,
        // unless Override is on: then they are the user's, as under Manual.
        this.role = v.role ?? WIND_ROLES[this.id] ?? null;
        this.override = v.override ?? false;

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
                    wf.noteWindChanged?.();
                }
            };
            // Target and Local Wind say what they are for; any other wind
            // node (Object, Cloud in older sitches) keeps the generic text.
            const tipGroup = {targetWind: "target", localWind: "local"}[this.id];
            const fromTip = tipGroup ? t(`custom.wind.${tipGroup}From.tooltip`) : t("misc.windFrom.tooltip");
            const knotsTip = tipGroup ? t(`custom.wind.${tipGroup}Knots.tooltip`) : t("misc.windKnots.tooltip");
            this.guiFrom = this.gui.add (this, "from", 0,359,1).name(this.name+" Wind From").tooltip(fromTip).onChange(onManualWindEdit).wrap()
            // The speed row is in the Wind panel's speed unit (speedInUnit);
            // the node keeps knots. It was "Wind Knots", in knots, until
            // 2026-11-03 (decision D4).
            const unit = this.speedUnit();
            this.guiKnots = this.gui.add (this, "speedInUnit", 0, this.max * unit.fromKnots, 1)
                .name(`${this.name} Wind Speed (${unit.abbrev})`).tooltip(knotsTip).onChange(onManualWindEdit)
            // Whole numbers: a live value (read from the source on each frame)
            // showed every decimal, such as 226.481.
            this.guiFrom.decimals?.(0);
            this.guiKnots.decimals?.(0);
            if (tipGroup) {
                // Shown by _syncLiveGUI when the source is not Manual.
                this.guiOverride = this.gui.add(this, "override")
                    .name(`Override ${this.name} Wind`)
                    .tooltip(t(`custom.wind.${tipGroup}Override.tooltip`))
                    .onChange(() => {
                        this._syncLiveGUI();
                        this.recalculateCascade();
                        NodeMan.get("windField", false)?.noteWindChanged?.();
                    });
                this.guiOverride.hide();
            }
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
            override: this.override,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.from = v.from;
        this.knots = v.knots;
        this.name = v.name;
        this.max = v.max;
        this.lock = v.lock;
        this.override = !!v.override;
        this.guiFrom.updateDisplay()
        this.guiKnots.updateDisplay()
        this.guiOverride?.updateDisplay();
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
        // The Override checkbox follows the sliders, when it is offered at all.
        this._guiShown = visible;
        if (this.guiOverride) this.guiOverride.show(visible && !!this._overrideOffered);
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

    // ── the speed unit of the GUI ─────────────────────────────────────

    // The unit of the speed row: the Wind panel's (Units, or knots with Wind
    // in Knots on the wind field). {abbrev, fromKnots}.
    speedUnit() {
        return windSpeedUnit(Units, NodeMan.get("windField", false)?.windInKnots);
    }

    // The speed row's value, in that unit. The node itself keeps knots.
    get speedInUnit() {
        return this.knots * this.speedUnit().fromKnots;
    }

    set speedInUnit(value) {
        this.knots = value / this.speedUnit().fromKnots;
    }

    // The unit changed (Units, or Wind in Knots): new name and range.
    refreshSpeedGUI() {
        if (!this.guiKnots) return;
        const unit = this.speedUnit();
        this.guiKnots.name(`${this.name} Wind Speed (${unit.abbrev})`);
        this.guiKnots.max(this.max * unit.fromKnots);
        this.guiKnots.updateDisplay();
    }

    // CUnits calls these on every node that has them.
    changeUnits() {
        this.refreshSpeedGUI();
    }

    updateDesc() {
        this.refreshSpeedGUI();
    }

    // ── the wind this node gives ──────────────────────────────────────

    // The source this node reads from the wind field, or null when it gives
    // its own From and Knots: Manual source, Override on, no wind field, or a
    // wind node that is not Target or Local Wind.
    liveSourceKey() {
        if (!this.role || this.override) return null;
        const wf = NodeMan.get("windField", false);
        if (!wf || typeof wf.windAt !== "function") return null;
        const key = wf.sourceKeyFor(this.role);
        return key && key !== "manual" ? key : null;
    }

    // Target Wind gives Local Wind's wind when "Lock Target Wind to Local" is
    // on (Local Wind carries `lock: "targetWind"`).
    _lockedTo() {
        if (this.role !== "target") return null;
        if (!NodeMan.get("lockWind", false)?.value) return null;
        const local = NodeMan.get("localWind", false);
        return local && local !== this && local.lock === this.id ? local : null;
    }

    // The wind this node gives at frame f at an ECEF position:
    // {from, knots, status, sourceKey}. Status is the wind field's (see
    // CNodeDisplayWindField.windAt), or "manual" / "override" for a value
    // the user set. Pure: no change to the node.
    windStateAt(f, position = this.position) {
        const locked = this._lockedTo();
        if (locked) return locked.windStateAt(f, position);
        if (!this.override) {
            const hist = this.trackWindAt(f);
            if (hist) {
                return {from: hist.from, knots: hist.knots, status: "ok",
                    sourceKey: trackSourceKey(this.trackSource)};
            }
            const key = this.liveSourceKey();
            if (key) {
                const lla = position ? ECEFToLLAVD_radii(position) : null;
                const wf = NodeMan.get("windField");
                const w = lla && Number.isFinite(lla.z)
                    ? wf.windAt(key, lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y), f)
                    : {u: null, v: null, status: "no-data"};
                if (Number.isFinite(w.u) && Number.isFinite(w.v)) {
                    const {from, knots} = fromUVToDirKnots(w.u, w.v);
                    const state = {from, knots, status: w.status, sourceKey: key};
                    // The height a held value is from (see windAt).
                    if (w.limitM != null) state.limitM = w.limitM;
                    return state;
                }
                // Nothing here (yet): this node's last values, marked so.
                return {from: this.from, knots: this.knots, status: w.status, sourceKey: key};
            }
        }
        return {from: this.from, knots: this.knots,
            status: this.override ? "override" : "manual", sourceKey: null};
    }

    // What changes the wind this node gives, other than the frame and the
    // position. update() recalculates the node's users when it changes.
    // (From and Knots under Manual or Override are left out: an edit of them
    // recalculates at once, in its onChange.)
    windSignature() {
        const locked = this._lockedTo();
        if (locked) return `lock:${locked.windSignature()}`;
        if (this.override) return "override";
        if (this.trackSource) return `track:${this.trackSource}`;
        const key = this.liveSourceKey();
        if (!key) return "manual";
        const wf = NodeMan.get("windField");
        return `live:${key}|${wf._sourceDataVersion ?? 0}|${wf.sondeProfileSignature?.(key) ?? ""}`;
    }

    // A key for a cache of results that used this node's wind: the signature,
    // and From and Knots when they are the wind (Manual, Override). Not the
    // From and Knots of a node that reads a source: they follow the playhead.
    windCacheKey() {
        const locked = this._lockedTo();
        if (locked) return `lock:${locked.windCacheKey()}`;
        const signature = this.windSignature();
        return signature === "manual" || signature === "override"
            ? `${signature}:${this.from}|${this.knots}` : signature;
    }

    // One sentence on where this node's wind comes from, for reports.
    describeSource() {
        const locked = this._lockedTo();
        if (locked) return locked.describeSource();
        if (this.override) return "User-set wind (Override is on); uncertainty is an input assumption.";
        if (this.trackSource) return "Captured wind series from the loaded track.";
        const text = this.liveSourceKey()
            ? NodeMan.get("windField", false)?.windProvenance?.(this.role === "local" ? "camera" : "target")
            : null;
        return text ?? "User-supplied wind; uncertainty is an input assumption.";
    }

    // ECEF wind displacement for one frame, from a {from, knots} state.
    _vectorFrom(state, position) {
        const wind = getLocalNorthVector(position);
        wind.multiplyScalar(metersPerSecondFromKnots(state.knots)
            * (Sit.simSpeed ?? 1) / Sit.fps);
        wind.applyAxisAngle(getLocalUpVector(position), radians(180 - state.from));
        assert(!isNaN(wind.x) && !isNaN(wind.y) && !isNaN(wind.z), "Wind vector has NaNs");
        return wind;
    }

    // The per-frame wind vector (ECEF) at frame f at a position (default: the
    // last position a user set). Every way to read this node comes here.
    getValueFrame(f, position) {
        if (position === undefined) position = this.position;
        return this._vectorFrom(this.windStateAt(f, position), position);
    }

    // v(f), p(f) and v0 read the frame they ask for. A wind node has no frames
    // of its own (frames = 0), and CNode.getValue then read frame 0 for every
    // f, so until 2026-11-03 the Flight Sim camera, Constant Ground Speed and
    // Straight Line traverses had the frame-0 wind of a telemetry track.
    getValue(frameFloat) {
        return this.getValueFrame(frameFloat);
    }

    // PURE historical lookup of the track-driven wind at frame f, or null when
    // no track drives this node. Same misb-row mapping as update(f), but with
    // no mutation/cascade side effects. The traverse analysis samples the whole
    // clip through this — getValueFrame ignores its frame argument and always
    // returns the CURRENT playhead wind, which silently repeated one wind value
    // across the entire analysed clip for track-driven winds.
    trackWindAt(f) {
        // A sounding's track is read by altitude, through the wind field. The row
        // for the current time is the wind where the balloon is, not the wind at
        // this node's altitude, so it is never this node's wind.
        if (this.trackSource && altitudeProfileForSourceKey(trackSourceKey(this.trackSource))) return null;
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
                    // Tag 36 is metres per second (ST 0601); this node is knots.
                    const speedMS = row && row[MISB.WindSpeed];
                    return Number.isFinite(from) && Number.isFinite(speedMS)
                        ? {from, knots: knotsFromMISBWindSpeed(speedMS)} : null;
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

    // Per-frame wind displacement vector at frame f for an ECEF position.
    // Pure — no node-state side effects. (The same as getValueFrame.)
    windVectorAt(f, position) {
        return this._vectorFrom(this.windStateAt(f, position), position);
    }

    update(f) {
        // From and Knots show the wind at this node's own track (originTrack)
        // at this frame, when the node reads a source: read-only, so the
        // sliders show what the users get where the target (or camera) is.
        // Users do not read From and Knots; they call windStateAt at their own
        // positions, so a change here needs no recalculation.
        // A telemetry wind is the same at every position, so a node with no
        // track of its own still shows it.
        const anchor = this._anchorPosition(f) ?? (this.trackSource ? this.position : null);
        const state = anchor ? this.windStateAt(f, anchor) : null;
        this.liveState = state;
        const live = !!state && state.status !== "manual" && state.status !== "override";
        if (live && Number.isFinite(state.from) && Number.isFinite(state.knots)
            && (this.from !== state.from || this.knots !== state.knots)) {
            this.from = state.from;
            this.knots = state.knots;
            if (this.guiFrom) this.guiFrom.updateDisplay();
            if (this.guiKnots) this.guiKnots.updateDisplay();
        }
        this._syncLiveGUI(live);

        // Recalculate the users when what this node reads changes: a new
        // source, Override, data that arrived (a GFS level, a sounding).
        // Not while recalculation is off (a sitch load applies its mods with
        // it off): the cascade would be dropped, so keep the old signature and
        // try again on a later frame.
        const signature = this.windSignature();
        if (signature !== this._lastWindSignature && !Globals.dontRecalculate) {
            this._lastWindSignature = signature;
            this.recalculateCascade();
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

    // This node's own track position at frame f (ECEF), or null.
    _anchorPosition(f) {
        let track = this.originTrack;
        if (typeof track === "string") track = NodeMan.get(track, false);
        if (!track || typeof track.p !== "function") return null;
        try {
            const pos = track.p(f);
            return pos && Number.isFinite(pos.x) ? pos : null;
        } catch (e) {
            return null;   // the track is not ready (during a load)
        }
    }

    // Read-only sliders while the node reads a source; the Override checkbox
    // offered whenever the source is not Manual.
    _syncLiveGUI(live = this._live) {
        this._live = live;
        if (!this.guiFrom) return;
        const wf = NodeMan.get("windField", false);
        const sourceKey = this.role && wf?.sourceKeyFor ? wf.sourceKeyFor(this.role) : "manual";
        const offered = !!this.role && (sourceKey !== "manual" || !!this.trackSource);
        if (this.guiOverride && offered !== this._overrideOffered) {
            this._overrideOffered = offered;
            this.guiOverride.show(offered && this._guiShown !== false);
        }
        const readOnly = !!live && !this.override;
        if (readOnly !== this._readOnly) {
            this._readOnly = readOnly;
            this.guiFrom.disable(readOnly);
            this.guiKnots.disable(readOnly);
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
