// Delete Object (CustomManager.deleteObject) and Delete Track's "Delete Track and Object" path
// (TrackManager.confirmDeleteSyntheticTrack). The real methods are taken from their classes
// (the modules themselves import the whole scene) and run against a real node manager.

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CNode} from "../src/nodes/CNode";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {CManager} from "../src/CManager";
import {setFileManager, setNodeMan} from "../src/Globals";
import {ownedSubNodeIds} from "../src/UserObjects";
import {t} from "../src/i18n";

class TestNode extends CNode {
    getValueFrame() { return 0; }
}

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
    context = {
        console, t, NodeMan: nodeMan, CManager, ownedSubNodeIds,
        Globals: {menuBar: {persistentMenus: []}},
        requestCameraFocusSync: jest.fn(),
        setRenderOne: jest.fn(),
        showChoice: jest.fn(),
        showConfirm: jest.fn(),
    };
    const trackMethods = classMethods("../src/TrackManager.js", "CTrackManager",
        ["objectForTrack", "detachObject", "trackForObject", "confirmDeleteSyntheticTrack"], context);
    trackManager = Object.assign(Object.create(trackMethods), new CManager());
    trackManager.disposeSyntheticTrack = jest.fn(id => trackManager.remove(id));
    context.TrackManager = trackManager;
    context.CustomManager = customManager = Object.create(classMethods("../src/CustomSupport.js", "CCustomManager",
        ["clearEditingObject", "disposeObjectWithControllers", "deleteObject"], context));
});

// A user-made object the way Add Object leaves it: the object, a sub-node it owns, a controller
// input, a fixed position node, an open panel, and a track that it rides.
function makeObjectOnTrack() {
    const position = new TestNode({id: "syntheticObject_100_position"});
    const size = new TestNode({id: "syntheticObject_100_size"});
    const controller = new TestNode({id: "syntheticObject_100_ControllerTrackPosition"});
    controller.isController = true;
    const object = new TestNode({id: "syntheticObject_100"});
    object.addInput("size", size);
    object.addInput("controller", controller);
    object.displayName = "Object 1";
    object.gui = {};
    object.fixedObjectPositionID = position.id;
    object.showTrackController = {destroy: jest.fn()};
    const otherObject = new TestNode({id: "syntheticObject_1000"});
    new TestNode({id: "syntheticObject_1000_size"});
    const panel = {_mirrorSource: object.gui, destroy: jest.fn()};
    context.Globals.menuBar.persistentMenus.push(panel);
    customManager.editingObjectNodeId = object.id;
    const showObjectController = {destroy: jest.fn()};
    const track = {trackID: "syntheticTrack_100", objectID: object.id, showObjectController};
    trackManager.add(track.trackID, track);
    return {object, otherObject, panel, track, showObjectController};
}

test("Delete Object removes every node the object made, closes its panel, and detaches its track", () => {
    const {object, panel, track, showObjectController} = makeObjectOnTrack();
    const madeByObject = () => Object.keys(nodeMan.list).filter(id => id.startsWith("syntheticObject_100_") || id === "syntheticObject_100");
    expect(madeByObject()).toHaveLength(4);
    customManager.deleteObject(object);
    expect(madeByObject()).toEqual([]);
    // An object made in the same millisecond keeps its own nodes.
    expect(nodeMan.exists("syntheticObject_1000")).toBe(true);
    expect(nodeMan.exists("syntheticObject_1000_size")).toBe(true);
    expect(panel.destroy).toHaveBeenCalled();
    expect(customManager.editingObjectNodeId).toBeNull();
    // The track stays, without its object or its Show Object Menu button.
    expect(trackManager.exists(track.trackID)).toBe(true);
    expect(track.objectID).toBeNull();
    expect(showObjectController.destroy).toHaveBeenCalled();
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
});
