// Nimitz: interactive reconstruction of the 14 Nov 2004 USS Nimitz "Tic Tac"
// encounter as VERBALLY described by CDR David Fravor and LT Alex Dietrich —
// NOT the later FLIR1 video taken by Chad Underwood. Two F/A-18Fs arrive over
// a whitewater disturbance; a white tic-tac object moves erratically just
// above it; Fravor descends in a spiral while the object appears to mirror
// him on the opposite side of the circle, rising to meet him; he cuts across
// the circle, the object accelerates across his nose and is gone in about a
// second; the Princeton then reports it at the flight's CAP point ~60 nm away.
//
// The tic-tac trajectory has selectable hypothesis modes:
//   "Object Maneuvers (as described)" — the object really does hover, jitter,
//       mirror Fravor's circle, and depart with extreme acceleration.
//   "Stationary Object (parallax)"    — the object stays near the disturbance
//       (optionally drifting with the wind); all apparent motion in the pilot
//       POV comes from the jet's own maneuvering and misjudged size/distance.
//
// Everything lives under Physics -> Scenarios -> Nimitz. "Load Nimitz
// Encounter" configures the whole scene (location, date/time, ships, camera
// POV). The look camera rides Fravor's jet by default (selectable to
// Dietrich's via the Camera menu or the View buttons), aimed at the tic-tac
// via a gated LOS controller.
//
// setupNimitz() (run lazily by the ScenarioManager when the Scenarios menu is
// opened) adds ONLY the folder buttons; the simulation itself — nodes, 3D
// objects, camera-switch options, script tabs — is created by activateNimitz()
// when the user clicks Enable or a Load button (or when a loading save was
// using Nimitz — see CScenarioManager.activateForMods; the nodes must exist
// before the save's mods apply). An un-activated Nimitz is a 100% no-op.
// All node creation is idempotent (NodeMan.exists guards) and serializes
// through the standard mods mechanism.
//
// Sources for every number (with quotes, links, and the conflicts between
// tellings): docs/Nimitz.md.

import {guiMenus, Globals, NodeMan, Sit, setRenderOne, GlobalDateTimeNode} from "./Globals";
import {par} from "./par";
import {CNodeGUIValue, CNodeGUIFlag} from "./nodes/CNodeGUIValue";
import {CNodeTrack} from "./nodes/CNodeTrack";
import {CNode3DObject} from "./nodes/CNode3DObject";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {CNodePositionLLA} from "./nodes/CNodePositionLLA";
import {CNodeControllerTrackToTrack} from "./nodes/CNodeControllerVarious";
import {CNode, CNodeConstant} from "./nodes/CNode";
import {CNodeSwitch} from "./nodes/CNodeSwitch";
import {getLocalUpVector, getLocalNorthVector, getLocalEastVector} from "./SphericalMath";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {radians, degrees, f2m, metersPerSecondFromKnots} from "./utils";
import {Color} from "three";
import * as LAYER from "./LayerMasks";
import {EventManager} from "./CEventManager";
import {propagateLayerMaskObject} from "./threeExt";

const NM = 1852;              // meters per nautical mile
const GRAV = 9.81;            // m/s^2, for the departure acceleration in g

// ── Encounter scenario ──────────────────────────────────────────────
// The November 14, 2004 event, ~90 nm SSE of San Diego. Times are seconds
// from sitch start; t=0 = the FASTEAGLE flight tallying the whitewater,
// anchored to 1430 local (PST, UTC-8) by the contemporaneous CVW-11 Event
// Summary. Every number is sourced and its conflicts documented in
// docs/Nimitz.md — values here are the "recommended defaults" from that
// document (Fravor's stable modern telling), with the compressed variant
// (Event Summary narrative / Dietrich's 8-10 s) as a second preset.
const NIMITZ_SCENARIO = {
    name: "Nimitz Encounter (Nov 14, 2004)",
    dateTime: "2004-11-14T22:30:00Z",     // 1430 PST — [ES] "SPOTTED ... AT 1430L"
    durationSec: 420,
    // [ES] merge coords N30°50.8' W117°46.9' (see docs/Nimitz.md conflict #2
    // for the TTSA cluster alternative ~43 nm away)
    disturbance: {lat: 30.8467, lon: -117.7817},
    ships: {
        nimitz: {lat: 31.4883, lon: -117.8800},    // [ES] "NIMITZ N3129.3 W11752.8"
        princeton: {lat: 31.473, lon: -118.047},   // hypothesis (no deck log exists)
    },
    capBearingDeg: 180,      // unresolved (S/E/N all attested); S per TTSA + southbound departure
    capDistanceNm: 60,       // "roughly 60 miles" (2019-2023 tellings; 40 in NYT 2017)
    fravor: {
        altFt: 20000,        // "We arrived at the location at approximately 20,000 feet"
        speedKts: 300,       // [ER] "max endurance profile at approximately 300 knots"
        radiusNm: 2.5,       // 5-min engagement at ~20-25° bank → ~5 nm circle diameter
        turnDir: "Right",    // "As we started clockwise" (every Fravor telling)
        descentStartSec: 60, // watched the jinking object ~a minute, then "easy descent"
        cutAcrossSec: 270,   // ~360° of spiral later (90° to mirror onset + 270°)
        cutAcrossAltFt: 15000, // "Our altitude at this point was about 15,000 feet"
        aggressDegSec: 6,    // turn rate while maneuvering to intercept
    },
    dietrich: {altFt: 20000, radiusNm: 2.8},  // stayed in high cover at ~20,000 ft
    ticTac: {
        sizeFt: 40,          // sworn 2023: "40-foot flying Tic Tac" (range 25-47)
        hoverAltFt: 50,      // "Hovering 50 feet above the churn" (NYT 2017)
        jitterAmpFt: 100,    // excursion scale over the patch (no source quantifies)
        meetAltFt: 12000,    // "a Tic Tac was about 12,000" when he cut across
        departTriggerNm: 0.5,   // "within about a half mile of it" at departure
        departAccelG: 500,   // hypothesis A: gone in ~1-2 s, 60 nm in 30-60 s
        departTopSpeedKts: 6000,   // 60 nm in ~40 s ≈ Mach 8 average
        capAltFt: 24000,     // [ER] CAP blip "had climbed to approximately 24,000 feet"
        driftSpeedKts: 15,   // hypothesis B: slow drift (≤30 kt, ~wind)
        driftBearingDeg: 170,   // radar-track group drifted ~south
    },
    disturbanceSizeFt: 130,  // "roiling whitewater the size of a Boeing 737"
    pilotFOV: 45,
    // Compressed variant: the Event Summary narrative shape and Dietrich's
    // 8-10 s visual — one aggressive descending turn, object gone within a
    // minute, on the 1-nm circle Fravor's TTSA telling mentions.
    compressed: {
        durationSec: 150,
        descentStartSec: 10,
        cutAcrossSec: 45,
        radiusNm: 0.5,       // "about a mile across the circle" (needs ~60°+ bank)
        aggressDegSec: 12,
    },
};

