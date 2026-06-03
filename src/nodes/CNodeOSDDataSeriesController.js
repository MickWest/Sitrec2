import {CNode, CNodeConstant} from "./CNode";
import {guiMenus, NodeMan, registerFrameBlocker, setRenderOne, Sit, unregisterFrameBlocker} from "../Globals";
import {par} from "../par";
import {EventManager} from "../CEventManager";
import {CNodeOSDGraphView} from "./CNodeCurveEdit2";
import {CNodeOSDDataSeriesTrack} from "./CNodeOSDDataSeriesTrack";
import {CNodeDisplayTrack} from "./CNodeDisplayTrack";
import {CNode3DObject} from "./CNode3DObject";
import {Color} from "three";
import * as LAYER from "../LayerMasks";
import JSZip from "jszip";
import {saveAs} from "file-saver";
import {t} from "../i18n";
import {parseSingleCoordinate} from "../CoordinateParser";

const DEFAULT_X = 50;
const DEFAULT_Y = 20;
const PLACEHOLDER_TEXT = "?????";

const OSD_DATA_SERIES_TYPES = {
    "MGRS Zone": "MGRS Zone",
    "MGRS East": "MGRS East",
    "MGRS North": "MGRS North",
    "Latitude": "Latitude",
    "Longitude": "Longitude",
    "Altitude (m)": "Altitude (m)",
    "Altitude (ft)": "Altitude (ft)",
    "Slant Range": "Slant Range",
};

/*
 TODO:

- If the frame numberis changed externally, update the editing text to match the new frame's value for the active track, if any.
 the same as if the user had navigated to that frame using the [ and ] keys while editing.

 - Add "Type" field to each data series.
 This will allow for future expansion of different types of OSD data series,
 like MGRS grid squares, lat/lon coordinates, altitude, etc.
 - Use that to add a dynamic data series type that can use user-selected OSD data series as data sources
  this will allow real-time visualization of the track

- Add export of CSV position tracks, keyframe based, just interpolating where there's a keyframe in one OSD data series but not another

- Add import of CSV frame based data into OSD data series.

(Mick: make the merged higher qualiting 30 fps version before editing)

(seperately)
 - video zoom to match the way we can video zoom in the video sitch. This will be complex, so keep it separate


 */

class COSDDataSeries {
    constructor(controller, index) {
        this.controller = controller;
        this.index = index;
        this.name = `OSD Data Series ${index + 1}`;
        this.type = "MGRS Zone";
        this.show = true;
        this.lock = false;
        this.x = DEFAULT_X;
        this.y = DEFAULT_Y + index * 8;
        this.frameData = {};
        this.editing = false;
        this.guiFolder = null;
    }

    isKeyframe(frame) {
        const val = this.frameData[frame];
        return val !== undefined && val !== PLACEHOLDER_TEXT && val !== "";
    }
    
    getValue(frame) {
        if (this.isKeyframe(frame)) {
            return this.frameData[frame];
        }
        
        let prevFrame = frame - 1;
        while (prevFrame >= 0) {
            if (this.isKeyframe(prevFrame)) {
                return this.frameData[prevFrame];
            }
            prevFrame--;
        }
        
        return PLACEHOLDER_TEXT;
    }
    
    getDisplayInfo(frame) {
        if (this.isKeyframe(frame)) {
            return { value: this.frameData[frame], isKeyframe: true, direction: this.getKeyframeDirection(frame) };
        }
        
        let prevFrame = frame - 1;
        while (prevFrame >= 0) {
            if (this.isKeyframe(prevFrame)) {
                return { value: this.frameData[prevFrame], isKeyframe: false, direction: 0 };
            }
            prevFrame--;
        }
        
        return { value: PLACEHOLDER_TEXT, isKeyframe: false, direction: 0 };
    }

    getKeyframeDirection(frame) {
        const curVal = parseFloat(this.frameData[frame]);
        if (isNaN(curVal)) return 0;

        let prevFrame = frame - 1;
        while (prevFrame >= 0) {
            if (this.isKeyframe(prevFrame)) {
                const prevVal = parseFloat(this.frameData[prevFrame]);
                if (isNaN(prevVal)) return 0;
                if (curVal > prevVal) return 1;
                if (curVal < prevVal) return -1;
                return 0;
            }
            prevFrame--;
        }
        return 0;
    }

    setValue(frame, value) {
        this.frameData[frame] = value;
        this.controller.updateSliderStatus();
        this.controller.updateGraph();
        this.controller.updateDataTrack();
    }

    hasValue(frame) {
        return this.isKeyframe(frame);
    }
    
    getKeyframeStatusArray() {
        const status = new Array(Sit.frames).fill(0);
        for (let frame = 0; frame < Sit.frames; frame++) {
            if (this.isKeyframe(frame)) {
                status[frame] = 1;
            }
        }
        return status;
    }

