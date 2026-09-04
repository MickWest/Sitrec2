// Where the vector water polygons are fetched from.
//
// Worth its own tests because the failure mode is silent in both directions: a
// wrong template 404s, a 404 correctly means "no water polygons here", and the
// water simply stops appearing with nothing logged. And because the whole point
// of the override is deployments that cannot reach the internet to find out.

import {
    fillTileTemplate,
    vectorWaterMaxZoom,
    vectorWaterSource,
    vectorWaterTileUrl,
    waterMaskAvailable,
    waterMaskSourceForTile,
} from "../src/WaterMaskTiles";

// getEnv reads window.__SITREC_ENV__ first, which is how a Docker deployment
// sets these — so that is the layer to drive the tests from.
function setEnv(values) {
    global.window = global.window ?? {};
    window.__SITREC_ENV__ = values;
}

beforeEach(() => setEnv({}));
afterEach(() => { delete window.__SITREC_ENV__; });

describe("no source configured", () => {

    test("an unset key is not a source", () => {
        setEnv({MAPTILER_KEY: ""});
        expect(vectorWaterSource()).toBeNull();
        expect(waterMaskAvailable()).toBe(false);
    });

    test("the placeholder key in shared.env.example is not a source", () => {
        // Every install starts from the .example file, so EXAMPLEKEY is the
        // value most likely to be sitting there — offering the switch would
        // wire the UI to a guaranteed 403.
        setEnv({MAPTILER_KEY: "EXAMPLEKEY"});
        expect(vectorWaterSource()).toBeNull();
        expect(waterMaskAvailable()).toBe(false);
    });

    test("callers get null rather than a malformed URL", () => {
        setEnv({MAPTILER_KEY: ""});
        expect(vectorWaterTileUrl(12, 699, 1636)).toBeNull();
        expect(waterMaskSourceForTile(12, 699, 1636)).toBeNull();
    });
});

describe("the MapTiler default", () => {

    beforeEach(() => setEnv({MAPTILER_KEY: "TESTKEY"}));

    test("builds the OpenMapTiles v3 endpoint", () => {
        expect(vectorWaterTileUrl(12, 699, 1636))
            .toBe("https://api.maptiler.com/tiles/v3/12/699/1636.pbf?key=TESTKEY");
    });

    test("serves to zoom 14", () => {
        expect(vectorWaterMaxZoom()).toBe(14);
    });
});

