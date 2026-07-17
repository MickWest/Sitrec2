// Football: launch a football (soccer ball) from a point on a selected track
// at a given frame, with ballistic physics (quadratic drag + Magnus lift from
// spin), an optional Spidercam-style cable-cam whose four support wires are
// drawn and checked for collision with the ball, and a fixed "broadcast"
// camera view that follows the ball.
//
// Everything lives under Physics -> Scenarios -> Football in the menu. The
// cable cam is normally hidden; the "Show Cable Cam" checkbox reveals the
// dolly, its path, and the four wires. "Load England-Norway Goal Kick"
// configures the whole scene to replicate the 2026 goal-kick / spidercam
// controversy (see GOAL_KICK_SCENARIO below).
//
// setupFootball() (run lazily by the ScenarioManager when the Scenarios menu
// is opened) adds ONLY the folder buttons; the simulation itself — nodes, 3D
// objects, GUI values, camera-switch options — is created by
// activateFootball() when the user clicks Enable or the Load button (or when
// a loading save was using Football — see CScenarioManager.activateForMods).
// An un-activated Football is a 100% no-op. All node creation is idempotent
// (NodeMan.exists guards) and serializes through the standard mods mechanism
// by node id.

import {guiMenus, Globals, NodeMan, Sit, setRenderOne, GlobalDateTimeNode} from "./Globals";
import {EventManager} from "./CEventManager";
import {par} from "./par";
import {CNodeGUIValue, CNodeGUIFlag} from "./nodes/CNodeGUIValue";
import {CNodeTrackSwitch} from "./nodes/CNodeTrackSwitch";
import {CNodeTrack} from "./nodes/CNodeTrack";
import {CNode3DGroup} from "./nodes/CNode3DGroup";
import {CNode3DObject} from "./nodes/CNode3DObject";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {CNodePositionLLA} from "./nodes/CNodePositionLLA";
import {CNodeCamera} from "./nodes/CNodeCamera";
import {CNodeView3D} from "./nodes/CNodeView3D";
import {CNodeGroundOverlay} from "./nodes/CNodeGroundOverlay";
import {CNodeControllerTrackToTrack} from "./nodes/CNodeControllerVarious";
import {SITREC_APP} from "./configUtils";
import {CNodeConstant} from "./nodes/CNode";
import {getLocalUpVector, getLocalNorthVector, getLocalEastVector} from "./SphericalMath";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {radians} from "./utils";
import {makeMatLine, disposeMatLine} from "./MatLines";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {dispose, propagateLayerMaskObject} from "./threeExt";
import {CustomGraphManager} from "./CCustomGraphManager";
import {Color, Mesh, MeshBasicMaterial, SphereGeometry, Vector3} from "three";
import * as LAYER from "./LayerMasks";

// ── Physical constants ──────────────────────────────────────────────
const BALL_MASS = 0.430;          // kg, FIFA size 5
const BALL_RADIUS = 0.110;        // m  (circumference 68-70 cm)
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const AIR_RHO = 1.225;            // kg/m^3 at sea level
const WIRE_RADIUS = 0.008;        // m, Spidercam rope is ~8-10 mm
const WIRE_ATTACH_ABOVE = 0.5;    // m, wires join the rig this far above the
                                  // camera/dolly point (the gimbal hangs below)
const GRAVITY = 9.81;             // m/s^2
const GROUND_RESTITUTION = 0.6;   // bounce energy retention (vertical)
const GROUND_FRICTION = 0.75;     // horizontal velocity retained per bounce
const WIRE_FRICTION = 0.8;        // tangential velocity retained on wire contact
const SIM_DT = 1 / 480;           // physics substep, s
const CONTACT_TIME = 0.010;       // s, ball impact contact time — kick/bounce
                                  // studies put shell deformation at ~8-12 ms

// ── Goal-kick replication scenario ──────────────────────────────────
// The "Wire-gate" incident: 2026 FIFA World Cup quarter-final, Norway 1-2
// England, Hard Rock Stadium, Miami Gardens, 2026-07-11. At 45+2' Norway
// keeper Ørjan Nyland's goal kick appeared to clip a Spidercam suspension
// wire and dropped near-vertically in front of the benches near halfway;
// Elliot Anderson collected it and the move ended with Bellingham's
// equalizer. FIFA said the ball's 500 Hz IMU showed no contact spike and
// the camera "neither shakes nor moves"; Norway (and a viral BBC optical
// 3D replay showing a kink in the flight path) disputed that.
//
// Pitch-frame coordinates are meters from the pitch center: "along" is the
// long axis (+along = pitchHeading direction = East at Hard Rock), "across"
// is right of +along (= South here, assumed bench/main-camera side).
// Unpublished quantities (dolly position, exact kick spot, camera-1 gantry)
// are estimates chosen to reproduce the described flight.
const GOAL_KICK_SCENARIO = {
    name: "England-Norway Goal Kick (WC 2026)",
    stadium: {
        lat: 25.957915,           // Hard Rock Stadium, Miami Gardens
        lon: -80.238930,          // (center aligned to the canopy opening)
        fieldAltitude: 3,         // ~sea level
        // Long-axis compass bearing re-fitted against the 3D building tiles
        // (was 111° from the low-zoom satellite strip).
        pitchHeadingDeg: 121.4,
    },
    pitch: {length: 105, width: 68},
    // Nyland's goal kick from the (assumed west) Norway goal area, aimed
    // downfield toward the bench-side touchline near halfway. Keeper stands
    // slightly bench-side of the goal center in the broadcast frame.
    kick: {
        along: -47.0,             // goal-area edge, 5.5 m off the goal line
        across: 2.0,
        headingRelDeg: 9.6,       // relative to +along (toward bench side);
                                  // keeps the tuned 131° compass heading with
                                  // the re-fitted 121.4° pitch axis
        elevationDeg: 38,         // high apex, level with the upper deck
        speed: 35,                // m/s, hard elite goal kick (~69 m unimpeded)
        spinRPM: 300,             // backspin
        spinTiltDeg: 0,
        dragCd: 0.22,
        launchTime: 0.583,        // seconds into the sitch; ball contact in the
                                  // real-time spidercam clip (frame 35 @ 60 fps)
    },
    // Spidercam motion matched frame-by-frame against the REAL-TIME clip
    // ("Real Time Spider Footage - correct speed.mov", 262 f @ 60 fps): the
    // rig is already moving at clip start just above the Norway goal, races
    // downfield at ~14-15 m/s (near the rig's spec limit), RISING slightly
    // (~19 m to ~21 m) while drifting to the bench side, reaching halfway
    // ~3.5 s after the kick — about 2.5x faster than the old keys, which
    // were fitted to a SLOW-MOTION replay and only constrained the path
    // shape. Keyframe times are seconds RELATIVE TO THE KICK (dt),
    // converted to sitch frames at load so the replication survives
    // fps/frame-count changes.
    cableCam: [
        {dt: -0.583, along: -51, across: -4, height: 19},
        {dt: 0.417,  along: -32, across: -1, height: 19.5},
        {dt: 1.417,  along: -15, across: 3,  height: 20},
        {dt: 2.417,  along: 0,   across: 9,  height: 20.5},
        {dt: 3.583,  along: 14,  across: 20, height: 21},
        {dt: 3.767,  along: 16,  across: 22, height: 21},
    ],
    // Where the spidercam operator points the camera (pitch frame, same
    // kick-relative keyframe scheme): over the keeper toward bench-side
    // midfield at the kick, swinging down-pitch as the rig accelerates,
    // then panning right onto the bench-side drop zone.
    cableCamAim: [
        {dt: -0.583, along: -3, across: 18, height: 4},
        {dt: 0.417,  along: 15, across: 8,  height: 0},
        {dt: 1.417,  along: 30, across: 7,  height: 2},
        {dt: 2.417,  along: 40, across: 16, height: 2},
        {dt: 3.583,  along: 32, across: 34, height: 0},
        {dt: 3.767,  along: 32, across: 34, height: 0},
    ],
    cableCamFOV: 81.5,            // vertical FOV of the spidercam lens (very
                                  // wide; fitted against the footage)
    matchDateTime: "2026-07-11T21:47:00Z",  // ~45+2' after 21:00 UTC kickoff
    // Canopy-opening corners: ~140m x 92m rectangle, roof deck ~48 m
    anchors: {along: 70, across: 45, height: 48},
    // Main center-line broadcast camera ("camera 1"), bench side, gantry
    broadcastCam: {along: 0, across: 45, height: 24, fov: 20},
};

// ── small math helpers ──────────────────────────────────────────────