// ── preset presentation scripts (Video → Scripting tabs) ───────────
// Injected once per browser (guarded by tab name); the user can edit or
// delete them. Both assume "Load Nimitz Encounter" has been run. Script
// durations ≈ the 420 s sitch, so world time plays near-real-time.
//
// Written in the DSL (flat) form, NOT JS calls: only DSL lines carry the
// character spans that make their numbers scroll-wheel / drag editable in
// the editor and timeline (ScriptSugar records spans; JS calls have none).
// Sequencing: a bare command line is a sequential camera beat; "& text ..."
// anchors a caption to the start of the beat on the line above; "&N text"
// anchors it N seconds after that start; "wait N" is a visible camera-hold
// beat (used instead of sleep() so the hold itself is wheel-tunable).
const NIMITZ_SCRIPT_A = `# Nimitz Encounter - Hypothesis A: the object maneuvers as described.
# Run "Load Nimitz Encounter (Nov 14, 2004)" from Physics > Scenarios > Nimitz first.
# Numbers on command lines are live: hover one and scroll (or drag) to tune it.
set "Tic-Tac Hypothesis" "Object Maneuvers (as described)"
hide "Show Track Trails"
view main
zoom nimitzTicTacTrack 10 500
& text "November 14, 2004, 14:30 PST - 90 nm SSE of San Diego" 6
orbit nimitzTicTacTrack 35 200
& text "A white Tic Tac, about 40 ft long, jinks over a churning patch of ocean" 6
follow nimitzFravorTrack 25 80 25
& text "Fravor begins a descending spiral from 20,000 ft; Dietrich stays in high cover" 6
view look 1
& text "Fravor's POV: the object climbs, mirroring him on the opposite side of the circle" 8
wait 114
show "Show Track Trails"
view main 1
orbit nimitzFravorTrack 45 180 1500
hide "Show Track Trails"
view look 1
& text "At 15,000 ft he cuts across the circle toward the object" 6
wait 53
&53 text "Within about half a mile it accelerates across his nose - gone in about a second" 6
wait 20
show "Show Track Trails"
view main 1
track nimitzTicTacTrack 15
orbit nimitzFravorTrack 40 120 4000
& text "Moments later the Princeton reacquires it at the CAP point, 60 nm away, at 24,000 ft" 8
wait 30
& text "The whitewater is gone; the flight, low on fuel, returns to the Nimitz" 6
`;

const NIMITZ_SCRIPT_B = `# Nimitz Encounter - Hypothesis B: near-stationary object, parallax.
# Run "Load Nimitz Encounter (Nov 14, 2004)" from Physics > Scenarios > Nimitz first.
# Numbers on command lines are live: hover one and scroll (or drag) to tune it.
set "Tic-Tac Hypothesis" "Stationary Object (parallax)"
hide "Show Track Trails"
view main
zoom nimitzTicTacTrack 10 500
& text "Parallax hypothesis: the object never leaves the water area" 6
orbit nimitzTicTacTrack 35 200
& text "A small object drifting with the wind - its true size and distance unknown to the pilots" 6
follow nimitzFravorTrack 25 80 25
& text "Over a featureless ocean there is nothing to judge its motion against" 6
view look 1
& text "Fravor's POV: his own descending turn makes the object appear to move and climb" 8
wait 114
show "Show Track Trails"
view main 1
orbit nimitzFravorTrack 45 180 1500
hide "Show Track Trails"
view look 1
& text "From outside: the jet circles and descends - the object barely moves" 6
wait 53
&53 text "Cutting across, his sightline sweeps rapidly - reading as sudden acceleration" 6
wait 20
show "Show Track Trails"
view main 1
orbit nimitzTicTacTrack 45 180 500
& text "The object is still there; the departure was losing sight of a small object" 8
wait 30
& text "The CAP radar blip, in this hypothesis, is a separate target - not a Mach 8 transit" 6
`;

const NIMITZ_SCRIPTS = {
    "Nimitz: As Described": NIMITZ_SCRIPT_A,
    "Nimitz: Parallax": NIMITZ_SCRIPT_B,
};

function injectNimitzScripts() {
    const sv = Globals.scriptedVideo;
    if (!sv || !sv._loadTabs) return;
    sv._loadTabs();
    // The textarea is the live edit buffer for the active tab — fold any
    // unsaved edits into the tab BEFORE comparing/upgrading, and refresh the
    // buffer AFTER: parse()'s debounced _saveScript syncs the buffer back
    // over the tab, so a stale buffer would silently revert the upgrade.
    sv.syncActiveFromEditor?.();
    let changed = false;
    for (const [name, text] of Object.entries(NIMITZ_SCRIPTS)) {
        const existing = sv.tabs.find(t => t.name === name);
        if (!existing) {
            sv.tabs.push({name, text});
            changed = true;
        } else if (existing.text !== text && /^\/\/ Nimitz Encounter/.test(existing.text)) {
            // Upgrade a legacy JS-call-form preset (recognized by its old
            // "//" header) to the DSL form — JS-form numbers carry no source
            // spans, so they were not wheel/drag editable. A tab the user
            // rewrote (different header) is left alone.
            existing.text = text;
            changed = true;
        }
    }
    if (changed) {
        sv.saveTabs();
        sv.editor?._refreshTabs?.();
        // If the ACTIVE tab is one we just wrote, push the new text into the
        // live textarea and reparse, so the buffer can't clobber the upgrade.
        const cur = sv.tabs[sv.activeTab]?.text;
        if (sv.editor?.textarea && cur !== undefined && sv.editor.textarea.value !== cur) {
            sv.editor.textarea.value = cur;
            sv.doParse?.();
        }
    }
}

// ── small helpers ───────────────────────────────────────────────────

// World (ECEF, HAE) position → the [lat, lon, altMSL] triple that
// CNodePositionLLA expects (its recalculate treats altitude as MSL and adds
// the geoid offset back).
function worldToPositionLLA(worldPos) {
    const lla = ECEFToLLAVD_radii(worldPos);
    return [lla.x, lla.y, lla.z - meanSeaLevelOffset(lla.x, lla.y)];
}

// Local frame at a center node's position: unit vectors east/north/up.
function frameFromCenter(centerNode) {
    const C = centerNode.p(0);
    return {
        C,
        up: getLocalUpVector(C),
        north: getLocalNorthVector(C),
        east: getLocalEastVector(C),
    };
}

// The encounter frame, anchored at the water-disturbance position.
export function getEncounterFrame() {
    const centerNode = NodeMan.get("nimitzDisturbancePos", false);
    if (!centerNode) return null;
    return frameFromCenter(centerNode);
}

// World position from encounter-frame coords (meters east/north of the
// disturbance, altitude above sea level). Flat-frame approximation — fine
// for the few-nm scale of the close encounter; the departure run and the
// CAP point use great-circle math instead.
export function encToWorld(eastM, northM, altM, ef = null) {
    const f = ef ?? getEncounterFrame();
    if (!f) return null;
    return f.C.clone()
        .add(f.east.clone().multiplyScalar(eastM))
        .add(f.north.clone().multiplyScalar(northM))
        .add(f.up.clone().multiplyScalar(altM));
}

// Spherical destination point: from (lat, lon) along a compass bearing for
// distM meters. Good to ~0.5% over the 60 nm scales used here.
function llaDestination(latDeg, lonDeg, bearingDeg, distM) {
    const R = 6371000;
    const d = distM / R;
    const th = radians(bearingDeg);
    const la1 = radians(latDeg), lo1 = radians(lonDeg);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(th));
    const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la1),
        Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [degrees(la2), degrees(lo2)];
}

// ECEF position at (lat, lon) and altitude-above-MSL meters
function worldFromLLAMSL(latDeg, lonDeg, altMSL) {
    return LLAToECEF(latDeg, lonDeg, altMSL + meanSeaLevelOffset(latDeg, lonDeg));
}

function norm360(a) {
    return ((a % 360) + 360) % 360;
}

function smoothstep01(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}

