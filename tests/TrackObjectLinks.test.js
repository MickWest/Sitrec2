/**
 * @jest-environment jsdom
 */

// Which object is on which track, and what each track is used for (src/TrackObjectLinks.js).
//
// The first part tests the model with plain stand-ins: a node is an object with `inputs`, a
// selector also has a `choice`. The second part runs the refresh against real menus (lil-gui
// with the Sitrec extras), with stand-ins for the node manager and the track manager.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // installs asLinkRow, asDisplayRow, setTitleNote
import {Globals, guiMenus, setCustomManager, setNodeMan, setSit, setTrackManager, Sit} from "../src/Globals";
import {EventManager} from "../src/CEventManager";
import {addNameControl} from "../src/DisplayName";
import {OBJECT_MANUAL_POSITION} from "../src/TrackSelectors";
import {
    buildLinkIndex,
    cancelTrackObjectLinksRefresh,
    describeLinks,
    installTrackObjectLinks,
    keysOfTrack,
    noteWords,
    positionSourceOf,
    refreshTrackObjectLinks,
    rolesOf,
    scheduleTrackObjectLinksRefresh,
    sourceOfObject,
    trackLinkSummaries,
    usedForText,
} from "../src/TrackObjectLinks";

// --- stand-ins -----------------------------------------------------------------------------

// An object whose position controller reads `source`.
function makeObject(id, source, extra = {}) {
    return {
        id, displayName: extra.displayName ?? id,
        inputs: {position: {isController: true, inputs: {sourceTrack: source}}},
        ...extra,
    };
}

// An object that the user made: a Position selector with Manual and the given tracks.
function makeUserObject(id, tracks = {}, choice = OBJECT_MANUAL_POSITION) {
    const manual = {id: id + "_manualPosition"};
    const selector = {id: id + "_positionSwitch", inputs: {[OBJECT_MANUAL_POSITION]: manual, ...tracks}, choice};
    const object = makeObject(id, selector, {positionSwitchID: selector.id});
    return {object, selector, manual};
}

const loadedTrack = (short) => ({
    trackID: "Track_" + short, menuText: short, displayName: short,
    trackNode: {id: "Track_" + short}, trackDataNode: {id: "TrackData_" + short},
});

// A hand-drawn track: the selectors of the sitch hold its spline, an object holds the
// finished (smoothed) track.
const handDrawnTrack = (id, name) => {
    const spline = {id: id + "_unsmoothed"};
    const smoothed = {id, inputs: {source: spline}};
    return {trackID: id, menuText: name, displayName: name, isSynthetic: true,
        trackNode: smoothed, smoothedTrackNode: smoothed, splineEditorNode: spline};
};

// --- the model -----------------------------------------------------------------------------

