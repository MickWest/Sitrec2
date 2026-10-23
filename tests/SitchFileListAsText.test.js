/** @jest-environment jsdom */

// While a sitch loads, CSituation.loadAssets() lists each of its files in the info box. Those
// names are the values of the sitch's `files` dictionary, and a sitch can come from any URL
// with ?custom=, so the list must show them as text. Written as HTML, a value such as
// <img src=x onerror=...> ran its script on the page's origin as soon as the link was opened.
// These run the real loadAssets() with the asset loader stubbed out.

import {beforeEach, expect, jest, test} from "@jest/globals";

let mockInfoDiv;

jest.mock("../src/Globals", () => ({
    // A getter, so each test can give loadAssets() a fresh box to write into.
    get infoDiv() { return mockInfoDiv; },
    FileManager: {loadAsset: jest.fn()},
    Sit: {},
    TrackManager: {},
    Units: {},
}));
jest.mock("../src/configUtils", () => ({isConsole: false, setupConfigPaths: jest.fn()}));
jest.mock("../src/ExtraFiles", () => ({NightSkyFiles: {}}));
jest.mock("../src/nodes/CNode", () => ({CNodeConstant: class {}}));
jest.mock("../src/nodes/CNodeDisplayTrack", () => ({CNodeDisplayTrack: class {}}));
jest.mock("../src/nodes/CNodePositionLLA", () => ({makePositionLLA: jest.fn()}));
jest.mock("../src/SituationSetup", () => ({expandSitData: jest.fn()}));
jest.mock("../src/utils", () => ({updateNewCustomFields: jest.fn()}));
jest.mock("../src/LLA-ECEF-ENU", () => ({updateEarthRadii: jest.fn()}));
jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));

import {FileManager} from "../src/Globals";
import {CSituation} from "../src/CSituation";

const PAYLOAD = '<img src=x onerror="globalThis.__xss=1">';

beforeEach(() => {
    delete globalThis.__xss;
    document.body.innerHTML = "";
    mockInfoDiv = document.createElement("div");
    mockInfoDiv.textContent = "Loading";       // what index.js puts there before any sitch loads
    document.body.appendChild(mockInfoDiv);
    FileManager.loadAsset.mockReset();
});

// loadAssets() empties the box when it finishes, so look at it while each file "loads".
function recordInfoDivWhileLoading() {
    const seen = [];
    FileManager.loadAsset.mockImplementation(async (filename) => {
        // A browser fires onerror for an image that fails to load. jsdom loads no images, so
        // fire it here: if markup got in, its handler runs as it would on the live page.
        for (const img of mockInfoDiv.querySelectorAll("img")) img.dispatchEvent(new Event("error"));
        seen.push({
            filename,
            html: mockInfoDiv.innerHTML,
            text: mockInfoDiv.textContent,
            images: mockInfoDiv.querySelectorAll("img").length,
        });
    });
    return seen;
}

test("a file name with markup in it is shown as text and runs nothing", async () => {
    const seen = recordInfoDivWhileLoading();

    await CSituation.prototype.loadAssets.call({files: {TargetTrack: PAYLOAD}});

    expect(seen).toHaveLength(1);
    expect(seen[0].filename).toBe(PAYLOAD);           // the loader still gets the value itself
    expect(globalThis.__xss).toBeUndefined();
    expect(seen[0].images).toBe(0);
    expect(seen[0].text).toBe("Loading" + PAYLOAD);
});

test("the list looks as it did: one file per line, in sitch order, then cleared and hidden", async () => {
    const seen = recordInfoDivWhileLoading();

    await CSituation.prototype.loadAssets.call({
        files: {cameraFile: "data/camera.kml", TargetTrack: "data/target.csv", videoFile: "v.mp4"},
    });

    // videoFile is loaded elsewhere and never listed.
    expect(seen.map(s => s.filename)).toEqual(["data/camera.kml", "data/target.csv"]);
    expect(seen[0].html).toBe("Loadingdata/camera.kml<br>");
    expect(seen[1].html).toBe("Loadingdata/camera.kml<br>data/target.csv<br>");
    expect(mockInfoDiv.innerHTML).toBe("");
    expect(mockInfoDiv.style.display).toBe("none");
});
