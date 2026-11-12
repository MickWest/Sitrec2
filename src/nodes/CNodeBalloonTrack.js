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
import {markSitchDirty, NodeMan, Sit} from "../Globals";
import {integrateBalloonPositions} from "../BalloonPhysics";
import {sampleSceneWind, sceneWindFingerprint} from "../SceneWind";
import {EventManager} from "../CEventManager";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";

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

    // The object move widget edits the launch point, even when the playhead
    // shows the balloon later in flight. The baked path remains generated.
    getPositionEditTarget() {
        return {
            getLLA: () => [this.startLat, this.startLon, this.in.startAltitude.v0],
            getECEF: () => LLAToECEF(this.startLat, this.startLon,
                this.in.startAltitude.v0 + meanSeaLevelOffset(this.startLat, this.startLon)),
            setLLA: (lat, lon, alt) => {
                this.startLat = lat;
                this.startLon = lon;
                // Update the existing GUI input quietly, then bake once with
                // all three new coordinates. This also preserves save/load.
                this.in.startAltitude.setValue(alt, true);
                this.recalculateCascade();
                markSitchDirty();
            },
        };
    }

    // Wind (u = east, v = north, m/s) at a position/altitude, and the cheap
    // change detection for it. Shared with the kite track: see SceneWind.js.
    windUVAt(lat, lon, altMSL, f) {
        return sampleSceneWind(lat, lon, altMSL, f);
    }

    _currentWindFingerprint() {
        return sceneWindFingerprint();
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
