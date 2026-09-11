/**
 * GimbalCustomSetup.js — enables the full Gimbal analysis pipeline for custom sitches.
 *
 * When a sitch definition includes a `gimbalSetup` property, this module replicates
 * everything that SitGimbal's setup() does (CSV data processing, az/el/bank/glare
 * switches, jet track, winds, SA page, fleet objects, traverse nodes, graphs, air
 * track) but does it imperatively on top of the base custom sitch rather than as
 * part of a dedicated sitch class.  The original SitGimbal is NOT touched — it
 * keeps its own setup() path.
 *
 * Two ways in:
 *   A) One-click preset — `Physics > Gimbal Analysis Preset > Create Gimbal Sitch`
 *      serialises a sitch with `gimbalSetup` (no `pipeline` field), reloads, and
 *      `handleGimbalSetup` runs every step.  Same behaviour as built-in Gimbal.
 *   B) Manual build — the `Create Gimbal Base (manual build)` button produces a
 *      sitch with `gimbalSetup.pipeline = {}` (an empty allowlist, so nothing
 *      auto-runs).  The user then clicks individual step buttons in the
 *      `Manual Build` sub-folder; each button live-runs its step AND flips its
 *      flag in `Sit.gimbalSetup.pipeline`, so saving + reloading reproduces the
 *      exact partial pipeline.  See `CustomSupport._setupManualBuildFolder`.
 *
 * Because the manual-build path can leave the scene in intermediate states,
 * several downstream modules were hardened to tolerate missing nodes:
 *   - `JetStuff.CommonJetStuff` — defers if `LOSTraverseSelect` absent; idempotent.
 *   - `JetStuff.initJetStuff.preRenderFunction` — bails if `SAPage`/winds/jetTrack
 *     or `LOSTraverseSelect` are not yet created.
 *   - `JetGraphs.AddSpeedGraph` — skips the fleet sub-graph unless `fleeter01` exists.
 *   - `CNodeATFLIRUI.renderCanvas` — skips the bank overlay until `bank` exists.
 *   - `CNodeGUIValue.recalculate` — skips linked `setValue()` if the target node
 *     was swapped to a kind without `setValue` (e.g. when core replaces the
 *     GUIValue `turnRate` with a `CNodeSwitch`, leaving `totalTurn` linked at it).
 *
 * Usage in a custom sitch definition:
 *   gimbalSetup: {
 *       showGlare: true,
 *       cloudWindFrom: 240, cloudWindKnots: 17,
 *       targetWindFrom: 274, targetWindKnots: 65,
 *       localWindFrom: 270, localWindKnots: 120,
 *       defaultTraverse: "Const Air Spd",
 *       // fleet parameters (optional)
 *       fleetTurnStart: 0, fleetTurnRate: 8, fleetAcceleration: 2,
 *       fleetSpacing: 0.7, fleetX: 20, fleetY: -5.27,
 *       // Per-step allowlist (optional — absence = "run everything")
 *       pipeline: {core: true, traverse: true, airTrack: true, ...},
 *   }
 */

import {Color} from "three";
import {FileManager, gui, guiJetTweaks, guiTweaks, NodeMan, Sit} from "./Globals";
import {arrayColumn, ExpandKeyframes, scaleF2M} from "./utils";
import {RollingAverage} from "./smoothing";
import {par} from "./par";
import {SetupJetGUI} from "./JetGUI";
import {
    CommonJetStuff,
    curveChanged,
    SetupCommon,
    SetupTrackLOSNodes,
    SetupTraverseNodes,
} from "./JetStuff";
import {SetupGimbal} from "./sitch/SitGimbal";
import {setupOpts} from "./JetChart";
import {SetupCloudNodes} from "./Clouds";
import {CNodeTrackAir} from "./nodes/CNodeTrackAir";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {CNodeFleeter} from "./nodes/CNodeFleeter";
import {CNodeMunge, CNodeGForce} from "./nodes/CNodeMunge";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {CNodeGraphSeries} from "./nodes/CNodeGraphSeries";
import {CNodeTraverseAngularSpeed} from "./nodes/CNodeTraverseAngularSpeed";
import {CNodeScale} from "./nodes/CNodeScale";
import {CNodeDisplayTargetSphere} from "./nodes/CNodeDisplayTargetSphere";
import {CNode3DObject, ModelFiles} from "./nodes/CNode3DObject";
import {AddGenericNodeGraph} from "./JetGraphs";
import {ViewMan} from "./CViewManager";
import * as LAYER from "./LayerMasks";

