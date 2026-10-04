/**
 * CameraStateTable: parsing a camera data CSV (Frame, Mode, FL, optional Zoom
 * and Polarity), the hold rule that gives the row for a frame, and the compact
 * form a sitch saves.
 */
import fs from "fs";
import csv from "../src/utils/CSVParser";
import {getArrayValueFromFrame} from "../src/utils";
import {
    cameraBand,
    cameraStateAt,
    cameraStateFromSaved,
    cameraStateModes,
    cameraStateToSaved,
    emptyCameraStateTable,
    isCameraStateCSV,
    parseCameraStateCSV,
    polarityFromText,
} from "../src/CameraStateTable";
import {legacyCameraDataFiles} from "./fixtures/legacyCameraDataFiles";

// A file as Node reads it: the byte-order mark is still on the first header
// cell. Empty-named and unknown columns carry notes; one line is blank.
const SAMPLE = "﻿Frame,Mode,FL,Zoom,,Polarity,Comment\n"
    + "0,IR,27,1,,,\n"
    + "100,IR,135,,,,first lens change\n"
    + "250,EOW,200,2.0X,,,\n"
    + "300,IR,675,1,note,B,\n"
    + "400,IR,1012,1,,W,\n"
    + ",,,,,,\n"
    + "480,IR,1012,1,,bh,\n"
    + "600,EON,9,1.5,,,\n";

const sampleTable = () => parseCameraStateCSV(csv.toArrays(SAMPLE), {sourceName: "sample.csv"});

// The row a plain linear scan finds, for checking the binary search.
function linearRowIndex(rows, frame) {
    const f = Math.floor(frame);
    let index = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].frame <= f) index = i;
    return index;
}

describe("detection and parsing", () => {
    test("reads every column, skips blank lines and ignores other columns", () => {
        const table = sampleTable();
        expect(table.version).toBe(1);
        expect(table.sourceName).toBe("sample.csv");
        expect(table.rows.map(r => [r.frame, r.mode, r.band, r.focalLengthMm, r.zoom, r.polarity])).toEqual([
            [0, "IR", "IR", 27, 1, null],
            [100, "IR", "IR", 135, 1, null],
            [250, "EOW", "EO", 200, 2, null],
            [300, "IR", "IR", 675, 1, "blackHot"],
            [400, "IR", "IR", 1012, 1, "whiteHot"],
            [480, "IR", "IR", 1012, 1, "blackHot"],
            [600, "EON", "EO", 9, 1.5, "blackHot"],
        ]);
    });

    test("the byte-order mark does not hide the Frame column", () => {
        const rows = csv.toArrays(SAMPLE);
        expect(rows[0][0]).toBe("﻿Frame");
        expect(isCameraStateCSV(rows)).toBe(true);
        expect(isCameraStateCSV(csv.toArrays(SAMPLE.slice(1)))).toBe(true);
    });

    test("header names ignore case and spaces; Frame, Mode and FL are all required", () => {
        expect(isCameraStateCSV([[" frame ", "MODE", "fl"]])).toBe(true);
        expect(isCameraStateCSV([["Mode", "FL", "Frame"]])).toBe(true);
        expect(isCameraStateCSV([["Frame", "Zoom"]])).toBe(false);
        expect(isCameraStateCSV([["Frame", "Mode", "Zoom"]])).toBe(false);
        expect(isCameraStateCSV([])).toBe(false);
        expect(isCameraStateCSV(null)).toBe(false);
        expect(isCameraStateCSV(["Frame,Mode,FL"])).toBe(false);
    });

    test("band: IR, MWIR and LWIR modes are infrared, anything else is EO", () => {
        for (const mode of ["IR", "ir", "MWIR", "LWIR", " IR "]) expect(cameraBand(mode)).toBe("IR");
        for (const mode of ["EOW", "EON", "SWIR", "NIR", "", null]) expect(cameraBand(mode)).toBe("EO");
    });

    test("polarity names", () => {
        for (const text of ["B", "b", "BH", "black", "Black Hot", "blackHot", "black-hot"]) {
            expect(polarityFromText(text)).toBe("blackHot");
        }
        for (const text of ["W", "WH", "white", "whiteHot", "WHITE_HOT"]) {
            expect(polarityFromText(text)).toBe("whiteHot");
        }
        expect(polarityFromText("gray")).toBeNull();
        expect(polarityFromText("")).toBeNull();
    });

    test("modes are listed once each, in order of first use", () => {
        expect(cameraStateModes(sampleTable())).toEqual([
            {mode: "IR", band: "IR"}, {mode: "EOW", band: "EO"}, {mode: "EON", band: "EO"},
        ]);
        expect(cameraStateModes(emptyCameraStateTable())).toEqual([]);
    });
});

