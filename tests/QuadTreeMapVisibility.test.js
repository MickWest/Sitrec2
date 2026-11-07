jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/QuadTreeTile", () => ({QuadTreeTile: jest.fn()}));

import {Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3} from "three";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {QuadTreeMapTexture} from "../src/QuadTreeMapTexture";
import {CTileMappingGoogleMapsCompatible} from "../src/WMSUtils";
import {terrestrialLiftContext, liftWorldPoint} from "../src/atmosphere/terrestrialRefraction";
import {buildFrustumShape, createFrustumShape, OBB} from "../src/QuadTreeCullingBounds";

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
    test("a distant mountain's prospective children inherit elevation instead of sea level", () => {
        const projection = new CTileMappingGoogleMapsCompatible();
        const lat = 0, lon = 2;
        const parent = {z: 10, x: Math.floor(projection.lon2Tile(lon, 10)),
            y: Math.floor(projection.lat2Tile(lat, 10)), highestAltitude: 4000, parent: null};
        const camera = new PerspectiveCamera(3, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 100));
        camera.up.set(1, 0, 0); camera.lookAt(LLAToECEF(lat, lon, 4000));
        installCameraFrustums(camera);
        const map = Object.create(QuadTreeMapTexture.prototype);
        map.options = {mapProjection: projection};
        expect(map.anyProspectiveChildVisible(parent, camera)).toBe(true);
    });

    test("Standard refraction lifts a tile up into a narrow view, never sideways into it", () => {
        // Same view as below: 0.05 deg, aimed at the lifted 3883 m summit 445 km away,
        // where the frame is about 390 m wide and the lift bound is over 2 km. A
        // tile 600 m BESIDE the summit stays outside the frame however far the lift
        // raises it. One sphere grown by half the lift in every direction took it in.
        const camera = new PerspectiveCamera(.05, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 2828));
        camera.up.set(1, 0, 0);
        const point = LLAToECEF(0, 4, 3883);
        const ctx = terrestrialLiftContext(camera.position, {enabled: true, k: .17});
        camera.lookAt(liftWorldPoint(ctx, point)); installCameraFrustums(camera);
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const beside = point.clone().addScaledVector(right, 600);
        const seaLevel = p => p.clone().multiplyScalar((p.length() - 3883) / p.length());
        const tileAt = p => ({z: 16, _centerLatRad: 0, highestAltitude: 3883, parent: null,
            getWorldSphere: () => new Sphere(seaLevel(p), 10)});
        const map = Object.create(QuadTreeMapTexture.prototype);
        camera._terrainLift = ctx;
        expect(map.calculateTileVisibility(tileAt(point), camera).visible).toBe(true);
        expect(map.calculateTileVisibility(tileAt(beside), camera).visible).toBe(false);
    });

    // The default bounds mode is "obb": a tile's oriented box is the tight test, since a
    // distant tile's sphere is tens of km thick where its terrain is a few. Under
    // Standard refraction the box is swept up by the lift. Skipping it left only the
    // sphere, which doubled the tiles kept in a view looking down at Cheyenne.
    test("Standard refraction sweeps the OBB narrow phase up, it does not skip it", () => {
        const camera = new PerspectiveCamera(.05, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 2828));
        camera.up.set(1, 0, 0);
        const summit = LLAToECEF(0, 4, 3883);
        const ctx = terrestrialLiftContext(camera.position, {enabled: true, k: .17});
        camera.lookAt(liftWorldPoint(ctx, summit)); installCameraFrustums(camera);
        camera._viewFrustumShape = buildFrustumShape(createFrustumShape(), camera, camera.projectionMatrix);
        camera._dilatedFrustumShape = buildFrustumShape(createFrustumShape(), camera, camera.projectionMatrix);
        // On the equator the local up is radial and north is +Z.
        const up = summit.clone().normalize(), east = new Vector3(-up.y, up.x, 0), north = new Vector3(0, 0, 1);
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        // A measured tile: a box `half` m wide from sea level up to `top`, and a sphere of `radius`.
        const tileAt = (top, half, radius) => {
            const obb = new OBB();
            obb.box.min.set(-half, -half, -3883 / 2);
            obb.box.max.set(half, half, 3883 / 2);
            obb.transform.makeBasis(east, north, up).setPosition(top.clone().addScaledVector(up, -3883 / 2));
            obb.update();
            const state = {sphere: new Sphere(top.clone(), radius), obb};
            return {z: 16, _centerLatRad: 0, highestAltitude: 3883, parent: null, cullingState: state,
                altitudeBounds: {measured: true, source: "renderedGeometry"}, ensureCullingState: () => state,
                getWorldSphere: () => new Sphere(top.clone().multiplyScalar((top.length() - 3883) / top.length()), radius)};
        };
        const map = Object.create(QuadTreeMapTexture.prototype);
        const obbMode = {mode: "obb", coverageMode: "main"};
        camera._terrainLift = ctx;
        // The summit's box reaches the frame only once it is swept up by the lift.
        expect(map.calculateTileVisibility(tileAt(summit, 100, 10), camera, obbMode).visible).toBe(true);
        // A box 600 m beside the summit stays out, though its 1 km sphere reaches the frame.
        const beside = tileAt(summit.clone().addScaledVector(right, 600), 100, 1000);
        expect(map.calculateTileVisibility(beside, camera, {mode: "sphere", coverageMode: "main"}).visible).toBe(true);
        expect(map.calculateTileVisibility(beside, camera, obbMode).visible).toBe(false);
        // The physical box is not changed by the sweep.
        expect(beside.cullingState.obb.box.max.z).toBe(3883 / 2);
    });

    // Refraction raises the sea horizon as well as the terrain behind it: with a
    // uniform k the view behaves as if the Earth's radius were R/(1-k). From 2828 m,
    // 445 km out, that hides 3.65 km. Adding only the target's lift to the GEOMETRIC
    // horizon test (5.11 km hidden, 2.64 km lift) also let through a 3000 m top that
    // can never show.
    test("Standard refraction's horizon is raised with the terrain", () => {
        const camera = new PerspectiveCamera(5, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 2828));
        camera.up.set(1, 0, 0);
        const ctx = terrestrialLiftContext(camera.position, {enabled: true, k: .17});
        camera.lookAt(liftWorldPoint(ctx, LLAToECEF(0, 4, 3883))); installCameraFrustums(camera);
        const tileWithTop = top => ({z: 16, _centerLatRad: 0, highestAltitude: top, parent: null,
            getWorldSphere: () => new Sphere(LLAToECEF(0, 4, 0), 10)});
        const map = Object.create(QuadTreeMapTexture.prototype);
        camera._terrainLift = ctx;
        expect(map.calculateTileVisibility(tileWithTop(3883), camera).visible).toBe(true);
        expect(map.calculateTileVisibility(tileWithTop(3000), camera).visible).toBe(false);
    });

    test("ray-traced selection reads decoded heights and writes no tile state", () => {
        // A narrow view aimed at a 3883 m summit 222 km away, where the Earth hides
        // about 80 m. The tile has no mesh yet, so only its decoded elevation
        // range knows how high it is.
        const camera = new PerspectiveCamera(.05, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 2828));
        camera.up.set(1, 0, 0);
        camera.lookAt(LLAToECEF(0, 2, 3883)); installCameraFrustums(camera);
        const altitudeBounds = {min: -1500, max: 10000, measured: false, source: "global", generation: 0};
        const decoded = new Sphere(LLAToECEF(0, 2, 3883), 10);
        const tile = {z: 16, _centerLatRad: 0, highestAltitude: 0, altitudeBounds, parent: null,
            elevationDataBounds: {min: 3800, max: 3883},
            getWorldSphere: () => new Sphere(LLAToECEF(0, 2, 0), 10),
            decodedCullingSphere: jest.fn(() => decoded), ensureCullingState: jest.fn()};
        const map = Object.create(QuadTreeMapTexture.prototype);
        // Standard: the height arrives with the mesh, so the tile is at sea level.
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(false);
        expect(tile.decodedCullingSphere).not.toHaveBeenCalled();
        // Ray-traced geometry, with zero lift so only the bounds differ.
        camera._terrainRefraction = {observer: camera.position.clone(), zenith: camera.position.clone().normalize(),
            rayTable: {distances: [0, 1e7], width: 2, liftBounds: new Float32Array(4)}};
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(true);
        expect(tile.decodedCullingSphere).toHaveBeenCalled();
        // Nothing written back: a later Standard pass sees the tile as before.
        expect(tile.ensureCullingState).not.toHaveBeenCalled();
        expect(tile.highestAltitude).toBe(0);
        expect(tile.altitudeBounds).toBe(altitudeBounds);
        expect(altitudeBounds).toEqual({min: -1500, max: 10000, measured: false, source: "global", generation: 0});
        expect(decoded.radius).toBe(10);
        camera._terrainRefraction = null;
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(false);
    });

    test("Standard refraction admits a lifted mountain and keeps its LOD error", () => {
        const camera = new PerspectiveCamera(.05, 1, 1, 1e6);
        camera.position.copy(LLAToECEF(0, 0, 2828));
        camera.up.set(1, 0, 0);
        const point = LLAToECEF(0, 4, 3883);
        const ctx = terrestrialLiftContext(camera.position, {enabled: true, k: .17});
        camera.lookAt(liftWorldPoint(ctx, point)); installCameraFrustums(camera);
        const tile = {z: 16, _centerLatRad: 0, highestAltitude: 3883, parent: null,
            getWorldSphere: () => new Sphere(LLAToECEF(0, 4, 0), 10)};
        const map = Object.create(QuadTreeMapTexture.prototype);
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(false);
        // The summit is drawn lifted into this narrow view; its physical bounds miss it.
        camera._terrainLift = ctx;
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(true);
        camera._terrainLift = null;
        expect(map.calculateTileVisibility(tile, camera).visible).toBe(false);
        // The lift decides only whether a tile can be seen. For a tile that is
        // seen either way (222 km, above the horizon), the LOD error is the same
        // with and without it.
        const near = {z: 16, _centerLatRad: 0, highestAltitude: 3883, parent: null,
            getWorldSphere: () => new Sphere(LLAToECEF(0, 2, 0), 10)};
        camera.fov = 5; installCameraFrustums(camera);
        const plain = map.calculateTileVisibility(near, camera);
        camera._terrainLift = ctx;
        const lifted = map.calculateTileVisibility(near, camera);
        expect(plain.visible).toBe(true);
        expect(plain.screenSpaceError).toBeGreaterThan(0);
        expect(lifted.screenSpaceError).toBe(plain.screenSpaceError);
    });
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
