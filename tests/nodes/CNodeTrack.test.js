import {
    clampTerrainElevationHAE,
    conformControlPointsToAltitudeLock,
    terrainCacheMatchesLocation
} from "../../src/nodes/trackElevationUtils";
import {meanSeaLevelOffset} from "../../src/EGM96Geoid";
import {Vector3} from "three";

// The production EGM96Geoid loader fetches its grid binary lazily over the network,
// which isn't available under Jest. Delegate to the original egm96-universal package
// (bit-identical values — see scripts/extractEGM96Geoid.js validation) so these tests
// exercise real geoid undulations without needing the async loader.
jest.mock("../../src/EGM96Geoid", () => {
    const {meanSeaLevel} = require("egm96-universal");
    return {
        meanSeaLevelOffset: (lat, lon) => meanSeaLevel(Math.max(-90, Math.min(90, lat)), lon),
        ensureGeoidLoaded: () => Promise.resolve(),
    };
});

describe("clampTerrainElevationHAE", () => {
    test("preserves negative HAE sea-level terrain for cached 0 AGL reconstruction", () => {
        const lat = 25.2048;
        const lon = 55.2708;
        const seaLevel = meanSeaLevelOffset(lat, lon);

        expect(seaLevel).toBeLessThan(0);
        expect(clampTerrainElevationHAE(lat, lon, seaLevel)).toBeCloseTo(seaLevel, 10);
    });

    test("still preserves positive terrain elevations above local sea level", () => {
        const lat = 25.2048;
        const lon = 55.2708;
        const elevation = meanSeaLevelOffset(lat, lon) + 42;

        expect(clampTerrainElevationHAE(lat, lon, elevation)).toBeCloseTo(elevation, 10);
    });
});

describe("terrainCacheMatchesLocation", () => {
    test("rejects cache entries from a different lat/lon", () => {
        const cached = {lat: 25.2048, lon: 55.2708};

        expect(terrainCacheMatchesLocation(cached, 25.2048, 55.2708)).toBe(true);
        expect(terrainCacheMatchesLocation(cached, 25.2052, 55.2708)).toBe(false);
        expect(terrainCacheMatchesLocation(cached, 25.2048, 55.2712)).toBe(false);
    });
});

describe("conformControlPointsToAltitudeLock", () => {
    test("updates control points in place using frame-aware altitude locking", () => {
        const positions = [new Vector3(1, 2, 3), new Vector3(4, 5, 6)];
        const frames = [10, 20];

        const changed = conformControlPointsToAltitudeLock(
            positions,
            frames,
            (position, frame) => new Vector3(position.x, position.y, frame)
        );

        expect(changed).toBe(true);
        expect(positions[0].toArray()).toEqual([1, 2, 10]);
        expect(positions[1].toArray()).toEqual([4, 5, 20]);
    });
});
