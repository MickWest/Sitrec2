/**
 * @jest-environment jsdom
 *
 * Lock Aspect with a video loaded.
 *
 * Only the vertical FOV is stored; HFOV is that angle read through fovAspect. Loading a video
 * turns Lock Aspect on at the video's aspect, as it always did, but the user may now turn it off
 * and quote HFOV against the look view pane instead. Saves from before that was possible must
 * load with the same VFOV and HFOV as they always did.
 *
 * These drive the real controller through a real lil-gui folder, the same way
 * PanAzimuth360.test.js does, because ticking the box goes through its onChange.
 */

import GUI, {Controller} from '../src/js/lil-gui.esm';
import '../src/MenuMirror';        // installs Controller.mirrorTo / GUI.mirrorFolderFrom

jest.mock('../src/Globals', () => {
    const nodes = {};
    return {
        NodeMan: {
            add: (id, node) => { nodes[id] = node; return node; },
            get: (id) => nodes[id] ?? null,
            exists: (id) => Object.prototype.hasOwnProperty.call(nodes, id),
            list: nodes,
        },
        guiMenus: {},
        Sit: {frames: 100, fps: 30},
        Globals: {},
        setRenderOne: () => {},
        infoDiv: null,
        SitchMan: {},
    };
});

jest.mock('../src/showError', () => ({showError: jest.fn()}));

if (!window.matchMedia) window.matchMedia = () => ({matches: false, addListener() {}, removeListener() {}});
if (!Controller.prototype.tooltip) Controller.prototype.tooltip = function () { return this; };
if (!Controller.prototype.setLabelColor) Controller.prototype.setLabelColor = function () { return this; };

const {NodeMan} = require('../src/Globals');
const {CNodeControllerPTZUI} = require('../src/nodes/CNodeControllerPTZUI');

const PANE = 1.6;              // the look view pane: 16:10, deliberately not any video's shape
let idCounter = 0;

function makePTZ() {
    const ptz = new CNodeControllerPTZUI({
        id: "testPTZ" + (idCounter++),
        az: 0, el: 0, fov: 30, roll: 0,
        showGUI: true, gui: new GUI({autoPlace: false}),
    });
    // The pane lookup needs a real view; the pane's shape is all that matters here.
    ptz.liveAspect = () => PANE;
    return ptz;
}

function loadVideo(w, h) {
    NodeMan.add("video", {videoData: {originalVideoWidth: w, originalVideoHeight: h, videoWidth: w, videoHeight: h}});
}

function removeVideo() {
    NodeMan.get("video").videoData = null;
}

const hfovFor = (vfov, a) => 2 * Math.atan(a * Math.tan(vfov * Math.PI / 360)) * 180 / Math.PI;

/** fovAspect as it was before the lock could be turned off with a video loaded (once the video has its size). */
function oldFovAspect(ptz) {
    const size = NodeMan.get("video")?.videoData;
    if (size?.originalVideoWidth > 0) return size.originalVideoWidth / size.originalVideoHeight;
    if (ptz.lockAspect) return ptz.lockedAspect;
    return PANE;
}

beforeEach(() => {
    for (const id in NodeMan.list) delete NodeMan.list[id];
});

test("loading a video turns Lock Aspect on at the video's aspect, and the box stays usable", () => {
    const ptz = makePTZ();
    expect(ptz.lockAspect).toBe(false);
    expect(ptz.fovAspect).toBe(PANE);

    loadVideo(1920, 1080);
    // No apply() here: a read alone catches up, as it must while another heading source
    // owns the camera and this controller is disabled.
    expect(ptz.fovAspect).toBe(1920 / 1080);
    expect(ptz.lockAspect).toBe(true);
    expect(ptz.lockedAspect).toBe(1920 / 1080);
    expect(ptz.hfov).toBeCloseTo(hfovFor(30, 16 / 9), 10);
    expect(ptz.lockAspectController._disabled).toBe(false);

    ptz.updateAspectReadout();
    expect(ptz.aspectDisplay).toBe("1.7778  (1920×1080)");
});

test("turning the lock off with a video quotes HFOV against the pane, and it stays off", () => {
    const ptz = makePTZ();
    loadVideo(1920, 1080);
    expect(ptz.fovAspect).toBe(1920 / 1080);

    ptz.lockAspectController.setValue(false);
    for (let i = 0; i < 5; i++) expect(ptz.fovAspect).toBe(PANE);
    expect(ptz.lockAspect).toBe(false);
    expect(ptz.fov).toBe(30);                                  // the camera did not move
    expect(ptz.hfov).toBeCloseTo(hfovFor(30, PANE), 10);

    // The readout shows the pane's ratio, without the video's pixels beside it.
    ptz.updateAspectReadout();
    expect(ptz.aspectDisplay).toBe("1.6000");
});

test("the readout follows a click on Lock Aspect even when apply() is not running", () => {
    // Another heading source (To Target) or Free Look stops apply(), and with it the per-frame
    // readout refresh. The click itself must still leave the readout naming the frame HFOV uses.
    const ptz = makePTZ();
    loadVideo(1920, 1080);
    ptz.updateAspectReadout();
    expect(ptz.aspectDisplay).toBe("1.7778  (1920×1080)");

    ptz.lockAspectController.setValue(false);
    expect(ptz.aspectDisplay).toBe("1.6000");
    ptz.lockAspectController.setValue(true);
    expect(ptz.aspectDisplay).toBe("1.7778  (1920×1080)");
});

