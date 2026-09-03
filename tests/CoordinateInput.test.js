/**
 * @jest-environment jsdom
 *
 * Covers the GUI half of coordinate entry: what a lil-gui Lat/Lon field does
 * when the user types or pastes something that isn't a plain number.
 */
import {attachCoordinateInput, attachLatLonInputs, isPlainNumber} from "../src/CoordinateInput";

// Stand-in for a lil-gui NumberController, including the parts that fight us:
// its 'input' handler is registered FIRST, parses with parseFloat (bailing on
// NaN), and calls updateDisplay(), which REWRITES the field to that number
// whenever the field isn't focused. That rewrite is what silently ate the
// longitude out of a pasted pair, so it has to be modelled here.
//
// `focused` defaults to true (a real user must focus a field to type or paste
// into it); pass false for the automation/programmatic case.
function makeController(initial = 0, focused = true) {
    const $input = document.createElement("input");
    $input.type = "text";
    $input.value = String(initial);
    document.body.appendChild($input);

    const controller = {
        $input,
        value: initial,
        focused,
        setValueCalls: 0,
        getValue() {
            return this.value;
        },
        setValue(v) {
            this.value = v;
            this.setValueCalls++;
            if (!this.focused) $input.value = String(v);   // updateDisplay()
            return this;
        },
    };

    // Registered before attachCoordinateInput(), exactly as in lil-gui.
    $input.addEventListener("input", () => {
        const v = parseFloat($input.value);
        if (isNaN(v)) return;
        controller.setValue(v);
    });

    return controller;
}

// jsdom dispatches no input events for programmatic .value writes, so the tests
// drive them explicitly — inputType distinguishes a paste from typing.
function type(controller, text) {
    controller.$input.value = text;
    controller.$input.dispatchEvent(new window.InputEvent("input", {inputType: "insertText"}));
}

function paste(controller, text) {
    controller.$input.value = text;
    controller.$input.dispatchEvent(new window.InputEvent("input", {inputType: "insertFromPaste"}));
}

// Committing a typed value (Tab away, or Enter — which lil-gui turns into
// $input.blur()) fires 'change' and then 'blur', in that order. lil-gui's blur
// handler rewrites the field to its own numeric value, so the ordering is what
// lets our 'change' handler still see the full typed text. Verified in real
// Chromium; jsdom implements neither the change-on-blur behaviour nor lil-gui,
// so both are modelled here.
function commit(controller, text) {
    type(controller, text);                                     // finish typing...
    controller.$input.dispatchEvent(new window.Event("change")); // ...then Tab/Enter
    // lil-gui's updateDisplay() on blur, AFTER change.
    controller.$input.value = String(controller.value);
    controller.$input.dispatchEvent(new window.Event("blur"));
}

describe("isPlainNumber", () => {
    test("plain decimals are left to lil-gui", () => {
        expect(isPlainNumber("45")).toBe(true);
        expect(isPlainNumber("-122.5")).toBe(true);
        expect(isPlainNumber(" 0.001 ")).toBe(true);
        expect(isPlainNumber("1e-5")).toBe(true);
    });

    test("anything else is ours to parse", () => {
        expect(isPlainNumber("45 30")).toBe(false);
        expect(isPlainNumber("25.299895°")).toBe(false);
        expect(isPlainNumber("N40 26.767")).toBe(false);
        expect(isPlainNumber("")).toBe(false);
    });
});

describe("attachCoordinateInput", () => {
    test("plain numbers are left entirely to lil-gui", () => {
        // lil-gui owns the plain-number path (clamping, elastic ranges), so we
        // must not apply the value a second time on top of it.
        const c = makeController(10);
        attachCoordinateInput(c);
        type(c, "45.5");
        expect(c.value).toBe(45.5);
        expect(c.setValueCalls).toBe(1);   // lil-gui's, and only lil-gui's
        expect(c.$input.value).toBe("45.5");
    });

    test("a format lil-gui cannot read is corrected after it, not before", () => {
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "45 30");
        // lil-gui's parseFloat got 45; we then corrected it to 45.5.
        expect(c.setValueCalls).toBe(2);
        expect(c.value).toBeCloseTo(45.5, 5);
    });

    test("degrees and decimal minutes", () => {
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "45 30");
        expect(c.value).toBeCloseTo(45.5, 5);
    });

    test("degrees minutes seconds with symbols", () => {
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "45° 30' 30\"");
        expect(c.value).toBeCloseTo(45.508333, 4);
    });

    test("hemisphere letters lil-gui's parseFloat cannot read", () => {
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "S 45.5");
        expect(c.value).toBeCloseTo(-45.5, 5);
    });

    test("a partially typed value does not rewrite the field", () => {
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "45 30");
        // Still editable, so the user can go on to type the seconds.
        expect(c.$input.value).toBe("45 30");
    });

    test("nonsense is ignored", () => {
        const c = makeController(7);
        attachCoordinateInput(c);
        type(c, "somewhere");
        expect(c.value).toBe(7);
    });

    test("text that is not a coordinate leaves the value where it was", () => {
        // lil-gui's own handler reads "45 30 3o" as parseFloat -> 45 and stores
        // it before we see the event. The entry is invalid, so the value must
        // stay at the last thing that parsed, not drop to 45.
        const c = makeController(0);
        attachCoordinateInput(c);
        type(c, "45 30 3");
        expect(c.value).toBeCloseTo(45.500833, 5);
        type(c, "45 30 3o");
        expect(c.value).toBeCloseTo(45.500833, 5);
        commit(c, "45 30 3o");
        expect(c.value).toBeCloseTo(45.500833, 5);
    });

    test("a minus sign typed on its own does not zero the field", () => {
        const c = makeController(34);
        attachCoordinateInput(c);
        type(c, "-");
        expect(c.value).toBe(34);
        type(c, "-0 13");
        expect(c.value).toBeCloseTo(-0.216667, 5);
    });
});