// Closest distance between segments P1→Q1 and P2→Q2 (Ericson, RTCD 5.1.9).
// Returns {dist, c1, c2} with the closest points on each segment.
function segSegClosest(p1, q1, p2, q2) {
    const d1 = q1.clone().sub(p1);
    const d2 = q2.clone().sub(p2);
    const r = p1.clone().sub(p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
    let s, t;
    const EPS = 1e-12;
    if (a <= EPS && e <= EPS) { s = 0; t = 0; }
    else if (a <= EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
        const c = d1.dot(r);
        if (e <= EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else {
            const b = d1.dot(d2);
            const denom = a * e - b * b;
            s = denom > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
            else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
        }
    }
    const c1 = p1.clone().add(d1.multiplyScalar(s));
    const c2 = p2.clone().add(d2.multiplyScalar(t));
    return {dist: c1.distanceTo(c2), c1, c2};
}

// World (ECEF, HAE) position → the [lat, lon, altMSL] triple that
// CNodePositionLLA expects (its recalculate treats altitude as MSL and adds
// the geoid offset back). Skipping this conversion double-applies the geoid
// (~-27 m at Miami).
function worldToPositionLLA(worldPos) {
    const lla = ECEFToLLAVD_radii(worldPos);
    return [lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y)];
}

// The local "pitch frame" at the pitch-center node: unit vectors along the
// pitch long axis (compass pitchHeading), across (right of along), and up.
export function getPitchFrame() {
    const centerNode = NodeMan.get("footballPitchCenter", false);
    if (!centerNode) return null;
    const C = centerNode.p(0);
    const up = getLocalUpVector(C);
    const north = getLocalNorthVector(C);
    const east = getLocalEastVector(C);
    const h = radians(NodeMan.get("footballPitchHeading", false)?.v(0) ?? 0);
    const along = north.clone().multiplyScalar(Math.cos(h))
        .add(east.clone().multiplyScalar(Math.sin(h))).normalize();
    const across = along.clone().cross(up).normalize();
    return {C, up, along, across};
}

// World position from pitch-frame coords
export function pitchToWorld(alongM, acrossM, heightM, frame = null) {
    const pf = frame ?? getPitchFrame();
    if (!pf) return null;
    return pf.C.clone()
        .add(pf.along.clone().multiplyScalar(alongM))
        .add(pf.across.clone().multiplyScalar(acrossM))
        .add(pf.up.clone().multiplyScalar(heightM));
}

// The four cable-cam wire anchor points (world space), from the GUI values.
// Order: [+along+across (NE), +along-across (NW), -along+across (SE), -along-across (SW)]
// where "N/S/E/W" are just labels in the pitch frame.
const ANCHOR_NAMES = ["A (+long,+wide)", "B (+long,-wide)", "C (-long,+wide)", "D (-long,-wide)"];
export function getCableCamAnchors() {
    const pf = getPitchFrame();
    if (!pf) return null;
    const a = NodeMan.get("footballAnchorAlong", false)?.v(0) ?? 68;
    const c = NodeMan.get("footballAnchorAcross", false)?.v(0) ?? 52;
    const h = NodeMan.get("footballAnchorHeight", false)?.v(0) ?? 40;
    return [
        pitchToWorld(a, c, h, pf),
        pitchToWorld(a, -c, h, pf),
        pitchToWorld(-a, c, h, pf),
        pitchToWorld(-a, -c, h, pf),
    ];
}

// Wire sample counts: the physics collision path uses a coarse polyline
// (the sag is well under a meter, so 10 samples are within centimeters);
// the display uses a much smoother curve.
const WIRE_POINTS = 10;
const DISPLAY_WIRE_POINTS = 48;

// Convert kick-relative keys (dt seconds from the kick) to sitch-frame
// keyframes at the current Sit.fps, holding the first position from frame 0
// until the kick. Used for both the dolly path and the operator aim point.
function scenarioMotionToFrames(S, keys) {
    const fps = Sit.fps ?? 30;
    const kickF = Math.round(S.kick.launchTime * fps);
    const strip = (k) => ({along: k.along, across: k.across, height: k.height});
    const motion = [{f: 0, ...strip(keys[0])}];
    for (const k of keys) {
        motion.push({f: Math.round(kickF + k.dt * fps), ...strip(k)});
    }
    return motion;
}

// ── Cable-cam dolly track ───────────────────────────────────────────
// Keyframed motion in pitch-frame coordinates, smoothly interpolated
// (cosine ease between keyframes). Keyframes serialize via modSerialize.
export class CNodeCableCamTrack extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);
        this.useSitFrames = true;
        this.requireInputs(["center", "heading"]);
        this.optionalInputs(["anchorHeight"]);
        this.isNumber = false;
        this.motion = v.motion ?? [{f: 0, along: 0, across: 0, height: 20}];
        this.recalculate();
    }

    // pitch-frame sample at (possibly fractional) frame time
    sampleMotion(f) {
        const m = this.motion;
        if (f <= m[0].f) return m[0];
        if (f >= m[m.length - 1].f) return m[m.length - 1];
        let i = 0;
        while (i < m.length - 2 && m[i + 1].f < f) i++;
        const a = m[i], b = m[i + 1];
        const t = (f - a.f) / Math.max(1e-9, b.f - a.f);
        const s = 0.5 - 0.5 * Math.cos(t * Math.PI); // cosine ease in/out
        return {
            along: a.along + (b.along - a.along) * s,
            across: a.across + (b.across - a.across) * s,
            height: a.height + (b.height - a.height) * s,
        };
    }

    recalculate() {
        this.frames = Sit.frames;
        this.array = [];
        const pf = getPitchFrame();
        for (let f = 0; f < this.frames; f++) {
            const s = this.sampleMotion(f);
            const pos = pf ? pitchToWorld(s.along, s.across, s.height, pf)
                : this.in.center.p(0);
            this.array.push({position: pos});
        }
    }

    setMotion(motion) {
        this.motion = motion.slice().sort((a, b) => a.f - b.f);
        this.recalculateCascade();
    }

    modSerialize() {
        return {...super.modSerialize(), motion: this.motion};
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.motion) this.setMotion(v.motion);
    }
}