/**
 * Node IDs that the gimbal pipeline creates imperatively.
 * If any of these already exist (e.g. from the base custom sitch template),
 * they must be removed before the gimbal pipeline runs so we don't get
 * "adding <id> twice" asserts.
 */
const GIMBAL_PIPELINE_NODE_IDS = [
    // SetupGimbal
    "azMarkus", "azEditor", "azSources",
    "jetTAS", "elStart", "elRise", "el",
    "bank", "recordedAngle", "userBankAngle",
    "glareAngle", "Unsmoothed", "movingAverage", "markusSmoothed",
    "MickKeyframe", "markusKeyframe",
    "unsmoothedArray", "movingAverageArray", "markusSmoothedArray", "markusKeyFrameArray",
    "recordedCueAz", "recordedCueAzArray",
    "turnRateBS", "watchTAS",
    "cloudSpeedEditor",
    "cloudWind", "targetWind", "localWind",
    "initialHeading",
    "turnRateFromClouds", "turnRate", "totalTurn",
    "userTurnRateFine", "userTurnRateLarge",
    "jetTrack", "SAPage",
    "JetLOS", "gimbalTriangulate",
    // SetupCommon
    "cloudAltitude", "cloudAltitudeGUI",
    // SetupTraverseNodes / CreateTraverseNodes
    "startDistance", "speedScaled",
    "LOSTraverseConstantDistance", "LOSTraverseUseRange",
    "LOSTraverseConstantSpeed", "LOSTraverseConstantAirSpeed",
    "LOSTraverseStraightLine", "LOSTraverseStraightConstantAir",
    "LOSTraverseConstantAltitude",
    "LOSTraverseSelect",
    "targetRelativeHeading", "targetActualHeading",
    // handleGimbalSetup extras
    "airTrack",
    "AirTrackDisplay",
    "sizeScaled", "targetModel", "targetSphere",
    // SetupTrackLOSNodes
    "JetLOSDisplayNode", "jetTrackDisplayNode",
    "jetTrackColor", "jetTrackColor2",
    "LOSTraverseDisplayNode",
    // SetupCloudNodes
    "cloudData", "cloudDisplay", "cloudMaterial",
    "LOSHorizonTrack", "LOSHorizonDisplay",
    // Fleet
    "fleetTurnStart", "fleetTurnRate", "fleetAcceleration",
    "fleetSpacing", "fleetX", "fleetY",
    "fleeter01", "fleeter02", "fleeter03", "fleeter04", "fleeter05",
    "tf01", "tf02", "tf03", "tf04", "tf05",
    "fleeter01Display", "fleeter02Display", "fleeter03Display",
    "fleeter04Display", "fleeter05Display",
];


/**
 * Load and pre-process the three Gimbal CSV data files into `Sit`.
 *
 * - `GimbalCSV`      — raw glare angle samples; column 1 is the glare angle
 *                      we later smooth and feed into the glare switch.
 * - `GimbalCSV2`     — sparse keyframes for recorded az/el/bank; expanded
 *                      to one sample per video frame.
 * - `GimbalCSV_Pip`  — (optional) PIP/recorded-cue keyframes, expanded and
 *                      rolling-averaged for display overlays.
 *
 * These exact files are re-hosted by the Gimbal preset into the generated
 * sitch's `files` block, so they are guaranteed to be in `FileManager`
 * by the time this runs.  Extracted from `SitGimbal.setup()`; unchanged
 * aside from being callable from the custom-sitch path.
 */
export function processGimbalCSVData() {
    Sit.CSV = FileManager.get("GimbalCSV");

    Sit.CSV2 = FileManager.get("GimbalCSV2");
    Sit.CSV2 = ExpandKeyframes(Sit.CSV2, Sit.frames);

    if (FileManager.exists("GimbalCSV_Pip")) {
        Sit.CSV_Pip = FileManager.get("GimbalCSV_Pip");
        Sit.CSV_Pip = ExpandKeyframes(Sit.CSV_Pip, Sit.frames, 0, 7);
        Sit.CSV_Pip = RollingAverage(Sit.CSV_Pip, 10);
    }

    Sit.glareAngleOriginal = arrayColumn(Sit.CSV, 1);
    Sit.glareAngleSmooth = RollingAverage(Sit.glareAngleOriginal, 6);
}


/**
 * Create the five fleet aircraft ("fleeters") plus the GUI sliders that
 * control their formation geometry (turn start, turn rate, acceleration,
 * spacing, X/Y offsets).
 *
 * Each fleeter is offset from the target track (`LOSTraverseSelect`) by a
 * hand-tuned `[turnFrameOffset, offX, offY, offZ]` tuple.  The `turnFrame`
 * input staggers when each wingman initiates its turn relative to the
 * fleet's start frame, producing the classic 5-ship wedge that fans out
 * during the Gimbal manoeuvre.
 *
 * Display tracks (`fleeterNNDisplay`) render each aircraft's path with a
 * small auto-sphere so they show up on the main view and SA page.
 *
 * @param {object} config — gimbalSetup configuration (reads fleet* fields)
 */
