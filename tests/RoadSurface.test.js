import {BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Vector3} from "three";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalNorthVector, getLocalUpVector} from "../src/SphericalMath";
import {RoadProfile, sampleRoadPath} from "../src/RoadProfile";
import {originalRoadGeometry, restoreRoadGeometry, smoothRoadGeometry} from "../src/RoadGeometry";
import {setSit} from "../src/Globals";

setSit({lat: 35, lon: -88});
const origin = LLAToECEF(35, -88, 150);
const up = getLocalUpVector(origin), north = getLocalNorthVector(origin), east = north.clone().cross(up);
const point = (x, y, z) => origin.clone().addScaledVector(east, x).addScaledVector(north, y).addScaledVector(up, z);

test("spatial road smoothing retains a grade through both endpoints and removes polygon pitch steps", () => {
    const points = Array.from({length: 101}, (_, i) => point(i, 0, i * 0.1));
    const profile = new RoadProfile(points, 20);
    for (const x of [0, 0.5, 30, 99.5, 100]) expect(profile.at(point(x, 0, 0)).height).toBeCloseTo(x * 0.1, 6);
    const rough = new RoadProfile(points.map((p, i) => p.clone().addScaledVector(up, Math.abs(i % 8 - 4) * 0.3)), 20);
    let maxPitchChange = 0;
    let previous;
    for (let x = 1; x < 99; x += 0.1) {
        const grade = (rough.at(point(x + 0.05, 0, 0)).height - rough.at(point(x - 0.05, 0, 0)).height) / 0.1;
        if (previous !== undefined) maxPitchChange = Math.max(maxPitchChange, Math.abs(grade - previous));
        previous = grade;
    }
    expect(maxPitchChange).toBeLessThan(0.002);
});

test("resampling ignores stopped frames and retains the endpoint", () => {
    const samples = sampleRoadPath([point(0, 0, 0), point(0, 0, 0), point(10.5, 0, 0)], 2);
    expect(samples).toHaveLength(7);
    expect(samples[6].distanceTo(point(10.5, 0, 0))).toBeLessThan(1e-6);
    expect(samples[3].distanceTo(point(6, 0, 0))).toBeLessThan(1e-6);
});

test("road deformation subdivides textured ground, matches the profile, and restores exact geometry", () => {
    const profile = new RoadProfile(Array.from({length: 21}, (_, i) => point(i, 0, Math.sin(i / 5))), 8, 8);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, -5, 0, 20, -5, 0, 20, 5, 0, 0, 5, 0], 3));
    geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(east, north, up).setPosition(origin);
    mesh.updateMatrixWorld(true);
    expect(smoothRoadGeometry(mesh, [profile])).toBe(true);
    expect(mesh.geometry.attributes.position.count).toBeGreaterThan(4);
    expect(mesh.geometry.attributes.uv.count).toBe(mesh.geometry.attributes.position.count);
    const vertex = new Vector3();
    let centralVertices = 0;
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
        vertex.fromBufferAttribute(mesh.geometry.attributes.position, i).applyMatrix4(mesh.matrixWorld);
        const sample = profile.at(vertex);
        if (sample?.distance < 4) {
            centralVertices++;
            expect(sample.z).toBeCloseTo(sample.height, 5);
        }
    }
    expect(centralVertices).toBeGreaterThan(20);
    expect(originalRoadGeometry(mesh)).toBe(geometry);
    restoreRoadGeometry(mesh);
    expect(mesh.geometry).toBe(geometry);
    expect(geometry.attributes.position.count).toBe(4);
});

test("roads leave distant geometry and roofs untouched", () => {
    const profile = new RoadProfile([point(0, 0, 0), point(100, 0, 0)], 20, 8);
    for (const [y, z] of [[50, 0], [0, 20]]) {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute([0, y, z, 10, y, z, 0, y + 1, z], 3));
        const mesh = new Mesh(geometry, new MeshBasicMaterial());
        mesh.matrixAutoUpdate = false;
        mesh.matrix.makeBasis(east, north, up).setPosition(origin);
        mesh.updateMatrixWorld(true);
        expect(smoothRoadGeometry(mesh, [profile])).toBe(false);
        expect(mesh.geometry).toBe(geometry);
    }
});

test("subdivision splits both sides of a non-indexed texture seam", () => {
    const profile = new RoadProfile([point(0, 0, 0), point(20, 0, 0)], 20, 8);
    const geometry = new BufferGeometry();
    // The first face reaches the road. The second is entirely outside it. Their
    // duplicated edge at y=10 must acquire matching vertices on both sides.
    geometry.setAttribute("position", new Float32BufferAttribute([
        0, 10, 0, 20, 10, 0, 10, 0, 0,
        20, 10, 0, 0, 10, 0, 10, 20, 0,
    ], 3));
    geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, .5, 1, 1, 1, 0, 1, .5, 2], 2));
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(east, north, up).setPosition(origin);
    mesh.updateMatrixWorld(true);
    smoothRoadGeometry(mesh, [profile]);
    const sides = [new Set(), new Set()];
    const p = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
    for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getY(i) - 10) < 1e-5) sides[uv.getY(i) < .5 ? 0 : 1].add(p.getX(i).toFixed(4));
    }
    expect(sides[0].size).toBeGreaterThan(2);
    expect([...sides[0]].sort()).toEqual([...sides[1]].sort());
    restoreRoadGeometry(mesh);
});
