/**
 * Sitch chapters: capture, restore, switch and serialize the chapters of a custom sitch
 * (File → Sitch Chapters). A chapter holds its own views, cameras, time and timeline
 * markers; the rest of the sitch is shared. In code and in saved sitches a chapter is a
 * "sub sitch" (subSitches, subSitchesData).
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
import {showChoice, showError, showConfirm, showPrompt} from "./showError";
import {TimelineMarkers} from "./TimelineMarkers";
import {editTimelineMarkers} from "./TimelineMenu";
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
        this.chapterRevertRequest = null;
        this.chapterBusy = false;
        // The sitch text after the last load or successful save, for Revert. The end of every
        // custom sitch load (finishDeserialization) and every successful save set it.
        this.chapterBaseline = null;

        const folderName = t("custom.chapters.folder.label");
        this.subSitchFolder = guiMenus.file.addFolder(folderName).close()
            .tooltip(t("custom.chapters.folder.tooltip"));
        FileManager?.fileTweaksFolder?.moveAfter(folderName);
        this.subSitchFolder.add(this, "updateAndAddSubSitch").name(t("custom.chapters.addChapter.label"))
            .tooltip(t("custom.chapters.addChapter.tooltip"));
        this.subSitchFolder.add(this, "renameCurrentSubSitch").name(t("custom.chapters.renameChapter.label"))
            .tooltip(t("custom.chapters.renameChapter.tooltip"));
        this.subSitchFolder.add(this, "deleteCurrentSubSitch").name(t("custom.chapters.deleteChapter.label"))
            .tooltip(t("custom.chapters.deleteChapter.tooltip"));
        this.subSitchFolder.add(this, "revertSitchChapters").name(t("custom.chapters.revert.label"))
            .tooltip(t("custom.chapters.revert.tooltip"));
        this.subSitchFolder.add(this, "loadChapterVersion").name(t("custom.chapters.restoreFromServer.label"))
            .tooltip(t("custom.chapters.restoreFromServer.tooltip"));
        this.subSitchFolder.add(this, "loadChapterFile").name(t("custom.chapters.restoreFromFile.label"))
            .tooltip(t("custom.chapters.restoreFromFile.tooltip"));
        // One button per chapter, rebuilt by rebuildSubSitchMenu.
        this.chapterListFolder = this.subSitchFolder.addFolder(t("custom.chapters.list.label"))
            .tooltip(t("custom.chapters.list.tooltip"));
        this.subSitchFolder.add(this, "addSatelliteMarkers").name(t("custom.chapters.satelliteMarkers.label"))
            .tooltip(t("custom.chapters.satelliteMarkers.tooltip"));
        this.setupSubSitchDetails();
        this.initializeFirstSubSitch();
    },

    initializeFirstSubSitch() {
        const state = this.captureSubSitchState();
        this.subSitches.push({
            name: t("custom.chapters.defaultName", {number: 1}),
            state: state
        });
        this.currentSubIndex = 0;
        this.rebuildSubSitchMenu();
    },

    setupSubSitchDetails() {
        // The kinds of data that a chapter captures and restores.
        // Format: kind: [defaultOn, ...patterns]
        // - defaultOn: 1 = enabled by default, 0 = disabled by default
        // - patterns: exact node ID match, or *pattern* for case-insensitive includes
        // The timeline markers are not nodes, so their kind has no patterns.
        this.subIncludes = {
            views: [1, "mainView", "lookView", "video", "chatView", "*View*"],
            cameras: [1, "mainCamera", "lookCamera", "fixedCameraPosition", "ptzAngles", "fovUI", "fovSwitch", "anglesSwitch", "angelsSwitch", "*Camera*"],
            dateTime: [1, "dateTimeStart", "*DateTime*"],
            measurement: [1, "globalMeasureA", "globalMeasureB"],
            markers: [1],
            others: [0, "lighting", "*Lighting*", "*Effect*", "*Target*", "targetObject", "traverseObject"]
        };

        this.subSaveEnabled = {};
        this.subLoadEnabled = {};
        for (const kind in this.subIncludes) {
            this.subSaveEnabled[kind] = this.subIncludes[kind][0] === 1;
            this.subLoadEnabled[kind] = true;
        }

        this.subSaveFolder = this.subSitchFolder.addFolder(t("custom.chapters.captureScope.label")).close()
            .tooltip(t("custom.chapters.captureScope.tooltip"));
        for (const kind in this.subIncludes) {
            this.subSaveFolder.add(this.subSaveEnabled, kind).name(t(`custom.chapters.scope.${kind}`)).listen()
                .tooltip(t("custom.chapters.captureScope.item"));
        }

        this.subLoadFolder = this.subSitchFolder.addFolder(t("custom.chapters.restoreScope.label")).close()
            .tooltip(t("custom.chapters.restoreScope.tooltip"));
        for (const kind in this.subIncludes) {
            this.subLoadFolder.add(this.subLoadEnabled, kind).name(t(`custom.chapters.scope.${kind}`)).listen()
                .tooltip(t("custom.chapters.restoreScope.item"));
        }
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
        // A node can belong to the whole sitch rather than to each chapter.
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

    // The state of the current chapter: the frame, the timeline markers (when the capture
    // scope includes them) and the mods of the nodes in the capture scope. all = true
    // captures every kind of data, whatever the scope.
    captureSubSitchState(all = false) {
        const state = {
            frame: par.frame,
            mods: {},
            focusTracks: {},
            lockTracks: {}
        };
        if (all || this.subSaveEnabled.markers) state.markers = TimelineMarkers.snapshot();

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

    // Apply a chapter state, limited to the restore scope. A state without markers (captured
    // with the markers out of scope) leaves the current markers as they are.
    restoreSubSitchState(state) {
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
        // Exit the previous owner before changing view flags/geometry. View mods
        // deliberately defer fullscreen ownership until all views are restored.
        const restoresViews = Object.keys(state.mods).some(rawId => {
            const id = this.remapDeprecatedNodeId(rawId);
            return (this.shouldIncludeNodeForLoad(rawId) || this.shouldIncludeNodeForLoad(id)) && ViewMan.exists(id);
        });
        if (restoresViews) ViewMan.setFullscreenView(null);
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

        if (restoresViews) ViewMan.restoreFullscreenFromMods();
        Globals.dontRecalculate = previousRecalculate;

        for (const id of restoredIds) {
            const node = NodeMan.get(id, false);
            if (node) {
                node.recalculateCascade();
            }
        }

        if (Array.isArray(state.markers) && this.subLoadEnabled.markers) {
            TimelineMarkers.restore(state.markers);
        }
        if (Number.isFinite(state.frame)) {
            par.frame = Math.max(0, Math.min(Sit.frames - 1, Math.round(state.frame)));
            UIChangedFrame();
        }
        // Undo records hold state from before this restore (for example the markers of the
        // chapter that was showing), so they must not apply to the restored chapter.
        UndoManager?.clear();
        setRenderOne(true);
    },

    pushNewSubSitch(state) {
        markSitchDirty();
        this.subSitches.push({
            name: t("custom.chapters.defaultName", {number: this.subSitches.length + 1}),
            state: state
        });

        this.currentSubIndex = this.subSitches.length - 1;
        this.rebuildSubSitchMenu();
    },

    updateAndAddSubSitch() {
        if (this.chapterBusy) return;
        this.saveCurrentSubSitch();
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
        this.restoreSubSitchState(this.subSitches[index].state);
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
            const newName = await showPrompt(t("custom.chapters.renamePrompt"), {
                title: t("custom.chapters.renameTitle"),
                defaultValue: currentSub.name,
            });

            if (generation !== Globals.loadGeneration) return;
            if (newName && newName.trim()) {
                markSitchDirty();
                currentSub.name = newName.trim();
                this.rebuildSubSitchMenu();
            }
        } finally {
            if (generation === Globals.loadGeneration) this.chapterBusy = false;
        }
    },

    async deleteCurrentSubSitch() {
        if (this.chapterBusy) return;
        if (this.subSitches.length <= 1) {
            showError(t("custom.chapters.keepOne"));
            return;
        }

        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
            const currentSub = this.subSitches[this.currentSubIndex];
            if (!await showConfirm(t("custom.chapters.deleteConfirm", {name: currentSub.name}),
                {title: t("custom.chapters.deleteTitle")})) return;
            if (generation !== Globals.loadGeneration) return;

            const nextIndex = this.currentSubIndex === this.subSitches.length - 1 ? this.currentSubIndex - 1 : this.currentSubIndex + 1;
            this.restoreSubSitchState(this.subSitches[nextIndex].state);
            markSitchDirty();
            this.subSitches.splice(this.currentSubIndex, 1);
            this.currentSubIndex = nextIndex > this.currentSubIndex ? nextIndex - 1 : nextIndex;
            this.rebuildSubSitchMenu();
        } finally {
            if (generation === Globals.loadGeneration) this.chapterBusy = false;
        }
    },

    // One button per chapter in the Chapters folder; "● " marks the current one. They are
    // ordinary lil-gui controls, so a floating copy of the menu and the Sitrec API can use them.
    rebuildSubSitchMenu() {
        for (const controller of [...this.chapterListFolder.controllers]) {
            controller.destroy();
        }
        this.subSitches.forEach((chapter, index) => {
            const current = index === this.currentSubIndex;
            this.chapterListFolder.add({switchChapter: () => this.switchToSubSitch(index)}, "switchChapter")
                .name(current ? "● " + chapter.name : chapter.name);
        });
    },

    // Add a timeline marker at each rise and each set, between the first and the last frame,
    // of each satellite shown in the sky. Like any marker, they belong to the current chapter.
    addSatelliteMarkers() {
        const ephemeris = NodeMan.get("ephemerisView", false);
        if (!ephemeris) {
            showError(t("custom.chapters.noSatelliteData"));
            return;
        }
        const crossings = ephemeris.horizonCrossings(GlobalDateTimeNode.frameToMS(0), GlobalDateTimeNode.frameToMS(Sit.frames - 1));
        if (!crossings.length) {
            showError(t("custom.chapters.noCrossings"));
            return;
        }
        const entries = crossings.map(({sat, timeMS, rising}) => ({
            frame: GlobalDateTimeNode.msToFrame(timeMS),
            label: t(rising ? "custom.chapters.satelliteRises" : "custom.chapters.satelliteSets", {name: sat.name || sat.number}),
        }));
        editTimelineMarkers(t("custom.chapters.satelliteMarkers.label"), () => TimelineMarkers.addPredicted(entries));
    },

    markChapterBaseline(serialized) {
        this.chapterBaseline = serialized || this.getCustomSitchString(true);
    },

    async revertSitchChapters() {
        if (this.chapterBusy || !this.chapterBaseline) return;
        this.chapterBusy = true;
        const generation = Globals.loadGeneration;
        try {
            if (!await showConfirm(t("custom.chapters.revertConfirm"), {title: t("custom.chapters.revertTitle")})) return;
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
        } catch (error) { showError(t("custom.chapters.restoreFileError"), error); }
        finally { if (generation === Globals.loadGeneration) this.chapterBusy = false; }
    },

    async restoreChapterFromData(data, current, generation) {
        const chapters = data?.subSitches || [];
        if (!chapters.length) { showError(t("custom.chapters.noChapters")); return; }
        const index = await this.chooseChapterOption(t("custom.chapters.chooseChapter"), chapters.map(chapter => chapter.name));
        if (index === null || generation !== Globals.loadGeneration) return;
        const chapter = chapters[index];
        if (!chapter?.state?.mods) throw new Error(t("custom.chapters.invalidState"));
        if (!await showConfirm(t("custom.chapters.restoreConfirm", {source: chapter.name, target: current.name}),
            {title: t("custom.chapters.restoreTitle")})) return;
        if (generation !== Globals.loadGeneration) return;
        this.saveCurrentSubSitch();
        // The recovery chapter keeps everything that the restore can overwrite, so it
        // captures every kind of data, now and whenever it is visited, left or saved.
        const recovery = structuredClone(current);
        recovery.name = t("custom.chapters.recoveryName", {name: current.name});
        recovery.captureAll = true;
        recovery.state = this.captureSubSitchState(true);
        this.restoreSubSitchState(chapter.state);
        this.subSitches.push(recovery);
        current.state = structuredClone(chapter.state);
        markSitchDirty();
        this.rebuildSubSitchMenu();
    },

    // Ask which of `labels` to use. Resolves to its index, or null when cancelled.
    chooseChapterOption(message, labels) {
        return showChoice(message, {
            title: t("custom.chapters.chooseTitle"),
            options: [
                ...labels.map((label, index) => ({label, value: index})),
                {label: t("custom.chapters.cancel"), value: null, cancel: true},
            ],
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
            if (!versions?.length) { showError(t("custom.chapters.noServerVersions")); return; }
            const choice = await this.chooseChapterOption(t("custom.chapters.chooseVersion"), [...versions].reverse().map(v => String(v.version || v.url || v.ref)));
            if (generation !== Globals.loadGeneration || choice === null) return;
            const version = versions[versions.length - 1 - choice];
            const response = await fetch(await resolveURLForFetch(version.ref || version.url));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (generation !== Globals.loadGeneration) return;
            const data = textSitchToObject(text).subSitchesData;
            await this.restoreChapterFromData(data, current, generation);
        } catch (error) { showError(t("custom.chapters.restoreError"), error); }
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
        if (!data?.subSitches?.length) return;
        this.subSitches = structuredClone(data.subSitches);
        this.currentSubIndex = data.currentSubIndex ?? 0;
        this.restoreSubSitchState(this.subSitches[this.currentSubIndex].state);
        this.rebuildSubSitchMenu();
    },
};
