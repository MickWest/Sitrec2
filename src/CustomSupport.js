/**
 * Module: custom sitch and mod support.
 *
 * Responsibilities:
 * - Serialize/deserialize custom sitches and mod state.
 * - Coordinate save/share flows with FileManager and rehosting.
 * - Generate share links and keep URL state in sync with saved content.
 * - Provide advanced UI helpers, including GUI mirroring utilities.
 */
// Support functions for the custom sitches and mods
// 
// GUI Mirroring Functionality:
// - mirrorGUIFolder(sourceFolderName, menuTitle, x, y): Mirror any GUI menu to a standalone draggable window with dynamic updates
// - mirrorNodeGUI(nodeId, menuTitle, x, y): Mirror a specific node's GUI with dynamic updates
// - createDynamicMirror(sourceType, sourceName, title, x, y): Universal function to create dynamic mirrors
// - setupFlowOrbsMirrorExample(): Example that mirrors Flow Orbs menu (or effects menu as fallback)
// - showMirrorMenuDemo(): Interactive demo accessible from Help menu
//
// Dynamic Mirroring Features:
// - Automatically detects when original menu items are added/removed/changed
// - Uses event-based detection when possible, falls back to polling
// - Handles model/geometry switching and other programmatic GUI changes
// - Provides manual refresh capability via refreshMirror() method
// - Proper cleanup when mirrors are destroyed

