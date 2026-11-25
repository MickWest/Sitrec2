jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/FastComputeVertexNormalsAsync", () => ({}));
jest.mock("../src/js/get-pixels-mick", () => ({}));

import {Group, Matrix4, Object3D, PlaneGeometry, Sphere, Vector3} from "three";
import {Globals, NodeMan, setNodeMan} from "../src/Globals";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {QuadTreeTile} from "../src/QuadTreeTile";
import {CNodeWaterReflection} from "../src/nodes/CNodeWaterReflection";
import {getLocalDownVector} from "../src/SphericalMath";
import {CTileMappingGoogleCRS84Quad, CTileMappingGoogleMapsCompatible} from "../src/WMSUtils";

const BASE_SIZE = 259560;
const SEGMENTS = 4;
let originalSettings, originalEquatorRadius, originalPolarRadius, originalNodeMan;
let tiles;

beforeEach(() => {
    originalNodeMan = NodeMan;
    originalSettings = Globals.settings;
    originalEquatorRadius = Globals.equatorRadius;
    originalPolarRadius = Globals.polarRadius;
    Globals.settings = {...Globals.settings, tileSegments: SEGMENTS};
    Globals.equatorRadius = 6378137;
    Globals.polarRadius = 6356752.314245;
    tiles = [];
});

afterEach(() => {
    for (const tile of tiles) {
        tile.geometry.dispose();
        tile.skirtGeometry?.dispose();
    }
    setNodeMan(originalNodeMan);
    Globals.settings = originalSettings;
    Globals.equatorRadius = originalEquatorRadius;
    Globals.polarRadius = originalPolarRadius;
});

function makeTile(projection, z) {
    const tile = Object.create(QuadTreeTile.prototype);
    Object.assign(tile, {
        map: {options: {mapProjection: projection, tileSegments: SEGMENTS}},
        size: BASE_SIZE,
        z,
        x: Math.floor(projection.lon2Tile(10, z)),
        y: Math.floor(projection.lat2Tile(60, z)),
        geometry: new PlaneGeometry(250, 250, SEGMENTS, SEGMENTS),
    });
    const positions = tile.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) positions.setZ(i, i * 0.5);
    tiles.push(tile);
    return tile;
}

function expectEdgesCovered(tile) {
    const projection = tile.map.options.mapProjection;
    const north = projection.getNorthLatitude(tile.y, tile.z);
    const south = projection.getNorthLatitude(tile.y + 1, tile.z);
    const longitude = projection.getLeftLongitude(tile.x + 0.5, tile.z);
    const drop = getLocalDownVector(LLAToECEF((north + south) / 2, longitude, 0))
        .multiplyScalar(tile.skirtDepth);
    const main = tile.geometry.attributes.position;
    const skirt = tile.skirtGeometry.attributes.position;
    const top = new Vector3(), bottom = new Vector3();
    const mainEdges = new Set();
    for (let y = 0; y <= SEGMENTS; y++) for (let x = 0; x <= SEGMENTS; x++) {
        if (x === 0 || x === SEGMENTS || y === 0 || y === SEGMENTS) {
            mainEdges.add(new Vector3().fromBufferAttribute(main, y * (SEGMENTS + 1) + x).toArray().join(","));
        }
    }
    const skirtTops = new Set();
    for (let i = 0; i < skirt.count; i += 2) {
        top.fromBufferAttribute(skirt, i);
        bottom.fromBufferAttribute(skirt, i + 1);
        skirtTops.add(top.toArray().join(","));
        expect(bottom.sub(top).distanceTo(drop)).toBeLessThan(0.0001);
    }
    expect(skirtTops).toEqual(mainEdges);
}

describe.each([
    ["Web Mercator", CTileMappingGoogleMapsCompatible, 15, 16],
    ["equirectangular", CTileMappingGoogleCRS84Quad, 30, 31],
])("%s terrain skirts", (name, Projection, minFineDepth, maxFineDepth) => {
    test("fine tiles use their own span while coarse roots retain the existing depth limit", () => {
        const projection = new Projection();
        const fine = makeTile(projection, 17);
        const finer = makeTile(projection, 18);
        const root = makeTile(projection, 0);
        for (const tile of [fine, finer, root]) tile.buildSkirtGeometry();

        // At 60 degrees latitude these tiles span roughly 153 m (Mercator)
        // or 306 m (equirectangular), despite sharing a 260 km base width.
        expect(fine.skirtDepth).toBeGreaterThan(minFineDepth);
        expect(fine.skirtDepth).toBeLessThan(maxFineDepth);
        expect(finer.skirtDepth / fine.skirtDepth).toBeCloseTo(0.5, 3);
        expect(root.skirtDepth).toBe(BASE_SIZE * 0.1);
        expect(fine.size).toBe(BASE_SIZE);
        expect(root.size).toBe(BASE_SIZE);
    });

    test("building and updating skirts preserve every surface edge and the recorded drop", () => {
        const tile = makeTile(new Projection(), 17);
        tile.buildSkirtGeometry();
        const depth = tile.skirtDepth;
        expectEdgesCovered(tile);

        // Elevation arrival changes the main mesh; the skirt must follow the
        // new edge positions without reverting to the map's initial depth.
        const positions = tile.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) positions.setZ(i, positions.getZ(i) + 12 + i % 3);
        tile.updateSkirtGeometry();
        expect(tile.skirtDepth).toBe(depth);
        expectEdgesCovered(tile);
        expect(tile.skirtGeometry.boundingBox).not.toBeNull();
        expect(tile.skirtGeometry.boundingSphere).not.toBeNull();
    });
});

test("reflection hides a shoreline skirt by its lowest edge and preserves high hillside skirts", () => {
    const terrain = new Group();
    const addSkirt = (min, max, measured = true) => {
        const skirt = new Object3D();
        skirt.userData.isTerrainSkirt = true;
        skirt.userData.tile = {
            size: BASE_SIZE,
            skirtDepth: 25,
            altitudeBounds: {min, max, measured},
            // Both tile centres are well above the water. Only the shoreline
            // tile has a low edge that reaches it, so centre altitude is unsafe.
            mesh: {
                geometry: {boundingSphere: new Sphere(LLAToECEF(60, 10, 250), 300)},
                matrixWorld: new Matrix4(),
            },
        };
        terrain.add(skirt);
        return skirt;
    };
    const shore = addSkirt(10, 500);
    const hill = addSkirt(200, 300);
    const unknown = addSkirt(200, 300, false);
    setNodeMan({get: id => id === "TerrainModel" ? {getGroup: () => terrain} : undefined});
    const reflection = Object.create(CNodeWaterReflection.prototype);
    reflection.mirrorHideSkirts = true;

    reflection.hideSkirts({altitude: 0});
    expect(shore.visible).toBe(false);
    expect(hill.visible).toBe(true);
    expect(unknown.visible).toBe(false);
    reflection.restoreSkirts();
    expect(shore.visible).toBe(true);
    expect(hill.visible).toBe(true);
    expect(unknown.visible).toBe(true);
});
