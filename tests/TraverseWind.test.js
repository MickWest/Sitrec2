import {solvedHorizontalWindAt} from "../src/TraverseWind";

describe("Traverse solved-wind reconstruction", () => {
    const solved = {
        windE: 7.5, windN: 8,
        windDriftE: 6, windDriftN: 12,
        windCurveE: -4, windCurveN: -10,
        shearPerM: 0.001,
    };

    test("includes the fitted quadratic at start, midpoint, and end", () => {
        expect(solvedHorizontalWindAt(solved, {normalizedTime: 0, altitudeM: 1000,
            referenceAltitudeM: 1000})).toMatchObject({u: 7.5, v: 8});
        expect(solvedHorizontalWindAt(solved, {normalizedTime: 0.5, altitudeM: 1000,
            referenceAltitudeM: 1000})).toMatchObject({u: 9.5, v: 11.5});
        expect(solvedHorizontalWindAt(solved, {normalizedTime: 1, altitudeM: 1000,
            referenceAltitudeM: 1000})).toMatchObject({u: 9.5, v: 10});
    });

    test("applies the same clamped altitude-shear multiplier as the lantern model", () => {
        expect(solvedHorizontalWindAt(solved, {normalizedTime: 0, altitudeM: 1200,
            referenceAltitudeM: 1000})).toMatchObject({u: 9, v: 9.6, multiplier: 1.2});
        expect(solvedHorizontalWindAt({...solved, shearPerM: -1}, {
            normalizedTime: 0, altitudeM: 1200, referenceAltitudeM: 1000,
        })).toMatchObject({u: 1.875, v: 2, multiplier: 0.25});
    });

    test("quadcopter wind remains constant and ignores lantern-only terms", () => {
        expect(solvedHorizontalWindAt(solved, {modelKind: "quadcopter", normalizedTime: 1,
            altitudeM: 5000, referenceAltitudeM: 1000})).toMatchObject({u: 7.5, v: 8});
    });
});
