import {
    defaultSourcesEnabled,
    filterSourcesForServerless,
    filterToCustomAndOfflineSources,
    findOSMWaterSource,
    isStandardOSMTileURL,
    OSM_WATER_COLOR,
    parseWaterColor,
    pickAvailableSourceType,
    waterColorForCustomSource,
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

// Water Reflection finds water by matching the map texture against the active
// source's declared waterColor. Getting any of this wrong does not throw — the
// effect simply stays off, or detects water of the wrong colour, both of which
// look like "the feature is broken" rather than like a bug with a location.
describe("water colour for custom map sources", () => {
    test("recognises the standard OSM tile servers, with or without a subdomain", () => {
        expect(isStandardOSMTileURL("https://c.tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe(true);
        expect(isStandardOSMTileURL("https://tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe(true);
        expect(isStandardOSMTileURL("http://a.tile.osm.org/{z}/{x}/{y}.png")).toBe(true);
    });

    test("accepts an explicit port on the host", () => {
        expect(isStandardOSMTileURL("https://tile.openstreetmap.org:443/{z}/{x}/{y}.png")).toBe(true);
        expect(isStandardOSMTileURL("http://c.tile.openstreetmap.org:8080/{z}/{x}/{y}.png")).toBe(true);
    });

    test("recognises OSM behind the cachemaps proxy, where the host is percent-encoded", () => {
        const proxied = "https://www.metabunk.org/sitrec/sitrecServer/cachemaps.php?url="
            + encodeURIComponent("https://c.tile.openstreetmap.org/{z}/{x}/{y}.png");
        expect(isStandardOSMTileURL(proxied)).toBe(true);
    });

    test("does not claim OSM's water colour for other tile servers", () => {
        // A self-hosted renderer or a different style may paint water anything at
        // all, so it must declare _WATER_COLOR rather than be guessed at.
        expect(isStandardOSMTileURL("https://tiles.example.org/osm/{z}/{x}/{y}.png")).toBe(false);
        expect(isStandardOSMTileURL("https://services.arcgisonline.com/{z}/{y}/{x}")).toBe(false);
        expect(isStandardOSMTileURL("https://openstreetmap.org.evil.example/{z}/{x}/{y}.png")).toBe(false);
        expect(isStandardOSMTileURL(undefined)).toBe(false);
    });

    test("survives a malformed percent-escape instead of throwing", () => {
        // decodeURIComponent throws on a lone '%'; the raw string is tested instead.
        expect(isStandardOSMTileURL("https://c.tile.openstreetmap.org/%/{z}/{x}/{y}.png")).toBe(true);
        expect(isStandardOSMTileURL("https://tiles.example.org/%")).toBe(false);
    });

    test("parses both documented water colour formats", () => {
        expect(parseWaterColor("170,211,223")).toEqual([170, 211, 223]);
        expect(parseWaterColor(" 170 , 211 , 223 ")).toEqual([170, 211, 223]);
        expect(parseWaterColor("#AAD3DF")).toEqual([170, 211, 223]);
        expect(parseWaterColor("aad3df")).toEqual([170, 211, 223]);
    });

    test("the two formats agree with the OSM constant", () => {
        expect(parseWaterColor("#AAD3DF")).toEqual(OSM_WATER_COLOR);
    });

    test("rejects unparseable water colours rather than inventing one", () => {
        expect(parseWaterColor(undefined)).toBeUndefined();
        expect(parseWaterColor("")).toBeUndefined();
        expect(parseWaterColor("blue")).toBeUndefined();
        expect(parseWaterColor("170,211")).toBeUndefined();
        expect(parseWaterColor("170,211,223,255")).toBeUndefined();
        expect(parseWaterColor("#AAD3")).toBeUndefined();
    });

    test("clamps out-of-range channels", () => {
        expect(parseWaterColor("-5,300,223.6")).toEqual([0, 255, 224]);
    });

    // This is what the SITREC_CUSTOM_MAP_* parser actually calls.
    describe("waterColorForCustomSource", () => {
        const OSM_URL = "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png";
        const OTHER_URL = "https://tiles.example.org/osm/{z}/{x}/{y}.png";

        test("the documented OSM example needs no _WATER_COLOR", () => {
            expect(waterColorForCustomSource(undefined, OSM_URL)).toEqual(OSM_WATER_COLOR);
        });

        test("an explicit colour overrides the automatic OSM one", () => {
            // A restyled OSM served from the real tile servers is unusual, but the
            // explicit value must win wherever it is set.
            expect(waterColorForCustomSource("#102030", OSM_URL)).toEqual([16, 32, 48]);
            expect(waterColorForCustomSource("1,2,3", OTHER_URL)).toEqual([1, 2, 3]);
        });

        test("a non-OSM source with no explicit colour gets none", () => {
            expect(waterColorForCustomSource(undefined, OTHER_URL)).toBeUndefined();
            expect(waterColorForCustomSource("", OTHER_URL)).toBeUndefined();
        });

        test("a typo falls through to the URL test rather than being trusted", () => {
            expect(waterColorForCustomSource("blue", OSM_URL)).toEqual(OSM_WATER_COLOR);
            expect(waterColorForCustomSource("blue", OTHER_URL)).toBeUndefined();
        });

        test("returns a copy, so one source cannot mutate another's colour", () => {
            const first = waterColorForCustomSource(undefined, OSM_URL);
            first[0] = 0;
            expect(waterColorForCustomSource(undefined, OSM_URL)).toEqual([170, 211, 223]);
            expect(OSM_WATER_COLOR).toEqual([170, 211, 223]);
        });
    });
});

describe("findOSMWaterSource", () => {
    const osmish = {waterColor: [170, 211, 223]};

    test("prefers the config.js osm key, so existing installs are unchanged", () => {
        const other = {waterColor: [1, 2, 3]};
        const sources = {CustomMap_OSM: other, osm: osmish};
        expect(findOSMWaterSource(sources)).toBe(osmish);
    });

    test("an osm key that deliberately clears waterColor still disables the combine", () => {
        // The backfill only fills `undefined`, so `null` is a way to opt out. The
        // fallback must not defeat that by stamping from osmHighlight instead.
        const sources = {osm: {waterColor: null}, osmHighlight: {waterColor: [170, 211, 223]}};
        expect(findOSMWaterSource(sources)).toBeUndefined();
    });

    test("falls back to an env-defined source when there is no config osm key", () => {
        // SITREC_ENABLE_DEFAULT_MAP_SOURCES=false strips the config.js sources,
        // and an env-only deployment never had one.
        const sources = {CustomMap_OSM: osmish, CustomMap_ESRI: {name: "ESRI"}};
        expect(findOSMWaterSource(sources)).toBe(osmish);
    });

    test("never stamps from osmHighlight, the road-highlight variant", () => {
        // The real shape from config.js: commenting out `osm` leaves osmHighlight
        // backfilled with OSM's colour and FIRST in insertion order, so it used to
        // win over the user's own env-defined OSM. It recolors its tiles
        // (dimIntensity 0.1, roads yellow) and is hidden from the menu.
        const osmHighlight = {waterColor: [170, 211, 223], processColors: true,
                              excludeFromMenu: true,
                              mapURL: () => "https://host/cachemaps.php?url=x"};
        const envOsm = {waterColor: [170, 211, 223],
                        mapURL: (z, x, y) => `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`};
        expect(findOSMWaterSource({osmHighlight, CustomMap_OSM: envOsm})).toBe(envOsm);
        // and with nothing else to fall back to, it is still not used
        expect(findOSMWaterSource({osmHighlight})).toBeUndefined();
    });

    test("prefers a recognisably-OSM source over whichever is first", () => {
        // Insertion order is an accident of config.js, so it must not decide this.
        const other = {waterColor: [1, 2, 3], mapURL: () => "https://tiles.example.org/a.png"};
        const envOsm = {waterColor: [170, 211, 223],
                        mapURL: (z, x, y) => `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`};
        expect(findOSMWaterSource({AAA_other: other, CustomMap_OSM: envOsm})).toBe(envOsm);
    });

    test("falls back to a non-OSM coloured source when there is no OSM one", () => {
        const other = {waterColor: [1, 2, 3], mapURL: () => "https://tiles.example.org/a.png"};
        expect(findOSMWaterSource({CustomMap_HOUSE: other})).toBe(other);
    });

    test("a mapURL that throws does not take out the search", () => {
        // Some sources' mapURL expects a layer argument.
        const throws = {waterColor: [9, 9, 9], mapURL: () => { throw new Error("needs layer"); }};
        const envOsm = {waterColor: [170, 211, 223],
                        mapURL: (z, x, y) => `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`};
        expect(findOSMWaterSource({throws, CustomMap_OSM: envOsm})).toBe(envOsm);
    });

    test("skips 4326 sources in the fallback search", () => {
        // GoogleCRS84Quad tiles do not line up with the Web Mercator grid the
        // combine assumes, so stamping from one puts water in the wrong place.
        const equirectangular = {waterColor: [170, 211, 223], mapping: 4326};
        expect(findOSMWaterSource({CustomMap_NRL: equirectangular})).toBeUndefined();
        expect(findOSMWaterSource({CustomMap_NRL: equirectangular, CustomMap_OSM: osmish}))
            .toBe(osmish);
    });

    test("returns undefined when no source declares a water colour", () => {
        expect(findOSMWaterSource({ESRI: {name: "ESRI"}, Local: {name: "Local"}})).toBeUndefined();
        expect(findOSMWaterSource({})).toBeUndefined();
        expect(findOSMWaterSource(undefined)).toBeUndefined();
    });
});
