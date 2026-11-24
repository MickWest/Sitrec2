jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}, NodeMan: {}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: (lat, lon) =>
    -32 + 7 * Math.sin(lat * Math.PI / 180) + 3 * Math.cos(lon * Math.PI / 180)}));
jest.mock("../src/water/SeaLevelMaterial", () => ({createSeaLevelMaterial: () =>
    new (require("three").MeshBasicMaterial)({side: require("three").DoubleSide})}));

import {SeaLevelGeometry, SeaLevelSurface, seaLevelPlane, seaLevelPoint} from "../src/water/SeaLevelSurface";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../src/EGM96Geoid";
import {BoxGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3} from "three";
import {Globals} from "../src/Globals";

const fortyFeet = 40 * 0.3048;

test.each([[34, -118], [51.5, 0], [-33, 179.99], [89.99, 23]])(
    "40 ft surface vertices and triangle interiors follow MSL within 1 cm at %s, %s", (lat, lon) => {
        const geometry = new SeaLevelGeometry(lat, lon, 40000);
        geometry.setLevel(fortyFeet);
        const position = geometry.attributes.position;
        const checkHeight = point => {
            const lla = ECEFToLLAVD_radii(point.add(geometry.origin));
            expect(Math.abs(lla.z - meanSeaLevelOffset(lla.x, lla.y) - fortyFeet)).toBeLessThan(0.01);
        };
        for (let i = 0; i < position.count; i += 317) {
            checkHeight(new Vector3().fromBufferAttribute(position, i));
        }
        const indices = geometry.index.array;
        for (let i = 0; i < indices.length; i += 951) {
            const a = new Vector3().fromBufferAttribute(position, indices[i]);
            const b = new Vector3().fromBufferAttribute(position, indices[i + 1]);
            const c = new Vector3().fromBufferAttribute(position, indices[i + 2]);
            checkHeight(a.add(b).add(c).divideScalar(3));
        }
        geometry.dispose();
    });

test("water crosses a building at its specified level without a terrain or shoreline mask", () => {
    const surface = new SeaLevelSurface();
    surface.updateSurface(0, 0, 1000, fortyFeet);
    surface.updateMatrixWorld(true);
    const ground = seaLevelPoint(0, 0);
    // At the equator ECEF x is vertical. A 20 m building is 10 m wide.
    const building = new Mesh(new BoxGeometry(20, 10, 10), new MeshBasicMaterial());
    building.position.copy(ground).add(new Vector3(10, 0, 0));
    building.updateMatrixWorld(true);
    const down = new Vector3(-1, 0, 0);
    const ray = new Raycaster(ground.clone().add(new Vector3(50, 0, 0)), down);
    ray.layers.enableAll();
    expect(ray.intersectObjects([surface, building])[0].object).toBe(building);
    ray.ray.origin.z = 8; // just outside the wall
    const hit = ray.intersectObjects([surface, building])[0];
    expect(hit.object).toBe(surface.mesh);
    expect(hit.point.x - ground.x).toBeCloseTo(fortyFeet, 2);
    surface.updateSurface(0, 0, 1000, 25);
    surface.updateMatrixWorld(true);
    ray.ray.origin.z = 0;
    expect(ray.intersectObjects([surface, building])[0].object).toBe(surface.mesh);
    surface.dispose();
    building.geometry.dispose();
    building.material.dispose();
});

test("level changes retain geometry, update bounds and reflection datum; large moves rebuild coverage", () => {
    const surface = new SeaLevelSurface();
    surface.updateSurface(34, -118, 4000, 0);
    const geometry = surface.mesh.geometry;
    const originalRadius = geometry.boundingSphere.radius;
    const dispose = jest.spyOn(geometry, "dispose");
    surface.updateSurface(34, -118, 4000, fortyFeet + 1.5);
    expect(surface.mesh.geometry).toBe(geometry);
    expect(geometry.boundingSphere.radius).not.toBe(originalRadius);
    const plane = surface.reflectionPlane(LLAToECEF(34, -118, 100));
    expect(plane.altitude).toBeCloseTo(meanSeaLevelOffset(34, -118) + fortyFeet + 1.5, 8);
    expect(plane.point.distanceTo(seaLevelPoint(34, -118, fortyFeet + 1.5))).toBeLessThan(1e-6);
    surface.updateSurface(35, -118, 4000, fortyFeet);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(surface.mesh.geometry).not.toBe(geometry);
    surface.dispose();
});

test("the same surface works with the legacy spherical earth", () => {
    const polarRadius = Globals.polarRadius;
    try {
        Globals.polarRadius = Globals.equatorRadius;
        const plane = seaLevelPlane(LLAToECEF(48, 12, 100), fortyFeet);
        expect(plane.point.length() - Globals.equatorRadius)
            .toBeCloseTo(meanSeaLevelOffset(48, 12) + fortyFeet, 6);
    } finally {
        Globals.polarRadius = polarRadius;
    }
});
