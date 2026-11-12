/** @jest-environment jsdom */
import {TimeEditor} from "../src/TimeEditor";

// The menu style sheet is in the page before the editor adds its own. It gives each
// menu button the full row width and left text.
const menuStyle = document.createElement("style");
menuStyle.textContent = ".lil-gui button { width: 100%; text-align: left; }";
document.head.append(menuStyle);

let editor, host, state, edits, adapter;
beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement("div"); document.body.append(host);
    state = {now: new Date("2024-12-31T23:59:10.987Z"), start: new Date("2024-12-31T23:59:00.987Z"), frame: 300,
        offset: 0, useZone: false, zone: "PST UTC-8", paused: true, live: false, speed: 1, playbackSpeed: 1, canUndo: false};
    edits = [];
    adapter = {
        zones: ["PST UTC-8", "NPT UTC+5.75"], read: () => state,
        pause: jest.fn(() => { state.paused = true; state.live = false; }),
        edit: jest.fn((date, target, begin) => {
            edits.push({date, target, begin});
            const delta = date - (target === "now" ? state.now : state.start);
            state.now = new Date(+state.now + delta); state.start = new Date(+state.start + delta);
        }),
        zone: jest.fn(), cameraZone: jest.fn(), speed: jest.fn(), play: jest.fn(), live: jest.fn(), undo: jest.fn(),
    };
    editor = new TimeEditor(host, adapter);
});
afterEach(() => { editor.dispose(); host.remove(); jest.useRealTimers(); });
const input = part => editor.root.querySelector(`input[data-part="${part}"]`);
function pointer(element, type, x = 0, options = {}) {
    const e = new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, ...options});
    Object.defineProperty(e, "pointerId", {value: 1});
    element.dispatchEvent(e);
}

test("keyboard steps cross midnight, keep fractional seconds, and isolate scene shortcuts", () => {
    const sceneKey = jest.fn(); document.addEventListener("keydown", sceneKey);
    input("minute").focus();
    input("minute").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
    expect(state.now.toISOString()).toBe("2025-01-01T00:00:10.987Z");
    expect(input("hour").value).toBe("00");
    expect(state.frame).toBe(300);
    expect(sceneKey).not.toHaveBeenCalled();
    document.removeEventListener("keydown", sceneKey);
});

test("relative digit scrub is one undoable edit, crosses a boundary, and can return to its starting time", () => {
    const minute = input("minute");
    pointer(minute, "pointerdown", 100);
    pointer(minute, "pointermove", 112);
    jest.advanceTimersByTime(20);
    expect(state.now.toISOString()).toBe("2025-01-01T00:01:10.987Z");
    pointer(minute, "pointermove", 100);
    pointer(minute, "pointerup", 100);
    expect(state.now.toISOString()).toBe("2024-12-31T23:59:10.987Z");
    expect(edits.map(e => e.begin)).toEqual([true, false]);
    expect(adapter.pause).toHaveBeenCalled();
});

test("left/right clicks step once, even when the digit is already focused", () => {
    const minute = input("minute");
    minute.getBoundingClientRect = () => ({left: 100, width: 80});
    minute.focus();
    pointer(minute, "pointerdown", 120);
    pointer(minute, "pointerup", 120);
    expect(state.now.toISOString()).toBe("2024-12-31T23:58:10.987Z");
    pointer(minute, "pointerdown", 160);
    pointer(minute, "pointerup", 160);
    expect(state.now.toISOString()).toBe("2024-12-31T23:59:10.987Z");
    pointer(minute, "pointerdown", 160, {shiftKey: true});
    pointer(minute, "pointerup", 160, {shiftKey: true});
    expect(state.now.toISOString()).toBe("2025-01-01T00:09:10.987Z");
    expect(edits.map(e => e.begin)).toEqual([true, true, true]);
    expect(document.activeElement).toBe(minute);
    expect(minute.selectionEnd - minute.selectionStart).toBe(2);
});