describe("what an object is on", () => {
    test("the marker of a loaded track is on that track", () => {
        const track = loadedTrack("N97826");
        const marker = makeObject("N97826_ob", track.trackNode);
        const index = buildLinkIndex({tracks: [track], objects: [marker]});
        expect(sourceOfObject(marker, index)).toEqual({kind: "track", trackOb: track});
    });

    test("an object with a Position selector is on what the selector has now", () => {
        const first = handDrawnTrack("syntheticTrack_1", "Track 1");
        const second = handDrawnTrack("syntheticTrack_2", "Track 2");
        const {object, selector} = makeUserObject("syntheticObject_1",
            {"Track 1": first.smoothedTrackNode, "Track 2": second.smoothedTrackNode}, "Track 1");
        const index = buildLinkIndex({tracks: [first, second], objects: [object]});
        expect(sourceOfObject(object, index).trackOb).toBe(first);
        // The user puts it on the other track. Nothing else is told: the link is read again.
        selector.choice = "Track 2";
        expect(sourceOfObject(object, index).trackOb).toBe(second);
        selector.choice = OBJECT_MANUAL_POSITION;
        expect(sourceOfObject(object, index)).toEqual({kind: "manual"});
    });

    test("an object can be at another object that is on its manual position", () => {
        const anchor = makeUserObject("syntheticObject_1");
        const rider = makeUserObject("syntheticObject_2", {syntheticObject_1: anchor.manual}, "syntheticObject_1");
        const index = buildLinkIndex({objects: [anchor.object, rider.object]});
        expect(sourceOfObject(rider.object, index)).toEqual({kind: "object", objectNode: anchor.object});
        expect(sourceOfObject(anchor.object, index)).toEqual({kind: "manual"});
    });

    test("the camera object is on the camera track, whatever the camera's position is", () => {
        const track = loadedTrack("N97826");
        const cameraSwitch = {id: "cameraTrackSwitch", inputs: {N97826: track.trackNode}, choice: "N97826"};
        const smooth = {id: "cameraTrackSwitchSmooth", inputs: {source: cameraSwitch}};
        const cameraTrack = {id: "cameraDisplayTrack", ownsGuiFolder: true, inputs: {track: smooth}};
        const cameraObject = makeObject("cameraObject", smooth);
        const index = buildLinkIndex({tracks: [track], builtInTracks: [cameraTrack], objects: [cameraObject]});
        expect(sourceOfObject(cameraObject, index)).toEqual({kind: "builtIn", displayNode: cameraTrack});
    });

    test("with no track of its own to name, the walk goes on through a copy and a selector", () => {
        // a sitch that draws no camera track: the camera object is then on the loaded track
        const track = loadedTrack("N97826");
        const cameraSwitch = {id: "cameraTrackSwitch", inputs: {N97826: track.trackNode}, choice: "N97826"};
        const smooth = {id: "cameraTrackSwitchSmooth", inputs: {source: cameraSwitch}};
        const cameraObject = makeObject("cameraObject", smooth);
        const index = buildLinkIndex({tracks: [track], objects: [cameraObject]});
        expect(sourceOfObject(cameraObject, index).trackOb).toBe(track);
    });

    test("an object with no position controller, or with a disabled one, is on nothing", () => {
        const track = loadedTrack("N97826");
        const index = buildLinkIndex({tracks: [track]});
        expect(sourceOfObject({id: "plain", inputs: {}}, index)).toBeNull();
        const off = makeObject("off", track.trackNode);
        off.inputs.position.enabled = false;
        expect(positionSourceOf(off)).toBeNull();
        expect(sourceOfObject(off, index)).toBeNull();
    });

    test("a selector that selects itself does not hang the walk", () => {
        const loop = {id: "loop", inputs: {}, choice: "self"};
        loop.inputs.self = loop;
        expect(sourceOfObject(makeObject("lost", loop), buildLinkIndex({}))).toBeNull();
    });
});

