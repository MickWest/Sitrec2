import {
    defaultSourcesEnabled,
    filterSourcesForServerless,
    filterToCustomAndOfflineSources,
    pickAvailableSourceType,
} from "../src/terrainSourceUtils";

describe("terrainSourceUtils", () => {
    test("filters out sources that are not allowed in serverless mode", () => {
        const sources = {
            Debug: {allowInServerless: true},
            ESRI: {name: "ESRI"},
            Local: {allowInServerless: true},
        };

        expect(filterSourcesForServerless(sources)).toEqual({
            Debug: {allowInServerless: true},
            Local: {allowInServerless: true},
        });
    });

    test("falls back to Local when the requested default source is unavailable", () => {
        const sources = {
            Debug: {allowInServerless: true},
            Local: {allowInServerless: true},
        };

        expect(pickAvailableSourceType({
            sources,
            requestedType: "ESRI",
            defaultType: "AWS_Terrarium",
        })).toBe("Local");
    });

    test("keeps an explicitly requested local-safe source when it is available", () => {
        const sources = {
            Debug: {allowInServerless: true},
            Local: {allowInServerless: true},
        };

        expect(pickAvailableSourceType({
            sources,
            requestedType: "Debug",
            defaultType: "Local",
        })).toBe("Debug");
    });

    test("filterToCustomAndOfflineSources keeps custom + offlineSafe, drops internet sources", () => {
        const sources = {
            ESRI: {name: "ESRI"},                       // internet provider -> dropped
            MapBox: {name: "MapBox"},                   // internet provider -> dropped
            Local: {name: "Local", offlineSafe: true},  // offline -> kept
            Debug: {name: "Debug", offlineSafe: true},  // offline -> kept
            CustomMap_WORLD: {name: "World"},           // user's custom -> kept
        };

        expect(filterToCustomAndOfflineSources(sources, /^CustomMap_/)).toEqual({
            Local: {name: "Local", offlineSafe: true},
            Debug: {name: "Debug", offlineSafe: true},
            CustomMap_WORLD: {name: "World"},
        });
    });

    test("defaultSourcesEnabled defaults to true, only explicit false disables", () => {
        expect(defaultSourcesEnabled(undefined)).toBe(true);   // unset -> keep defaults
        expect(defaultSourcesEnabled("")).toBe(true);
        expect(defaultSourcesEnabled("true")).toBe(true);
        expect(defaultSourcesEnabled(true)).toBe(true);
        expect(defaultSourcesEnabled("false")).toBe(false);    // env arrives as a string
        expect(defaultSourcesEnabled("False")).toBe(false);
        expect(defaultSourcesEnabled(false)).toBe(false);
    });
});
