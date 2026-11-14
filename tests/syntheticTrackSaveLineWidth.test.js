// The save of a hand-drawn (synthetic) track keeps its line width (CTrackManager.serialize).
//
// CNodeDisplayTrack keeps the width in its "width" input, and the Line Width slider sets
// that input. The save read a "width" field that the node does not have, so every save
// wrote 1, and a sitch that was loaded and saved again drew its tracks thinner.
// The real method is taken from its class (the module itself imports the whole scene).

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CNodeConstant} from "../src/nodes/CNode";
import {CManager} from "../src/CManager";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {setNodeMan} from "../src/Globals";

// A real CNodeConstant registers itself with the node manager.
beforeEach(() => setNodeMan(new CNodeManager()));

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

const quietConsole = {log() {}, warn() {}, error() {}};

// A track manager that holds the given tracks, with the real serialize().
function managerWith(tracks) {
    const context = {console: quietConsole, CManager, NodeMan: {get: () => undefined}, trackColorHex: color => color};
    const manager = Object.create(classMethods("../src/TrackManager.js", "CTrackManager", ["serialize"], context));
    manager.iterate = (callback) => tracks.forEach(track => callback(track.trackID, track));
    return manager;
}

// A hand-drawn track whose display node draws its line with the given width input.
function syntheticTrack(id, widthNode) {
    return {
        isSynthetic: true, trackID: id, displayTrackID: id + "_display", menuText: id,
        displayTrack: widthNode === undefined ? undefined : {in: {width: widthNode}},
    };
}

test("a save keeps the line width that the track is drawn with", () => {
    const width = new CNodeConstant({id: "width_2", value: 2});
    const [saved] = managerWith([syntheticTrack("synth_01", width)]).serialize();
    expect(saved.lineWidth).toBe(2);
});

test("a save keeps a width that the Line Width slider set", () => {
    const width = new CNodeConstant({id: "width_slider", value: 1});
    width.value = 3.5;     // what the slider does
    const [saved] = managerWith([syntheticTrack("synth_02", width)]).serialize();
    expect(saved.lineWidth).toBe(3.5);
});

test("a track with no display node saves width 1", () => {
    const [saved] = managerWith([syntheticTrack("synth_03", undefined)]).serialize();
    expect(saved.lineWidth).toBe(1);
});
