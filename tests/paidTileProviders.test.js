import {isPaidTileSource, pickFreeSourceType, sampleSourceUrl} from "../src/paidTileProviders";

describe("paidTileProviders", () => {
    const mapbox = {name: "MapBox", mapURL: (z, x, y) => `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}.jpg?access_token=t`};
    const maptiler = {name: "MapTiler", urlTemplate: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=k"};
    const esri = {name: "ESRI", mapURL: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`};
    const wireframe = {name: "Wireframe", mapURL: () => null};
    const debug = {name: "Debug Info", isDebug: true};
    const terrarium = {name: "AWS Terrarium", mapURL: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`};
    const throwing = {name: "WMS", mapURL: function () { return this.missing.helper(); }};

    test("samples the 0/0/0 URL from mapURL, urlTemplate or url", () => {
        expect(sampleSourceUrl(mapbox)).toContain("api.mapbox.com");
        expect(sampleSourceUrl(maptiler)).toContain("maptiler");
        expect(sampleSourceUrl({url: "https://example.com/tiles"})).toBe("https://example.com/tiles");
    });

    test("sources that build no URL, or whose probe throws, are not paid", () => {
        expect(sampleSourceUrl(wireframe)).toBeNull();
        expect(sampleSourceUrl(debug)).toBeNull();
        expect(sampleSourceUrl(throwing)).toBeNull();
        expect(isPaidTileSource(wireframe)).toBe(false);
        expect(isPaidTileSource(debug)).toBe(false);
        expect(isPaidTileSource(throwing)).toBe(false);
        expect(isPaidTileSource(undefined)).toBe(false);
    });

    test("Mapbox and MapTiler are paid; ESRI and AWS Terrarium are not", () => {
        expect(isPaidTileSource(mapbox)).toBe(true);
        expect(isPaidTileSource(maptiler)).toBe(true);
        expect(isPaidTileSource(esri)).toBe(false);
        expect(isPaidTileSource(terrarium)).toBe(false);
    });

    test("picks the first free source in preference order, then any free source", () => {
        const sources = {mapbox, maptiler, ESRI: esri, wireframe};
        expect(pickFreeSourceType(sources, ["mapbox", "ESRI", "wireframe"])).toBe("ESRI");
        expect(pickFreeSourceType(sources, ["maptiler"])).toBe("ESRI");
        expect(pickFreeSourceType({mapbox, maptiler}, ["ESRI"])).toBeNull();
        expect(pickFreeSourceType(null, ["ESRI"])).toBeNull();
    });
});