describe("what a track is used for", () => {
    const track = loadedTrack("N97826");
    const selector = (id, keyKind, choice, label = id) => ({id, keyKind, choice, label});
    const roleNames = (roles) => roles.map(entry => entry.role);

    test("one track has a different option key for each kind of selector", () => {
        expect(keysOfTrack(track)).toEqual({
            track: "N97826", fov: "Track_N97826", angles: "Angles_N97826", wind: "track:TrackData_N97826",
        });
    });

    test("the camera's position, FOV and heading, the target, and the wind", () => {
        const world = {
            selectors: [
                selector("cameraTrackSwitch", "track", "N97826"),
                selector("targetTrackSwitch", "track", "Center_N97826"),
                selector("fovSwitch", "fov", "Track_N97826"),
                selector("CameraLOSController", "angles", "Angles_N97826"),
            ],
            windSources: ["track:TrackData_N97826"],
        };
        expect(roleNames(rolesOf(keysOfTrack(track), world)))
            .toEqual(["cameraPosition", "cameraFOV", "cameraHeading", "windSource"]);
        expect(roleNames(rolesOf(keysOfTrack(loadedTrack("Center_N97826")), world))).toEqual(["target"]);
        expect(rolesOf(keysOfTrack(loadedTrack("Other")), world)).toEqual([]);
    });

    test("a key of one kind does not match a selector of another kind", () => {
        // a track with the short name "Track_N97826" is not the FOV source of N97826
        const world = {selectors: [selector("fovSwitch", "fov", "Track_N97826")]};
        expect(rolesOf({track: "Track_N97826"}, world)).toEqual([]);
    });

    test("Zoom to Track is not a use: it is a one-time pick", () => {
        const world = {selectors: [selector("zoomToTrack", "track", "N97826")]};
        expect(rolesOf(keysOfTrack(track), world)).toEqual([]);
    });

    test("the Orbit Target is a use only while the camera's position is Orbit", () => {
        const orbit = selector("orbitTargetSwitch", "track", "N97826");
        expect(rolesOf(keysOfTrack(track), {selectors: [orbit, selector("cameraTrackSwitch", "track", "fixedCamera")]}))
            .toEqual([]);
        expect(roleNames(rolesOf(keysOfTrack(track),
            {selectors: [orbit, selector("cameraTrackSwitch", "track", "orbitCamera")]}))).toEqual(["orbitCenter"]);
    });

    test("a selector that the table does not know gives its own label", () => {
        const world = {selectors: [selector("footballBroadcastCamSwitch", "track", "N97826", "Broadcast Camera")]};
        const roles = rolesOf(keysOfTrack(track), world);
        expect(roles).toEqual([{role: null, selector: "footballBroadcastCamSwitch", label: "Broadcast Camera"}]);
        expect(usedForText(roles)).toBe("Broadcast Camera");
    });

    test("the words of the Used For row and of the title note", () => {
        const roles = [{role: "cameraPosition"}, {role: "cameraFOV"}, {role: "cameraHeading"}, {role: "target"}];
        expect(usedForText(roles)).toBe("Camera position, FOV, heading, Target");
        // without "Camera position" before them, FOV and heading have their full names
        expect(usedForText([{role: "cameraFOV"}, {role: "cameraHeading"}])).toBe("Camera FOV, Camera heading");
        expect(noteWords(roles)).toEqual(["Camera", "Target"]);
        expect(noteWords([{role: "cameraFOV"}, {role: "windSource"}])).toEqual([]);
    });
});

describe("every link of a sitch", () => {
    test("objects are listed on their track, and an object on Manual has the uses of its option", () => {
        const balloon = {trackID: "balloonTrack_1", menuText: "Balloon", displayName: "Balloon",
            isBalloon: true, trackNode: {id: "balloonTrack_1"}};
        const sphere = makeObject("balloonObject_1", balloon.trackNode);
        const rider = makeUserObject("syntheticObject_1", {Balloon: balloon.trackNode}, "Balloon");
        const fixed = makeUserObject("syntheticObject_2");
        const world = {
            tracks: [balloon],
            objects: [sphere, rider.object, fixed.object],
            // the Position selectors of the two objects are not in this list (gatherWorld)
            selectors: [{id: "targetTrackSwitch", keyKind: "track", choice: "syntheticObject_2", label: "Target Track"}],
        };
        const links = describeLinks(world);
        expect(links.tracks.get(balloon).objects).toEqual([sphere, rider.object]);
        expect(links.objects.get(rider.object).roles).toEqual([]);
        expect(links.objects.get(fixed.object).source).toEqual({kind: "manual"});
        expect(links.objects.get(fixed.object).roles.map(entry => entry.role)).toEqual(["target"]);
    });
});

// --- the rows, in real menus ---------------------------------------------------------------

