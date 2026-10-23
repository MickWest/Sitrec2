// One dropped file with several tracks and no declared camera/target roles used to make its
// first track the camera and its second the target, and turn Camera Heading to "To Target".
// The import now asks first (TrackManager.shouldAskLoadOrderPairing / askLoadOrderPairing);
// "No" adds the tracks as switch options without selecting them (updateDropTargets'
// pairByLoadOrder). The methods are taken from their class (the module imports the whole
// scene) and run against fake switches.

import fs from "fs";
import path from "path";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CManager} from "../src/CManager";
import {shouldPreserveAnglesHeading} from "../src/trackSourceUtils";
import {t} from "../src/i18n";

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

class FakeSwitch {
    constructor(id, options, choice) {
        this.id = id;
        this.inputs = Object.fromEntries(options.map(option => [option, {}]));
        this.choice = choice;
    }
    addOption(name, node) { this.inputs[name] = node; }
    removeOption(name) { delete this.inputs[name]; }
    selectOption(name) { this.choice = name; }
    selectOptionQuietly(name) { this.choice = name; }
}

// A file with `count` independent tracks, e.g. an ADS-B Exchange KML. No roles unless given.
function makeFile(count, {importCount = count, roles = [], ...rest} = {}) {
    return {
        getTrackCount: () => count,
        getImportTrackCount: () => importCount,
        trackRoleHint: (i) => roles[i] ?? null,
        isSupplementaryTrack: () => false,
        getShortName: (i) => "N" + (100 + i),
        ...rest,
    };
}

let context;
let trackManager;
let nodes;

beforeEach(() => {
    nodes = {
        cameraTrackSwitch: new FakeSwitch("cameraTrackSwitch", ["fixedCamera", "flightSimCamera"], "fixedCamera"),
        targetTrackSwitch: new FakeSwitch("targetTrackSwitch", ["fixedTarget", "fixedTarget + Wind"], "fixedTarget"),
        zoomToTrack: new FakeSwitch("zoomToTrack", [], undefined),
        CameraLOSController: new FakeSwitch("CameraLOSController", ["Manual", "To Target"], "Manual"),
    };
    context = {
        console, t, CManager, shouldPreserveAnglesHeading,
        Globals: {sitchEstablished: false},
        window: {},
        // The custom sitch's drop targets (data/custom/SitCustom.js).
        Sit: {dropTargets: {track: ["cameraTrackSwitch-1", "targetTrackSwitch-2", "zoomToTrack"]}},
        NodeMan: {
            exists: (id) => id in nodes,
            get: (id) => nodes[id],
        },
        FileManager: {get: () => context.file},
        MISB: {SensorVerticalFieldofView: 0, PlatformPitchAngle: 1, WindSpeed: 2},
        showChoice: jest.fn(),
        file: makeFile(13),
    };
    const methods = classMethods(path.resolve(__dirname, "../src/TrackManager.js"), "CTrackManager",
        ["shouldAskLoadOrderPairing", "askLoadOrderPairing", "updateDropTargets"], context);
    trackManager = Object.assign(Object.create(methods), new CManager());
    trackManager.relabelTrackOptions = () => {};
});