    serialize() {
        return {
            name: this.name,
            type: this.type,
            show: this.show,
            lock: this.lock,
            x: this.x,
            y: this.y,
            frameData: {...this.frameData}
        };
    }

    deserialize(data) {
        this.name = data.name ?? this.name;
        this.type = data.type ?? "MGRS Zone";
        this.show = data.show ?? true;
        this.lock = data.lock ?? false;
        this.x = data.x ?? DEFAULT_X;
        this.y = data.y ?? DEFAULT_Y;
        this.frameData = data.frameData ?? {};
    }

    setupGUI(parentFolder) {
        this.guiFolder = parentFolder.addFolder(this.name).close();
        
        this.guiFolder.add(this, "name").name(t("osdController.seriesName.label")).listen()
            .onChange(() => {
                this.guiFolder.title(this.name);
                this.controller.rebuildGraphDropdowns();
            });

        this.guiFolder.add(this, "type", OSD_DATA_SERIES_TYPES).name(t("osdController.seriesType.label")).listen();

        this.guiFolder.add(this, "show").name(t("osdController.seriesShow.label")).listen()
            .onChange(() => {
                this.controller.updateVideoInfoVisibility();
                setRenderOne();
            });

        this.guiFolder.add(this, "lock").name(t("osdController.seriesLock.label")).listen()
            .onChange(() => {
                if (this.lock && this.controller.getEditingTrack() === this) {
                    this.controller.stopEditing();
                }
                setRenderOne();
            });

        this.guiFolder.add(this, "remove").name(t("osdController.removeTrack.label"));
    }

    remove() {
        this.controller.removeTrack(this);
    }

    disposeGUI() {
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
    }
}

export class CNodeOSDDataSeriesController extends CNode {
    constructor(v) {
        super(v);
        
        this.tracks = [];
        this.activeTrack = null;
        this.editingText = "";
        this.editingModified = false;
        this.cursorPos = 0;
        this.cursorBlinkEpoch = Date.now();
        this.showAll = true;
        this.dataTracks = {};
        
        this.boundHandleKeyDown = (e) => this.handleKeyDown(e);
        this.boundHandleDoubleClick = (e) => this.handleDoubleClick(e);
        this.guiMenu = guiMenus.video;
        this.setupMenu();
    }

    setupMenu() {
        this.guiFolder = guiMenus.video.addFolder(t("osdController.folderTitle.label")).close()
            .tooltip(t("osdController.folderTitle.tooltip"));

        this.guiFolder.add(this, "addNewTrack").name(t("osdController.addNewTrack.label"))
            .tooltip(t("osdController.addNewTrack.tooltip"));

        this.guiFolder.add(this, "makeTrack").name(t("osdController.makeTrack.label"))
            .tooltip(t("osdController.makeTrack.tooltip"));

        this.guiFolder.add(this, "showAll").name(t("osdController.showAll.label")).listen()
            .onChange(() => {
                for (const track of this.tracks) {
                    track.show = this.showAll;
                }
                // Re-evaluate the video-info overlay's visibility (matches the
                // per-series Show toggle); otherwise turning all series on never
                // un-hides the overlay if it was hidden.
                this.updateVideoInfoVisibility();
                setRenderOne();
            })
            .tooltip(t("osdController.showAll.tooltip"));

        this.guiFolder.add(this, "exportAllData").name(t("osdController.exportAllData.label"))
            .tooltip(t("osdController.exportAllData.tooltip"));

        EventManager.addEventListener("keydown", (data) => {
            if (data.key === '\\') {
                this.cycleEditingTrack();
            }
            if (data.keyCode === 'PageUp') {
                this.advanceToAnyKeyframe(-1);
            }
            if (data.keyCode === 'PageDown') {
                this.advanceToAnyKeyframe(1);
            }
        });

        this.graphView = null;
        this.graphSettings = { show: false, xAxis: "None", y1Axis: "None", y2Axis: "None" };
        this.graphFolder = this.guiFolder.addFolder("Graph").close();
        this.graphFolder.add(this.graphSettings, "show").name(t("osdController.graphShow.label")).listen()
            .tooltip(t("osdController.graphShow.tooltip"))
            .onChange(() => {
                if (this.graphSettings.show && this.graphView) {
                    this.graphView.show(true);
                }
                this.updateGraph();
            });
        this.xAxisCtrl = null;
        this.y1AxisCtrl = null;
        this.y2AxisCtrl = null;
        this.rebuildGraphDropdowns();
    }
    
    getGraphTrackOptions() {
        const opts = { "None": "None" };
        for (let i = 0; i < this.tracks.length; i++) {
            opts[this.tracks[i].name] = "OSD" + (i + 1);
        }
        return opts;
    }

