import {
    terrainAnalysisConfigScalars,
    terrainDependencyRecordsMatch,
} from "../src/TraverseAnalysisCache";

describe("Traverse analysis cache", () => {
    test("render-camera terrain LOD state is not an analysis configuration input", () => {
        const terrain = {
            loaded: true,
            elevationRevision: 76,
            UI: {
                mapType: "ESRI World Imagery",
                elevationType: "Mapbox",
                zoom: 8,
                nTiles: 3,
                elevationScale: 1,
            },
            elevationMap: {
                getTileCount: () => 117,
                getAllTileKeys: () => ["camera/a", "camera/b"],
            },
        };
        const before = terrainAnalysisConfigScalars(terrain, 6378137, 6356752.314245);

        // Exact runtime failure mode: orbiting mainCamera changed only these
        // view-driven values (revision 76→96, tile count 117→141).
        terrain.elevationRevision = 96;
        terrain.elevationMap.getTileCount = () => 141;
        terrain.elevationMap.getAllTileKeys = () => ["elsewhere/x", "elsewhere/y", "elsewhere/z"];
        const after = terrainAnalysisConfigScalars(terrain, 6378137, 6356752.314245);
        expect(after).toEqual(before);
    });

    test("terrain model configuration still invalidates the analysis", () => {
        const terrain = {
            loaded: true,
            UI: {mapType: "A", elevationType: "DEM-1", zoom: 8, nTiles: 3, elevationScale: 1},
        };
        const before = terrainAnalysisConfigScalars(terrain, 6378137, 6356752);
        terrain.UI.elevationType = "DEM-2";
        expect(terrainAnalysisConfigScalars(terrain, 6378137, 6356752)).not.toEqual(before);
    });

    test("an explicit terrain data reload invalidates even with unchanged UI settings", () => {
        const terrain = {
            loaded: true,
            UI: {mapType: "A", elevationType: "DEM", zoom: 8, nTiles: 3, elevationScale: 1},
        };
        const before = terrainAnalysisConfigScalars(terrain, 6378137, 6356752, 4);
        const after = terrainAnalysisConfigScalars(terrain, 6378137, 6356752, 5);
        expect(after).not.toEqual(before);
    });

    test("only changed terrain actually used by a cached corridor invalidates it", () => {
        const cached = [
            {key: "local-ground", groundAltitudeM: 12, tileZ: 10},
            {key: "aircraft:0", groundAltitudeM: 31.5, tileZ: 12},
        ];
        expect(terrainDependencyRecordsMatch(cached, cached.map((x) => ({...x})))).toBe(true);

        // A view move evicted the detailed tile. Keep the result produced from
        // the better cached sample instead of rerunning every optimizer.
        const evicted = cached.map((x) => ({...x}));
        evicted[1].tileZ = 9;
        evicted[1].groundAltitudeM = 28;
        expect(terrainDependencyRecordsMatch(cached, evicted)).toBe(true);

        // Newly available equal/higher-resolution terrain changed a height the
        // analysis actually tested: this is a genuine input improvement.
        const improved = cached.map((x) => ({...x}));
        improved[1].tileZ = 13;
        improved[1].groundAltitudeM = 34;
        expect(terrainDependencyRecordsMatch(cached, improved)).toBe(false);
    });
});
