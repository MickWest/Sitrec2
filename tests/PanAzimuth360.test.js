/**
 * @jest-environment jsdom
 *
 * Pan (Az): one angle, two spellings.
 *
 * An azimuth is an angle on a circle, so 270 and -90 name the same direction.
 * Sitrec stores the signed one, -180..180, everywhere - so that nothing which
 * compares, differences or fits azimuths has to ask which convention a number
 * arrived in - and the "Use 0-360 for Pan" checkbox changes only how the Pan (Az)
 * slider WRITES that stored angle.
 *
 * These tests drive the real controller through a real lil-gui folder, because the
 * interesting half of the feature is the wiring rather than the arithmetic: a typed
 * value outside the slider's range would normally be clamped at the end of the track
 * and never reach the property at all, which is exactly what typing 270 into a
 * -180..180 slider has to survive.
 */

import GUI, {Controller} from '../src/js/lil-gui.esm';
import '../src/MenuMirror';        // installs Controller.mirrorTo / GUI.mirrorFolderFrom
import {azTo360, normalizeAzSigned} from '../src/mathUtils';

// The node system is reached through Globals, which the app fills in at startup.
// A dictionary-backed NodeMan is all this controller needs from it.
jest.mock('../src/Globals', () => {
    const nodes = {};
    return {
        NodeMan: {
            add: (id, node) => { nodes[id] = node; return node; },
            get: (id) => nodes[id] ?? null,
            exists: (id) => Object.prototype.hasOwnProperty.call(nodes, id),
            list: nodes,
        },
        guiMenus: {},          // no cameraFOV/cameraTweaks shells: everything lands in the folder we pass
        Sit: {frames: 100, fps: 30},
        Globals: {},
        setRenderOne: () => {},
        infoDiv: null,
        SitchMan: {},
    };
});

jest.mock('../src/showError', () => ({showError: jest.fn()}));

// lil-gui asks this to decide whether to use a numeric keyboard. Answer "desktop".
if (!window.matchMedia) window.matchMedia = () => ({matches: false, addListener() {}, removeListener() {}});

// tooltip() and setLabelColor() are Sitrec's own prototype patches, installed by
// importing lil-gui-extras - a module that drags in most of the menu bar. The
// controller only chains them, so stubs are enough to build one here.
if (!Controller.prototype.tooltip) Controller.prototype.tooltip = function () { return this; };
if (!Controller.prototype.setLabelColor) Controller.prototype.setLabelColor = function () { return this; };

const {CNodeControllerPTZUI} = require('../src/nodes/CNodeControllerPTZUI');

let idCounter = 0;

/** A real PTZ controller with its real GUI, built the way SituationSetup builds one. */
function makePTZ(v = {}) {
    const gui = new GUI({autoPlace: false});
    const ptz = new CNodeControllerPTZUI({
        id: "testPTZ" + (idCounter++),
        az: 0, el: 0, fov: 30, roll: 0,
        showGUI: true, gui,
        ...v,
    });
    return {ptz, gui, pan: ptz.azController};
}

/** Type into a controller's number box, as a user would. */
function typeInto(controller, text) {
    controller.$input.value = String(text);
    controller.$input.dispatchEvent(new Event('input'));
}

/** Press an arrow key in that box. */
function pressArrow(controller, code) {
    controller.$input.dispatchEvent(new KeyboardEvent('keydown', {code, bubbles: true}));
}

describe("the signed/compass conversion", () => {

    test("folds any spelling to signed, leaving both endpoints alone", () => {
        expect(normalizeAzSigned(270)).toBe(-90);
        expect(normalizeAzSigned(-270)).toBe(90);
        expect(normalizeAzSigned(630)).toBe(-90);      // a full turn further round
        expect(normalizeAzSigned(0)).toBe(0);
        expect(normalizeAzSigned(179.999)).toBe(179.999);
        // 180 and -180 are the same direction. Snapping one onto the other would make a
        // slider jump end to end the instant a drag reached it, so both stay put.
        expect(normalizeAzSigned(180)).toBe(180);
        expect(normalizeAzSigned(-180)).toBe(-180);
    });

    test("the round trip is exact, not 359.98999999999995", () => {
        expect(azTo360(-0.01)).toBe(359.99);
        expect(normalizeAzSigned(359.99)).toBe(-0.01);
        expect(azTo360(normalizeAzSigned(359.99))).toBe(359.99);
        expect(azTo360(270)).toBe(270);
        expect(azTo360(-90)).toBe(270);
        expect(azTo360(0)).toBe(0);
    });
});

