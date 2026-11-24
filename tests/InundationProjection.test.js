jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}}));

import {readFileSync} from "fs";
import {gunzipSync} from "zlib";
import {Matrix4, Vector3} from "three";
import {meanSeaLevel as referenceGeoid} from "egm96-universal";
import {Globals} from "../src/Globals";
import {ECEFToLLAVD_radii, RLLAToECEF_radii} from "../src/LLA-ECEF-ENU";
import {ecefToGeodetic} from "../src/GeodesyMath";
import {meanSeaLevelOffsetFromGrid} from "../src/EGM96GeoidMath";
import {mercatorX, mercatorY} from "../src/WaterMaskGeo";
import {projectInundationMesh} from "../src/water/InundationProjection";

// Decode the shipped grid for comparison against the original geoid package.
const values = 721 * 1440;
const planar = gunzipSync(readFileSync(`${__dirname}/../data/egm96/egm96-15.bin`));
const geoid = new Int16Array(values);
for (let row = 0; row < 721; row++) {
    let accumulated = 0;
    for (let column = 0; column < 1440; column++) {
        const i = row * 1440 + column;
        accumulated = (accumulated + (planar[i] | (planar[values + i] << 8))) & 0xffff;
        geoid[i] = (accumulated << 16) >> 16;
    }
}

test.each([[37.618806, -122.375417], [0, 0], [-33.9, 151.2], [85.05, 179.999999],
    [-85.05, -179.999999], [90, 0], [-90, 0], [37.5, -122.5], [21, 540], [-95, -540]])(
    "worker geoid interpolation exactly matches the original grid lookup at %s, %s", (lat, lon) => {
        expect(meanSeaLevelOffsetFromGrid(geoid, lat, lon)).toBe(referenceGeoid(Math.max(-90, Math.min(90, lat)), lon));
    });

test.each([6378137, 6356752.314245])(
    "scalar conversion preserves the configured Earth model with polar radius %s", polarRadius => {
        Globals.equatorRadius = 6378137;
        Globals.polarRadius = polarRadius;
        const output = new Float64Array(3);
        for (const [lat, lon, height] of [[37.618806, -122.375417, -31.125], [0, 180, 12.192],
            [89.999999999, -10, 500], [-89.999999999, 80, 10000], [-42.2, 20.5, 10000]]) {
            const radians = lat * Math.PI / 180;
            const ecef = RLLAToECEF_radii(radians, lon * Math.PI / 180, height);
            expect(ecefToGeodetic(ecef.x, ecef.y, ecef.z, 6378137, polarRadius, output)).toBe(output);
            expect(output[0]).toBeCloseTo(radians, 11);
            expect(output[1]).toBeCloseTo(lon * Math.PI / 180, 11);
            expect(output[2]).toBeCloseTo(height, 5);
        }
    });

test("scalar conversion retains the original iteration result for a highly flattened test Earth", () => {
    // Captured from the original ECEFToLLA_radii implementation. Its five
    // iterations deliberately remain unchanged by worker extraction.
    expect(ecefToGeodetic(-3191118.867135993, -5033170.722332089, 1152722.0543028866,
        6378137, 3189068.5)).toEqual([0.6565723544777853, -2.1358539501510414, 10000.663713240996]);
});

// The original scene-based path is the reference for matrix ordering,
// longitude wrapping, cell centres and Float32 publication.
function sceneProjection(input, {rect, size}) {
    return input.matrices.map(elements => {
        const matrix = new Matrix4().fromArray(elements), point = new Vector3();
        const vertices = new Float32Array(input.positions.length);
        let minHeight = Infinity, maxHeight = -Infinity;
        for (let i = 0; i < input.positions.length; i += 3) {
            point.fromArray(input.positions, i).applyMatrix4(matrix);
            const lla = ECEFToLLAVD_radii(point);
            let u = mercatorX(lla.y) - rect.u0;
            u -= Math.round(u - rect.du / 2);
            vertices[i] = u / rect.du * size - 0.5;
            vertices[i + 1] = (mercatorY(lla.x) - rect.v0) / rect.du * size - 0.5;
            const h = lla.z - referenceGeoid(Math.max(-90, Math.min(90, lla.x)), lla.y);
            vertices[i + 2] = h;
            minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h);
        }
        return {vertices, minHeight, maxHeight};
    });
}

test.each([[37.618806, -122.375417, 6356752.314245], [12.3, 179.99999, 6378137]])(
    "packed projection exactly matches the scene path at %s, %s", async (lat, lon, polarRadius) => {
        Globals.equatorRadius = 6378137;
        Globals.polarRadius = polarRadius;
        const origin = RLLAToECEF_radii(lat * Math.PI / 180, lon * Math.PI / 180, -30);
        const world = new Matrix4().makeTranslation(origin.x, origin.y, origin.z);
        const rotation = new Matrix4().makeRotationY(0.173);
        const input = {
            positions: new Float64Array([-122.123456789, 45.000000001, -3.25, 0, 0, 0,
                251.987654321, -362.000000001, 40.123456789]),
            matrices: [world.toArray(), world.clone().multiply(rotation).toArray()],
        };
        const options = {rect: {u0: mercatorX(lon) - 0.0001, v0: mercatorY(lat) - 0.0001, du: 0.0002},
            size: 2048, equatorRadius: 6378137, polarRadius, geoid};
        const positions = input.positions.slice(), matrices = input.matrices.map(m => m.slice());
        expect(await projectInundationMesh(input, options)).toEqual(sceneProjection(input, options));
        expect(input.positions).toEqual(positions);
        expect(input.matrices).toEqual(matrices);
    });

test("projection keeps double precision until writing the grid and checkpoints can cancel", async () => {
    const origin = 6378137 + 12.192;
    const input = {positions: new Float64Array([origin, 0, 0]), matrices: [new Matrix4().toArray()]};
    const options = {rect: {u0: 0.499, v0: 0.499, du: 0.002}, size: 64,
        equatorRadius: 6378137, polarRadius: 6378137, geoid: new Int16Array(values)};
    const projected = await projectInundationMesh(input, options);
    expect(projected[0].minHeight).toBeCloseTo(12.192, 8);
    expect(projected[0].minHeight).not.toBe(Math.fround(origin) - 6378137);

    const many = new Float64Array(8193 * 3);
    for (let i = 0; i < many.length; i += 3) many[i] = origin;
    const checkpoint = jest.fn(async () => { throw new Error("cancelled"); });
    await expect(projectInundationMesh({...input, positions: many}, options, checkpoint)).rejects.toThrow("cancelled");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(many.byteLength).toBe(8193 * 3 * 8);
});