describe("errors name the line and the problem", () => {
    const parse = (lines) => () => parseCameraStateCSV(csv.toArrays(["Frame,Mode,FL,Zoom,Polarity", ...lines].join("\n")));

    test.each([
        [["0,IR,675,1,", "12.5,IR,675,1,"], /line 3: the frame "12\.5" is not a whole number/],
        [["-1,IR,675,1,"], /line 2: the frame "-1"/],
        [[",IR,675,1,"], /line 2: the frame "" is not a whole number/],
        [["10,IR,675,1,", "10,IR,135,1,"], /line 3: frame 10 does not come after frame 10/],
        [["10,IR,675,1,", "5,IR,135,1,"], /line 3: frame 5 does not come after frame 10/],
        [["0,,675,1,"], /line 2: the mode is blank/],
        [["0,IR,0,1,"], /line 2: the focal length "0" is not a number above 0/],
        [["0,IR,abc,1,"], /line 2: the focal length "abc"/],
        [["0,IR,,1,"], /line 2: the focal length ""/],
        [["0,IR,675,0.5,"], /line 2: the zoom "0.5" is not a number of 1 or more/],
        [["0,IR,675,big,"], /line 2: the zoom "big"/],
        [["0,IR,675,1,gray"], /line 2: the polarity "gray" is not one of/],
    ])("%j", (lines, message) => {
        expect(parse(lines)).toThrow(message);
    });

    test("header problems", () => {
        expect(() => parseCameraStateCSV([["Frame", "Mode"], ["0", "IR"]])).toThrow(/Frame, Mode and FL/);
        expect(() => parseCameraStateCSV([["Frame", "Mode", "FL", "fl"], ["0", "IR", "1", "2"]]))
            .toThrow(/names the "fl" column twice/);
        expect(() => parseCameraStateCSV([["Frame", "Mode", "FL"], ["", "", ""]])).toThrow(/no data rows/);
    });
});

describe("hold rule", () => {
    const table = sampleTable();

    test("each row holds until the next row's frame; the last row holds to the end", () => {
        expect(cameraStateAt(table, 0)).toMatchObject({index: 0, focalLengthMm: 27});
        expect(cameraStateAt(table, 99)).toMatchObject({index: 0, focalLengthMm: 27});
        expect(cameraStateAt(table, 100)).toMatchObject({index: 1, focalLengthMm: 135});
        expect(cameraStateAt(table, 399)).toMatchObject({index: 3, polarity: "blackHot"});
        expect(cameraStateAt(table, 400)).toMatchObject({index: 4, polarity: "whiteHot"});
        expect(cameraStateAt(table, 479)).toMatchObject({index: 4, polarity: "whiteHot"});
        expect(cameraStateAt(table, 480)).toMatchObject({index: 5, polarity: "blackHot"});
        expect(cameraStateAt(table, 600)).toMatchObject({index: 6, mode: "EON"});
        expect(cameraStateAt(table, 1e9)).toMatchObject({index: 6, mode: "EON"});
    });

    test("frames before the first row use the first row", () => {
        const late = parseCameraStateCSV([["Frame", "Mode", "FL"], ["50", "IR", "675"], ["90", "EOW", "200"]]);
        expect(cameraStateAt(late, 0)).toMatchObject({index: 0, frame: 50, mode: "IR"});
        expect(cameraStateAt(late, -10)).toMatchObject({index: 0});
    });

    test("fractional playback frames round down", () => {
        expect(cameraStateAt(table, 99.999)).toMatchObject({index: 0});
        expect(cameraStateAt(table, 100.0)).toMatchObject({index: 1});
        expect(cameraStateAt(table, 100.5)).toMatchObject({index: 1});
        expect(cameraStateAt(table, 249.9)).toMatchObject({index: 1});
    });

    test("no row for an empty table or a frame that is not a number", () => {
        expect(cameraStateAt(emptyCameraStateTable(), 0)).toBeNull();
        expect(cameraStateAt(null, 0)).toBeNull();
        expect(cameraStateAt(table, NaN)).toBeNull();
        expect(cameraStateAt(table, undefined)).toBeNull();
    });

    test("the binary search finds the same row as a linear scan", () => {
        let seed = 12345;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let trial = 0; trial < 50; trial++) {
            const rows = [];
            let frame = Math.floor(random() * 20);
            const count = 1 + Math.floor(random() * 40);
            for (let i = 0; i < count; i++) {
                rows.push({frame, mode: "IR", band: "IR", focalLengthMm: 675, zoom: 1, polarity: null});
                frame += 1 + Math.floor(random() * 30);
            }
            for (let f = 0; f < frame + 20; f += 0.5) {
                expect(cameraStateAt({rows}, f).index).toBe(linearRowIndex(rows, f));
            }
        }
    });
});

