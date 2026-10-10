import {
    isPhotoBackdropJSON, normalizePhotoBackdrop, photoBackdropGridSize, photoBackdropNodeId, PHOTO_BACKDROP_DEFAULT_RANGE,
} from "../src/photoBackdrop/PhotoBackdropFormat";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const valid = () => ({
    type: "SitrecPhotoBackdrop", version: 1, name: "Ridge",
    image: PNG, terrainMask: PNG, coverageMask: PNG,
    origin: {lat: 33.5, lon: -106.1, altMSL: 1429.5},
    azMin: 75.7, azMax: 87.7, elMin: 1.95, elMax: 4.65,
    range: 12000, fillColor: "#8c8c8c",
});

describe("PhotoBackdropFormat", () => {
    test("detects the type", () => {
        expect(isPhotoBackdropJSON(valid())).toBe(true);
        expect(isPhotoBackdropJSON({type: "SitrecCloudField"})).toBe(false);
        expect(isPhotoBackdropJSON(null)).toBe(false);
    });

    test("normalizes a valid file and fills the defaults", () => {
        expect(normalizePhotoBackdrop(valid())).toEqual({
            name: "Ridge", image: PNG, terrainMask: PNG, coverageMask: PNG,
            origin: {lat: 33.5, lon: -106.1, altMSL: 1429.5},
            azMin: 75.7, azMax: 87.7, elMin: 1.95, elMax: 4.65, range: 12000, fillColor: "#8c8c8c",
        });
        const bare = valid();
        delete bare.name; delete bare.terrainMask; delete bare.coverageMask; delete bare.range; delete bare.fillColor;
        expect(normalizePhotoBackdrop(bare)).toMatchObject({
            name: "Photo Backdrop", terrainMask: null, coverageMask: null, range: PHOTO_BACKDROP_DEFAULT_RANGE, fillColor: null,
        });
    });

    test.each([
        ["version", {version: 2}, /version 2/],
        ["image", {image: "http://example.com/a.png"}, /image/],
        ["terrainMask", {terrainMask: 5}, /terrainMask/],
        ["coverageMask", {coverageMask: "x"}, /coverageMask/],
        ["origin", {origin: {lat: 33.5, lon: -106.1}}, /altMSL/],
        ["latitude", {origin: {lat: 91, lon: 0, altMSL: 0}}, /lat/],
        ["azimuth order", {azMax: 70}, /azMax/],
        ["elevation order", {elMax: 1}, /elMin/],
        ["range", {range: 0}, /range/],
        ["fill color", {fillColor: "grey"}, /fillColor/],
    ])("rejects a bad %s", (what, change, message) => {
        expect(() => normalizePhotoBackdrop({...valid(), ...change})).toThrow(message);
    });

    test("the grid is 0.1 degree cells for a small picture, and capped for a panorama", () => {
        // the Tracks.md example, 75.6-87.8 by 1.9-4.7 degrees: the plain 0.1 degree grid
        expect(photoBackdropGridSize(87.8 - 75.6, 4.7 - 1.9))
            .toEqual({nx: Math.ceil((87.8 - 75.6) / 0.1), ny: Math.ceil((4.7 - 1.9) / 0.1)});
        // at least 8 x 4
        expect(photoBackdropGridSize(0.2, 0.1)).toEqual({nx: 8, ny: 4});
        // a 360 x 90 degree panorama: square cells, about 512 x 512 in all
        const {nx, ny} = photoBackdropGridSize(360, 90);
        expect(nx / ny).toBeCloseTo(4, 1);
        expect(nx * ny).toBeLessThanOrEqual(512 * 512 * 1.01);
        expect(nx * ny).toBeGreaterThan(512 * 512 * 0.99);
    });

    test("node ids are stable and distinct", () => {
        expect(photoBackdropNodeId("ridge.backdrop.json")).toBe(photoBackdropNodeId("ridge.backdrop.json"));
        expect(photoBackdropNodeId("a.b")).not.toBe(photoBackdropNodeId("a_b"));
        expect(photoBackdropNodeId("a b.json")).toMatch(/^PhotoBackdrop_[A-Za-z0-9_-]+$/);
    });
});
