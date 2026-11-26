// Delete Object (CustomManager.deleteObject), which is the one way to remove a user-made object,
// and the paths that come to it: Delete Track's "Delete Track and Object"
// (TrackManager.confirmDeleteSyntheticTrack) and Remove All Tracks (CustomManager.removeAllTracks).
// The undo of Add Object comes to it too: createObjectUndo.test.js. The real methods are taken
// from their classes (the modules themselves import the whole scene) and run against a real
// node manager.

import fs from "fs";
import {UndoManager} from "../src/UndoManager";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CNode} from "../src/nodes/CNode";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {CManager} from "../src/CManager";
import {setFileManager, setNodeMan, setSit} from "../src/Globals";
import {isUserMadeObjectId, ownedSubNodeIds} from "../src/UserObjects";
import {unlistManualObject} from "../src/TrackSelectors";
import {captureNodeMods, restoreNodeMods} from "../src/SceneEditState";
import {hasOtherTrackSourceReference} from "../src/trackSourceUtils";
import {t} from "../src/i18n";

class TestNode extends CNode {
    getValueFrame() { return 0; }
}

// Stands in for CNode3DObject: Remove All Tracks finds the objects by their class.
class TestObject extends TestNode {}

// The named methods of one class in a source file, as a prototype object.
function classMethods(file, className, methodNames, context) {
    const source = fs.readFileSync(require.resolve(file), "utf8");
    const code = transformSync(source, {configFile: false, plugins: [() => ({visitor: {Program(path) {
        const statement = path.node.body.find(node => (node.declaration ?? node).id?.name === className);
        const declaration = statement.declaration ?? statement;
        declaration.body.body = declaration.body.body.filter(member => methodNames.includes(member.key?.name));
        path.node.body = [declaration];
    }}})]}).code;
    vm.createContext(context);
    vm.runInContext(`${code};globalThis.extracted=${className}.prototype;`, context);
    return context.extracted;
}

let nodeMan;
let context;
let customManager;
let trackManager;

beforeEach(() => {
    nodeMan = new CNodeManager();
    setNodeMan(nodeMan);
    setFileManager({removeExportButton: () => {}});
    setSit({dropTargets: {track: []}});
    context = {
        console, t, undoManager: new UndoManager(), NodeMan: nodeMan, CManager, ownedSubNodeIds, isUserMadeObjectId, unlistManualObject,
        CNode3DObject: TestObject,
        EventManager: {removeEventListener: jest.fn()},
        Globals: {menuBar: {persistentMenus: []}},
        requestCameraFocusSync: jest.fn(),
        setRenderOne: jest.fn(),
        showChoice: jest.fn(),
        showConfirm: jest.fn(),
    };
    const trackMethods = classMethods("../src/TrackManager.js", "CTrackManager",
        ["objectForTrack", "detachObject", "trackForObject", "confirmDeleteSyntheticTrack", "deleteSyntheticTrackWithUndo",
            "deleteImportedTrackWithUndo", "captureImportedTrackForUndo", "addTracks", "captureImportSettings", "recordTrackImport",
            "disposeRemove"], context);
    trackManager = Object.assign(Object.create(trackMethods), new CManager());
    trackManager.disposeSyntheticTrack = jest.fn(id => trackManager.remove(id));
    trackManager.captureSyntheticTrackForUndo = track => {
        const state = {...track};
        return () => trackManager.add(state.trackID, {...state});
    };
    context.TrackManager = trackManager;
    context.CustomManager = customManager = Object.create(classMethods("../src/CustomSupport.js", "CCustomManager",
        ["clearEditingObject", "disposeObjectWithControllers", "deleteObject", "removeAllTracks"], context));
});

