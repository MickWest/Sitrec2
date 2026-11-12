// The 3D objects on a manual position, as options of the track selectors
// (src/TrackSelectors.js). The selectors here are small stand-ins with the parts of
// CNodeSwitch that the module uses: a real switch needs a menu.

import {Globals, setNodeMan, setSit, Sit} from "../src/Globals";
import {
    addManualObjectsToSelector,
    OBJECT_MANUAL_POSITION,
    syncManualObject,
    trackSelectors,
    unlistManualObject,
} from "../src/TrackSelectors";

let nodes;

// A selector as CNodeSwitch gives it. `rows` is the menu: the texts in order, which is
// what the user sees and what a real menu finds a row by.
function makeSelector(id, inputs = {}, choice = Object.keys(inputs)[0] ?? null) {
    const selector = {
        id, inputs: {...inputs}, choice, guiLabels: {},
        get rows() { return Object.keys(this.inputs).map(key => this.guiLabels[key] ?? key); },
        addOption(key, node, label) {
            this.inputs[key] = node;
            if (label !== undefined) this.guiLabels[key] = label;
        },
        setOptionLabel(key, label) {
            if (label === undefined || label === key) delete this.guiLabels[key];
            else this.guiLabels[key] = label;
        },
        removeOption(key) {
            delete this.inputs[key];
            delete this.guiLabels[key];
            if (this.choice === key) this.choice = Object.keys(this.inputs)[0];
        },
        selectOption(key) { this.choice = key; },
    };
    nodes[id] = selector;
    return selector;
}

// An object with a Location: its manual position node, and its own Position selector with
// Manual and the given tracks.
function makeObject(id, name, tracks = {}, choice = OBJECT_MANUAL_POSITION) {
    const manual = {id: id + "_manualPosition"};
    const own = makeSelector(id + "_positionSwitch", {[OBJECT_MANUAL_POSITION]: manual, ...tracks}, choice);
    const object = {id, menuName: name, positionSwitchID: own.id};
    nodes[id] = object;
    return {object, manual, own};
}

const kiteTrack = {id: "Track_Kite"};

// Put a selector that a test made into the list of the sitch, as CNodeTrackSwitch does for itself.
const addToSitch = selector => Sit.dropTargets.track.push(selector.id);

beforeEach(() => {
    nodes = {};
    Globals.disposing = false;
    setNodeMan({
        get: id => nodes[id],
        iterate: callback => Object.keys(nodes).forEach(id => callback(id, nodes[id])),
    });
    setSit({dropTargets: {track: []}});
});

// The selectors of a custom sitch: two with a track number, one plain.
function makeSitchSelectors() {
    const camera = makeSelector("cameraTrackSwitch", {fixedCamera: {}, Kite: kiteTrack});
    const target = makeSelector("targetTrackSwitch", {fixedTarget: {}, Kite: kiteTrack});
    const finder = makeSelector("balloonLaunchFinder_source", {lineOfSight: {}, Kite: kiteTrack});
    setSit({dropTargets: {track: ["cameraTrackSwitch-1", "targetTrackSwitch-2", "balloonLaunchFinder_source"]}});
    return {camera, target, finder};
}

function listed(objectID) {
    return [...trackSelectors()].filter(selector => selector.inputs[objectID] !== undefined).map(selector => selector.id);
}

describe("trackSelectors", () => {
    test("gives the selectors of the sitch, with the track number taken off the name", () => {
        makeSitchSelectors();
        expect([...trackSelectors()].map(selector => selector.id))
            .toEqual(["cameraTrackSwitch", "targetTrackSwitch", "balloonLaunchFinder_source"]);
    });

    test("does not give a selector that is in the list but is not a node", () => {
        makeSitchSelectors();
        delete nodes.targetTrackSwitch;
        expect([...trackSelectors()].map(selector => selector.id))
            .toEqual(["cameraTrackSwitch", "balloonLaunchFinder_source"]);
    });

    test("does not give a selector that the caller removed on the way", () => {
        makeSitchSelectors();
        const seen = [];
        for (const selector of trackSelectors()) {
            seen.push(selector.id);
            delete nodes.targetTrackSwitch;
        }
        expect(seen).toEqual(["cameraTrackSwitch", "balloonLaunchFinder_source"]);
    });
});

