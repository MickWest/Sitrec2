// CNodeBalloonTrack.js
//
// Algorithmic weather-balloon target track ("Add Balloon" in the ground
// context menu). The balloon holds at its start point until launch, then
// ascends at the buoyancy rate while being advected by the wind — the
// altitude-aware wind field when weather profiles are loaded (soundings /
// GFS via windField.sampleWindAtAltitude), falling back to the constant
// targetWind. "Wind Variability" adds smooth seeded gusts on top.
//
// The kinematics live in the pure integrateBalloonPositions (BalloonPhysics
// .js); this node wires it into the graph: GUI-value inputs, wind sampling,
// Sit.frames tracking (useSitFrames), and a cheap wind-change poll — the wind
// nodes cannot be graph inputs here because targetWind's frame of reference
// can itself follow the target track (a cycle, same reason CNodeWind reads
// its originTrack outside the graph).

import {CNodeTrack} from "./CNodeTrack";
import {NodeMan, Sit} from "../Globals";
import {metersPerSecondFromKnots, radians} from "../utils";
import {integrateBalloonPositions} from "../BalloonPhysics";
import {EventManager} from "../CEventManager";

export class CNodeBalloonTrack extends CNodeTrack {
    constructor(v) {
        super(v);
        this.input("startAltitude");    // m MSL
        this.input("launchDelay");      // seconds
        this.input("buoyancy");         // m/s ascent rate
        this.input("windVariability");  // % gustiness
        this.input("seed");

        this.startLat = v.startLat;
        this.startLon = v.startLon;
        this.simpleSerials.push("startLat", "startLon");

        // resize + rebake when the sitch frame count changes
        this.useSitFrames = true;
        this.frames = Sit.frames;

        this._windFingerprint = null;

        // Sonde/weather profiles arrive as imported TRACKS (possibly async,
        // after this balloon was created or reloaded) — invalidate the wind
        // fingerprint so the next update() rebakes with the new profiles.
        this._onTracksChanged = () => {
            this._windFingerprint = null;
        };
        EventManager.addEventListener("tracksChanged", this._onTracksChanged);

        this.recalculate();
    }

    dispose() {
        EventManager.removeEventListener("tracksChanged", this._onTracksChanged);
        super.dispose();
    }

    // Wind (u = east, v = north, m/s) at a position/altitude. Altitude-aware
    // wind field first (sounding/GFS profiles), constant targetWind fallback.
    windUVAt(lat, lon, altMSL, f) {
        const wf = NodeMan.get("windField", false);
        if (wf && typeof wf.sampleWindAtAltitude === "function") {
            try {
                const s = wf.sampleWindAtAltitude(lat, lon, altMSL);
                if (s && Number.isFinite(s.u) && Number.isFinite(s.v)) {
                    return s;
                }
            } catch (e) {
                // no usable profile data at this point — fall through
            }
        }
        const tw = NodeMan.get("targetWind", false);
        if (tw) {
            const hist = (typeof tw.trackWindAt === "function") ? tw.trackWindAt(f) : null;
            const from = hist ? hist.from : tw.from;
            const knots = hist ? hist.knots : tw.knots;
            if (Number.isFinite(from) && Number.isFinite(knots)) {
                // meteorological FROM heading → blow-TO vector (same convention
                // as CNodeWind.getValueFrame)
                const speed = metersPerSecondFromKnots(knots);
                const toRad = radians(from + 180);
                return {u: Math.sin(toRad) * speed, v: Math.cos(toRad) * speed};
            }
        }
        return {u: 0, v: 0};
    }