    rebuildGraphDropdowns() {
        if (this.xAxisCtrl) this.xAxisCtrl.destroy();
        if (this.y1AxisCtrl) this.y1AxisCtrl.destroy();
        if (this.y2AxisCtrl) this.y2AxisCtrl.destroy();

        const trackOpts = this.getGraphTrackOptions();
        const osdOnly = { ...trackOpts };
        delete osdOnly["None"];
        const xOptions = { "None": "None", "Frame": "Frame", "Frame A→B": "FrameAB", ...osdOnly };
        const yOptions = trackOpts;

        const isValidX = (v) => Object.values(xOptions).includes(v);
        const isValidY = (v) => Object.values(yOptions).includes(v);
        this.graphSettings.xAxis = isValidX(this._storedX ?? "None") ? (this._storedX ?? "None") : "None";
        this.graphSettings.y1Axis = isValidY(this._storedY1 ?? "None") ? (this._storedY1 ?? "None") : "None";
        this.graphSettings.y2Axis = isValidY(this._storedY2 ?? "None") ? (this._storedY2 ?? "None") : "None";

        const onChange = () => {
            this._storedX = this.graphSettings.xAxis;
            this._storedY1 = this.graphSettings.y1Axis;
            this._storedY2 = this.graphSettings.y2Axis;
            this.updateGraph();
        };

        this.xAxisCtrl = this.graphFolder.add(this.graphSettings, "xAxis", xOptions).name(t("osdController.xAxis.label")).tooltip(t("osdController.xAxis.tooltip")).onChange(onChange);
        this.y1AxisCtrl = this.graphFolder.add(this.graphSettings, "y1Axis", yOptions).name(t("osdController.y1Axis.label")).tooltip(t("osdController.y1Axis.tooltip")).onChange(onChange);
        this.y2AxisCtrl = this.graphFolder.add(this.graphSettings, "y2Axis", yOptions).name(t("osdController.y2Axis.label")).tooltip(t("osdController.y2Axis.tooltip")).onChange(onChange);
    }

    getTrackNumericData(trackIndex, frameMin = 0, frameMax = Sit.frames - 1) {
        const track = this.tracks[trackIndex];
        if (!track) return [];
        const data = [];
        for (let f = frameMin; f <= frameMax; f++) {
            if (!track.isKeyframe(f)) continue;
            const val = track.frameData[f];
            if (!val || val === PLACEHOLDER_TEXT) continue;
            const num = this._parseNumericValue(val);
            if (!isNaN(num)) data.push({ frame: f, value: num });
        }
        return data;
    }

    getTrackInterpolatedData(trackIndex, frameMin = 0, frameMax = Sit.frames - 1) {
        const track = this.tracks[trackIndex];
        if (!track) return [];
        if (!this._isNumericSeries(track)) {
            return this.getTrackNumericData(trackIndex, frameMin, frameMax);
        }
        const arr = this._buildExpandedArray(track);
        const data = [];
        for (let f = frameMin; f <= frameMax; f++) {
            const v = arr[f];
            if (v !== null && v !== undefined && !isNaN(v)) {
                data.push({ frame: f, value: v });
            }
        }
        return data;
    }

    resolveAxisData(storedValue, frameMin, frameMax, interpolated = true) {
        if (storedValue === "None") return null;
        if (storedValue === "Frame" || storedValue === "FrameAB") {
            const data = [];
            for (let f = frameMin; f <= frameMax; f++) data.push({ frame: f, value: f });
            return data;
        }
        if (storedValue.startsWith("OSD")) {
            const idx = parseInt(storedValue.substring(3), 10) - 1;
            return interpolated
                ? this.getTrackInterpolatedData(idx, frameMin, frameMax)
                : this.getTrackNumericData(idx, frameMin, frameMax);
        }
        return null;
    }