// ── The jets ────────────────────────────────────────────────────────
// Parametric orbit around the disturbance (constant radius, compass angle
// advancing with airspeed), with an optional descending-spiral phase and a
// cut-across-the-circle intercept phase for the lead (Fravor):
//   t < descentStart          level orbit at alt
//   descentStart..cutAcross   spiral descent to cutAcrossAlt (same circle)
//   t > cutAcross             roll out and fly straight across the circle
//                             toward the object's mirrored position; a while
//                             after the object departs, turn toward the CAP.
// The wing (Dietrich, descends: false) just orbits at her own altitude.
export class CNodeNimitzJetTrack extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);
        this.useSitFrames = true;
        this.requireInputs(["center", "speed", "radius", "alt", "turnDir",
            "descentStart", "cutAcross", "cutAcrossAlt", "capBearing", "aggress"]);
        this.isNumber = false;
        this.descends = v.descends ?? true;
        this.phase0 = v.phase0 ?? 0;        // starting angle on the circle, deg from north
        this.recalculate();
    }

    recalculate() {
        this.frames = Sit.frames;
        const center = this.in.center.p(0);

        const speedKts = this.in.speed.v(0);
        const radiusNm = this.in.radius.v(0);
        const altFt = this.in.alt.v(0);
        const dir = this.in.turnDir.v(0) >= 0 ? 1 : -1;
        const tDescent = this.in.descentStart.v(0);
        const tCut = Math.max(tDescent + 5, this.in.cutAcross.v(0));
        const cutAltFt = this.in.cutAcrossAlt.v(0);
        const capBearing = this.in.capBearing.v(0);
        const aggress = this.in.aggress.v(0);

        // The sim is a pure function of these values — skip re-simulation
        // when an unrelated recalc cascade lands here.
        const fingerprint = JSON.stringify([
            speedKts, radiusNm, altFt, dir, tDescent, tCut, cutAltFt, capBearing, aggress,
            this.descends, this.phase0, center.x, center.y, center.z,
            this.frames, Sit.fps, Sit.simSpeed ?? 1,
        ]);
        if (fingerprint === this._fingerprint && this.array && this.array.length === this.frames) {
            return;
        }
        this._fingerprint = fingerprint;

        const ef = frameFromCenter(this.in.center);
        const dt = (Sit.simSpeed ?? 1) / Sit.fps;
        const spd = metersPerSecondFromKnots(speedKts);
        const R = Math.max(100, radiusNm * NM);
        const omega = spd / R;                      // rad/s around the circle
        const alt0 = f2m(altFt);
        const altCut = f2m(cutAltFt);
        // HAE of the sea surface at the center — parametric altitudes are
        // measured above this along the center's up vector.
        const geoidC = ECEFToLLAVD_radii(ef.C).z;

        this.array = [];
        let mode = "circle";
        let pos = null;
        let heading = 0;
        let targetBearing = 0;
        let turnRate = 0;         // deg/s, slewed — no bank snap at mode changes
        let maxAbsRate = degrees(omega);   // for the bank/G readout (the circle rate at minimum)

        for (let f = 0; f < this.frames; f++) {
            const t = f * dt;

            if (mode === "circle") {
                if (!this.descends || t <= tCut) {
                    const th = radians(this.phase0) + dir * omega * t;
                    let alt = alt0;
                    if (this.descends && t > tDescent) {
                        alt = alt0 + (altCut - alt0) * smoothstep01((t - tDescent) / (tCut - tDescent));
                    }
                    pos = ef.C.clone()
                        .add(ef.east.clone().multiplyScalar(R * Math.sin(th)))
                        .add(ef.north.clone().multiplyScalar(R * Math.cos(th)))
                        .add(ef.up.clone().multiplyScalar(alt));
                    // Pin to the true altitude above the sea surface: the
                    // tangent-plane construction above sits R²/2Rₑ (~1.7 m at
                    // 2.5 nm) above the curved surface, and the integration
                    // phase below pins true LLA altitude — pin here the same
                    // way or the circle→cut seam gets a one-frame vertical
                    // step (a velocity spike, visible as a bank-display kick).
                    const llaC = ECEFToLLAVD_radii(pos);
                    pos.add(getLocalUpVector(pos).multiplyScalar(geoidC + alt - llaC.z));
                    heading = norm360(degrees(th) + dir * 90);
                    this.array.push({position: pos.clone(), heading});
                    continue;
                }
                // Roll out and cut across the circle: aim through the center
                // at the object's mirrored position on the far side.
                mode = "cut";
                turnRate = dir * degrees(omega);   // carry the circle's turn rate into the roll-out
                const toCenter = ef.C.clone().sub(pos);
                targetBearing = norm360(degrees(Math.atan2(toCenter.dot(ef.east), toCenter.dot(ef.north))));
            }

            // A while after the object has departed, head for the CAP point.
            if (mode === "cut" && t > tCut + 60) mode = "toCap";

            if (mode === "cut") {
                // Pure pursuit of the object: the mirrored tic-tac is always
                // diametrically opposite through the circle center, so aiming
                // at it means continuously steering at the center. Inside the
                // jet's own turn radius further chasing is futile (it becomes
                // a limit cycle orbiting the center) — lock heading there and
                // fly straight through.
                const turnRadius = spd / radians(aggress);
                const toC = ef.C.clone().sub(pos);
                const horizDist = Math.hypot(toC.dot(ef.east), toC.dot(ef.north));
                if (horizDist > turnRadius) {
                    targetBearing = norm360(degrees(Math.atan2(toC.dot(ef.east), toC.dot(ef.north))));
                }
            }
            // Slew-limited turn: command a proportional correction toward the
            // target bearing (capped at the intercept turn rate), and ramp the
            // actual turn rate toward that command — the bank rolls in and out
            // over a couple of seconds instead of snapping at mode changes.
            const target = mode === "cut" ? targetBearing : capBearing;
            const delta = ((target - heading + 540) % 360) - 180;
            const desired = Math.max(-aggress, Math.min(aggress, delta));
            const SLEW = 3;       // deg/s of turn-rate change per second
            turnRate += Math.max(-SLEW * dt, Math.min(SLEW * dt, desired - turnRate));
            maxAbsRate = Math.max(maxAbsRate, Math.abs(turnRate));
            heading = norm360(heading + turnRate * dt);

            // Integrate forward, spherically correct: local axes at the
            // current position, altitude re-pinned each step.
            const up = getLocalUpVector(pos);
            const north = getLocalNorthVector(pos);
            const east = getLocalEastVector(pos);
            const h = radians(heading);
            const fwd = north.multiplyScalar(Math.cos(h)).add(east.multiplyScalar(Math.sin(h)));
            pos.add(fwd.multiplyScalar(spd * dt));
            const lla = ECEFToLLAVD_radii(pos);
            pos.add(up.multiplyScalar(geoidC + altCut - lla.z));

            this.array.push({position: pos.clone(), heading});
        }

        // Physical-plausibility diagnostics: the bank angle / load factor
        // implied by the turn rates at this speed (ω·v = g·tan φ, n = 1/cos φ)
        // — a real F/A-18 sustains ~7.5 g. Surfaced as a read-only GUI line.
        const bankOf = (rateDegSec) => Math.atan(radians(rateDegSec) * spd / GRAV);
        const bCircle = bankOf(degrees(omega));
        const bMax = bankOf(maxAbsRate);
        this.flightInfo = {
            speedKts,
            circleBankDeg: degrees(bCircle),
            circleG: 1 / Math.cos(bCircle),
            maxBankDeg: degrees(bMax),
            maxG: 1 / Math.cos(bMax),
        };
        if (this.id === "nimitzFravorTrack") updateJetStatus(this);
    }
}