function setupFleet(config) {
    new CNodeGUIValue({id: "fleetTurnStart", value: config.fleetTurnStart ?? 0, start: 0, end: 35, step: 0.1, desc: "Fleet Turn Start"}, guiTweaks);
    new CNodeGUIValue({id: "fleetTurnRate", value: config.fleetTurnRate ?? 8, start: 0, end: 50, step: 0.1, desc: "Fleet Turn Rate"}, guiTweaks);
    new CNodeGUIValue({id: "fleetAcceleration", value: config.fleetAcceleration ?? 2, start: 1, end: 50, step: 0.1, desc: "Fleet Acceleration"}, guiTweaks);
    new CNodeGUIValue({id: "fleetSpacing", value: config.fleetSpacing ?? 0.7, start: 0.01, end: 4, step: 0.01, desc: "Fleet Spacing"}, guiTweaks);
    new CNodeGUIValue({id: "fleetX", value: config.fleetX ?? 20, start: -10, end: 20, step: 0.01, desc: "Fleet X"}, guiTweaks);
    new CNodeGUIValue({id: "fleetY", value: config.fleetY ?? -5.27, start: -10, end: 10, step: 0.01, desc: "Fleet Y"}, guiTweaks);

    const fleetDefaults = {
        gimbal: "LOSTraverseSelect",
        turnRate: "fleetTurnRate",
        acc: "fleetAcceleration",
        spacing: "fleetSpacing",
        fleetX: "fleetX",
        fleetY: "fleetY",
    };

    const offsets = [
        {id: "01", off: [2.1, -2, 0, -1]},
        {id: "02", off: [1.2, -1, 0, -2]},
        {id: "03", off: [-1.2, 0, 0, -3]},
        {id: "04", off: [-2.1, 1, 0, -2]},
        {id: "05", off: [0, 2, 0, -1]},
    ];

    offsets.forEach(({id, off}) => {
        new CNodeFleeter({
            id: "fleeter" + id,
            ...fleetDefaults,
            turnFrame: new CNodeMunge({
                id: "tf" + id,
                inputs: {t: "fleetTurnStart"},
                frames: 0,
                munge: function (f) { return 30 * (this.in.t.v(0) + off[0]); }
            }),
            offX: off[1], offY: off[2], offZ: off[3],
        });
    });

    const fleetDisplayDefaults = {width: 1, autoSphere: 100, color: 0xc0c000};
    offsets.forEach(({id}) => {
        new CNodeDisplayTrack({
            ...fleetDisplayDefaults,
            id: "fleeter" + id + "Display",
            track: "fleeter" + id,
        });
    });
}


/**
 * Register Hostile/Friendly HAFU symbols on the SA page for the target
 * track and the five fleeters.  Must run AFTER the SA page view exists
 * AND after the fleet nodes exist — which is why it's split out from
 * `gimbalStepFleet` into its own `gimbalStepSAHAFU` step for the
 * manual-build path, where the user may enable the SA page after the
 * fleet has already been created.
 *
 * The trailing integer on each `addHAFU` call is the symbol's heading
 * offset in degrees (tweaks tail direction so wingmen don't all point
 * the same way).
 */
function setupSAPageHAFU() {
    const SA = ViewMan.get("SAPage");
    SA.addHAFU(NodeMan.get("LOSTraverseSelect"), "Hostile", "Hostile", 0);
    SA.addHAFU(NodeMan.get("fleeter01"), "Friendly", "Friendly", 10);
    SA.addHAFU(NodeMan.get("fleeter02"), "Friendly", "Friendly", 10);
    SA.addHAFU(NodeMan.get("fleeter03"), "Friendly", "Friendly", 20);
    SA.addHAFU(NodeMan.get("fleeter04"), "Friendly", "Friendly", 15);
    SA.addHAFU(NodeMan.get("fleeter05"), "Friendly", "Friendly", 5);
}