import {
    addGUIFolder,
    FileManager,
    getEffectiveUserID,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiShowHideViews,
    infoDiv,
    NodeFactory,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    setSitchEstablished,
    Sit,
    Synth3DManager,
    TrackManager,
    UndoManager,
    Units,
    withTestUser
} from "./Globals";
import {isKeyHeld, toggler} from "./KeyBoardHandler";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {par} from "./par";
import {GlobalScene} from "./LocalFrame";
import {refreshLabelsAfterLoading} from "./nodes/CNodeLabels3D";
import {assert} from "./assert";
import {getShortURL} from "./urlUtils";
import {CNode3DObject, ModelAliases} from "./nodes/CNode3DObject";
import {UpdateHUD} from "./JetStuff";
import {degrees, getDateTimeFilename} from "./utils";
import {ViewMan} from "./CViewManager";
import {EventManager} from "./CEventManager";
import {isAdmin, SITREC_APP, SITREC_SERVER} from "./configUtils";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {DebugArrowAB, elevationAtLL, intersectSurface} from "./threeExt";
import {FeatureManager} from "./CFeatureManager";
import {CNodeTrackGUI} from "./nodes/CNodeControllerTrackGUI";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";
import {configParams} from "./runtimeConfig";
import {showError} from "./showError";
import {showPostLoadFilterDialog} from "./TrackFilterDialog";
import {textSitchToObject} from "./RegisterSitches";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {parseObjectInput as parseObjectInputUtil} from "./utils/parseObjectInput";
import {initializeSettings, SettingsSaver} from "./SettingsManager";
import {refreshMatLineAlphaToCoverage, updateMatLineResolution} from "./MatLines";
import {CNodeCurveEditor2} from "./nodes/CNodeCurveEdit2";
import {CNodeViewDAG} from "./nodes/CNodeViewDAG";
import {CNodeNotes} from "./nodes/CNodeNotes";
import {createCustomModalWithCopy, saveFilePrompted, saveFileToDirectory, saveFileToHandle} from "./FileUtils";
import {deserializeMotionAnalysis, serializeMotionAnalysis} from "./CMotionAnalysisUI";
import {deserializeAutoTracking, serializeAutoTracking} from "./CObjectTracking";
import {getCursorPositionFromTopView} from "./mouseMoveView";
import {addMenuToLeftSidebar, addMenuToRightSidebar, isInLeftSidebar, isInRightSidebar} from "./PageStructure";
import {CNodeControllerCelestial} from "./nodes/CNodeControllerVarious";
import {CNodeAutoTrackLOS} from "./nodes/CNodeAutoTrackLOS";
import {CNodeVideoInfoUI} from "./nodes/CNodeVideoInfoUI";
import {CNodeSimInfoUI} from "./nodes/CNodeSimInfoUI";
import {CNodeOSDDataSeriesController} from "./nodes/CNodeOSDDataSeriesController";
import {CNodeGUIFlag, CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {CNodeControllerCameraBankRoll} from "./nodes/CNodeControllerCameraBankRoll";
import {CNodeTurnRateBS} from "./nodes/CNodeTurnRateBS";
import {CNodeHorizonAngle} from "./CHorizonExtractor";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from "./trackSourceUtils";
import {encodeShareParam, resolveURLForFetch, toShareableCustomValue} from "./SitrecObjectResolver";
import {getEnvBool} from "./envUtils";
import {CNodeFloodSim} from "./nodes/CNodeFloodSim";
import {CNodeOrbitTrack} from "./nodes/CNodeOrbitTrack";
import {CNodeTrackSwitch} from "./nodes/CNodeTrackSwitch";
import {CNodeSwitch} from "./nodes/CNodeSwitch";
import {getNearbyWeatherBalloons, importSoundingDialog} from "./SondeFetch";
import {WIND_SOURCES, windSourceLabelsToKeys, windSourceByKey} from "./nodes/WindSources";
import {getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGE_OPTIONS, t} from "./i18n";
import {CNodeSAPage} from "./nodes/CNodeSAPage";
import {updateFilenameOverlay} from "./AttributionOverlay";
import {
    gimbalStepAirTrack,
    gimbalStepAirTrackDisplay,
    gimbalStepClouds,
    gimbalStepCommonViews,
    gimbalStepCore,
    gimbalStepFleet,
    gimbalStepGraphs,
    gimbalStepSAHAFU,
    gimbalStepTargetModel,
    gimbalStepTrackLOSNodes,
    gimbalStepTraverse,
} from "./GimbalCustomSetup";
import {Color, Vector3} from "three";

// Mixin modules — these files export objects of methods that are merged into
// CCustomManager.prototype at the bottom of this file. Splitting the class
// across multiple files keeps each file under the 2000-line limit while
// preserving `this` semantics for every method.
import {setupMethods} from "./CustomManagerSetup";
import {subSitchMethods} from "./CustomManagerSubSitch";
import {mirrorMethods} from "./CustomManagerMirror";
import {menuMethods} from "./CustomManagerMenus";
import {serializeMethods} from "./CustomManagerSerialize";

// Bulk knob set for the Performance Preset dropdown. Tuned for integrated GPUs
// and 16 GB hi-DPI laptops: render-scale shrinks the squared per-pixel work,
// reduced MSAA cuts the multisample resolve, and lower terrain detail/segments
// cut both CPU traversal and GPU vertex work. Only Quality keeps MSAA=4, which
// is the threshold at which LineMaterial's alphaToCoverage path can fade a
// sub-pixel-wide line smoothly. Below that, MatLines.js clamps linewidth to
// ≥1 fb-pixel so LOS / track lines stay solid instead of dashing at low MSAA.
const PERFORMANCE_PRESETS = {
    Quality:  { renderScale: 1,    msaaSamples: 4, fpsLimit: 60, tileSegments: 64, maxDetails: 25, videoMaxSize: "1080P" },
    Balanced: { renderScale: 0.85, msaaSamples: 2, fpsLimit: 30, tileSegments: 32, maxDetails: 20, videoMaxSize: "720P" },
    Fast:     { renderScale: 0.7,  msaaSamples: 0, fpsLimit: 30, tileSegments: 16, maxDetails: 15, videoMaxSize: "480P" },
    Potato:   { renderScale: 0.5,  msaaSamples: 0, fpsLimit: 20, tileSegments: 16, maxDetails: 10, videoMaxSize: "360P" },
};

export function applyPerformancePreset(name) {
    const p = PERFORMANCE_PRESETS[name];
    if (!p) return; // "Custom" or unknown — leave settings alone
    Object.assign(Globals.settings, p);
}

// Push the current renderScale + msaaSamples into every CNodeView3D so changes
// take effect without reloading the page. The renderer keeps its WebGL context;
// only the offscreen render targets are recreated (cheap).
export function applyRenderPerformanceSettings() {
    NodeMan.iterate((id, node) => {
        if (typeof node?.applyPerformanceSettings === "function") {
            node.applyPerformanceSettings();
        }
    });
    // Push the new effective render-target resolution into every pooled
    // LineMaterial so Line2 widths render at correct fb pixel sizes (otherwise
    // lines under-cover sub-pixel triangles at low renderScale → visible gaps).
    const lineDPR = (window.devicePixelRatio || 1) * (Globals.settings?.renderScale ?? 1);
    updateMatLineResolution(window.innerWidth * lineDPR, window.innerHeight * lineDPR);
    // And flip alphaToCoverage so the fragment-shader smoothstep AA branch
    // runs whenever MSAA is on (and stays off when MSAA=0, where it'd be a
    // no-op that costs a recompile).
    refreshMatLineAlphaToCoverage();
    // Also refresh terrain so a tileSegments/maxDetails change in a preset
    // takes effect immediately rather than waiting for the next pan.
    const terrainUI = NodeMan.get("terrainUI", false);
    if (terrainUI && typeof terrainUI.doRefresh === "function") {
        terrainUI.doRefresh();
    }
}

export class CCustomManager {
    constructor() {
        // Listen for GUI order change events to refresh mirrors
        document.addEventListener('gui-order-changed', (event) => {
            this.handleGUIOrderChange(event.detail.gui);
        });

        // Settings will be initialized in setup() after login check
        this.settingsInitialized = false;
    }

    /**
     * Wire up per-step buttons inside the Gimbal Analysis Preset folder so
     * the user can build the pipeline piece by piece.  Each button runs its
     * step live AND sets the corresponding flag in Sit.gimbalSetup.pipeline
     * so the state persists across save/reload.
     */
    _setupManualBuildFolder(parentFolder) {
        const gs = Sit.gimbalSetup;
        // Ensure pipeline object exists even for legacy sitches that set
        // gimbalSetup without an explicit pipeline — we don't retro-flag
        // everything, we just give the user a place to track new additions.
        if (!gs.pipeline) gs.pipeline = null;

        const manualFolder = parentFolder.addFolder("Manual Build").close();

        const markDone = (key) => {
            if (!Sit.gimbalSetup.pipeline) Sit.gimbalSetup.pipeline = {};
            Sit.gimbalSetup.pipeline[key] = true;
        };

        const step = (label, key, prereq, run) => {
            const state = {run: () => {
                try {
                    const miss = prereq && prereq();
                    if (miss) { showError(miss); return; }
                    run();
                    markDone(key);
                    setRenderOne(true);
                } catch (e) {
                    console.error("Gimbal manual step failed:", e);
                    showError("Step failed: " + (e && e.message ? e.message : e));
                }
            }};
            manualFolder.add(state, "run").name(label);
        };

        const need = (ids, msg) => () => {
            for (const id of ids) {
                if (!NodeMan.exists(id)) return msg + " (missing: " + id + ")";
            }
            return null;
        };

        step("Core (az/el/bank/winds/jetTrack/SAPage)", "core",
            need(["jetAltitude", "jetOrigin"], "Core step needs jetOrigin + jetAltitude"),
            () => gimbalStepCore(this._gimbalConfig));

        step("Traverse Nodes", "traverse",
            need(["JetLOS", "jetTrack"], "Traverse needs Core first"),
            () => gimbalStepTraverse(this._gimbalConfig.defaultTraverse ?? "Const Air Spd"));

        step("Air Track (target airspeed)", "airTrack",
            need(["LOSTraverseSelect", "targetWind"], "Air Track needs Traverse + Core"),
            () => gimbalStepAirTrack());

        step("Track LOS Display Nodes", "trackLOS",
            need(["JetLOS", "jetTrack", "LOSTraverseSelect"], "Track LOS needs Core + Traverse"),
            () => gimbalStepTrackLOSNodes());

        step("Clouds", "clouds",
            need(["jetTrack", "cloudAltitude"], "Clouds need Core"),
            () => gimbalStepClouds());

        step("Fleet (5-ship)", "fleet",
            need(["LOSTraverseSelect"], "Fleet needs Traverse"),
            () => gimbalStepFleet(this._gimbalConfig));

        step("Jet Views (chart + ATFLIR pod)", "commonViews",
            need(["LOSTraverseSelect"], "Jet Views needs Traverse"),
            () => gimbalStepCommonViews());

        step("Fleet HAFUs on SA Page", "saHAFU",
            () => {
                if (!ViewMan.get("SAPage", false)) return "HAFUs need SA Page (enable it under Show/Hide > Views)";
                if (!NodeMan.exists("fleeter01")) return "HAFUs need Fleet step first";
                if (!NodeMan.exists("LOSTraverseSelect")) return "HAFUs need Traverse step first";
                return null;
            },
            () => gimbalStepSAHAFU());

        step("Gimbal Graphs", "graphs",
            need(["cloudSpeedEditor", "azEditor", "LOSTraverseSelect"], "Graphs need Core + Traverse"),
            () => gimbalStepGraphs());

        step("Target Model (FA-18F)", "targetModel",
            need(["LOSTraverseSelect", "airTrack", "targetWind"], "Target Model needs Traverse + Air Track"),
            () => gimbalStepTargetModel());

        step("Air Track Display", "airTrackDisplay",
            need(["airTrack"], "Air Track Display needs Air Track step"),
            () => gimbalStepAirTrackDisplay());
    }

    _createSAPage() {
        const jetTrack = NodeMan.get("jetTrack", false) || NodeMan.get("cameraTrackSwitchSmooth", false);
        if (!jetTrack) { showError("SA Page requires a track"); this._showSAPage = false; return; }
        const windLocal = NodeMan.get("localWind", false);
        const windTarget = NodeMan.get("targetWind", false);

        const sa = new CNodeSAPage({
            id: "SAPage",
            jetTrack: jetTrack.id,
            windLocal: windLocal ? windLocal.id : undefined,
            windTarget: windTarget ? windTarget.id : undefined,
            left: 0.0, top: 0.5, width: -1, height: 0.5,
            background: new Color().setRGB(0, 0, 0),
            draggable: true, resizable: true,
        });

        // Auto-add all loaded tracks as HAFU symbols
        for (const id in TrackManager.list) {
            const meta = TrackManager.list[id].data;
            const track = meta && meta.trackNode ? meta.trackNode : meta;
            if (track && typeof track.p === 'function' && track.id !== jetTrack.id) {
                sa.addHAFU(track, "Unknown", "None", 0);
            }
        }
        const targetTrack = NodeMan.get("targetTrackSwitchSmooth", false)
            || NodeMan.get("LOSTraverseSelect", false);
        if (targetTrack && typeof targetTrack.p === 'function') {
            sa.addHAFU(targetTrack, "Hostile", "None", 0);
        }
    }

    // Settings saver with intelligent debouncing (5 second delay)
    settingsSaver = new SettingsSaver(5000);
    editingObjectNodeId = null;
    editingObjectMenu = null;

    async initializeSettings() {
        await initializeSettings();
    }

    /**
     * Save settings with intelligent debouncing
     * Delegates to SettingsSaver for all debouncing logic
     * @param {boolean} immediate - Force immediate save, bypassing debounce
     */
    async saveGlobalSettings(immediate = false) {
        await this.settingsSaver.save(immediate);
    }

    setEditingObject(nodeOrId, menu = null) {
        const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;
        if (!nodeId) {
            return;
        }

        this.editingObjectNodeId = nodeId;
        this.editingObjectMenu = menu ?? null;

        if (menu && !menu._clearsEditingObjectOnDestroy) {
            const originalDestroy = menu.destroy.bind(menu);
            menu.destroy = (...args) => {
                if (this.editingObjectMenu === menu) {
                    this.editingObjectMenu = null;
                    if (this.editingObjectNodeId === nodeId) {
                        this.editingObjectNodeId = null;
                    }
                }
                return originalDestroy(...args);
            };
            menu._clearsEditingObjectOnDestroy = true;
        }
    }

    clearEditingObject(nodeOrId = null, menu = null) {
        const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;

        if (menu && this.editingObjectMenu !== menu) {
            return;
        }
        if (nodeId && this.editingObjectNodeId !== nodeId) {
            return;
        }

        if (!menu || this.editingObjectMenu === menu) {
            this.editingObjectMenu = null;
        }
        if (!nodeId || this.editingObjectNodeId === nodeId) {
            this.editingObjectNodeId = null;
        }
    }

    getEditingObjectNode() {
        if (!this.editingObjectNodeId) {
            return null;
        }

        const node = NodeMan.get(this.editingObjectNodeId, false);
        if (!(node instanceof CNode3DObject)) {
            this.clearEditingObject();
            return null;
        }

        return node;
    }

    refreshEditingObjectMenu(nodeOrId = null) {
        const nodeId = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;
        if (nodeId && this.editingObjectNodeId && nodeId !== this.editingObjectNodeId) {
            return;
        }

        const menu = this.editingObjectMenu;
        if (!menu?._mirrorSource) {
            return;
        }

        this.rebuildMirror(menu._mirrorSource, menu);
        menu._lastMirrorState = this.createGUISignature(menu._mirrorSource);
    }

    /**
     * Dispose a 3D object and all its controllers
     * Properly cleans up controller resources (like smoothedTracks in ObjectTilt)
     * @param {string|CNode} nodeId - The node ID or node instance to dispose
     */
    disposeObjectWithControllers(nodeId) {
        const node = NodeMan.get(nodeId, false);
        if (!node) return;

        // Dispose all controllers first. Several controller types allocate helper
        // nodes of their own (for example ObjectTilt creates a smoothed helper track),
        // so they must be unlinked and disposed before the object that owns them.
        const controllerIds = [];
        for (const inputId in node.inputs) {
            const input = node.inputs[inputId];
            if (input.isController) {
                controllerIds.push(input.id);
            }
        }

        // Dispose controllers
        for (const controllerId of controllerIds) {
            NodeMan.unlinkDisposeRemove(controllerId);
        }

        // Finally unlink and dispose the object itself. Using unlinkDisposeRemove
        // avoids leaving controller inputs or other graph edges attached.
        NodeMan.unlinkDisposeRemove(nodeId);
    }

    setupSettingsMenu() {
        // Rebuild each sitch change (non-perm contents get destroyed)
        if (this._settingsMenuAdded) return;
        this._settingsMenuAdded = true;

        // Create Settings folder in the Sitrec menu
        const tooltipText = getEffectiveUserID() > 0
            ? t("custom.settings.tooltipLoggedIn")
            : t("custom.settings.tooltipAnonymous");

        const settingsFolder = guiMenus.main.addFolder(t("custom.settings.title"))
            .tooltip(tooltipText)
            .close();

        Globals.settings.language = getCurrentLanguage();

        settingsFolder.add(Globals.settings, "language", SUPPORTED_LANGUAGE_OPTIONS)
            .name(t("custom.settings.language.label"))
            .tooltip(t("custom.settings.language.tooltip"))
            .onChange((value) => {
                const previousLanguage = getCurrentLanguage();
                const normalizedLanguage = setLanguage(value);
                Globals.settings.language = normalizedLanguage;
                this.saveGlobalSettings(true);

                if (normalizedLanguage !== previousLanguage) {
                    window.location.reload();
                }
            })
            .listen();

        // Bulk preset that drives the render-perf knobs in Performance Tweaks
        // below. Selecting Custom is also what every individual onChange does,
        // so the preset just shows "Custom" once any sub-setting is hand-tuned.
        settingsFolder.add(Globals.settings, "performancePreset",
            ["Quality", "Balanced", "Fast", "Potato", "Custom"])
            .name(t("custom.settings.performancePreset.label"))
            .tooltip(t("custom.settings.performancePreset.tooltip"))
            .onChange((value) => {
                applyPerformancePreset(value);
                applyRenderPerformanceSettings();
                this.saveGlobalSettings(true);
            })
            .listen();

        // The five individual knobs the preset controls. Grouped into a
        // closed sub-folder so the preset stays the front-door control and
        // the tweaks only show up when the user opens the folder.
        const tweaksFolder = settingsFolder.addFolder("Performance Tweaks").close();

        // Render Scale: scales offscreen render targets + canvas pixel ratio.
        // Squared cost: 0.5 = ~1/4 GPU pixel work. Largest single perf knob.
        tweaksFolder.add(Globals.settings, "renderScale", {
            "100% (Native)": 1,
            "85%": 0.85,
            "70%": 0.7,
            "50% (Half)": 0.5,
            "35% (Quarter)": 0.35,
        })
            .name(t("custom.settings.renderScale.label"))
            .tooltip(t("custom.settings.renderScale.tooltip"))
            .onChange(() => {
                Globals.settings.performancePreset = "Custom";
                applyRenderPerformanceSettings();
                this.saveGlobalSettings(true);
            })
            .listen();

        // MSAA samples on the offscreen render target. 0 = disabled (fastest).
        tweaksFolder.add(Globals.settings, "msaaSamples", {
            "Off (fastest)": 0,
            "2x": 2,
            "4x (default)": 4,
            "8x": 8,
        })
            .name(t("custom.settings.msaaSamples.label"))
            .tooltip(t("custom.settings.msaaSamples.tooltip"))
            .onChange(() => {
                Globals.settings.performancePreset = "Custom";
                applyRenderPerformanceSettings();
                this.saveGlobalSettings(true);
            })
            .listen();

        // Tile Segments — terrain mesh resolution per tile.
        tweaksFolder.add(Globals.settings, "tileSegments", [8, 16, 32, 64, 128])
            .name(t("custom.settings.tileSegments.label"))
            .tooltip(t("custom.settings.tileSegments.tooltip"))
            .onFinishChange(() => {
                Globals.settings.performancePreset = "Custom";
                // When selection is finalized, force immediate save and refresh terrain
                this.saveGlobalSettings(true);

                // Refresh terrain with new mesh resolution
                const terrainUI = NodeMan.get("terrainUI", false);
                if (terrainUI) {
                    terrainUI.doRefresh();
                }
            })
            .listen();

        // Max Details — terrain detail level cap.
        tweaksFolder.add(Globals.settings, "maxDetails", 5, 30, 1)
            .name(t("custom.settings.maxDetails.label"))
            .tooltip(t("custom.settings.maxDetails.tooltip"))
            .onChange((value) => {
                // Sanitize the value
                const newValue = Math.max(5, Math.min(30, Math.round(value)));
                Globals.settings.maxDetails = newValue;
            })
            .onFinishChange(() => {
                // Flip preset to Custom only on release so dragging the slider
                // doesn't write the preset string on every frame of the gesture.
                Globals.settings.performancePreset = "Custom";
                // When we release the slider, force immediate save and recalculate everything
                this.saveGlobalSettings(true);

                // Recalculate terrain to avoid holes when going from high to low detail
                const terrainNode = NodeMan.get("terrainUI", false);
                if (terrainNode) {
                    console.log("Calling terrainNode.doRefresh()");
                    terrainNode.doRefresh();
                }
            })
            .listen();

        // FPS Limit — caps the requestAnimationFrame loop.
        tweaksFolder.add(Globals.settings, "fpsLimit", [60, 30, 20, 15])
            .name(t("custom.settings.fpsLimit.label"))
            .tooltip(t("custom.settings.fpsLimit.tooltip"))
            .onChange(() => {
                Globals.settings.performancePreset = "Custom";
                this.saveGlobalSettings(true);
            })
            .listen();

        // V5 OBB tile-culling controls. Admin-only — these are debug knobs
        // for graduating modes per-view, not user-facing settings.
        if (isAdmin()) {
            const TBM_OPTIONS = { Legacy: "legacy", Metrics: "metrics", Sphere: "sphere", OBB: "obb" };
            tweaksFolder.add(Globals.tileBoundsMode, "mainView", TBM_OPTIONS)
                .name("Tile Culling (main)")
                .tooltip("Tile bounding mode for mainView. Legacy = current sea-level sphere. Metrics = collect new bounds + counters without rendering changes. Sphere = use measured sphere. OBB = sphere broad-phase + OBB narrow-phase.")
                .listen();
            tweaksFolder.add(Globals.tileBoundsMode, "lookView", TBM_OPTIONS)
                .name("Tile Culling (look)")
                .tooltip("Tile bounding mode for lookView.")
                .listen();
            // Reach Cull is a V5 Phase 4 placeholder — Globals.enableReachCull
            // exists for the URL parser and stats counter, but no code in the
            // cull pipeline reads it yet. Hide the GUI control until Phase 4
            // ships so users don't toggle a no-op.
            tweaksFolder.add(Globals, "showTileOBB")
                .name("Show Tile OBB")
                .tooltip("Debug overlay: render each tile's OBB as line segments. Green = measured, yellow = inherited (from a measured ancestor), red = global default.")
                .listen();
        }

        // Max Resolution — caps the per-frame video texture size used for
        // motion analysis / tracking. Now preset-controlled, so changes flip
        // performancePreset to Custom like the other tweaks.
        tweaksFolder.add(Globals.settings, "videoMaxSize", ["None", "1080P", "720P", "480P", "360P"])
            .name(t("custom.settings.maxResolution.label"))
            .tooltip(t("custom.settings.maxResolution.tooltip"))
            .onChange(() => {
                Globals.settings.performancePreset = "Custom";
                this.saveGlobalSettings(true);
            })
            .listen();

        // Add AI Model selector dropdown (bound directly to Globals.settings.chatModel)
        this.availableChatModels = [];
        this.chatModelController = settingsFolder.add(Globals.settings, "chatModel", { "Loading...": "" })
            .name(t("custom.settings.aiModel.label"))
            .tooltip(t("custom.settings.aiModel.tooltip"))
            .onChange(() => {
                this.saveGlobalSettings(true);
            });

        // Add Center Sidebar toggle
        settingsFolder.add(Globals.settings, "centerSidebar")
            .name(t("custom.settings.centerSidebar.label"))
            .tooltip(t("custom.settings.centerSidebar.tooltip"))
            .onChange((value) => {
                Globals.settings.centerSidebar = Boolean(value);
                this.saveGlobalSettings(true);
            })
            .listen();

        // Add Show Attribution toggle
        settingsFolder.add(Globals.settings, "showAttribution")
            .name(t("custom.settings.showAttribution.label"))
            .tooltip(t("custom.settings.showAttribution.tooltip"))
            .onChange((value) => {
                Globals.settings.showAttribution = Boolean(value);
                this.saveGlobalSettings(true);
                const terrainUI = NodeMan.get("terrainUI", false);
                if (terrainUI) terrainUI.updateAttribution();
            })
            .listen();

        settingsFolder.add(Globals.settings, "showFilename")
            .name(t("custom.settings.showFilename.label"))
            .tooltip(t("custom.settings.showFilename.tooltip"))
            .onChange((value) => {
                Globals.settings.showFilename = Boolean(value);
                this.saveGlobalSettings(true);
                updateFilenameOverlay();
            })
            .listen();

        updateFilenameOverlay();

        // Fetch available models from server
        this.fetchAvailableChatModels();
    }

    async fetchAvailableChatModels() {
        try {
            const res = await fetch(withTestUser(SITREC_SERVER + 'chatbot.php?fetchModels=1'));
            const data = await res.json();
            this.availableChatModels = data.models || [];
            this.updateChatModelSelector();
        } catch (e) {
            console.error('Failed to fetch chat models:', e);
            this.availableChatModels = [];
            this.updateChatModelSelector();
        }
    }

    updateChatModelSelector() {
        if (!this.chatModelController) return;

        // Build options object: {label: "provider:model", ...}
        const options = {};
        for (const model of this.availableChatModels) {
            options[model.label] = `${model.provider}:${model.model}`;
        }

        if (Object.keys(options).length === 0) {
            options["No models available"] = "";
        }

        // Update the controller with new options
        this.chatModelController.options(options);

        // Validate saved setting and select appropriate model
        const savedModel = Globals.settings.chatModel;
        const validValues = Object.values(options);

        if (savedModel && validValues.includes(savedModel)) {
            // Saved model is valid, use it - just refresh the display
            this.chatModelController.updateDisplay();
        } else if (this.availableChatModels.length > 0) {
            // Saved model invalid or empty, use first available
            const firstModel = this.availableChatModels[0];
            Globals.settings.chatModel = `${firstModel.provider}:${firstModel.model}`;
            this.chatModelController.updateDisplay();
            this.saveGlobalSettings(true);
        }
    }

    // Upgrade legacy camera smoothing tracks to dynamic smoothing controls.
    // This keeps older custom sitches compatible without requiring data/custom/SitCustom.js edits.
    upgradeCameraSmoothingControls() {
        const smoothTrack = NodeMan.get("cameraTrackSwitchSmooth", false);
        if (!smoothTrack) return;
        if (typeof smoothTrack._setupDynamicSmoothingGUI !== "function") return;

        const cameraFolder = guiMenus.camera ?? guiMenus.physics;
        let smoothingFolder = cameraFolder.getFolder?.("Smoothing");
        if (!smoothingFolder) {
            smoothingFolder = cameraFolder.addFolder("Smoothing");
        }
        smoothingFolder.close();

        const migrateInputToSmoothingFolder = (inputName, nodeId, defaultValue, start, end, step, desc, tooltip = undefined) => {
            const existingInput = smoothTrack.in[inputName];
            let value = defaultValue;

            if (existingInput?.value !== undefined) {
                value = existingInput.value;
            } else if (existingInput?.v0 !== undefined) {
                value = existingInput.v0;
            }

            if (existingInput && existingInput.gui === smoothingFolder) {
                return existingInput;
            }

            if (existingInput) {
                smoothTrack.removeInput(inputName);
                if (existingInput.outputs.length === 0) {
                    NodeMan.unlinkDisposeRemove(existingInput.id);
                }
            }

            let inputNode = NodeMan.get(nodeId, false);
            if (inputNode && inputNode.gui !== smoothingFolder && inputNode.outputs.length === 0) {
                NodeMan.unlinkDisposeRemove(inputNode.id);
                inputNode = null;
            }

            if (!inputNode) {
                inputNode = new CNodeGUIValue({
                    id: nodeId,
                    value,
                    start,
                    end,
                    step,
                    desc,
                    tooltip,
                }, smoothingFolder);
            }

            if (smoothTrack.in[inputName] !== inputNode) {
                smoothTrack.addMoreInputs({[inputName]: inputNode});
            }

            return inputNode;
        };

        migrateInputToSmoothingFolder("window", "cameraTrackSwitchSmooth_windowValue", 20, 0, 1000, 1, "Camera Smooth Window");
        migrateInputToSmoothingFolder("tension", "cameraTrackSwitchSmooth_tensionValue", 0.5, 0, 1, 0.01, "Camera Catmull Tension");
        migrateInputToSmoothingFolder("intervals", "cameraTrackSwitchSmooth_intervalsValue", 20, 2, 200, 1, "Camera Catmull Intervals");
        migrateInputToSmoothingFolder("polyOrder", "cameraTrackSwitchSmooth_polyOrderValue", 3, 1, 5, 1, "Camera SavGol Poly Order");
        migrateInputToSmoothingFolder("edgeOrder", "cameraTrackSwitchSmooth_edgeOrderValue", 2, 1, 5, 1, "Camera Edge Fit Order");
        migrateInputToSmoothingFolder("fitWindow", "cameraTrackSwitchSmooth_fitWindowValue", 100, 3, 1000, 1, "Camera Edge Fit Window");

        if (smoothTrack.smoothingMethodController && smoothTrack.smoothingMethodController.parent !== smoothingFolder) {
            smoothTrack.smoothingMethodController.destroy();
            smoothTrack.smoothingMethodController = null;
        }

        smoothTrack.isDynamicSmoothing = true;
        smoothTrack.guiFolder = smoothingFolder;

        if (smoothTrack.method === "catmull") {
            smoothTrack.method = "spline";
        }
        const validMethods = new Set(["none", "moving", "movingPolyEdge", "sliding", "savgol", "spline"]);
        const methodWasNotExplicitlyModified = Sit.mods?.cameraTrackSwitchSmooth?.method === undefined;
        if (methodWasNotExplicitlyModified && (smoothTrack.method === undefined || smoothTrack.method === "moving" || smoothTrack.method === "movingPolyEdge")) {
            smoothTrack.method = "savgol";
        }
        if (!validMethods.has(smoothTrack.method)) {
            smoothTrack.method = "savgol";
        }

        smoothTrack._setupDynamicSmoothingGUI();
        smoothTrack._updateParameterVisibility?.();
        smoothTrack.recalculateCascade();
    }

    /**
     * Handle GUI order change events by refreshing any mirrors that depend on the changed GUI
     * @param {GUI} changedGui - The GUI that had its order changed
     */
    handleGUIOrderChange(changedGui) {
        // Find all standalone menus that mirror this GUI or any of its ancestors
        const allContainers = Array.from(document.querySelectorAll('[id^="menuBarDiv_"]'));

        allContainers.forEach((container) => {
            const gui = container._gui;
            if (gui && gui._standaloneContainer && gui._mirrorSource) {
                // Check if this mirror depends on the changed GUI
                if (this.isGUIRelated(gui._mirrorSource, changedGui)) {
                    // Force an immediate update of this mirror
                    setTimeout(() => this.updateMirror(gui), 0);
                }
            }
        });
    }

    /**
     * Check if a source GUI is related to (contains or is contained by) a changed GUI
     * @param {GUI} sourceGui - The source GUI of a mirror
     * @param {GUI} changedGui - The GUI that was changed
     * @returns {boolean} True if they are related
     */
    isGUIRelated(sourceGui, changedGui) {
        // Check if they are the same GUI
        if (sourceGui === changedGui) {
            return true;
        }

        // Check if changedGui is a child of sourceGui
        let current = changedGui.parent;
        while (current) {
            if (current === sourceGui) {
                return true;
            }
            current = current.parent;
        }

        // Check if sourceGui is a child of changedGui
        current = sourceGui.parent;
        while (current) {
            if (current === changedGui) {
                return true;
            }
            current = current.parent;
        }

        return false;
    }

    // CustomManager.setup() is called whenever we are setting up a new sitch
    // It's called from setupFunctions() in index.js AFTER the non-deferred run of SituationSetupFromData
    // So at this point the sitch noded will be set up, and youcan add more

    setupVideoInfoMenu() {
        if (!NodeMan.exists("videoInfo") && NodeMan.exists("video")) {
            new CNodeVideoInfoUI({
                id: "videoInfo",
                relativeTo: "video",
                visible: true,
                passThrough: true,
            });
        }

        const videoInfo = NodeMan.get("videoInfo", false);
        if (!videoInfo) return;

        videoInfo.setupMenu(guiMenus.video);
    }

    // Sim Info Display: a date/time overlay on the look view, added under the
    // "Show" menu. Independent of the Video Info Display (separate node + flags).
    // Attached via overlayView (not relativeTo) so it shares the look view's div
    // and behaves as a plain percent-of-canvas overlay (see CNodeSimInfoUI).
    setupSimInfoMenu() {
        if (!NodeMan.exists("lookView")) return;

        if (!NodeMan.exists("simInfo")) {
            new CNodeSimInfoUI({
                id: "simInfo",
                overlayView: "lookView",
                visible: true,
            });
        }

        const simInfo = NodeMan.get("simInfo", false);
        if (!simInfo) return;

        simInfo.setupMenu(guiMenus.showhide);
    }

    setupOSDDataSeriesController() {
        if (!NodeMan.exists("osdDataSeriesController")) {
            new CNodeOSDDataSeriesController({
                id: "osdDataSeriesController",
            });
        }
    }

    // Per-sitch wiring for the Simple Flight Sim folder. Creates the
    // racetrack-pattern controls (legLength, transitionTime) and the
    // optional bank-roll flag for the look camera, then wires them into
    // the existing flight-sim JetTrack and lookCamera. Idempotent — safe
    // to re-run on every sitch load (NodeMan.exists guards).
    setupSimpleFlightSim() {
        if (!guiMenus.simpleFlightSim) return;
        const folder = guiMenus.simpleFlightSim;

        if (!NodeMan.exists("legLength")) {
            new CNodeGUIValue({
                id: "legLength",
                value: 0,
                start: 0,
                end: 600,
                step: 0.1,
                desc: "Leg Length",
                tooltip: "Seconds of straight flight between 180° turns (0 disables the racetrack pattern)",
            }, folder);
        }
        if (!NodeMan.exists("transitionTime")) {
            new CNodeGUIValue({
                id: "transitionTime",
                value: 3,
                start: 0,
                end: 10,
                step: 0.1,
                desc: "Transition Time",
                tooltip: "Seconds to ramp the turn rate from 0 to the full Turn Rate at the start and end of each 180° turn",
            }, folder);
        }

        // Wire racetrack inputs into the JetTrack. JetTrack was constructed
        // before these nodes existed (sitch object processed first), so
        // optionalInputs left them undefined — patch them in now.
        if (NodeMan.exists("flightSimCameraPosition")) {
            const jt = NodeMan.get("flightSimCameraPosition");
            const legLengthNode = NodeMan.get("legLength");
            const transitionNode = NodeMan.get("transitionTime");
            const wiredNew = jt.in.legLength !== legLengthNode || jt.in.transitionTime !== transitionNode;
            if (jt.in.legLength !== legLengthNode) {
                jt.addMoreInputs({legLength: legLengthNode});
            }
            if (jt.in.transitionTime !== transitionNode) {
                jt.addMoreInputs({transitionTime: transitionNode});
            }
            // Re-run recalc so the new inputs take effect immediately.
            if (wiredNew) jt.recalculate();
        }

        // Optional bank-roll for the look camera so the rendered horizon
        // tilts with the simulated aircraft's bank.
        if (!NodeMan.exists("lookCameraBankRoll")) {
            new CNodeGUIFlag({
                id: "lookCameraBankRoll",
                value: false,
                desc: "Roll View with Bank",
                tooltip: "When using the flight-sim camera, roll the look camera by the bank angle so the horizon tilts as if you were the pilot",
            }, folder);
        }

        if (NodeMan.exists("lookCamera")
            && NodeMan.exists("cameraTrackSwitchSmooth")
            && !NodeMan.exists("cameraBankRollController")) {
            const ctrl = new CNodeControllerCameraBankRoll({
                id: "cameraBankRollController",
                track: "cameraTrackSwitchSmooth",
                enabled: "lookCameraBankRoll",
            });
            NodeMan.get("lookCamera").addControllerNode(ctrl);
        }

        // Consolidated "Turn Rate Source" dropdown. Selects which signal
        // drives the JetTrack's turn rate input:
        //   Manual Turn Rate   → the user's Turn Rate slider directly
        //   Manual Bank        → g·tan(bank)/V using a manual Bank slider
        //   Horizon Extractor  → g·tan(bank)/V using the horizon-extractor angle
        // Conditional future options (Turn Rate File <name>, Bank File <name>)
        // will plug into the same switch when the data-file infrastructure
        // lands. The switch is the only thing JetTrack reads — swapping
        // options swaps sources without touching downstream consumers.
        if (!NodeMan.exists("horizonAngle")) {
            new CNodeHorizonAngle({id: "horizonAngle"});
        }
        if (!NodeMan.exists("jetBank")) {
            new CNodeGUIValue({
                id: "jetBank",
                value: 0, start: -60, end: 60, step: 0.1,
                desc: "Manual Bank",
                tooltip: "Manual bank angle in degrees (positive = right wing down). Used by the Manual Bank source via g·tan(bank)/V.",
            }, folder);
        }
        if (!NodeMan.exists("turnRateFromBank")
            && NodeMan.exists("jetTAS") && NodeMan.exists("horizonAngle")) {
            new CNodeTurnRateBS({
                id: "turnRateFromBank",
                inputs: {speed: "jetTAS", bank: "horizonAngle"},
            });
        }
        if (!NodeMan.exists("turnRateFromManualBank")
            && NodeMan.exists("jetTAS") && NodeMan.exists("jetBank")) {
            new CNodeTurnRateBS({
                id: "turnRateFromManualBank",
                inputs: {speed: "jetTAS", bank: "jetBank"},
            });
        }
        if (!NodeMan.exists("turnRateSource")
            && NodeMan.exists("turnRate")
            && NodeMan.exists("turnRateFromBank")
            && NodeMan.exists("turnRateFromManualBank")) {
            new CNodeSwitch({
                id: "turnRateSource",
                inputs: {
                    "Manual Turn Rate": "turnRate",
                    "Manual Bank": "turnRateFromManualBank",
                    "Horizon Extractor": "turnRateFromBank",
                },
                default: "Manual Turn Rate",
                desc: "Turn Rate Source",
            }, folder);
        }

        // Rewire the JetTrack's turnRate input to read from the switch.
        // addInput asserts the input doesn't already exist, so we have to
        // removeInput first. Idempotent: if already pointing at the switch,
        // we do nothing.
        if (NodeMan.exists("flightSimCameraPosition") && NodeMan.exists("turnRateSource")) {
            const jt = NodeMan.get("flightSimCameraPosition");
            const src = NodeMan.get("turnRateSource");
            if (jt.in.turnRate !== src) {
                jt.removeInput("turnRate");
                jt.addInput("turnRate", src);
                jt.recalculate();
            }
        }

        // Racetrack-pattern controls (Leg Length, Transition Time) only make
        // sense for the constant Manual Turn Rate source — every other source
        // already encodes a real per-frame turn rate. Hide them when the
        // user picks anything else, and recalculate the JetTrack so the
        // straight legacy "use turnRate directly" path kicks in immediately.
        // Drive visibility through the node's `.visible` field rather than
        // calling `.guiEntry.hide()` directly: CNodeGUIValue.update() syncs
        // the gui's _hidden flag back to `this.visible` every frame, so a
        // bare guiEntry.hide() gets reverted on the very next render tick.
        const applyRacetrackVisibility = () => {
            const trs = NodeMan.get("turnRateSource", false);
            const legNode = NodeMan.get("legLength", false);
            const transNode = NodeMan.get("transitionTime", false);
            if (!trs || !legNode || !transNode) return;
            const showRacetrack = (trs.choice === "Manual Turn Rate");
            if (showRacetrack) {
                legNode.show();
                transNode.show();
            } else {
                legNode.hide();
                transNode.hide();
            }
        };
        applyRacetrackVisibility();
        const trsNode = NodeMan.get("turnRateSource", false);
        // Guard against re-wrapping on a second setupSimpleFlightSim() call
        // for the same switch — each call would otherwise chain another
        // layer of onChange wrappers around the previous one.
        if (trsNode && !trsNode._racetrackVisibilityWired) {
            trsNode._racetrackVisibilityWired = true;
            // CNodeSwitch fires Switch.choiceChanged.<id> on every choice
            // change, including the quiet ones from modDeserialize. That's
            // the only signal that catches the post-deserialize state
            // change — onChangeCallback alone only covers interactive picks.
            EventManager.addEventListener("Switch.choiceChanged.turnRateSource", () => {
                applyRacetrackVisibility();
                const jt = NodeMan.get("flightSimCameraPosition", false);
                if (jt) jt.recalculate();
            });
        }

        // The pre-existing jetHeading switch is labelled "Turn Rate Control"
        // in SitCustom.js, which is genuinely confusing because it actually
        // controls the *heading* source (manual angle or a per-frame file).
        // Rename its slider label so it reads as what it does. The "*"
        // prefix CNodeSwitch adds on local builds is preserved.
        const jh = NodeMan.get("jetHeading", false);
        if (jh?.controller) {
            const star = jh.controller._name?.startsWith("*") ? "*" : "";
            jh.controller.name(star + "Heading Source");
        }
    }


    async setupVideoExport() {
        const { VideoExportManager } = await import("./VideoExporter");
        this.videoExportManager = new VideoExportManager();
        await this.videoExportManager.setupMenu(guiMenus.video);
    }

    setupStandaloneMenuExample() {
        // Create a standalone pop-up menu at position (300, 150)
        const standaloneMenu = Globals.menuBar.createStandaloneMenu("Example Popup", 300, 150);

        // Add some example controls to the menu
        const exampleObject = {
            message: "Hello World!",
            value: 42,
            enabled: true,
            color: "#ff0000",
            showMenu: () => {
                console.log("Standalone menu button clicked!");
                alert("This is a standalone pop-up menu!\n\nYou can:\n- Drag it around by the title bar\n- Click anywhere on it to bring it to front\n- Add any lil-gui controls to it");
            },
            closeMenu: () => {
                standaloneMenu.destroy();
            }
        };

        // Add various controls to demonstrate functionality
        standaloneMenu.add(exampleObject, "message").name("Text Message");
        standaloneMenu.add(exampleObject, "value", 0, 100).name("Numeric Value");
        standaloneMenu.add(exampleObject, "enabled").name("Toggle Option");
        standaloneMenu.addColor(exampleObject, "color").name("Color Picker");

        // Add a folder to show nested structure works
        const subFolder = standaloneMenu.addFolder("Sub Menu");
        subFolder.add(exampleObject, "showMenu").name("Show Info");
        subFolder.add(exampleObject, "closeMenu").name("Close This Menu");

        // Open the menu by default to show it
        standaloneMenu.open();
        subFolder.open();

        // Store reference for potential cleanup
        this.exampleStandaloneMenu = standaloneMenu;
    }


    updateViewFromPreset() {
        const preset = this.viewPresets[this.currentViewPreset];
        if (preset) {
            // Clear any fullscreen state before applying preset
            ViewMan.fullscreenView = null;
            ViewMan.iterate((id, v) => {
                if (v.doubled) {
                    v.doubled = false;
                    v.left = v.preDoubledLeft;
                    v.top = v.preDoubledTop;
                    if (v.width > 0) v.width = v.preDoubledWidth;
                    if (v.height > 0) v.height = v.preDoubledHeight;
                    v.updateWH();
                }
            });

            for (const viewName in preset) {
                if (NodeMan.exists(viewName)) {
                    ViewMan.updateViewFromPreset(viewName, preset[viewName]);
                }
            }

            // The secondary video view only appears in the two-video preset.
            // Any preset that doesn't mention it should hide it, so an empty
            // video2 box doesn't linger over another view after switching back.
            if (NodeMan.exists("video2") && preset.video2 === undefined) {
                NodeMan.get("video2").setVisible(false);
            }

            forceUpdateUIText();
        } else {
            console.warn("No view preset found for " + this.currentViewPreset);
        }
    }


    removeAllTracks() {
        // First, dispose any synthetic objects that might be associated with tracks
        // This ensures their controllers are properly cleaned up
        const nodesToDispose = [];
        NodeMan.iterate((id, node) => {
            // Find any synthetic 3D objects (typically starting with "syntheticObject_")
            if (id.startsWith("syntheticObject_") && node.inputs) {
                nodesToDispose.push(id);
            }
        });

        // Dispose objects with their controllers
        for (const objectId of nodesToDispose) {
            this.disposeObjectWithControllers(objectId);
        }

        // Then dispose all tracks
        TrackManager.iterate((id, track) => {
            TrackManager.disposeRemove(id)
        })
        setRenderOne(true);

    }

    async filterTracks() {
        await showPostLoadFilterDialog();
    }

    removeAllBuildings() {
        Synth3DManager.removeAllBuildings();
        setRenderOne(true);
    }

    addTrackFromCameraLOS() {
        const cameraNode = NodeMan.get("lookCamera", false) || NodeMan.get("mainCamera", false);
        if (!cameraNode || !cameraNode.camera) {
            console.warn("addTrackFromCameraLOS: no camera node found");
            return;
        }

        const camera = cameraNode.camera;
        camera.updateMatrixWorld();

        const start = camera.position.clone();
        const forward = new Vector3();
        camera.getWorldDirection(forward);

        // 300 statute miles in meters
        const FAR_DISTANCE = 300 * 1609.344;
        const surfaceHit = intersectSurface(start, forward);
        const end = surfaceHit ?? start.clone().add(forward.clone().multiplyScalar(FAR_DISTANCE));

        const lastFrame = Math.max(0, (Sit.frames ?? 1) - 1);
        TrackManager.addSyntheticTrack({
            name: "Camera LOS",
            curveType: "linear",
            editMode: false,
            color: 0xff00ff,
            initialPoints: [
                [0,         start.x, start.y, start.z],
                [lastFrame, end.x,   end.y,   end.z],
            ],
        });
        setRenderOne(true);
    }

    calculateBestPairs() {
        // given the camera position for lookCamera at point A and B
        // calculate the LOS for each object from the camerea, at A and B
        // then interate over the objects and find the best pairs

        const targetAngle = 0.6;

        const A = Sit.aFrame;
        const B = Sit.bFrame;

        const lookCamera = NodeMan.get("lookCamera");
        const lookA = lookCamera.p(A);
        const lookB = lookCamera.p(B);
        // TODO - A and B above don't work, we need to use a track like CNodeLOSFromCamera, or simulate the camera (which is what CNodeLOSFromCamera does)
        // but for fixed camera for now, it's okay.

        const trackList = [];

        // Now iterate over the objects tracks
        TrackManager.iterate((id, track) => {

            const node = track.trackNode;

            // get the object position at times A and B
            const posA = node.p(A);
            const posB = node.p(B);

            // get the two vectors from look A and B to the object

            const losA = posA.clone().sub(lookA).normalize();
            const losB = posB.clone().sub(lookB).normalize();

            trackList.push({
                id: id,
                node: node,
                posA: posA,
                posB: posB,
                losA: losA,
                losB: losB,

            });

            console.log("Track " + id + " A: " + posA.toArray() + " B: " + posB.toArray() + " LOSA: " + losA.toArray() + " LOSB: " + losB.toArray());

        })

        // Now iterate over the track list and find the best pairs
        // for now add two absolute deffrences between the target angle
        // and the angle between the two LOS vectors


        let bestPair = [null, null];
        let bestDiff = 1000000;

        this.bestPairs = []

        // outer loop, iterate over the track list
        for (let i = 0; i < trackList.length - 1; i++) {
            const obj1 = trackList[i];

            // inner loop, iterate over the object list
            for (let j = i + 1; j < trackList.length; j++) {
                const obj2 = trackList[j];

                // get the angle between the two LOS vectors at A and B
                const angleA = degrees(Math.acos(obj1.losA.dot(obj2.losA)));
                const angleB = degrees(Math.acos(obj1.losB.dot(obj2.losB)));

                // get the absolute difference from the target angle
                const diffA = Math.abs(angleA - targetAngle);
                const diffB = Math.abs(angleB - targetAngle);

                console.log("Pair " + obj1.id + " " + obj2.id + " A: " + angleA.toFixed(2) + " B: " + angleB.toFixed(2) + " Diff A: " + diffA.toFixed(2) + " Diff B: " + diffB.toFixed(2));

                const metric = diffA + diffB;

                // store all pairs as object in bestPairs
                this.bestPairs.push({
                    obj1: obj1,
                    obj2: obj2,
                    angleA: angleA,
                    angleB: angleB,
                    diffA: diffA,
                    diffB: diffB,
                    metric: metric,
                });


                // if the diff is less than the best diff, then store it
                if (metric < bestDiff) {
                    bestDiff = diffA + diffB;
                    bestPair = [obj1, obj2];
                }


            }
        }

        // sort the best pairs by metric
        this.bestPairs.sort((a, b) => {
            return a.metric - b.metric;
        });




        console.log("Best pair: " + bestPair[0].id + " " + bestPair[1].id + " Diff: " + bestDiff.toFixed(10));
        console.log("Best angles: " + bestPair[0].losA.angleTo(bestPair[1].losA).toFixed(10) + " " + bestPair[0].losB.angleTo(bestPair[1].losB).toFixed(10));

        // // for the best pair draw debug arrows from lookA and lookB to the objects
        //
        // // red fro the first one
        // DebugArrowAB("Best 0A", lookA, bestPair[0].posA, "#FF0000", true, GlobalScene)
        // DebugArrowAB("Best 0B", lookB, bestPair[0].posB, "#FF8080", true, GlobalScene)
        //
        // // green for the second one
        // DebugArrowAB("Best 1A", lookA, bestPair[1].posA, "#00ff00", true, GlobalScene)
        // DebugArrowAB("Best 1B", lookB, bestPair[1].posB, "#80ff80", true, GlobalScene)


        // do debug arrows for the top 10
        for (let i = 0; i < Math.min(10, this.bestPairs.length); i++) {
            const obj1 = this.bestPairs[i].obj1;
            const obj2 = this.bestPairs[i].obj2;

            DebugArrowAB("Best " + i + "A", lookA, obj1.posA, "#FF0000", true, GlobalScene)
            DebugArrowAB("Best " + i + "B", lookB, obj1.posB, "#FF8080", true, GlobalScene)

            DebugArrowAB("Best " + i + "A", lookA, obj2.posA, "#00ff00", true, GlobalScene)
            DebugArrowAB("Best " + i + "B", lookB, obj2.posB, "#80ff80", true, GlobalScene)

            // and a white arrow between them
            DebugArrowAB("Best " + i + "AB", obj1.posA, obj2.posA, "#FFFFFF", true, GlobalScene)

        }

    }


    toggleExtendToGround() {
        console.log("Toggle Extend to Ground");
        let anyExtended = false;
        NodeMan.iterate((id, node) => {
            if (node instanceof CNodeDisplayTrack) {
                anyExtended ||= node.extendToGround;
            }
        })

        NodeMan.iterate((id, node) => {
            if (node instanceof CNodeDisplayTrack) {
                node.extendToGround = !anyExtended;
                node.recalculate();
            }
        })
        setRenderOne(true);

    }

    loginAttempt() {
        FileManager.loginAttempt(this.serialize, this.serializeButton, this.buttonText, this.buttonColor);
    };

    openAdminDashboard() {
        window.open(SITREC_SERVER + 'admin_dashboard.php', '_blank');
    }

    toggleFeatureSitch() {
        const sitchName = Sit.sitchName;
        if (!sitchName) {
            alert("No saved sitch is currently loaded.");
            return;
        }
        const browser = FileManager.sitchBrowser;
        if (!browser) {
            alert("Sitch browser is not available.");
            return;
        }

        if (browser._isFeatured(sitchName)) {
            browser._removeLabelFromSitches([sitchName], "Featured");
        } else {
            browser._addLabelToSitches([sitchName], "Featured");
        }
        this.updateFeatureButton();
    }

    updateFeatureButton() {
        if (!this._featureButton) return;
        const sitchName = Sit.sitchName;
        const browser = FileManager.sitchBrowser;
        const isFeatured = sitchName && browser && browser._isFeatured(sitchName);
        this._featureButton.name(isFeatured ? "Unfeature" : "Feature");
    }

    validateSitchNames() {
        alert("Validate Sitch Names is disabled.");
    }

    async validateAllSitches() {
        if (!FileManager.userSaves || FileManager.userSaves.length === 0) {
            alert("No saved sitches found. Make sure you are logged in and have saved sitches.");
            return;
        }

        const sitchesToValidate = FileManager.userSaves.filter(name => name !== "-");
        if (sitchesToValidate.length === 0) {
            alert("No sitches to validate.");
            return;
        }

        const results = {
            total: sitchesToValidate.length,
            passed: [],
            failed: []
        };

        console.log(`Starting validation of ${sitchesToValidate.length} sitches...`);

        Globals.validationMode = true;
        Globals.validationErrors = [];

        const originalConsoleError = console.error;
        const originalConsoleWarn = console.warn;

        for (let i = 0; i < sitchesToValidate.length; i++) {
            const sitchName = sitchesToValidate[i];
            console.log(`\n[${i + 1}/${sitchesToValidate.length}] Validating: ${sitchName}`);

            Globals.validationErrors = [];
            let sitchErrors = [];

            console.error = (...args) => {
                const errorMsg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
                sitchErrors.push({ type: 'console.error', message: errorMsg });
                originalConsoleError.apply(console, args);
            };

            try {
                const versions = await FileManager.getVersions(sitchName);
                const latestVersion = versions[versions.length - 1].url;
                const response = await fetch(latestVersion);
                const data = await response.arrayBuffer();
                const decoder = new TextDecoder('utf-8');
                const decodedString = decoder.decode(data);

                let sitchObject = textSitchToObject(decodedString);

                if (sitchObject.terrainUI) {
                    sitchObject.terrainUI.mapType = "Local";
                    sitchObject.terrainUI.elevationType = "Local";
                } else if (sitchObject.terrain) {
                    sitchObject.terrain.mapType = "Local";
                    sitchObject.terrain.elevationType = "Local";
                }

                await new Promise((resolve, reject) => {
                    const errorHandler = (event) => {
                        sitchErrors.push({ type: 'uncaught', message: event.message || String(event) });
                    };
                    const rejectionHandler = (event) => {
                        sitchErrors.push({ type: 'unhandledRejection', message: event.reason?.message || String(event.reason) });
                    };

                    window.addEventListener('error', errorHandler);
                    window.addEventListener('unhandledrejection', rejectionHandler);

                    setNewSitchObject(sitchObject);

                    setTimeout(() => {
                        window.removeEventListener('error', errorHandler);
                        window.removeEventListener('unhandledrejection', rejectionHandler);
                        resolve();
                    }, 3000);
                });

                if (sitchErrors.length > 0) {
                    results.failed.push({ name: sitchName, errors: sitchErrors });
                    console.log(`  FAILED: ${sitchName} - ${sitchErrors.length} error(s)`);
                } else {
                    results.passed.push(sitchName);
                    console.log(`  PASSED: ${sitchName}`);
                }

            } catch (error) {
                sitchErrors.push({ type: 'exception', message: error.message || String(error) });
                results.failed.push({ name: sitchName, errors: sitchErrors });
                console.log(`  FAILED: ${sitchName} - ${error.message}`);
            }
        }

        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        Globals.validationMode = false;

        let report = `\n${"=".repeat(60)}\nSITCH VALIDATION REPORT\n${"=".repeat(60)}\n`;
        report += `Total: ${results.total} | Passed: ${results.passed.length} | Failed: ${results.failed.length}\n`;
        report += `${"=".repeat(60)}\n`;

        if (results.failed.length > 0) {
            report += `\nFAILED SITCHES:\n${"-".repeat(40)}\n`;
            for (const failed of results.failed) {
                report += `\n${failed.name}:\n`;
                for (const error of failed.errors) {
                    report += `  [${error.type}] ${error.message}\n`;
                }
            }
        }

        if (results.passed.length > 0) {
            report += `\nPASSED SITCHES:\n${"-".repeat(40)}\n`;
            for (const passed of results.passed) {
                report += `  ${passed}\n`;
            }
        }

        console.log(report);
        alert(`Validation complete!\n\nPassed: ${results.passed.length}\nFailed: ${results.failed.length}\n\nSee console for detailed report.`);
    }

    async addMissingScreenshots() {
        // Fetch the full sitch list with screenshot info
        let sitchList;
        try {
            const response = await fetch(withTestUser(SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: 'cors'});
            if (response.status !== 200) throw new Error(`Server returned ${response.status}`);
            sitchList = await response.json();
        } catch (err) {
            alert("Failed to fetch sitch list: " + err.message);
            return;
        }

        // Fetch label metadata so we can skip Deleted sitches
        let deletedNames = new Set();
        try {
            const metaResp = await fetch(withTestUser(SITREC_SERVER + "metadata.php"), {mode: 'cors'});
            if (metaResp.ok) {
                const metaData = await metaResp.json();
                const sitchLabels = metaData.sitchLabels || {};
                for (const [name, labels] of Object.entries(sitchLabels)) {
                    if (Array.isArray(labels) && labels.includes("Deleted")) {
                        deletedNames.add(name);
                    }
                }
            }
        } catch (e) {
            console.warn("Could not fetch label metadata, proceeding without filter:", e);
        }

        // Filter to sitches without screenshots, excluding Deleted: entry is [name, date, screenshotUrl|null]
        // Sort newest first
        const missing = sitchList.filter(entry => !entry[2] && !deletedNames.has(String(entry[0])));
        missing.sort((a, b) => new Date(b[1]) - new Date(a[1]));
        if (missing.length === 0) {
            alert("All sitches already have screenshots!");
            return;
        }

        const total = missing.length;
        if (!confirm(`Found ${total} sitch(es) without screenshots.\n\nThis will load each one, wait for it to render, then upload a screenshot.\n\nContinue?`)) {
            return;
        }

        console.log(`Adding screenshots to ${total} sitches...`);

        Globals.screenshotting = true;
        const results = {added: [], failed: []};

        // Intercept console.error so any error (including asserts) stops the process
        const originalConsoleError = console.error;
        let capturedError = null;
        console.error = function (...args) {
            originalConsoleError.apply(console, args);
            if (!capturedError) {
                capturedError = args.join(' ');
            }
        };

        for (let i = 0; i < missing.length; i++) {
            const sitchName = String(missing[i][0]);
            let latestVersion = "(unknown)";
            capturedError = null;
            console.log(`\n[${i + 1}/${total}] Loading: ${sitchName}`);

            try {
                // Get the latest version URL
                const versions = await FileManager.getVersions(sitchName);
                if (!versions || versions.length === 0) {
                    throw new Error("No versions found");
                }
                latestVersion = versions[versions.length - 1].url;

                // Fetch and parse the sitch
                const response = await fetch(latestVersion);
                const data = await response.arrayBuffer();
                const decoder = new TextDecoder('utf-8');
                const decodedString = decoder.decode(data);
                let sitchObject = textSitchToObject(decodedString);

                // Force local terrain to avoid network delays
                if (sitchObject.terrainUI) {
                    sitchObject.terrainUI.mapType = "Local";
                    sitchObject.terrainUI.elevationType = "Local";
                } else if (sitchObject.terrain) {
                    sitchObject.terrain.mapType = "Local";
                    sitchObject.terrain.elevationType = "Local";
                }

                // Load the sitch and wait for it to fully render
                setNewSitchObject(sitchObject);

                // Wait for the sitch object to be picked up by the animation loop
                await new Promise(resolve => {
                    const check = () => {
                        if (Globals.newSitchObject === undefined) resolve();
                        else setTimeout(check, 100);
                    };
                    check();
                });

                const targetFrame = Math.floor(par.frame);
                const savedPaused = par.paused;
                const renderAtTargetFrame = async () => {
                    par.frame = targetFrame;

                    // Keep requesting the exact target frame so video decode/cache converges
                    // even when playback is paused during screenshot generation.
                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.videoData && typeof node.videoData.getImage === "function") {
                            node.videoData.getImage(targetFrame);
                        }
                    }

                    setRenderOne(true);
                    await new Promise(resolve => requestAnimationFrame(resolve));
                };

                par.paused = true;
                par.frame = targetFrame;
                setRenderOne(true);

                try {
                    // Wait for all pending async operations (terrain tiles, 3D tiles, video, etc.)
                    await waitForExportFrameSettled({
                        frame: targetFrame,
                        maxWaitMs: 60000,
                        renderFrame: renderAtTargetFrame,
                        logPrefix: "Screenshot add",
                    });

                    // Check if any console.error occurred during loading
                    if (capturedError) {
                        throw new Error(`console.error during load: ${capturedError}`);
                    }

                    // Capture and upload the screenshot
                    const blob = await FileManager.captureViewportScreenshot();
                    if (!blob) {
                        throw new Error("Screenshot capture returned null");
                    }
                    const buffer = await blob.arrayBuffer();
                    const url = await FileManager.rehoster.rehostFile(sitchName, buffer, "screenshot.jpg", {skipHash: true});
                    await FileManager.bumpScreenshotVersion(sitchName);
                    console.log(`  Screenshot saved: ${url}`);
                    results.added.push(sitchName);
                } finally {
                    par.paused = savedPaused;
                    setRenderOne(true);
                }

            } catch (error) {
                console.error = originalConsoleError;
                console.error(`  FAILED: ${sitchName} - ${error.message}`);
                results.failed.push({name: sitchName, error: error.message});
                Globals.screenshotting = false;
                let report = `\nScreenshot generation STOPPED on error.\nAdded: ${results.added.length} | Failed: 1\n`;
                report += `  ${sitchName}: ${error.message}\n`;
                console.log(report);
                alert(`Screenshot generation stopped on error!\n\nAdded: ${results.added.length}\nFailed: ${sitchName}\nFile: ${latestVersion}\n\n${error.message}\n\nSee console for details.`);
                return;
            }
        }

        console.error = originalConsoleError;
        Globals.screenshotting = false;
        let report = `\nScreenshot generation complete.\nAdded: ${results.added.length}\n`;
        console.log(report);
        alert(`Screenshot generation complete!\n\nAdded: ${results.added.length}\n\nSee console for details.`);
    }

    refreshLookViewTracks() {
        // intere over all nodes, and find all CNodeTrackGUI, and call setTrackVisibility
        NodeMan.iterate((id, node) => {
            if (node instanceof CNodeTrackGUI) {
                if (Globals.showAllTracksInLook) {
                    node.setTrackVisibility(true);
                } else {
                    node.setTrackVisibility(node.showTrackInLook);
                }
            }
        });
        setRenderOne(true)
    }


    preRenderUpdate(view) {
        if (!Sit.isCustom) return;

        // Track which CNode3DObjects we hide for this view's render so the
        // right-click picker can ignore them even after postRenderUpdate
        // restores .visible.
        view._renderHiddenNodeIDs = new Set();

        //
        // infoDiv.style.display = 'block';
        // infoDiv.innerHTML = "Look Camera<br>"
        // let camera = NodeMan.get("lookCamera").camera
        // infoDiv.innerHTML += "Position: " + camera.position.x.toFixed(2) + ", " + camera.position.y.toFixed(2) + ", " + camera.position.z.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Rotation: " + camera.rotation.x.toFixed(2) + ", " + camera.rotation.y.toFixed(2) + ", " + camera.rotation.z.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "FOV: " + camera.fov.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Aspect: " + camera.aspect.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Near: " + camera.near.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Far: " + camera.far.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Zoom: " + camera.zoom.toFixed(2) + "<br>"
        //
        //
        // infoDiv.innerHTML += "<br><br>Main Camera<br>"
        // camera = NodeMan.get("mainCamera").camera
        // infoDiv.innerHTML += "Position: " + camera.position.x.toFixed(2) + ", " + camera.position.y.toFixed(2) + ", " + camera.position.z.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "Rotation: " + camera.rotation.x.toFixed(2) + ", " + camera.rotation.y.toFixed(2) + ", " + camera.rotation.z.toFixed(2) + "<br>"
        // infoDiv.innerHTML += "FOV: " + camera.fov.toFixed(2) + "<br>"
        //
        // infoDiv.innerHTML += "<br>Sit.lat: " + Sit.lat.toFixed(2) + " Sit.lon " + Sit.lon.toFixed(2) + "<br>"
        //


        // special logic for custom model visibility
        // if the custom model is following the same track as this one, then turn it off

        let targetObject = NodeMan.get("targetObject", false);
        if (targetObject === undefined) {
            targetObject = NodeMan.get("traverseObject", false);
        }

        // patch for legacy sitches with different configuation of target Object (e.g. Gimbal)
        if(!targetObject) return;

        const tob = targetObject._object;

        // root track are calculate and cached for all CNode3DObjects in their recalculate()
        const targetRoot = targetObject.rootTrack;

        // iterate over the NodeMan objects
        // if the object has a displayTargetSphere, then check if it's following the same track
        // as the camera track, and if so, turn it off
        for (const entry of Object.values(NodeMan.list)) {
            const node = entry.data;
            // is it derived from CNode3D?
            if (node instanceof CNode3DObject) {
                const ob = node._object;
                if (disableIfNearCameraTrack(node, ob, view.camera)) {
                    view._renderHiddenNodeIDs.add(node.id);
                }

                // This is for when we set the target object to follow one of the other object tracks, like a KML track
                // we don't want two objects in the same spot.
                if (ob !== tob) {
                    if (tob.customOldVisible === undefined) {

                        // removed this assert as it was sometimes triggering on the first frame
                        // due to async issues
                        // assert (findRootTrack(node) === node.rootTrack, "findRootTrack(node) is not equal to node.rootTrack")

                        // check if they share the same root track
                        if (targetRoot && node.rootTrack === targetRoot) {

                            tob.customOldVisible = tob.visible;
                            tob.visible = false;
                            view._renderHiddenNodeIDs.add(targetObject.id);
                        }
                    }
                }
            }
        }
    }

    postRenderUpdate(view) {
        if (!Sit.isCustom) return;
        for (const entry of Object.values(NodeMan.list)) {
            const node = entry.data;
            if (node instanceof CNode3DObject) {
                restoreIfDisabled(node._object, view.camera)
            }
        }
    }


    // per-frame update code for custom sitches
    update(f) {


        UpdateHUD(""
            + "+/- - Zoom in/out<br>"
            + "C - Move Camera<br>"
            + "X - Move Target<br>"
            + "WASD - Walk in look View<br>"
            + "Shift-C - Ground Camera<br>"
            + "Shift-X - Ground Target<br>"
            + "; - Decrease Start Time<br>"
            + "' - Increase Start Time<br>"
            + "[ - Decrease Start Time+<br>"
            + "] - Increase Start Time+<br>"
            + (Globals.onMac ? "Shift/Ctrl/Opt/Cmd - speed<br>" : "Shift/Ctrl/Alt/Win - speed<br>")


        )


        // handle hold down the t key to move the terrain square around
        if (NodeMan.exists("terrainUI")) {
            const terrainUI = NodeMan.get("terrainUI")

            // only relevant if we are NOT using dynamic subdivision
            // which we most are now
            if (!Globals.dynamicSubdivision && isKeyHeld('t')) {
                const cursorPos = getCursorPositionFromTopView();
                if (cursorPos) {
                    setSitchEstablished(true);
                    const LLA = ECEFToLLAVD_radii(cursorPos);

                    if (terrainUI.lat !== LLA.x || terrainUI.lon !== LLA.y) {
                        terrainUI.lat = LLA.x
                        terrainUI.lon = LLA.y
                        terrainUI.flagForRecalculation();
                        terrainUI.tHeld = true;
                        terrainUI.startLoading = false;
                    }
                }
            } else {
                if (terrainUI.tHeld) {
                    terrainUI.tHeld = false;
                    terrainUI.startLoading = true;
                }
            }
        }
    }
}