describe("SITREC_VECTOR_WATER_URL", () => {

    test("replaces MapTiler entirely", () => {
        setEnv({
            MAPTILER_KEY: "TESTKEY",
            SITREC_VECTOR_WATER_URL: "https://tiles.example.org/water/{z}/{x}/{y}.pbf",
        });
        const url = vectorWaterTileUrl(12, 699, 1636);
        expect(url).toBe("https://tiles.example.org/water/12/699/1636.pbf");
        // The whole point: an isolated deployment must not need a MapTiler
        // account, so the key must not appear even when one happens to be set.
        expect(url).not.toContain("maptiler");
        expect(url).not.toContain("TESTKEY");
    });

    test("works with no MapTiler key at all", () => {
        setEnv({SITREC_VECTOR_WATER_URL: "https://tiles.example.org/{z}/{x}/{y}.pbf"});
        expect(waterMaskAvailable()).toBe(true);
        expect(vectorWaterTileUrl(3, 1, 2)).toBe("https://tiles.example.org/3/1/2.pbf");
    });

    test("a template may carry its own query string and credential", () => {
        setEnv({SITREC_VECTOR_WATER_URL: "https://tiles.example.org/{z}/{x}/{y}.pbf?token=abc"});
        expect(vectorWaterTileUrl(9, 4, 5))
            .toBe("https://tiles.example.org/9/4/5.pbf?token=abc");
    });

    test("a placeholder repeated in the template is filled everywhere", () => {
        setEnv({SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{z}/{x}/{y}.pbf"});
        expect(vectorWaterTileUrl(7, 1, 2)).toBe("https://ex.org/7/7/1/2.pbf");
    });
});

describe("SITREC_VECTOR_WATER_MAX_ZOOM", () => {

    test("defaults to 14 when the override sets no zoom", () => {
        setEnv({SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf"});
        expect(vectorWaterMaxZoom()).toBe(14);
    });

    test("a shallower server is respected", () => {
        setEnv({
            SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
            SITREC_VECTOR_WATER_MAX_ZOOM: "12",
        });
        expect(vectorWaterMaxZoom()).toBe(12);
    });

    test("nonsense falls back to the default rather than to NaN", () => {
        // NaN would propagate into osmTileForTile's shift arithmetic and put
        // the coastline somewhere arbitrary, which is much worse than 14.
        for (const bad of ["", "abc", "  "]) {
            setEnv({
                SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
                SITREC_VECTOR_WATER_MAX_ZOOM: bad,
            });
            expect(vectorWaterMaxZoom()).toBe(14);
        }
    });

    test("a terrain tile deeper than the server goes crops from the ancestor", () => {
        setEnv({
            SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
            SITREC_VECTOR_WATER_MAX_ZOOM: "12",
        });
        // A z14 terrain tile is a quarter-of-a-quarter of its z12 ancestor.
        const source = waterMaskSourceForTile(14, 2796, 6544);
        expect(source.url).toBe("https://ex.org/12/699/1636.pbf");
        expect(source.srcRect).toEqual({fx: 0, fy: 0, fw: 0.25, fh: 0.25});
    });

    test("at or above the server's own zoom there is no crop", () => {
        setEnv({
            SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
            SITREC_VECTOR_WATER_MAX_ZOOM: "12",
        });
        const source = waterMaskSourceForTile(12, 699, 1636);
        expect(source.url).toBe("https://ex.org/12/699/1636.pbf");
        expect(source.srcRect).toBeNull();
    });
});

describe("fillTileTemplate", () => {

    test("leaves a template with no placeholders alone", () => {
        expect(fillTileTemplate("https://ex.org/all.pbf", 1, 2, 3))
            .toBe("https://ex.org/all.pbf");
    });

    test("does not touch anything but z, x and y", () => {
        expect(fillTileTemplate("https://ex.org/{s}/{z}/{x}/{y}?v={v}", 1, 2, 3))
            .toBe("https://ex.org/{s}/1/2/3?v={v}");
    });
});

describe("attribution", () => {

    test("MapTiler credits both MapTiler and OpenStreetMap", () => {
        setEnv({MAPTILER_KEY: "TESTKEY"});
        const source = vectorWaterSource();
        expect(source.attribution).toMatch(/MapTiler/);
        expect(source.attribution).toMatch(/OpenStreetMap/);
        expect(source.termsURL).toBe("https://www.maptiler.com/copyright/");
    });

    test("a custom source is credited to OpenStreetMap by default", () => {
        // The schema this module decodes is OpenMapTiles, and a server speaking
        // it is overwhelmingly serving ODbL OpenStreetMap data. Defaulting to a
        // credit and letting the operator correct it is the right way round —
        // the reverse drops a licence obligation for anyone who never reads the
        // documentation.
        setEnv({SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf"});
        const source = vectorWaterSource();
        expect(source.attribution).toMatch(/OpenStreetMap/);
        expect(source.termsURL).toBe("https://www.openstreetmap.org/copyright");
    });

    test("an operator can replace the credit", () => {
        setEnv({
            SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
            SITREC_VECTOR_WATER_ATTRIBUTION: "Water: Example Hydrography Office",
            SITREC_VECTOR_WATER_TERMS_URL: "https://example.org/terms",
        });
        const source = vectorWaterSource();
        expect(source.attribution).toBe("Water: Example Hydrography Office");
        expect(source.termsURL).toBe("https://example.org/terms");
    });

    test("an EMPTY credit is honoured, not treated as unset", () => {
        // Truthiness would silently reinstate the OSM default here, so an
        // operator whose data needs no credit could not switch the line off.
        setEnv({
            SITREC_VECTOR_WATER_URL: "https://ex.org/{z}/{x}/{y}.pbf",
            SITREC_VECTOR_WATER_ATTRIBUTION: "",
        });
        expect(vectorWaterSource().attribution).toBe("");
    });

    test("no source means nothing to credit", () => {
        setEnv({MAPTILER_KEY: ""});
        expect(vectorWaterSource()).toBeNull();
    });
});
