/**
 * CCustomManager.setup() — main sitch setup pipeline.
 *
 * Extracted from CustomSupport.js as a mixin. Methods are merged into
 * CCustomManager.prototype so `this` references the CCustomManager instance.
 */
import {
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
import {setupHorizonExtractorMenu} from "./CHorizonExtractor";
import {setupCameraMotionMenu} from "./CameraMotionFromVideo";
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
import {DebugArrowAB, elevationAtLL} from "./threeExt";
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
import {CNodeCurveEditor2} from "./nodes/CNodeCurveEdit2";
import {CNodeViewDAG} from "./nodes/CNodeViewDAG";
import {CNodeNotes} from "./nodes/CNodeNotes";
import {createCustomModalWithCopy, saveFilePrompted, saveFileToDirectory, saveFileToHandle} from "./FileUtils";
import {deserializeMotionAnalysis, serializeMotionAnalysis} from "./CMotionAnalysisUI";
import {deserializeAutoTracking, serializeAutoTracking} from "./CObjectTracking";
import {getCursorPositionFromTopView} from "./mouseMoveView";
import {addMenuToLeftSidebar, addMenuToRightSidebar, isInLeftSidebar, isInRightSidebar} from "./PageStructure";
import {CNodeControllerCelestial, CNodeControllerHorizonFlareRegion} from "./nodes/CNodeControllerVarious";
import {CNodeAutoTrackLOS} from "./nodes/CNodeAutoTrackLOS";
import {CNodeAnnotateOverlay} from "./nodes/CNodeAnnotateOverlay";
import {CNodeVideoInfoUI} from "./nodes/CNodeVideoInfoUI";
import {CNodeOSDDataSeriesController} from "./nodes/CNodeOSDDataSeriesController";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from "./trackSourceUtils";
import {encodeShareParam, resolveURLForFetch, toShareableCustomValue} from "./SitrecObjectResolver";
import {getEnvBool} from "./envUtils";
import {CNodeFloodSim} from "./nodes/CNodeFloodSim";
import {CNodeOrbitTrack} from "./nodes/CNodeOrbitTrack";
import {CNodeTrackSwitch} from "./nodes/CNodeTrackSwitch";
import {getNearbyWeatherBalloons, haversineKm, importSoundingDialog, loadStationList} from "./SondeFetch";
import {
    WIND_SOURCES,
    isTrackSourceKey,
    trackDataIdFromSourceKey,
    windSourceByKey,
    windSourceLabelsToKeysWithTracks,
} from "./nodes/WindSources";
import {estimateWindFromConstantAirspeed} from "./WindFromConstantAirspeed";
import {getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGE_OPTIONS, t} from "./i18n";
import {CNodeSAPage} from "./nodes/CNodeSAPage";
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
import {Color} from "three";

export const setupMethods = {
    async setup() {

        // default to paused, as there's nothing to animate yet
        par.paused = true;

        // Initialize settings first (after login check)
        // this will only be done once per session
        if (!this.settingsInitialized) {
            await this.initializeSettings();
            this.settingsInitialized = true;
        }

        // Add Settings folder to Sitrec menu
        this.setupSettingsMenu();

        // Backfill newer camera smoothing controls for legacy custom sitches.
        this.upgradeCameraSmoothingControls();

        // Add celestial controller to CameraLOSController sweitch
        // switches automatically disable unselected controllers
        const cameraLOSController = NodeMan.get("CameraLOSController", false);
        if (cameraLOSController) {
            const celestialController = new CNodeControllerCelestial({
                    id: "celestialController",
                    celestialObject: "Moon",
                    camera: "lookCamera",
                });
            const lookCamera = NodeMan.get("lookCamera", false);
            lookCamera.addControllerNode(celestialController);
            cameraLOSController.addOption("Celestial Lock", celestialController);

            // "Horizon Flare Region": points at the Sun's azimuth but just above the
            // horizon (10% up), where Starlink horizon flares appear — and follows the
            // Sun along the horizon over time. Used by the "Open in Sitrec" handoff.
            const horizonFlareController = new CNodeControllerHorizonFlareRegion({
                id: "horizonFlareController",
                el: 9,
                camera: "lookCamera",
            });
            lookCamera.addControllerNode(horizonFlareController);
            cameraLOSController.addOption("Horizon Flare Region", horizonFlareController);
        }

        // Create the "Camera + Point Track" LOS adapter node and wire it into the JetLOS switch.
        // Added here (rather than in SitCustom.js) so that sitches saved before this node was
        // introduced still get it on reload. The option is always present once setup completes;
        // CNodeAutoTrackLOS.getValueFrame() falls back safely to the plain camera LOS when the
        // point tracker isn't active or video geometry isn't ready.
        // Legacy saves recorded this option under the name "Camera + Auto Track"; the
        // serialize-time migration in CustomManagerSerialize rewrites that key to the new
        // name before modDeserialize sees it.
        if (Sit.isCustom && NodeMan.exists("JetLOSCameraCenter") && NodeMan.exists("fovSwitch")
            && NodeMan.exists("video") && NodeMan.exists("JetLOS")) {
            if (!NodeMan.exists("autoTrackLOS")) {
                new CNodeAutoTrackLOS({
                    id: "autoTrackLOS",
                    videoView: "video",
                    cameraLOSNode: "JetLOSCameraCenter",
                    fovNode: "fovSwitch",
                });
            }
            const jetLOS = NodeMan.get("JetLOS");
            const autoTrackLOS = NodeMan.get("autoTrackLOS");
            const autoTrackOptionName = "Camera + Point Track";
            if (jetLOS.inputs[autoTrackOptionName] === undefined) {
                jetLOS.addOption(autoTrackOptionName, autoTrackLOS);
                jetLOS.controller?.updateDisplay();
            }
        }

        // Create the Annotate overlay on the video view. It's hidden / no-op until the
        // user enables it from the View > Annotate menu, so creating it unconditionally
        // for any custom sitch with a video is harmless. Added here (not in SitCustom.js)
        // so older saves get it on reload — strokes are restored via modDeserialize.
        if (Sit.isCustom && NodeMan.exists("video") && !NodeMan.exists("annotateOverlay")) {
            new CNodeAnnotateOverlay({
                id: "annotateOverlay",
                overlayView: "video",
            });
        }

        // When the PTZ controller is disabled (i.e. another angles source like a track
        // is driving the camera), sync the PTZ az/el/roll from the resulting camera orientation.
        // This way switching back to Manual PTZ preserves the current view.
        const ptzController = NodeMan.get("ptzAngles", false);
        const lookCamera = NodeMan.get("lookCamera", false);
        if (lookCamera && ptzController) {
            lookCamera.postApplyControllers = () => {
                if (!ptzController.enabled && !Globals.deserializing) {
                    // When "Roll View with Bank" is on, CameraBankRollController
                    // is actively writing ptz.roll = -bankAngle each frame so
                    // trackToTrackController can pick it up on the next pass.
                    // syncFromCamera would extract whatever roll the camera
                    // currently has (set by *last* frame's ptz.roll) and write
                    // it back over our value — silently undoing the bank write
                    // every frame and pinning the slider at a stale value.
                    // Skip the sync while bank-roll is on so our write persists.
                    const bankRollOn = NodeMan.list.lookCameraBankRoll?.data?.value;
                    if (bankRollOn) return;
                    ptzController.syncFromCamera(lookCamera.camera);
                }
            };

            // Camera Heading: "To Target" -> "Use Angles" should preserve the
            // current camera orientation, mirroring how syncModeTransition
            // preserves orientation when toggling PTZ Satellite mode. The
            // per-frame sync in postApplyControllers above keeps ptz angles
            // warm while "To Target" drives the camera, but that's not enough
            // on its own: between the last "To Target" frame and the first
            // "Use Angles" frame the camera *position* can shift (any moving
            // track), which makes the previous-frame's az/el slightly wrong
            // against the new local frame. Capture orientation at the moment
            // of switch so the transition is exact in both normal and
            // satellite (near-vertical) cases — syncFromCamera handles both.
            // Use choiceChanged (not onChange) so the same fix-up also fires
            // for programmatic switches (e.g. TrackManager auto-selecting).
            EventManager.addEventListener("Switch.choiceChanged.CameraLOSController", (choice) => {
                if (choice !== "Use Angles") return;
                if (Globals.deserializing) return;
                lookCamera.camera.updateMatrixWorld();
                ptzController.syncFromCamera(lookCamera.camera);
                ptzController.refresh();
                setRenderOne(true);
            });
        }

        // if (Sit.canMod) {
        //     // we have "SAVE MOD", but "SAVE CUSTOM" is no more, replaced by standard "Save", "Save As", etc.
        //     this.buttonText = "SAVE MOD"
        //
        //     // add a lil-gui button linked ot the serialize function
        //     //FileManager.guiFolder.add(this, "serialize").name("Export Custom Sitch")
        //
        //     const theGUI = guiMenus.file;
        //
        //     this.buttonColor = "#80ff80"
        //
        //     if (getEffectiveUserID() > 0)
        //         this.serializeButton = theGUI.add(this, "serializeMod").name(this.buttonText).setLabelColor(this.buttonColor)
        //     else
        //         this.serializeButton = theGUI.add(this, "loginAttempt").name("Export Disabled (click to log in)").setLabelColor("#FF8080");
        //
        //     this.serializeButton.moveToFirst();
        // }

        // Sounding-loader state — folded into the Wind Data folder below.
        // `balloonCount` name kept for backward compat with saved par state.
        // Default 3 so 3-nearest IDW has enough samples to be meaningful.
        par.balloonCount = 3;
        // Wrap the dialog so a successful import switches the wind source
        // to "Manual Soundings" — that source pulls from any loaded
        // CNodeAtmosphericProfile regardless of origin, so the just-
        // imported station immediately participates in the IDW field.
        // (Cancel / failure paths return false from the dialog and leave
        // the current source alone.)
        this._importSounding = async () => {
            const ok = await importSoundingDialog();
            if (!ok || !this._windNode) return;
            if (this._windNode.source !== "manual-soundings") {
                // setValue("manual-soundings") on the source dropdown
                // fires onTargetSourceChange (which mirrors to local in
                // shared mode and runs the load pipeline).
                if (this._windSourceCtrl) {
                    this._windSourceCtrl.setValue("manual-soundings");
                } else {
                    this._windNode.source = "manual-soundings";
                }
            } else {
                // Already on Manual Soundings — rebuild the IDW grid so
                // the new profile is included.
                this._windNode.fetchWindForAltitude(this._windNode.windAltFt);
            }
        };

        // ── Wind Visualization subfolder under Physics ──────────────
        this._windNode = null;

        // Source labels ↔ internal source keys — single source of truth in
        // src/nodes/WindSources.js. UWYO/IGRA2 auto-fetch nearby soundings
        // if none of that source are loaded; Manual Soundings uses whatever
        // the user has dropped in. Track-bearing-wind MISB tracks add a
        // "Track: <shortName>" entry to this map, refreshed on every
        // tracksChanged event from TrackManager.
        this._windSourceOptions = windSourceLabelsToKeysWithTracks();

        // par now holds only state that doesn't belong to the wind node:
        //   windStatus  — short status string for the disabled GUI display
        //   balloonCount — sounding-loader knob (consumed by
        //                  getNearbyWeatherBalloons, not the wind node)
        // Everything wind-related (source, sourceLocal, sourceSeparate,
        // windAltFt, lineOpacity, seedSpacing, maxWindSpeed, nearbyOnly,
        // nearbyRadiusKm, showArrows, inspect, lockAltitudeTo, inspectPoints)
        // now lives on this._windNode and the GUI binds straight to those
        // fields. The dropdowns use lil-gui's options-object form so the
        // node stores the internal key while the GUI shows labels.
        par.windStatus = "Not loaded";

        // Track which sources we've already auto-shown wind for, so the
        // "first switch to GFS/sounding turns on Show Wind" rule fires once
        // per source per session — and never again if the user later toggles
        // wind off explicitly.
        this._autoShownWindSources = new Set();

        // Eagerly create the wind node so the GUI can bind directly to its
        // fields. Constructor is cheap (one ShaderMaterial; no network),
        // and visibility / streamlines are off by default so this is
        // invisible to the user until a non-Manual source is picked.
        // modDeserialize will restore the saved state on reload.
        if (NodeMan.exists("windField")) {
            this._windNode = NodeMan.get("windField");
        } else {
            // Default source = "manual" — no fetch, no streamlines until
            // the user picks something else from the dropdown.
            this._windNode = NodeFactory.create("DisplayWindField", {
                id: "windField",
                source: "manual",
                sourceLocal: "manual",
            });
            // Streamline mesh starts off; group stays visible so the
            // arrow grid + inspect arrows can render independently when
            // the user enables them. The Show/Hide menu's "Wind Field"
            // entry remains the master toggle for the whole group.
            this._windNode.linesVisible = false;
        }
        // Local alias so the rest of the wind setup can read wn.* without
        // repeating this._windNode. Declared up here so source dropdowns
        // (which reference it directly) and slider onChange handlers
        // (which close over it) all see it without a TDZ.
        const wn = this._windNode;

        // par.windShow drives the Wind folder's "Show Wind Lines" checkbox
        // and binds the streamline-mesh visibility only — NOT the whole
        // group. Hiding the lines must leave the screen-grid arrow overlay
        // and Inspect Wind readouts intact. The Show/Hide menu's master
        // "Wind Field" entry binds to wn.visible, which is independent.
        Object.defineProperty(par, "windShow", {
            configurable: true,
            enumerable: true,
            get: () => !!this._windNode.linesVisible,
            set: (v) => {
                const wn = this._windNode;
                wn.linesVisible = !!v;
                if (wn.linesMesh) wn.linesMesh.visible = !!v;
                // Bring the master back if the user is turning lines on
                // from a fully-hidden state — otherwise the toggle would
                // appear to do nothing.
                if (v && !wn.visible) {
                    wn.show(true);
                }
                setRenderOne(true);
            },
        });

        // The folder shell is created once at app init (in index.js
        // initializeOnce); only its non-permanent contents get rebuilt here
        // each sitch load.
        const windFolder = guiMenus.wind;

        // Auto-load nearby soundings when a source declares autoLoad and no
        // matching profiles exist yet. Returns true on success, false on
        // fatal failure (caller surfaces the real reason instead of a
        // misleading "No profiles loaded" later).
        this._ensureSoundingsForWind = async (sourceKey) => {
            const src = windSourceByKey(sourceKey);
            const autoKey = src?.autoLoad;
            if (!autoKey) return true;
            // If a refresh-driven relocation is mid-flight (profiles temp-
            // disposed before the new fetch lands), don't probe `have` —
            // we'd see false and kick off our own getNearbyWeatherBalloons,
            // racing the relocate's. Wait for relocation to settle, then
            // re-probe; the new profiles will satisfy `have` and we skip
            // the redundant fetch.
            if (this._relocatingSoundings) {
                try { await this._relocatingSoundings; } catch { /* swallow */ }
            }
            let have = false;
            NodeMan.iterate((id, n) => {
                if (n && n.constructor?.name === "CNodeAtmosphericProfile"
                    && n.source === autoKey) have = true;
            });
            if (have) return true;
            par.windStatus = `Loading ${src.short} soundings...`;
            try {
                const results = await getNearbyWeatherBalloons(par.balloonCount, autoKey);
                const ok = Array.isArray(results) && results.some(r => r && r.success);
                if (!ok) {
                    const firstErr = Array.isArray(results)
                        ? (results.find(r => r && r.error)?.error ?? "no soundings returned")
                        : "no soundings returned";
                    par.windStatus = `${src.short} fetch failed: ${firstErr}`;
                    return false;
                }
                return true;
            } catch (e) {
                console.error(`${autoKey} auto-fetch threw:`, e);
                par.windStatus = `${src.short} fetch failed: ${e.message}`;
                return false;
            }
        };

        // Lazily create the wind node and load data for the current source.
        // Source changes and the first Show Wind toggle both go through here.
        //
        // Concurrent callers (e.g. rapid Show / Show Arrows / Inspect toggles
        // before the first fetch finishes) all await the same in-flight
        // promise — without this, each one would overwrite par.windStatus
        // and re-fire _ensureSoundingsForWind, producing flicker and
        // redundant work.
        //
        // Source change mid-flight: the node's source field is assigned
        // unconditionally, and a fetchWindForAltitude call is forwarded so
        // the wind node's _pendingSource coalescer notices the change and
        // re-runs after the in-flight settles. The original in-flight
        // promise's `await fetchWindForAltitude(...)` chains through the
        // re-run, so our promise still resolves only after the new source
        // has actually loaded.
        this._loadWindForCurrentSource = () => {
            // wn.source is the live internal key — set by the dropdown
            // bind directly. The inner coalescer in fetchWindForAltitude
            // re-reads this.source if it changes mid-flight, so we just
            // hand it the current value.
            const sourceKey = this._windNode.source;

            if (this._windLoadInFlight) {
                // Forward to fetchWindForAltitude so its _pendingSource /
                // _pendingAltFt coalescer picks up any change since the
                // current flight started.
                //
                // Two cases the forwarded promise covers:
                //   1. The in-flight is mid-fetch (fetching=true): the
                //      forwarded call sets _pendingAltFt/_pendingSource
                //      and returns immediately. The in-flight's tail
                //      handles the recursion to load the new source.
                //   2. The in-flight failed before reaching its fetch
                //      (e.g. _ensureSoundingsForWind returned false):
                //      fetching=false, so the forwarded call kicks off
                //      a real fetch for the new source.
                //
                // We allSettled both so par.windStatus syncs to the wind
                // node's current statusText after everything finishes —
                // otherwise case 2 leaves par.windStatus pinned to the
                // failure reason for the OLD source.
                const fwd = this._windNode.fetchWindForAltitude(this._windNode.windAltFt);
                return Promise.allSettled([this._windLoadInFlight, fwd])
                    .then(() => {
                        if (this._windNode) par.windStatus = this._windNode.statusText;
                    });
            }

            this._windLoadInFlight = (async () => {
                par.windStatus = "Loading...";
                const ok = await this._ensureSoundingsForWind(sourceKey);
                if (!ok) return; // status already set with the real failure reason
                await this._windNode.fetchWindForAltitude(this._windNode.windAltFt);
                par.windStatus = this._windNode.statusText;
            })().finally(() => {
                this._windLoadInFlight = null;
            });
            return this._windLoadInFlight;
        };

        // ── Source selectors ──────────────────────────────────────────
        //
        // Default mode (this._windNode.sourceSeparate === false): a single
        // "Wind Source" dropdown drives both target and local wind.
        // Separate mode (this._windNode.sourceSeparate === true): two dropdowns
        // — "Target Wind Source" + "Local Wind Source" — operate
        // independently. Toggling separate→shared snaps the local
        // selection back to the target's value.
        //
        // The "Lock Target Wind to Local" toggle is a different concept
        // entirely: it mirrors the *manual* From/Knots values between
        // the two wind nodes. Source selection is per-pipeline; manual
        // value mirroring is per-field.
        //
        // Both dropdowns share the same option set, which is rebuilt
        // whenever TrackManager fires tracksChanged so MISB tracks with
        // wind columns can come and go as the user imports / removes
        // them. .listen() keeps the dropdowns synced when restored from
        // a save.

        // Resolve a track-derived sourceKey to its TrackData id, or
        // null for non-track sources.
        const resolveTrackSource = (sourceKey) => isTrackSourceKey(sourceKey)
            ? trackDataIdFromSourceKey(sourceKey)
            : null;

        // Apply a sourceKey to the localWind node's trackSource override.
        // For non-track sources, trackSource is null (the windField grid
        // sample becomes the source).
        const applyLocalSource = (sourceKey) => {
            const localWind = NodeMan.exists("localWind")
                ? NodeMan.get("localWind") : null;
            if (!localWind) return;
            localWind.trackSource = resolveTrackSource(sourceKey);
        };

        // Target source onChange. Drives targetWind's trackSource override
        // (for track sources) or the windField fetch pipeline (for
        // atmospheric / manual). In shared mode, mirrors the selection
        // onto wn.sourceLocal + localWind synchronously up-front so a
        // toggled-Separate mid-fetch can't expose a stale local value.
        const onTargetSourceChange = async () => {
            const sourceKey = wn.source;
            const targetWind = NodeMan.exists("targetWind")
                ? NodeMan.get("targetWind") : null;

            // Synchronous local mirror first.
            if (!wn.sourceSeparate) {
                wn.sourceLocal = sourceKey;
                applyLocalSource(sourceKey);
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.updateDisplay();
            }

            const tdId = resolveTrackSource(sourceKey);
            if (tdId) {
                // Track-driven: targetWind reads its from/knots from the
                // track per frame. The wind field also fetches so the
                // global grid reflects this single source — picking a
                // sonde track means "show me what this station reports,"
                // not "leave the previous field intact." Falls through
                // to the fetch pipeline below.
                if (targetWind) targetWind.trackSource = tdId;
            } else {
                if (targetWind) targetWind.trackSource = null;
            }
            // atmospheric / manual / track: auto-show + fetch pipeline.
            const autoShowSources = ["gfs", "uwyo", "igra2", "manual-soundings"];
            const isTrack = !!tdId;
            if ((autoShowSources.includes(sourceKey) || isTrack)
                && !this._autoShownWindSources.has(sourceKey)
                && !par.windShow) {
                par.windShow = true;
            }
            if (autoShowSources.includes(sourceKey) || isTrack) {
                this._autoShownWindSources.add(sourceKey);
            }
            await this._loadWindForCurrentSource();
        };

        // Local source onChange. Only meaningful in separate mode; in
        // shared mode the local source mirrors the target by way of
        // onTargetSourceChange and the local dropdown is hidden anyway.
        //
        // Limitation in separate mode: when target=A and local=B are
        // *different atmospheric* sources, only A fetches via
        // _loadWindForCurrentSource. Local ends up sampling that grid
        // at the local position — fine if A and B happen to be the same
        // source, off otherwise. A truly independent local fetch would
        // need a second windField pipeline; not implemented yet.
        const onLocalSourceChange = () => {
            if (!wn.sourceSeparate) return;
            applyLocalSource(wn.sourceLocal);
        };

        // Toggle Separate Wind Sources: change the target dropdown's
        // label, show/hide the local dropdown, and on
        // shared→separate→shared cycles snap the local source back to
        // the target so the two pipelines don't drift out of sync
        // silently.
        const onSeparateChange = () => {
            if (wn.sourceSeparate) {
                if (this._windSourceCtrl) this._windSourceCtrl.name("Target Wind Source");
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.show();
            } else {
                if (this._windSourceCtrl) this._windSourceCtrl.name("Wind Source");
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.hide();
                wn.sourceLocal = wn.source;
                applyLocalSource(wn.source);
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.updateDisplay();
            }
        };

        // Both dropdowns bind directly to wind-node fields (wn.source /
        // wn.sourceLocal). lil-gui's options-object form makes the GUI
        // show LABELS while writing the internal KEY into the bound
        // field — so the node holds the key, no par-side display proxy
        // is needed. .listen() syncs the dropdown when the node is
        // restored from save.
        this._windSourceCtrl = windFolder.add(wn, "source", this._windSourceOptions)
            .name(wn.sourceSeparate ? "Target Wind Source" : "Wind Source")
            .listen()
            .onChange(onTargetSourceChange);

        // Separate toggle, placed right under the target dropdown so
        // its scope is visually obvious.
        windFolder.add(wn, "sourceSeparate")
            .name("Separate Wind Sources")
            .listen()
            .onChange(onSeparateChange);

        this._windSourceLocalCtrl = windFolder.add(wn, "sourceLocal", this._windSourceOptions)
            .name("Local Wind Source")
            .listen()
            .onChange(onLocalSourceChange);
        if (!wn.sourceSeparate) this._windSourceLocalCtrl.hide();

        // tracksChanged listener — rebuilds both dropdowns in place
        // when the imported-track set changes. lil-gui's controller.options
        // destroys + creates a new controller, so name/listen/onChange and
        // any visibility (hidden in shared mode) must be re-applied.
        const refreshSourceCtrls = () => {
            const tracks = (TrackManager && typeof TrackManager.tracksWithWind === "function")
                ? TrackManager.tracksWithWind() : [];
            this._windSourceOptions = windSourceLabelsToKeysWithTracks(tracks);
            const validKeys = Object.values(this._windSourceOptions);
            const reattach = (ctrlField, prop, label, handler) => {
                const old = this[ctrlField];
                if (!old) return;
                // If the previously-selected key is no longer valid (e.g.
                // its track was removed), fall back to the manual key.
                if (!validKeys.includes(wn[prop])) wn[prop] = "manual";
                this[ctrlField] = old.options(this._windSourceOptions)
                    .name(label)
                    .listen()
                    .onChange(handler);
                // setValueQuietly: don't fire onChange. This refresh fires
                // when tracksChanged dispatches (e.g. mid-sitch-load when
                // imported tracks finish loading). A regular .setValue here
                // would invoke onTargetSourceChange → fetchWindForAltitude
                // → _fillFromManual against targetWind's *constructor*
                // defaults rather than its modDeserialize-restored values,
                // baking a stale wind grid into the field. Trackbacks via
                // _reconcileWindTrackSources in finishDeserialization push
                // through any actual source change once everything's
                // settled.
                this[ctrlField].setValueQuietly(wn[prop]);
            };
            reattach("_windSourceCtrl", "source",
                wn.sourceSeparate ? "Target Wind Source" : "Wind Source",
                onTargetSourceChange);
            reattach("_windSourceLocalCtrl", "sourceLocal",
                "Local Wind Source",
                onLocalSourceChange);
            if (!wn.sourceSeparate && this._windSourceLocalCtrl) {
                this._windSourceLocalCtrl.hide();
            }
            // Reattach's setValue on the local controller fires
            // onLocalSourceChange, which early-returns in shared mode —
            // so localWind.trackSource doesn't get cleared when the
            // track behind the previous local selection is removed.
            // Force-sync here.
            applyLocalSource(wn.sourceLocal);
        };
        // Setup runs once per sitch load; remove the previous binding
        // before re-registering so reloads don't accumulate listeners.
        if (this._tracksChangedListener) {
            EventManager.removeEventListener?.("tracksChanged", this._tracksChangedListener);
        }
        this._tracksChangedListener = refreshSourceCtrls;
        EventManager.addEventListener("tracksChanged", refreshSourceCtrls);

        // Save-restore reconciliation. modDeserialize writes wn.source /
        // wn.sourceLocal as plain field assignments — .listen() refreshes the
        // dropdown DISPLAY but does NOT fire the onChange handler that
        // normally pushes through to targetWind.trackSource / localWind.
        // trackSource. finishDeserialization invokes this hook AFTER both
        // SituationSetup (which creates the *Wind nodes) and modDeserialize
        // have run, so the restored source keys actually take effect.
        this._reconcileWindTrackSources = () => {
            const targetWind = NodeMan.exists("targetWind")
                ? NodeMan.get("targetWind") : null;
            const effectiveLocalKey = wn.sourceSeparate ? wn.sourceLocal : wn.source;
            if (targetWind) targetWind.trackSource = resolveTrackSource(wn.source);
            applyLocalSource(effectiveLocalKey);
        };

        // Display altitude in feet. Target/local winds use their own track
        // altitudes, independent of this.
        // .listen() so the slider tracks this._windNode.windAltFt when restored from save.
        // Two handlers:
        //  - onChange: live re-blend + streamline rebuild while dragging IF
        //    Nearby Wind Only is on AND the needed levels are already cached.
        //    Cuts perceived latency on altitude scrubbing to one frame.
        //  - onFinishChange: full fetch (handles uncached levels via network)
        //    when the user commits the value.
        // (wn alias for this._windNode is declared above, after node creation.)

        // Display altitude in feet. GUI binds directly to wn.windAltFt;
        // .listen() picks up modDeserialize-restored values without a
        // post-deserialize sync step.
        windFolder.add(wn, "windAltFt", 0, 60000, 10).name("Altitude (ft)").listen()
            .onChange(() => {
                // Lock-altitude wins: the wind node's update() will
                // overwrite windAltFt next frame from the locked track.
                // Skip the fetch we'd otherwise queue on slider input —
                // it'd just be immediately undone, wasting a network
                // round-trip on uncached GFS brackets.
                if (wn.lockAltitudeTo !== "none") return;
                if (!wn.nearbyOnly) return;
                // Allow live updates only when the source's hot path is
                // local (no network on the drag tick).
                const localSources = ["uwyo", "igra2", "manual-soundings", "manual"];
                const isLocal = localSources.includes(wn.source)
                    || (wn.source === "gfs" && wn.hasGFSBracketCached(wn.windAltFt));
                if (!isLocal) return;
                wn.fetchWindForAltitude(wn.windAltFt);
            })
            .onFinishChange(async () => {
                if (wn.lockAltitudeTo !== "none") return;
                par.windStatus = "Loading...";
                await wn.fetchWindForAltitude(wn.windAltFt);
                par.windStatus = wn.statusText;
            });

        // Lock Altitude: drive windAltFt from the camera or target track
        // every frame. The options-as-object form keeps the GUI labels
        // capitalized while the node holds the lowercase internal value.
        windFolder.add(wn, "lockAltitudeTo",
            { None: "none", Camera: "camera", Target: "target" })
            .name("Lock Altitude to").listen();

        // Nearby Wind Only: clip streamline seeding to a radius around
        // the sitch origin. With this on, altitude scrubbing is near-
        // instant.
        windFolder.add(wn, "nearbyOnly").name("Nearby Wind Only").listen()
            .onChange(() => { wn.rebuildStreamlines(); setRenderOne(true); });

        windFolder.add(wn, "nearbyRadiusKm", 5, 500, 5)
            .name("Nearby Radius (km)").listen()
            .onChange(() => {
                if (wn.nearbyOnly) {
                    wn.rebuildStreamlines();
                    setRenderOne(true);
                }
            });

        // Show Wind Lines checkbox. The par.windShow setter already flips
        // wn.linesVisible + wn.linesMesh.visible — onChange just kicks off
        // the data load when streamlines are turned on for the first time
        // (no windU yet). A previous failed load (windU still null) gets
        // retried automatically here instead of showing nothing forever.
        // Same retry path also covers the case where windU exists but the
        // last rebuildStreamlines produced empty geometry (e.g. it ran on
        // 0-knot stale wind values), so linesMesh is null — the setter
        // would otherwise no-op forever.
        windFolder.add(par, "windShow").name("Show Wind Lines").listen().onChange(async (v) => {
            if (v && (!wn.windU || !wn.linesMesh)) {
                await this._loadWindForCurrentSource();
                setRenderOne(true);
            }
        });

        // Show Wind Arrows: render a 200 px screen-space grid of wind arrows
        // in the main view, ray-cast onto the ellipsoid at the current wind
        // altitude. Independent of the streamline mesh — either or both can
        // be on.
        windFolder.add(wn, "showArrows").name("Show Wind Arrows").listen()
            .onChange(async (v) => {
                if (v && !wn.windU) {
                    await this._loadWindForCurrentSource();
                }
                setRenderOne(true);
            });

        // Inspect Wind: cursor-driven readout. Single arrow at the cursor's
        // ellipsoid intersection plus a floating panel with speed (display
        // units) and FROM heading (compass + degrees).
        windFolder.add(wn, "inspect").name("Inspect Wind").listen()
            .onChange(async (v) => {
                if (v && !wn.windU) {
                    await this._loadWindForCurrentSource();
                }
                wn.setInspect(!!v);
                setRenderOne(true);
            });

        // Status display
        this._windStatusCtrl = windFolder.add(par, "windStatus").name("Status").listen().disable();

        windFolder.add(wn, "lineOpacity", 0, 1, 0.01).name("Opacity")
            .onChange(() => {
                wn.material.uniforms.uOpacity.value = wn.lineOpacity;
                setRenderOne(true);
            });

        windFolder.add(wn, "seedSpacing", 1.5, 10, 0.5).name("Spacing (\u00b0)")
            .onChange(() => { wn.rebuildStreamlines(); setRenderOne(true); });

        windFolder.add(wn, "maxWindSpeed", 5, 80, 1).name("Max Speed (m/s)")
            .onChange(() => {
                wn.material.uniforms.uMaxSpeed.value = wn.maxWindSpeed;
                setRenderOne(true);
            });

        // For sounding sources (uwyo/igra2): if the camera has moved
        // since soundings were originally loaded, the once-nearest stations
        // may no longer be a good IDW basis. Detect drift and swap in the
        // new nearest stations so refresh actually freshens what the user
        // sees, not just re-runs the IDW build over stale far-away data.
        //
        // Returns true if soundings were relocated. The single-flight guard
        // (_relocatingSoundings) keeps a double-clicked refresh from
        // disposing the same tracks twice and double-fetching from UWYO.
        this._maybeRelocateSoundings = async (source) => {
            if (source !== "uwyo" && source !== "igra2") return false;
            if (this._relocatingSoundings) return this._relocatingSoundings;

            this._relocatingSoundings = (async () => {
                // Camera position — same fallback chain as getNearbyWeatherBalloons
                // so the "current" position matches what the auto-load uses.
                let camLat, camLon;
                try {
                    const lookCamera = NodeMan.get("lookCamera").camera;
                    const lla = ECEFToLLAVD_radii(lookCamera.position);
                    camLat = lla.x;
                    camLon = lla.y;
                } catch {
                    return false;
                }

                // Loaded profiles for this source that have a station coord.
                // Profiles missing coords can't participate in the proximity
                // comparison, but we still want to nuke their tracks if
                // relocation runs (they're stale by the same logic).
                const loaded = [];
                NodeMan.iterate((id, node) => {
                    if (node?.constructor?.name === "CNodeAtmosphericProfile"
                        && node.source === source
                        && node.stationLat != null && node.stationLon != null) {
                        loaded.push(node);
                    }
                });
                if (loaded.length === 0) return false;

                const wantedN = Math.max(1, Math.min(par.balloonCount ?? 3, 10));

                // Sort all stations by current proximity. Filter to
                // currently-active stations using the sitch year (matches
                // the same year gate getNearbyWeatherBalloons applies —
                // keeps decommissioned stations out of the "nearest" pool).
                let stations;
                try {
                    stations = await loadStationList();
                } catch {
                    return false;
                }
                if (!Array.isArray(stations) || stations.length === 0) return false;
                let targetYear;
                try {
                    targetYear = GlobalDateTimeNode.frameToDate(0).getUTCFullYear();
                } catch {
                    targetYear = new Date().getUTCFullYear();
                }
                const sorted = stations
                    .filter(s => s.wmo && s.lastYear >= targetYear)
                    .map(s => ({...s, dist: haversineKm(camLat, camLon, s.lat, s.lon)}))
                    .sort((a, b) => a.dist - b.dist);
                if (sorted.length === 0) return false;

                const optimalMaxDist = sorted[Math.min(wantedN, sorted.length) - 1].dist;
                const loadedDists = loaded.map(p =>
                    haversineKm(camLat, camLon, p.stationLat, p.stationLon));
                const maxLoadedDist = Math.max(...loadedDists);

                // Reload triggers when:
                //   - Loaded count differs from the requested count (user
                //     changed balloonCount in either direction, or some
                //     loads previously failed), OR
                //   - The farthest loaded station is significantly farther
                //     than the farthest of the current N nearest. The 1.5× +
                //     50 km clause keeps small jitters from triggering reloads
                //     on slow-moving tracks; the 100 km absolute-difference
                //     clause catches sitch-origin changes that cross
                //     continents but happen to keep the same proportional ratio.
                const drifted = maxLoadedDist > optimalMaxDist * 1.5 + 50
                    || (maxLoadedDist - optimalMaxDist) > 100;
                if (loaded.length === wantedN && !drifted) return false;

                par.windStatus = `Soundings: relocating to ${wantedN} nearest…`;

                // TrackManager.disposeRemove cascades through CMetaTrack.dispose
                // which now cleans up the full sonde cluster (atmosphericProfile,
                // _windArrows, colorData_*, colorTrack_*) — no hand-cleanup
                // needed here.
                const profileSet = new Set(loaded);
                const trackIdsToRemove = [];
                TrackManager.iterate((trackID, trackOb) => {
                    if (trackOb?.atmosphericProfile
                        && profileSet.has(trackOb.atmosphericProfile)) {
                        trackIdsToRemove.push(trackID);
                    }
                });
                for (const trackID of trackIdsToRemove) {
                    TrackManager.disposeRemove(trackID);
                }

                try {
                    await getNearbyWeatherBalloons(wantedN, source);
                } catch (e) {
                    console.warn("Sounding relocation fetch failed:", e?.message ?? e);
                }
                return true;
            })().finally(() => {
                this._relocatingSoundings = null;
            });
            return this._relocatingSoundings;
        };

        const refresh = async () => {
            if (!this._windNode) return;
            // Drop every per-source cache the wind node owns so the next
            // fetch actually hits the network (or the IDW pipeline) again.
            //   GFS:        FileManager entries + _levelCache (via _evictAllWindGrids)
            //   open-meteo: _omCache
            //   uwyo/igra2: relocate to current N nearest if drifted; the
            //               IDW rebuild inside fetchWindForAltitude does the rest.
            this._windNode._evictAllWindGrids();
            if (this._windNode._omCache) this._windNode._omCache.clear();
            par.windStatus = "Loading...";
            await this._maybeRelocateSoundings(this._windNode.source);
            await this._windNode.fetchWindForAltitude(this._windNode.windAltFt);
            par.windStatus = this._windNode.statusText;
        };
        windFolder.add({refresh}, "refresh").name("Refresh Wind Data");

        // Fit local wind from a constant-airspeed camera assumption. Solves
        // for the single horizontal wind vector that minimizes airspeed
        // standard deviation across the track, then writes it into
        // localWind.from/knots. Switches the local source to "manual" so the
        // fit actually takes effect — track/atmospheric sources would
        // otherwise overwrite from/knots each frame.
        const fitLocalFromConstantCamera = () => {
            const localWind = NodeMan.exists("localWind") ? NodeMan.get("localWind") : null;
            if (!localWind) {
                par.windStatus = "Fit failed: no localWind node";
                return;
            }
            // Order: prefer the smoothed switch in the custom sitch (noise
            // suppression sharpens the fit), then the raw switch, then the
            // legacy single-purpose ids used by SitGimbal / SitAguadilla.
            let track = null;
            let trackId = null;
            for (const id of ["cameraTrackSwitchSmooth", "cameraTrackSwitch", "jetTrack", "cameraTrack"]) {
                if (NodeMan.exists(id)) {
                    const cand = NodeMan.get(id);
                    if (cand && typeof cand.p === "function") {
                        track = cand;
                        trackId = id;
                        break;
                    }
                }
            }
            if (!track) {
                par.windStatus = "Fit failed: no camera track";
                return;
            }

            par.windStatus = "Fitting wind…";
            const result = estimateWindFromConstantAirspeed(track);
            if (!result) {
                par.windStatus = "Fit failed: not enough samples";
                return;
            }

            // Flip the local source to manual so the new from/knots stick.
            // In shared mode (sourceSeparate=false) the source field drives
            // both pipelines, so we change wn.source; in separate mode we
            // only touch wn.sourceLocal.
            if (wn.sourceSeparate) {
                wn.sourceLocal = "manual";
                localWind.trackSource = null;
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.updateDisplay();
            } else {
                wn.source = "manual";
                wn.sourceLocal = "manual";
                localWind.trackSource = null;
                if (NodeMan.exists("targetWind")) {
                    NodeMan.get("targetWind").trackSource = null;
                }
                if (this._windSourceCtrl) this._windSourceCtrl.updateDisplay();
                if (this._windSourceLocalCtrl) this._windSourceLocalCtrl.updateDisplay();
            }

            localWind.from = Math.round(result.from);
            localWind.knots = Math.round(result.knots);
            if (localWind.guiFrom) localWind.guiFrom.updateDisplay();
            if (localWind.guiKnots) localWind.guiKnots.updateDisplay();
            localWind.recalculateCascade();

            // Rebuild the wind grid from the new manual values, matching the
            // behavior of CNodeWind's onManualWindEdit closure.
            if (NodeMan.exists("windField")) {
                const wf = NodeMan.get("windField");
                if (wf.source === "manual" && wf.windU) {
                    wf.fetchWindForAltitude(wf.windAltFt);
                }
            }

            par.windStatus = `Local wind: ${localWind.from}° / ${localWind.knots} kt (σ=${result.finalCostKnots.toFixed(1)} kt, ${trackId})`;
        };
        windFolder.add({fitLocalFromConstantCamera}, "fitLocalFromConstantCamera")
            .name("Local from Constant Camera");

        // ── Sounding-loader controls (used by UWYO/IGRA2 sources) ──
        // `balloonCount` drives how many nearby soundings auto-load. Manual
        // Soundings ignores this; GFS/open-meteo/Manual don't use soundings.
        windFolder.add(par, "balloonCount", 1, 10, 1).name("Sounding Count")
            .tooltip(t("custom.balloons.count.tooltip"));
        windFolder.add(this, "_importSounding").name(t("custom.balloons.importSounding.label"))
            .tooltip(t("custom.balloons.importSounding.tooltip"));
        // ── end Wind ────────────────────────────────────────────────

        // ── SA Page — checkbox under Show/Hide > Views ─────────
        // If showSAPage was saved, create the SA page now (after tracks are loaded)
        if (Sit.showSAPage && !NodeMan.exists("SAPage")) {
            this._createSAPage();
        }
        // Backing field + reactive getter so the checkbox reflects the live SAPage
        // visibility even when the SAPage is created later (e.g. by handleGimbalSetup
        // which runs after CustomManager.setup).
        //
        // The setter MUST also push to the live view's visibility.  lil-gui's
        // setValue() writes the property, then fires onChange with getValue().
        // If the setter only updates the backing field, the getter still
        // returns the stale sa.visible, so onChange receives the old value
        // and every toggle is a no-op.
        this.__showSAPage = NodeMan.exists("SAPage");
        Object.defineProperty(this, "_showSAPage", {
            configurable: true,
            get: () => {
                const sa = ViewMan.get("SAPage", false);
                if (sa) return !!sa.visible;
                return this.__showSAPage;
            },
            set: (v) => {
                this.__showSAPage = v;
                const sa = ViewMan.get("SAPage", false);
                if (sa) sa.setVisible(v);
            },
        });
        guiShowHideViews.add(this, "_showSAPage").name("SA Page").onChange((value) => {
            if (value && !NodeMan.exists("SAPage")) {
                this._createSAPage();
                const sa = ViewMan.get("SAPage", false);
                if (sa) sa.setVisible(true);
            }
            Sit.showSAPage = value; // persist for serialization
            setRenderOne(true);
        }).listen();
        // ── end SA Page ─────────────────────────────────────────

        // ── ATFLIR Pod — requires reload ────────────────────────
        if (!Sit.showATFLIR && !Sit.jetStuff) {
            this._addATFLIR = () => {
                Sit.showATFLIR = true;
                Sit.jetStuff = true;
                if (!Sit.files) Sit.files = {};
                if (!Sit.files.ATFLIRModel) Sit.files.ATFLIRModel = 'models/ATFLIR.glb';
                if (!Sit.files.FA18Model)   Sit.files.FA18Model   = 'models/FA-18F.glb';
                if (!Sit.lookCamera) Sit.lookCamera = {fov: 0.35};
                if (!Sit.lookView) Sit.lookView = {
                    left: 0.6656, top: 1 - 0.3333, width: -1, height: 0.333,
                    draggable: true, resizable: true, freeAspect: false, noOrbitControls: true,
                };
                this.serialize("Custom", getDateTimeFilename()).then(() => {
                    window.location.reload();
                });
            };
            guiMenus.gimbalAnalysis.add(this, "_addATFLIR").name("Add ATFLIR Pod (reload)");
        }
        // ── end ATFLIR Pod ──────────────────────────────────────

        // ── Gimbal Preset — full pipeline, creates a new sitch ──
        // Folder shell created once in initializeOnce; rebuild contents here.
        const gimbalFolder = guiMenus.gimbalAnalysis;

        this._gimbalConfig = {
            showGlare: true, showATFLIR: true,
            cloudWindFrom: 240,  cloudWindKnots: 17,
            startDistance: 32,   targetSpeed: 340,
            defaultTraverse: "Const Air Spd",
            fleetTurnStart: 0,  fleetTurnRate: 8,
            fleetAcceleration: 2, fleetSpacing: 0.7,
            fleetX: 20, fleetY: -5.27,
        };
        if (Sit.gimbalSetup) Object.assign(this._gimbalConfig, Sit.gimbalSetup);
        const gc = this._gimbalConfig;

        if (Sit.gimbalSetup) {
            gimbalFolder.add({status: "Active"}, "status").name("Status").disable();
        }

        gimbalFolder.add(gc, "cloudWindFrom", 0, 360, 1).name("Cloud Wind From");
        gimbalFolder.add(gc, "cloudWindKnots", 0, 100, 1).name("Cloud Wind Knots");
        gimbalFolder.add(gc, "showGlare").name("Show Glare");
        gimbalFolder.add(gc, "showATFLIR").name("Show ATFLIR Pod");

        const makeBaseGimbalSitch = (pipeline) => {
            // An empty `pipeline` object means "nothing auto-runs" — the
            // manual-build variant.  In that mode we have to strip sitch
            // options that resolve references at setup-time (azSlider,
            // include_JetLabels, sprites/FlowOrbs) because their target
            // nodes (azSources, jetTrack, targetWind) won't exist yet.
            const isManual = pipeline && Object.keys(pipeline).length === 0;

            // Seed the generated sitch from the live nodes of the current
            // (base custom) sitch so the user sees only one set of controls:
            // target/local wind live at the top of Physics, and start
            // distance / target speed / traverse mode live in the Traverse
            // menu. The preset folder no longer duplicates these.
            const liveSeed = {};
            if (NodeMan.exists("targetWind")) {
                const tw = NodeMan.get("targetWind");
                liveSeed.targetWindFrom = tw.from;
                liveSeed.targetWindKnots = tw.knots;
            }
            if (NodeMan.exists("localWind")) {
                const lw = NodeMan.get("localWind");
                liveSeed.localWindFrom = lw.from;
                liveSeed.localWindKnots = lw.knots;
            }
            if (NodeMan.exists("startDistance")) {
                liveSeed.startDistance = NodeMan.get("startDistance").value;
            }
            if (NodeMan.exists("speedScaled")) {
                liveSeed.targetSpeed = NodeMan.get("speedScaled").value;
            }
            if (NodeMan.exists("LOSTraverseSelect")) {
                liveSeed.defaultTraverse = NodeMan.get("LOSTraverseSelect").choice;
            }

            const s = {
                name: "custom", isCustom: true, canMod: false, isTextable: false,
                jetStuff: true,
                fps: 29.97, frames: 1031, aFrame: 0, bFrame: 1030,
                lat: 28.5, lon: -79.5,
                jetLat: {kind: "Constant", value: 28.5},
                jetLon: {kind: "Constant", value: -79.5},
                jetAltitude: {kind: "inputFeet", value: 25000, desc: "Altitude", start: 24500, end: 25500, step: 1},
                jetOrigin: {kind: "TrackFromLLA", lat: "jetLat", lon: "jetLon", alt: "jetAltitude"},
                TerrainModel: {kind: "Terrain", lat: 34, lon: -118.3, zoom: 7, nTiles: 3, fullUI: true, dynamic: true},
                files: {
                    GimbalCSV: 'gimbal/GimbalData.csv', GimbalCSV2: 'gimbal/GimbalRotKeyframes.csv',
                    GimbalCSV_Pip: 'gimbal/GimbalPIPKeyframes.csv',
                    ATFLIRModel: 'models/ATFLIR.glb', FA18Model: 'models/FA-18F.glb',
                    TargetObjectFile: 'models/FA-18F.glb',
                },
                mainCamera: {
                    startCameraPositionLLA: [28.470586, -79.100902, 26132.346324],
                    startCameraTargetLLA: [28.470824, -79.110720, 25870.046771],
                },
                mainView: {left: 0, top: 0, width: 1, height: 1, fov: 10, background: '#000000'},
                videoView: {left: 0.8250, top: 0.6666, width: -1, height: 0.3333, background: [1, 0, 0, 0]},
                syncVideoZoom: true,
                lookCamera: {fov: 0.35},
                lookView: {left: 0.6656, top: 0.6667, width: -1, height: 0.333,
                    draggable: true, resizable: true, shiftDrag: true, freeAspect: false, noOrbitControls: true},
                mirrorVideo: {transparency: 0.15, autoClear: true, autoFill: false},
                lighting: {kind: "Lighting", ambientIntensity: 0.35, IRAmbientIntensity: 1.0,
                    sunIntensity: 0.7, sunScattering: 0.6, ambientOnly: false},
                focusTracks: {"Default": "default", "Jet track": "jetTrack", "Traverse Path (UFO)": "LOSTraverseSelect"},
                include_Compasses: true,
                gimbalSetup: {...this._gimbalConfig, ...liveSeed, ...(pipeline ? {pipeline} : {})},
            };
            if (!isManual) {
                s.azSlider = {defer: true};
                s.include_JetLabels = true;
                s.sprites = {kind: "FlowOrbs", nSprites: 1000, wind: "targetWind",
                    colorMethod: "Hue From Altitude", hueAltitudeMax: 1400,
                    camera: "lookCamera", visible: false, defer: true};
            }
            return s;
        };

        if (!Sit.gimbalSetup) {
            this._enableGimbalAnalysis = async () => {
                const gimbalSitch = makeBaseGimbalSitch(null);

                // Rehost any dropped video + supporting files so the user can drag a
                // Gimbal .mp4 onto the base custom sitch and still have it carried over
                // into the new Gimbal sitch when they click "Create Gimbal Sitch".
                await FileManager.rehostDynamicLinks(true);

                const videoNode = NodeMan.exists("video") ? NodeMan.get("video") : null;
                if (videoNode) {
                    const videoURL = videoNode.videos?.[videoNode.currentVideoIndex]?.staticURL
                        || videoNode.staticURL;
                    const droppedSize = videoNode.videos?.[videoNode.currentVideoIndex]?.videoData?.videoDroppedData?.byteLength ?? 0;
                    // Only carry over when the URL looks real AND the rehosted file is
                    // at least plausibly the size of what we dropped. Rehost can silently
                    // fail when PHP's post_max_size is exceeded — the returned URL points
                    // at a tiny error HTML file that would break the sitch on reload.
                    let accept = false;
                    if (videoURL && /^(https?:|sitrec:|\/)/.test(videoURL)) {
                        try {
                            const head = await fetch(videoURL, {method: "HEAD"});
                            const len = parseInt(head.headers.get("Content-Length") || "0", 10);
                            if (head.ok && (len >= droppedSize / 2 || len >= 100000)) {
                                accept = true;
                            } else {
                                console.warn("Gimbal preset: rehosted video is too small (" + len + " B for " + droppedSize + " B source), ignoring");
                            }
                        } catch (e) {
                            console.warn("Gimbal preset: couldn't verify rehosted video:", e.message);
                        }
                    }
                    if (accept) gimbalSitch.videoFile = videoURL;
                }
                if (Sit.loadedFiles && Object.keys(Sit.loadedFiles).length > 0) {
                    gimbalSitch.loadedFiles = {...Sit.loadedFiles};
                }
                if (FileManager.loadedFilesMetadata
                    && Object.keys(FileManager.loadedFilesMetadata).length > 0) {
                    gimbalSitch.loadedFilesMetadata = {...FileManager.loadedFilesMetadata};
                }

                const sitchStr = JSON.stringify({stringified: true, isASitchFile: true, ...gimbalSitch}, null, 2);
                FileManager.rehoster.rehostFile("GimbalAnalysis", new TextEncoder().encode(sitchStr), getDateTimeFilename() + ".js").then((staticRef) => {
                    FileManager.loadURL = staticRef;
                    window.location.href = SITREC_APP + "?custom=" + encodeShareParam(toShareableCustomValue(staticRef));
                });
            };
            gimbalFolder.add(this, "_enableGimbalAnalysis").name(">> Create Gimbal Sitch");

            // Variant: same base sitch, but with an EMPTY pipeline so nothing
            // auto-runs on load — user then clicks manual-build buttons.
            this._enableGimbalManualBase = async () => {
                const gimbalSitch = makeBaseGimbalSitch({});  // empty pipeline = run no steps
                await FileManager.rehostDynamicLinks(true);
                const sitchStr = JSON.stringify({stringified: true, isASitchFile: true, ...gimbalSitch}, null, 2);
                FileManager.rehoster.rehostFile("GimbalManualBase",
                    new TextEncoder().encode(sitchStr),
                    getDateTimeFilename() + ".js"
                ).then((staticRef) => {
                    FileManager.loadURL = staticRef;
                    window.location.href = SITREC_APP + "?custom=" + encodeShareParam(toShareableCustomValue(staticRef));
                });
            };
            gimbalFolder.add(this, "_enableGimbalManualBase").name(">> Create Gimbal Base (manual build)");
        } else {
            this._updateGimbalConfig = () => {
                // preserve pipeline flags, just update config knobs
                const pipeline = Sit.gimbalSetup.pipeline;
                Sit.gimbalSetup = {...this._gimbalConfig, ...(pipeline ? {pipeline} : {})};
                Sit.showGlare = gc.showGlare;
                this.serialize("Custom", getDateTimeFilename()).then(() => { window.location.reload(); });
            };
            gimbalFolder.add(this, "_updateGimbalConfig").name("Apply Parameter Changes");

            this._setupManualBuildFolder(gimbalFolder);
        }
        gimbalFolder.close();
        // ── end Gimbal Preset ───────────────────────────────────

        toggler('k', guiMenus.help.add(par, 'showKeyboardShortcuts').listen().name(t("custom.showHide.keyboardShortcuts.label")).onChange(value => {
            if (value) {
                infoDiv.style.display = 'block';
            } else {
                infoDiv.style.display = 'none';
            }
        }).tooltip(t("custom.showHide.keyboardShortcuts.tooltip"))
        )

        toggler('e', guiMenus.contents.add(this, "toggleExtendToGround")
            .name(t("custom.showHide.toggleExtendToGround.label"))
            .moveToFirst()
            .tooltip(t("custom.showHide.toggleExtendToGround.tooltip"))
        )

        if (Globals.showAllTracksInLook === undefined)
            Globals.showAllTracksInLook = false;
        guiMenus.showhide.add(Globals, "showAllTracksInLook").name(t("custom.showHide.showAllTracksInLook.label")).tooltip(t("custom.showHide.showAllTracksInLook.tooltip")).onChange(() => {
            this.refreshLookViewTracks();

        }).listen();

        if (GlobalScene.showCompassElevation === undefined) {
            Globals.showCompassElevation = false;
            guiMenus.showhide.add(Globals, "showCompassElevation").name(t("custom.showHide.showCompassElevation.label"))
                .tooltip(t("custom.showHide.showCompassElevation.tooltip"))
                .onChange(() => {
                    // iterate over all nodes, find any CNodeCompassUI, and force update their text by changing lastHeading to null
                    NodeMan.iterate((id, node) => {
                        if (node.constructor.name === "CNodeCompassUI") {
                            node.lastHeading = null;
                        }
                    })

                })
                .listen();
        }

        guiMenus.contents.add(this, "filterTracks")
            .name(t("custom.showHide.filterTracks.label"))
            .moveToFirst()
            .tooltip(t("custom.showHide.filterTracks.tooltip"))

        guiMenus.contents.add(this, "addTrackFromCameraLOS")
            .name(t("custom.showHide.addTrackFromCameraLOS.label"))
            .moveToFirst()
            .tooltip(t("custom.showHide.addTrackFromCameraLOS.tooltip"))

        guiMenus.contents.add(this, "removeAllTracks")
            .name(t("custom.showHide.removeAllTracks.label"))
            .moveToFirst()
            .tooltip(t("custom.showHide.removeAllTracks.tooltip"))


        // guiMenus.physics.add(this, "calculateBestPairs").name("Calculate Best Pairs");


        guiMenus.objects.add(this, "removeAllBuildings")
            .name(t("custom.objects.removeAllBuildings.label"))
            .tooltip(t("custom.objects.removeAllBuildings.tooltip"))

        if (Globals.objectScale === undefined)
            Globals.objectScale = 1.0;
        guiMenus.objects.add(Globals, "objectScale", 1, 50, 0.01)
            .name(t("custom.objects.globalScale.label"))
            .tooltip(t("custom.objects.globalScale.tooltip"))
            .listen()
            .onChange((value) => {
                // iterate over all node, any CNode3DObject, and set the scale to this.objectScale
                NodeMan.iterate((id, node) => {
                    if (node instanceof CNode3DObject) {
                        node.recalculate();
                    }
                });
            });

        // configParmas.extraHelpFunctions has and object keyed on function name
        if (configParams?.extraHelpFunctions) {
            // iterate over k, value of configParmas.extraHelpFunctions
            for (const funcName in configParams.extraHelpFunctions) {
                const funcVars = configParams.extraHelpFunctions[funcName];
                // create a new function in CCustomManager with the function name
                this[funcName] = () => {
                    funcVars[0]();
                }

                guiMenus["help"].add(this, funcName)
                    .name(t("helpFunctions." + funcName + ".label", {defaultValue: funcVars[1]}))
                    .listen()
                    .tooltip(t("helpFunctions." + funcName + ".tooltip", {defaultValue: funcVars[2]}));
            }
        }

        // Add GUI mirroring functionality to help menu
        // guiMenus.help.add(this, "showMirrorMenuDemo").name("Mirror Menu Demo").tooltip("Demonstrates how to mirror any GUI menu to create a standalone floating menu");

        if (isAdmin()) {
            const adminFolder = guiMenus.help.addFolder("Admin");
            adminFolder.add(this, "openAdminDashboard").name(t("custom.admin.dashboard.label")).tooltip(t("custom.admin.dashboard.tooltip"));
            adminFolder.add(this, "validateAllSitches").name(t("custom.admin.validateAllSitches.label")).tooltip(t("custom.admin.validateAllSitches.tooltip"));
            adminFolder.add(Globals, "testUserID", 0, 99999999, 1).noSlider().name(t("custom.admin.testUserID.label")).tooltip(t("custom.admin.testUserID.tooltip"))
                .onFinishChange(() => { FileManager.refreshUserSaves(); });
            if (getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3)) {
                adminFolder.add(this, "addMissingScreenshots").name(t("custom.admin.addMissingScreenshots.label")).tooltip(t("custom.admin.addMissingScreenshots.tooltip"));
            }
            this._featureButton = adminFolder.add(this, "toggleFeatureSitch").name(t("custom.admin.feature.label"))
                .tooltip(t("custom.admin.feature.tooltip"));
            const browser = FileManager.sitchBrowser;
            // Only fetch featured state when a saved sitch is already loaded.
            // Browser-first startup will load featured data when the browser opens.
            if (browser && Sit.sitchName && !browser.pendingOpen) {
                browser._reloadFeaturedFromServer().then(() => this.updateFeatureButton());
            } else {
                this.updateFeatureButton();
            }
        }

        // TODO - Multiple events passed to EventManager.addEventListener

        const syncTrackingOverlayLOSSourceOption = () => {
            if (!Sit.isCustom || !NodeMan.exists("JetLOS") || !NodeMan.exists("trackingOverlay")) {
                return;
            }

            const jetLOS = NodeMan.get("JetLOS");
            const trackingOverlay = NodeMan.get("trackingOverlay");
            const optionName = "Camera + Object Track";
            const shouldExposeOption = trackingOverlay.hasVideoGeometry?.() ?? false;
            const hasOption = jetLOS.inputs[optionName] !== undefined;

            // Hide the object-track LOS mode until the tracking overlay has a real video pixel space.
            if (shouldExposeOption && !hasOption) {
                jetLOS.addOption(optionName, trackingOverlay);
                jetLOS.controller?.updateDisplay();
            } else if (!shouldExposeOption && hasOption) {
                jetLOS.removeOption(optionName);
                jetLOS.controller?.updateDisplay();
            }
        };

        syncTrackingOverlayLOSSourceOption();

        // Listen for events that mean we've changed the camera track
        // and hence established a sitch we don't want subsequent tracks to mess up.
        // changing camera to a fixed camera, which might be something the user does even beforer
        // they add any tracks
        EventManager.addEventListener("Switch.onChange.cameraTrackSwitch", (choice) => {
            console.log("EVENT Camera track switch changed to " + choice)
            setSitchEstablished(true)
        });

        // Changing the LOS traversal method would indicate a sitch has been established
        // this might be done after the first track
        EventManager.addEventListener("Switch.onChange.LOSTraverseSelectTrack", (choice) => {
            console.log("EVENT Camera track switch changed to " + choice)
            setSitchEstablished(true)
        });

        // Changing the CameraLOSController method would indicate a sitch has been established
        // this might be done after the first track
        // I'm not doing this, as the LOS controller is changed programatically by loading the first track
        // coudl possibly patch around it, but I'm not sure if it's needed.
        // EventManager.addEventListener("Switch.onChange.CameraLOSController", (choice) => {
        //     setSitchEstablished(true)
        // });

        EventManager.addEventListener("GUIValue.onChange.Camera [C] Lat", (value) => {
            setSitchEstablished(true)
        });

        EventManager.addEventListener("GUIValue.onChange.Camera [C] Lon", (value) => {
            setSitchEstablished(true)
        });

        EventManager.addEventListener("PositionLLA.onChange", (data) => {
            if (data.id === "fixedCameraPosition") {
                setSitchEstablished(true)

                // if there's a camera track switch, then we need to update the camera track
                if (NodeMan.exists("cameraTrackSwitch")) {
                    const cameraTrackSwitch = NodeMan.get("cameraTrackSwitch");
                    // if the camera track switch is not set to "fixedCamera", "flightSimCamera", or "orbitCamera", then set it to "fixedCamera"
                    if (cameraTrackSwitch.choice !== "fixedCamera" && cameraTrackSwitch.choice !== "flightSimCamera" && cameraTrackSwitch.choice !== "orbitCamera") {
                        console.log("Setting camera track switch to fixedCamera");
                        cameraTrackSwitch.selectOption("fixedCamera");
                    }
                }
            }
        });

        EventManager.addEventListener("videoLoaded", (data) => {
            let width, height;

            if (!Sit.isCustom) {
                console.warn("videoLoaded event received for non-custom sitch: " + Sit.name);
                return;
            }

            syncTrackingOverlayLOSSourceOption();

            if (data.width !== undefined && data.height !== undefined) {
                // this is a video loaded from a file, so we can use the width and height directly
                width = data.width;
                height = data.height;
            } else if (data.videoData && data.videoData.config) {
                // this is a video loaded from a CVideoMp4Data, so we can use the config
                // codedWidth and codedHeight are the original video dimensions
                width = data.videoData.config.codedWidth;
                height = data.videoData.config.codedHeight;
            }

            if (NodeMan.exists("video")) {
                const videoView = NodeMan.get("video");
                // if it's NOT visible, then we can decide what preset to use
                // if it IS visible, then we assume the user has set it up how they want
                if (!videoView.visible) {
                    // decide what preset is needed
                    if (width === undefined || width > height) {
                        this.currentViewPreset = "Default"; // wide video
                    } else {
                        this.currentViewPreset = "ThreeWide"; // tall video
                    }
                    this.updateViewFromPreset();
                }
            }

            if (Sit.metadata && !Globals.sitchEstablished) {
                const meta = Sit.metadata;
                // got lat, lon, alt?
                if (meta.latitude && meta.longitude && meta.altitude) {
                    const camera = NodeMan.get("fixedCameraPosition");
                    camera.gotoLLA(meta.latitude, meta.longitude, meta.altitude)
                    // and set sitchEstablished to true
                    setSitchEstablished(true);
                }

                // got date and time?
                if (meta.creationDate) {
                    // parse the date and time
                    // set the GlobalDateTimeNode to this date
                    GlobalDateTimeNode.setStartDateTime(meta.creationDate);
                    // and set sitchEstablished to true
                    setSitchEstablished(true);
                }

                // regardless, we clear the live mode on GlobalDateTimeNode, as loading a video should always put us in control of the time
                GlobalDateTimeNode.liveMode = false;

            }

            NodeMan.recalculateAllRootFirst();



        });

        EventManager.addEventListener("videoAvailabilityChanged", () => {
            syncTrackingOverlayLOSSourceOption();
        });


        this.viewPresets = {
            Default: {
                keypress: "1",
                // video: {visible: true, left: 0.5, top: 0, width: -1.7927, height: 0.5},
                // mainView: {visible: true, left: 0.0, top: 0, width: 0.5, height: 1},
                // lookView: {visible: true, left: 0.5, top: 0.5, width: -1.7927, height: 0.5},
                mainView: { visible: true, left: 0.0, top: 0, width: 0.5, height: 1 },
                video: { visible: true, left: 0.5, top: 0, width: 0.5, height: 0.5 },
                lookView: { visible: true, left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
                chatView: { left: 0.25, top: 0.10, width: 0.25, height: 0.85, }, // does not work
            },

            SideBySide: {
                keypress: "2",
                mainView: { visible: true, left: 0.0, top: 0, width: 0.5, height: 1 },
                video: { visible: false },
                lookView: { visible: true, left: 0.5, top: 0, width: 0.5, height: 1 },
            },

            TopandBottom: {
                keypress: "3",
                mainView: { visible: true, left: 0.0, top: 0, width: 1, height: 0.5 },
                video: { visible: false },
                lookView: { visible: true, left: 0.0, top: 0.5, width: 1, height: 0.5 },
            },

            ThreeWide: {
                keypress: "4",
                mainView: { visible: true, left: 0.0, top: 0, width: 0.333, height: 1 },
                video: { visible: true, left: 0.333, top: 0, width: 0.333, height: 1 },
                lookView: { visible: true, left: 0.666, top: 0, width: 0.333, height: 1 },
            },

            TallVideo: {
                keypress: "5",
                mainView: { visible: true, left: 0.0, top: 0, width: 0.50, height: 1 },
                video: { visible: true, left: 0.5, top: 0, width: 0.25, height: 1 },
                lookView: { visible: true, left: 0.75, top: 0, width: 0.25, height: 1 },

            },

            VideoLookHorizontal: {
                keypress: "6",
                mainView: { visible: false },
                video: { visible: true, left: 0.0, top: 0, width: 1, height: 0.5 },
                lookView: { visible: true, left: 0.0, top: 0.5, width: 1, height: 0.5 },
            },

            VideoLookVertical: {
                keypress: "7",
                mainView: { visible: false },
                video: { visible: true, left: 0.0, top: 0, width: 0.5, height: 1 },
                lookView: { visible: true, left: 0.5, top: 0, width: 0.5, height: 1 },

            },

            // The two video views side by side, filling the screen, for
            // comparing/syncing two clips. mainView and lookView are hidden.
            TwoVideos: {
                keypress: "8",
                mainView: { visible: false },
                video: { visible: true, left: 0.0, top: 0, width: 0.5, height: 1 },
                video2: { visible: true, left: 0.5, top: 0, width: 0.5, height: 1 },
                lookView: { visible: false },
            },
        }

        this.currentViewPreset = "Default";
        // add a key handler to switch between the view presets

        this.presetGUI = guiMenus.view.add(this, "currentViewPreset", Object.keys(this.viewPresets))
            .name(t("custom.viewPreset.label"))
            .listen()
            .tooltip(t("custom.viewPreset.tooltip"))
            .onChange((value) => {
                this.updateViewFromPreset();
            })

        EventManager.addEventListener("keydown", (data) => {
            const keypress = data.key.toLowerCase();
            // if it's a number key, then switch to the corresponding view preset
            // in this.viewPreset
            if (keypress >= '0' && keypress <= '9') {

                // find the preset with the key: in the object
                const presetKey = Object.keys(this.viewPresets).find(
                    key => this.viewPresets[key].keypress === keypress
                );
                if (presetKey) {
                    this.currentViewPreset = presetKey;
                    console.log("Switching to view preset " + keypress);
                    this.updateViewFromPreset();
                }
            }
        })

        this.setupVideoExport();

        // Test the debug view after a short delay to ensure it's initialized
        setTimeout(() => {
            if (NodeMan.exists("debugView")) {
                const debugView = NodeMan.get("debugView");
                debugView.log("CCustomManager setup complete!");
                debugView.info("Debug view is working correctly.");
                debugView.warn("This is a warning message.");
                debugView.error("This is an error message.");
                debugView.debug("This is a debug message.");
            }
        }, 1000);

        // Example of creating a standalone pop-up menu
        // This creates a draggable menu that behaves like the individual menus from the menu bar
        // but is not attached to the menu bar itself
        // this.setupStandaloneMenuExample();
        //
        // // Example of mirroring the Flow Orbs menu (or effects menu if no Flow Orbs exist)
        // this.setupFlowOrbsMirrorExample();

        if (!NodeMan.exists("dagView") && isAdmin()) {
            new CNodeViewDAG({
                id: "dagView",
                visible: false,
                left: 0.8,
                top: 0,
                width: 0.2,
                height: 0.2,
                draggable: false,
            });
        }

        if (!NodeMan.exists("notesView")) {
            new CNodeNotes({
                id: "notesView",
                visible: false,
                left: 0.60,
                top: 0.10,
                width: 0.35,
                height: 0.50,
                draggable: true,
                resizable: true,
                freeAspect: true,
            });
        }

        // Set up the fovEditor and add it to fovSwitch
        if (!NodeMan.exists("fovEditor")) {

            // only currently makes sense if we have a fovSwitch
            // although we could hook it up to bespoke sitches, we probably won't
            const fovSwitch = NodeMan.get("fovSwitch", false);
            if (fovSwitch) {

                const fovEditor = new CNodeCurveEditor2(
                    {
                        id: "fovEditor",
                        menuName: "FOV Editor",
                        visible: false,
                        left: 0, top: 0.5, width: -1, height: 0.5,
                        draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
                        editorConfig: {
                            useRegression: true,
                            minX: 0, maxX: "Sit.frames", minY: 0, maxY: 40,
                            xLabel: "Frame", xStep: 1, yLabel: "FOV", yStep: 5,
                            points: [99, 99]
                        },
                        frames: -1, // -1 will inherit from Sit.frames
                    },
                )


                fovSwitch.addOption("FOV Editor", fovEditor);
            }
        }

        this.setupVideoInfoMenu();

        this.setupOSDDataSeriesController();

        setupHorizonExtractorMenu();

        setupCameraMotionMenu();

        this.setupSimpleFlightSim();

        // Orbit camera - orbits around a selected target track at a given radius and period
        if (!NodeMan.exists("orbitCameraPosition") && NodeMan.exists("fixedCameraPosition")) {
            new CNodeTrackSwitch({
                id: "orbitTargetSwitch",
                inputs: {
                    "fixedCamera": NodeMan.get("fixedCameraPosition"),
                },
                desc: "Orbit Target",
                gui: "camera",
            });

            new CNodeGUIValue({
                id: "orbitRadius",
                value: 5000, start: 100, end: 100000, step: 100,
                desc: "Orbit Radius (m)", gui: "camera",
            });

            new CNodeGUIValue({
                id: "orbitPeriod",
                value: 120, start: 60, end: 300, step: 1,
                desc: "Orbit Period (s)", gui: "camera",
            });

            new CNodeOrbitTrack({
                id: "orbitCameraPosition",
                target: "orbitTargetSwitch",
                radius: "orbitRadius",
                period: "orbitPeriod",
                altitude: "fixedCameraPosition",
            });

            const cameraTrackSwitch = NodeMan.get("cameraTrackSwitch", false);
            if (cameraTrackSwitch) {
                cameraTrackSwitch.addOption("orbitCamera", NodeMan.get("orbitCameraPosition"));
            }
        }

        if (!NodeMan.exists("FloodSim")) {
            new CNodeFloodSim({
                id: "FloodSim",
            });
        }

        this.setupSubSitches();

    }, // end of setup()
};