// ── The tic-tac ─────────────────────────────────────────────────────
// mode 0 "Object Maneuvers (as described)":
//   t < descentStart      erratic ping-pong jitter just above the disturbance
//   descentStart..        blends into mirroring Fravor's position through the
//                         circle center, rising from hoverAlt to meetAlt
//   (Fravor cuts across)  keeps mirroring — so as he closes on the center it
//                         crosses his nose from the other side — until the
//                         separation drops below departTrigger, then departs:
//                         constant acceleration along the CAP bearing up to
//                         topSpeed, stopping (hovering) at the CAP point.
// mode 1 "Stationary Object (parallax)":
//   stays over the disturbance at hoverAlt, drifting slowly with the wind;
//   all apparent motion in the pilot POV is the jet's own.
export class CNodeTicTacTrack extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);
        this.useSitFrames = true;
        this.requireInputs(["center", "fravorTrack", "mode", "hoverAlt", "meetAlt",
            "jitterAmp", "descentStart", "cutAcross", "departTrigger", "departAccel",
            "departTopSpeed", "capBearing", "capDistance", "capAlt",
            "driftSpeed", "driftBearing"]);
        this.isNumber = false;
        this.departFrame = null;     // set in literal mode when it accelerates away
        this.recalculate();
    }

    recalculate() {
        this.frames = Sit.frames;
        const center = this.in.center.p(0);
        const fravor = this.in.fravorTrack;

        const mode = this.in.mode.v(0);
        const hoverAlt = f2m(this.in.hoverAlt.v(0));
        const meetAlt = f2m(this.in.meetAlt.v(0));
        const jitterAmp = f2m(this.in.jitterAmp.v(0));
        const tDescent = this.in.descentStart.v(0);
        const tCut = Math.max(tDescent + 5, this.in.cutAcross.v(0));
        const trigger = this.in.departTrigger.v(0) * NM;
        const accel = this.in.departAccel.v(0) * GRAV;
        const vmax = metersPerSecondFromKnots(this.in.departTopSpeed.v(0));
        const capBearing = this.in.capBearing.v(0);
        const capDist = this.in.capDistance.v(0) * NM;
        const capAlt = f2m(this.in.capAlt.v(0));
        const drift = metersPerSecondFromKnots(this.in.driftSpeed.v(0));
        const driftBearing = this.in.driftBearing.v(0);

        const fingerprint = JSON.stringify([
            mode, hoverAlt, meetAlt, jitterAmp, tDescent, tCut, trigger, accel,
            vmax, capBearing, capDist, capAlt, drift, driftBearing,
            center.x, center.y, center.z, fravor._fingerprint ?? fravor.frames,
            this.frames, Sit.fps, Sit.simSpeed ?? 1,
        ]);
        if (fingerprint === this._fingerprint && this.array && this.array.length === this.frames) {
            return;
        }
        this._fingerprint = fingerprint;

        const ef = frameFromCenter(this.in.center);
        const dt = (Sit.simSpeed ?? 1) / Sit.fps;
        const centerLLA = ECEFToLLAVD_radii(ef.C);

        this.array = [];
        this.departFrame = null;

        if (mode >= 1) {
            // ── parallax / near-stationary: slow wind drift, tiny bob ──
            const db = radians(driftBearing);
            for (let f = 0; f < this.frames; f++) {
                const t = f * dt;
                const e = drift * t * Math.sin(db);
                const n = drift * t * Math.cos(db);
                const alt = hoverAlt + 3 * Math.sin(1.3 * t);
                this.array.push({position: encToWorld(e, n, alt, ef)});
            }
            return;
        }

        // ── literal: jitter → mirror → depart ──
        const blendSec = 8;      // seconds to morph from jitter to mirroring
        // deterministic "ping pong ball" jitter (sums of incommensurate sines)
        const jitterE = (t) => jitterAmp * (0.5 * Math.sin(0.7 * t + 1.3) + 0.3 * Math.sin(1.9 * t + 0.4) + 0.2 * Math.sin(4.3 * t + 2.1));
        const jitterN = (t) => jitterAmp * (0.5 * Math.cos(0.9 * t) + 0.3 * Math.sin(2.7 * t + 1.0) + 0.2 * Math.sin(5.1 * t));
        const jitterAlt = (t) => hoverAlt + 3 * Math.sin(1.7 * t) + 1.5 * Math.sin(3.9 * t + 0.7);

        // The mirror point: Fravor's position reflected through the circle
        // center (horizontally), at the tic-tac's own (rising) altitude.
        const mirrorAt = (f, t) => {
            const pf = fravor.p(Math.min(f, fravor.frames - 1));
            const d = pf.sub(ef.C);
            const e = -d.dot(ef.east);
            const n = -d.dot(ef.north);
            const alt = hoverAlt + (meetAlt - hoverAlt) * smoothstep01((t - tDescent) / (tCut - tDescent));
            return {e, n, alt};
        };

        let departing = false;
        let dep = null;             // departure state
        let prevSep = Infinity;     // separation from Fravor last frame
        let hasClosed = false;      // separation has genuinely decreased

        for (let f = 0; f < this.frames; f++) {
            const t = f * dt;

            if (!departing) {
                let e, n, alt;
                if (t < tDescent) {
                    e = jitterE(t);
                    n = jitterN(t);
                    alt = jitterAlt(t);
                } else {
                    const m = mirrorAt(f, Math.min(t, tCut));
                    if (t < tDescent + blendSec) {
                        const s = smoothstep01((t - tDescent) / blendSec);
                        e = jitterE(t) * (1 - s) + m.e * s;
                        n = jitterN(t) * (1 - s) + m.n * s;
                        alt = jitterAlt(t) * (1 - s) + m.alt * s;
                    } else {
                        e = m.e;
                        n = m.n;
                        alt = m.alt;
                    }
                }
                const pos = encToWorld(e, n, alt, ef);

                // Departure trigger, after Fravor has cut across: either he
                // closes inside departTrigger, or — the described geometry —
                // the object has just crossed his nose, i.e. the separation
                // passes through its minimum (it was closing, now opening).
                // Fallback: a minute after the cut.
                if (t > tCut) {
                    const sep = pos.distanceTo(fravor.p(Math.min(f, fravor.frames - 1)));
                    if (sep < prevSep - 0.5) hasClosed = true;
                    const atMinimum = hasClosed && sep > prevSep + 0.5;
                    if (sep < trigger || atMinimum || t > tCut + 60) {
                        departing = true;
                        this.departFrame = f;
                        const lla = ECEFToLLAVD_radii(pos);
                        dep = {lat: lla.x, lon: lla.y, altMSL: alt, s: 0, v: metersPerSecondFromKnots(100)};
                    }
                    prevSep = sep;
                }
                if (!departing) {
                    this.array.push({position: pos});
                    continue;
                }
            }

            // ── departure run: accelerate along the CAP bearing, climbing to
            // the CAP-blip altitude, and stop (hover) at the CAP point ──
            dep.v = Math.min(vmax, dep.v + accel * dt);
            dep.s = Math.min(dep.s + dep.v * dt, capDist);
            const [lat2, lon2] = llaDestination(dep.lat, dep.lon, capBearing, dep.s);
            const alt2 = dep.altMSL + (capAlt - dep.altMSL) * (dep.s / capDist);
            this.array.push({position: worldFromLLAMSL(lat2, lon2, alt2)});
        }
    }
}

// ── CAP point (derived from bearing/distance off the disturbance) ───
export class CNodeCapPosition extends CNode {
    constructor(v) {
        super(v);
        this.requireInputs(["center", "bearing", "distance"]);
        this.frames = 0;
        this.recalculate();
    }

    recalculate() {
        const lla = ECEFToLLAVD_radii(this.in.center.p(0));
        const [lat2, lon2] = llaDestination(lla.x, lla.y, this.in.bearing.v(0), this.in.distance.v(0) * NM);
        this._pos = worldFromLLAMSL(lat2, lon2, 0);
    }

    p() {
        return this._pos.clone();
    }