describe("shouldAskLoadOrderPairing", () => {
    const ask = (file = context.file, trackFiles = ["flights.kml"]) =>
        trackManager.shouldAskLoadOrderPairing(file, trackFiles);

    test("asks for one file of several roleless tracks dropped into a fresh sitch", () => {
        expect(ask()).toBe(true);
        expect(ask(makeFile(2))).toBe(true);
    });

    test("does not ask for a one-track file", () => {
        expect(ask(makeFile(1))).toBe(false);
    });

    test("does not ask for a MISB file whose second track is its own Center track", () => {
        expect(ask(makeFile(2, {importCount: 1}))).toBe(false);
    });

    test("does not ask for a file that declares its roles (STANAG, BOT)", () => {
        expect(ask(makeFile(3, {roles: ["camera", null, "target"]}))).toBe(false);
        expect(ask(makeFile(2, {roles: [null, "target"]}))).toBe(false);
    });

    test("does not ask for a file that is its own camera (NITF) or a sounding", () => {
        expect(ask(makeFile(2, {autoSelectAsCamera: true}))).toBe(false);
        expect(ask(makeFile(2, {isSondeTrack: () => true}))).toBe(false);
    });

    test("does not ask once the sitch is set up, or when a track is already loaded", () => {
        context.Globals.sitchEstablished = true;
        expect(ask()).toBe(false);
        context.Globals.sitchEstablished = false;
        trackManager.add("Track_first", {});
        expect(ask()).toBe(false);
    });

    // One addTracks call with several files (FlightClub stages). Files dropped together by
    // drag and drop are parsed separately and each reaches addTracks on its own.
    test("does not ask when one call imports several files", () => {
        expect(ask(context.file, ["a.kml", "b.kml"])).toBe(false);
    });

    test("does not ask the regression harness or the MCP bridge", () => {
        context.Globals.regression = true;
        expect(ask()).toBe(false);
        context.Globals.regression = false;
        context.window._mcpDebug = true;
        expect(ask()).toBe(false);
    });

    test("does not ask in a sitch with no camera and target switches to pair into", () => {
        // The night sky sitch: one camera switch, fed controllers.
        context.Sit = {dropTargets: {track: ["cameraSwitch"]}, dropAsController: true};
        expect(ask()).toBe(false);
    });
});

describe("askLoadOrderPairing", () => {
    test("names the two tracks and pairs on yes", async () => {
        context.showChoice.mockResolvedValue("pair");
        expect(await trackManager.askLoadOrderPairing(context.file, "flights.kml")).toBe(true);
        const [message, options] = context.showChoice.mock.calls[0];
        expect(message).toContain("13 tracks");
        expect(message).toContain("\"N100\"");
        expect(message).toContain("\"N101\"");
        // Closing the dialog keeps the old behaviour.
        expect(options.cancelValue).toBe("pair");
    });

    test("does not pair on no", async () => {
        context.showChoice.mockResolvedValue("noPair");
        expect(await trackManager.askLoadOrderPairing(context.file, "flights.kml")).toBe(false);
    });
});

describe("updateDropTargets pairing", () => {
    // What addTracks does for each track of the file, in load order.
    function importTracks(count, pairByLoadOrder) {
        for (let i = 0; i < count; i++) {
            const shortName = "N" + (100 + i);
            const trackID = "Track_" + shortName;
            const trackOb = {trackFileName: "flights.kml", trackIndex: i, shortName};
            trackManager.add(trackID, trackOb);
            const trackNode = {id: trackID, v: () => ({misbRow: []})};
            nodes[trackID] = trackNode;
            trackManager.updateDropTargets(trackManager.size(), shortName, trackID, "TrackData_" + shortName,
                trackNode, false, trackOb, pairByLoadOrder);
        }
    }

    test("yes: the first track is the camera, the second the target, heading To Target", () => {
        importTracks(3, true);
        expect(nodes.cameraTrackSwitch.choice).toBe("N100");
        expect(nodes.targetTrackSwitch.choice).toBe("N101");
        expect(nodes.CameraLOSController.choice).toBe("To Target");
    });

    test("no: the tracks are options, but camera, target and heading do not change", () => {
        importTracks(3, false);
        expect(nodes.cameraTrackSwitch.choice).toBe("fixedCamera");
        expect(nodes.targetTrackSwitch.choice).toBe("fixedTarget");
        expect(nodes.CameraLOSController.choice).toBe("Manual");
        for (const name of ["N100", "N101", "N102"]) {
            expect(nodes.cameraTrackSwitch.inputs[name]).toBeDefined();
            expect(nodes.targetTrackSwitch.inputs[name]).toBeDefined();
        }
        // Not a camera/target switch, so not part of the question.
        expect(nodes.zoomToTrack.choice).toBe("N102");
    });
});