describe("attachLatLonInputs", () => {
    let lat, lon;
    beforeEach(() => {
        document.body.innerHTML = "";
        lat = makeController(0);
        lon = makeController(0);
        attachLatLonInputs(lat, lon);
    });

    test("a pair pasted into Lat fills in both, and Lat shows the latitude", () => {
        paste(lat, "25.299895° 60.430364°");
        expect(lat.value).toBeCloseTo(25.299895, 6);
        expect(lon.value).toBeCloseTo(60.430364, 6);
        expect(lat.$input.value).toBe("25.299895");
    });

    test("a pair pasted into Lon fills in both, and Lon shows the longitude", () => {
        paste(lon, "25.299895° 60.430364°");
        expect(lat.value).toBeCloseTo(25.299895, 6);
        expect(lon.value).toBeCloseTo(60.430364, 6);
        expect(lon.$input.value).toBe("60.430364");
    });

    test("comma separated pairs work too", () => {
        paste(lat, "40.7128, -74.0060");
        expect(lat.value).toBeCloseTo(40.7128, 4);
        expect(lon.value).toBeCloseTo(-74.006, 4);
    });

    test("DMS with hemisphere letters", () => {
        paste(lat, "45° 30' 30\" N 122° 30' 30\" W");
        expect(lat.value).toBeCloseTo(45.508333, 4);
        expect(lon.value).toBeCloseTo(-122.508333, 4);
    });

    test("MGRS", () => {
        paste(lat, "37SCR1192692923");
        expect(lat.value).toBeCloseTo(32.4576, 3);
    });

    test("typing a pair does not split until it is committed", () => {
        type(lat, "45.5, -1");
        // Mid-typing: don't grab a half-finished longitude or rewrite the box.
        expect(lon.value).toBe(0);
        expect(lat.$input.value).toBe("45.5, -1");

        commit(lat, "45.5, -122.5");
        expect(lat.value).toBeCloseTo(45.5, 5);
        expect(lon.value).toBeCloseTo(-122.5, 5);
    });

    test("lil-gui's blur rewrite does not eat a typed pair", () => {
        // The blur handler resets the field to the latitude alone. Because it
        // runs after 'change', the longitude has already been taken.
        commit(lat, "40.7128, -74.0060");
        expect(lat.value).toBeCloseTo(40.7128, 4);
        expect(lon.value).toBeCloseTo(-74.006, 4);
        expect(lat.$input.value).toBe("40.7128");
    });

    test("blurring a field the user never edited changes nothing", () => {
        lat.$input.value = "12.5";
        lat.$input.dispatchEvent(new window.Event("blur"));
        expect(lat.value).toBe(0);
        expect(lon.value).toBe(0);
    });

    test("a pair survives lil-gui rewriting the field on an unfocused input", () => {
        // Programmatic / automated input (MCP-driven testing, drag-and-drop):
        // the field is not focused, so lil-gui's updateDisplay() overwrites
        // "25.299895° 60.430364°" with "25.299895" inside its own 'input'
        // handler, before ours runs on the same event.
        document.body.innerHTML = "";
        const uLat = makeController(0, false);
        const uLon = makeController(0, false);
        attachLatLonInputs(uLat, uLon);

        paste(uLat, "25.299895° 60.430364°");

        expect(uLat.$input.value).toBe("25.299895");   // lil-gui did rewrite it
        expect(uLat.value).toBeCloseTo(25.299895, 6);
        expect(uLon.value).toBeCloseTo(60.430364, 6);  // ...and we still got the lon
    });

    test("a single coordinate in the Lat box leaves Lon alone", () => {
        type(lat, "45 30");
        expect(lat.value).toBeCloseTo(45.5, 5);
        expect(lon.value).toBe(0);
    });
});