/**
 * Install the three analysis graphs layered on top of the base gimbal view:
 *
 * 1. Cloud-speed editor overlay — adds "Cloud Speed" (green, derived from
 *    the horizon track's transverse angular speed through `cloudWind`) and
 *    "Sim Turn Rate" (blue, from `turnRate`) as compare series on
 *    `cloudSpeedEditor`.  Lets the user match simulated turn rate to
 *    observed cloud drift.
 * 2. Az editor overlay — adds three compare series to `azEditor`:
 *    Markus Az (smoothed reference), Selected Az (whichever source the
 *    az switch is currently routed to), and Delta Az (per-frame
 *    derivative ×10, clamped ±10) for spotting glitches.
 * 3. Acceleration graph — standalone window showing the target's g-force
 *    (total, lateral, vertical) along `LOSTraverseSelect`, with purple
 *    bands at the frames where the recorded object visibly swings.
 *
 * All three read from nodes created by `gimbalStepCore` and
 * `gimbalStepTraverse`, so this step must run after both.
 */
function setupGimbalGraphs() {
    // Cloud speed graph overlay
    NodeMan.get("cloudSpeedEditor").editorView.addInput("compare",
        new CNodeGraphSeries({
            inputs: {
                source: new CNodeTraverseAngularSpeed({
                    id: "transverseAngularSpeed",
                    inputs: {
                        track: "jetTrack",
                        traverse: "LOSHorizonTrack",
                        wind: "cloudWind",
                    },
                })
            },
            name: "Cloud Speed",
            color: "green",
        })
    );

    NodeMan.get("cloudSpeedEditor").editorView.addInput("compare1",
        new CNodeGraphSeries({
            id: "SimTurnRate",
            inputs: {source: "turnRate"},
            name: "Sim Turn Rate",
            color: "#8080F0",
            min: -2.5, max: -1,
        })
    );
    NodeMan.get("cloudSpeedEditor").editorView.recalculate();

    // Az editor graph overlay
    const azEditorNode = NodeMan.get("azEditor");
    azEditorNode.editorView.addInput("compare",
        new CNodeGraphSeries({
            id: "azGraphSources",
            inputs: {
                source: new CNodeMunge({
                    id: "azSourcesMarkus",
                    inputs: {az: "azMarkus"},
                    munge: function (f) { return this.in.az.getValueFrame(f); }
                })
            },
            name: "Markus Az",
            color: "#008000",
        })
    );
    azEditorNode.editorView.addInput("compare1",
        new CNodeGraphSeries({
            id: "azSources1",
            inputs: {source: "azSources"},
            name: "Selected Az",
            color: "#8080F0",
        })
    );
    azEditorNode.editorView.addInput("compare2",
        new CNodeGraphSeries({
            id: "azSources2",
            inputs: {
                source: new CNodeMunge({
                    id: "azSourcesMunge",
                    inputs: {az: "azSources"},
                    munge: function (f) {
                        if (f === 0) f = 1;
                        return (this.in.az.v(f) - this.in.az.getValue(f - 1)) * 10;
                    }
                })
            },
            name: "Delta Az",
            color: "#0080FF",
            lines: [{y: 0, color: "#0000FF"}],
            min: -10, max: 10,
        })
    );
    azEditorNode.editorView.recalculate();

    // Acceleration graph
    AddGenericNodeGraph("Acceleration", "Object g-force", [
        ["black", 1, new CNodeGForce("LOSTraverseSelect", [1, 1, 1])],
        ["green", 1, new CNodeGForce("LOSTraverseSelect", [1, 0, 1])],
        ["red", 1, new CNodeGForce("LOSTraverseSelect", [0, 1, 0])],
    ], {
        left: 0.0, top: 0.0, width: 0.5 * 9 / 16, height: 0.5,
    }, [
        {x: 716, x2: 725, color: "#FF00ff40"},
        {x: 813, x2: 828, color: "#ff00ff40"},
        {x: 861, x2: 943, color: "#ff00ff40"},
        {x: 978, x2: 984, color: "#ff00ff40"},
    ]);
}


/**
 * Create the 3D target — an FA-18F model plus a solid sphere fallback —
 * positioned along `LOSTraverseSelect` and oriented via an `ObjectTilt`
 * controller that banks the model into its apparent air-relative motion
 * (`airTrack` + `targetWind`).
 *
 * `sizeScaled` wraps the user-facing "Target size ft" GUIValue through
 * `scaleF2M` so feet-valued slider input becomes metres-valued scale.
 * `Sit.targetSize` defaults to 56 ft to match the built-in Gimbal Far
 * sitch's implicit size (set there via `setup2`).
 *
 * The `targetSphere` renders on the `MASK_TARGET` layer so it's visible
 * in the main view but hidden from ATFLIR-pod view layers.  Requires
 * `LOSTraverseSelect`, `airTrack`, and `targetWind` — i.e. core +
 * traverse + airTrack must have run.
 */
