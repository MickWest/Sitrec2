/**
 * @jest-environment jsdom
 *
 * The big slider and elastic ranges.
 *
 * An elastic slider grows its range when the pointer goes PAST the end of the
 * track, so the growth budget is really the screen between the track and the edge
 * of the window. That is generous for the ~80px sliders in Sitrec's menus and all
 * but absent for the big slider's window-wide bar, which is why the bar resizes the
 * range on a hold timer from its end zones instead. These tests pin both halves:
 * the distance rule the menu sliders still use, and the timed rule that replaces it.
 */

import GUI from '../src/js/lil-gui.esm';
import {closeBigSlider, openBigSlider} from '../src/BigSlider';

jest.mock('../src/Globals', () => ({
    setRenderOne: jest.fn(),
    Globals: {},
}));

jest.mock('../src/showError', () => ({
    showError: jest.fn(),
}));

// jsdom has no pointer capture, and the drag code calls it on both ends.
for (const name of ['setPointerCapture', 'releasePointerCapture']) {
    if (!Element.prototype[name]) Element.prototype[name] = function () {};
}
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;

// lil-gui asks this to decide whether to use a numeric keyboard. Answer "desktop".
if (!window.matchMedia) window.matchMedia = () => ({matches: false, addListener() {}, removeListener() {}});

// jsdom has no PointerEvent either, and the whole popup is driven by them.
if (typeof PointerEvent === 'undefined') {
    global.PointerEvent = class extends MouseEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? 'mouse';
            this.isPrimary = init.isPrimary !== false;
        }
    };
}

// Geometry of the two sliders, measured in a real 1900px-wide Sitrec window.
const MENU_SLIDER = {left: 550, right: 629};        //   79px wide, 1271px of room right
const BIG_TRACK = {left: 48, right: 1852};          // 1804px wide,   48px of room right
const WINDOW_WIDTH = 1900;

// Must match ZONE_PX in src/BigSlider.js.
const ZONE_PX = 60;

function stubRect(element, {left, right}) {
    element.getBoundingClientRect = () => ({
        left, right, top: 0, bottom: 54, width: right - left, height: 54, x: left, y: 0,
    });
}

// A number controller with a real elastic range: 1..200, allowed to stretch to
// 100000 and to shrink to 50. These are the numbers on "35mm Equiv (mm)" in the
// camera menu, which is one of the eighteen elastic sliders in Sitrec.
function makeElasticController() {
    const controller = new GUI().add({focalLength: 50}, 'focalLength', 1, 200, 0.1)
        .elastic(50, 100000);
    stubRect(controller.$slider, MENU_SLIDER);
    return controller;
}

describe('elastic growth by pointer distance (what the menu sliders use)', () => {

    it('doubles repeatedly when there is screen beyond the track', () => {
        const controller = makeElasticController();

        controller._dragStart(MENU_SLIDER.right - 5);
        controller._dragMove(WINDOW_WIDTH);     // 1271px past a 79px track

        // The pointer maps to ~3400 on the frozen 1..200 range, so the loop doubles
        // 200 -> 400 -> ... -> 6400, which is the first max above it.
        expect(controller._max).toBe(6400);
    });

    it('manages only ONE doubling on a window-wide track - the reported bug', () => {
        const controller = makeElasticController();
        stubRect(controller.$slider, BIG_TRACK);

        controller._dragStart(BIG_TRACK.right - 5);
        controller._dragMove(WINDOW_WIDTH);     // all 48px of gutter there is

        // The pointer maps to only ~205, so one doubling and then nothing.
        expect(controller._max).toBe(400);
        expect(controller.getValue()).toBeLessThan(210);
    });

    it('leaves the range alone when the caller passes allowElasticRange = false', () => {
        const controller = makeElasticController();

        controller._dragStart(MENU_SLIDER.right - 5, controller.$slider, false);
        controller._dragMove(WINDOW_WIDTH, controller.$slider, false);

        expect(controller._max).toBe(200);
    });
});

describe('_elasticStepRange', () => {

    it('doubles to _elasticMax, then reports that it can do no more', () => {
        const controller = makeElasticController();
        const reached = [];
        while (controller._elasticStepRange(true)) reached.push(controller._max);

        expect(reached).toEqual([400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 100000]);
        expect(controller._elasticStepRange(true)).toBe(false);
    });

    it('halves to _elasticMin, then reports that it can do no more', () => {
        const controller = makeElasticController();
        const reached = [];
        while (controller._elasticStepRange(false)) reached.push(controller._max);

        expect(reached).toEqual([100, 50]);
        expect(controller._elasticStepRange(false)).toBe(false);
    });

    it('re-seeds _maxClick, so the new headroom is actually reachable', () => {
        const controller = makeElasticController();
        controller._dragStart(MENU_SLIDER.left, controller.$slider, false);
        expect(controller._maxClick).toBe(200);

        controller._elasticStepRange(true);
        expect(controller._maxClick).toBe(400);

        // Without the re-seed the drag would still map onto 1..200, and the value
        // could never pass 200 whatever the range said.
        controller._setValueFromX(MENU_SLIDER.right, false, controller.$slider, false);
        expect(controller.getValue()).toBeCloseTo(400, 0);
    });

    it('does nothing to a slider that is not elastic', () => {
        const controller = new GUI().add({x: 5}, 'x', 0, 10, 0.1);

        expect(controller._elasticStepRange(true)).toBe(false);
        expect(controller._max).toBe(10);
    });
});