test("cancelling a pointer never steps or flushes a pending scrub", () => {
    pointer(input("second"), "pointerdown", 100);
    pointer(input("second"), "pointermove", 112);
    pointer(input("second"), "pointercancel", 112);
    jest.advanceTimersByTime(100);
    expect(edits).toHaveLength(0);
});

test("a quick scrub returning to its origin is not mistaken for a click", () => {
    pointer(input("second"), "pointerdown", 100);
    pointer(input("second"), "pointermove", 112);
    pointer(input("second"), "pointerup", 100);
    expect(edits).toHaveLength(0);
});

test("Tab selects only date/time digits in both directions and wraps", () => {
    const parts = ["year", "month", "day", "hour", "minute", "second", "millisecond"];
    const tab = shiftKey => {
        const event = new KeyboardEvent("keydown", {key: "Tab", shiftKey, bubbles: true, cancelable: true});
        document.activeElement.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    };
    input("year").focus();
    for (const part of [...parts.slice(1), "year"]) {
        tab(false);
        expect(document.activeElement).toBe(input(part));
        expect(input(part).selectionEnd - input(part).selectionStart).toBe(input(part).value.length);
    }
    for (const part of [...parts.slice(1).reverse(), "year"]) {
        tab(true);
        expect(document.activeElement).toBe(input(part));
    }
    for (const control of editor.root.querySelectorAll("button, select, input:not([data-part])")) expect(control.tabIndex).toBe(-1);
    editor.el("zone").focus();
    tab(false);
    expect(document.activeElement).toBe(input("year"));
    input("year").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    expect(editor.root.contains(document.activeElement)).toBe(false);
});

