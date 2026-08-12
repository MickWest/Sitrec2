// "Show it in the main view but not the look view" is one bit, not the obvious one. MASK_WORLD
// and MASK_TARGET are in BOTH render masks, so MASK_MAINRENDER — which reads like "the main
// render" — is tested true by the LOOK camera as well. The equatorial grid used exactly that and
// so could not be shown in main alone.
import {
    MASK_LOOKRENDER,
    MASK_MAINRENDER,
    perViewLayerMask,
} from "../src/LayerMasks";

const shownIn = (cameraMask, objectMask) => (cameraMask & objectMask) !== 0;

describe("perViewLayerMask", () => {
    test.each([
        ["main only", true, false, true, false],
        ["look only", false, true, false, true],
        ["both", true, true, true, true],
        ["neither", false, false, false, false],
    ])("%s", (label, inMain, inLook, expectMain, expectLook) => {
        const mask = perViewLayerMask(inMain, inLook);
        expect(shownIn(MASK_MAINRENDER, mask)).toBe(expectMain);
        expect(shownIn(MASK_LOOKRENDER, mask)).toBe(expectLook);
    });

    test("neither view selected yields an empty mask, so .visible can be cleared from it", () => {
        expect(perViewLayerMask(false, false)).toBe(0);
    });
});
