import {Vector3} from "three";
import {isPointOccludedByGlobe} from "../src/GlobeOcclusion";
import {isMeasurementOccluded} from "../src/MeasurementGeometry";
import {Globals} from "../src/Globals";

const R = 6378137;
const point = (x, y = 0, z = 0) => new Vector3(x, y, z);

test("finite sight lines keep near ground visible and hide the opposite side", () => {
    const camera = point(R + 1000);
    expect(isPointOccludedByGlobe(camera, point(R), R, R)).toBe(false);
    expect(isPointOccludedByGlobe(camera, point(-R), R, R)).toBe(true);
    expect(isPointOccludedByGlobe(camera, camera, R, R)).toBe(false);
    expect(isPointOccludedByGlobe(point(-2 * R, R), point(2 * R, R), R, R)).toBe(false);
    expect(isPointOccludedByGlobe(point(-2 * R, R - 10), point(2 * R, R - 10), R, R)).toBe(true);
});

test("ground endpoints below the ellipsoid do not hide the local scene", () => {
    expect(isPointOccludedByGlobe(point(R - 50), point(R + 1000), R, R)).toBe(false);
    expect(isPointOccludedByGlobe(point(R + 1000), point(R - 100), R, R)).toBe(false);
    expect(isPointOccludedByGlobe(point(R - 50), point(-R - 1000), R, R)).toBe(true);
});

test("the active polar radius determines whether a line passes above the globe", () => {
    const camera = point(2 * R, 0, R - 10000), target = point(-2 * R, 0, R - 10000);
    expect(isPointOccludedByGlobe(camera, target, R, 6356752.314245)).toBe(false);
    expect(isPointOccludedByGlobe(camera, target, R, R)).toBe(true);
});

test("both distance endpoints and V/B measurements obey the same per-view check", () => {
    const radius = Globals.equatorRadius;
    const A = point(radius + 500), B = point(radius + 1000);
    const camera = point(radius + 2000), otherCamera = point(-radius - 2000);
    for (const flags of [{isMeasurement: true}, {isVBMeasure: true}]) {
        const measurement = {...flags, A, B};
        expect(isMeasurementOccluded(measurement, camera)).toBe(false);
        expect(isMeasurementOccluded(measurement, otherCamera)).toBe(true);
        measurement.B = point(-radius);
        expect(isMeasurementOccluded(measurement, camera)).toBe(true);
    }
    expect(isMeasurementOccluded({position: point(-radius)}, camera)).toBe(false);
});
