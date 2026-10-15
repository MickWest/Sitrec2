import {penumbraFade, shadowOcclusion} from "../tools/shf/flarePhysics.js";

const a = 6378137, b = 6356752.314245;
const toSun = {x: 1, y: 0, z: 0};

describe("satellite shadow for the selected Earth shape", () => {
    test("an equatorial grazing ray can miss the polar sphere but hit the ellipsoid", () => {
        const pos = {x: -7000000, y: 6370000, z: 0};
        expect(shadowOcclusion(pos, toSun, b)).toBe(-1);
        expect(shadowOcclusion(pos, toSun, a, b)).toBeCloseTo(8137, 5);
        expect(penumbraFade(shadowOcclusion(pos, toSun, a, b), 5000)).toBe(0);
    });

    test("polar grazing uses the smaller polar axis", () => {
        const pos = {x: -7000000, y: 0, z: 6370000};
        expect(shadowOcclusion(pos, toSun, a, b)).toBe(-1);
        expect(shadowOcclusion(pos, toSun, a)).toBeCloseTo(8137, 5);
    });

    test("a ray pointing away from Earth remains lit", () => {
        expect(shadowOcclusion({x: 7000000, y: 6370000, z: 0}, toSun, a, b)).toBe(-1);
    });

    test("partial shadow produces fractional flux instead of a lit boolean", () => {
        const pos = {x: -7000000, y: a - 2000, z: 0};
        const depth = shadowOcclusion(pos, toSun, a, b);
        expect(depth).toBeCloseTo(2000, 5);
        expect(penumbraFade(depth, 5000)).toBeCloseTo(.6, 10);
    });

    test("equal axes preserve the spherical result", () => {
        const pos = {x: -7000000, y: a - 2000, z: 0};
        expect(shadowOcclusion(pos, toSun, a, a)).toBe(shadowOcclusion(pos, toSun, a));
    });
});
