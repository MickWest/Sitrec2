/** @jest-environment jsdom */
/**
 * A video imported into an empty view (the importMedia API call, which is what the MCP bridge
 * and the chat assistant use) must keep Sit.frames defined while the video loads.
 *
 * Sit.frames feeds the "frames" watch node, and the custom sitch's Turn Rate value reads it
 * through CNodeMath ("$turnRate * $frames / $fps"). newVideo() used to set Sit.frames to
 * undefined until the loader knew the new count. Any recalculation in that window - the render
 * loop's watch update, or the full recalculation on the early "videoLoaded" event - then
 * threw "Cannot read properties of undefined (reading 'position')" in evaluateExpression. The
 * second one is caught by the MP4 loader, which shows an error dialog and abandons the import.
 */
jest.mock("../../src/CVideoMp4Data", () => ({CVideoMp4Data: jest.fn(function () { this.frames = 0; })}));
jest.mock("../../src/CVideoLoadingManager", () => ({VideoLoadingManager: {registerLoading: jest.fn(), completeLoading: jest.fn()}}));

import {Globals, setGlobalDateTimeNode, setNodeMan, setSit, Sit} from "../../src/Globals";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeWatch} from "../../src/nodes/CNodeWatch";
import {CNodeGUIValue} from "../../src/nodes/CNodeGUIValue";
import {CNodeVideoView} from "../../src/nodes/CNodeVideoView";
import {updateSitFrames} from "../../src/UpdateSitFrames";

// The prototype's newVideo() on an empty, timeline-owning view. Only the DOM helpers are stubbed.
function emptyVideoView() {
    const view = Object.create(CNodeVideoView.prototype);
    Object.assign(view, {id: "video", ownsTimeline: true, videos: [], videoData: null, videoSpeed: 1});
    for (const method of ["invalidateELAResult", "disposeVideoData", "addVideoEntry", "addLoadingMessage", "addDownloadButton"]) {
        view[method] = jest.fn();
    }
    return view;
}

// A GUI value with no menu. setValue() stores the value itself; the menu entry only mirrors it.
function guiValue(v) {
    const node = new CNodeGUIValue(v);
    node.guiEntry = {setValue: () => {}, setValueQuietly: () => {}};
    return node;
}

let consoleError;
beforeEach(() => {
    setNodeMan(new CNodeManager());
    setSit({frames: 900, fps: 30, aFrame: 0, bFrame: 899, framesFromVideo: true});
    setGlobalDateTimeNode({changedFrames: jest.fn()});
    Globals.pendingActions = 0;
    // The same nodes the custom sitch builds: the watches first (index.js), then the pair of
    // linked GUI values from SitCustom.js.
    new CNodeWatch({id: "frames", ob: "Sit", watchID: "frames"});
    new CNodeWatch({id: "fps", ob: "Sit", watchID: "fps"});
    guiValue({id: "turnRate", value: 0, start: -10, end: 10, step: 0.001,
        quietLink: "totalTurn", linkMath: "$turnRate * $frames / $fps"});
    guiValue({id: "totalTurn", value: 0, start: -360, end: 360, step: 0.1,
        link: "turnRate", linkMath: "$totalTurn / ($frames / $fps)"});
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "trace").mockImplementation(() => {});
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

test("importing into an empty view keeps the old frame count until the video's own count arrives", () => {
    emptyVideoView().newVideo("clip.mp4", true);

    expect(Sit.frames).toBe(900);
});

test("the graph recalculates without error while the video loads", () => {
    const {NodeMan} = require("../../src/Globals");
    emptyVideoView().newVideo("clip.mp4", true);

    // the render loop's per-frame watch update, and the custom sitch's "videoLoaded" handler
    expect(() => NodeMan.get("frames").update(0)).not.toThrow();
    expect(() => NodeMan.recalculateAllRootFirst()).not.toThrow();
    expect(consoleError.mock.calls.filter(args => String(args[0]).startsWith("ASSERT"))).toEqual([]);
});

test("the loaded video's frame count still replaces the old one", () => {
    const {NodeMan} = require("../../src/Globals");
    NodeMan.get("turnRate").value = 1;   // degrees per second
    emptyVideoView().newVideo("clip.mp4", true);

    // what the loader does when it finishes
    Sit.videoFrames = 45;
    updateSitFrames();
    NodeMan.get("frames").update(0);

    expect(Sit.frames).toBe(45);
    expect(Sit.bFrame).toBe(44);
    expect(NodeMan.get("frames").getValueFrame(0)).toBe(45);
    // Total Turn follows the new length: 1 deg/s over 45 frames at 30 fps
    expect(NodeMan.get("totalTurn").value).toBeCloseTo(1.5, 10);
});
