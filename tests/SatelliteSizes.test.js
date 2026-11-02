// The GCAT size table: the rules that build it (scripts/buildSatelliteSizes.js),
// the file that ships (data/nightsky/gcat-sizes.csv.gz), and the loader that
// copies it onto the satellites (src/SatelliteSizes.js).

import {applySatelliteSizes, parseSatelliteSizes} from "../src/SatelliteSizes";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {meanProjectedArea, starlinkDesign} = require("../scripts/buildSatelliteSizes.js");

describe("mean projected area from GCAT sizes", () => {
    it("is a quarter of a cylinder's surface", () => {
        // A Zenit-2 second stage: 11.1 m long, 3.9 m across.
        const expected = (Math.PI * 3.9 * 3.9 / 2 + Math.PI * 3.9 * 11.1) / 4;
        expect(meanProjectedArea(11.1, 3.9, 11.1, "Cyl")).toBeCloseTo(expected, 10);
    });

    it("is the cross-section of a sphere", () => {
        expect(meanProjectedArea(2, 2, 2, "Sphere")).toBeCloseTo(Math.PI, 10);
    });

    it("treats a box as a square cross-section along its length", () => {
        expect(meanProjectedArea(3, 1, 3, "Box")).toBeCloseTo((2 + 12) / 4, 10);
    });

    it("adds solar panels, both faces, only when the shape lists them", () => {
        const body = meanProjectedArea(0.3, 4.1, 29, "Box");
        expect(meanProjectedArea(0.3, 4.1, 29, "Box + pan") - body).toBeCloseTo((29 - 4.1) * 4.1 / 2, 10);
        expect(meanProjectedArea(0.3, 4.1, 29, "Box + Ant")).toBe(body);
    });
});

describe("Starlink design from GCAT", () => {
    const row = (bus, plName, name = "Starlink 1000") => ({Bus: bus, PLName: plName, Name: name});

    it("reads the V2 Mini family from the bus", () => {
        expect(starlinkDesign(row("Starlink V2M", "Starlink Group 6-1-01"))).toBe("v2m");
        expect(starlinkDesign(row("Starlink V2MO", "Starlink Group 12-1-13"))).toBe("v2mo");
        expect(starlinkDesign(row("Starlink V2MD", "Starlink Group 7-9-01"))).toBe("v2md");
    });

    it("splits the older bus by payload name, VisorSats from launch L9", () => {
        expect(starlinkDesign(row("Starlink", "Starlink V0.9-01"))).toBe("v0.9");
        expect(starlinkDesign(row("Starlink", "Starlink V1.0-L8-01"))).toBe("v1.0");
        expect(starlinkDesign(row("Starlink", "Starlink V1.0-L9-03"))).toBe("visor");
        expect(starlinkDesign(row("Starlink", "Starlink V1.0-L28-01"))).toBe("visor");
        expect(starlinkDesign(row("Starlink", "Starlink Group 2-1-01"))).toBe("v1.5");
    });

    it("marks Starlink-1436, the VisorSat flown on L7", () => {
        expect(starlinkDesign(row("Starlink", "Starlink V1.0-L7-05", "Starlink 1436"))).toBe("visor");
        expect(starlinkDesign(row("Starlink", "Starlink V1.0-L7-06", "Starlink 1437"))).toBe("v1.0");
    });

    it("leaves test flights and other buses without a design", () => {
        expect(starlinkDesign(row("Starlink", "Starlink TSP2-01"))).toBe("");
        expect(starlinkDesign(row("Kuiper", "Kuiper-00008"))).toBe("");
    });
});

describe("the size table", () => {
    const text = [
        "# comment",
        "# norad step,area m2,length m,diameter m,span m,design",
        "20625,40,11.1,3.9,11.1",
        "1,0.031,0.2,0.1,0.2",
        "35000,61,0.3,4.1,29,v2m",
        "3,,,,,v1.5",
        "",
    ].join("\n");

    it("reads the steps back into catalog numbers", () => {
        const table = parseSatelliteSizes(text);
        expect([...table.keys()]).toEqual([20625, 20626, 55626, 55629]);
        expect(table.get(20625)).toEqual({areaM2: 40, sizeM: {length: 11.1, diameter: 3.9, span: 11.1}});
        expect(table.get(55626).starlinkDesign).toBe("v2m");
        expect(table.get(55629)).toEqual({starlinkDesign: "v1.5"});
    });

    it("copies sizes and designs onto the satellites it lists", () => {
        const table = parseSatelliteSizes(text);
        const sats = [{number: 20625}, {number: 55629}, {number: 99999}];
        expect(applySatelliteSizes(sats, table)).toBe(2);
        expect(sats[0].areaM2).toBe(40);
        expect(sats[0].sizeM.diameter).toBe(3.9);
        expect(sats[1].starlinkDesign).toBe("v1.5");
        expect(sats[1].areaM2).toBeUndefined();
        expect(sats[2]).toEqual({number: 99999});
    });

    it("ships as a table that holds known objects", () => {
        const file = path.resolve(__dirname, "../data/nightsky/gcat-sizes.csv.gz");
        const table = parseSatelliteSizes(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
        expect(table.size).toBeGreaterThan(30000);
        expect(table.get(20625).areaM2).toBe(40);                // Zenit-2 stage, SL-16 R/B
        expect(table.get(44713).starlinkDesign).toBe("v1.0");    // Starlink-1007, L1
        expect(table.get(55695).starlinkDesign).toBe("v2m");     // Starlink-30050, group 6-1
        expect(table.get(58705).starlinkDesign).toBe("v2md");    // Starlink-11072, Direct to Cell
        // GCAT sizes only Zarya, the first module, for the ISS's catalog number.
        expect(table.get(25544)).toBeUndefined();
    });
});
