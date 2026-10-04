/**
 * Camera data CSV through the real file-manager parse:
 *
 *  - A built-in sitch that reads its camera data file by row index (the
 *    wescamFOV setup entry) must get exactly the rows it always got: the file
 *    used to parse as an unrecognized CSV with its header row removed, and the
 *    new CAMERA_STATE type must not change that.
 *  - A dropped camera data file fills the cameraState node and is not
 *    uploaded with the sitch; the node saves the rows itself.
 */
jest.mock("../src/showError", () => ({...jest.requireActual("../src/showError"), showError: jest.fn()}));

import fs from "fs";
import {parseMethods} from "../src/CFileManagerParse";
import {Globals, setNodeMan, setSit} from "../src/Globals";
import {cleanCSVText, getArrayValueFromFrame} from "../src/utils";
import csv from "../src/utils/CSVParser";
import {showError} from "../src/showError";
import {CNodeCameraState} from "../src/nodes/CNodeCameraState";
import {legacyCameraDataFiles} from "./fixtures/legacyCameraDataFiles";

const arrayBufferOf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// A stand-in file manager carrying the real parse methods.
const fileManager = () => ({...parseMethods, list: {}});

// wescamFOV's per-frame focal length (SituationSetup): FL, doubled outside IR.
function legacyFocalLengths(rows, legacy) {
    const out = new Array(legacy.frames);
    for (let frame = 0; frame < legacy.frames; frame++) {
        const focalLength = getArrayValueFromFrame(rows, 0, legacy.focalIndex, frame);
        const mode = getArrayValueFromFrame(rows, 0, legacy.modeIndex, frame);
        out[frame] = mode !== "IR" ? focalLength * 2 : focalLength;
    }
    return out;
}

describe.each(legacyCameraDataFiles())("built-in load of the $name camera data", (legacy) => {
    test("parseAsset gives the rows the built-in sitch has always read", async () => {
        setSit({isCustom: false, frames: legacy.frames});
        const bytes = fs.readFileSync(legacy.csvPath);

        // What the parse did before camera state existed: clean, decode, split,
        // classify as unrecognized, remove the header row.
        const expected = csv.toArrays(new TextDecoder("utf-8").decode(cleanCSVText(arrayBufferOf(bytes)))).slice(1);

        // The legacy load calls parseAsset(filename, id, buffer) and stores .parsed.
        const result = await fileManager().parseAsset(legacy.csvPath, legacy.fileId, arrayBufferOf(bytes));
        expect(result.dataType).toBe("CAMERA_STATE");
        expect(result.parsed).toStrictEqual(expected);
        expect(legacyFocalLengths(result.parsed, legacy)).toStrictEqual(legacyFocalLengths(expected, legacy));
    });

    test("a saved modification of the sitch, reloading the file by its id, does not fill the node", async () => {
        // A canMod save lists the sitch's own files, and the reload hands each one to
        // handleParsedFile under its id, which has no extension: that is left alone,
        // so the built-in sitch is never driven by its own data file.
        expect(legacy.fileId).not.toContain(".");
        const nodes = new Map();
        setNodeMan({add: (id, node) => nodes.set(id, node), get: (id) => nodes.get(id), exists: (id) => nodes.has(id)});
        setSit({isCustom: false, canMod: true, frames: legacy.frames});
        const node = new CNodeCameraState({id: "cameraState", gui: false});
        const fm = fileManager();
        const bytes = fs.readFileSync(legacy.csvPath);
        const result = await fm.parseAsset(legacy.csvPath, legacy.fileId, arrayBufferOf(bytes));
        fm.list[legacy.fileId] = {data: result.parsed, dataType: result.dataType, filename: legacy.csvPath};
        expect(await fm.handleParsedFile(legacy.fileId, result.parsed)).toBe(false);
        expect(node.hasData()).toBe(false);
        expect(fm.list[legacy.fileId].skipSerialization).toBeUndefined();
    });
});

