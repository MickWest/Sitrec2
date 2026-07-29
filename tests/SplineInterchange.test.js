/**
 * Sitrec spline interchange format — src/SplineInterchange.js
 *
 * Covers the pure format layer: what counts as a spline file, what a malformed
 * one is rejected for, and that control points survive the LLA <-> ECEF round
 * trip that moving a spline between sitches depends on.
 *
 * importSplineJSON itself is not covered here: it drives TrackManager/NodeMan
 * and needs a live node graph.
 */

import {
    isSplineJSON,
    makeSplineJSON,
    makeUniqueName,
    safeTrackName,
    splineJSONToECEFPoints,
    validateSplineJSON,
    SPLINE_CURVE_TYPES,
    SPLINE_FILE_TYPE,
    SPLINE_FILE_VERSION,
} from "../src/SplineInterchange";
import {LLAVToECEF} from "../src/LLA-ECEF-ENU";
import {Vector3} from "three";

// Three of the Aguadilla UAP spline's control points — a real case, and the
// reason the format is geodetic: these are metres-scale altitudes at a
// specific place on the ellipsoid.
const AGUA_POINTS = [
    [0, 18.503705640095387, -67.1504289887557, 29.22562827449292],
    [121, 18.500549008435044, -67.14880906435559, 57.510756713338196],
    [7027, 18.509550237640788, -67.14068135684772, 67.96719601005316],
];

function makeFile(overrides = {}) {
    return {
        fileType: SPLINE_FILE_TYPE,
        version: SPLINE_FILE_VERSION,
        name: "Test Spline",
        curveType: "chordal",
        altitudeDatum: "HAE",
        columns: ["frame", "lat", "lon", "alt"],
        points: AGUA_POINTS.map(p => [...p]),
        ...overrides,
    };
}

describe("isSplineJSON", () => {
    test("accepts a spline file", () => {
        expect(isSplineJSON(makeFile())).toBe(true);
    });

    test("rejects non-objects and nulls", () => {
        expect(isSplineJSON(null)).toBe(false);
        expect(isSplineJSON(undefined)).toBe(false);
        expect(isSplineJSON("sitrec-spline")).toBe(false);
    });

    // The sniff runs in the .json parse path ahead of the generic track
    // detectors, so it must not claim files that belong to them.
    test("rejects other JSON track formats", () => {
        const geoJSON = {
            type: "FeatureCollection",
            features: [{geometry: {type: "Point"}, properties: {dtg: "..."}}],
        };
        expect(isSplineJSON(geoJSON)).toBe(false);
        expect(isSplineJSON({kind: "klv-pes-pts", entries: []})).toBe(false);
        expect(isSplineJSON({isASitchFile: true})).toBe(false);
    });

    // The sniff is on fileType alone: a malformed spline file must still be
    // CLAIMED here so the validator can report why, rather than falling through
    // to the generic JSON track handlers and vanishing without a message.
    test("claims a spline file even when it is malformed", () => {
        expect(isSplineJSON({fileType: SPLINE_FILE_TYPE})).toBe(true);
        expect(validateSplineJSON({fileType: SPLINE_FILE_TYPE})).toMatch(/no points array/);
    });
});