function setupTargetModel() {
    ModelFiles["TargetObjectFile"] = {file: "TargetObjectFile"};

    const targetModel = new CNode3DObject({
        id: "targetModel",
        model: "TargetObjectFile",
        size: new CNodeScale("sizeScaled", scaleF2M,
            new CNodeGUIValue({
                value: Sit.targetSize ?? 56,
                start: 0,
                end: 2000,
                step: 0.1,
                desc: "Target size ft"
            }, gui)
        ),
    });

    targetModel.addController("TrackPosition", {
        sourceTrack: "LOSTraverseSelect",
    });

    targetModel.addController("ObjectTilt", {
        track: "LOSTraverseSelect",
        tiltType: "none",
        wind: "targetWind",
        airTrack: "airTrack",
    });

    new CNodeDisplayTargetSphere({
        id: "targetSphere",
        inputs: {
            track: "LOSTraverseSelect",
            size: "sizeScaled",
        },
        layers: LAYER.MASK_TARGET,
    });
}


/**
 * Copy the user-tunable knobs from `config` into the global `Sit` object
 * where `SetupGimbal()` and related routines read them.  SetupGimbal was
 * originally written to read straight from `Sit`, so rather than refactor
 * it we stage the config here.
 *
 * Fall-through chain is `config → current Sit → hard-coded default` so that:
 *   - Calling with a partial config preserves previously-applied values
 *     (important for the manual-build path, where the user may edit a
 *     single wind knob and re-run core).
 *   - Calling on a fresh sitch still lands on the Gimbal default scene.
 *
 * Boolean flags (`showATFLIR`, `showGimbalDragMesh`, `showGimbalCharts`)
 * use `!== false` so a missing key defaults to true, but an explicit
 * `false` in either `config` or a prior `Sit` value sticks.
 */
export function applyGimbalConfigToSit(config = {}) {
    Sit.showGlare = config.showGlare ?? Sit.showGlare ?? false;
    Sit.cloudWindFrom = config.cloudWindFrom ?? Sit.cloudWindFrom ?? 240;
    Sit.cloudWindKnots = config.cloudWindKnots ?? Sit.cloudWindKnots ?? 17;
    Sit.targetWindFrom = config.targetWindFrom ?? Sit.targetWindFrom ?? 274;
    Sit.targetWindKnots = config.targetWindKnots ?? Sit.targetWindKnots ?? 65;
    Sit.localWindFrom = config.localWindFrom ?? Sit.localWindFrom ?? 270;
    Sit.localWindKnots = config.localWindKnots ?? Sit.localWindKnots ?? 120;
    Sit.startDistance = config.startDistance ?? Sit.startDistance ?? 32;
    Sit.targetSpeed = config.targetSpeed ?? Sit.targetSpeed ?? 340;
    Sit.showATFLIR = config.showATFLIR !== false && (Sit.showATFLIR !== false);
    Sit.showGimbalDragMesh = config.showGimbalDragMesh !== false && (Sit.showGimbalDragMesh !== false);
    Sit.showGimbalCharts = config.showGimbalCharts !== false && (Sit.showGimbalCharts !== false);
}

/**
 * Dispose + remove the listed nodes from `NodeMan` so a pipeline step can
 * be re-run without tripping "adding <id> twice" asserts.
 *
 * Needed in two scenarios:
 *   1. Base custom sitch already defines some of these IDs (e.g. the base
 *      template declares `targetWind`, `localWind`, `turnRate`,
 *      `totalTurn`, `jetTrack`) as plain GUIValues / tracks.  The gimbal
 *      pipeline wants to replace them with CSV-driven switches or
 *      computed tracks, so we clear first.
 *   2. The manual-build UI lets the user click the same step twice (e.g.
 *      after tweaking a knob).  Clearing makes each step idempotent.
 *
 * `NodeMan.unlinkDisposeRemove` unhooks the node from its consumers
 * before freeing GPU/DOM resources.
 */