// A user-made object the way Add Object leaves it: the object, a sub-node it owns, a controller
// input, a fixed position node, an open panel, and a track that it rides.
function makeObjectOnTrack() {
    const position = new TestNode({id: "syntheticObject_100_position"});
    const size = new TestNode({id: "syntheticObject_100_size"});
    const controller = new TestNode({id: "syntheticObject_100_ControllerTrackPosition"});
    controller.isController = true;
    const object = new TestObject({id: "syntheticObject_100"});
    object.addInput("size", size);
    object.addInput("controller", controller);
    object.displayName = "Object 1";
    object.gui = {};
    object.fixedObjectPositionID = position.id;
    const otherObject = new TestObject({id: "syntheticObject_1000"});
    new TestNode({id: "syntheticObject_1000_size"});
    const panel = {_mirrorSource: object.gui, destroy: jest.fn()};
    context.Globals.menuBar.persistentMenus.push(panel);
    customManager.editingObjectNodeId = object.id;
    // nameShared: as a balloon or kite pair has it. A track without its object has none.
    const track = {trackID: "syntheticTrack_100", objectID: object.id, nameShared: true};
    trackManager.add(track.trackID, track);
    return {object, otherObject, panel, track};
}

test("Delete Object removes every node the object made, closes its panel, and detaches its track", () => {
    const {object, panel, track} = makeObjectOnTrack();
    const madeByObject = () => Object.keys(nodeMan.list).filter(id => id.startsWith("syntheticObject_100_") || id === "syntheticObject_100");
    expect(madeByObject()).toHaveLength(4);
    customManager.deleteObject(object);
    expect(madeByObject()).toEqual([]);
    // An object made in the same millisecond keeps its own nodes.
    expect(nodeMan.exists("syntheticObject_1000")).toBe(true);
    expect(nodeMan.exists("syntheticObject_1000_size")).toBe(true);
    expect(panel.destroy).toHaveBeenCalled();
    expect(customManager.editingObjectNodeId).toBeNull();
    // The track stays, without its object. Its "Object" link row goes at the next refresh of
    // the links (TrackObjectLinks.js), which reads the sitch and finds no object on the track.
    expect(trackManager.exists(track.trackID)).toBe(true);
    expect(track.objectID).toBeNull();
    expect(track.nameShared).toBe(false);
    expect(context.requestCameraFocusSync).toHaveBeenCalled();
});

test("Delete Track and Object removes both", async () => {
    const {object, track} = makeObjectOnTrack();
    context.showChoice.mockResolvedValue("both");
    await trackManager.confirmDeleteSyntheticTrack(track.trackID, "Track 1");
    const [question, {options}] = context.showChoice.mock.calls[0];
    expect(question).toBe('Delete track "Track 1"?');
    expect(options.map(option => option.label)).toEqual(['Delete Track and "Object 1"', "Delete Track Only", "Cancel"]);
    expect(nodeMan.exists(object.id)).toBe(false);
    expect(trackManager.disposeSyntheticTrack).toHaveBeenCalledWith(track.trackID);
    expect(trackManager.exists(track.trackID)).toBe(false);
});

test("Delete Track Only keeps the object, and Cancel keeps both", async () => {
    const {object, track} = makeObjectOnTrack();
    context.showChoice.mockResolvedValue(null);
    await trackManager.confirmDeleteSyntheticTrack(track.trackID, "Track 1");
    expect(nodeMan.exists(object.id)).toBe(true);
    expect(trackManager.disposeSyntheticTrack).not.toHaveBeenCalled();
    context.showChoice.mockResolvedValue("track");
    await trackManager.confirmDeleteSyntheticTrack(track.trackID, "Track 1");
    expect(nodeMan.exists(object.id)).toBe(true);
    expect(trackManager.disposeSyntheticTrack).toHaveBeenCalledWith(track.trackID);
});

test("a track without an object asks a plain yes or no", async () => {
    trackManager.add("syntheticTrack_7", {trackID: "syntheticTrack_7", objectID: null});
    context.showConfirm.mockResolvedValue(true);
    await trackManager.confirmDeleteSyntheticTrack("syntheticTrack_7", "Track 7");
    expect(context.showConfirm).toHaveBeenCalledWith('Delete track "Track 7"?', {title: "Delete Track"});
    expect(context.showChoice).not.toHaveBeenCalled();
    expect(trackManager.exists("syntheticTrack_7")).toBe(false);
    expect(context.undoManager.undo()).toBe(true);
    expect(trackManager.get("syntheticTrack_7").trackID).toBe("syntheticTrack_7");
    expect(context.undoManager.redo()).toBe(true);
    expect(trackManager.exists("syntheticTrack_7")).toBe(false);
});