    getValueFrame() {
        return {position: this._pos.clone()};
    }
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

// Non-permanent subfolder of the Nimitz menu, registered in guiMenus so
// nodes can reference it by key. Recreated on every sitch load.
function nimitzSubFolder(key, title) {
    const parent = guiMenus.nimitz;
    let f = guiMenus[key];
    if (!f || !parent.folders.includes(f)) {
        f = parent.addFolder(title).close();
        guiMenus[key] = f;
    }
    return f;
}

function constant(id, value) {
    if (NodeMan.exists(id)) return NodeMan.get(id);
    return new CNodeConstant({id, value});
}

const showAll = () => !!NodeMan.get("nimitzShow", false)?.v(0);

// Read-only "Turn Bank / G" line in the Fravor folder — the bank angle and
// load factor implied by the circle geometry (and the peak intercept turn)
// at the current speed, so parameter combinations beyond a real F/A-18
// (~7.5 g sustained) are immediately visible. Updated from the track's
// recalculate (football's status-line pattern).
const nimitzJetStatus = {text: "—"};
let jetStatusController = null;

function updateJetStatus(track) {
    const fi = track.flightInfo;
    if (!fi) return;
    const fmt = (b, g) => `${b.toFixed(0)}° / ${g.toFixed(2)}g`;
    nimitzJetStatus.text = `circle ${fmt(fi.circleBankDeg, fi.circleG)}, peak ${fmt(fi.maxBankDeg, fi.maxG)}`;
    jetStatusController?.updateDisplay();
}

// Resize the tic-tac and disturbance in place when their sliders change:
// CNode3DObject rebuilds its geometry from geometryParams, so no node is
// ever recreated (recreation double-adds the auto-created child nodes —
// _color_colorInput, _size, _ControllerTrackPosition — under the same ids).
function applyNimitzSizes() {
    const ticTac = NodeMan.get("nimitzTicTacModel", false);
    if (ticTac) {
        const sizeM = f2m(NodeMan.get("nimitzTicTacSize", false)?.v(0) ?? 40);
        ticTac.geometryParams.radius = sizeM / 4.5;   // candy ≈ 2.25:1 length:diameter
        ticTac.geometryParams.totalLength = sizeM;
        ticTac.rebuild();
    }
    const disc = NodeMan.get("nimitzDisturbanceModel", false);
    if (disc) {
        const distM = f2m(NodeMan.get("nimitzDisturbanceSize", false)?.v(0) ?? 120);
        disc.geometryParams.radiusTop = distM / 2;
        disc.geometryParams.radiusBottom = distM / 2;
        disc.rebuild();
    }
    setRenderOne(true);
}

function createNimitzObjects() {
    // the tic-tac itself: a smooth white capsule, ~3:1 length:diameter
    if (!NodeMan.exists("nimitzTicTacModel")) {
        const sizeM = f2m(NodeMan.get("nimitzTicTacSize", false)?.v(0) ?? 40);
        const ticTac = new CNode3DObject({
            id: "nimitzTicTacModel",
            geometry: "capsule",
            radius: sizeM / 4.5,   // candy ≈ 2.25:1 length:diameter
            totalLength: sizeM,
            color: "#ffffff",
            material: "phong",
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        ticTac.addController("TrackPosition", {sourceTrack: "nimitzTicTacTrack"});
        ticTac.visibleCheck = showAll;
    }

    // the whitewater disturbance: a flat pale disc at the sea surface
    if (!NodeMan.exists("nimitzDisturbanceModel")) {
        const distM = f2m(NodeMan.get("nimitzDisturbanceSize", false)?.v(0) ?? 120);
        const disc = new CNode3DObject({
            id: "nimitzDisturbanceModel",
            geometry: "cylinder",
            radiusTop: distM / 2,
            radiusBottom: distM / 2,
            height: 1,
            color: "#dceefb",
            material: "phong",
            opacity: 0.85,
            transparent: true,
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        disc.addController("TrackPosition", {sourceTrack: "nimitzDisturbancePos"});
        // In the literal hypothesis the whitewater vanished shortly after the
        // object left; in the parallax hypothesis it is decoupled (persists).
        disc.visibleCheck = () => {
            if (!showAll()) return false;
            const track = NodeMan.get("nimitzTicTacTrack", false);
            if (!track || track.departFrame === null) return true;
            return par.frame < track.departFrame + 30 * (Sit.fps ?? 30);
        };
    }
}

// Activation: create the whole simulation — tracks, 3D objects, GUI values,
// camera-switch options, listeners, script tabs. Idempotent (NodeMan.exists
// guards), so re-running on sitch reload or repeated Enable clicks is safe.
export function activateNimitz() {
    const folder = guiMenus.nimitz;
    if (!folder) return;

    // Needs the custom-sitch camera infrastructure
    const camTrackSwitch = NodeMan.get("cameraTrackSwitch", false);
    if (!camTrackSwitch) return;

    const S = NIMITZ_SCENARIO;

    // ── top-level controls ──────────────────────────────────────
    const show = guiFlag("nimitzShow", false, "Show Nimitz Encounter",
        "Show the jets, tic-tac, ships, and disturbance of the Nov 14, 2004 encounter", folder);
    show.onChange = () => setRenderOne(true);

    // Hypothesis selector: what the tic-tac actually does
    constant("nimitzHypoLiteral", 0);
    constant("nimitzHypoParallax", 1);
    if (!NodeMan.exists("nimitzHypothesis")) {
        new CNodeSwitch({
            id: "nimitzHypothesis",
            inputs: {
                "Object Maneuvers (as described)": "nimitzHypoLiteral",
                "Stationary Object (parallax)": "nimitzHypoParallax",
            },
            default: "Object Maneuvers (as described)",
            desc: "Tic-Tac Hypothesis",
        }, folder);
    }

    // ── Fravor's jet ────────────────────────────────────────────
    const fravorFolder = nimitzSubFolder("nimitzFravor", "Fravor's Jet");
    guiValue("nimitzFravorAlt", S.fravor.altFt, 1000, 30000, 100,
        "Start Altitude (ft)", "Altitude of the FASTEAGLE flight when they arrive overhead", fravorFolder);
    guiValue("nimitzJetSpeed", S.fravor.speedKts, 150, 500, 5,
        "Jet Speed (kn)", "Airspeed of both F/A-18Fs throughout", fravorFolder);
    guiValue("nimitzCircleRadius", S.fravor.radiusNm, 0.3, 5, 0.05,
        "Circle Radius (nm)", "Radius of Fravor's descending spiral around the disturbance", fravorFolder);
    constant("nimitzTurnLeftC", -1);
    constant("nimitzTurnRightC", 1);
    if (!NodeMan.exists("nimitzTurnDir")) {
        new CNodeSwitch({
            id: "nimitzTurnDir",
            inputs: {
                "Left (counterclockwise)": "nimitzTurnLeftC",
                "Right (clockwise)": "nimitzTurnRightC",
            },
            default: S.fravor.turnDir === "Left" ? "Left (counterclockwise)" : "Right (clockwise)",
            desc: "Turn Direction",
        }, fravorFolder);
    }
    guiValue("nimitzDescentStart", S.fravor.descentStartSec, 0, 300, 1,
        "Descent Start (s)", "Seconds after arrival when Fravor starts his descending spiral", fravorFolder);
    guiValue("nimitzCutAcross", S.fravor.cutAcrossSec, 10, 600, 1,
        "Cut Across (s)", "Seconds after arrival when Fravor cuts across the circle toward the object", fravorFolder);
    guiValue("nimitzCutAcrossAlt", S.fravor.cutAcrossAltFt, 500, 25000, 100,
        "Cut Across Altitude (ft)", "Altitude at which Fravor abandons the spiral and cuts across", fravorFolder);
    guiValue("nimitzAggressiveness", S.fravor.aggressDegSec, 1, 15, 0.5,
        "Intercept Turn Rate (°/s)", "How hard Fravor turns when rolling out to cut across", fravorFolder);
    // read-only implied bank/G — folder contents are destroyed on sitch
    // change, so look the controller up by name rather than caching blindly
    jetStatusController = fravorFolder.controllers.find(c => c._name === "Turn Bank / G");
    if (!jetStatusController) {
        jetStatusController = fravorFolder.add(nimitzJetStatus, "text").name("Turn Bank / G")
            .tooltip("Bank angle and load factor implied by the circle radius (and the peak "
                + "intercept turn rate) at the current jet speed. A real F/A-18 sustains up to ~7.5 g.");
        jetStatusController.disable();
    }

    // ── Dietrich's jet ──────────────────────────────────────────
    const dietrichFolder = nimitzSubFolder("nimitzDietrich", "Dietrich's Jet");
    guiValue("nimitzDietrichAlt", S.dietrich.altFt, 1000, 30000, 100,
        "Altitude (ft)", "Dietrich stayed high as cover while Fravor descended", dietrichFolder);
    guiValue("nimitzDietrichRadius", S.dietrich.radiusNm, 0.3, 5, 0.05,
        "Circle Radius (nm)", "Radius of Dietrich's holding orbit", dietrichFolder);

    // ── the tic-tac ─────────────────────────────────────────────
    const ticTacFolder = nimitzSubFolder("nimitzTicTac", "Tic-Tac");
    const size = guiValue("nimitzTicTacSize", S.ticTac.sizeFt, 10, 100, 1,
        "Tic-Tac Length (ft)", "\"About the size of my airplane\" — 40-ish feet", ticTacFolder);
    guiValue("nimitzHoverAlt", S.ticTac.hoverAltFt, 0, 5000, 10,
        "Hover Altitude (ft)", "Height above the water while moving erratically over the disturbance", ticTacFolder);
    guiValue("nimitzJitterAmp", S.ticTac.jitterAmpFt, 0, 2000, 10,
        "Erratic Motion Size (ft)", "Amplitude of the ping-pong-ball jitter over the disturbance", ticTacFolder);
    guiValue("nimitzMeetAlt", S.ticTac.meetAltFt, 500, 25000, 100,
        "Mirror Rise Altitude (ft)", "Altitude the object rises to while mirroring Fravor's descent", ticTacFolder);
    guiValue("nimitzDepartTrigger", S.ticTac.departTriggerNm, 0.05, 3, 0.05,
        "Departure Range (nm)", "Separation from Fravor at which the object accelerates away", ticTacFolder);
    guiValue("nimitzDepartAccel", S.ticTac.departAccelG, 1, 5000, 1,
        "Departure Accel (g)", "Acceleration of the departure toward the CAP point (hypothesis A)", ticTacFolder);
    guiValue("nimitzDepartTopSpeed", S.ticTac.departTopSpeedKts, 100, 60000, 100,
        "Departure Top Speed (kn)", "Peak speed of the departure run", ticTacFolder);
    guiValue("nimitzCapAlt", S.ticTac.capAltFt, 500, 60000, 100,
        "CAP Arrival Altitude (ft)", "The reacquired radar blip at the CAP was at ~24,000 ft", ticTacFolder);
    guiValue("nimitzDriftSpeed", S.ticTac.driftSpeedKts, 0, 60, 1,
        "Drift Speed (kn)", "Parallax hypothesis: slow wind drift of the near-stationary object", ticTacFolder);
    guiValue("nimitzDriftBearing", S.ticTac.driftBearingDeg, 0, 360, 1,
        "Drift Bearing (°)", "Parallax hypothesis: direction of the slow drift", ticTacFolder);
    const distSize = guiValue("nimitzDisturbanceSize", S.disturbanceSizeFt, 20, 500, 5,
        "Disturbance Size (ft)", "Diameter of the whitewater patch — \"about the size of a 737\"", ticTacFolder);
    size.onChange = applyNimitzSizes;
    distSize.onChange = applyNimitzSizes;

    // ── locations ───────────────────────────────────────────────
    nimitzSubFolder("nimitzLocations", "Locations");
    if (!NodeMan.exists("nimitzDisturbancePos")) {
        new CNodePositionLLA({
            id: "nimitzDisturbancePos",
            LLA: [S.disturbance.lat, S.disturbance.lon, 0],
            desc: "Disturbance",
            gui: "nimitzLocations",
            locationTools: false,
        });
    }
    if (!NodeMan.exists("nimitzShipNimitzPos")) {
        new CNodePositionLLA({
            id: "nimitzShipNimitzPos",
            LLA: [S.ships.nimitz.lat, S.ships.nimitz.lon, 0],
            desc: "USS Nimitz",
            gui: "nimitzLocations",
            locationTools: false,
        });
    }
    if (!NodeMan.exists("nimitzShipPrincetonPos")) {
        new CNodePositionLLA({
            id: "nimitzShipPrincetonPos",
            LLA: [S.ships.princeton.lat, S.ships.princeton.lon, 0],
            desc: "USS Princeton",
            gui: "nimitzLocations",
            locationTools: false,
        });
    }
    const locFolder = guiMenus.nimitzLocations;
    guiValue("nimitzCapBearing", S.capBearingDeg, 0, 360, 1,
        "CAP Bearing (°)", "Compass bearing from the encounter to the flight's CAP point", locFolder);
    guiValue("nimitzCapDistance", S.capDistanceNm, 10, 150, 1,
        "CAP Distance (nm)", "\"It's at your CAP\" — about 60 miles away", locFolder);
    if (!NodeMan.exists("nimitzCapPos")) {
        new CNodeCapPosition({
            id: "nimitzCapPos",
            center: "nimitzDisturbancePos",
            bearing: "nimitzCapBearing",
            distance: "nimitzCapDistance",
        });
    }

    // ── tracks ──────────────────────────────────────────────────
    if (!NodeMan.exists("nimitzFravorTrack")) {
        new CNodeNimitzJetTrack({
            id: "nimitzFravorTrack",
            center: "nimitzDisturbancePos",
            speed: "nimitzJetSpeed",
            radius: "nimitzCircleRadius",
            alt: "nimitzFravorAlt",
            turnDir: "nimitzTurnDir",
            descentStart: "nimitzDescentStart",
            cutAcross: "nimitzCutAcross",
            cutAcrossAlt: "nimitzCutAcrossAlt",
            capBearing: "nimitzCapBearing",
            aggress: "nimitzAggressiveness",
            descends: true,
            phase0: 0,
        });
    }
    if (!NodeMan.exists("nimitzDietrichTrack")) {
        new CNodeNimitzJetTrack({
            id: "nimitzDietrichTrack",
            center: "nimitzDisturbancePos",
            speed: "nimitzJetSpeed",
            radius: "nimitzDietrichRadius",
            alt: "nimitzDietrichAlt",
            turnDir: "nimitzTurnDir",
            descentStart: "nimitzDescentStart",
            cutAcross: "nimitzCutAcross",
            cutAcrossAlt: "nimitzCutAcrossAlt",
            capBearing: "nimitzCapBearing",
            aggress: "nimitzAggressiveness",
            descends: false,
            phase0: 180,
        });
    }
    if (!NodeMan.exists("nimitzTicTacTrack")) {
        new CNodeTicTacTrack({
            id: "nimitzTicTacTrack",
            center: "nimitzDisturbancePos",
            fravorTrack: "nimitzFravorTrack",
            mode: "nimitzHypothesis",
            hoverAlt: "nimitzHoverAlt",
            meetAlt: "nimitzMeetAlt",
            jitterAmp: "nimitzJitterAmp",
            descentStart: "nimitzDescentStart",
            cutAcross: "nimitzCutAcross",
            departTrigger: "nimitzDepartTrigger",
            departAccel: "nimitzDepartAccel",
            departTopSpeed: "nimitzDepartTopSpeed",
            capBearing: "nimitzCapBearing",
            capDistance: "nimitzCapDistance",
            capAlt: "nimitzCapAlt",
            driftSpeed: "nimitzDriftSpeed",
            driftBearing: "nimitzDriftBearing",
        });
    }

    // ── 3D objects ──────────────────────────────────────────────
    if (!NodeMan.exists("nimitzFravorModel")) {
        const jet = new CNode3DObject({
            id: "nimitzFravorModel",
            model: "F/A-18F",
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        jet.addController("TrackPosition", {sourceTrack: "nimitzFravorTrack"});
        jet.addController("ObjectTilt", {track: "nimitzFravorTrack", tiltType: "banking", noMenu: true});
        jet.visibleCheck = showAll;
    }
    if (!NodeMan.exists("nimitzDietrichModel")) {
        const jet = new CNode3DObject({
            id: "nimitzDietrichModel",
            model: "F/A-18F",
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        jet.addController("TrackPosition", {sourceTrack: "nimitzDietrichTrack"});
        jet.addController("ObjectTilt", {track: "nimitzDietrichTrack", tiltType: "banking", noMenu: true});
        jet.visibleCheck = showAll;
    }
    // tic-tac + disturbance disc (sizes applied in place on slider changes)
    createNimitzObjects();

    // ships: LCS placeholders scaled to length (no carrier/cruiser models yet)
    if (!NodeMan.exists("nimitzShipNimitzModel")) {
        const ship = new CNode3DObject({
            id: "nimitzShipNimitzModel",
            model: "LCS",
            modelLength: 333,     // CVN-68 length
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        ship.addController("TrackPosition", {sourceTrack: "nimitzShipNimitzPos"});
        ship.visibleCheck = showAll;
    }
    if (!NodeMan.exists("nimitzShipPrincetonModel")) {
        const ship = new CNode3DObject({
            id: "nimitzShipPrincetonModel",
            model: "LCS",
            modelLength: 173,     // CG-59 length
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        ship.addController("TrackPosition", {sourceTrack: "nimitzShipPrincetonPos"});
        ship.visibleCheck = showAll;
    }
    // CAP point beacon: a tall translucent column, visible from the wide view
    if (!NodeMan.exists("nimitzCapMarker")) {
        const marker = new CNode3DObject({
            id: "nimitzCapMarker",
            geometry: "cylinder",
            radiusTop: 100,
            radiusBottom: 100,
            height: 4000,
            color: "#00ffff",
            material: "basic",
            opacity: 0.25,
            transparent: true,
            layers: LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK,
        });
        marker.addController("TrackPosition", {sourceTrack: "nimitzCapPos", forceAboveSurface: false});
        marker.visibleCheck = showAll;
    }

    // ── track displays ──────────────────────────────────────────
    const trails = guiFlag("nimitzShowTrails", true, "Show Track Trails",
        "Draw the flight paths of the jets and the tic-tac", folder);
    const trailsVisible = () => showAll() && !!trails.v(0);
    const addTrail = (id, track, color, width) => {
        if (NodeMan.exists(id)) return;
        const disp = new CNodeDisplayTrack({
            id,
            track,
            color: new CNodeConstant({id: id + "Color", value: color}),
            width,
            trackDisplayStep: 1,
            minWallStep: 1e9,
            layers: LAYER.MASK_HELPERS | LAYER.MASK_LOOK,
        });
        disp.visibleCheck = trailsVisible;
    };
    addTrail("nimitzFravorTrackDisplay", "nimitzFravorTrack", new Color(0.25, 1, 0.5), 1.5);
    addTrail("nimitzDietrichTrackDisplay", "nimitzDietrichTrack", new Color(0.25, 0.5, 1), 1.5);
    addTrail("nimitzTicTacTrackDisplay", "nimitzTicTacTrack", new Color(1, 1, 1), 2);

    // ── camera: POV sources for the look camera ─────────────────
    if (camTrackSwitch.inputs["Fravor's Jet"] === undefined) {
        camTrackSwitch.addOption("Fravor's Jet", NodeMan.get("nimitzFravorTrack"));
    }
    if (camTrackSwitch.inputs["Dietrich's Jet"] === undefined) {
        camTrackSwitch.addOption("Dietrich's Jet", NodeMan.get("nimitzDietrichTrack"));
    }
    const losSwitch = NodeMan.get("CameraLOSController", false);
    const lookCamera = NodeMan.get("lookCamera", false);
    if (losSwitch && lookCamera && losSwitch.inputs["Look At Tic-Tac"] === undefined) {
        const aimController = new CNodeControllerTrackToTrack({
            id: "nimitzLookAtTicTac",
            sourceTrack: "cameraTrackSwitchSmooth",
            targetTrack: "nimitzTicTacTrack",
        });
        lookCamera.addControllerNode(aimController);
        losSwitch.addOption("Look At Tic-Tac", aimController);
    }
    // The look camera sits at the ridden jet's own position — that jet must
    // not render in the look view (the camera would be inside its fuselage).
    // Keep the OTHER jet visible so each pilot can see their wingman.
    const applyPovLayers = () => {
        const choice = NodeMan.get("cameraTrackSwitch", false)?.choice;
        const setL = (id, ridden) => {
            const n = NodeMan.get(id, false);
            if (!n?.group) return;
            const mask = ridden
                ? (LAYER.MASK_WORLD | LAYER.MASK_MAIN)
                : (LAYER.MASK_WORLD | LAYER.MASK_MAIN | LAYER.MASK_LOOK);
            // update the node's stored mask too — the async model load
            // reapplies this.layers over the group when the GLB arrives
            n.layers = mask;
            n.group.layers.mask = mask;
            propagateLayerMaskObject(n.group);
        };
        setL("nimitzFravorModel", choice === "Fravor's Jet");
        setL("nimitzDietrichModel", choice === "Dietrich's Jet");
        setRenderOne(true);
    };
    // EventManager.removeAll() runs on sitch dispose, so re-register every
    // setup with an explicit remove of the stored previous handler.
    if (setupNimitz._povLayersHandler) {
        EventManager.removeEventListener("Switch.choiceChanged.cameraTrackSwitch",
            setupNimitz._povLayersHandler);
    }
    setupNimitz._povLayersHandler = applyPovLayers;
    EventManager.addEventListener("Switch.choiceChanged.cameraTrackSwitch", applyPovLayers);
    applyPovLayers();

    const pilotFOV = guiValue("nimitzPilotFOV", S.pilotFOV, 10, 120, 0.5,
        "Pilot View FOV (°)", "Vertical FOV of the pilot POV look view", folder);
    const fovSwitch = NodeMan.get("fovSwitch", false);
    if (fovSwitch && fovSwitch.inputs["Nimitz Pilot"] === undefined) {
        fovSwitch.addOption("Nimitz Pilot", pilotFOV);
    }

    // ── action buttons ──────────────────────────────────────────
    const povJet = (option) => {
        NodeMan.get("cameraTrackSwitch", false)?.selectOption?.(option);
        NodeMan.get("CameraLOSController", false)?.selectOption?.("Look At Tic-Tac");
        NodeMan.get("fovSwitch", false)?.selectOption?.("Nimitz Pilot");
        setRenderOne(true);
    };
    const actions = {
        povFravor: () => povJet("Fravor's Jet"),
        povDietrich: () => povJet("Dietrich's Jet"),
        overhead: () => {
            const c = NodeMan.get("nimitzDisturbancePos", false)?.p(0);
            if (c) NodeMan.get("mainCamera", false)?.goToPoint?.(c, 15000, 6000);
            setRenderOne(true);
        },
    };
    const addButton = (prop, label) => {
        if (!folder.controllers.find(c => c._name === label)) {
            folder.add(actions, prop).name(label);
        }
    };
    addButton("povFravor", "View: Fravor POV");
    addButton("povDietrich", "View: Dietrich POV");
    addButton("overhead", "View: Overhead");

    // preset presentation scripts under Video → Scripting
    injectNimitzScripts();

    syncEnableButton();
}

const ENABLE_LABEL = "Enable Nimitz Simulation";

function syncEnableButton() {
    const folder = guiMenus.nimitz;
    const btn = folder?.controllers.find(c => c._name === ENABLE_LABEL);
    if (btn && NodeMan.exists("nimitzFravorTrack")) btn.disable();
}

// Thin per-sitch setup: just the folder buttons. The simulation's nodes
// (tracks, 3D objects, GUI values, camera-switch options, script tabs) are
// only created on activation — an untouched Nimitz folder adds nothing to
// the Objects/Contents/Camera menus and costs nothing per frame.
export function setupNimitz() {
    const folder = guiMenus.nimitz;
    if (!folder) return;
    if (!NodeMan.get("cameraTrackSwitch", false)) return;

    const actions = {
        enable: () => activateNimitz(),
        loadScenario: () => loadNimitzScenario(),
        loadCompressed: () => loadNimitzScenario("compressed"),
    };
    const addButton = (prop, label) => {
        if (!folder.controllers.find(c => c._name === label)) {
            folder.add(actions, prop).name(label);
        }
    };
    addButton("enable", ENABLE_LABEL);
    addButton("loadScenario", "Load " + NIMITZ_SCENARIO.name);
    addButton("loadCompressed", "Load Compressed Variant (~1 min)");

    // Save-compat (a save made with Nimitz in use must activate BEFORE its
    // mods apply, or they are dropped) is handled centrally by
    // CScenarioManager.activateForMods from deserializeMods().
    syncEnableButton();
    folder.close();
}

// ── Scenario loader ─────────────────────────────────────────────────
// Reconfigures the sitch to the Nov 14, 2004 encounter: location, date/time,
// ships, jet and tic-tac parameters, and the Fravor-POV look camera.
export function loadNimitzScenario(variant) {
    const S = NIMITZ_SCENARIO;
    const C = variant === "compressed" ? S.compressed : null;

    activateNimitz();   // loading implies enabling
    const disturbance = NodeMan.get("nimitzDisturbancePos", false);
    if (!disturbance) return;

    // duration first — the tracks are rebuilt to Sit.frames
    Sit.frames = Math.round((C?.durationSec ?? S.durationSec) * (Sit.fps ?? 30));
    GlobalDateTimeNode.changedFrames();

    // date/time (sun position / lighting for ~noon PST)
    GlobalDateTimeNode.setStartDateTime(S.dateTime);

    // locations
    disturbance.setLLA(S.disturbance.lat, S.disturbance.lon, 0);
    NodeMan.get("nimitzShipNimitzPos", false)?.setLLA(S.ships.nimitz.lat, S.ships.nimitz.lon, 0);
    NodeMan.get("nimitzShipPrincetonPos", false)?.setLLA(S.ships.princeton.lat, S.ships.princeton.lon, 0);

    // Relocate the terrain tiles to the encounter (gotoLLA also flies the
    // main camera, which we then bring to a scene overview).
    const camNode = NodeMan.get("fixedCameraPosition", false);
    if (camNode?.gotoLLA) camNode.gotoLLA(S.disturbance.lat, S.disturbance.lon, 3000);

    // parameters
    const setV = (id, value) => NodeMan.get(id, false)?.setValue?.(value);
    setV("nimitzFravorAlt", S.fravor.altFt);
    setV("nimitzJetSpeed", S.fravor.speedKts);
    setV("nimitzCircleRadius", C?.radiusNm ?? S.fravor.radiusNm);
    setV("nimitzDescentStart", C?.descentStartSec ?? S.fravor.descentStartSec);
    setV("nimitzCutAcross", C?.cutAcrossSec ?? S.fravor.cutAcrossSec);
    setV("nimitzCutAcrossAlt", S.fravor.cutAcrossAltFt);
    setV("nimitzAggressiveness", C?.aggressDegSec ?? S.fravor.aggressDegSec);
    setV("nimitzDietrichAlt", S.dietrich.altFt);
    setV("nimitzDietrichRadius", S.dietrich.radiusNm);
    setV("nimitzTicTacSize", S.ticTac.sizeFt);
    setV("nimitzHoverAlt", S.ticTac.hoverAltFt);
    setV("nimitzJitterAmp", S.ticTac.jitterAmpFt);
    setV("nimitzMeetAlt", S.ticTac.meetAltFt);
    setV("nimitzDepartTrigger", S.ticTac.departTriggerNm);
    setV("nimitzDepartAccel", S.ticTac.departAccelG);
    setV("nimitzDepartTopSpeed", S.ticTac.departTopSpeedKts);
    setV("nimitzCapAlt", S.ticTac.capAltFt);
    setV("nimitzDriftSpeed", S.ticTac.driftSpeedKts);
    setV("nimitzDriftBearing", S.ticTac.driftBearingDeg);
    setV("nimitzDisturbanceSize", S.disturbanceSizeFt);
    setV("nimitzCapBearing", S.capBearingDeg);
    setV("nimitzCapDistance", S.capDistanceNm);
    setV("nimitzPilotFOV", S.pilotFOV);
    NodeMan.get("nimitzTurnDir", false)?.selectOption?.(
        S.fravor.turnDir === "Left" ? "Left (counterclockwise)" : "Right (clockwise)");
    NodeMan.get("nimitzHypothesis", false)?.selectOption?.("Object Maneuvers (as described)");

    // show everything (flags have no setValue; drive their gui entries)
    const setFlag = (id, value) => {
        const flag = NodeMan.get(id, false);
        if (flag && !!flag.v(0) !== !!value) flag.guiEntry.setValue(value);
    };
    setFlag("nimitzShow", true);
    setFlag("nimitzShowTrails", true);

    // look camera: Fravor's POV, aimed at the tic-tac
    NodeMan.get("cameraTrackSwitch", false)?.selectOption?.("Fravor's Jet");
    NodeMan.get("CameraLOSController", false)?.selectOption?.("Look At Tic-Tac");
    NodeMan.get("fovSwitch", false)?.selectOption?.("Nimitz Pilot");

    // The default target/camera marker boxes, the camera-to-target LOS fan,
    // and the camera-track altitude/distance labels (which sit AT the look
    // camera and render as giant letters in the POV) read as clutter here
    NodeMan.get("traverseObject", false)?.show?.(false);
    NodeMan.get("cameraObject", false)?.show?.(false);
    NodeMan.get("displayLOS", false)?.show?.(false);
    NodeMan.get("altitudeLabel", false)?.show?.(false);
    NodeMan.get("distanceLabel", false)?.show?.(false);
    // default camera/traverse trails duplicate the Nimitz ones in other colors
    NodeMan.get("cameraDisplayTrack", false)?.show?.(false);
    NodeMan.get("traverseDisplayTrack", false)?.show?.(false);

    // main camera: overview of the encounter
    const c = disturbance.p(0);
    NodeMan.get("mainCamera", false)?.goToPoint?.(c, 15000, 6000);

    NodeMan.get("nimitzFravorTrack", false)?.recalculateCascade();
    NodeMan.get("nimitzDietrichTrack", false)?.recalculateCascade();
    par.frame = 0;
    setRenderOne(true);
}