test("rows go from the date down to the paste field, and no row is in a closed section", () => {
    const rows = ['[data-part="year"]', '[data-part="hour"]', '[data-part="millisecond"]', '[data-id="status"]',
        '[data-id="zone"]', '[data-target="now"]', '[data-action="play"]', '[data-id="paste"]'].map(selector => editor.root.querySelector(selector));
    for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].compareDocumentPosition(rows[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(editor.root.querySelector("details")).toBeNull();
    expect(editor.el("paste").placeholder).toBe("Paste a date & time");
});

test("Enter in the paste field sets the time, and Now once is still there", () => {
    const paste = editor.el("paste");
    paste.value = "2025-03-04 05:06:07.089Z";
    paste.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    expect(state.now.toISOString()).toBe("2025-03-04T05:06:07.089Z");
    expect(edits.at(-1).target).toBe("now");
    paste.value = "not a date";
    paste.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    expect(editor.el("error").textContent).not.toBe("");
    expect(state.now.toISOString()).toBe("2025-03-04T05:06:07.089Z");
    expect(editor.root.querySelector('[data-action="now"]').textContent).toBe("Now once");
});

test("wheel scrolling over a focused digit does not change time", () => {
    input("second").focus();
    const wheel = new WheelEvent("wheel", {deltaY: 100, bubbles: true, cancelable: true});
    input("second").dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(edits).toHaveLength(0);
});

test("date digits and calendar edit the same local date without losing time precision", () => {
    input("year").value = "2025";
    input("year").dispatchEvent(new Event("change"));
    expect(state.now.toISOString()).toBe("2025-12-31T23:59:10.987Z");
    editor.el("calendar").value = "2024-02-29";
    editor.el("calendar").dispatchEvent(new Event("change"));
    expect(state.now.toISOString()).toBe("2024-02-29T23:59:10.987Z");
    expect(input("year").value).toBe("2024");
    expect(input("day").value).toBe("29");
});

test("drafts survive refresh; invalid input changes nothing; Escape restores it", () => {
    const minute = input("minute"); minute.focus(); minute.value = "70";
    editor.refresh(); expect(minute.value).toBe("70");
    minute.dispatchEvent(new Event("change"));
    expect(edits).toHaveLength(0); expect(minute.getAttribute("aria-invalid")).toBe("true");
    minute.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    expect(minute.value).toBe("59"); expect(editor.el("error").textContent).toBe("");
});

test("start mode targets frame zero without moving the playhead", () => {
    editor.root.querySelector('[data-target="start"]').click();
    input("second").value = "20";
    input("second").dispatchEvent(new Event("change"));
    expect(edits[0].target).toBe("start");
    expect(state.start.toISOString()).toBe("2024-12-31T23:59:20.987Z");
    expect(state.now.toISOString()).toBe("2024-12-31T23:59:30.987Z");
    expect(state.frame).toBe(300);
});

test("UTC/local selector only changes presentation through the source adapter", () => {
    editor.el("zone").value = "NPT UTC+5.75";
    editor.el("zone").dispatchEvent(new Event("change"));
    expect(adapter.zone).toHaveBeenCalledWith("NPT UTC+5.75");
    expect(adapter.edit).not.toHaveBeenCalled(); expect(adapter.pause).not.toHaveBeenCalled();
});

test("buttons keep their own width inside a menu that stretches its buttons", () => {
    const menu = document.createElement("div"); menu.className = "lil-gui"; document.body.append(menu);
    const inMenu = new TimeEditor(menu, adapter);
    try {
        // A button with te-grow fills the rest of its row with flex; the others have their text width.
        const buttons = [...inMenu.root.querySelectorAll("button:not(.te-grow)")];
        expect(buttons.length).toBeGreaterThan(3);
        for (const button of buttons) {
            expect(getComputedStyle(button).width).toBe("auto");
            expect(getComputedStyle(button).textAlign).toBe("center");
        }
    } finally { inMenu.dispose(); menu.remove(); }
});

test("after a click on a button, a key goes to the scene; a digit field keeps its keys", () => {
    const sceneKey = jest.fn(); document.addEventListener("keydown", sceneKey);
    const live = editor.root.querySelector('[data-action="live"]');
    pointer(live, "pointerdown"); live.focus(); pointer(live, "pointerup");
    const space = new KeyboardEvent("keydown", {key: " ", code: "Space", bubbles: true, cancelable: true});
    live.dispatchEvent(space);
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(space.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(live);
    input("minute").focus();
    input("minute").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
    expect(sceneKey).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", sceneKey);
});

test("disposal stops a pending scrub and removes the editor", () => {
    pointer(input("minute"), "pointerdown", 100);
    pointer(input("minute"), "pointermove", 112);
    editor.dispose(); jest.advanceTimersByTime(1000);
    expect(edits).toHaveLength(0); expect(host.children).toHaveLength(0);
});

// refresh() runs ten times each second. A write of the same value makes the browser lay out
// and paint the editor again, so a refresh with no change must not write to the page.
describe("a refresh", () => {
    // Every change to the editor's part of the page during `action`.
    function mutationsDuring(action) {
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(editor.root, {subtree: true, childList: true, attributes: true, characterData: true});
        action();
        records.push(...observer.takeRecords());
        observer.disconnect();
        return records.map(record => `${record.type}:${record.attributeName ?? record.target.nodeName}`);
    }

    test("with no change of state writes nothing to the page", () => {
        editor.refresh();

        expect(mutationsDuring(() => { for (let count = 0; count < 5; count++) editor.refresh(); })).toEqual([]);
    });

    test("with no change writes nothing also when the speed is not in the list", () => {
        state.speed = 7;
        editor.refresh();
        const speed = editor.root.querySelector('[data-custom]');
        expect(speed.value).toBe("7");

        expect(mutationsDuring(() => editor.refresh())).toEqual([]);
        expect(editor.root.querySelector('[data-custom]')).toBe(speed);
    });

    test("shows a change of state, and only that change", () => {
        editor.refresh();
        state.paused = false;

        const changes = mutationsDuring(() => editor.refresh());

        expect(editor.root.querySelector('[data-action="play"]').textContent).toBe(editor.text.pause);
        expect(changes.length).toBeGreaterThan(0);
        expect(changes.some(change => change === "attributes:disabled")).toBe(false);
    });

    test("removes the option of a speed that is not in the list when the speed goes back to a listed one", () => {
        state.speed = 7;
        editor.refresh();
        state.speed = 1;
        editor.refresh();

        expect(editor.root.querySelector('[data-custom]')).toBeNull();
        expect(editor.el("speed").value).toBe("1");
    });
});