describe("the stored azimuth", () => {

    test("is signed no matter who writes it", () => {
        const {ptz} = makePTZ();
        // An EXIF heading and the AR compass both arrive as 0..360.
        ptz.az = 270;
        expect(ptz.az).toBe(-90);
        ptz.az = 200;
        expect(ptz.az).toBe(-160);
        // A file-driven azimuth can accumulate past a full turn.
        ptz.az = 630;
        expect(ptz.az).toBe(-90);
        ptz.az = -270;
        expect(ptz.az).toBe(90);
        // Anything already signed is left exactly as it was.
        ptz.az = -179.5;
        expect(ptz.az).toBe(-179.5);
    });

    test("does not move when the convention is switched", () => {
        const {ptz, pan} = makePTZ();
        ptz.az = -90;
        ptz.pan360 = true;                 // what the checkbox's onChange does
        ptz.updatePanRange();
        expect(ptz.az).toBe(-90);          // the camera has not turned
        expect(ptz.panDisplay).toBe(270);  // it is only spelled differently
        expect(pan._min).toBe(0);
        expect(pan._max).toBe(360);

        ptz.pan360 = false;
        ptz.updatePanRange();
        expect(ptz.az).toBe(-90);
        expect(ptz.panDisplay).toBe(-90);
        expect(pan._min).toBe(-180);
        expect(pan._max).toBe(180);
    });
});

describe("the Pan slider", () => {

    test("starts signed, and shows the stored angle", () => {
        const {ptz, pan} = makePTZ({az: -90});
        expect(ptz.pan360).toBe(false);
        expect(pan._min).toBe(-180);
        expect(pan._max).toBe(180);
        expect(pan.$input.value).toBe("-90");
    });

    test("typing a value above 180 ticks the box and KEEPS the value", () => {
        const {ptz, pan} = makePTZ();
        typeInto(pan, 270);

        expect(ptz.pan360).toBe(true);       // the box ticked itself
        expect(ptz.panDisplay).toBe(270);    // 270 stayed 270
        expect(pan.$input.value).toBe("270");
        expect(ptz.az).toBe(-90);            // and internally it is the same direction
        // The range moved with it, so the knob sits three-quarters along rather than
        // pinned past the end of a track it no longer fits on.
        expect(pan._min).toBe(0);
        expect(pan._max).toBe(360);
        expect(pan._fillPercent()).toBeCloseTo(0.75, 6);
    });

    test("typing a negative into a 0-360 slider wraps it, and leaves the box ticked", () => {
        const {ptz, pan} = makePTZ();
        ptz.pan360 = true;
        ptz.updatePanRange();

        typeInto(pan, -90);

        // -90 IS representable in this convention, so it is shown as 270 rather than
        // silently undoing the choice the user made by ticking the box.
        expect(ptz.pan360).toBe(true);
        expect(ptz.panDisplay).toBe(270);
        expect(ptz.az).toBe(-90);
        expect(pan._min).toBe(0);
        expect(pan._max).toBe(360);
    });

    test("a value below 180 does not tick the box", () => {
        const {ptz, pan} = makePTZ();
        typeInto(pan, 100);
        expect(ptz.pan360).toBe(false);
        expect(ptz.az).toBe(100);

        // 180 is the last value the signed slider can show, so it is not a request for
        // the other convention either.
        const second = makePTZ();
        typeInto(second.pan, 180);
        expect(second.ptz.pan360).toBe(false);
        expect(second.ptz.az).toBe(180);
    });

    test("a wild typed value is folded, and the range restored", () => {
        const {ptz, pan} = makePTZ();
        typeInto(pan, 5000);               // 5000 deg is 13 turns and 320 deg
        expect(ptz.pan360).toBe(true);
        expect(ptz.panDisplay).toBe(320);
        expect(ptz.az).toBe(-40);
        expect(pan._max).toBe(360);        // not 5000
    });

    test("stepping off the end arrives at the other end, not one step short", () => {
        // The wrap period of an angle slider is 360, not max-min+step: 0 and 360 are one
        // direction, not two. With the step included, arrowing down from 0 landed back on
        // 0 and the slider appeared stuck.
        const {ptz, pan} = makePTZ();
        ptz.pan360 = true;
        ptz.updatePanRange();
        expect(pan.$input.value).toBe("0");

        pressArrow(pan, 'ArrowDown');
        expect(ptz.panDisplay).toBeCloseTo(359.99, 6);
        expect(ptz.az).toBeCloseTo(-0.01, 6);

        // and back over the top again
        pressArrow(pan, 'ArrowUp');
        expect(ptz.panDisplay).toBe(0);
    });
});

