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