// ── The ball track ──────────────────────────────────────────────────
// Simulates the ball from the launch point/frame with quadratic drag,
// Magnus lift, ground bounces, and (optionally) collision with the
// cable-cam wires. One entry per sitch frame; before the launch frame the
// ball rests at the launch point.
export class CNodeFootballTrack extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);
        this.useSitFrames = true;
        this.requireInputs(["startTrack", "launchFrame", "heading", "elevation",
            "speed", "spin", "spinTilt", "drag"]);
        this.optionalInputs(["cableCam", "wireCollide", "wireSag", "wireBounce",
            "wireHitOffset", "anchorAlong", "anchorAcross", "anchorHeight"]);
        this.isNumber = false;
        // Ghost mode: simulate with the OPPOSITE of the wire-collide flag.
        // The ghost track is displayed as a thin grey "what if" line, so the
        // user always sees both the deflected and pass-through paths.
        this.ghost = !!v.ghost;
        this.collisions = [];       // [{frame, pos, wire, type}]
        this.minMiss = null;        // {dist, frame, wire} closest approach if no hit
        this.collisionsVersion = 0;
        this.recalculate();
    }

    // dolly position at fractional frame ff (lerp between whole frames)
    dollyAt(ff) {
        const cc = this.in.cableCam;
        if (!cc) return null;
        const f0 = Math.max(0, Math.min(cc.frames - 1, Math.floor(ff)));
        const f1 = Math.min(cc.frames - 1, f0 + 1);
        const p0 = cc.p(f0);
        return p0.clone().lerp(cc.p(f1), ff - f0);
    }

    recalculate() {
        this.frames = Sit.frames;

        const launchFrame = Math.floor(this.in.launchFrame.v(0));
        const startPos = this.in.startTrack.p(Math.max(0, Math.min(this.frames - 1, launchFrame)));

        // Recalc cascades reach this node from many unrelated sources (every
        // GUI drag tick, per-tile elevation events on the launch track, etc).
        // The simulation is a pure function of the values below, so skip the
        // re-simulation entirely when none of them changed.
        const pf0 = getPitchFrame();
        const fingerprint = JSON.stringify([
            launchFrame, this.in.heading.v(0), this.in.elevation.v(0),
            this.in.speed.v(0), this.in.spin.v(0), this.in.spinTilt.v(0),
            this.in.drag.v(0),
            this.in.wireCollide ? this.in.wireCollide.v(0) : null,
            this.in.wireBounce ? this.in.wireBounce.v(0) : null,
            this.in.wireSag ? this.in.wireSag.v(0) : null,
            this.in.wireHitOffset ? this.in.wireHitOffset.v(0) : null,
            this.in.anchorAlong ? this.in.anchorAlong.v(0) : null,
            this.in.anchorAcross ? this.in.anchorAcross.v(0) : null,
            this.in.anchorHeight ? this.in.anchorHeight.v(0) : null,
            startPos.x, startPos.y, startPos.z,
            pf0 ? [pf0.C.x, pf0.C.y, pf0.C.z] : null,
            this.in.cableCam ? this.in.cableCam.motion : null,
            this.frames, Sit.fps, Sit.simSpeed ?? 1,
        ]);
        if (fingerprint === this._fingerprint && this.array && this.array.length === this.frames) {
            return;
        }
        this._fingerprint = fingerprint;

        this.array = [];
        this.collisions = [];
        this.minMiss = null;
        this.collisionsVersion++;
        // Per-frame ball g-force — what the ball's IMU would read (gravity
        // doesn't register on an accelerometer): the peak aero (drag+Magnus)
        // proper acceleration, and impact events (the kick, wire strikes,
        // ground bounces) converted from their Δv over the ball's ~10 ms
        // contact-deformation time. The integrator resolves impacts in one
        // substep, so raw dv/dt there would overstate the g by ~5x.
        this.gForce = [];

        // Local frame at the launch point. Over a ~100m kick, treating
        // gravity and "up" as constant is well inside other error sources.
        const up = getLocalUpVector(startPos);
        const north = getLocalNorthVector(startPos);
        const east = getLocalEastVector(startPos);
        const groundLevel = 0; // heights measured relative to startPos along up

        const heading = radians(this.in.heading.v(0));
        const elevation = radians(this.in.elevation.v(0));
        const speed = this.in.speed.v(0);
        const spinRPM = this.in.spin.v(0);
        const spinTilt = radians(this.in.spinTilt.v(0));
        const Cd = this.in.drag.v(0);
        const rawCollide = this.in.wireCollide ? !!this.in.wireCollide.v(0) : false;
        const collideWires = this.ghost ? !rawCollide : rawCollide;
        const wireRestitution = this.in.wireBounce ? this.in.wireBounce.v(0) : 0.4;
        // Off-center hit fraction: how far off the ball's center the wire
        // strikes, as a fraction of the effective radius (GUI is in %).
        const hitOffset = Math.max(-1, Math.min(1,
            (this.in.wireHitOffset ? this.in.wireHitOffset.v(0) : 0) / 100));

        const dirH = north.clone().multiplyScalar(Math.cos(heading))
            .add(east.clone().multiplyScalar(Math.sin(heading))).normalize();
        const vel = dirH.clone().multiplyScalar(speed * Math.cos(elevation))
            .add(up.clone().multiplyScalar(speed * Math.sin(elevation)));

        // Spin axis: 0 tilt = pure backspin (axis points right of travel,
        // Magnus lift up); +90 = axis up (curves left); negative RPM = topspin.
        const right = dirH.clone().cross(up).normalize();
        let omegaMag = spinRPM * 2 * Math.PI / 60; // rad/s
        const spinAxis = right.clone().multiplyScalar(Math.cos(spinTilt))
            .add(up.clone().multiplyScalar(Math.sin(spinTilt))).normalize();

        const gravity = up.clone().multiplyScalar(-GRAVITY);
        const kDrag = 0.5 * AIR_RHO * BALL_AREA / BALL_MASS;

        const heightOf = (p) => p.clone().sub(startPos).dot(up);

        // per-frame output; simulate with fixed substeps between frames.
        // simSpeed/fps is the REAL seconds per sitch frame (slow-motion
        // video sitches have simSpeed < 1), so the physics stays physical
        // on any timeline.
        const fps = Sit.fps ?? 30;
        const frameDT = (Sit.simSpeed ?? 1) / fps;
        // ball rests with its center one radius above the launch point
        let pos = startPos.clone().add(up.clone().multiplyScalar(BALL_RADIUS));
        let v = vel.clone();
        let flying = false;
        let atRest = false;
        const rEff = BALL_RADIUS + WIRE_RADIUS;

        // Wire-collision context, computed once per recalculation — the
        // anchors and pitch frame only move with inputs of this node, and
        // any input change re-runs the whole simulation.
        const anchors = this.in.cableCam ? getCableCamAnchors() : null;
        const wireSag = this.in.wireSag ? this.in.wireSag.v(0) : 0.6;
        const pitchUp = pf0 ? pf0.up : up;
        if (!this._wireBuf) {
            this._wireBuf = Array.from({length: 4}, () =>
                Array.from({length: WIRE_POINTS}, () => new Vector3()));
        }

        // flight diagnostics (apex, first ground contact) for tuning/reports
        let maxHeight = 0, maxHeightFrame = launchFrame;
        let firstBounce = null;
        let airborne = false; // clear of the ground — gates the landing record

        for (let f = 0; f < this.frames; f++) {
            if (f < launchFrame || atRest) {
                this.array.push({position: pos.clone()});
                this.gForce.push(1);   // at rest: 1 g of support force
                continue;
            }
            if (f === launchFrame) flying = true;
            if (!flying) { this.array.push({position: pos.clone()}); this.gForce.push(1); continue; }

            // The wires move with the dolly, but within one display frame
            // that is millimetres — build the sampled polylines once per
            // frame into reusable buffers instead of every substep.
            let wires = null;
            if (anchors) {
                const dolly = this.dollyAt(f);
                if (dolly) {
                    // wires join the rig above the camera point (fresh clone
                    // from dollyAt, so shifting in place is safe)
                    dolly.addScaledVector(pitchUp, WIRE_ATTACH_ABOVE);
                    for (let w = 0; w < 4; w++) {
                        const buf = this._wireBuf[w];
                        for (let i = 0; i < WIRE_POINTS; i++) {
                            const tt = i / (WIRE_POINTS - 1);
                            buf[i].copy(anchors[w]).lerp(dolly, tt)
                                .addScaledVector(pitchUp, -wireSag * 4 * tt * (1 - tt));
                        }
                    }
                    wires = this._wireBuf;
                }
            }

            // integrate one display frame in SIM_DT substeps
            let t = 0;
            let peakAeroG = 0;
            // Impulsive |Δv| this frame. The kick is a real impact too — the
            // ball goes from rest to launch speed inside one foot contact —
            // so it lands here as a one-frame spike (~360 g at 35 m/s).
            let dvImpulse = (f === launchFrame) ? speed : 0;
            while (t < frameDT - 1e-9 && !atRest) {
                const dt = Math.min(SIM_DT, frameDT - t);
                const vPrev = v.clone();   // for the IMU-style g readout
                const speedNow = v.length();

                // accelerations
                const acc = gravity.clone();
                if (speedNow > 1e-6) {
                    // quadratic drag
                    acc.add(v.clone().multiplyScalar(-kDrag * Cd * speedNow));
                    // Magnus: Cl from spin ratio S = r*omega/v (Goff & Carré)
                    if (Math.abs(omegaMag) > 1e-6) {
                        const S = BALL_RADIUS * Math.abs(omegaMag) / speedNow;
                        const Cl = Math.min(0.45, 0.62 * Math.pow(S, 0.7));
                        const magnusDir = spinAxis.clone()
                            .multiplyScalar(Math.sign(omegaMag))
                            .cross(v.clone().normalize());
                        acc.add(magnusDir.multiplyScalar(kDrag * Cl * speedNow * speedNow));
                    }
                }

                // semi-implicit Euler substep
                v.add(acc.multiplyScalar(dt));
                const vIntegrated = v.clone();   // before any contact response
                const prevPos = pos.clone();
                pos.add(v.clone().multiplyScalar(dt));

                // wire collision: motion segment vs sampled wire polylines.
                // A coarse test against the straight anchor-dolly chord
                // (padded by the sag) gates the detailed per-segment pass.
                const ff = f + t / frameDT;
                if (wires) {
                    for (let w = 0; w < 4; w++) {
                        const pts = wires[w];
                        const coarse = segSegClosest(prevPos, pos, pts[0], pts[WIRE_POINTS - 1]);
                        if (coarse.dist > rEff + wireSag + 0.5) {
                            if (!this.minMiss || coarse.dist < this.minMiss.dist) {
                                this.minMiss = {dist: coarse.dist, frame: Math.round(ff), wire: w};
                            }
                            continue;
                        }
                        let best = null, bestSeg = 0;
                        for (let i = 0; i < pts.length - 1; i++) {
                            const r = segSegClosest(prevPos, pos, pts[i], pts[i + 1]);
                            if (!best || r.dist < best.dist) { best = r; bestSeg = i; }
                        }
                        if (best.dist < rEff) {
                            // contact
                            this.collisions.push({
                                frame: Math.round(ff), wire: w,
                                pos: best.c1.clone(),
                                name: ANCHOR_NAMES[w],
                            });
                            if (collideWires) {
                                // Collision normal, constructed rather than taken
                                // from the substep closest-approach vector (which
                                // for crossing segments is ⊥ to the path and
                                // quantized by the substep). Head-on part: −v
                                // projected ⊥ the wire — the flight direction
                                // alone decides top vs bottom (a climbing ball is
                                // struck on its upper face, a dropping one
                                // underneath). hitOffset then slides the impact
                                // point SIDEWAYS, along the mutual perpendicular
                                // of the path and the wire (= the lateral miss
                                // distance of the wire off the ball's center
                                // line, as a fraction of the radius): +1 = grazes
                                // the right side of the ball (deflects it left),
                                // −1 = the left side, 0 = dead center.
                                const wdir = pts[bestSeg + 1].clone().sub(pts[bestSeg]).normalize();
                                const n = v.clone().multiplyScalar(-1);
                                n.addScaledVector(wdir, -n.dot(wdir));
                                if (n.lengthSq() > 1e-12) n.normalize(); else n.copy(up);
                                if (hitOffset !== 0) {
                                    // side axis: ⊥ path and ⊥ wire, signed to the
                                    // right of the direction of travel (degenerate
                                    // when the path runs along the wire — then
                                    // there is no "side" and the tilt is skipped)
                                    const side = v.clone().cross(wdir);
                                    if (side.lengthSq() > 1e-12) {
                                        side.normalize();
                                        if (side.dot(v.clone().cross(up)) < 0) side.negate();
                                        // impact right of center → normal tilts left,
                                        // away from the impact point
                                        n.multiplyScalar(Math.sqrt(1 - hitOffset * hitOffset))
                                            .addScaledVector(side, -hitOffset);
                                    }
                                }
                                const vn = v.dot(n);
                                if (vn < 0) {
                                    // inelastic bounce: normal reflected with
                                    // the wire-bounce restitution, tangential
                                    // scrubbed by wire friction (the thin wire
                                    // bites into the ball surface)
                                    const vNormal = n.clone().multiplyScalar(vn);
                                    const vTangent = v.clone().sub(vNormal);
                                    v = vTangent.multiplyScalar(WIRE_FRICTION)
                                        .add(n.clone().multiplyScalar(-vn * wireRestitution));
                                }
                                pos.copy(best.c2.clone().add(n.multiplyScalar(rEff + 0.005)));
                                omegaMag *= 0.8;
                            }
                        } else if (!this.minMiss || best.dist < this.minMiss.dist) {
                            this.minMiss = {dist: best.dist, frame: Math.round(ff), wire: w};
                        }
                    }
                }

                // ground bounce (plane through the launch point)
                const h = heightOf(pos);
                if (h > maxHeight) { maxHeight = h; maxHeightFrame = f + t * fps; }
                if (h > groundLevel + BALL_RADIUS + 0.5) airborne = true;
                if (h < groundLevel + BALL_RADIUS) {
                    if (airborne && !firstBounce) {
                        firstBounce = {frame: f + t * fps, pos: pos.clone()};
                    }
                    const vUp = v.dot(up);
                    if (vUp < 0) {
                        // reflect
                        const vVert = up.clone().multiplyScalar(vUp);
                        const vHoriz = v.clone().sub(vVert);
                        v = vHoriz.multiplyScalar(GROUND_FRICTION)
                            .add(up.clone().multiplyScalar(-vUp * GROUND_RESTITUTION));
                        omegaMag *= 0.5;
                        // rest condition: too slow to meaningfully bounce/roll
                        if (v.length() < 0.8) {
                            v.set(0, 0, 0);
                            atRest = true;
                        }
                    }
                    pos = pos.clone().sub(up.clone().multiplyScalar(h - groundLevel - BALL_RADIUS));
                }
                // Split the g readout: contact responses (wire, ground) are
                // instantaneous velocity edits, so bank their Δv for the
                // contact-time conversion below; the smooth aero part
                // (drag + Magnus) is a true continuous dv/dt − g.
                dvImpulse += v.clone().sub(vIntegrated).length();
                const aAero = vIntegrated.sub(vPrev).divideScalar(dt).sub(gravity);
                peakAeroG = Math.max(peakAeroG, aAero.length() / GRAVITY);
                t += dt;
            }
            this.array.push({position: pos.clone()});
            this.gForce.push(Math.max(peakAeroG, dvImpulse / CONTACT_TIME / GRAVITY));
        }

        // de-duplicate near-identical successive contacts (substeps in contact)
        const dedup = [];
        for (const c of this.collisions) {
            const last = dedup[dedup.length - 1];
            if (last && last.wire === c.wire && Math.abs(last.frame - c.frame) <= 3) continue;
            dedup.push(c);
        }
        this.collisions = dedup;

        // pitch-frame flight summary for tuning and reporting
        const pf = getPitchFrame();
        const toPitch = (p) => {
            if (!pf || !p) return null;
            const d = p.clone().sub(pf.C);
            return {
                along: +d.dot(pf.along).toFixed(1),
                across: +d.dot(pf.across).toFixed(1),
                height: +d.dot(pf.up).toFixed(1),
            };
        };
        this.flightInfo = {
            apexHeight: +maxHeight.toFixed(1),
            apexFrame: Math.round(maxHeightFrame),
            apexPitch: toPitch(this.array[Math.min(this.frames - 1, Math.round(maxHeightFrame))]?.position),
            landFrame: firstBounce ? Math.round(firstBounce.frame) : null,
            landPitch: firstBounce ? toPitch(firstBounce.pos) : null,
            rangeM: firstBounce ? +firstBounce.pos.clone().sub(startPos).dot(dirH).toFixed(1) : null,
            collisions: this.collisions.map(c => ({frame: c.frame, wire: c.name, pitch: toPitch(c.pos)})),
        };
        // the ghost's contacts are a hypothetical — keep them off the GUI
        if (!this.ghost) updateCollisionStatus(this);
    }
}