describe("saving and loading", () => {

    test("the convention travels with the sitch", () => {
        const {ptz} = makePTZ();
        ptz.pan360 = true;
        ptz.az = 250;
        const saved = ptz.modSerialize();
        expect(saved.pan360).toBe(true);
        expect(saved.az).toBe(-110);        // stored signed, as always

        const {ptz: loaded} = makePTZ();
        loaded.modDeserialize(saved);
        expect(loaded.pan360).toBe(true);
        expect(loaded.az).toBe(-110);
        expect(loaded.panDisplay).toBe(250);
    });

    test("a sitch written with an azimuth above 180 is shown the way it was written", () => {
        // Saves predate the checkbox, and an EXIF import could put a 0..360 heading in
        // one. Showing 250 as -110 would be a number the file never mentions.
        const {ptz} = makePTZ({az: 250});
        expect(ptz.pan360).toBe(true);
        expect(ptz.az).toBe(-110);
        expect(ptz.panDisplay).toBe(250);

        const {ptz: signed} = makePTZ({az: -110});
        expect(signed.pan360).toBe(false);
    });
});

describe("a mirrored copy of the menu", () => {

    // CustomManager.mirrorGUIFolder("camera", ...) clones the whole Camera folder into a
    // standalone window, so the Pan slider can exist twice. Both copies are bound to the
    // same property, so they cannot disagree about the VALUE - but a twin built without
    // the wrap settings would clamp where the original wraps, and in the 0-360 spelling
    // that means sticking at north.

    test("wraps the same way the original does", () => {
        const {ptz, pan} = makePTZ();
        const other = new GUI({autoPlace: false});
        const twin = pan.mirrorTo(other);

        expect(twin._canWrap).toBe(true);
        expect(twin._wrapPeriod).toBe(360);
        expect(twin._allowInputExpandMax).toBe(true);
        expect(twin._allowInputExpandMin).toBe(true);

        ptz.pan360 = true;
        ptz.updatePanRange();                    // carries the new range across on its own

        // Arrowing down off the bottom of the twin continues round, as on the original.
        twin.$input.dispatchEvent(new KeyboardEvent('keydown', {code: 'ArrowDown', bubbles: true}));
        expect(ptz.panDisplay).toBeCloseTo(359.99, 6);
        expect(ptz.az).toBeCloseTo(-0.01, 6);
    });

    test("follows the original when the CONVENTION is switched", () => {
        // The checkbox moves the range without moving the value, so the mirror's
        // value-change sync never fires. A twin left on -180..180 would then draw a
        // compass bearing against the signed range - 270 pinned past the end of its own
        // track - and clamp anything typed into it to 180.
        const {ptz, pan} = makePTZ();
        const other = new GUI({autoPlace: false});
        const twin = pan.mirrorTo(other);
        expect(twin._min).toBe(-180);
        expect(twin._max).toBe(180);

        ptz.az = -90;
        ptz.pan360 = true;
        ptz.updatePanRange();          // what the checkbox's onChange does

        expect(twin._min).toBe(0);
        expect(twin._max).toBe(360);
        expect(twin.$input.value).toBe("270");
        expect(twin._fillPercent()).toBeCloseTo(0.75, 6);

        ptz.pan360 = false;
        ptz.updatePanRange();
        expect(twin._min).toBe(-180);
        expect(twin._max).toBe(180);
        expect(twin.$input.value).toBe("-90");
    });

    test("mirroring the same control twice does not stack range hooks", () => {
        const {ptz, pan} = makePTZ();
        const a = new GUI({autoPlace: false}), b = new GUI({autoPlace: false});
        const twinA = pan.mirrorTo(a);
        const twinB = pan.mirrorTo(b);

        ptz.pan360 = true;
        ptz.updatePanRange();
        expect(twinA._max).toBe(360);
        expect(twinB._max).toBe(360);
        expect(pan._menuMirrorRangeTwins.length).toBe(2);

        // A closed mirror menu drops out rather than being carried for ever.
        twinA.destroy();
        ptz.pan360 = false;
        ptz.updatePanRange();
        expect(pan._menuMirrorRangeTwins).toEqual([twinB]);
        expect(twinB._min).toBe(-180);
    });

    test("typing 270 into the twin works exactly as it does in the original", () => {
        const {ptz, pan} = makePTZ();
        const other = new GUI({autoPlace: false});
        const twin = pan.mirrorTo(other);

        typeInto(twin, 270);

        expect(ptz.pan360).toBe(true);
        expect(ptz.panDisplay).toBe(270);
        expect(ptz.az).toBe(-90);
        // The source slider is the one the controller owns, so its range moved; the
        // twin's is carried across by MenuMirror's syncRange on the same change.
        expect(pan._min).toBe(0);
        expect(pan._max).toBe(360);
        expect(twin._min).toBe(0);
        expect(twin._max).toBe(360);
    });
});

describe("satellite mode", () => {

    test("hides the checkbox with the Pan slider it belongs to", () => {
        const {ptz} = makePTZ();
        ptz.satellite = true;
        ptz.updateSatelliteSliderVisibility();
        expect(ptz.pan360Controller.domElement.style.display).toBe("none");

        ptz.satellite = false;
        ptz.updateSatelliteSliderVisibility();
        expect(ptz.pan360Controller.domElement.style.display).not.toBe("none");
    });
});
