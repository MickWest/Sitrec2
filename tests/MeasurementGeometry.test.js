import {Vector3} from "three";
import {Globals, setSit} from "../src/Globals";
import {LLAToECEF, wgs84} from "../src/LLA-ECEF-ENU";
import {
    isUnplacedMeasurePoint, MEASURE_MIN_SEPARATION, measurementCircleOffsets, measurementHeading, separatedMeasurePoint,
} from "../src/MeasurementGeometry";
import {altitudeHAE, getLocalEastVector, getLocalNorthVector, getLocalUpVector, setAltitudeHAE} from "../src/SphericalMath";

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

test("an end at the origin, NaN or null is not placed; a point on the Earth is", () => {
    expect(isUnplacedMeasurePoint(new Vector3(0, 0, 0))).toBe(true);
    expect(isUnplacedMeasurePoint(new Vector3(NaN, NaN, NaN))).toBe(true);
    expect(isUnplacedMeasurePoint(new Vector3(null, null, null))).toBe(true);
    expect(isUnplacedMeasurePoint(new Vector3(1, 0, 0))).toBe(false);
    expect(isUnplacedMeasurePoint(LLAToECEF(33, -118, 400))).toBe(false);
});

test("the origin has no geodetic altitude, which is why an unplaced end must not be projected", () => {
    expect(altitudeHAE(new Vector3(0, 0, 0))).toBeNaN();
    expect(altitudeHAE(LLAToECEF(33, -118, 400))).toBeCloseTo(400, 6);
});

test("a dragged end stops a foot short of the other end, and coincident ends separate eastward", () => {
    const fixed = LLAToECEF(33, -118, 400);
    const far = LLAToECEF(33.01, -118, 400);
    expect(separatedMeasurePoint(far, fixed).equals(far)).toBe(true);

    const near = fixed.clone().addScaledVector(getLocalNorthVector(fixed), 0.1);
    const pushed = separatedMeasurePoint(near, fixed);
    expect(pushed.distanceTo(fixed)).toBeCloseTo(MEASURE_MIN_SEPARATION, 6);
    expect(pushed.clone().sub(fixed).normalize().dot(getLocalNorthVector(fixed))).toBeCloseTo(1, 6);

    const placed = separatedMeasurePoint(fixed, fixed);
    expect(placed.distanceTo(fixed)).toBeCloseTo(MEASURE_MIN_SEPARATION, 6);
    expect(placed.clone().sub(fixed).normalize().dot(getLocalEastVector(fixed))).toBeCloseTo(1, 6);
    expect(measurementHeading(fixed, placed)).toBeCloseTo(90, 4);
    expect(measurementCircleOffsets(fixed, placed)).toHaveLength(256);
});

test("separation is horizontal: an end straight above the other moves a foot east and keeps its height", () => {
    const fixed = LLAToECEF(33, -118, 400);
    // Built the way the display moves an end to another altitude, along the ellipsoid normal.
    const above = setAltitudeHAE(fixed, 410);
    const pushed = separatedMeasurePoint(above, fixed);
    const up = getLocalUpVector(fixed);
    const offset = pushed.clone().sub(fixed);
    expect(offset.dot(up)).toBeCloseTo(10, 3);
    const horizontal = offset.clone().addScaledVector(up, -offset.dot(up));
    expect(horizontal.length()).toBeCloseTo(MEASURE_MIN_SEPARATION, 6);
    expect(horizontal.normalize().dot(getLocalEastVector(fixed))).toBeCloseTo(1, 6);
    // Drawn at one altitude, as the display does with both ends, they stay a foot apart.
    expect(setAltitudeHAE(pushed, 410).distanceTo(setAltitudeHAE(fixed, 410))).toBeCloseTo(MEASURE_MIN_SEPARATION, 3);
    // A slope: a foot along a 45-degree slope is only 0.7 ft horizontally, so it is pushed out.
    const slope = fixed.clone().addScaledVector(getLocalNorthVector(fixed), 0.2).addScaledVector(up, 0.2);
    const pushedSlope = separatedMeasurePoint(slope, fixed);
    const slopeOffset = pushedSlope.clone().sub(fixed);
    expect(slopeOffset.clone().addScaledVector(up, -slopeOffset.dot(up)).length()).toBeCloseTo(MEASURE_MIN_SEPARATION, 6);
    expect(slopeOffset.dot(up)).toBeCloseTo(0.2, 6);
});

test("coincident ends at either exact pole still separate by a foot, horizontally", () => {
    for (const sign of [1, -1]) {
        const pole = new Vector3(0, 0, sign * wgs84.POLAR_RADIUS);
        expect(getLocalEastVector(pole).length()).toBeLessThan(1e-6);
        const placed = separatedMeasurePoint(pole, pole);
        const offset = placed.clone().sub(pole);
        expect(offset.length()).toBeCloseTo(MEASURE_MIN_SEPARATION, 6);
        expect(Math.abs(offset.dot(getLocalUpVector(pole)))).toBeLessThan(1e-6);
        expect(measurementCircleOffsets(pole, placed)).toHaveLength(256);
    }
});

test("coincident or vertical endpoints do not invent a heading or circle", () => {
    const A = LLAToECEF(0, 0, 0);
    for (const B of [A, A.clone().add(new Vector3(50, 0, 0))]) {
        expect(measurementHeading(A, B)).toBeNull();
        expect(measurementCircleOffsets(A, B)).toEqual([]);
    }
});