// ── Wires + collision-marker display ────────────────────────────────
// Draws the four wires from the anchors to the dolly at the current frame,
// and red markers at any ball-wire contact points.
//
// MAIN layer only: the look camera rides the (smoothed) dolly, so wires
// rendered there sweep right past the lens and any lag/quantization reads
// as judder. The broadcast camera carries the MAIN bit so it still sees
// them. Geometry is built RELATIVE to the pitch center (group.position):
// Line2 buffers are float32, and absolute ECEF magnitudes (~6.4e6 m)
// quantize to ~0.5 m — visible wobble; local coordinates are sub-mm.
export class CNodeDisplayCableCamWires extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_MAIN;
        super(v);
        this.input("cableCam");
        this.optionalInputs(["ballTrack"]);
        this.matLine = makeMatLine(new Color(0.15, 0.15, 0.15), 1.5);
        this.wireLines = [];
        this.wireGeoms = [];
        this.markerMeshes = [];
        this._markerVersion = -1;
        this._lastDollyPos = null;
        this._origin = new Vector3();
        this.rebuildWires(0);
    }

    dispose() {
        this.clearWires();
        this.clearMarkers();
        disposeMatLine(this.matLine);
        super.dispose();
    }

    clearWires() {
        for (const l of this.wireLines) this.group.remove(l);
        for (const g of this.wireGeoms) dispose(g);
        this.wireLines = [];
        this.wireGeoms = [];
    }

    clearMarkers() {
        for (const m of this.markerMeshes) {
            this.group.remove(m);
            dispose(m.geometry);
            m.material.dispose();
        }
        this.markerMeshes = [];
    }

    rebuildWires(f) {
        this.clearWires();
        const dolly = this.in.cableCam.p(f);
        const anchors = getCableCamAnchors();
        const pf = getPitchFrame();
        if (!dolly || !anchors || !pf) return;
        const sag = NodeMan.get("footballWireSag", false)?.v(0) ?? 0.6;

        // local frame origin = pitch center; markers share it, so refresh
        // them if it moved (pitch edits are rare)
        if (this._origin.distanceToSquared(pf.C) > 1e-6) {
            this._origin.copy(pf.C);
            this.group.position.copy(this._origin);
            this._markerVersion = -1;
        }

        // wires join the rig above the camera point
        const attach = dolly.clone().addScaledVector(pf.up, WIRE_ATTACH_ABOVE);
        const p = new Vector3();
        for (const anchor of anchors) {
            const flat = [];
            for (let i = 0; i < DISPLAY_WIRE_POINTS; i++) {
                const t = i / (DISPLAY_WIRE_POINTS - 1);
                p.copy(anchor).lerp(attach, t)
                    .addScaledVector(pf.up, -sag * 4 * t * (1 - t))
                    .sub(this._origin);
                flat.push(p.x, p.y, p.z);
            }
            const geom = new LineGeometry();
            geom.setPositions(flat);
            const line = new Line2(geom, this.matLine);
            line.computeLineDistances();
            this.group.add(line);
            this.wireLines.push(line);
            this.wireGeoms.push(geom);
        }
        propagateLayerMaskObject(this.group);
    }

    rebuildMarkers() {
        this.clearMarkers();
        const ball = this.in.ballTrack;
        if (!ball) return;
        for (const c of ball.collisions) {
            const mesh = new Mesh(
                new SphereGeometry(0.35, 12, 8),
                new MeshBasicMaterial({color: 0xff2020})
            );
            mesh.position.copy(c.pos).sub(this._origin);
            this.group.add(mesh);
            this.markerMeshes.push(mesh);
        }
        propagateLayerMaskObject(this.group);
    }

    update(f) {
        super.update(f);
        if (!this.group.visible) return;
        const dolly = this.in.cableCam.p(f);
        if (!this._lastDollyPos || this._lastDollyPos.distanceToSquared(dolly) > 1e-6) {
            this.rebuildWires(f);
            this._lastDollyPos = dolly.clone();
        }
        const ball = this.in.ballTrack;
        if (ball && ball.collisionsVersion !== this._markerVersion) {
            this._markerVersion = ball.collisionsVersion;
            this.rebuildMarkers();
        }
    }

    recalculate() {
        this._lastDollyPos = null; // force wire rebuild (anchors may have moved)
        this.rebuildWires(par.frame);
    }
}