    updateGraph() {
        const xStored = this._storedX ?? "None";
        const y1Stored = this._storedY1 ?? "None";
        const y2Stored = this._storedY2 ?? "None";

        if (!this.graphSettings.show || (y1Stored === "None" && y2Stored === "None")) {
            if (this.graphView) {
                this.graphView.show(false);
            }
            return;
        }

        if (!this.graphView) {
            this.graphView = new CNodeOSDGraphView({
                id: "osdGraphView",
                menuName: "OSD Graph",
                visible: true,
                left: 0, top: 0.5, width: 0.5, height: 0.5,
                draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
            });
        }

        const useFullRange = xStored === "None" || xStored === "Frame";
        const frameMin = useFullRange ? 0 : (Sit.aFrame ?? 0);
        const frameMax = useFullRange ? Sit.frames - 1 : (Sit.bFrame ?? Sit.frames - 1);

        const xData = this.resolveAxisData(xStored, frameMin, frameMax);
        const series = [];

        const buildSeries = (yStored, label, yAxis, interpolated) => {
            const yData = this.resolveAxisData(yStored, frameMin, frameMax, interpolated);
            if (!yData || yData.length === 0) return;

            const points = [];
            if (xData) {
                const xByFrame = {};
                for (const d of xData) xByFrame[d.frame] = d.value;
                for (const d of yData) {
                    if (xByFrame[d.frame] !== undefined) {
                        points.push({ x: xByFrame[d.frame], y: d.value, frame: d.frame });
                    }
                }
                if (xStored === "Frame" || xStored === "FrameAB") {
                    points.sort((a, b) => a.x - b.x);
                }
            } else {
                for (const d of yData) {
                    points.push({ x: d.frame, y: d.value, frame: d.frame });
                }
            }
            series.push({ data: points, label: label, yAxis: yAxis, raw: !interpolated });
        };

        const getLabel = (stored) => {
            if (stored === "Frame" || stored === "FrameAB") return "Frame";
            if (stored.startsWith("OSD")) {
                const idx = parseInt(stored.substring(3), 10) - 1;
                return this.tracks[idx] ? this.tracks[idx].name : stored;
            }
            return stored;
        };

        // For OSD-backed series, emit both an interpolated (blue) and a raw-keyframes (dashed red) variant.
        // Non-OSD selections (Frame, FrameAB) only get the single series.
        const emitPair = (yStored, yAxis) => {
            if (yStored === "None") return;
            buildSeries(yStored, getLabel(yStored), yAxis, true);
            if (yStored.startsWith("OSD")) {
                buildSeries(yStored, getLabel(yStored), yAxis, false);
            }
        };

        emitPair(y1Stored, 1);
        emitPair(y2Stored, 2);

        this.graphView.xLabel = xData ? getLabel(xStored) : "Frame";
        this.graphView.isFrameX = (xStored === "None" || xStored === "Frame" || xStored === "FrameAB");
        this.graphView.setSeries(series);
    }

    getVisibleSeriesMap() {
        const byType = {};
        const typeCounts = {};
        for (const track of this.tracks) {
            typeCounts[track.type] = (typeCounts[track.type] || 0) + 1;
        }
        for (const track of this.tracks) {
            if (typeCounts[track.type] > 1 && (!track.show || track.lock)) continue;
            byType[track.type] = track;
        }
        return byType;
    }

    getSeriesSignature(seriesMap) {
        const names = [];
        for (const [type, series] of Object.entries(seriesMap)) {
            names.push(type + ":" + series.name);
        }
        names.sort();
        return names.join("|");
    }

    makeTrackFromSignature(sig) {
        if (this.dataTracks[sig]) return;
        const seriesMap = {};
        for (const part of sig.split("|")) {
            const sep = part.indexOf(":");
            if (sep < 0) continue;
            const type = part.substring(0, sep);
            const name = part.substring(sep + 1);
            const series = this.tracks.find(t => t.type === type && t.name === name);
            if (series) seriesMap[type] = series;
        }
        const hasMGRS = seriesMap["MGRS Zone"] && seriesMap["MGRS East"] && seriesMap["MGRS North"];
        const hasLatLon = seriesMap["Latitude"] && seriesMap["Longitude"];
        if (!hasMGRS && !hasLatLon) return;
        this.makeTrackWithSeriesMap(seriesMap);
    }

    makeTrack() {
        const seriesMap = this.getVisibleSeriesMap();

        const hasMGRS = seriesMap["MGRS Zone"] && seriesMap["MGRS East"] && seriesMap["MGRS North"];
        const hasLatLon = seriesMap["Latitude"] && seriesMap["Longitude"];
        if (!hasMGRS && !hasLatLon) return;

        const sig = this.getSeriesSignature(seriesMap);

        if (this.dataTracks[sig]) {
            this.dataTracks[sig].track.recalculateCascade();
            return;
        }

        this.makeTrackWithSeriesMap(seriesMap);
    }