test("turning the lock on again locks to the video if there is one, else to the pane", () => {
    const ptz = makePTZ();
    loadVideo(1440, 1080);
    expect(ptz.fovAspect).toBe(4 / 3);
    ptz.lockAspectController.setValue(false);
    expect(ptz.fovAspect).toBe(PANE);
    ptz.lockAspectController.setValue(true);
    expect(ptz.lockedAspect).toBe(4 / 3);
    expect(ptz.fovAspect).toBe(4 / 3);

    for (const id in NodeMan.list) delete NodeMan.list[id];
    const noVideo = makePTZ();
    noVideo.lockAspectController.setValue(true);
    expect(noVideo.fovAspect).toBe(PANE);
});

test("removing the video puts back the setting from before it, unless the lock was turned off", () => {
    // Locked at 3:2 before the video; two videos in turn; then none.
    const ptz = makePTZ();
    Object.assign(ptz, {lockAspect: true, lockedAspect: 1.5});
    loadVideo(1920, 1080);
    expect(ptz.fovAspect).toBe(1920 / 1080);
    loadVideo(1440, 1080);                       // straight to a video of another shape
    expect(ptz.fovAspect).toBe(4 / 3);
    removeVideo();
    expect(ptz.fovAspect).toBe(1.5);
    expect(ptz.lockAspect).toBe(true);

    // Turned off while the video was loaded: that is the user's setting, so it stays.
    for (const id in NodeMan.list) delete NodeMan.list[id];
    const other = makePTZ();
    loadVideo(1920, 1080);
    expect(other.fovAspect).toBe(1920 / 1080);
    other.lockAspectController.setValue(false);
    removeVideo();
    expect(other.lockAspect).toBe(false);
    expect(other.fovAspect).toBe(PANE);

    // Loading a video again turns the lock on again.
    loadVideo(1920, 1080);
    expect(other.fovAspect).toBe(1920 / 1080);
    expect(other.lockAspect).toBe(true);
});

test("an old save with a video loads locked to the video, with the same VFOV and HFOV as before", () => {
    const oldSaves = [
        // Saved while the video forced the lock on: lockAspect true, lockedAspect not the video's.
        {az: 10, el: 5, fov: 20, roll: 0, lockAspect: true, lockedAspect: 16 / 9},
        {az: 10, el: 5, fov: 20, roll: 0, lockAspect: true, lockedAspect: 1.5},
        // Saved before Lock Aspect existed.
        {az: 10, el: 5, fov: 20, roll: 0},
    ];
    for (const save of oldSaves) {
        for (const id in NodeMan.list) delete NodeMan.list[id];
        const ptz = makePTZ();
        ptz.modDeserialize(save);

        // Before the video arrives, and while it is still loading (placeholder size only).
        expect(ptz.fovAspect).toBe(oldFovAspect(ptz));
        NodeMan.add("video", {videoData: {originalVideoWidth: 0, originalVideoHeight: 0, videoWidth: 100, videoHeight: 100}});
        expect(ptz.fovAspect).toBe(oldFovAspect(ptz));

        loadVideo(1440, 1080);
        const before = oldFovAspect(ptz);
        expect(before).toBe(4 / 3);
        expect(ptz.fovAspect).toBe(before);
        expect(ptz.lockAspect).toBe(true);
        expect(ptz.fov).toBe(20);
        expect(ptz.hfov).toBeCloseTo(hfovFor(20, before), 10);
    }
});

test("a new save keeps the user's choice when it is loaded again", () => {
    // Unlocked with a video: reloads unlocked, through the video's loading frames.
    const first = makePTZ();
    loadVideo(1920, 1080);
    expect(first.fovAspect).toBe(1920 / 1080);
    first.lockAspectController.setValue(false);
    const unlockedSave = JSON.parse(JSON.stringify(first.modSerialize()));

    for (const id in NodeMan.list) delete NodeMan.list[id];
    const reloaded = makePTZ();
    reloaded.modDeserialize(unlockedSave);
    expect(reloaded.fovAspect).toBe(PANE);
    NodeMan.add("video", {videoData: {originalVideoWidth: 0, originalVideoHeight: 0, videoWidth: 100, videoHeight: 100}});
    expect(reloaded.fovAspect).toBe(PANE);
    loadVideo(1920, 1080);
    expect(reloaded.fovAspect).toBe(PANE);
    expect(reloaded.lockAspect).toBe(false);

    // Locked with a video: reloads locked to the video, even before the video is back.
    for (const id in NodeMan.list) delete NodeMan.list[id];
    const lockedFirst = makePTZ();
    loadVideo(1440, 1080);
    expect(lockedFirst.fovAspect).toBe(4 / 3);
    const lockedSave = JSON.parse(JSON.stringify(lockedFirst.modSerialize()));

    for (const id in NodeMan.list) delete NodeMan.list[id];
    const lockedReloaded = makePTZ();
    lockedReloaded.modDeserialize(lockedSave);
    expect(lockedReloaded.fovAspect).toBe(4 / 3);
    loadVideo(1440, 1080);
    expect(lockedReloaded.fovAspect).toBe(4 / 3);
    expect(lockedReloaded.lockAspect).toBe(true);
});