describe("validateSplineJSON", () => {
    test("passes a well-formed file", () => {
        expect(validateSplineJSON(makeFile())).toBeNull();
    });

    test("rejects an empty point list", () => {
        expect(validateSplineJSON(makeFile({points: []}))).toMatch(/no control points/);
    });

    test("rejects a future or non-numeric format version", () => {
        expect(validateSplineJSON(makeFile({version: SPLINE_FILE_VERSION + 1})))
            .toMatch(/not one this build understands/);
        expect(validateSplineJSON(makeFile({version: "1"})))
            .toMatch(/not one this build understands/);
    });

    test("accepts the current version and older", () => {
        expect(validateSplineJSON(makeFile({version: SPLINE_FILE_VERSION}))).toBeNull();
    });

    // Without this, a bad value reaches LLAVToECEF and puts NaN control points
    // into the node graph, which only shows up later as an invisible track.
    test.each([
        ["a short row", [[0, 18.5, -67.1]]],
        ["a non-array row", [{frame: 0, lat: 18.5}]],
        ["a string coordinate", [[0, "18.5", -67.1, 100]]],
        ["a null coordinate", [[0, 18.5, null, 100]]],
        ["NaN", [[0, NaN, -67.1, 100]]],
        ["Infinity", [[0, 18.5, -67.1, Infinity]]],
    ])("rejects %s", (_label, points) => {
        expect(validateSplineJSON(makeFile({points}))).not.toBeNull();
    });

    test("rejects out-of-range latitude and longitude", () => {
        expect(validateSplineJSON(makeFile({points: [[0, 118.5, -67.1, 100]]})))
            .toMatch(/out-of-range/);
        expect(validateSplineJSON(makeFile({points: [[0, 18.5, -267.1, 100]]})))
            .toMatch(/out-of-range/);
    });

    // PointEditor.getPointFrame walks the frame list in order and divides by
    // (frames[s+1] - frames[s]). Equal frames divide by zero; out-of-order ones
    // select the wrong segment. Either way every frame of the track goes NaN.
    describe("frame ordering", () => {
        test("rejects duplicate adjacent frames", () => {
            const points = [[0, 18.5, -67.1, 100], [300, 18.5, -67.1, 110], [300, 18.5, -67.1, 120]];
            expect(validateSplineJSON(makeFile({points}))).toMatch(/must strictly increase/);
        });

        test("rejects decreasing frames", () => {
            const points = [[0, 18.5, -67.1, 100], [600, 18.5, -67.1, 110], [300, 18.5, -67.1, 120]];
            expect(validateSplineJSON(makeFile({points}))).toMatch(/must strictly increase/);
        });

        test("accepts strictly increasing frames, including a single point", () => {
            expect(validateSplineJSON(makeFile({points: [[0, 18.5, -67.1, 100]]}))).toBeNull();
            expect(validateSplineJSON(makeFile({
                points: [[0, 18.5, -67.1, 100], [1, 18.5, -67.1, 110]],
            }))).toBeNull();
        });
    });

    describe("consumed scalar fields", () => {
        test("rejects an unknown curve type", () => {
            expect(validateSplineJSON(makeFile({curveType: "banana"}))).toMatch(/curveType/);
            expect(validateSplineJSON(makeFile({curveType: 3}))).toMatch(/curveType/);
        });

        test("accepts every curve type the GUI offers", () => {
            for (const curveType of SPLINE_CURVE_TYPES) {
                expect(validateSplineJSON(makeFile({curveType}))).toBeNull();
            }
        });

        test("rejects a non-string name", () => {
            expect(validateSplineJSON(makeFile({name: 5}))).toMatch(/name must be a string/);
            expect(validateSplineJSON(makeFile({name: {}}))).toMatch(/name must be a string/);
        });

        test.each(["constantSpeed", "extrapolateTrack", "altitudeLockAGL"])(
            "rejects a non-boolean %s", (key) => {
                expect(validateSplineJSON(makeFile({[key]: "true"}))).toMatch(/true or false/);
            });

        test("rejects a non-numeric altitudeLock", () => {
            expect(validateSplineJSON(makeFile({altitudeLock: "250"}))).toMatch(/altitudeLock/);
            expect(validateSplineJSON(makeFile({altitudeLock: NaN}))).toMatch(/altitudeLock/);
        });

        test("rejects a non-numeric altitudeOffset", () => {
            expect(validateSplineJSON(makeFile({altitudeOffset: "30"}))).toMatch(/altitudeOffset/);
            expect(validateSplineJSON(makeFile({altitudeOffset: NaN}))).toMatch(/altitudeOffset/);
        });

        test("allows the optional fields to be absent", () => {
            const bare = {fileType: SPLINE_FILE_TYPE, points: [[0, 18.5, -67.1, 100]]};
            expect(validateSplineJSON(bare)).toBeNull();
        });
    });
});

describe("makeUniqueName", () => {
    test("keeps the name when it is free", () => {
        expect(makeUniqueName("UAP Spline", new Set())).toBe("UAP Spline");
    });

    test("suffixes on collision and keeps counting", () => {
        expect(makeUniqueName("Lantern", new Set(["Lantern"]))).toBe("Lantern 2");
        expect(makeUniqueName("Lantern", new Set(["Lantern", "Lantern 2"]))).toBe("Lantern 3");
        expect(makeUniqueName("Lantern", new Set(["Lantern", "Lantern 2", "Lantern 3"])))
            .toBe("Lantern 4");
    });

    // The taken set includes the drop-target switches' built-in options, because
    // addSyntheticTrack does removeOption(name)/addOption(name) on each — a spline
    // named "fixedCamera" would otherwise delete that option and take its place.
    test("avoids built-in switch option names", () => {
        const builtIns = new Set(["fixedCamera", "flightSimCamera", "orbitCamera", "fixedTarget", "-"]);
        expect(makeUniqueName("fixedCamera", builtIns)).toBe("fixedCamera 2");
        expect(makeUniqueName("-", builtIns)).toBe("- 2");
        expect(makeUniqueName("Lantern", builtIns)).toBe("Lantern");
    });
});