// ── pitch ground overlay ────────────────────────────────────────────
// Drapes data/images/footballPitch.png (105x68 regulation markings on a
// 117x80 grass apron) onto the terrain, centered on the pitch-center node
// and rotated to the pitch heading. Bounds are constructor state, so the
// overlay is rebuilt whenever the pitch frame moves.
const PITCH_IMG_L = 117;  // m, image footprint incl. apron (long axis = E-W at rotation 0)
const PITCH_IMG_W = 80;

export function updatePitchOverlay() {
    const pf = getPitchFrame();
    if (!pf) return;
    const lla = ECEFToLLAVD_radii(pf.C);
    const lat = lla.x, lon = lla.y;
    const latR = radians(lat);
    const mPerDegLat = 111132.95 - 559.85 * Math.cos(2 * latR) + 1.175 * Math.cos(4 * latR);
    const mPerDegLon = 111319.49 * Math.cos(latR);
    const halfNS = (PITCH_IMG_W / 2) / mPerDegLat;
    const halfEW = (PITCH_IMG_L / 2) / mPerDegLon;
    const heading = NodeMan.get("footballPitchHeading", false)?.v(0) ?? 90;

    if (NodeMan.exists("footballPitchOverlay")) {
        NodeMan.unlinkDisposeRemove("footballPitchOverlay");
    }
    const overlay = new CNodeGroundOverlay({
        id: "footballPitchOverlay",
        name: "Football Pitch",
        imageURL: SITREC_APP + "data/images/footballPitch.png",
        north: lat + halfNS, south: lat - halfNS,
        east: lon + halfEW, west: lon - halfEW,
        // Image long axis is E-W at rotation 0. GroundOverlay rotation is
        // applied to the texture sampling, so positive turns the drawn
        // overlay counter-clockwise — negate for a compass heading.
        rotation: 90 - heading,
        opacity: 1.0,
        noGUI: true,
    });
    overlay.visibleCheck = () => !!NodeMan.get("footballShowPitch", false)?.v(0);
    setRenderOne(true);
    return overlay;
}

// Rebuild the overlay — but not during a suppressed-recalc window (sitch
// load applies mods with Globals.dontRecalculate set): the pitch-center
// mods restore _LLA with recalculation disabled, so its p(0) is stale until
// the end-of-load recalc, and an overlay built now would drape at the OLD
// pitch location (the default start island, after reloading a Miami save).
// Defer until the load fully settles, coalescing repeated triggers (lat,
// lon, alt, heading each fire one) into a single build.
let overlayRebuildPending = false;
function requestPitchOverlayRebuild() {
    if (!Globals.dontRecalculate && !Globals.deserializing) {
        updatePitchOverlay();
        return;
    }
    if (overlayRebuildPending) return;
    overlayRebuildPending = true;
    const tick = () => {
        if (Globals.dontRecalculate || Globals.deserializing) {
            setTimeout(tick, 50);
            return;
        }
        overlayRebuildPending = false;
        // re-check: the flag may have been turned off while we waited
        if (NodeMan.get("footballShowPitch", false)?.v(0)) updatePitchOverlay();
    };
    setTimeout(tick, 50);
}

// ── collision status line in the GUI ────────────────────────────────
const footballStatus = {contact: "no simulation yet"};
let statusController = null;

function updateCollisionStatus(ballTrack) {
    if (ballTrack.collisions.length > 0) {
        const c = ballTrack.collisions[0];
        const msg = `HIT wire ${c.name} at frame ${c.frame}`
            + (ballTrack.collisions.length > 1 ? ` (+${ballTrack.collisions.length - 1} more)` : "");
        if (msg !== footballStatus.contact) {
            console.log("Football wire contacts:", ballTrack.collisions
                .map(c => `wire ${c.name} frame ${c.frame}`).join(", "));
        }
        footballStatus.contact = msg;
    } else if (ballTrack.minMiss) {
        footballStatus.contact = `no hit — closest ${ballTrack.minMiss.dist.toFixed(2)} m `
            + `(wire ${ANCHOR_NAMES[ballTrack.minMiss.wire]}, frame ${ballTrack.minMiss.frame})`;
    } else {
        footballStatus.contact = "no cable cam in scene";
    }
    statusController?.updateDisplay();
    setRenderOne(true);
}

// ── setup ───────────────────────────────────────────────────────────

function guiValue(id, value, start, end, step, desc, tooltip, folder) {
    if (NodeMan.exists(id)) return NodeMan.get(id);
    return new CNodeGUIValue({id, value, start, end, step, desc, tooltip}, folder);
}

function guiFlag(id, value, desc, tooltip, folder) {
    if (NodeMan.exists(id)) return NodeMan.get(id);
    return new CNodeGUIFlag({id, value, desc, tooltip}, folder);
}

// Non-permanent subfolder of the Football menu, registered in guiMenus so
// nodes can reference it by key. Recreated on every sitch load (menuBar
// destroy(false) removes non-perm children), so refresh the stale entry.
function footballSubFolder(key, title) {
    const parent = guiMenus.football;
    let f = guiMenus[key];
    if (!f || !parent.folders.includes(f)) {
        f = parent.addFolder(title).close();
        guiMenus[key] = f;
    }
    return f;
}