// Merge mixin method objects into the CCustomManager prototype. Order matters
// only if two modules defined the same method name — they don't.
Object.assign(
    CCustomManager.prototype,
    setupMethods,
    subSitchMethods,
    mirrorMethods,
    menuMethods,
    serializeMethods,
);


function disableIfNearCameraTrack(node, ob, camera) {
    // Check if the camera is inside the object's bounding sphere
    let shouldHide = false;

    // Use the cached bounding sphere if available (computed when model/geometry was loaded)
    if (node.cachedBoundingSphere) {
        // Clone the cached bounding sphere (in local coordinates)
        const boundingSphere = node.cachedBoundingSphere.clone();

        // Transform to world space using the object's world matrix
        boundingSphere.applyMatrix4(ob.matrixWorld);

        // Check if camera is inside the bounding sphere
        const distToCenter = camera.position.distanceTo(boundingSphere.center);
        shouldHide = distToCenter < boundingSphere.radius;
    } else {
        // Fallback: use simple distance check if no cached bounding sphere
        const dist = ob.position.distanceTo(camera.position);
        shouldHide = dist < 1;
    }

    if (shouldHide) {
        ob.customOldVisible = ob.visible;
        ob.visible = false;
    } else {
        ob.customOldVisible = undefined;
    }
    return shouldHide;
}

function restoreIfDisabled(ob) {
    if (ob.customOldVisible !== undefined) {
        ob.visible = ob.customOldVisible;
        ob.customOldVisible = undefined;
    }
}
