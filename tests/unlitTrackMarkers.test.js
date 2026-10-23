// An imported track's default marker is unlit (MeshBasicMaterial), so it shows its full track
// colour by night as by day. A fitted candidate from an analysis handoff (named by the sender
// through TrackManager.setCandidateTrackNames) and the ground-truth icosahedron stay phong.
// makeMotionTrack and reassignTrackColors are taken from their class (the module imports the
// whole scene) and run against stub nodes.

import fs from "fs";
import path from "path";
import vm from "vm";
import {transformSync} from "@babel/core";
import {Color, MeshBasicMaterial} from "three";
import {CManager} from "../src/CManager";

// The named methods of one class in a source file, as a prototype object.
function classMethods(file, className, methodNames, context) {
    const source = fs.readFileSync(file, "utf8");
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

// Records what it was built with.
class StubNode {
    constructor(props) { this.props = props; }
    addController() {}
}

let context;
let trackManager;
let files;

beforeEach(() => {
    files = {};
    context = {
        console, Color, CManager,
        CNodeConstant: StubNode, CNodeDisplayTrack: StubNode, CNode3DObject: StubNode,
        CNodeDisplayBalloonSphere: StubNode, CNodeSondeColor: StubNode,
        CNodeDisplaySondeWind: StubNode, CNodeAtmosphericProfile: StubNode,
        LAYER: {MASK_HELPERS: 1, MASK_TARGET: 2},
        Sit: {frames: 100},
        DEFAULT_TRACK_SPHERE_RADIUS_M: 40,
        // The real one reads names and BOT files; the name is enough here.
        isTruthTrack: (trackOb, shortName) => shortName === "truth",
        getEnv: () => undefined,
        process: {env: {}},
        ModelFiles: {},
        NodeMan: {get: () => null},
        FileManager: {get: (name) => files[name]},
        TRACK_PALETTE: [new Color(0.5, 1.0, 0.5), new Color(0.6, 0.6, 1.0)],
    };
    const methods = classMethods(path.resolve(__dirname, "../src/TrackManager.js"), "CTrackManager",
        ["setCandidateTrackNames", "isCandidateTrack", "makeMotionTrack", "reassignTrackColors", "disposeAll"], context);
    trackManager = Object.assign(Object.create(methods), new CManager());
    trackManager.setCandidateTrackNames([]);
});

function markerFor(shortName, {trackIndex = 0, file = {}} = {}) {
    const trackFileName = shortName + ".csv";
    files[trackFileName] = file;
    const trackOb = {trackFileName, trackIndex, menuText: shortName};
    trackManager.makeMotionTrack(trackOb, shortName, new Color(0.5, 1, 0.5), new Color(0.4, 0.75, 0.4), "Track_" + shortName);
    return trackOb.displayTargetSphere.props;
}

test("an ordinary imported track gets an unlit sphere", () => {
    const marker = markerFor("N12345");
    expect(marker.geometry).toBe("sphere");
    expect(marker.material).toBe("basic");
});

test("a fitted candidate named by the handoff keeps phong", () => {
    trackManager.setCandidateTrackNames(["c_drone", "w_lantern"]);
    expect(markerFor("c_drone").material).toBe("phong");
    expect(markerFor("w_lantern").material).toBe("phong");
    // The prefix alone does not make a candidate.
    expect(markerFor("c_mytrack").material).toBe("basic");
});

test("New Sitch forgets the handoff's candidate names", () => {
    trackManager.setCandidateTrackNames(["c_drone"]);
    trackManager.disposeAll();
    // An ordinary track in the next sitch that reuses the name gets the ordinary marker.
    expect(markerFor("c_drone").material).toBe("basic");
});

test("ground truth keeps its phong icosahedron", () => {
    const marker = markerFor("truth");
    expect(marker.geometry).toBe("icosahedron");
    expect(marker.material).toBe("phong");
});

test("a supplementary object track (MISB Target Location) is unlit like the default marker", () => {
    const file = {isSupplementaryTrack: () => true, supplementaryTrackIsObject: () => true};
    const marker = markerFor("Target_N12345", {trackIndex: 1, file});
    expect(marker.visible).toBe(true);
    expect(marker.material).toBe("basic");
});

test("re-colouring a track re-colours an unlit marker", () => {
    // A basic marker as CNode3DObject builds one: materialParams.color is the hex string.
    const material = new MeshBasicMaterial({color: new Color(0.6, 0.6, 1.0)});
    const marker = {
        modelOrGeometry: "geometry", material, props: {},
        materialParams: {color: "#" + material.color.getHexString(), fog: true},
    };
    trackManager.add("Track_A", {
        paletteColored: true, shortName: "A", trackColor: material.color.clone(), displayTargetSphere: marker,
    });

    trackManager.reassignTrackColors();

    const expected = context.TRACK_PALETTE[0];
    expect(material.color.getHex()).toBe(expected.getHex());
    expect(marker.materialParams.color).toBe("#" + expected.getHexString());
});