export function activateFootball() {
    const folder = guiMenus.football;
    if (!folder) return;

    // Needs the custom-sitch track infrastructure
    const targetTrack = NodeMan.get("targetTrackSwitchSmooth", false);
    const cameraTrack = NodeMan.get("cameraTrackSwitchSmooth", false);
    if (!targetTrack) return;

    // ── launch parameter GUI ────────────────────────────────────
    if (!NodeMan.exists("footballStartTrack")) {
        const inputs = {Target: targetTrack};
        if (cameraTrack) inputs.Camera = cameraTrack;
        new CNodeTrackSwitch({
            id: "footballStartTrack",
            inputs,
            default: "Target",
            desc: "Launch From Track",
            gui: "football",
        });
    }

    const launchFrame = guiValue("footballLaunchFrame", 30, 0, Math.max(1, Sit.frames - 1), 1,
        "Launch Frame", "Sitch frame at which the ball is kicked", folder);
    const heading = guiValue("footballHeading", 0, 0, 360, 0.1,
        "Kick Heading (°)", "Compass direction of the kick (0 = North)", folder);
    const elevation = guiValue("footballElevation", 40, 0, 89, 0.1,
        "Elevation Angle (°)", "Launch angle above the horizontal", folder);
    const speed = guiValue("footballSpeed", 30, 1, 60, 0.1,
        "Speed (m/s)", "Initial ball speed. Long goal kicks are typically 25-35 m/s", folder);
    const spin = guiValue("footballSpin", 300, -1200, 1200, 5,
        "Spin (rpm)", "Ball spin. Positive = backspin (lift), negative = topspin (dip)", folder);
    const spinTilt = guiValue("footballSpinTilt", 0, -90, 90, 1,
        "Spin Axis Tilt (°)", "0 = pure backspin, +90 = sidespin curving left, -90 = curving right", folder);
    const drag = guiValue("footballDrag", 0.22, 0, 0.6, 0.005,
        "Air Drag Cd", "Drag coefficient. ~0.2-0.25 for a fast soccer ball, 0 = vacuum", folder);

    const showBall = guiFlag("footballShowBall", false, "Show Football",
        "Show the ball, its trajectory, and enable the simulation", folder);
    const wireCollide = guiFlag("footballWireCollide", true, "Ball Bounces Off Wires",
        "When on, the ball deflects off cable-cam wires; when off it passes through (contacts still reported)", folder);

    // status line (read-only text). Folder contents are destroyed on sitch
    // change, so look the controller up by name rather than caching blindly.
    statusController = folder.controllers.find(c => c._name === "Wire Contact");
    if (!statusController) {
        statusController = folder.add(footballStatus, "contact").name("Wire Contact");
        statusController.disable();
    }

    // "kick now" convenience
    const actions = {
        kickNow: () => {
            launchFrame.setValue(par.frame);
            NodeMan.get("footballTrack", false)?.recalculateCascade();
        },
        loadScenario: () => loadGoalKickScenario(),
    };
    if (!folder.controllers.find(c => c._name === "Set Launch Frame = Now")) {
        folder.add(actions, "kickNow").name("Set Launch Frame = Now");
    }

    // ── pitch frame + cable cam ─────────────────────────────────
    // Pitch center defaults to ground under the current target; the scenario
    // (or the user, via the LLA fields) moves it to a real stadium.
    footballSubFolder("footballPitchLoc", "Pitch Location");
    if (!NodeMan.exists("footballPitchCenter")) {
        new CNodePositionLLA({
            id: "footballPitchCenter",
            LLA: worldToPositionLLA(targetTrack.p(0)),
            desc: "Pitch Center",
            gui: "footballPitchLoc",
        });
    }
    // getPitchFrame() reads this node's p(0) via the NodeMan side-channel
    // (no graph edge), so the checkDisplayOutputs gate — which skips nodes
    // with no visible display outputs in recalculateAllRootFirst — could
    // leave its ecef stale after a save reload (mods restore _LLA with
    // recalcs suppressed). Its recalculate is one LLAToECEF; always run it.
    NodeMan.get("footballPitchCenter").checkDisplayOutputs = false;
    const pitchHeading = guiValue("footballPitchHeading", 0, 0, 360, 0.1,
        "Pitch Heading (°)", "Compass bearing of the pitch long axis", folder);
    const anchorAlong = guiValue("footballAnchorAlong", 70, 20, 200, 0.5,
        "Anchor Dist Long (m)", "Wire anchor distance from pitch center along the long axis", folder);
    const anchorAcross = guiValue("footballAnchorAcross", 45, 20, 200, 0.5,
        "Anchor Dist Wide (m)", "Wire anchor distance from pitch center across the pitch", folder);
    const anchorHeight = guiValue("footballAnchorHeight", 48, 5, 100, 0.5,
        "Anchor Height (m)", "Wire anchor height above the pitch (stadium roof line)", folder);
    const wireSag = guiValue("footballWireSag", 0.6, 0, 5, 0.05,
        "Wire Sag (m)", "Mid-span sag of each support wire", folder);
    const wireBounce = guiValue("footballWireBounce", 0.4, 0, 1, 0.05,
        "Wire Bounce", "Restitution of a ball-wire contact. Low = the wire kills the ball's momentum", folder);
    const wireHitOffset = guiValue("footballWireHitOffset", 0, -100, 100, 1,
        "Wire Hit Offset (%)",
        "How far to the SIDE of the ball's center the wire strikes, as a % of the ball's radius. "
        + "0 = dead center (kills the momentum), +100 = grazes the ball's right side (deflects it left), "
        + "-100 = the left side. Top/bottom contact follows from the flight direction: a climbing ball "
        + "is struck on its upper face, a dropping one underneath", folder);

    const showCableCam = guiFlag("footballShowCableCam", false, "Show Cable Cam",
        "Show the cable-cam dolly, its path, and the four support wires", folder);

    // Optionally render the wires in the look view too. Off by default: the
    // look camera often rides the dolly, and wires sweeping right past the
    // lens read as judder (why the wires are MAIN-only — see
    // CNodeDisplayCableCamWires). The broadcast view sees them either way.
    const wiresInLook = guiFlag("footballWiresLookView", false, "Wires in Look View",
        "Also render the cable-cam wires (and contact markers) in the look view. "
        + "Off by default because wires sweeping past the lens of a dolly-riding camera read as judder", folder);
    const applyWiresLookLayers = () => {
        const wires = NodeMan.get("footballWires", false);
        if (!wires) return;
        wires.group.layers.mask = wiresInLook.v(0)
            ? (LAYER.MASK_MAIN | LAYER.MASK_LOOK) : LAYER.MASK_MAIN;
        propagateLayerMaskObject(wires.group);
        setRenderOne(true);
    };
    wiresInLook.onChange = applyWiresLookLayers;

    const showPitch = guiFlag("footballShowPitch", false, "Show Pitch Overlay",
        "Drape a regulation 105x68 m pitch (grass + white lines) on the ground at the pitch location", folder);
    // Fires on user toggles AND on modDeserialize (guiEntry.setValue), so a
    // saved sitch with the overlay enabled rebuilds it on load — after the
    // pitch-center/heading mods, which were created (and thus deserialize)
    // earlier in this setup.
    showPitch.onChange = () => {
        if (showPitch.v(0) && !NodeMan.exists("footballPitchOverlay")) requestPitchOverlayRebuild();
        setRenderOne(true);
    };

    // Keep the overlay glued to the pitch frame when the user (or a loading
    // save) edits the pitch center or heading after the overlay was built.
    const refreshOverlayIfPresent = () => {
        if (NodeMan.exists("footballPitchOverlay")) requestPitchOverlayRebuild();
    };
    pitchHeading.onChange = refreshOverlayIfPresent;
    // EventManager.removeAll() runs on sitch dispose, so re-register every
    // setup — a one-shot guard would leave a dead listener after an
    // in-session sitch switch.
    if (setupFootball._overlayEventHandler) {
        EventManager.removeEventListener("PositionLLA.onChange", setupFootball._overlayEventHandler);
    }
    setupFootball._overlayEventHandler = (data) => {
        if (data?.id === "footballPitchCenter") refreshOverlayIfPresent();
    };
    EventManager.addEventListener("PositionLLA.onChange", setupFootball._overlayEventHandler);

    if (!NodeMan.exists("footballCableCamTrack")) {
        new CNodeCableCamTrack({
            id: "footballCableCamTrack",
            center: "footballPitchCenter",
            heading: "footballPitchHeading",
            anchorHeight: "footballAnchorHeight",
            motion: scenarioMotionToFrames(GOAL_KICK_SCENARIO, GOAL_KICK_SCENARIO.cableCam),
        });
    }

    // ── cable cam as a camera: position / heading / FOV sources ─
    // The operator's aim point, keyframed in the pitch frame like the dolly.
    if (!NodeMan.exists("footballCableCamAim")) {
        new CNodeCableCamTrack({
            id: "footballCableCamAim",
            center: "footballPitchCenter",
            heading: "footballPitchHeading",
            motion: scenarioMotionToFrames(GOAL_KICK_SCENARIO, GOAL_KICK_SCENARIO.cableCamAim),
        });
    }

    // Position: the dolly track joins the Camera menu's Position switch, so
    // the look camera can ride the cable cam.
    const camTrackSwitch = NodeMan.get("cameraTrackSwitch", false);
    if (camTrackSwitch && camTrackSwitch.inputs["Cable Cam"] === undefined) {
        camTrackSwitch.addOption("Cable Cam", NodeMan.get("footballCableCamTrack"));
    }

    // Heading: a TrackToTrack controller that keeps the look camera pointed
    // at the keyframed aim point, gated by the Camera Heading switch.
    const losSwitch = NodeMan.get("CameraLOSController", false);
    const lookCamera = NodeMan.get("lookCamera", false);
    if (losSwitch && lookCamera && losSwitch.inputs["Cable Cam Aim"] === undefined) {
        const aimController = new CNodeControllerTrackToTrack({
            id: "footballCableCamAimController",
            sourceTrack: "cameraTrackSwitchSmooth",
            targetTrack: "footballCableCamAim",
        });
        lookCamera.addControllerNode(aimController);
        losSwitch.addOption("Cable Cam Aim", aimController);
    }

    // FOV: a wide spidercam lens as a Camera FOV source.
    const cableCamFOV = guiValue("footballCableCamFOV", GOAL_KICK_SCENARIO.cableCamFOV, 10, 120, 0.5,
        "Cable Cam FOV (°)", "Vertical FOV of the cable-cam lens (used when Camera FOV source = Cable Cam)", folder);
    const fovSwitch = NodeMan.get("fovSwitch", false);
    if (fovSwitch && fovSwitch.inputs["Cable Cam"] === undefined) {
        fovSwitch.addOption("Cable Cam", cableCamFOV);
    }

    // ── ball track + displays ───────────────────────────────────
    if (!NodeMan.exists("footballTrack")) {
        new CNodeFootballTrack({
            id: "footballTrack",
            startTrack: "footballStartTrack",
            launchFrame: "footballLaunchFrame",
            heading: "footballHeading",
            elevation: "footballElevation",
            speed: "footballSpeed",
            spin: "footballSpin",
            spinTilt: "footballSpinTilt",
            drag: "footballDrag",
            cableCam: "footballCableCamTrack",
            wireCollide: "footballWireCollide",
            wireSag: "footballWireSag",
            wireBounce: "footballWireBounce",
            wireHitOffset: "footballWireHitOffset",
            anchorAlong: "footballAnchorAlong",
            anchorAcross: "footballAnchorAcross",
            anchorHeight: "footballAnchorHeight",
        });
    }

    const ballVisible = () => !!showBall.v(0);
    const cableCamVisible = () => !!showCableCam.v(0);

    if (!NodeMan.exists("footballBall")) {
        const ball = new CNode3DObject({
            id: "footballBall",
            geometry: "sphere",
            radius: BALL_RADIUS,
            color: "#ffffff",
            material: "phong",
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        ball.addController("TrackPosition", {sourceTrack: "footballTrack"});
        ball.visibleCheck = ballVisible;
    }

    if (!NodeMan.exists("footballTrackDisplay")) {
        const disp = new CNodeDisplayTrack({
            id: "footballTrackDisplay",
            track: "footballTrack",
            color: new CNodeConstant({id: "footballTrackColor", value: new Color(1, 1, 1)}),
            width: 2,
            trackDisplayStep: 1,
            minWallStep: 1e9,   // no ground wall
            layers: LAYER.MASK_HELPERS | LAYER.MASK_LOOK,
        });
        disp.visibleCheck = ballVisible;
    }

    // The "what if" counterpart: the same kick simulated with the OPPOSITE
    // "Ball Bounces Off Wires" setting, drawn as a thin grey line. With
    // deflection on, the grey line is where the ball would have flown
    // unimpeded; with it off, the grey line is the deflected path. When
    // there is no wire contact the two coincide (the grey hides under the
    // white), which is the honest picture.
    if (!NodeMan.exists("footballTrackGhost")) {
        new CNodeFootballTrack({
            id: "footballTrackGhost",
            ghost: true,
            startTrack: "footballStartTrack",
            launchFrame: "footballLaunchFrame",
            heading: "footballHeading",
            elevation: "footballElevation",
            speed: "footballSpeed",
            spin: "footballSpin",
            spinTilt: "footballSpinTilt",
            drag: "footballDrag",
            cableCam: "footballCableCamTrack",
            wireCollide: "footballWireCollide",
            wireSag: "footballWireSag",
            wireBounce: "footballWireBounce",
            wireHitOffset: "footballWireHitOffset",
            anchorAlong: "footballAnchorAlong",
            anchorAcross: "footballAnchorAcross",
            anchorHeight: "footballAnchorHeight",
        });
    }

    // ghost ball riding the ghost track — same as the real ball but 50%
    // transparent, so the "what if" flight reads as a ball, not just a line
    if (!NodeMan.exists("footballBallGhost")) {
        const ghostBall = new CNode3DObject({
            id: "footballBallGhost",
            geometry: "sphere",
            radius: BALL_RADIUS,
            color: "#ffffff",
            material: "phong",
            opacity: 0.5,
            transparent: true,
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        ghostBall.addController("TrackPosition", {sourceTrack: "footballTrackGhost"});
        ghostBall.visibleCheck = ballVisible;
    }

    if (!NodeMan.exists("footballTrackGhostDisplay")) {
        const ghostDisp = new CNodeDisplayTrack({
            id: "footballTrackGhostDisplay",
            track: "footballTrackGhost",
            color: new CNodeConstant({id: "footballTrackGhostColor", value: new Color(0.45, 0.45, 0.45)}),
            width: 0.75,
            trackDisplayStep: 1,
            minWallStep: 1e9,
            layers: LAYER.MASK_HELPERS | LAYER.MASK_LOOK,
        });
        ghostDisp.visibleCheck = ballVisible;
    }

    if (!NodeMan.exists("footballCableCamDolly")) {
        // MAIN only, like the wires: the look camera rides (inside) this box
        const dolly = new CNode3DObject({
            id: "footballCableCamDolly",
            geometry: "box",
            width: 0.8, height: 0.6, depth: 0.8,
            color: "#202020",
            material: "phong",
            layers: LAYER.MASK_MAIN,
        });
        dolly.addController("TrackPosition", {sourceTrack: "footballCableCamTrack"});
        dolly.visibleCheck = cableCamVisible;
    }

    if (!NodeMan.exists("footballCableCamDisplay")) {
        const ccDisp = new CNodeDisplayTrack({
            id: "footballCableCamDisplay",
            track: "footballCableCamTrack",
            color: new CNodeConstant({id: "footballCableCamColor", value: new Color(1, 0.5, 0)}),
            width: 1.5,
            trackDisplayStep: 1,
            minWallStep: 1e9,
            layers: LAYER.MASK_HELPERS,
        });
        ccDisp.visibleCheck = cableCamVisible;
    }

    if (!NodeMan.exists("footballWires")) {
        const wires = new CNodeDisplayCableCamWires({
            id: "footballWires",
            cableCam: "footballCableCamTrack",
            ballTrack: "footballTrack",
        });
        wires.visibleCheck = cableCamVisible;
    }
    applyWiresLookLayers();   // sync layer mask to the current flag state

    // ── broadcast ("center field") camera + view ────────────────
    footballSubFolder("footballCamLoc", "Broadcast Camera Position");
    if (!NodeMan.exists("footballBroadcastCamPos")) {
        const bc = pitchToWorld(GOAL_KICK_SCENARIO.broadcastCam.along,
            GOAL_KICK_SCENARIO.broadcastCam.across,
            GOAL_KICK_SCENARIO.broadcastCam.height);
        new CNodePositionLLA({
            id: "footballBroadcastCamPos",
            LLA: bc ? worldToPositionLLA(bc) : [0, 0, 100],
            desc: "Broadcast Camera",
            gui: "footballCamLoc",
            locationTools: false,   // no Lookup / Geolocate / Go To
        });
    }
    // Only consumed by footballView's preRenderFunction (side-channel, zero
    // node outputs), so without this the end-of-load recalculateAllRootFirst
    // skips it and the broadcast camera stays at the pre-restore position
    // after reloading a save (see footballPitchCenter above).
    NodeMan.get("footballBroadcastCamPos").checkDisplayOutputs = false;

    // Position source selector: Manual (the LLA fields below) by default, or
    // any imported/synthetic track. CNodeTrackSwitch self-registers in
    // Sit.dropTargets["track"], so TrackManager populates it through the same
    // registration mechanism as the Camera/Target position switches — nothing
    // here is hard-wired to the track import code.
    if (!NodeMan.exists("footballBroadcastCamSwitch")) {
        const sw = new CNodeTrackSwitch({
            id: "footballBroadcastCamSwitch",
            inputs: {"Manual Position": "footballBroadcastCamPos"},
            default: "Manual Position",
            desc: "Position",
            gui: "footballCamLoc",
        });
        sw.controller?.moveToFirst?.();
    }

    // Grey out the manual Lat/Lon/Alt/AGL when a track drives the position
    // (mirrors the Camera menu's syncCameraControlGreyout). choiceChanged
    // fires on user changes AND modDeserialize, so a reloaded save lands in
    // the right state. EventManager.removeAll() runs on sitch dispose, so
    // re-register every setup (a one-shot guard would leave a dead listener
    // after an in-session sitch switch).
    const syncBroadcastCamGreyout = () => {
        const sw = NodeMan.get("footballBroadcastCamSwitch", false);
        const bc = NodeMan.get("footballBroadcastCamPos", false);
        if (!sw || !bc) return;
        const manual = sw.choice === "Manual Position";
        const set = (c, on) => { if (c && c.enable && c.disable) { on ? c.enable() : c.disable(); } };
        set(bc.guiLat?.guiEntry, manual);
        set(bc.guiLon?.guiEntry, manual);
        set(bc.guiAlt?.guiEntry, manual);
        set(bc.aglController, manual);
    };
    if (setupFootball._broadcastGreyoutHandler) {
        EventManager.removeEventListener("Switch.choiceChanged.footballBroadcastCamSwitch",
            setupFootball._broadcastGreyoutHandler);
    }
    setupFootball._broadcastGreyoutHandler = syncBroadcastCamGreyout;
    EventManager.addEventListener("Switch.choiceChanged.footballBroadcastCamSwitch", syncBroadcastCamGreyout);
    syncBroadcastCamGreyout();
    const viewFOV = guiValue("footballViewFOV", 25, 1, 90, 0.1,
        "Broadcast FOV (°)", "Vertical field of view of the broadcast camera view", folder);
    const showView = guiFlag("footballShowView", false, "Show Broadcast View",
        "Show the view from the center-field broadcast camera, following the ball", folder);

    if (!NodeMan.exists("footballBroadcastCamera")) {
        new CNodeCamera({
            id: "footballBroadcastCamera",
            fov: 25, aspect: 16 / 9,
            near: 0.5, far: 1e6,
            // LOOKRENDER + MAIN: sees the look-view world plus the wires and
            // dolly, which are MAIN-only so they stay out of the ride-along
            // look view itself.
            layers: LAYER.MASK_LOOKRENDER | LAYER.MASK_MAIN,
        });
    }

    if (!NodeMan.exists("footballView")) {
        const fv = new CNodeView3D({
            id: "footballView",
            menuName: "Football Broadcast",
            camera: "footballBroadcastCamera",
            left: 0.53, top: 0.55, width: -16 / 9, height: 0.4,
            background: "#000000",
            // Cap the offscreen render at 720p (and pixelRatio 1) — a third
            // full-scene render at native hi-DPI resolution is the main cost
            // of having this view open.
            canvasWidth: 1280, canvasHeight: 720,
            draggable: true, resizable: true, freeAspect: true,
            visible: false,
            preRenderFunction: function () {
                const camNode = NodeMan.get("footballBroadcastCamera", false);
                // position source: the selector switch (Manual Position or a
                // track), falling back to the manual node on older graphs
                const posNode = NodeMan.get("footballBroadcastCamSwitch", false)
                    ?? NodeMan.get("footballBroadcastCamPos", false);
                const ballNode = NodeMan.get("footballTrack", false);
                if (!camNode || !posNode) return;
                const cam = camNode.camera;
                const p = posNode.p(par.frame);
                cam.position.copy(p);
                cam.up.copy(getLocalUpVector(p));
                // Aim midway between the ball and the pitch center — steadier
                // camera-1 style framing that keeps the pitch in shot instead
                // of chasing the ball itself.
                const ballPos = ballNode ? ballNode.p(par.frame) : null;
                const pitchPos = NodeMan.get("footballPitchCenter", false)?.p(0);
                const lookAt = (ballPos && pitchPos)
                    ? ballPos.clone().add(pitchPos).multiplyScalar(0.5)
                    : (ballPos ?? pitchPos);
                if (lookAt) cam.lookAt(lookAt);
                cam.fov = NodeMan.get("footballViewFOV", false)?.v(0) ?? 25;
                cam.updateProjectionMatrix();
                cam.updateMatrixWorld();
            },
        });
        // Extra views share the lookView tile set (the camera's LOOK layer
        // bit renders whatever lookView's subdivision activated) and must
        // not own a tile layer of their own — a third subdivision driver
        // causes tile churn, which cascades into ground-overlay rebuilds.
        fv.tileLayers = 0;
    }

    // Show/hide the broadcast view with its checkbox
    showView.onChange = () => {
        NodeMan.get("footballView", false)?.setVisible(!!showView.v(0));
        setRenderOne(true);
    };

    const scenarioLabel = "Load " + GOAL_KICK_SCENARIO.name;
    if (!folder.controllers.find(c => c._name === scenarioLabel)) {
        folder.add(actions, "loadScenario").name(scenarioLabel);
    }
    syncEnableButton();
}

const ENABLE_LABEL = "Enable Football Simulation";

function syncEnableButton() {
    const folder = guiMenus.football;
    const btn = folder?.controllers.find(c => c._name === ENABLE_LABEL);
    if (btn && NodeMan.exists("footballTrack")) btn.disable();
}

// Thin per-sitch setup: just the folder buttons. The simulation's nodes
// (tracks, 3D objects, GUI values, camera-switch options) are only created
// by activateFootball() — an untouched Football folder adds nothing to the
// Objects/Contents/Camera menus and costs nothing per frame. Called lazily
// by the ScenarioManager when the Scenarios menu is first opened.
export function setupFootball() {
    const folder = guiMenus.football;
    if (!folder) return;
    // Needs the custom-sitch track infrastructure
    if (!NodeMan.get("targetTrackSwitchSmooth", false)) return;

    const actions = {
        enable: () => activateFootball(),
        loadScenario: () => loadGoalKickScenario(),
    };
    const addButton = (prop, label, tip) => {
        if (!folder.controllers.find(c => c._name === label)) {
            const b = folder.add(actions, prop).name(label);
            if (tip) b.tooltip(tip);
        }
    };
    addButton("enable", ENABLE_LABEL,
        "Create the football launcher, cable cam, and broadcast camera. "
        + "Their controls appear in this folder (and the Camera menu) once enabled.");
    addButton("loadScenario", "Load " + GOAL_KICK_SCENARIO.name,
        "Enable the simulation and configure the whole scene to replicate the "
        + "2026 England-Norway goal-kick / spidercam wire incident.");
    syncEnableButton();
    folder.close();
}

// ── Scenario loader ─────────────────────────────────────────────────
// Reconfigures the sitch to replicate the incident: stadium terrain, pitch
// frame, kick parameters, spidercam motion, and the broadcast view.
export function loadGoalKickScenario() {
    const S = GOAL_KICK_SCENARIO;

    activateFootball();   // loading implies enabling

    // pitch frame first — everything else derives from it
    const pitchCenter = NodeMan.get("footballPitchCenter", false);
    const pitchHeading = NodeMan.get("footballPitchHeading", false);
    if (!pitchCenter || !pitchHeading) return;
    pitchCenter.setLLA(S.stadium.lat, S.stadium.lon, S.stadium.fieldAltitude);
    pitchHeading.setValue(S.stadium.pitchHeadingDeg);

    // Move the look camera to the broadcast gantry. gotoLLA also relocates
    // the terrain tiles and flies the main camera (which we then bring down
    // to a stadium overview).
    const gantry = pitchToWorld(S.broadcastCam.along, S.broadcastCam.across, 0);
    const camNode = NodeMan.get("fixedCameraPosition", false);
    if (camNode?.gotoLLA && gantry) {
        const lla = ECEFToLLAVD_radii(gantry);
        camNode.gotoLLA(lla.x, lla.y, S.broadcastCam.height); // AGL height
    }
    // near-overhead, looking down at the pitch through the canopy opening
    const pcWorld = pitchToWorld(0, 0, 0);
    if (pcWorld) NodeMan.get("mainCamera", false)?.goToPoint?.(pcWorld, 260, 30);

    // match date/time (for sun position / lighting)
    if (S.matchDateTime) GlobalDateTimeNode.setStartDateTime(S.matchDateTime);

    // launch point = the goal-kick spot: move the Target there and select it
    const kickPos = pitchToWorld(S.kick.along, S.kick.across, 0);
    const targetPos = NodeMan.get("fixedTargetPositionWind", false);
    if (targetPos && kickPos) {
        targetPos.setLLA(...worldToPositionLLA(kickPos));
    }
    NodeMan.get("footballStartTrack", false)?.selectOption?.("Target");

    // kick parameters. Kick heading is relative to the pitch axis.
    const setV = (id, value) => NodeMan.get(id, false)?.setValue?.(value);
    setV("footballHeading", (S.stadium.pitchHeadingDeg + S.kick.headingRelDeg) % 360);
    setV("footballElevation", S.kick.elevationDeg);
    setV("footballSpeed", S.kick.speed);
    setV("footballSpin", S.kick.spinRPM);
    setV("footballSpinTilt", S.kick.spinTiltDeg);
    setV("footballDrag", S.kick.dragCd);
    setV("footballLaunchFrame", Math.round(S.kick.launchTime * (Sit.fps ?? 30)));
    setV("footballAnchorAlong", S.anchors.along);
    setV("footballAnchorAcross", S.anchors.across);
    setV("footballAnchorHeight", S.anchors.height);

    // spidercam motion + aim (kick-relative seconds → frames at current fps)
    NodeMan.get("footballCableCamTrack", false)?.setMotion(scenarioMotionToFrames(S, S.cableCam));
    NodeMan.get("footballCableCamAim", false)?.setMotion(scenarioMotionToFrames(S, S.cableCamAim));
    setV("footballCableCamFOV", S.cableCamFOV);

    // Ride the look camera on the cable cam, aimed and zoomed like the
    // spidercam feed, so lookView reproduces the broadcast clip.
    NodeMan.get("cameraTrackSwitch", false)?.selectOption?.("Cable Cam");
    NodeMan.get("CameraLOSController", false)?.selectOption?.("Cable Cam Aim");
    NodeMan.get("fovSwitch", false)?.selectOption?.("Cable Cam");

    // The default target/camera marker boxes read as clutter in the
    // replication views — the football is the visual now. (Re-enable from
    // the Show/Hide menu if needed.)
    NodeMan.get("traverseObject", false)?.show?.(false);
    NodeMan.get("cameraObject", false)?.show?.(false);

    // broadcast camera
    const bcPos = pitchToWorld(S.broadcastCam.along, S.broadcastCam.across, S.broadcastCam.height);
    if (bcPos) {
        NodeMan.get("footballBroadcastCamPos", false)?.setLLA(...worldToPositionLLA(bcPos));
    }
    setV("footballViewFOV", S.broadcastCam.fov);

    // the pitch overlay, aligned to the (possibly just-moved) pitch frame
    updatePitchOverlay();

    // turn everything on (flags have no setValue; drive their gui entries)
    const setFlag = (id, value) => {
        const flag = NodeMan.get(id, false);
        if (flag && !!flag.v(0) !== !!value) flag.guiEntry.setValue(value);
    };
    setFlag("footballShowBall", true);
    setFlag("footballShowCableCam", true);
    setFlag("footballShowView", true);
    setFlag("footballShowPitch", true);
    NodeMan.get("footballView", false)?.setVisible(true);

    // Rolling 2-second strip chart of the ball's g-force (the IMU readout
    // FIFA cited): the wire strike shows as a sharp spike scrolling past.
    // "Show Football" just turned on above, so addGraph's source refresh
    // sees the g-force series when the dropdowns build. Fixed id, so
    // re-loading the scenario replaces the graph instead of stacking copies.
    CustomGraphManager.addGraph({
        id: "customGraphBallG",
        title: "Ball G-Force",
        y1Series: "football.gforce",
        lastSeconds: 2,
    });

    NodeMan.get("footballTrack", false)?.recalculateCascade();
    par.frame = 0;
    setRenderOne(true);
}