describe("safeTrackName", () => {
    // Switch options are plain-object keys. CNodeSwitch.removeOption guards with
    // `inputs[option] !== undefined`, which an INHERITED property satisfies — so a
    // track named "constructor" would try to remove an input that was never added.
    test.each(["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"])(
        "renames the Object.prototype key %s", (name) => {
            expect(safeTrackName(name)).toBe("#" + name);
        });

    test("leaves ordinary names alone", () => {
        expect(safeTrackName("UAP Spline")).toBe("UAP Spline");
        expect(safeTrackName("fixedCamera")).toBe("fixedCamera");
        expect(safeTrackName("-")).toBe("-");
        expect(safeTrackName("proto")).toBe("proto");
    });

    // The renamed form must then be a normal, collidable key.
    test("the renamed form is not itself a prototype key", () => {
        const renamed = safeTrackName("constructor");
        expect(({})[renamed]).toBeUndefined();
        expect(Object.keys({[renamed]: 1})).toEqual([renamed]);
    });
});

describe("makeSplineJSON", () => {
    const positions = AGUA_POINTS.map(p => LLAVToECEF(new Vector3(p[1], p[2], p[3])));
    const frameNumbers = AGUA_POINTS.map(p => p[0]);

    test("produces a file its own sniff and validator accept", () => {
        const json = makeSplineJSON({name: "Round Trip", positions, frameNumbers, frames: 7028});
        expect(isSplineJSON(json)).toBe(true);
        expect(validateSplineJSON(json)).toBeNull();
        expect(json.fileType).toBe(SPLINE_FILE_TYPE);
        expect(json.version).toBe(SPLINE_FILE_VERSION);
        expect(json.name).toBe("Round Trip");
        expect(json.altitudeDatum).toBe("HAE");
        expect(json.points).toHaveLength(3);
    });

    test("carries the spline's editing settings", () => {
        const json = makeSplineJSON({
            name: "Settings", positions, frameNumbers, frames: 900,
            curveType: "linear", constantSpeed: true, extrapolateTrack: false,
            altitudeLock: 250, altitudeLockAGL: false, altitudeOffset: 30.48,
        });
        expect(json.curveType).toBe("linear");
        expect(json.constantSpeed).toBe(true);
        expect(json.extrapolateTrack).toBe(false);
        expect(json.altitudeLock).toBe(250);
        expect(json.altitudeLockAGL).toBe(false);
        // Carried so an Alt-offset-adjusted spline transfers at the altitude it was
        // set to, not the one its raw control points describe.
        expect(json.altitudeOffset).toBe(30.48);
        expect(json.frames).toBe(900);
    });

    test("defaults the settings when they are not supplied", () => {
        const json = makeSplineJSON({name: "Defaults", positions, frameNumbers, frames: 10});
        expect(json.curveType).toBe("chordal");
        expect(json.constantSpeed).toBe(false);
        expect(json.extrapolateTrack).toBe(true);
        expect(json.altitudeLock).toBe(-1);
        expect(json.altitudeOffset).toBe(0);
    });

    // Colour is optional so a sitch-built spline (whose colour lives on a
    // separate display track) imports with an auto palette colour instead.
    test("omits colour when there is none", () => {
        const json = makeSplineJSON({name: "NoColor", positions, frameNumbers, frames: 10});
        expect(json.color).toBeUndefined();
        expect("color" in json).toBe(false);
    });

    test("includes colour when given", () => {
        const json = makeSplineJSON({
            name: "Colored", positions, frameNumbers, frames: 10, color: "#ff8080",
        });
        expect(json.color).toBe("#ff8080");
    });

    test("keeps frame numbers with their points", () => {
        const json = makeSplineJSON({name: "Frames", positions, frameNumbers, frames: 7028});
        expect(json.points.map(p => p[0])).toEqual([0, 121, 7027]);
    });
});

describe("round trip", () => {
    // The point of the format: a spline written out in one sitch and read back
    // in another must land on the same ECEF positions, since the analysis
    // (LOS geometry, altitudes) is done on those.
    test("ECEF -> file -> ECEF is exact to float64 noise", () => {
        const original = AGUA_POINTS.map(p => LLAVToECEF(new Vector3(p[1], p[2], p[3])));
        const json = makeSplineJSON({
            name: "Exactness",
            positions: original,
            frameNumbers: AGUA_POINTS.map(p => p[0]),
            frames: 7028,
        });
        const back = splineJSONToECEFPoints(json);

        expect(back).toHaveLength(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(back[i][0]).toBe(AGUA_POINTS[i][0]);
            // sub-micrometre: well under any measurement this data supports
            expect(back[i][1]).toBeCloseTo(original[i].x, 6);
            expect(back[i][2]).toBeCloseTo(original[i].y, 6);
            expect(back[i][3]).toBeCloseTo(original[i].z, 6);
        }
    });

    test("splineJSONToECEFPoints emits [frame, x, y, z] rows", () => {
        const rows = splineJSONToECEFPoints(makeFile());
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row).toHaveLength(4);
            for (const value of row) {
                expect(Number.isFinite(value)).toBe(true);
            }
        }
        // Aguadilla is roughly one Earth radius from the geocentre
        const r = Math.hypot(rows[0][1], rows[0][2], rows[0][3]);
        expect(r).toBeGreaterThan(6_300_000);
        expect(r).toBeLessThan(6_400_000);
    });
});