describe("the rows and title notes", () => {
    let containers, nodes, tracks, customManager;

    const makeMenu = (title) => {
        const container = document.createElement("div");
        document.body.appendChild(container);
        containers.push(container);
        return new GUI({container, autoPlace: false, title});
    };

    // The visible rows of a folder, top to bottom: "label | [button text]" for a link row,
    // "label = text" for a display row, the label alone for another row.
    const rowsOf = (folder) => [...folder.$children.children].map(element => {
        const controller = folder.controllers.find(c => c.domElement === element);
        if (!controller || controller._hidden) return null;
        if (controller._linkRowLabel !== undefined) return `${controller._linkRowLabel} | [${controller._name}]`;
        if (controller._displayOnly) return `${controller._name} = ${controller.getValue()}`;
        return controller._name;
    }).filter(Boolean);

    const noteOf = (folder) => folder.getTitleNote();

    // A track with its Contents folder and Name row, as TrackManager.initTrackDisplayName makes.
    function addTrack(trackOb) {
        trackOb.guiFolder = guiMenus.contents.addFolder(trackOb.displayName);
        addNameControl(trackOb.guiFolder, trackOb, {property: "displayName", id: trackOb.trackID, first: true});
        trackOb.guiFolder.add({extend: false}, "extend").name("Extend To Ground");
        tracks.push(trackOb);
        return trackOb;
    }

    // An object with its Objects folder and Name row, as CNode3DObject makes.
    function addObject(object) {
        object.gui = guiMenus.objects.addFolder(object.displayName);
        object.setDisplayName = (name) => { object.displayName = name; object.gui.title(name); };
        object.nameController = addNameControl(object.gui, object, {property: "displayName", first: true});
        object.gui.add({model: "sphere"}, "model").name("Model");
        nodes[object.id] = object;
        return object;
    }

    beforeEach(() => {
        containers = [];
        nodes = {};
        tracks = [];
        guiMenus.contents = makeMenu("Contents");
        guiMenus.objects = makeMenu("Objects");
        Globals.disposing = false;
        Globals.deserializing = false;
        Globals.loadGeneration = 1;
        setNodeMan({
            get: id => nodes[id],
            iterate: callback => Object.keys(nodes).forEach(id => callback(id, nodes[id])),
        });
        setTrackManager({iterate: callback => tracks.forEach(trackOb => callback(trackOb.trackID, trackOb))});
        customManager = {showTrackMenu: jest.fn(), showNodeEditMenu: jest.fn()};
        setCustomManager(customManager);
        setSit({dropTargets: {track: [], fov: [], angles: []}});
    });

    afterEach(() => {
        cancelTrackObjectLinksRefresh();
        EventManager.removeAll();
        guiMenus.contents.destroy();
        guiMenus.objects.destroy();
        delete guiMenus.contents;
        delete guiMenus.objects;
        containers.forEach(container => container.remove());
    });

    // A selector of the sitch, in the list that the model reads.
    function addSelector(id, kind, choice, labels = {}) {
        nodes[id] = {id, choice, inputs: {}, guiLabels: labels, controller: {_name: "*" + id}};
        Sit.dropTargets[kind].push(id);
        return nodes[id];
    }

    test("a balloon from an old save: each folder names the other, and the object has a note", () => {
        const balloon = addTrack({trackID: "balloonTrack_1", menuText: "Balloon", displayName: "Balloon",
            isBalloon: true, trackNode: {id: "balloonTrack_1"}});
        const sphere = addObject(makeObject("balloonObject_1", balloon.trackNode, {displayName: "Object 1"}));
        refreshTrackObjectLinks();

        expect(rowsOf(sphere.gui)).toEqual(["Name", "On Track | [Balloon]", "Model"]);
        expect(noteOf(sphere.gui)).toBe("on Balloon");
        expect(rowsOf(balloon.guiFolder)).toEqual(["Name", "Object | [Object 1]", "Wind Source = Target Wind", "Extend To Ground"]);
        expect(noteOf(balloon.guiFolder)).toBe("");

        // the buttons open the other menu; the properties are the ones the API matches
        sphere.showTrackController.object.showTrackMenu();
        expect(customManager.showTrackMenu).toHaveBeenCalledWith(
            expect.objectContaining({trackID: "balloonTrack_1", trackOb: balloon}), expect.any(Number), 0);
        balloon.guiFolder.controllers.find(c => c.property === "showObjectMenu").object.showObjectMenu();
        expect(customManager.showNodeEditMenu).toHaveBeenCalledWith(sphere, expect.any(Number), 0);
    });

    test("a pair with one name has the rows but no note", () => {
        const kite = addTrack({trackID: "kiteTrack_1", menuText: "Kite", displayName: "Kite",
            isKite: true, trackNode: {id: "kiteTrack_1"}});
        const object = addObject(makeObject("kiteObject_1", kite.trackNode, {displayName: "Kite"}));
        refreshTrackObjectLinks();
        expect(rowsOf(object.gui)).toContain("On Track | [Kite]");
        expect(noteOf(object.gui)).toBe("");
    });

    test("the rows follow a rename, without a new row", () => {
        const track = addTrack(loadedTrack("N97826"));
        const marker = addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826"}));
        refreshTrackObjectLinks();
        const link = marker.showTrackController;
        track.displayName = "Reaper";
        refreshTrackObjectLinks();
        expect(marker.showTrackController).toBe(link);
        expect(rowsOf(marker.gui)).toEqual(["Name", "On Track | [Reaper]", "Model"]);
        // the panel copy of the folder is keyed by a name that did not change
        expect(link._signatureName).toBe("link:onTrack");
    });

    test("a track that the camera and the target use says so, in a row and in a note", () => {
        const platform = addTrack(loadedTrack("N97826"));
        const center = addTrack(loadedTrack("Center_N97826"));
        addSelector("cameraTrackSwitch", "track", "N97826");
        addSelector("targetTrackSwitch", "track", "Center_N97826");
        addSelector("fovSwitch", "fov", "Track_N97826");
        addSelector("CameraLOSController", "angles", "Angles_N97826");
        refreshTrackObjectLinks();
        expect(rowsOf(platform.guiFolder)).toEqual(["Name", "Used For = Camera position, FOV, heading", "Extend To Ground"]);
        expect(noteOf(platform.guiFolder)).toBe("Camera");
        expect(noteOf(center.guiFolder)).toBe("Target");

        // the camera goes back to its manual position: the row hides and the note goes
        nodes.cameraTrackSwitch.choice = "fixedCamera";
        nodes.fovSwitch.choice = "userFOV";
        nodes.CameraLOSController.choice = "Manual";
        refreshTrackObjectLinks();
        expect(rowsOf(platform.guiFolder)).toEqual(["Name", "Extend To Ground"]);
        expect(noteOf(platform.guiFolder)).toBe("");
    });

    test("an object moves from one track to another, then to Manual", () => {
        const first = addTrack(handDrawnTrack("syntheticTrack_1", "Track 1"));
        const second = addTrack(handDrawnTrack("syntheticTrack_2", "Track 2"));
        const made = makeUserObject("syntheticObject_1",
            {"Track 1": first.smoothedTrackNode, "Track 2": second.smoothedTrackNode}, "Track 1");
        nodes[made.selector.id] = made.selector;
        const object = addObject(Object.assign(made.object, {displayName: "Object 1"}));
        refreshTrackObjectLinks();
        expect(rowsOf(first.guiFolder)).toContain("Object | [Object 1]");
        expect(rowsOf(second.guiFolder)).not.toContain("Object | [Object 1]");
        expect(noteOf(object.gui)).toBe("on Track 1");

        made.selector.choice = "Track 2";
        refreshTrackObjectLinks();
        expect(rowsOf(first.guiFolder)).not.toContain("Object | [Object 1]");
        expect(rowsOf(second.guiFolder)).toContain("Object | [Object 1]");
        expect(rowsOf(object.gui)).toContain("On Track | [Track 2]");

        made.selector.choice = OBJECT_MANUAL_POSITION;
        refreshTrackObjectLinks();
        expect(rowsOf(object.gui)).toEqual(["Name", "Model"]);
        expect(noteOf(object.gui)).toBe("");
        expect(rowsOf(second.guiFolder)).toEqual(["Name", "Extend To Ground"]);
    });

    test("an object on Manual that is the target says so", () => {
        const made = makeUserObject("syntheticObject_1");
        nodes[made.selector.id] = made.selector;
        const object = addObject(Object.assign(made.object, {displayName: "Tower"}));
        addSelector("targetTrackSwitch", "track", "syntheticObject_1");
        refreshTrackObjectLinks();
        expect(rowsOf(object.gui)).toEqual(["Name", "Used For = Target", "Model"]);
        expect(noteOf(object.gui)).toBe("Target");
    });

    test("the camera track says what the camera's position is", () => {
        const track = addTrack(loadedTrack("N97826"));
        const cameraSwitch = addSelector("cameraTrackSwitch", "track", "N97826", {fixedCamera: "Manual", orbitCamera: "Orbit"});
        cameraSwitch.inputs = {N97826: track.trackNode};
        const smooth = {id: "cameraTrackSwitchSmooth", inputs: {source: cameraSwitch}};
        const folder = guiMenus.contents.addFolder("Camera Track");
        folder.add({extend: false}, "extend").name("Extend To Ground");
        nodes.cameraDisplayTrack = {id: "cameraDisplayTrack", ownsGuiFolder: true, guiFolder: folder,
            menuTitle: "Camera Track", inputs: {track: smooth}};
        const cameraObject = addObject(makeObject("cameraObject", smooth, {displayName: "Camera Object"}));
        refreshTrackObjectLinks();

        expect(rowsOf(folder)).toEqual(["Object | [Camera Object]", "Camera Position = N97826", "Extend To Ground"]);
        expect(noteOf(folder)).toBe("follows N97826");
        expect(rowsOf(cameraObject.gui)).toContain("On Track | [Camera Track]");
        // always on its own track: a note would say nothing
        expect(noteOf(cameraObject.gui)).toBe("");

        cameraSwitch.choice = "fixedCamera";
        refreshTrackObjectLinks();
        expect(rowsOf(folder)).toContain("Camera Position = Manual");
        expect(noteOf(folder)).toBe("Manual");

        addSelector("orbitTargetSwitch", "track", "N97826");
        cameraSwitch.choice = "orbitCamera";
        refreshTrackObjectLinks();
        expect(rowsOf(folder)).toContain("Camera Position = Orbit around N97826");
        expect(noteOf(folder)).toBe("Orbit");
        expect(rowsOf(track.guiFolder)).toContain("Used For = Orbit center");
    });

    test("the traverse track says its method, and the method Target Object as what it means", () => {
        nodes.LOSTraverseSelectTrack = {id: "LOSTraverseSelectTrack", choice: "Constant Altitude", inputs: {}, guiLabels: {}};
        const folder = guiMenus.contents.addFolder("Traverse Track");
        nodes.traverseDisplayTrack = {id: "traverseDisplayTrack", ownsGuiFolder: true, guiFolder: folder,
            inputs: {track: {id: "traverseSmoothedTrack"}}};
        refreshTrackObjectLinks();
        expect(rowsOf(folder)).toEqual(["Traverse Method = Constant Altitude"]);
        nodes.LOSTraverseSelectTrack.choice = "Target Object";
        refreshTrackObjectLinks();
        expect(rowsOf(folder)).toEqual(["Traverse Method = Same as Target Track"]);
        expect(noteOf(folder)).toBe("");
    });

    test("the traverse object says when it is not drawn, and why", () => {
        const track = addTrack(loadedTrack("N97826"));
        const marker = addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826", rootTrack: track.trackDataNode}));
        const traverse = addObject(makeObject("traverseObject", {id: "traverseSmoothedTrack"},
            {displayName: "Traverse Object", rootTrack: track.trackDataNode}));
        refreshTrackObjectLinks();
        expect(rowsOf(traverse.gui)).toEqual(["Name", "Not Drawn = Same track as N97826", "Model"]);
        expect(rowsOf(marker.gui)).not.toContain("Not Drawn = Same track as Traverse Object");

        traverse.rootTrack = {id: "another"};
        refreshTrackObjectLinks();
        expect(rowsOf(traverse.gui)).toEqual(["Name", "Model"]);
    });

    test("a row that a rebuild of the folder removed is made again", () => {
        const track = addTrack(loadedTrack("N97826"));
        const marker = addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826"}));
        refreshTrackObjectLinks();
        // the rows of an object folder are marked so that a model change keeps them...
        expect(marker.showTrackController.isCommon).toBe(true);
        // ...but a handle is not trusted: a row that is gone is made again
        marker.showTrackController.destroy();
        refreshTrackObjectLinks();
        expect(rowsOf(marker.gui)).toEqual(["Name", "On Track | [N97826]", "Model"]);
    });

    test("an object that is deleted leaves the track's folder", () => {
        const track = addTrack(loadedTrack("N97826"));
        const marker = addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826"}));
        refreshTrackObjectLinks();
        expect(rowsOf(track.guiFolder)).toContain("Object | [N97826]");
        delete nodes[marker.id];
        refreshTrackObjectLinks();
        expect(rowsOf(track.guiFolder)).toEqual(["Name", "Extend To Ground"]);
    });

    test("a refresh with nothing changed writes nothing to the page", async () => {
        const track = addTrack(loadedTrack("N97826"));
        addObject(makeObject("N97826_ob", track.trackNode, {displayName: "Marker"}));
        addSelector("cameraTrackSwitch", "track", "N97826");
        refreshTrackObjectLinks();
        const changes = [];
        const observer = new MutationObserver(list => changes.push(...list));
        observer.observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true});
        refreshTrackObjectLinks();
        refreshTrackObjectLinks();
        await Promise.resolve();
        observer.disconnect();
        expect(changes).toEqual([]);
    });

    test("the API summary of each track", () => {
        const track = addTrack(loadedTrack("N97826"));
        addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826"}));
        const drawn = addTrack(handDrawnTrack("syntheticTrack_1", "Track 1"));
        addSelector("cameraTrackSwitch", "track", "N97826");
        const summaries = trackLinkSummaries();
        expect(summaries.get(track)).toEqual({kind: "loaded", objects: ["N97826"], usedFor: ["Camera position"]});
        expect(summaries.get(drawn)).toEqual({kind: "handDrawn", objects: [], usedFor: []});
    });

    describe("when the refresh runs", () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        const linked = () => {
            const track = addTrack(loadedTrack("N97826"));
            const marker = addObject(makeObject("N97826_ob", track.trackNode, {displayName: "N97826"}));
            return () => rowsOf(marker.gui).includes("On Track | [N97826]");
        };

        test("many requests in one turn make one refresh, after the turn", () => {
            const done = linked();
            scheduleTrackObjectLinksRefresh();
            scheduleTrackObjectLinksRefresh();
            expect(done()).toBe(false);
            expect(jest.getTimerCount()).toBe(1);
            jest.runAllTimers();
            expect(done()).toBe(true);
        });

        test("a request during a sitch load does nothing: the load asks at its end", () => {
            const done = linked();
            Globals.deserializing = true;
            scheduleTrackObjectLinksRefresh();
            jest.runAllTimers();
            expect(done()).toBe(false);
            Globals.deserializing = false;
            scheduleTrackObjectLinksRefresh();
            jest.runAllTimers();
            expect(done()).toBe(true);
        });

        test("a request from a sitch that was left does nothing in the next one", () => {
            const done = linked();
            scheduleTrackObjectLinksRefresh();
            Globals.loadGeneration++;
            jest.runAllTimers();
            expect(done()).toBe(false);
        });

        test("a selector change asks for a refresh, and the listener stays", () => {
            const done = linked();
            installTrackObjectLinks();
            jest.runAllTimers();
            expect(done()).toBe(true);
            // The event manager removes a listener that returns a true value.
            for (let i = 0; i < 2; i++) {
                EventManager.dispatchEvent("Switch.choiceChanged", {id: "cameraTrackSwitch", choice: "N97826"});
                expect(jest.getTimerCount()).toBe(1);
                jest.runAllTimers();
            }
            // installed again on the next load: still one listener for each event
            installTrackObjectLinks();
            expect(EventManager.events["Switch.choiceChanged"]).toHaveLength(1);
        });

        test("an error in the rows does not go out of the refresh", () => {
            linked();
            const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
            setTrackManager({iterate: () => { throw new Error("broken"); }});
            scheduleTrackObjectLinksRefresh();
            expect(() => jest.runAllTimers()).not.toThrow();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });
});

test("a satellite track is an option under its trackName, and says what it is used for", () => {
    const satellite = {id: "satelliteTrack", trackName: "Satellite"};
    const display = {id: "satelliteDisplayTrack", ownsGuiFolder: true, inputs: {track: satellite}};
    const links = describeLinks({
        builtInTracks: [display],
        selectors: [{id: "targetTrackSwitch", keyKind: "track", choice: "Satellite", label: "Target Track"}],
    });
    expect(links.builtIn.get(display).roles.map(entry => entry.role)).toEqual(["target"]);
    // a display track with no such name (the camera track) has no uses of its own
    const camera = {id: "cameraDisplayTrack", ownsGuiFolder: true, inputs: {track: {id: "cameraTrackSwitchSmooth"}}};
    expect(describeLinks({builtInTracks: [camera]}).builtIn.get(camera).roles).toEqual([]);
});