describe("saved form", () => {
    test("round trip through JSON gives the same table", () => {
        const table = sampleTable();
        const saved = JSON.parse(JSON.stringify(cameraStateToSaved(table)));
        expect(saved.rows[3]).toEqual([300, "IR", 675, 1, "blackHot"]);
        expect(cameraStateFromSaved(saved)).toEqual(table);
    });

    test("a damaged or newer save is refused, not half used", () => {
        const saved = cameraStateToSaved(sampleTable());
        expect(() => cameraStateFromSaved({...saved, version: 2})).toThrow(/version 2/);
        expect(() => cameraStateFromSaved(undefined)).toThrow();
        const bad = JSON.parse(JSON.stringify(saved));
        bad.rows[2][2] = -5;
        expect(() => cameraStateFromSaved(bad)).toThrow(/line 4: the focal length "-5"/);
    });
});

// The built-in sitches that read a camera data CSV by row index keep their own
// file and lookup (SituationSetup wescamFOV). The same file, with its unnamed
// polarity column named in memory, must give the same mode and focal length on
// every frame through the hold rule.
const legacyFiles = legacyCameraDataFiles();

describe.each(legacyFiles)("built-in camera data: $name", (legacy) => {
    // Read as Node does, so the byte-order mark is still present.
    const rows = csv.toArrays(fs.readFileSync(legacy.csvPath, "utf8"));
    const legacyRows = rows.slice(1);   // the rows the built-in load keeps

    // The unnamed column whose cells, where not blank, are all polarity names.
    const polarityColumn = rows[0].findIndex((name, column) => name.trim() === ""
        && legacyRows.some(r => (r[column] ?? "").trim() !== "")
        && legacyRows.every(r => (r[column] ?? "").trim() === "" || polarityFromText(r[column]) !== null));
    const named = rows.map((r, i) => i === 0 && polarityColumn >= 0
        ? r.map((name, column) => column === polarityColumn ? "Polarity" : name) : r);
    const table = parseCameraStateCSV(named, {sourceName: "legacy"});

    test("one table row per file row", () => {
        expect(table.rows.length).toBe(legacyRows.length);
    });

    test("mode and focal length equal the built-in lookup on every frame", () => {
        let compared = 0;
        for (let frame = 0; frame < legacy.frames; frame++) {
            const legacyMode = getArrayValueFromFrame(legacyRows, 0, legacy.modeIndex, frame);
            if (legacyMode === null) continue;   // before the first row the built-in lookup has none
            const state = cameraStateAt(table, frame);
            if (state.mode !== legacyMode
                || state.focalLengthMm !== Number(getArrayValueFromFrame(legacyRows, 0, legacy.focalIndex, frame))) {
                throw new Error(`frame ${frame}: ${state.mode} ${state.focalLengthMm} mm`);
            }
            compared++;
        }
        expect(compared).toBeGreaterThan(0);
    });

    test("polarity holds from each marked row until the next mark", () => {
        if (polarityColumn < 0) return;
        // Independent of the hold code: walk the file rows, carrying the last mark.
        let expected = null;
        let next = 0;
        for (let frame = Number(legacyRows[0][0]); frame < legacy.frames; frame++) {
            while (next < legacyRows.length && Number(legacyRows[next][0]) <= frame) {
                const mark = (legacyRows[next][polarityColumn] ?? "").trim();
                if (mark !== "") expected = polarityFromText(mark);
                next++;
            }
            const state = cameraStateAt(table, frame);
            if (state.polarity !== expected) throw new Error(`frame ${frame}: ${state.polarity}, not ${expected}`);
        }
    });
});

test("the built-in camera data checks above found at least one sitch", () => {
    // Guards the check against a silent pass while such a sitch exists.
    expect(legacyFiles.length).toBeGreaterThan(0);
});
