/**
 * @jest-environment jsdom
 */
// The MX overlay's mode, focal length and digital zoom readouts, with and
// without per-frame camera data. The view base class is replaced by a stub so
// the real constructor lays out the real grid without a canvas.
jest.mock("../src/nodes/CNodeViewUI", () => ({
    CNodeViewUI: class {
        constructor(v) {
            this.props = v;
        }

        input() {}
    },
}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));

import {CNodeWescamMXUI} from "../src/nodes/CNodeWescamMXUI";
import {CNodeCameraState} from "../src/nodes/CNodeCameraState";
import {parseCameraStateCSV} from "../src/CameraStateTable";
import {setFileManager, setNodeMan} from "../src/Globals";
import csv from "../src/utils/CSVParser";

const GRAY = "#888888";
const WHITE = "#FFFFFF";

// Vertical FOV whose 35mm-equivalent focal length (24 mm frame height) is 600 mm.
const VFOV_600 = 2 * Math.atan(12 / 600) * 180 / Math.PI;

let nodes;
let overlay;
beforeEach(() => {
    nodes = new Map();
    setNodeMan({add: (id, node) => nodes.set(id, node), get: (id) => nodes.get(id), exists: (id) => nodes.has(id)});
    setFileManager({removeExportButton: () => {}});
    overlay = new CNodeWescamMXUI({id: "WescamMXUI", camera: "lookCamera"});
});

function cameraData(text) {
    const node = new CNodeCameraState({id: "cameraState", gui: false});
    node.setTable(parseCameraStateCSV(csv.toArrays(text), {sourceName: "camera.csv"}));
    return node;
}

const texts = () => [overlay.modeText.text, overlay.modeText.color, overlay.focalText.text, overlay.zoomText.text];

test("the zoom line sits under the focal length, in the same right-aligned column", () => {
    expect(overlay.focalText).toMatchObject({col: 61, row: 1, align: "right"});
    expect(overlay.zoomText).toMatchObject({col: 61, row: 2, align: "right", color: WHITE, text: ""});
    expect(overlay.modeText).toMatchObject({col: 41, row: 1, align: "center", color: GRAY, text: "EON"});
    expect(overlay.gridTexts).toContain(overlay.zoomText);
});

test("without camera data: dimmed placeholder mode and a 35mm-equivalent focal length", () => {
    overlay.updateCameraTexts(0, VFOV_600);
    expect(texts()).toEqual(["EON", GRAY, "600", ""]);
});

test("with camera data: the recorded mode, the focal length as displayed, the zoom when not 1", () => {
    cameraData("Frame,Mode,FL,Zoom\n"
        + "0,IR,675,1\n"
        + "10,IR,1012,\n"
        + "20,EOW,200,2\n"
        + "30,EON,154,1.5\n"
        + "40,EOW,94.4,1\n");
    const at = (frame) => {
        overlay.updateCameraTexts(frame, VFOV_600);
        return texts();
    };
    expect(at(0)).toEqual(["IR", WHITE, "675", ""]);
    expect(at(10)).toEqual(["IR", WHITE, "1012", ""]);
    expect(at(29.9)).toEqual(["EOW", WHITE, "200", "2.0X"]);
    expect(at(30)).toEqual(["EON", WHITE, "154", "1.5X"]);
    expect(at(45)).toEqual(["EOW", WHITE, "94", ""]);
});

test("Drive Look View off, or the data removed, brings back the placeholder", () => {
    const node = cameraData("Frame,Mode,FL,Zoom\n0,EOW,200,2\n");
    overlay.updateCameraTexts(5, VFOV_600);
    expect(texts()).toEqual(["EOW", WHITE, "200", "2.0X"]);

    node.driveLookView = false;
    overlay.updateCameraTexts(5, VFOV_600);
    expect(texts()).toEqual(["EON", GRAY, "600", ""]);

    node.driveLookView = true;
    node.clear();
    overlay.updateCameraTexts(5, VFOV_600);
    expect(texts()).toEqual(["EON", GRAY, "600", ""]);
});
