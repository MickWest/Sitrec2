// Removing every track un-establishes the sitch only when track imports alone established it
// (Globals.sitchEstablishedByTrackImport). A camera, time or position the user set up must
// survive Remove All Tracks, or the next dropped track takes the camera over again.
// TrackManager.disposeRemove is taken from its class (the module imports the whole scene)
// and run against the real Globals helpers.

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import {CManager} from "../src/CManager";
import {
    Globals,
    isSitchEstablishedByUser,
    setSitchEstablished,
    setSitchEstablishedByTrackImport,
} from "../src/Globals";

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

let trackManager;

beforeEach(() => {
    const context = {
        CManager,
        Globals,
        isSitchEstablishedByUser,
        setSitchEstablished,
        setSitchEstablishedByTrackImport,
        GlobalDateTimeNode: null,
        FileManager: {exists: () => false},
        Sit: {},
        hasOtherTrackSourceReference: () => false,
    };
    const trackMethods = classMethods("../src/TrackManager.js", "CTrackManager", ["disposeRemove"], context);
    trackManager = Object.assign(Object.create(trackMethods), new CManager());
    trackManager.notifyTracksChanged = jest.fn();

    // A fresh sitch (New Sitch).
    setSitchEstablished(false);
});

// What TrackManager.addTracks does with the flag around building the tracks.
function importTracks(ids, duringImport = () => {}) {
    const byUserBeforeImport = isSitchEstablishedByUser();
    for (const id of ids) trackManager.add(id, {id});
    duringImport();
    setSitchEstablishedByTrackImport(byUserBeforeImport);
}

function removeAllTracks() {
    trackManager.iterate(id => trackManager.disposeRemove(id));
}

test("a fresh sitch set up only by a track import is fresh again once every track goes", () => {
    importTracks(["Track_A", "Track_B"]);
    expect(Globals.sitchEstablished).toBe(true);
    expect(isSitchEstablishedByUser()).toBe(false);

    removeAllTracks();
    expect(trackManager.size()).toBe(0);
    expect(Globals.sitchEstablished).toBe(false);
});

test("removing every track keeps a camera the user set up after the import", () => {
    importTracks(["Track_A", "Track_B"]);
    // e.g. the cameraTrackSwitch / fixedCameraPosition listeners in CustomManagerSetup
    setSitchEstablished(true);
    expect(isSitchEstablishedByUser()).toBe(true);

    removeAllTracks();
    expect(Globals.sitchEstablished).toBe(true);

    // and a later import does not hand the setup back to the tracks
    importTracks(["Track_C"]);
    removeAllTracks();
    expect(Globals.sitchEstablished).toBe(true);
});

test("a setup the user made before the first import is kept too", () => {
    setSitchEstablished(true);
    importTracks(["Track_A"]);
    expect(isSitchEstablishedByUser()).toBe(true);

    removeAllTracks();
    expect(Globals.sitchEstablished).toBe(true);
});

test("a camera switch the import itself selects does not count as a user setup", () => {
    // Selecting a NITF or measured-angles camera track fires the same switch event as a
    // user edit, part-way through the import.
    importTracks(["Track_A"], () => setSitchEstablished(true));
    expect(isSitchEstablishedByUser()).toBe(false);

    removeAllTracks();
    expect(Globals.sitchEstablished).toBe(false);
});

test("removing the camera track is not a user setup, though its switch falls back through the user-edit event", () => {
    // CMetaTrack.dispose takes the track out of cameraTrackSwitch. The switch falls back to
    // its first option with a non-quiet selectOption, which fires
    // Switch.onChange.cameraTrackSwitch, and the CustomManagerSetup listener calls
    // setSitchEstablished(true).
    importTracks(["Track_A", "Track_B"]);
    trackManager.get("Track_A").dispose = () => setSitchEstablished(true);

    removeAllTracks();
    expect(Globals.sitchEstablished).toBe(false);
});

test("a second import into a sitch set up by tracks alone stays un-establishable", () => {
    importTracks(["Track_A"]);
    importTracks(["Track_B"]);
    expect(isSitchEstablishedByUser()).toBe(false);

    trackManager.disposeRemove("Track_A");
    expect(Globals.sitchEstablished).toBe(true);
    trackManager.disposeRemove("Track_B");
    expect(Globals.sitchEstablished).toBe(false);
});

test("New Sitch clears the track-import marker", () => {
    importTracks(["Track_A"]);
    setSitchEstablished(false);
    expect(Globals.sitchEstablished).toBe(false);
    expect(Globals.sitchEstablishedByTrackImport).toBe(false);
});
