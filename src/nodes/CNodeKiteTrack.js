// CNodeKiteTrack.js
//
// Algorithmic kite track ("Add Kite" in the ground context menu). The kite is
// held by a line of a set length from an anchor point, and flies where the
// wind puts it: downwind of the anchor, at the height where lift, drag, weight
// and the pull of the line balance.
//
// The wind is the altitude-aware wind field when weather profiles are loaded,
// and the constant targetWind otherwise, plus smooth seeded gusts ("Wind
// Variability"). The kite's mass, lifting area, lift and drag come from the
// kite design on its object.
//
// The statics are in the pure integrateKiteStates (KitePhysics.js); this node
// wires it into the graph, as CNodeBalloonTrack does for the balloon.

import {CNodeTrack} from "./CNodeTrack";
import {markSitchDirty, NodeMan, Sit} from "../Globals";
import {integrateKiteStates, kiteAnchorFrame, kitePointECEF} from "../KitePhysics";
import {sampleSceneWind, sceneWindFingerprint} from "../SceneWind";
import {EventManager} from "../CEventManager";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {GENERIC_KITE_FLIGHT, kiteFlightProperties, kiteMinimumWind, solveKiteLine} from "../../tools/vehicles/kiteFlight.js";

export class CNodeKiteTrack extends CNodeTrack {
    constructor(v) {
        super(v);
        this.input("anchorAltitude");   // m MSL
        this.input("lineLength");       // m
        this.input("lineWeight");       // g/m
        this.input("lineDiameter");     // mm
        this.input("windVariability");  // % gustiness
        this.input("seed");

        this.anchorLat = v.anchorLat;
        this.anchorLon = v.anchorLon;
        this.simpleSerials.push("anchorLat", "anchorLon");

        // The object that carries the kite design. It is made after this track,
        // so it is found by id when it is needed.
        this.objectID = v.objectID;

        // resize + rebake when the sitch frame count changes
        this.useSitFrames = true;
        this.frames = Sit.frames;

        this._fingerprint = null;

        // Weather profiles arrive as imported tracks, possibly after this kite
        // was made or reloaded. Clear the fingerprint so the next update() rebakes.
        this._onTracksChanged = () => {
            this._fingerprint = null;
        };
        EventManager.addEventListener("tracksChanged", this._onTracksChanged);

        this.recalculate();
    }

    dispose() {
        EventManager.removeEventListener("tracksChanged", this._onTracksChanged);
        super.dispose();
    }

    // The object move widget moves the anchor, wherever the wind has put the kite.
    getPositionEditTarget() {
        return {
            getLLA: () => [this.anchorLat, this.anchorLon, this.in.anchorAltitude.v0],
            getECEF: () => LLAToECEF(this.anchorLat, this.anchorLon,
                this.in.anchorAltitude.v0 + meanSeaLevelOffset(this.anchorLat, this.anchorLon)),
            setLLA: (lat, lon, alt) => {
                this.anchorLat = lat;
                this.anchorLon = lon;
                // Update the GUI input quietly, then bake once with all three coordinates.
                this.in.anchorAltitude.setValue(alt, true);
                this.recalculateCascade();
                markSitchDirty();
            },
        };
    }

    // Mass, lifting area, lift and drag: from the kite design on the object, or
    // those of a generic kite when the object has some other model.
    flightProperties() {
        const parameters = NodeMan.get(this.objectID, false)?.proceduralModel?.recipe?.parameters;
        return parameters?.vehicleType === "kite" ? kiteFlightProperties(parameters) : GENERIC_KITE_FLIGHT;
    }

    // Everything outside the graph that the bake depends on: the wind, and the kite design.
    _currentFingerprint() {
        const {massKg, areaM2, liftCoefficient, dragCoefficient} = this.flightProperties();
        return `${sceneWindFingerprint()}|${massKg}|${areaM2}|${liftCoefficient}|${dragCoefficient}`;
    }