export function clearGimbalPipelineNodes(ids = GIMBAL_PIPELINE_NODE_IDS) {
    for (const id of ids) {
        if (NodeMan.exists(id)) {
            NodeMan.unlinkDisposeRemove(id);
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// Individual pipeline steps.
//
// Each `gimbalStep*` function is a self-contained unit that:
//   - clears the nodes it's about to create (safe re-run)
//   - creates its nodes / wires its state
//   - can be invoked from both `handleGimbalSetup` (one-shot preset) and
//     the manual-build GUI (see CustomSupport._setupManualBuildFolder).
//
// The steps are ordered by dependency; later steps assume earlier ones
// have run (core → traverse → airTrack → fleet / trackLOS / clouds /
// graphs / targetModel / airTrackDisplay / commonViews).  Prerequisite
// checks live in `CustomSupport._setupManualBuildFolder`'s `need(...)`
// helper so each button pops an error instead of throwing when a
// dependency is missing.
// ──────────────────────────────────────────────────────────────────────

/**
 * Core step — az/el/bank/glare switches, winds, jetTrack, SAPage, JetLOS.
 *
 * This is the largest step.  It:
 *   1. Stages `config` into `Sit` so downstream routines pick it up.
 *   2. Processes the three Gimbal CSVs into `Sit.CSV*` arrays.
 *   3. Calls `setupOpts()` to seed `par` (the mutable global toggles) and
 *      flips `par.deroFromGlare` / `par.showGlareGraph` to the
 *      gimbal-specific defaults.
 *   4. Builds the jet GUI (`SetupJetGUI`) — only in GUI mode.
 *   5. `SetupCommon()` adds the cloud-altitude GUI slider.
 *   6. `SetupGimbal()` does the bulk of the work: creates the az/el/bank
 *      keyframe-driven tracks, the glare switch, the three wind nodes
 *      (cloud/target/local), the turn-rate math, `jetTrack` (animated
 *      jet position derived from wind + heading + turn-rate), `SAPage`,
 *      `JetLOS` (line-of-sight from jet to target), and
 *      `gimbalTriangulate`.
 *
 * Required inputs: `jetOrigin` + `jetAltitude` from the base custom sitch.
 *
 * After this step a number of base-sitch GUIValues have been replaced
 * by different node kinds (e.g. `turnRate` becomes a `CNodeSwitch`).
 * That's why `CNodeGUIValue.recalculate` had to be hardened to skip
 * `setValue()` on non-GUIValue targets.
 */
export function gimbalStepCore(config = {}) {
    applyGimbalConfigToSit(config);
    clearGimbalPipelineNodes([
        "azMarkus", "azEditor", "azSources",
        "jetTAS", "elStart", "elRise", "el",
        "bank", "recordedAngle", "userBankAngle",
        "glareAngle", "Unsmoothed", "movingAverage", "markusSmoothed",
        "MickKeyframe", "markusKeyframe",
        "unsmoothedArray", "movingAverageArray", "markusSmoothedArray", "markusKeyFrameArray",
        "recordedCueAz", "recordedCueAzArray",
        "turnRateBS", "watchTAS",
        "cloudSpeedEditor",
        "cloudWind", "targetWind", "localWind",
        "initialHeading",
        "turnRateFromClouds", "turnRate",
        "userTurnRateFine", "userTurnRateLarge",
        "jetTrack", "SAPage",
        "JetLOS", "gimbalTriangulate",
        "cloudAltitude", "cloudAltitudeGUI",
    ]);
    processGimbalCSVData();
    setupOpts();
    par.deroFromGlare = true;
    par.showGlareGraph = true;
    if (gui) SetupJetGUI();
    SetupCommon();
    SetupGimbal();
}

/**
 * Traverse step — hypothetical target-path interpretations.
 *
 * Creates the five candidate traversals of the jet-relative line-of-sight:
 *   Straight Line, Const Ground Spd, Const Air Spd, Const Air AB,
 *   Constant Altitude.
 * They're wrapped in a `LOSTraverseSelect` switch so the user can flip
 * between them with a dropdown; everything downstream (target model,
 * air track, display tracks, graphs) consumes `LOSTraverseSelect`.
 *
 * Also produces `startDistance`, `speedScaled`, and the
 * `targetRelativeHeading` / `targetActualHeading` helpers used by the
 * air track and target tilt logic.
 *
 * @param {string} defaultTraverse — initially selected traversal name.
 */
export function gimbalStepTraverse(defaultTraverse = "Const Air Spd") {
    clearGimbalPipelineNodes([
        "startDistance", "speedScaled",
        "LOSTraverseConstantDistance", "LOSTraverseUseRange",
        "LOSTraverseConstantSpeed", "LOSTraverseConstantAirSpeed",
        "LOSTraverseStraightLine", "LOSTraverseStraightConstantAir",
        "LOSTraverseConstantAltitude",
        "LOSTraverseSelect",
        "targetRelativeHeading", "targetActualHeading",
    ]);
    SetupTraverseNodes("LOSTraverseSelect", {
        "Straight Line": "LOSTraverseStraightLine",
        "Const Ground Spd": "LOSTraverseConstantSpeed",
        "Const Air Spd": "LOSTraverseConstantAirSpeed",
        "Const Air AB": "LOSTraverseStraightConstantAir",
        "Constant Altitude": "LOSTraverseConstantAltitude",
    }, defaultTraverse);
}

/**
 * Jet-view step — speed / altitude / tail-angle charts, target-distance
 * and size-percentage graphs, initViews() (creates `chart` view, dragMesh,
 * ATFLIR display pod, LocalFrame layer mask), HUD, chart updates.
 *
 * This is what the legacy preset path runs automatically on load via
 * `Sit.jetStuff: true` in `index.js` (which calls `CommonJetStuff`
 * directly).  It is exposed here as its own manual-build step for two
 * reasons:
 *   1. The manual-build sitch sets `jetStuff: true` in its base config
 *      but at sitch-load time `LOSTraverseSelect` doesn't exist yet, so
 *      `CommonJetStuff` bails early (guard in JetStuff.js).  The user
 *      needs an explicit way to invoke it once traverse is present.
 *   2. It must run AFTER fleet when the fleet speed sub-graph is wanted
 *      (`AddSpeedGraph` only adds the fleet series when `fleeter01`
 *      exists — guard in JetGraphs.js).
 *
 * Idempotent: re-running is a no-op (CommonJetStuff checks `chart`).
 */
export function gimbalStepCommonViews() {
    CommonJetStuff();
}

/**
 * Air track step — create `airTrack`, the target's motion relative to the
 * target-altitude wind (`targetWind`).  Where `LOSTraverseSelect` is the
 * ground-frame traversal, `airTrack` subtracts the local air mass so
 * downstream consumers (target tilt, Air Track Display, target air-speed
 * graph) see the target's through-the-air motion.
 *
 * Requires `LOSTraverseSelect` (traverse step) and `targetWind` (core).
 */
export function gimbalStepAirTrack() {
    clearGimbalPipelineNodes(["airTrack"]);
    new CNodeTrackAir({
        id: "airTrack",
        source: "LOSTraverseSelect",
        wind: "targetWind",
    });
}

/**
 * Fleet step — five-ship wingman formation plus their GUI knobs and
 * display tracks.  See `setupFleet()` for formation details.
 *
 * If the SA page is already up when this runs, the HAFU symbols for
 * target + fleet are added in the same call.  If the SA page is added
 * LATER (manual-build users can toggle it from Show/Hide > Views at any
 * time), the user must click the separate "Fleet HAFUs on SA Page"
 * button (`gimbalStepSAHAFU`).
 *
 * Requires `LOSTraverseSelect` (traverse step).
 */
export function gimbalStepFleet(config = {}) {
    clearGimbalPipelineNodes([
        "fleetTurnStart", "fleetTurnRate", "fleetAcceleration",
        "fleetSpacing", "fleetX", "fleetY",
        "fleeter01", "fleeter02", "fleeter03", "fleeter04", "fleeter05",
        "tf01", "tf02", "tf03", "tf04", "tf05",
        "fleeter01Display", "fleeter02Display", "fleeter03Display",
        "fleeter04Display", "fleeter05Display",
    ]);
    setupFleet(config);
    if (ViewMan.get("SAPage", false)) {
        setupSAPageHAFU();
    }
}

/**
 * SA HAFU step — add target + fleet HAFU symbols to the SA page.
 *
 * Separate from `gimbalStepFleet` because in the manual-build flow the
 * SA page is a `Show/Hide > Views` toggle that may be turned on AFTER
 * the fleet has been created.  When that happens, the fleet step won't
 * have run `setupSAPageHAFU` (it skips when the view is absent), so
 * the user clicks this button to catch the SA page up.
 *
 * The prereq check in `CustomSupport._setupManualBuildFolder` makes
 * sure the SA page + fleet + traverse nodes all exist before letting
 * the user press the button.
 */
export function gimbalStepSAHAFU() {
    setupSAPageHAFU();
}

/**
 * Track-LOS display step — visual overlays for the jet's line-of-sight
 * and the jet's own track, rendered into the main 3D view.
 *
 * Delegates to `JetStuff.SetupTrackLOSNodes`, which creates:
 *   - `JetLOSDisplayNode`, `jetTrackDisplayNode` (the visible lines)
 *   - `jetTrackColor`, `jetTrackColor2` (colour sources)
 *   - `LOSTraverseDisplayNode` (highlights the selected traversal)
 *
 * Requires `jetTrack` + `JetLOS` (core) and `LOSTraverseSelect` (traverse).
 */
export function gimbalStepTrackLOSNodes() {
    clearGimbalPipelineNodes([
        "JetLOSDisplayNode", "jetTrackDisplayNode",
        "jetTrackColor", "jetTrackColor2",
        "LOSTraverseDisplayNode",
    ]);
    SetupTrackLOSNodes();
}

/**
 * Clouds step — cloud geometry layer + horizon LOS track.
 *
 * Delegates to `Clouds.SetupCloudNodes`, which creates the cloud mesh
 * (`cloudData`, `cloudDisplay`, `cloudMaterial`) drifting with
 * `cloudWind`, plus `LOSHorizonTrack` / `LOSHorizonDisplay` — the
 * intersection of the jet-to-target LOS with the cloud altitude used
 * by the cloud-speed analysis graph.
 *
 * Requires `jetTrack` + `cloudAltitude` (core).
 */
export function gimbalStepClouds() {
    clearGimbalPipelineNodes([
        "cloudData", "cloudDisplay", "cloudMaterial",
        "LOSHorizonTrack", "LOSHorizonDisplay",
    ]);
    SetupCloudNodes();
}

/**
 * Graphs step — add the three gimbal analysis graphs.  See
 * `setupGimbalGraphs` for details.  Thin wrapper so the manual-build UI
 * has a single entry point per step.  Requires core + traverse (and
 * ideally clouds, for the cloud-speed overlay to be meaningful).
 */
export function gimbalStepGraphs() {
    setupGimbalGraphs();
}

/**
 * Target model step — create the FA-18F model + target sphere along the
 * selected traversal.  See `setupTargetModel` for details.  Requires
 * traverse + airTrack + `targetWind` (core).
 */
export function gimbalStepTargetModel() {
    clearGimbalPipelineNodes(["sizeScaled", "targetModel", "targetSphere"]);
    setupTargetModel();
}

/**
 * Air-track display step — cyan polyline of the target's through-the-air
 * path, toggled by SA-page button 16 (the "wind" button).
 *
 * The visibility callback guards `ViewMan.get("SAPage", false)` so the
 * display node doesn't crash when the SA page is disabled (previous
 * version called `.buttonBoxed` on `null`).  The display stays in
 * `NodeMan` either way; it simply renders nothing when the SA page is
 * hidden.
 *
 * Requires `airTrack` (air-track step).
 */
export function gimbalStepAirTrackDisplay() {
    clearGimbalPipelineNodes(["AirTrackDisplay"]);
    new CNodeDisplayTrack({
        id: "AirTrackDisplay",
        track: "airTrack",
        color: [0, 0.5, 1],
        width: 1,
        visibleCheck: (() => {
            const sa = ViewMan.get("SAPage", false);
            return sa ? sa.buttonBoxed(16) : false;
        }),
    });
}

/**
 * Main entry point — invoked from the sitch load path (index.js) once
 * `Sit.gimbalSetup` has been detected.  Drives the pipeline:
 *
 *   - `config.pipeline` absent (legacy / Path A one-click preset) →
 *     every step runs, reproducing the built-in Gimbal scene.
 *   - `config.pipeline` is an object (Path B manual build) → it acts as
 *     a per-step allowlist; only steps with a truthy flag run.  The
 *     manual-build buttons flip these flags as the user clicks them,
 *     so `serialize()` + reload replays the exact partial pipeline.
 *
 * The `want("fleet") && ...` line keeps backwards compatibility with the
 * old `config.fleet: false` / `config.fleetTurnStart` opt-in semantics
 * when no explicit pipeline is provided.
 *
 * In console mode (`!gui`), stops after airTrack — the remaining steps
 * all produce UI or depend on GUI state.
 *
 * @param {object} config — the `gimbalSetup` object from the sitch.
 */
export function handleGimbalSetup(config) {
    console.log(">>> handleGimbalSetup: setting up Gimbal analysis pipeline for custom sitch");

    const defaultTraverse = config.defaultTraverse ?? "Const Air Spd";
    const p = config.pipeline;
    const want = (key) => !p || p[key];

    // Remove everything we're about to recreate (base template overlap).
    clearGimbalPipelineNodes();

    if (want("core")) gimbalStepCore(config);
    if (want("traverse")) gimbalStepTraverse(defaultTraverse);
    if (want("airTrack")) gimbalStepAirTrack();

    if (!gui) return; // console mode: skip UI-only setup

    const fleetDefaultOn = config.fleetTurnStart !== undefined || config.fleet !== false;
    if (want("fleet") && (p ? p.fleet : fleetDefaultOn)) {
        gimbalStepFleet(config);
    }
    if (want("trackLOS")) gimbalStepTrackLOSNodes();
    if (want("clouds")) gimbalStepClouds();
    if (want("graphs")) gimbalStepGraphs();
    if (want("targetModel")) gimbalStepTargetModel();
    if (want("airTrackDisplay")) gimbalStepAirTrackDisplay();
}
