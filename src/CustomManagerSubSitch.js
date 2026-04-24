/**
 * Sub-sitch management: capture/restore/switch/serialize sub-sitches.
 *
 * Extracted from CustomSupport.js as a mixin. Methods are merged into
 * CCustomManager.prototype so `this` references the CCustomManager instance.
 */
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
import {CNodeControllerCelestial} from "./nodes/CNodeControllerVarious";
import {CNodeAutoTrackLOS} from "./nodes/CNodeAutoTrackLOS";
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
import {getNearbyWeatherBalloons, importSoundingDialog} from "./SondeFetch";
import {WIND_SOURCES, windSourceLabelsToKeys, windSourceByKey} from "./nodes/WindSources";
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

export const subSitchMethods = {
    setupSubSitches() {
        this.subSitches = [];
        this.currentSubIndex = 0;
        this.subSitchFolder = null;
        this.subSitchControllers = [];

        this.subSitchFolder = guiMenus.file.addFolder("Sub Sitches").close()
            .tooltip(t("custom.subSitches.folder.tooltip"));

        this.subSitchFolder.add(this, "updateSubSitch").name(t("custom.subSitches.updateCurrent.label"))
            .tooltip(t("custom.subSitches.updateCurrent.tooltip"));

        this.subSitchFolder.add(this, "updateAndAddSubSitch").name(t("custom.subSitches.updateAndAddNew.label"))
            .tooltip(t("custom.subSitches.updateAndAddNew.tooltip"));

        this.subSitchFolder.add(this, "discardAndAddSubSitch").name(t("custom.subSitches.discardAndAddNew.label"))
            .tooltip(t("custom.subSitches.discardAndAddNew.tooltip"));

        this.subSitchFolder.add(this, "renameCurrentSubSitch").name(t("custom.subSitches.renameCurrent.label"))
            .tooltip(t("custom.subSitches.renameCurrent.tooltip"));

        this.subSitchFolder.add(this, "deleteCurrentSubSitch").name(t("custom.subSitches.deleteCurrent.label"))
            .tooltip(t("custom.subSitches.deleteCurrent.tooltip"));

        this.setupSubSitchDetails();
        this.initializeFirstSubSitch();
    },

    initializeFirstSubSitch() {
        const state = this.captureSubSitchState();
        this.subSitches.push({
            name: "Sub 1",
            state: state
        });
        this.currentSubIndex = 0;
        this.rebuildSubSitchMenu();
    },

    setupSubSitchDetails() {
        // Node categories for sub-sitch serialization
        // Format: CategoryName: [defaultOn, ...patterns]
        // - defaultOn: 1 = enabled by default, 0 = disabled by default
        // - patterns: exact node ID match, or *pattern* for case-insensitive includes
        this.subIncludes = {
            Views: [1, "mainView", "lookView", "video", "chatView", "*View*"],
            Cameras: [1, "mainCamera", "lookCamera", "fixedCameraPosition", "ptzAngles", "*Camera*"],
            "Date/Time": [1, "dateTimeStart", "*DateTime*"],
            Measurement: [1, "globalMeasureA", "globalMeasureB"],
            Others: [0, "lighting", "*Lighting*", "*Effect*", "*Target*", "targetObject", "traverseObject"]
        };

        this.subSaveEnabled = {};
        this.subLoadEnabled = {};
        for (const key in this.subIncludes) {
            this.subSaveEnabled[key] = this.subIncludes[key][0] === 1;
            this.subLoadEnabled[key] = true;
        }

        this.subSaveFolder = this.subSitchFolder.addFolder("Sub Saving Details").close()
            .tooltip("Select which node types to include when saving/updating sub sitches");
        for (const key in this.subIncludes) {
            this.subSaveFolder.add(this.subSaveEnabled, key).name(key).listen()
                .tooltip("Include " + key.toLowerCase() + " data when saving sub sitches");
        }

        this.subLoadFolder = this.subSitchFolder.addFolder("Sub Loading Details").close()
            .tooltip("Select which node types to restore when switching to a sub sitch");
        for (const key in this.subIncludes) {
            this.subLoadFolder.add(this.subLoadEnabled, key).name(key).listen()
                .tooltip("Restore " + key.toLowerCase() + " data when loading a sub sitch");
        }

        this.subSitchFolder.add(this, "syncSubSaveDetails").name(t("custom.subSitches.syncSaveDetails.label"))
            .tooltip(t("custom.subSitches.syncSaveDetails.tooltip"));
    },

    syncSubSaveDetails() {
        if (this.subSitches.length === 0 || this.currentSubIndex < 0) return;

        const currentSub = this.subSitches[this.currentSubIndex];
        if (!currentSub.state || !currentSub.state.mods) return;

        const newMods = {};
        const newFocusTracks = {};
        const newLockTracks = {};

        for (const id in currentSub.state.mods) {
            if (this.shouldIncludeNodeForSave(id)) {
                newMods[id] = currentSub.state.mods[id];
            }
        }

        for (const id in currentSub.state.focusTracks) {
            if (this.shouldIncludeNodeForSave(id)) {
                newFocusTracks[id] = currentSub.state.focusTracks[id];
            }
        }

        for (const id in currentSub.state.lockTracks) {
            if (this.shouldIncludeNodeForSave(id)) {
                newLockTracks[id] = currentSub.state.lockTracks[id];
            }
        }

        currentSub.state.mods = newMods;
        currentSub.state.focusTracks = newFocusTracks;
        currentSub.state.lockTracks = newLockTracks;
    },

    nodeMatchesPattern(nodeId, pattern) {
        const idLower = nodeId.toLowerCase();
        if (pattern.startsWith("*") && pattern.endsWith("*")) {
            const inner = pattern.slice(1, -1).toLowerCase();
            return idLower.includes(inner);
        }
        return nodeId === pattern;
    },

    nodeMatchesCategory(nodeId, category) {
        const patterns = this.subIncludes[category];
        for (let i = 1; i < patterns.length; i++) {
            if (this.nodeMatchesPattern(nodeId, patterns[i])) {
                return true;
            }
        }
        return false;
    },

    shouldIncludeNodeForSave(nodeId) {
        for (const category in this.subIncludes) {
            if (this.subSaveEnabled[category] && this.nodeMatchesCategory(nodeId, category)) {
                return true;
            }
        }
        return false;
    },

    shouldIncludeNodeForLoad(nodeId) {
        for (const category in this.subIncludes) {
            if (this.subLoadEnabled[category] && this.nodeMatchesCategory(nodeId, category)) {
                return true;
            }
        }
        return false;
    },

    remapDeprecatedNodeId(id) {
        const deprecatedNodeIds = {
            // Typo fix: canonical node id is now anglesSwitch.
            // Keep this remap so older saved sitches still load.
            "angelsSwitch": "anglesSwitch",
            "osdTrackController": "osdDataSeriesController",
        };
        const remappedId = deprecatedNodeIds[id];
        if (!remappedId) return id;

        // Only remap when the current graph actually uses the new id.
        // Some legacy saved custom files still define the old node id in the base graph.
        const oldExists = NodeMan.exists(id);
        const newExists = NodeMan.exists(remappedId);
        if (newExists && !oldExists) {
            return remappedId;
        }
        return id;
    },

    getSubSitchNodes() {
        const nodeIds = [];

        NodeMan.iterate((id, node) => {
            if (node.modSerialize !== undefined) {
                if (this.shouldIncludeNodeForSave(id)) {
                    nodeIds.push(id);
                }
            }
        });

        return nodeIds;
    },

    captureSubSitchState() {
        const state = {
            mods: {},
            focusTracks: {},
            lockTracks: {}
        };

        const nodeIds = this.getSubSitchNodes();

        for (const id of nodeIds) {
            const node = NodeMan.get(id, false);
            if (node && node.modSerialize) {
                const nodeMod = node.modSerialize();
                if (nodeMod.rootTestRemove !== undefined) {
                    delete nodeMod.rootTestRemove;
                }
                if (Object.keys(nodeMod).length > 0) {
                    state.mods[id] = nodeMod;
                }

                if (node.focusTrackName !== undefined) {
                    state.focusTracks[id] = node.focusTrackName;
                }
                if (node.lockTrackName !== undefined) {
                    state.lockTracks[id] = node.lockTrackName;
                }
            }
        }

        return state;
    },

    restoreSubSitchState(state) {
        if (!state || !state.mods) return;

        Globals.dontRecalculate = true;

        const restoredIds = [];
        for (const rawId in state.mods) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.mods[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node && node.modDeserialize) {
                node.modDeserialize(state.mods[rawId]);
                restoredIds.push(id);
            }
        }

        for (const rawId in state.focusTracks) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.focusTracks[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node) {
                node.focusTrackName = state.focusTracks[rawId];
            }
        }

        for (const rawId in state.lockTracks) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.lockTracks[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node) {
                node.lockTrackName = state.lockTracks[rawId];
            }
        }

        Globals.dontRecalculate = false;

        for (const id of restoredIds) {
            const node = NodeMan.get(id, false);
            if (node) {
                node.recalculateCascade();
            }
        }

        setRenderOne(true);
    },

    pushNewSubSitch(state) {
        const newIndex = this.subSitches.length + 1;
        this.subSitches.push({
            name: "Sub " + newIndex,
            state: state
        });

        this.currentSubIndex = this.subSitches.length - 1;
        this.rebuildSubSitchMenu();
    },

    updateSubSitch() {
        this.saveCurrentSubSitch();
    },

    updateAndAddSubSitch() {
        this.saveCurrentSubSitch();
        this.pushNewSubSitch(this.captureSubSitchState());
    },

    discardAndAddSubSitch() {
        this.pushNewSubSitch(this.captureSubSitchState());
    },

    saveCurrentSubSitch() {
        if (this.subSitches.length > 0 && this.currentSubIndex >= 0) {
            this.subSitches[this.currentSubIndex].state = this.captureSubSitchState();
        }
    },

    switchToSubSitch(index) {
        if (index < 0 || index >= this.subSitches.length) return;
        if (index === this.currentSubIndex) return;

        // this.saveCurrentSubSitch(); // No auto-save on switch

        this.currentSubIndex = index;
        this.restoreSubSitchState(this.subSitches[index].state);

        this.rebuildSubSitchMenu();
    },

    renameCurrentSubSitch() {
        if (this.subSitches.length === 0) return;

        const currentSub = this.subSitches[this.currentSubIndex];
        const newName = prompt("Enter new name for Sub Sitch:", currentSub.name);

        if (newName && newName.trim()) {
            currentSub.name = newName.trim();
            this.rebuildSubSitchMenu();
        }
    },

    deleteCurrentSubSitch() {
        if (this.subSitches.length <= 1) {
            alert("Cannot delete the last Sub Sitch.");
            return;
        }

        const currentSub = this.subSitches[this.currentSubIndex];
        if (!confirm(`Delete "${currentSub.name}"?`)) return;

        this.subSitches.splice(this.currentSubIndex, 1);

        if (this.currentSubIndex >= this.subSitches.length) {
            this.currentSubIndex = this.subSitches.length - 1;
        }

        this.restoreSubSitchState(this.subSitches[this.currentSubIndex].state);
        this.rebuildSubSitchMenu();
    },

    rebuildSubSitchMenu() {
        for (const controller of this.subSitchControllers) {
            controller.destroy();
        }
        this.subSitchControllers = [];

        for (let i = 0; i < this.subSitches.length; i++) {
            const sub = this.subSitches[i];
            const isCurrent = (i === this.currentSubIndex);
            const displayName = isCurrent ? "► " + sub.name : "   " + sub.name;

            const switchData = { switch: () => this.switchToSubSitch(i) };
            const controller = this.subSitchFolder.add(switchData, "switch")
                .name(displayName);

            if (isCurrent) {
                controller.setLabelColor("#80ff80");
            }

            const idx = i;
            controller.domElement.addEventListener("dblclick", () => {
                this.switchToSubSitch(idx);
                this.renameCurrentSubSitch();
            });

            this.subSitchControllers.push(controller);
        }
    },

    serializeSubSitches() {
        this.saveCurrentSubSitch();
        return {
            subSitches: this.subSitches,
            currentSubIndex: this.currentSubIndex
        };
    },

    deserializeSubSitches(data) {
        if (!data || !data.subSitches) return;

        this.subSitches = data.subSitches;
        this.currentSubIndex = data.currentSubIndex || 0;

        if (this.subSitches.length > 0) {
            this.restoreSubSitchState(this.subSitches[this.currentSubIndex].state);
        }

        this.rebuildSubSitchMenu();
    },
};
