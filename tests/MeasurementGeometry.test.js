import {Vector3} from "three";
import {Globals, setSit} from "../src/Globals";
import {LLAToECEF, wgs84} from "../src/LLA-ECEF-ENU";
import {measurementCircleOffsets, measurementHeading} from "../src/MeasurementGeometry";

beforeAll(() => {
    setSit({lat: 33, lon: -118});
    Globals.equatorRadius = wgs84.RADIUS;
    Globals.polarRadius = wgs84.POLAR_RADIUS;
});

test.each([
    [1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270], [1, -1, 315],
])("true heading for north/east components %s/%s is %s", (north, east, expected) => {
    const A = LLAToECEF(0, 0, 0);
    const B = A.clone().add(new Vector3(0, east, north));
    expect(measurementHeading(A, B)).toBeCloseTo(expected, 8);
});

test("north follows the local meridian away from the equator", () => {
    const heading = measurementHeading(LLAToECEF(33, -118, 400), LLAToECEF(34, -118, 400));
    expect(Math.min(heading, 360 - heading)).toBeLessThan(1e-8);
});

test("circle is centered on V, has the displayed radius, and contains B", () => {
    const A = LLAToECEF(33, -118, 400);
    const B = LLAToECEF(33.02, -117.98, 400);
    const points = measurementCircleOffsets(A, B);
    expect(points).toHaveLength(256);
    expect(points[0].clone().add(A).distanceTo(B)).toBeLessThan(1e-8);
    const center = new Vector3();
    for (const point of points) {
        expect(point.length()).toBeCloseTo(A.distanceTo(B), 7);
        center.add(point);
    }
    expect(center.divideScalar(points.length).length()).toBeLessThan(1e-8);
});

test("coincident or vertical endpoints do not invent a heading or circle", () => {
    const A = LLAToECEF(0, 0, 0);
    for (const B of [A, A.clone().add(new Vector3(50, 0, 0))]) {
        expect(measurementHeading(A, B)).toBeNull();
        expect(measurementCircleOffsets(A, B)).toEqual([]);
    }
});