describe("a dropped camera data file", () => {
    let nodes;

    beforeEach(() => {
        nodes = new Map();
        setNodeMan({
            add: (id, node) => nodes.set(id, node),
            get: (id) => nodes.get(id),
            exists: (id) => nodes.has(id),
        });
        setSit({isCustom: true, frames: 1000});
        showError.mockClear();
    });

    // parseResult's steps for one dropped file: parse, register, handle.
    async function drop(fm, name, text) {
        const buffer = arrayBufferOf(new TextEncoder().encode(text));
        const parsed = await fm.parseAsset(name, name, buffer);
        fm.list[name] = {data: parsed.parsed, original: buffer, dataType: parsed.dataType, filename: name};
        return fm.handleParsedFile(name, parsed.parsed);
    }

    const CAMERA = "﻿Frame,Mode,FL,Zoom,,Polarity\n"
        + "0,IR,675,1,,B\n"
        + "10,EOW,200,2,note,\n"
        + "20,IR,1012,,,W\n";

    test("fills the cameraState node, byte-order mark and all, and is not uploaded", async () => {
        const node = new CNodeCameraState({id: "cameraState", gui: false});
        const fm = fileManager();
        expect(await drop(fm, "camera.csv", CAMERA)).toBe(true);
        expect(showError).not.toHaveBeenCalled();
        expect(fm.list["camera.csv"].skipSerialization).toBe(true);
        expect(node.sourceName).toBe("camera.csv");
        expect(node.driveLookView).toBe(true);
        expect(node.table.rows.map(r => [r.frame, r.mode, r.focalLengthMm, r.zoom, r.polarity])).toEqual([
            [0, "IR", 675, 1, "blackHot"],
            [10, "EOW", 200, 2, "blackHot"],
            [20, "IR", 1012, 1, "whiteHot"],
        ]);
        expect(node.stateAt(15)).toMatchObject({index: 1, band: "EO", zoom: 2});
    });

    test("a second file replaces the first", async () => {
        const node = new CNodeCameraState({id: "cameraState", gui: false});
        const fm = fileManager();
        await drop(fm, "first.csv", CAMERA);
        expect(await drop(fm, "second.csv", "Frame,Mode,FL\n5,EON,9\n")).toBe(true);
        expect(node.sourceName).toBe("second.csv");
        expect(node.table.rows).toHaveLength(1);
        expect(node.stateAt(0)).toMatchObject({mode: "EON", focalLengthMm: 9, zoom: 1, polarity: null});
    });

    test("a bad row is reported with its line and changes nothing", async () => {
        const node = new CNodeCameraState({id: "cameraState", gui: false});
        const fm = fileManager();
        await drop(fm, "good.csv", CAMERA);
        expect(await drop(fm, "bad.csv", "Frame,Mode,FL\n0,IR,675\n0,IR,135\n")).toBe(false);
        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toMatch(/bad\.csv.*line 3: frame 0 does not come after frame 0/);
        expect(node.sourceName).toBe("good.csv");
        expect(node.table.rows).toHaveLength(3);
        // A file that cannot be used is not uploaded either.
        expect(fm.list["bad.csv"].skipSerialization).toBe(true);
    });

    test("a file that also has angle columns feeds those too and stays in the sitch; a reload imports only the angles", async () => {
        const node = new CNodeCameraState({id: "cameraState", gui: false});
        const azEl = {setAzFile: jest.fn(), setElFile: jest.fn()};
        const heading = {inputs: {}, addOption: jest.fn()};
        const fovSwitch = {replaceOption: jest.fn(), selectOption: jest.fn()};
        nodes.set("customAzElController", azEl).set("CameraLOSController", heading).set("fovSwitch", fovSwitch);
        const COMBINED = "Frame,Az,El,Mode,FL,Zoom\n0,10,1,IR,675,1\n10,11,2,EOW,200,2\n";
        const fm = fileManager();
        expect(await drop(fm, "combined.csv", COMBINED)).toBe(true);
        expect(fm.list["combined.csv"].dataType).toBe("CAMERA_STATE");
        expect(showError).not.toHaveBeenCalled();
        // The camera rows fill the node...
        expect(node.table.rows.map(r => [r.frame, r.mode, r.focalLengthMm, r.zoom])).toEqual([[0, "IR", 675, 1], [10, "EOW", 200, 2]]);
        // ...and the angle columns go where an angle file's go, as data rows without the header.
        expect(azEl.setAzFile).toHaveBeenCalledTimes(1);
        const [azRows, azCol] = azEl.setAzFile.mock.calls[0];
        expect(azCol).toBe(1); expect(azRows.map(row => row[1])).toEqual(["10", "11"]);
        expect(azEl.setElFile).toHaveBeenCalledWith(azRows, 2);
        expect(heading.addOption).toHaveBeenCalledWith("Custom Az/El", azEl);
        // Its Zoom column is the digital zoom, never a field of view. The file stays in the sitch for its angles.
        expect(fovSwitch.replaceOption).not.toHaveBeenCalled();
        expect(fm.list["combined.csv"].skipSerialization).toBeUndefined();

        // A reload hands the file over again while the sitch deserializes: the angles are imported again, and the
        // node keeps what its own mod restores (here, no data after Remove Camera Data).
        node.clear();
        Globals.deserializing = true;
        try {
            expect(await drop(fileManager(), "combined.csv", COMBINED)).toBe(true);
        } finally {
            Globals.deserializing = false;
        }
        expect(node.hasData()).toBe(false);
        expect(azEl.setAzFile).toHaveBeenCalledTimes(2);

        // A FOV column in camera data is a field of view, and is imported as one.
        expect(await drop(fileManager(), "fov.csv", "Frame,FOV,Mode,FL\n0,0.9,IR,675\n")).toBe(true);
        expect(fovSwitch.replaceOption).toHaveBeenCalledTimes(1);
        expect(fovSwitch.selectOption).toHaveBeenCalledWith("fov_FOV");
        expect(node.table.rows).toHaveLength(1);
    });

    test("a sitch without a cameraState node says why", async () => {
        const fm = fileManager();
        expect(await drop(fm, "camera.csv", CAMERA)).toBe(false);
        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toMatch(/camera\.csv.*no look camera/);
    });
});
