// One name for a balloon or a kite and its object (TrackManager.shareNameWithObject), and the
// name of a track in the Camera FOV list (TrackManager.relabelTrackOptions).
//
// The real methods are taken from the class, as tests/deleteObjectAndTrack.test.js does: the
// module itself imports the whole scene.

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CManager} from "../src/CManager";
import {uniqueDisplayName} from "../src/DisplayName";

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

let nodes, context, trackManager;

beforeEach(() => {
    nodes = {};
    context = {
        console, CManager, uniqueDisplayName,
        NodeMan: {
            get: id => nodes[id],
            iterate: callback => Object.keys(nodes).forEach(id => callback(id, nodes[id])),
        },
        Sit: {dropTargets: {fov: ["fovSwitch"]}},
        notifyDisplayNameChanged: jest.fn(),
        setRenderOne: jest.fn(),
    };
    const methods = classMethods("../src/TrackManager.js", "CTrackManager",
        ["shareNameWithObject", "noteObjectNameRestored", "detachObject", "sharesNameWithObject",
            "setTrackDisplayName", "relabelTrackOptions", "objectForTrack", "trackForObject", "uniqueTrackName"],
        context);
    trackManager = Object.assign(Object.create(methods), new CManager());
    context.TrackManager = trackManager;
});

// An object as CNode3DObject names it: a rename gives the name to its track when the two have
// one name, and the Name control writes the new name BEFORE it calls the handler.
function makeObject(id, displayName) {
    const object = {
        id, displayName,
        setDisplayName(name, {linked = true} = {}) {
            this.displayName = name;
            if (!linked) return;
            const trackOb = trackManager.trackForObject(this.id);
            if (trackOb && trackManager.sharesNameWithObject(trackOb)) {
                trackManager.setTrackDisplayName(trackOb, name, {linked: false});
            }
        },
        // what the Name control of the object's folder does on each key
        typeName(name) {
            this.displayName = name;
            this.setDisplayName(name);
        },
    };
    nodes[id] = object;
    return object;
}

function makeBalloon(displayName = "Balloon") {
    const trackOb = {trackID: "balloonTrack_1", menuText: "Balloon", displayName, isBalloon: true,
        objectID: "balloonObject_1"};
    trackManager.add(trackOb.trackID, trackOb);
    return trackOb;
}

// what the Name control of the track's folder does on each key
function typeTrackName(trackOb, name) {
    trackOb.displayName = name;
    trackManager.setTrackDisplayName(trackOb, name, {fromControl: true});
}

describe("a new balloon and its object", () => {
    test("the object gets the track's name, and the two are one name from then on", () => {
        const trackOb = makeBalloon();
        const object = makeObject("balloonObject_1", "Balloon_wrong");
        trackManager.shareNameWithObject(trackOb, object);
        expect(object.displayName).toBe("Balloon");
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(true);
    });

    test("a rename of the track, key by key, renames the object", () => {
        const trackOb = makeBalloon();
        const object = makeObject("balloonObject_1", "Balloon");
        trackManager.shareNameWithObject(trackOb, object);
        // The link must hold through the edit: after the first key the two names differ.
        for (const name of ["Balloo", "Ballo", "Ball", "Ball 2"]) typeTrackName(trackOb, name);
        expect(object.displayName).toBe("Ball 2");
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(true);
    });

    test("a rename of the object, key by key, renames the track", () => {
        const trackOb = makeBalloon();
        const object = makeObject("balloonObject_1", "Balloon");
        trackManager.shareNameWithObject(trackOb, object);
        for (const name of ["Balloon ", "Balloon A"]) object.typeName(name);
        expect(trackOb.displayName).toBe("Balloon A");
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(true);
    });
});