    // Cheap change detection for the wind sources we can't have as inputs.
    // For a TRACK-DRIVEN targetWind, from/knots mirror the playhead's wind
    // every rendered frame (CNodeWind.update) — but the bake already samples
    // the historical wind per frame through trackWindAt(f), so only the
    // identity of the driving track matters there; fingerprinting the live
    // values would rebake the balloon every single frame.
    _currentWindFingerprint() {
        const wf = NodeMan.get("windField", false);
        const tw = NodeMan.get("targetWind", false);
        const twPart = tw
            ? (tw.trackSource ? `track:${tw.trackSource}` : `${tw.from}|${tw.knots}`)
            : "";
        // _windDataVersion/_lastDateCycle capture ASYNC wind-grid arrival
        // (GFS levels re-fetch after a sitch reload) — without them, a
        // reloaded balloon would stay baked against the constant-wind
        // fallback forever once the deferred fetch completes.
        //
        // sondeProfileSignature() does the same for SOUNDING sources: UWYO/IGRA2
        // soundings load asynchronously as tracks after a reload, and their
        // arrival changes NONE of the fields above — so without this a saved
        // balloon that baked before the soundings arrived would stay pinned to
        // the constant-wind fallback (its memoized bake never re-runs because the
        // fingerprint, hence the bake key, is unchanged).
        const profSig = (wf && typeof wf.sondeProfileSignature === "function")
            ? wf.sondeProfileSignature() : "";
        return `${wf?.source ?? ""}|${wf?.windAltFt ?? ""}`
            + `|${wf?._windDataVersion ?? ""}|${wf?._lastDateCycle ?? ""}|${twPart}|${profSig}`;
    }

    update(f) {
        super.update(f);
        if (this._currentWindFingerprint() !== this._windFingerprint) {
            // The bake is stale. The fingerprint is consumed ONLY by a real
            // recalculate() — the cascade can be suppressed while it runs
            // (Globals.dontRecalculate during the sitch-load mods pass), and
            // consuming the fingerprint here would leave a permanently stale
            // bake. Left stale, this simply retries next frame until the
            // rebake actually happens. (A cascade rooted at this node bypasses
            // the checkDisplayOutputs gate — depth 0 always recalculates — so
            // hidden balloons rebake too.)
            this.recalculateCascade();
        }
    }

    recalculate() {
        this.frames = Sit.frames;
        const fingerprint = this._currentWindFingerprint();
        this._windFingerprint = fingerprint;

        const dt = (Sit.simSpeed ?? 1) / Sit.fps;

        // Memoize the bake. integrateBalloonPositions is a pure function of these
        // inputs plus the wind field (captured by the fingerprint), so if none of
        // them changed the output is byte-identical — skip the O(frames)
        // integration entirely. One "Add Balloon" otherwise re-bakes the same
        // 100k+ frame track ~5× (constructor, recalculateAllRootFirst, and the
        // update() wind-settle rebakes), each an unconditional full integration.
        const bakeKey = [
            fingerprint, this.frames, dt,
            this.startLat, this.startLon,
            this.in.startAltitude.v0, this.in.launchDelay.v0,
            this.in.buoyancy.v0, this.in.windVariability.v0,
            Math.round(this.in.seed.v0),
        ].join("|");
        if (this._lastBakeKey === bakeKey
            && Array.isArray(this.array) && this.array.length === this.frames) {
            return;
        }
        this._lastBakeKey = bakeKey;

        this.array = integrateBalloonPositions({
            startLat: this.startLat,
            startLon: this.startLon,
            startAltMSL: this.in.startAltitude.v0,
            launchDelay: this.in.launchDelay.v0,
            ascentRate: this.in.buoyancy.v0,
            variabilityPct: this.in.windVariability.v0,
            seed: Math.round(this.in.seed.v0),
            frames: this.frames,
            dt,
        }, (lat, lon, altMSL, f) => this.windUVAt(lat, lon, altMSL, f));
        this._ensureWindLayers();
    }

    // Pre-load the wind layers this balloon will climb through (GFS source
    // only). Estimate the peak altitude kinematically from the ascent rate and
    // the timeline — so raising Sitch Frames pulls in the higher layers — and
    // ask the wind field to fetch them. Fire-and-forget: when the higher levels
    // arrive the wind data version bumps and update() rebakes against the
    // fuller field. No-op for constant/sounding winds.
    _ensureWindLayers() {
        const wf = NodeMan.get("windField", false);
        if (!wf || typeof wf.ensureLevelsUpToAltitude !== "function") return;
        const dt = (Sit.simSpeed ?? 1) / Sit.fps;
        const climbSec = Math.max(0, this.frames * dt - this.in.launchDelay.v0);
        const maxAltM = this.in.startAltitude.v0
            + Math.max(0, this.in.buoyancy.v0) * climbSec;
        // 10% margin so the top bracketing level is comfortably covered.
        wf.ensureLevelsUpToAltitude(maxAltM * 1.1 / 0.3048);
    }
}