// The sub-nodes that a live Add Object makes under the id of the object.
const LIVE_SUB_NODES = ["size", "color_colorInput", "modelLength", "manualPosition", "positionSwitch",
    "ControllerTrackPosition", "ControllerObjectTilt", "ControllerObjectTiltSmoothed",
    "ControllerObjectTiltSmoothed_window"];

test("Delete Object removes every sub-node, and the object after them", () => {
    for (const name of LIVE_SUB_NODES) new TestNode({id: "syntheticObject_7_" + name});
    const object = new TestObject({id: "syntheticObject_7"});
    object.gui = {};
    const removed = [];
    const unlinkDisposeRemove = nodeMan.unlinkDisposeRemove.bind(nodeMan);
    nodeMan.unlinkDisposeRemove = id => { removed.push(id); unlinkDisposeRemove(id); };
    customManager.deleteObject(object);
    expect(removed).toEqual([...LIVE_SUB_NODES.map(name => "syntheticObject_7_" + name), "syntheticObject_7"]);
    expect(Object.keys(nodeMan.list).filter(id => id.startsWith("syntheticObject_7"))).toEqual([]);
});

test("Delete Object takes the object out of the track selectors before its nodes go, and stops its listeners", () => {
    const {object} = makeObjectOnTrack();
    const position = nodeMan.get(object.fixedObjectPositionID);
    const onChoice = () => {}, onRename = () => {};
    object.locationListeners = [["Switch.choiceChanged.syntheticObject_100_positionSwitch", onChoice], ["displayNameChanged", onRename]];

    // A track selector that has the object as an option (its manual position node), selected.
    const order = [];
    const selector = new TestNode({id: "targetTrackSwitch"});
    selector.addInput("fixedTarget", new TestNode({id: "fixedTargetPosition"}));
    selector.addInput(object.id, position);
    selector.choice = object.id;
    selector.removeOption = jest.fn(key => {
        order.push("option");
        selector.removeInput(key);
        selector.choice = "fixedTarget";
    });
    setSit({dropTargets: {track: ["targetTrackSwitch-2"]}});
    const unlinkDisposeRemove = nodeMan.unlinkDisposeRemove.bind(nodeMan);
    nodeMan.unlinkDisposeRemove = id => { order.push(id); unlinkDisposeRemove(id); };

    customManager.deleteObject(object);
    expect(selector.removeOption).toHaveBeenCalledWith(object.id);
    expect(order[0]).toBe("option");
    expect(Object.keys(selector.inputs)).toEqual(["fixedTarget"]);
    expect(selector.choice).toBe("fixedTarget");
    expect(context.EventManager.removeEventListener.mock.calls).toEqual([
        ["Switch.choiceChanged.syntheticObject_100_positionSwitch", onChoice], ["displayNameChanged", onRename]]);
    expect(object.locationListeners).toBeNull();
    expect(nodeMan.exists(position.id)).toBe(false);
});

test("Remove All Tracks removes each user-made object with Delete Object, and then the tracks", () => {
    const {object, otherObject, panel, track} = makeObjectOnTrack();
    // an object that a sitch defines stays
    const sitchObject = new TestObject({id: "traverseObject"});
    trackManager.disposeRemove = jest.fn(id => trackManager.remove(id));
    const deleted = [];
    const deleteObject = customManager.deleteObject;
    customManager.deleteObject = function (node) { deleted.push(node.id); deleteObject.call(this, node); };

    customManager.removeAllTracks();
    expect(deleted).toEqual([object.id, otherObject.id]);
    expect(Object.keys(nodeMan.list)).toEqual([sitchObject.id]);
    expect(panel.destroy).toHaveBeenCalled();
    expect(trackManager.disposeRemove).toHaveBeenCalledWith(track.trackID);
    expect(trackManager.exists(track.trackID)).toBe(false);
});