describe("an object on its manual position", () => {
    test("is an option in every selector but its own, with its id as the key and its name as the text", () => {
        const {camera, target, finder} = makeSitchSelectors();
        const {object, manual, own} = makeObject("syntheticObject_1", "Target Balloon", {Kite: kiteTrack});
        addToSitch(own);
        syncManualObject(object);

        for (const selector of [camera, target, finder]) {
            expect(selector.inputs.syntheticObject_1).toBe(manual);
            expect(selector.guiLabels.syntheticObject_1).toBe("Target Balloon");
        }
        expect(own.inputs.syntheticObject_1).toBeUndefined();
        // nothing was selected for the user
        expect(target.choice).toBe("fixedTarget");
    });

    test("follows a new name of the object, and keeps its key", () => {
        const {target} = makeSitchSelectors();
        const {object, manual} = makeObject("syntheticObject_1", "Object 1");
        syncManualObject(object);
        target.selectOption("syntheticObject_1");

        object.menuName = "Weather Balloon";
        syncManualObject(object);
        expect(target.rows).toEqual(["fixedTarget", "Kite", "Weather Balloon"]);
        expect(target.choice).toBe("syntheticObject_1");
        expect(target.inputs.syntheticObject_1).toBe(manual);
    });

    test("gets a text of its own when a track already has its name", () => {
        const {target, camera} = makeSitchSelectors();
        const {object} = makeObject("syntheticObject_1", "Kite");
        syncManualObject(object);
        expect(target.rows).toEqual(["fixedTarget", "Kite", "Kite (object)"]);

        const second = makeObject("syntheticObject_2", "Kite").object;
        syncManualObject(second);
        expect(camera.rows).toEqual(["fixedCamera", "Kite", "Kite (object)", "Kite (object 2)"]);

        // a sync that changes nothing keeps the texts
        syncManualObject(object);
        syncManualObject(second);
        expect(camera.rows).toEqual(["fixedCamera", "Kite", "Kite (object)", "Kite (object 2)"]);
    });

    test("two objects are options of each other, and neither is its own option", () => {
        makeSitchSelectors();
        const first = makeObject("syntheticObject_1", "Object 1");
        const second = makeObject("syntheticObject_2", "Object 2");
        addToSitch(first.own);
        addToSitch(second.own);
        syncManualObject(first.object);
        syncManualObject(second.object);
        expect(first.own.rows).toEqual([OBJECT_MANUAL_POSITION, "Object 2"]);
        expect(second.own.rows).toEqual([OBJECT_MANUAL_POSITION, "Object 1"]);
    });
});

describe("an object that goes onto a track", () => {
    test("leaves the selectors, and a selector that had it goes to that track", () => {
        const {camera, target, finder} = makeSitchSelectors();
        const {object, own} = makeObject("syntheticObject_1", "Object 1", {Kite: kiteTrack});
        addToSitch(own);
        syncManualObject(object);
        target.selectOption("syntheticObject_1");
        finder.selectOption("syntheticObject_1");

        own.choice = "Kite";
        syncManualObject(object);
        expect(listed("syntheticObject_1")).toEqual([]);
        expect(target.choice).toBe("Kite");
        expect(finder.choice).toBe("Kite");
        // a selector that did not have the object keeps its choice
        expect(camera.choice).toBe("fixedCamera");
    });

    test("a selector that does not have that track goes to its first option", () => {
        const {target} = makeSitchSelectors();
        const {object, own} = makeObject("syntheticObject_1", "Object 1", {Path: {id: "Track_Path"}});
        syncManualObject(object);
        target.selectOption("syntheticObject_1");

        own.choice = "Path";
        syncManualObject(object);
        expect(target.inputs.syntheticObject_1).toBeUndefined();
        expect(target.choice).toBe("fixedTarget");
    });

    test("comes back when it goes to Manual again", () => {
        const {target} = makeSitchSelectors();
        const {object, own, manual} = makeObject("syntheticObject_1", "Object 1", {Kite: kiteTrack}, "Kite");
        syncManualObject(object);
        expect(listed("syntheticObject_1")).toEqual([]);

        own.choice = OBJECT_MANUAL_POSITION;
        syncManualObject(object);
        expect(target.inputs.syntheticObject_1).toBe(manual);
        // it is an option again, and nothing selects it
        expect(target.choice).toBe("fixedTarget");
    });
});

describe("an object that is deleted", () => {
    test("leaves every selector, and a selector that had it goes to its first option", () => {
        const {camera, target} = makeSitchSelectors();
        const {object} = makeObject("syntheticObject_1", "Object 1");
        syncManualObject(object);
        target.selectOption("syntheticObject_1");

        unlistManualObject(object);
        expect(listed("syntheticObject_1")).toEqual([]);
        expect(target.choice).toBe("fixedTarget");
        expect(target.rows).toEqual(["fixedTarget", "Kite"]);
        expect(camera.rows).toEqual(["fixedCamera", "Kite"]);
    });

    test("an object that was never an option changes nothing", () => {
        const {target} = makeSitchSelectors();
        const {object} = makeObject("syntheticObject_1", "Object 1", {Kite: kiteTrack}, "Kite");
        unlistManualObject(object);
        expect(target.rows).toEqual(["fixedTarget", "Kite"]);
    });
});

describe("a selector that is made after the objects", () => {
    test("gets the objects on a manual position, and not the objects on a track", () => {
        makeSitchSelectors();
        makeObject("syntheticObject_1", "Object 1");
        makeObject("syntheticObject_2", "Object 2", {Kite: kiteTrack}, "Kite");
        const late = makeSelector("orbitTargetSwitch", {fixedCamera: {}});
        addManualObjectsToSelector(late);
        expect(late.rows).toEqual(["fixedCamera", "Object 1"]);
    });

    test("the Position selector of a new object does not get that object", () => {
        makeSitchSelectors();
        makeObject("syntheticObject_1", "Object 1");
        const {own} = makeObject("syntheticObject_2", "Object 2");
        addManualObjectsToSelector(own);
        expect(own.rows).toEqual([OBJECT_MANUAL_POSITION, "Object 1"]);
    });
});

test("while the sitch is disposed, the selectors are left alone", () => {
    const {target} = makeSitchSelectors();
    const {object} = makeObject("syntheticObject_1", "Object 1");
    Globals.disposing = true;
    syncManualObject(object);
    expect(target.rows).toEqual(["fixedTarget", "Kite"]);
    Globals.disposing = false;
    syncManualObject(object);
    Globals.disposing = true;
    unlistManualObject(object);
    expect(target.rows).toEqual(["fixedTarget", "Kite", "Object 1"]);
});
