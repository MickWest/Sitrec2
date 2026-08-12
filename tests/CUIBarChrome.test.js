/**
 * @jest-environment jsdom
 */

// A view's HUD companions (compass, OSD frame, video-info panel) are SIBLING divs stacked above
// the view by z-index, so they paint over its header — the header lives inside the view's own
// stacking context and cannot climb out. The fix is to clip out of each companion exactly what
// the header is already covering, and "exactly" is the whole point: an earlier version cut a
// full-width band down to the bottom of the open menu and blanked most of the MQ-9 OSD.
//
// hudClipPath is the geometry of that cut, so it is tested directly rather than through the DOM.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import {hudClipPath} from "../src/CUIBar";

// A look view at (1000, 400), 800x400, with a 26px header bar.
const BAR_BOTTOM = 426;
const closed = {left: 1000, barBottom: BAR_BOTTOM, bottom: BAR_BOTTOM, menuRight: 1000};
const open = {left: 1000, barBottom: BAR_BOTTOM, bottom: 826, menuRight: 1180};   // 180px x 400px menu

const box = (left, top, width, height) => ({left, top, right: left + width, bottom: top + height});

describe("hudClipPath", () => {
    test("a full-view companion loses only the bar strip while the menu is closed", () => {
        expect(hudClipPath(closed, box(1000, 400, 800, 400))).toBe("inset(26px 0 0 0)");
    });

    test("an open menu cuts a COLUMN, not a band — the rest of the HUD keeps drawing", () => {
        // The old full-width version returned inset(426px ...) here, hiding the entire OSD.
        expect(hudClipPath(open, box(1000, 400, 800, 400)))
            .toBe("polygon(180px 26px, 100% 26px, 100% 100%, 0 100%, 0 426px, 180px 426px)");
    });

    test("a companion clear of the chrome is not clipped at all", () => {
        // A corner compass low in the view, to the right of the menu column.
        expect(hudClipPath(open, box(1700, 750, 65, 65))).toBe("");
        expect(hudClipPath(closed, box(1000, 750, 65, 65))).toBe("");
    });

    test("a companion below the bar but under the open menu is cut from its own top", () => {
        // clip-path is box-relative, so the cut is measured from THIS box, not the view.
        // A bottom-left compass: 826 - 750 = 76px of it lies under the menu column.
        expect(hudClipPath(open, box(1000, 750, 65, 65)))
            .toBe("polygon(65px 0px, 100% 0px, 100% 100%, 0 100%, 0 76px, 65px 76px)");
    });

    test("a companion to the right of the menu column still loses the bar strip", () => {
        expect(hudClipPath(open, box(1400, 400, 400, 400))).toBe("inset(26px 0 0 0)");
    });
});