test("Remove All Tracks restores two tracks from the same source as one repeatable action", () => {
    const file = "Flights.kml";
    const files = new CManager();
    const bytes = new ArrayBuffer(4);
    const parsed = {names: ["North", "South"]};
    const metadata = {filename: file};
    files.add(file, parsed, bytes);
    files.loadedFilesMetadata = {[file]: metadata};
    Object.assign(context, {
        UndoManager: context.undoManager, FileManager: files, Sit: {loadedFiles: {[file]: file}},
        captureNodeMods, restoreNodeMods, hasOtherTrackSourceReference, GlobalDateTimeNode: null,
        isSitchEstablishedByUser: () => true,
    });
    const add = (index, shortName) => {
        const trackID = "Track_" + shortName;
        return trackManager.add(trackID, {trackID, trackFileName: file, trackIndex: index, menuText: shortName,
            displayName: shortName});
    };
    add(0, "North").displayName = "North renamed";
    add(1, "South");
    trackManager.notifyTracksChanged = jest.fn();
    trackManager.buildSelectedTracks = jest.fn(([source], _removeDuplicates, options, _selection, _declined, {index, shortName}) => {
        expect(files.get(source)).toBe(parsed);
        expect(files.getInfo(source).original).toBe(bytes);
        expect(parsed.names[index]).toBe(shortName);
        expect(options.syncTime).toBe(false);
        add(index, shortName);
    });
    trackManager.setTrackDisplayName = (track, name) => { track.displayName = name; };

    customManager.removeAllTracks(true);
    expect(context.undoManager.getStatus().undoCount).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) {
        expect(trackManager.size()).toBe(0);
        expect(files.exists(file)).toBe(false);
        expect(context.Sit.loadedFiles[file]).toBeUndefined();
        expect(context.undoManager.undo()).toBe(true);
        expect(trackManager.get("Track_North").displayName).toBe("North renamed");
        expect(trackManager.get("Track_South").trackIndex).toBe(1);
        expect(context.Sit.loadedFiles[file]).toBe(file);
        expect(files.loadedFilesMetadata[file]).toBe(metadata);
        expect(context.undoManager.redo()).toBe(true);
    }
});

test("a multi-track import and its timeline changes replay together without rerunning the picker", async () => {
    const file = "recording.kml";
    const files = new CManager();
    files.add(file, {}, new ArrayBuffer(8));
    const sit = {frames: 30, aFrame: 0, bFrame: 29, loadedFiles: {[file]: file}};
    const date = {dateStart: new Date(1000), setStartDateTime(value) { this.dateStart = value; },
        startTimeZoneLookup: jest.fn(), changedFrames: jest.fn()};
    Object.assign(context, {FileManager: files, Sit: sit, GlobalDateTimeNode: date, captureNodeMods,
        restoreNodeMods, hasOtherTrackSourceReference, isSitchEstablishedByUser: () => true});
    new TestNode({id: "globalSphereResize"});
    trackManager.notifyTracksChanged = jest.fn();
    trackManager.setTrackDisplayName = (track, name) => { track.displayName = name; };
    trackManager.buildSelectedTracks = jest.fn((_files, _removeDuplicates, _options, _selected, _declined, restoring) => {
        const indices = restoring ? [restoring.index] : [0, 1];
        for (const index of indices) {
            const shortName = "flight" + index, trackID = "Track_" + shortName;
            trackManager.add(trackID, {trackID, trackFileName: file, trackIndex: index,
                menuText: shortName, displayName: shortName});
        }
        if (!restoring) {
            Object.assign(sit, {frames: 60, aFrame: 3, bFrame: 56});
            date.dateStart = new Date(5000);
        }
    });
    await trackManager.addTracks([file], false, 0, {recordUndo: true, showDialog: false});
    expect(context.undoManager.getStatus().undoCount).toBe(1);
    expect(context.undoManager.undo()).toBe(true);
    expect(trackManager.size()).toBe(0);
    expect(files.exists(file)).toBe(false);
    expect(sit).toMatchObject({frames: 30, aFrame: 0, bFrame: 29});
    expect(date.dateStart.getTime()).toBe(1000);
    expect(context.undoManager.redo()).toBe(true);
    expect(trackManager.size()).toBe(2);
    expect(sit).toMatchObject({frames: 60, aFrame: 3, bFrame: 56});
    expect(date.dateStart.getTime()).toBe(5000);
});