describe('the big slider bar', () => {
    let clock;
    let frames;

    beforeEach(() => {
        // Own both the clock and the animation frame, so a hold can be stepped by
        // hand instead of waited out.
        clock = 0;
        frames = [];
        jest.spyOn(performance, 'now').mockImplementation(() => clock);
        window.requestAnimationFrame = cb => frames.push(cb);
        window.cancelAnimationFrame = jest.fn();
    });

    afterEach(() => {
        closeBigSlider();
        jest.restoreAllMocks();
        document.body.innerHTML = '';
    });

    // Run one animation frame at a chosen point on the clock.
    function frameAt(ms) {
        clock = ms;
        for (const cb of frames.splice(0, frames.length)) cb();
    }

    function openOnBigBar(controller) {
        openBigSlider(controller);
        const track = document.querySelector('.sitrec-bigslider-track');
        stubRect(track, BIG_TRACK);
        return track;
    }

    // The popup listens at the window in the capture phase, so a press dispatched on
    // the track reaches it with the track as the target, exactly as a real one does.
    function pressOn(track, clientX) {
        track.dispatchEvent(new PointerEvent('pointerdown', {
            clientX, bubbles: true, pointerId: 1,
        }));
    }

    function release() {
        window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 1}));
    }

    it('gives an elastic slider end zones, and a plain one none', () => {
        openOnBigBar(makeElasticController());
        expect(document.querySelectorAll('.sitrec-bigslider-zone')).toHaveLength(2);
        closeBigSlider();

        const plain = new GUI().add({x: 5}, 'x', 0, 10, 0.1);
        stubRect(plain.$slider, MENU_SLIDER);
        openOnBigBar(plain);
        expect(document.querySelectorAll('.sitrec-bigslider-zone')).toHaveLength(0);
    });

    it('grows the range while a drag is held in the right-hand zone', () => {
        const controller = makeElasticController();
        const track = openOnBigBar(controller);

        pressOn(track, BIG_TRACK.right - ZONE_PX / 2);

        frameAt(0);
        expect(controller._max).toBe(200);      // still inside the first-step wait

        frameAt(500);                           // past ZONE_FIRST_STEP_MS
        expect(controller._max).toBe(400);

        frameAt(900);                           // one ZONE_STEP_MS later
        expect(controller._max).toBe(800);

        // The value rides the top of the range rather than being left behind by it.
        expect(controller.getValue()).toBeGreaterThan(700);
    });

    it('shrinks the range while a drag is held in the left-hand zone', () => {
        const controller = makeElasticController();
        const track = openOnBigBar(controller);

        pressOn(track, BIG_TRACK.left + ZONE_PX / 2);

        frameAt(500);
        expect(controller._max).toBe(100);
        frameAt(900);
        expect(controller._max).toBe(50);       // _elasticMin
        frameAt(1300);
        expect(controller._max).toBe(50);       // and no lower
    });

    it('leaves the range alone for a drag held in the middle of the bar', () => {
        const controller = makeElasticController();
        const track = openOnBigBar(controller);

        pressOn(track, (BIG_TRACK.left + BIG_TRACK.right) / 2);

        frameAt(500);
        frameAt(2000);
        expect(controller._max).toBe(200);
    });

    it('stops resizing once the drag ends', () => {
        const controller = makeElasticController();
        const track = openOnBigBar(controller);

        pressOn(track, BIG_TRACK.right - ZONE_PX / 2);
        frameAt(500);
        expect(controller._max).toBe(400);

        release();
        frameAt(2000);
        expect(controller._max).toBe(400);
    });

    it('marks the zone the drag is being held in', () => {
        const controller = makeElasticController();
        const track = openOnBigBar(controller);
        const high = track.querySelector('.sitrec-bigslider-zone.high');
        const low = track.querySelector('.sitrec-bigslider-zone.low');

        pressOn(track, BIG_TRACK.right - ZONE_PX / 2);
        expect(high.classList.contains('active')).toBe(true);
        expect(low.classList.contains('active')).toBe(false);

        release();
        expect(high.classList.contains('active')).toBe(false);
    });
});