    update(f) {
        super.update(f);
        if (this._currentFingerprint() !== this._fingerprint) {
            // The bake is stale. Only a real recalculate() takes the new fingerprint:
            // the cascade can be suppressed (Globals.dontRecalculate, during the
            // sitch-load mods pass), and then this tries again on the next frame.
            this.recalculateCascade();
        }
        this.onStatus?.(...this.statusAt(f));
    }

    lineParameters() {
        return {
            lineLength: this.in.lineLength.v0,
            lineMassPerMetre: this.in.lineWeight.v0 / 1000,
            lineDiameter: this.in.lineDiameter.v0 / 1000,
            properties: this.flightProperties(),
        };
    }

    recalculate() {
        this.frames = Sit.frames;
        const fingerprint = this._currentFingerprint();
        this._fingerprint = fingerprint;

        const dt = (Sit.simSpeed ?? 1) / Sit.fps;
        const line = this.lineParameters();

        // The bake is a pure function of these values, so skip it when none changed.
        const bakeKey = [
            fingerprint, this.frames, dt,
            this.anchorLat, this.anchorLon, this.in.anchorAltitude.v0,
            line.lineLength, line.lineMassPerMetre, line.lineDiameter,
            this.in.windVariability.v0, Math.round(this.in.seed.v0),
        ].join("|");
        if (this._lastBakeKey === bakeKey
            && Array.isArray(this.array) && this.array.length === this.frames) {
            return;
        }
        this._lastBakeKey = bakeKey;

        this.array = integrateKiteStates({
            anchorLat: this.anchorLat,
            anchorLon: this.anchorLon,
            anchorAltMSL: this.in.anchorAltitude.v0,
            ...line,
            variabilityPct: this.in.windVariability.v0,
            seed: Math.round(this.in.seed.v0),
            frames: this.frames,
            dt,
        }, sampleSceneWind);
        // Lets the line display and the status text see a new bake.
        this.bakeSerial = (this.bakeSerial ?? 0) + 1;
    }

    // The kite's state at a frame: see integrateKiteStates for the fields.
    kiteStateAt(f) {
        if (!this.array?.length) return null;
        return this.array[Math.max(0, Math.min(this.array.length - 1, Math.round(f)))].kite;
    }

    // The wind on the kite at a frame, for the motion of its tails.
    kiteAirAt(f) {
        const state = this.kiteStateAt(f);
        return state ? {air: state.air, wind: state.windSpeed} : null;
    }

    // The line at a frame: ECEF points from the anchor to the kite. The shape is
    // that of the balance position for the wind of the frame. When the kite is
    // still on its way there, the shape is turned and scaled to end at the kite.
    linePointsAt(f) {
        const state = this.kiteStateAt(f);
        if (!state) return [];
        const frame = kiteAnchorFrame(this.anchorLat, this.anchorLon, this.in.anchorAltitude.v0);
        const line = solveKiteLine({windSpeed: state.windSpeed, ...this.lineParameters()});
        const scale = Math.hypot(state.downwind, state.height) / Math.hypot(line.downwind, line.height);
        const turn = Math.atan2(state.height, state.downwind) - Math.atan2(line.height, line.downwind);
        const cos = Math.cos(turn) * scale, sin = Math.sin(turn) * scale;
        return line.points.map(([downwind, height]) =>
            kitePointECEF(frame, state.bearing, downwind * cos - height * sin, downwind * sin + height * cos));
    }

    // Two short texts on the kite at a frame, for its menu: [position, wind and pull].
    statusAt(f) {
        const state = this.kiteStateAt(f);
        if (!state) return ["", ""];
        const knots = speed => `${(speed / 0.514444).toFixed(1)} kt`;
        if (!state.flying) {
            return ["On the ground", `${knots(state.windSpeed)} · needs ${knots(kiteMinimumWind(this.flightProperties()))}`];
        }
        // the pull is that of the balance position; a kite on its way down has a slack line
        const elevation = Math.atan2(state.height, state.downwind) * 180 / Math.PI;
        return [`${state.height.toFixed(0)} m up · ${state.downwind.toFixed(0)} m out · ${elevation.toFixed(0)}°`,
            `${knots(state.windSpeed)} · ${state.tension.toFixed(0)} N`];
    }
}
