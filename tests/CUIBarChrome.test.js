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

import "../src/lil-gui-extras";      // installs GUI.addMirror, which the icons go through
import {CUIBar, hudClipPath} from "../src/CUIBar";

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

// --- isBlankAt --------------------------------------------------------------------------------
//
// Double-clicking the header strip fullscreens the view. That has to stop at the things ON the
// strip: the view's menu tab, its toggle icons, the pin and the close button all do something
// else, and a fullscreen fired underneath them is a click the user did not ask for. The
// fullscreen icon is the exception — it toggles fullscreen anyway.
//
// jsdom lays nothing out, so the rects are stubbed: this is testing the hit rule, not a browser.

describe("isBlankAt", () => {
    let host, bar;

    // Place an element at [x, x+width) across the full 26px height of the strip.
    const place = (el, x, width) => {
        el.getBoundingClientRect = () => ({left: x, right: x + width, top: 0, bottom: 26,
                                           x, y: 0, width, height: 26});
    };

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        bar = new CUIBar(host, {title: "Main"});
        place(bar.bar, 0, 600);
        place(bar.left, 0, 75);
        place(bar.titleMenu.domElement.parentElement, 0, 50);      // the menu SLOT
        place(bar.addControlIcon("view:mainView:labels", {html: "L", action: "icon-labels"}), 54, 21);
        place(bar.addIcon("⛶", () => {}, "Toggle fullscreen", "fullscreen"), 560, 20);
        place(bar.addPinIcon(() => {}), 580, 20);
    });

    afterEach(() => { bar.dispose(); host.remove(); });

    test("the empty middle of the strip is blank", () => {
        expect(bar.isBlankAt(300, 13)).toBe(true);
    });

    test("the menu tab, a toggle icon and the pin are not", () => {
        expect(bar.isBlankAt(25, 13)).toBe(false);      // "Main"
        expect(bar.isBlankAt(60, 13)).toBe(false);      // the Labels icon
        expect(bar.isBlankAt(590, 13)).toBe(false);     // 📌
    });

    test("the fullscreen icon counts as blank — it does the same thing", () => {
        expect(bar.isBlankAt(570, 13)).toBe(true);
    });

    test("a point off the strip is not on it", () => {
        expect(bar.isBlankAt(300, 40)).toBe(false);
        expect(bar.isBlankAt(700, 13)).toBe(false);
    });

    // A narrow view cannot fit a dozen toggle icons. Something has to give, and it must not be
    // the close button: the icons clip, the window chrome does not move.
    test("the icons clip; the window chrome keeps its place", () => {
        expect(getComputedStyle(bar.leftIcons).overflow).toBe("hidden");
        expect(bar.leftIcons.style.flex).toBe("0 1 auto");
        expect(bar.right.style.flex).toBe("0 0 auto");
        // …and not `left` itself, which the title menu's dropdown hangs out of.
        expect(getComputedStyle(bar.left).overflow).not.toBe("hidden");
    });

    // An icon whose control this sitch does not have is display:none, and a browser measures
    // that as 0x0 at the PAGE ORIGIN — not at the place it would have occupied. Counted, it
    // would quietly claim the top-left pixel of any view docked at (0, 0).
    test("a hidden icon reserves nothing, at the origin or anywhere else", () => {
        const ghost = bar.addControlIcon("view:mainView:nothingRegistersThis", {html: "?"});
        expect(ghost.style.display).toBe("none");
        // A collapsed rect is a POINT, so without the guard it would still claim the pixel it
        // collapsed onto — the page origin in a browser, here the middle of the strip.
        ghost.getBoundingClientRect = () => ({left: 300, right: 300, top: 13, bottom: 13,
                                              x: 300, y: 13, width: 0, height: 0});
        expect(bar.isBlankAt(300, 13)).toBe(true);
    });
});