describe("a balloon from a saved sitch", () => {
    test("saved under two names, it keeps two names, and a rename of one leaves the other", () => {
        const trackOb = makeBalloon();
        const object = makeObject("balloonObject_1", "Balloon");
        trackManager.shareNameWithObject(trackOb, object);      // as addBalloonTrack does on a load
        object.setDisplayName("Object 1", {linked: false});     // the saved name comes back
        trackManager.noteObjectNameRestored(object);
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(false);

        typeTrackName(trackOb, "Weather Balloon");
        expect(object.displayName).toBe("Object 1");
        object.typeName("Sphere");
        expect(trackOb.displayName).toBe("Weather Balloon");
    });

    test("saved under one name, it stays one name", () => {
        const trackOb = makeBalloon("Weather Balloon");
        const object = makeObject("balloonObject_1", "Balloon");
        trackManager.shareNameWithObject(trackOb, object);
        object.setDisplayName("Weather Balloon", {linked: false});
        trackManager.noteObjectNameRestored(object);
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(true);
    });

    test("the rule is for a balloon's or a kite's object only", () => {
        // A hand-drawn track and the object made with it are "Track 1" and "Object 1".
        const trackOb = {trackID: "syntheticTrack_1", menuText: "Track 1", displayName: "Same", objectID: "syntheticObject_1"};
        trackManager.add(trackOb.trackID, trackOb);
        const object = makeObject("syntheticObject_1", "Same");
        trackManager.noteObjectNameRestored(object);
        expect(trackOb.nameShared).toBeUndefined();
        expect(trackManager.sharesNameWithObject(trackOb)).toBe(false);
    });
});

test("a track that loses its object is linked to no name", () => {
    const trackOb = makeBalloon();
    trackManager.shareNameWithObject(trackOb, makeObject("balloonObject_1", "Balloon"));
    trackManager.detachObject(trackOb);
    expect(trackOb.objectID).toBeNull();
    expect(trackOb.nameShared).toBe(false);
});

test("a loaded track and its marker have one name, as before", () => {
    const marker = makeObject("N97826_ob", "N97826");
    const trackOb = {trackID: "Track_N97826", menuText: "N97826", displayName: "N97826", displayTargetSphere: marker};
    trackManager.add(trackOb.trackID, trackOb);
    expect(trackManager.sharesNameWithObject(trackOb)).toBe(true);
    typeTrackName(trackOb, "Reaper");
    expect(marker.displayName).toBe("Reaper");
});

describe("the name of a track in the Camera FOV list", () => {
    // A selector with the parts of CNodeSwitch that relabelTrackOptions uses.
    function makeSwitch(id, inputs, labels = {}) {
        const selector = {
            id, inputs, guiLabels: {...labels},
            setOptionLabel(key, label) {
                if (label === key) delete this.guiLabels[key];
                else this.guiLabels[key] = label;
            },
            label(key) { return this.guiLabels[key] ?? key; },
        };
        nodes[id] = selector;
        return selector;
    }

    const track = {trackID: "Track_N97826", menuText: "N97826", displayName: "N97826"};

    test("the option shows the name of the track, and its key is still the id", () => {
        const fov = makeSwitch("fovSwitch", {userFOV: {}, Track_N97826: {}}, {userFOV: "Manual"});
        trackManager.relabelTrackOptions(track);
        expect(fov.label("Track_N97826")).toBe("N97826");
        expect(Object.keys(fov.inputs)).toContain("Track_N97826");
        trackManager.relabelTrackOptions({...track, displayName: "Reaper"});
        expect(fov.label("Track_N97826")).toBe("Reaper");
    });

    test("a name that another option shows is not used: a menu row is found by its text", () => {
        const fov = makeSwitch("fovSwitch", {userFOV: {}, Track_N97826: {}}, {userFOV: "Manual"});
        trackManager.relabelTrackOptions({...track, displayName: "Manual"});
        expect(fov.label("Track_N97826")).toBe("Track_N97826");
    });

    test("a track that is renamed to a name in use does not keep its old name in the list", () => {
        const fov = makeSwitch("fovSwitch", {userFOV: {}, Track_N97826: {}}, {userFOV: "Manual"});
        trackManager.relabelTrackOptions({...track, displayName: "Reaper"});
        expect(fov.label("Track_N97826")).toBe("Reaper");
        trackManager.relabelTrackOptions({...track, displayName: "Manual"});
        expect(fov.label("Track_N97826")).toBe("Track_N97826");
    });

    test("only a switch of the FOV list is given the name under the track's id", () => {
        // A switch that is not a Camera FOV list can have an option with that key.
        const other = makeSwitch("otherSwitch", {Track_N97826: {}});
        trackManager.relabelTrackOptions(track);
        expect(other.label("Track_N97826")).toBe("Track_N97826");
    });
});