    makeTrackWithSeriesMap(seriesMap) {
        const sig = this.getSeriesSignature(seriesMap);
        if (this.dataTracks[sig]) return;

        const trackIndex = Object.keys(this.dataTracks).length;
        const trackID = "OSD_Track_" + trackIndex;
        const shortName = "OSD_" + trackIndex;
        const TRACK_COLORS = [
            new Color(1, 0.5, 0),
            new Color(0, 0.8, 1),
            new Color(0.2, 1, 0.2),
            new Color(1, 0.2, 0.8),
            new Color(1, 1, 0),
        ];
        const trackColor = TRACK_COLORS[trackIndex % TRACK_COLORS.length];

        const track = new CNodeOSDDataSeriesTrack({
            id: trackID,
            controller: this,
            seriesMap: seriesMap,
        });

        const display = new CNodeDisplayTrack({
            id: trackID + "_Display",
            track: trackID,
            dataTrack: trackID,
            color: new CNodeConstant({
                id: trackID + "_Color",
                value: trackColor,
                pruneIfUnused: true,
            }),
            width: 2,
            ignoreAB: true,
            trackDisplayStep: 1,
            layers: LAYER.MASK_HELPERS,
        });

        const sphere = new CNode3DObject({
            id: trackID + "_Sphere",
            object: "sphere",
            radius: 40,
            color: trackColor,
            label: shortName,
        });

        sphere.addController("TrackPosition", {
            sourceTrack: trackID,
        });

        sphere.addController("ObjectTilt", {
            track: trackID,
            tiltType: "banking",
        });

        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                if (NodeMan.exists(dropTargetSwitch)) {
                    const switchNode = NodeMan.get(dropTargetSwitch);
                    switchNode.removeOption(shortName);
                    switchNode.addOption(shortName, track);
                }
            }
        }

        this.dataTracks[sig] = { track, display, sphere, trackID, shortName, sig };

        NodeMan.recalculateAllRootFirst();
        setRenderOne(true);
    }

    updateDataTrack() {
        if (Object.keys(this.dataTracks).length === 0) return;
        if (this._dataTrackTimer) clearTimeout(this._dataTrackTimer);
        this._dataTrackTimer = setTimeout(() => {
            this._dataTrackTimer = null;
            for (const entry of Object.values(this.dataTracks)) {
                entry.track.recalculateCascade();
            }
            setRenderOne(true);
        }, 250);
    }

    cycleEditingTrack() {
        if (this.tracks.length === 0) return;
        
        const editableTracks = this.getEditableTracks();
        if (editableTracks.length === 0) return;
        
        if (!this.activeTrack) {
            this.startEditing(editableTracks[0]);
        } else {
            const currentIndex = editableTracks.indexOf(this.activeTrack);
            const nextIndex = (currentIndex + 1) % editableTracks.length;
            this.startEditing(editableTracks[nextIndex]);
        }
    }

    updateVideoInfoVisibility() {
        const videoInfo = NodeMan.get("videoInfo", false);
        if (videoInfo && videoInfo.updateVisibility) {
            videoInfo.updateVisibility();
        }
    }

    addNewTrack() {
        const track = new COSDDataSeries(this, this.tracks.length);
        this.tracks.push(track);
        track.setupGUI(this.guiFolder);
        this.updateSliderStatus();
        this.rebuildGraphDropdowns();
        this.updateVideoInfoVisibility();
        setRenderOne();
        return track;
    }

    removeTrack(track) {
        const index = this.tracks.indexOf(track);
        if (index !== -1) {
            if (this.activeTrack === track) {
                this.stopEditing();
            }
            track.disposeGUI();
            this.tracks.splice(index, 1);
            this.updateSliderStatus();
            this.rebuildGraphDropdowns();
            this.updateGraph();
            this.updateDataTrack();
            this.updateVideoInfoVisibility();
            setRenderOne();
        }
    }

    getVisibleTracks() {
        return this.tracks.filter(t => t.show);
    }

    getEditableTracks() {
        return this.tracks.filter(t => t.show && !t.lock);
    }
    
    updateSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (!slider) return;
        
        const status = new Array(Sit.frames).fill(0);
        for (const track of this.tracks) {
            if (!track.show) continue;
            for (let frame = 0; frame < Sit.frames; frame++) {
                if (track.isKeyframe(frame)) {
                    status[frame] = 1;
                }
            }
        }
        
        slider.setStatusOverlay(status, 2);
    }
    
    clearSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            slider.clearStatusOverlay();
        }
    }

    startEditing(track) {
        if (this.activeTrack === track) {
            return;
        }
        
        if (this.activeTrack) {
            this.stopEditing();
        }
        
        this.activeTrack = track;
        track.editing = true;
        const frame = Math.floor(par.frame);
        const value = track.getValue(frame);
        this.editingText = (value === PLACEHOLDER_TEXT) ? "" : value;
        this.editingModified = track.isKeyframe(frame);
        this.cursorPos = this.editingText.length;
        
        document.addEventListener('keydown', this.boundHandleKeyDown, true);
        
        registerFrameBlocker('osdDataSeriesEdit', {
            check: () => false,
            requiresSingleFrame: () => true
        });
        
        setRenderOne();
    }

    stopEditing() {
        if (!this.activeTrack) return;
        
        if (this.editingModified) {
            this.activeTrack.setValue(Math.floor(par.frame), this.editingText);
        }
        this.activeTrack.editing = false;
        this.activeTrack = null;
        this.editingText = "";
        this.editingModified = false;
        this.cursorPos = 0;
        
        document.removeEventListener('keydown', this.boundHandleKeyDown, true);
        unregisterFrameBlocker('osdDataSeriesEdit');
        
        setRenderOne();
    }

    handleKeyDown(e) {
        if (!this.activeTrack) return;
        
        e.preventDefault();
        e.stopPropagation();
        this.cursorBlinkEpoch = Date.now();
        
        const frame = Math.floor(par.frame);
        
        if (e.key === '[') {
            if (this.editingModified) {
                this.activeTrack.setValue(frame, this.editingText);
            }
            this.advanceFrame(-1);
            return;
        }
        
        if (e.key === ']') {
            if (this.editingModified) {
                this.activeTrack.setValue(frame, this.editingText);
            }
            this.advanceFrame(1);
            return;
        }
        
        if (e.key === 'PageUp') {
            if (this.editingModified) {
                this.activeTrack.setValue(frame, this.editingText);
            }
            this.advanceToAnyKeyframe(-1);
            return;
        }
        
        if (e.key === 'PageDown') {
            if (this.editingModified) {
                this.activeTrack.setValue(frame, this.editingText);
            }
            this.advanceToAnyKeyframe(1);
            return;
        }
        
        if (e.key === 'Tab') {
            this.cycleEditingTrack();
            return;
        }
        
        if (e.key === 'Escape') {
            this.stopEditing();
            return;
        }
        
        if (e.key === 'Enter') {
            this.stopEditing();
            return;
        }
        
        if (e.key === 'ArrowLeft') {
            if (this.cursorPos > 0) this.cursorPos--;
            setRenderOne();
            return;
        }
        
        if (e.key === 'ArrowRight') {
            if (this.cursorPos < this.editingText.length) this.cursorPos++;
            setRenderOne();
            return;
        }
        
        if (e.key === 'Home') {
            this.cursorPos = 0;
            setRenderOne();
            return;
        }
        
        if (e.key === 'End') {
            this.cursorPos = this.editingText.length;
            setRenderOne();
            return;
        }
        
        if (e.key === 'Backspace') {
            if (this.cursorPos > 0) {
                this.editingText = this.editingText.slice(0, this.cursorPos - 1) + this.editingText.slice(this.cursorPos);
                this.cursorPos--;
                this.editingModified = true;
                setRenderOne();
            }
            return;
        }
        
        if (e.key === 'Delete') {
            if (this.cursorPos < this.editingText.length) {
                this.editingText = this.editingText.slice(0, this.cursorPos) + this.editingText.slice(this.cursorPos + 1);
                this.editingModified = true;
                setRenderOne();
            }
            return;
        }
        
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            this.editingText = this.editingText.slice(0, this.cursorPos) + e.key + this.editingText.slice(this.cursorPos);
            this.cursorPos++;
            this.editingModified = true;
            setRenderOne();
        }
    }

    advanceFrame(delta) {
        const currentFrame = Math.floor(par.frame);
        
        const newFrame = Math.max(0, Math.min(Sit.frames - 1, currentFrame + delta));
        
        if (newFrame === currentFrame) return;
        
        const frameSlider = NodeMan.get("frameSlider", false);
        if (frameSlider) {
            frameSlider.setFrame(newFrame);
        } else {
            par.frame = newFrame;
        }
        
        if (this.activeTrack.isKeyframe(newFrame)) {
            this.editingText = this.activeTrack.frameData[newFrame];
            this.editingModified = false;
        } else {
            const value = this.activeTrack.getValue(newFrame);
            this.editingText = (value === PLACEHOLDER_TEXT) ? "" : value;
            this.editingModified = false;
        }
        this.cursorPos = this.editingText.length;
        
        setRenderOne();
    }

    advanceToAnyKeyframe(direction) {
        const currentFrame = Math.floor(par.frame);
        let targetFrame = -1;

        if (direction < 0) {
            for (let f = currentFrame - 1; f >= 0; f--) {
                if (this.tracks.some(t => t.isKeyframe(f))) {
                    targetFrame = f;
                    break;
                }
            }
        } else {
            for (let f = currentFrame + 1; f < Sit.frames; f++) {
                if (this.tracks.some(t => t.isKeyframe(f))) {
                    targetFrame = f;
                    break;
                }
            }
        }

        if (targetFrame < 0) return;

        const frameSlider = NodeMan.get("frameSlider", false);
        if (frameSlider) {
            frameSlider.setFrame(targetFrame);
        } else {
            par.frame = targetFrame;
        }

        if (this.activeTrack) {
            if (this.activeTrack.isKeyframe(targetFrame)) {
                this.editingText = this.activeTrack.frameData[targetFrame];
                this.editingModified = false;
            } else {
                const value = this.activeTrack.getValue(targetFrame);
                this.editingText = (value === PLACEHOLDER_TEXT) ? "" : value;
                this.editingModified = false;
            }
            this.cursorPos = this.editingText.length;
        }

        setRenderOne();
    }

    handleDoubleClick(e) {
    }

    isEditing() {
        return this.activeTrack !== null;
    }

    getEditingTrack() {
        return this.activeTrack;
    }

    getEditingText() {
        return this.editingText;
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            showAll: this.showAll,
            trackSignatures: Object.keys(this.dataTracks),
            tracks: this.tracks.map(t => t.serialize()),
            graph: {
                show: this.graphSettings.show,
                xAxis: this._storedX ?? "None",
                y1Axis: this._storedY1 ?? "None",
                y2Axis: this._storedY2 ?? "None",
            }
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        
        if (v.showAll !== undefined) {
            this.showAll = v.showAll;
        }
        
        if (v.tracks && Array.isArray(v.tracks)) {
            for (const track of this.tracks) {
                track.disposeGUI();
            }
            this.tracks = [];
            
            for (const trackData of v.tracks) {
                const track = new COSDDataSeries(this, this.tracks.length);
                track.deserialize(trackData);
                this.tracks.push(track);
                track.setupGUI(this.guiFolder);
            }
            
            this.updateSliderStatus();
            this.rebuildGraphDropdowns();
        }

        if (v.graph) {
            this.graphSettings.show = v.graph.show ?? false;
            this._storedX = v.graph.xAxis ?? "None";
            this._storedY1 = v.graph.y1Axis ?? "None";
            this._storedY2 = v.graph.y2Axis ?? "None";
            this.rebuildGraphDropdowns();
            this.updateGraph();
        }

        if (v.hasTrack) {
            this.makeTrack();
        } else if (v.trackSignatures && v.trackSignatures.length > 0) {
            for (const sig of v.trackSignatures) {
                this.makeTrackFromSignature(sig);
            }
        }

        this.updateDataTrack();
        this.updateVideoInfoVisibility();
    }

    disposeDataTrack(sig) {
        if (sig) {
            const entry = this.dataTracks[sig];
            if (!entry) return;
            this.disposeDataTrackEntry(entry);
            delete this.dataTracks[sig];
            return;
        }
        for (const entry of Object.values(this.dataTracks)) {
            this.disposeDataTrackEntry(entry);
        }
        this.dataTracks = {};
    }

    disposeDataTrackEntry(entry) {
        if (Sit.dropTargets !== undefined && Sit.dropTargets["track"] !== undefined) {
            const dropTargets = Sit.dropTargets["track"];
            for (let dropTargetSwitch of dropTargets) {
                const match = dropTargetSwitch.match(/-(\d+)$/);
                if (match !== null) {
                    dropTargetSwitch = dropTargetSwitch.substring(0, dropTargetSwitch.length - match[0].length);
                }
                if (NodeMan.exists(dropTargetSwitch)) {
                    NodeMan.get(dropTargetSwitch).removeOption(entry.shortName);
                }
            }
        }
        NodeMan.unlinkDisposeRemove(entry.trackID + "_Sphere");
        NodeMan.unlinkDisposeRemove(entry.trackID + "_Display");
        NodeMan.unlinkDisposeRemove(entry.trackID + "_Color");
        NodeMan.unlinkDisposeRemove(entry.trackID);
    }

    _isNumericSeries(track) {
        for (let f = 0; f < Sit.frames; f++) {
            if (track.isKeyframe(f)) {
                if (isNaN(this._parseNumericValue(track.frameData[f]))) return false;
            }
        }
        return true;
    }

    _parseNumericValue(val) {
        let num = parseFloat(val);
        if (isNaN(num)) {
            const parsed = parseSingleCoordinate(val);
            if (parsed !== null) num = parsed;
        }
        return num;
    }

    _buildExpandedArray(track) {
        if (this._isNumericSeries(track)) {
            // Replicate expandLerp logic
            const kfs = [];
            for (let f = 0; f < Sit.frames; f++) {
                if (track.isKeyframe(f)) {
                    const num = this._parseNumericValue(track.frameData[f]);
                    if (!isNaN(num)) kfs.push({frame: f, value: num});
                }
            }
            const n = kfs.length;
            if (n === 0) return new Array(Sit.frames).fill(null);
            if (n === 1) return new Array(Sit.frames).fill(kfs[0].value);

            const first = kfs[0], second = kfs[1];
            const last = kfs[n - 1], prevLast = kfs[n - 2];
            const slopeStart = (second.value - first.value) / (second.frame - first.frame);
            const slopeEnd = (last.value - prevLast.value) / (last.frame - prevLast.frame);

            const arr = new Array(Sit.frames);
            for (let f = 0; f < Sit.frames; f++) {
                if (f <= first.frame) {
                    arr[f] = first.value + slopeStart * (f - first.frame);
                } else if (f >= last.frame) {
                    arr[f] = last.value + slopeEnd * (f - last.frame);
                } else {
                    let lo = 0, hi = n - 1;
                    while (lo < hi - 1) {
                        const mid = (lo + hi) >> 1;
                        if (kfs[mid].frame <= f) lo = mid; else hi = mid;
                    }
                    const prev = kfs[lo], next = kfs[hi];
                    const t = (f - prev.frame) / (next.frame - prev.frame);
                    arr[f] = prev.value + t * (next.value - prev.value);
                }
            }
            return arr;
        } else {
            // Replicate expandStepped logic
            const arr = new Array(Sit.frames).fill(null);
            let last = null;
            for (let f = 0; f < Sit.frames; f++) {
                if (track.isKeyframe(f)) last = track.frameData[f];
                arr[f] = last;
            }
            if (arr[0] === null) {
                const first = arr.find(v => v !== null);
                if (first !== null && first !== undefined) {
                    for (let f = 0; f < Sit.frames; f++) {
                        if (arr[f] !== null) break;
                        arr[f] = first;
                    }
                }
            }
            return arr;
        }
    }

    exportAllData() {
        if (this.tracks.length === 0) return;

        const zip = new JSZip();

        // A-B range (original frame numbers preserved)
        const fMin = Sit.aFrame ?? 0;
        const fMax = Sit.bFrame ?? (Sit.frames - 1);

        // Sim time: nowMS = startMS + frame * 1000 * simSpeed / fps
        const startMS = new Date(Sit.startTime).getTime();
        const simSpeed = Sit.simSpeed ?? 1;
        const frameToEpoch = (f) => Math.round(startMS + f * 1000 * simSpeed / Sit.fps);

        // a) Individual per-series CSVs (keyframes only)
        for (const track of this.tracks) {
            let csv = "Frame,Time,Epoch,DateTime," + track.name + "\n";
            for (let f = fMin; f <= fMax; f++) {
                if (track.isKeyframe(f)) {
                    const time = (f / Sit.fps).toFixed(4);
                    const epoch = frameToEpoch(f);
                    const datetime = new Date(epoch).toISOString();
                    csv += f + "," + time + "," + epoch + "," + datetime + "," + track.frameData[f] + "\n";
                }
            }
            zip.file(track.name + ".csv", csv);
        }

        // Build expanded arrays for all tracks (used by combined CSVs)
        const expandedArrays = this.tracks.map(track => this._buildExpandedArray(track));

        // Shared header for combined CSVs
        const combinedHeader = "Frame,Time,Epoch,DateTime," + this.tracks.map(t => t.name).join(",") + "\n";

        // Helper to build a row from expanded arrays at a given frame
        const buildRow = (f) => {
            const time = (f / Sit.fps).toFixed(4);
            const epoch = frameToEpoch(f);
            const datetime = new Date(epoch).toISOString();
            const values = expandedArrays.map(arr => {
                const v = arr[f];
                return v !== null && v !== undefined ? v : "";
            });
            return f + "," + time + "," + epoch + "," + datetime + "," + values.join(",") + "\n";
        };

        // b) Every Keyframe combined CSV
        const keyframeFrames = new Set();
        for (const track of this.tracks) {
            for (let f = fMin; f <= fMax; f++) {
                if (track.isKeyframe(f)) keyframeFrames.add(f);
            }
        }
        const sortedKeyframeFrames = [...keyframeFrames].sort((a, b) => a - b);

        {
            let csv = combinedHeader;
            for (const f of sortedKeyframeFrames) csv += buildRow(f);
            zip.file("EveryKeyframe.csv", csv);
        }

        // c) Every Second CSV
        {
            let csv = combinedHeader;
            // Start from the first whole-second boundary at or after fMin
            const startSec = Math.ceil(fMin / Sit.fps);
            for (let sec = startSec; ; sec++) {
                const f = Math.round(sec * Sit.fps);
                if (f > fMax) break;
                csv += buildRow(f);
            }
            zip.file("EverySecond.csv", csv);
        }

        // d) Every Frame CSV
        {
            let csv = combinedHeader;
            for (let f = fMin; f <= fMax; f++) csv += buildRow(f);
            zip.file("EveryFrame.csv", csv);
        }

        // d) ZIP and download
        zip.generateAsync({type: "blob"}).then(blob => {
            saveAs(blob, "OSDData.zip");
        });
    }

    dispose() {
        this.stopEditing();
        this.clearSliderStatus();
        this.disposeDataTrack();
        if (this.graphView) {
            NodeMan.unlinkDisposeRemove(this.graphView.id);
            this.graphView = null;
        }
        for (const track of this.tracks) {
            track.disposeGUI();
        }
        this.tracks = [];
        if (this.guiFolder) {
            this.guiFolder.destroy();
        }
        super.dispose();
    }
}
