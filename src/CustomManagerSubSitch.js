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
    markSitchDirty,
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
import {UIChangedFrame, UpdateHUD} from "./JetStuff";
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
import {showError, showConfirm, showPrompt} from "./showError";
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

        this.chapterRevertRequest = null;
        this.timelineEvents = [];
        this.chapterBusy = false;
        this.chapterBaseline = null;
        this.subSitchFolder = guiMenus.file.addFolder("Sitch Chapters").close();
        FileManager?.fileTweaksFolder?.moveAfter("Sitch Chapters");
        this.subSitchFolder.add(this, "updateAndAddSubSitch").name("Add chapter").tooltip("Create a chapter using the current views, camera, time and events.");
        this.subSitchFolder.add(this, "renameCurrentSubSitch").name("Rename chapter");
        this.subSitchFolder.add(this, "deleteCurrentSubSitch").name("Delete chapter");
        this.subSitchFolder.add(this, "revertSitchChapters").name("Revert sitch to last save / load");
        this.subSitchFolder.add(this, "loadChapterVersion").name("Restore chapter from server version…");
        this.subSitchFolder.add(this, "loadChapterFile").name("Restore chapter from saved file…");
        this.chapterCards = document.createElement("div");
        this.chapterCards.style.cssText = "display:grid;gap:6px;padding:8px";
        this.subSitchFolder.$children.appendChild(this.chapterCards);
        this.subSitchFolder.add(this, "addPredictedTimelineEvents").name("Add predicted satellite rise / set");
        this.subSitchFolder.add(this, "addTimelineEvent").name("Add event at current frame…");
        this.timelineCards = document.createElement("div");
        this.timelineCards.style.cssText = "display:grid;gap:4px;padding:8px";
        this.subSitchFolder.$children.appendChild(this.timelineCards);
        this.setupSubSitchDetails();
        this.initializeFirstSubSitch();
        this.markChapterBaseline();
    },

    initializeFirstSubSitch() {
        const state = this.captureSubSitchState();
        this.subSitches.push({
            name: "Chapter 1",
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
            Cameras: [1, "mainCamera", "lookCamera", "fixedCameraPosition", "ptzAngles", "fovUI", "fovSwitch", "anglesSwitch", "angelsSwitch", "*Camera*"],
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

        this.subSaveFolder = this.subSitchFolder.addFolder("Advanced: capture scope").close()
            .tooltip("Select which node types to include when capturing chapters");
        for (const key in this.subIncludes) {
            this.subSaveFolder.add(this.subSaveEnabled, key).name(key).listen()
                .tooltip("Include " + key.toLowerCase() + " data when capturing chapters");
        }

        this.subLoadFolder = this.subSitchFolder.addFolder("Advanced: restore scope").close()
            .tooltip("Select which node types to restore when switching chapters");
        for (const key in this.subIncludes) {
            this.subLoadFolder.add(this.subLoadEnabled, key).name(key).listen()
                .tooltip("Restore " + key.toLowerCase() + " data when loading a chapter");
        }


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
        // A node can belong to the whole sitch rather than to each sub sitch.
        if (NodeMan.get(nodeId, false)?.excludeFromSubSitches) return false;
        for (const category in this.subIncludes) {
            if (this.subSaveEnabled[category] && this.nodeMatchesCategory(nodeId, category)) {
                return true;
            }
        }
        return false;
    },

    shouldIncludeNodeForLoad(nodeId) {
        if (NodeMan.get(nodeId, false)?.excludeFromSubSitches) return false;
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

    getSubSitchNodes(all = false) {
        const nodeIds = [];

        NodeMan.iterate((id, node) => {
            if (node.modSerialize !== undefined) {
                if (all || this.shouldIncludeNodeForSave(id)) {
                    nodeIds.push(id);
                }
            }
        });

        return nodeIds;
    },

    captureSubSitchState(all = false) {
        const state = {
            frame: par.frame,
            events: structuredClone(this.timelineEvents || []),
            mods: {},
            focusTracks: {},
            lockTracks: {}
        };

        const nodeIds = this.getSubSitchNodes(all);

        for (const id of nodeIds) {
            const node = NodeMan.get(id, false);
            if (node && node.modSerialize) {
                const nodeMod = node.modSerialize();
                if (nodeMod.rootTestRemove !== undefined) {
                    delete nodeMod.rootTestRemove;
                }
                if (Object.keys(nodeMod).length > 0) {
                    state.mods[id] = structuredClone(nodeMod);
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

    restoreSubSitchState(state, all = false) {
        state = structuredClone(state);
        if (!state || !state.mods) return;

        // Older chapters captured PTZ/camera FOV but omitted the GUI input
        // that drives it. Restore that input too, or the next controller apply
        // immediately replaces the saved zoom with the outgoing chapter's zoom.
        const savedFOV = state.mods.ptzAngles?.fov ?? state.mods.lookCamera?.fov;
        if (!state.mods.fovUI && Number.isFinite(savedFOV) && NodeMan.exists("fovUI")) {
            state.mods.fovUI = {...NodeMan.get("fovUI").modSerialize(), value: savedFOV};
        }

        const previousRecalculate = Globals.dontRecalculate;
        Globals.dontRecalculate = true;
        try {
        // Exit the previous owner before changing view flags/geometry. View mods
        // deliberately defer fullscreen ownership until all views are restored.
        const restoresViews = Object.keys(state.mods).some(rawId => {
            const id = this.remapDeprecatedNodeId(rawId);
            return (all || this.shouldIncludeNodeForLoad(rawId) || this.shouldIncludeNodeForLoad(id)) && ViewMan.exists(id);
        });
        if (restoresViews) ViewMan.setFullscreenView(null);
        const restoredIds = [];
        for (const rawId in state.mods) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!all && !this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.mods[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node && node.modDeserialize) {
                node.modDeserialize(state.mods[rawId]);
                restoredIds.push(id);
            }
        }

        for (const rawId in state.focusTracks) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!all && !this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.focusTracks[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node) {
                node.focusTrackName = state.focusTracks[rawId];
            }
        }

        for (const rawId in state.lockTracks) {
            const id = this.remapDeprecatedNodeId(rawId);
            if (!all && !this.shouldIncludeNodeForLoad(rawId) && !this.shouldIncludeNodeForLoad(id)) continue;
            if (rawId !== id && state.lockTracks[id] !== undefined) continue;
            const node = NodeMan.get(id, false);
            if (node) {
                node.lockTrackName = state.lockTracks[rawId];
            }
        }

        if (restoresViews) ViewMan.restoreFullscreenFromMods();
        Globals.dontRecalculate = previousRecalculate;

        for (const id of restoredIds) {
            const node = NodeMan.get(id, false);
            if (node) {
                node.recalculateCascade();
            }
        }

        this.timelineEvents = structuredClone(state.events || []);
        if (Number.isFinite(state.frame)) {
            par.frame = Math.max(0, Math.min(Sit.frames - 1, Math.round(state.frame)));
            UIChangedFrame();
        }
        setRenderOne(true);
        } finally { Globals.dontRecalculate = previousRecalculate; }
    },

    pushNewSubSitch(state) {
        const newIndex = this.subSitches.length + 1;
        markSitchDirty();
        this.subSitches.push({
            name: "Chapter " + newIndex,
            state: state
        });

        this.currentSubIndex = this.subSitches.length - 1;
        this.rebuildSubSitchMenu();
    },

    updateSubSitch() {
        this.saveCurrentSubSitch();
    },

    updateAndAddSubSitch() {
        if (this.chapterBusy) return;
        this.saveCurrentSubSitch();
        this.pushNewSubSitch(this.captureSubSitchState());
    },

    discardAndAddSubSitch() {
        this.pushNewSubSitch(this.captureSubSitchState());
    },

    saveCurrentSubSitch() {
        if (this.subSitches.length > 0 && this.currentSubIndex >= 0) {
            const chapter = this.subSitches[this.currentSubIndex];
            chapter.state = this.captureSubSitchState(chapter.captureAll === true);
        }
    },

    switchToSubSitch(index) {
        if (index < 0 || index >= this.subSitches.length) return;
        if (index === this.currentSubIndex) return;

        if (this.chapterBusy) return;
        this.saveCurrentSubSitch();

        const outgoing = this.captureSubSitchState(true);
        try { this.restoreSubSitchState(this.subSitches[index].state); }
        catch (error) {
            try { this.restoreSubSitchState(outgoing, true); } catch (rollbackError) { console.error(rollbackError); }
            showError("Could not switch chapter. Your outgoing chapter is retained.", error);
            return;
        }
        this.currentSubIndex = index;

        this.rebuildSubSitchMenu();
    },

    async renameCurrentSubSitch() {
        if (this.chapterBusy || this.subSitches.length === 0) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
        const currentSub = this.subSitches[this.currentSubIndex];
        // showPrompt, not native prompt(): non-blocking, styled to match the app, and
        // it resolves to null under Globals.validationMode so headless runs don't hang.
        // Both callers (the menu item and the dblclick handler) ignore the promise.
        const newName = await showPrompt("Enter chapter name:", {
            title: "Rename chapter",
            defaultValue: currentSub.name,
        });

        if (generation !== Globals.loadGeneration) return;
        if (newName && newName.trim()) {
            markSitchDirty();
            currentSub.name = newName.trim();
            this.rebuildSubSitchMenu();
        }
        } finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    async deleteCurrentSubSitch() {
        if (this.chapterBusy) return;
        if (this.subSitches.length <= 1) {
            showError("Keep at least one chapter.");
            return;
        }

        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
        const currentSub = this.subSitches[this.currentSubIndex];
        if (!await showConfirm(`Delete "${currentSub.name}"?`, {title: "Delete chapter"})) return;

        if (generation !== Globals.loadGeneration) return;
        const outgoing = this.captureSubSitchState(true);
        const nextIndex = this.currentSubIndex === this.subSitches.length - 1 ? this.currentSubIndex - 1 : this.currentSubIndex + 1;
        try { this.restoreSubSitchState(this.subSitches[nextIndex].state); }
        catch (error) { this.restoreSubSitchState(outgoing, true); showError("Could not delete chapter; its state is retained.", error); return; }
        markSitchDirty();
        this.subSitches.splice(this.currentSubIndex, 1);
        this.currentSubIndex = nextIndex > this.currentSubIndex ? nextIndex - 1 : nextIndex;
        this.rebuildSubSitchMenu();
        } finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    rebuildSubSitchMenu() {
        for (const controller of this.subSitchControllers) {
            controller.destroy();
        }
        this.subSitchControllers = [];

        if (!this.chapterCards) return;
        this.chapterCards.replaceChildren();
        const note = document.createElement("div");
        note.textContent = "Chapters capture views, cameras, time and events. Other sitch content is shared. Edits stay in memory until File → Save.";
        note.style.cssText = "font-size:11px;line-height:1.5;color:#bbb";
        this.chapterCards.appendChild(note);
        this.subSitches.forEach((chapter, index) => {
            const card = document.createElement("button");
            const selected = index === this.currentSubIndex;
            card.textContent = `${selected ? "● " : ""}${chapter.name}`;
            card.setAttribute("aria-pressed", String(selected));
            card.style.cssText = `text-align:left;padding:12px;min-height:44px;height:auto;width:100%;border-radius:6px;border:1px solid ${selected ? "#72b5e8" : "#555"};background:${selected ? "#24415a" : "#303030"};color:white;cursor:pointer;white-space:normal`;
            card.onclick = () => this.switchToSubSitch(index);
            this.chapterCards.appendChild(card);
        });
        this.rebuildTimelineEvents();
    },

    rebuildTimelineEvents() {
        if (!this.timelineCards) return;
        this.timelineCards.replaceChildren();
        const title = document.createElement("div");
        title.textContent = "Timeline events · current chapter";
        this.timelineCards.appendChild(title);
        for (const event of [...(this.timelineEvents || [])].sort((a,b) => a.frame - b.frame)) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;gap:4px";
            const seek = document.createElement("button");
            seek.textContent = `${event.name} · frame ${event.frame}`;
            seek.style.cssText = "flex:1;min-width:0;width:auto;height:auto;min-height:36px;padding:8px;text-align:left;white-space:normal;background:#303030;border:1px solid #555;border-radius:5px;color:white;cursor:pointer";
            seek.onclick = () => { if (this.chapterBusy) return; par.frame = Math.max(0, Math.min(Sit.frames - 1, event.frame)); UIChangedFrame(); };
            const edit = document.createElement("button");
            edit.textContent = "Edit";
            edit.style.cssText = "flex:none;width:auto;height:auto;padding:6px;border:1px solid #555;border-radius:5px;color:white;background:#303030";
            edit.onclick = () => this.editTimelineEvent(event);
            row.append(seek, edit);
            this.timelineCards.appendChild(row);
        }
    },

    addPredictedTimelineEvents() {
        if (this.chapterBusy) return;
        const events = [];
        NodeMan.iterate((id, node) => {
            if (typeof node.updateEphemeris !== "function") return;
            node.updateEphemeris(true);
            for (const sat of node.nightSkyNode?.satellites?.TLEData?.satData || []) {
                if (!Number.isFinite(sat.cachedEventTime)) continue;
                const frame = Math.round(par.frame + (sat.cachedEventTime - GlobalDateTimeNode.dateNow.getTime()) * Sit.fps / (1000 * (Sit.simSpeed ?? 1)));
                if (frame < 0 || frame >= Sit.frames) continue;
                events.push({name:`${sat.name || sat.number} · ${sat.cachedEventRising ? "rise" : "set"} (estimated, 30 s samples)`, frame});
            }
        });
        if (!events.length) { showError("No predicted crossings within this chapter’s playback range. Open Satellite Ephemeris with satellite data loaded, then try again."); return; }
        markSitchDirty();
        this.timelineEvents ||= [];
        for (const event of events) {
            if (!this.timelineEvents.some(e => e.name === event.name && e.frame === event.frame)) this.timelineEvents.push(event);
        }
        this.saveCurrentSubSitch();
        this.rebuildTimelineEvents();
    },

    async addTimelineEvent() {
        if (this.chapterBusy) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        const frame = par.frame;
        try {
            const name = await showPrompt("Name this event (for example, flash begins)", {title:"Add timeline event"});
            if (generation !== Globals.loadGeneration || !name?.trim()) return;
            markSitchDirty();
            (this.timelineEvents ||= []).push({name:name.trim(), frame});
            this.saveCurrentSubSitch();
            this.rebuildTimelineEvents();
        } finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    async editTimelineEvent(event) {
        if (this.chapterBusy) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
            const name = await showPrompt("Event name (leave empty to delete)", {title:"Edit timeline event", defaultValue:event.name});
            if (generation !== Globals.loadGeneration || name === null) return;
            if (!name.trim()) {
                if (!await showConfirm(`Delete “${event.name}”?`, {title:"Delete event"})) return;
                if (generation !== Globals.loadGeneration) return;
                markSitchDirty();
                this.timelineEvents = this.timelineEvents.filter(e => e !== event);
            } else {
                const frame = await showPrompt("Frame", {title:"Event position", defaultValue:String(event.frame)});
                if (generation !== Globals.loadGeneration || frame === null) return;
                const number = Number(frame);
                if (!frame.trim() || !Number.isInteger(number) || number < 0 || number >= Sit.frames) {
                    showError(`Enter a whole frame between 0 and ${Sit.frames - 1}.`); return;
                }
                markSitchDirty();
                event.name = name.trim(); event.frame = number;
            }
            this.saveCurrentSubSitch();
            this.rebuildTimelineEvents();
        } finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    markChapterBaseline(serialized) {
        this.chapterBaseline = serialized || this.getCustomSitchString(true);
    },

    async revertSitchChapters() {
        if (this.chapterBusy || !this.chapterBaseline) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
            if (!await showConfirm("Discard all sitch edits since the last successful save or load?", {title:"Revert sitch"})) return;
            if (generation !== Globals.loadGeneration) return;
            const request = textSitchToObject(this.chapterBaseline);
            this.chapterRevertRequest = request;
            setNewSitchObject(request);
            // Keep chapter actions locked until setup of the reloaded sitch.
            return;
        } finally { if (generation === Globals.loadGeneration && !Globals.newSitchObject) this.chapterBusy = false; }
    },

    async loadChapterFile() {
        if (this.chapterBusy) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        const current = this.subSitches[this.currentSubIndex];
        try {
            const file = await new Promise(resolve => {
                const input = document.createElement("input");
                input.type = "file"; input.accept = ".json,.js";
                input.onchange = () => resolve(input.files[0] || null);
                input.oncancel = () => resolve(null);
                input.click();
            });
            if (!file || generation !== Globals.loadGeneration) return;
            const text = await file.text();
            if (generation !== Globals.loadGeneration) return;
            await this.restoreChapterFromData(textSitchToObject(text).subSitchesData, current, generation);
        } catch (error) { showError("Could not restore chapter from file.", error); }
        finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    async restoreChapterFromData(data, current, generation) {
        const chapters = data?.subSitches || [];
        if (!chapters.length) { showError("This save contains no chapters."); return; }
        const index = await this.chooseChapterOption("Choose chapter to restore", chapters.map(c => c.name));
        if (index === null || generation !== Globals.loadGeneration) return;
        const chapter = chapters[index];
        if (!chapter?.state?.mods) throw new Error("Invalid chapter state");
        if (!await showConfirm(`Load the state of “${chapter.name}” into “${current.name}”? A recovery chapter retains your current edits. Other chapters stay unchanged.`, {title:"Restore chapter"})) return;
        if (generation !== Globals.loadGeneration) return;
        this.saveCurrentSubSitch();
        const recovery = structuredClone(current);
        recovery.name += " (before restore)";
        // Recovery must remain complete when visited, switched away from or saved.
        recovery.captureAll = true;
        const outgoing = this.captureSubSitchState(true);
        recovery.state = structuredClone(outgoing);
        try { this.restoreSubSitchState(chapter.state); }
        catch (error) { this.restoreSubSitchState(outgoing, true); throw error; }
        this.subSitches.push(recovery);
        current.state = structuredClone(chapter.state);
        markSitchDirty();
        this.rebuildSubSitchMenu();
    },

    chooseChapterOption(title, labels) {
        if (Globals.validationMode) return Promise.resolve(null);
        return new Promise(resolve => {
            const dialog = document.createElement("dialog");
            dialog.style.cssText = "background:#25282b;color:#fff;border:1px solid #777;border-radius:10px;padding:20px;max-width:520px;width:80%;max-height:75vh";
            const heading = document.createElement("h3"); heading.textContent = title;
            const list = document.createElement("div"); list.style.cssText = "display:grid;gap:8px;max-height:50vh;overflow:auto";
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            labels.forEach((label,index) => {
                const button = document.createElement("button"); button.textContent = label;
                button.style.cssText = "padding:12px;text-align:left;white-space:normal;background:#343a40;border:1px solid #666;border-radius:5px;color:white;cursor:pointer";
                button.onclick = () => finish(index); list.appendChild(button);
            });
            const cancel = document.createElement("button"); cancel.textContent = "Cancel";
            cancel.style.cssText = "margin-top:16px;padding:8px 20px";
            cancel.onclick = () => finish(null);
            dialog.oncancel = event => { event.preventDefault(); finish(null); };
            dialog.append(heading,list,cancel); document.body.appendChild(dialog); dialog.showModal();
        });
    },

    async loadChapterVersion() {
        if (this.chapterBusy) return;
        this.chapterBusy = true;
        const current = this.subSitches[this.currentSubIndex];
        const generation = Globals.loadGeneration;
        try {
            const versions = await FileManager.getVersions(Sit.sitchName);
            if (generation !== Globals.loadGeneration) return;
            if (!versions?.length) { showError("No saved server versions. Use “Restore chapter from saved file…” to load a chapter from a local save."); return; }
            const choice = await this.chooseChapterOption("Choose saved version", [...versions].reverse().map(v => String(v.version || v.url || v.ref)));
            if (generation !== Globals.loadGeneration || choice === null) return;
            const version = versions[versions.length - 1 - choice];
            const response = await fetch(await resolveURLForFetch(version.ref || version.url));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (generation !== Globals.loadGeneration) return;
            const data = textSitchToObject(text).subSitchesData;
            await this.restoreChapterFromData(data, current, generation);
        } catch (error) { showError("Could not restore chapter.", error); }
        finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
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

        if (!Array.isArray(data.subSitches) || !data.subSitches.length) return;
        this.subSitches = structuredClone(data.subSitches);
        this.currentSubIndex = Math.max(0, Math.min(this.subSitches.length - 1, Number.isInteger(data.currentSubIndex) ? data.currentSubIndex : 0));

        if (this.subSitches.length > 0) {
            this.restoreSubSitchState(this.subSitches[this.currentSubIndex].state);
        }

        this.rebuildSubSitchMenu();
    },
};
