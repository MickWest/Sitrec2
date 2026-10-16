jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/QuadTreeTile", () => ({QuadTreeTile: jest.fn()}));

import {Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3} from "three";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {QuadTreeMapTexture} from "../src/QuadTreeMapTexture";
import {CTileMappingGoogleMapsCompatible} from "../src/WMSUtils";

function installCameraFrustums(camera) {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const viewProjection = new Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
    );
    camera.viewFrustum = new Frustum().setFromProjectionMatrix(viewProjection);
    camera.dilatedFrustum = new Frustum().setFromProjectionMatrix(viewProjection);
    camera._viewportHeightPx = 1000;
}

describe("QuadTreeMap tile visibility", () => {
    test("does not horizon-cull frustum tiles when camera altitude is below the ellipsoid", () => {
        const earthRadiusM = 6378137;
        const camera = new PerspectiveCamera(60, 1, 1, 1000);
        camera.position.set(earthRadiusM - 10, 0, 0);
        camera.lookAt(earthRadiusM - 10, 0, 100);
        installCameraFrustums(camera);

        const tile = {
            z: 16,
            _centerLatRad: 0,
            highestAltitude: 0,
            parent: null,
            getWorldSphere() {
                return new Sphere(new Vector3(earthRadiusM - 10, 0, 100), 10);
            },
        };
        const map = Object.create(QuadTreeMapTexture.prototype);

        const visibility = map.calculateTileVisibility(tile, camera, {
            mode: "legacy",
            coverageMode: "main",
        });

        expect(visibility.frustumIntersects).toBe(true);
        expect(visibility.visible).toBe(true);
    });

    test("does not block prospective child subdivision below the ellipsoid", () => {
        const projection = new CTileMappingGoogleMapsCompatible();
        const parentTile = {
            z: 15,
            x: 16384,
            y: 16384,
            highestAltitude: 0,
            parent: null,
        };
        const childZ = parentTile.z + 1;
        const childX = parentTile.x * 2;
        const childY = parentTile.y * 2;
        const childLat = (
            projection.getNorthLatitude(childY, childZ) +
            projection.getNorthLatitude(childY + 1, childZ)
        ) / 2;
        const childLon = (
            projection.getLeftLongitude(childX, childZ) +
            projection.getLeftLongitude(childX + 1, childZ)
        ) / 2;
        const childCenter = LLAToECEF(childLat, childLon, 0);
        const up = childCenter.clone().normalize();
        const east = new Vector3(0, 0, 1).cross(up).normalize();

        const camera = new PerspectiveCamera(60, 1, 1, 5000);
        camera.position.copy(childCenter)
            .addScaledVector(east, -1500)
            .addScaledVector(up, -10);
        camera.lookAt(childCenter);
        installCameraFrustums(camera);

        const map = Object.create(QuadTreeMapTexture.prototype);
        map.options = {mapProjection: projection};

        expect(map.anyProspectiveChildVisible(parentTile, camera)).toBe(true);
    });
});

describe("ground column under the camera (elevation map)", () => {
    // The elevation tiles under a camera must refine whatever it looks at: an AGL camera's
    // height, WASD walking and the C-key eye-level placement are all measured from them.
    const projection = new CTileMappingGoogleMapsCompatible();
    const lat = 33.217213, lon = -106.637568;
    const tileAt = (z) => ({
        z,
        x: Math.floor(Math.abs(projection.lon2Tile(lon, z) % 2 ** z)),
        y: Math.floor(Math.abs(projection.lat2Tile(lat, z) % 2 ** z)),
    });
    const map = Object.create(QuadTreeMapTexture.prototype);
    map.options = {mapProjection: projection};

    test("a camera on the ground keeps every zoom of the tile it stands in", () => {
        const column = {lat, lon, heightM: 2};
        for (let z = 0; z <= 15; z++) expect(map.tileInGroundColumn(tileAt(z), column)).toBe(true);
        // ...but not the tile next door.
        const t = tileAt(12);
        expect(map.tileInGroundColumn({...t, x: t.x + 1}, column)).toBe(false);
    });

    test("a camera high above stops at tiles wide compared with its height", () => {
        const column = {lat, lon, heightM: 10000};
        // At 33 deg a z11 tile is about 16.4 km wide and a z10 one 32.8 km.
        expect(map.tileInGroundColumn(tileAt(10), column)).toBe(true);
        expect(map.tileInGroundColumn(tileAt(11), column)).toBe(false);
    });

    test("the column measures the camera's height from the loaded ground", () => {
        const elev = Object.create(QuadTreeMapTexture.prototype);
        elev.getElevationInterpolated = () => 2029.5;
        const camera = new PerspectiveCamera();
        camera.position.copy(LLAToECEF(lat, lon, 2031.6));
        const column = elev.groundColumnUnder(camera);
        expect(column.lat).toBeCloseTo(lat, 6);
        expect(column.lon).toBeCloseTo(lon, 6);
        expect(column.heightM).toBeCloseTo(2.1, 1);
        // Under the ground (the case that started this) it still asks for the finest tiles.
        camera.position.copy(LLAToECEF(lat, lon, 1990));
        expect(elev.groundColumnUnder(camera).heightM).toBe(1);
    });

    test("no column, no tile", () => {
        expect(map.tileInGroundColumn(tileAt(8), null)).toBe(false);
    });
});
