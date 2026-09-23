// The shared display-name helpers (src/DisplayName.js) and the switch-option relabel that a
// track rename uses (src/lil-gui-extras.js).

import {
    addNameControl,
    DISPLAY_NAME_CHANGED,
    displayTitle,
    titleFollowsDisplayName,
    uniqueDisplayName,
} from "../src/DisplayName";
import {EventManager} from "../src/CEventManager";
import {relabelOptionInGUIMenu} from "../src/lil-gui-extras";

describe("uniqueDisplayName", () => {
    test("adds -1, or steps an existing number, skipping names that are taken", () => {
        expect(uniqueDisplayName("Tower", [])).toBe("Tower-1");
        expect(uniqueDisplayName("Tower", ["Tower", "Tower-1"])).toBe("Tower-2");
        expect(uniqueDisplayName("Tower-1", ["Tower-1"])).toBe("Tower-2");
        expect(uniqueDisplayName("Tower-4", ["Tower-4", "Tower-5"])).toBe("Tower-6");
    });
});

test("displayTitle uses the prefix only when there is one", () => {
    expect(displayTitle("Tower", "Building")).toBe("Building: Tower");
    expect(displayTitle("Drone")).toBe("Drone");
});

// Enough of a lil-gui folder and controller for addNameControl.
function fakeFolder() {
    const folder = {
        titles: [],
        title(text) { this.titles.push(text); return this; },
        add(target, property) {
            const controller = {
                target, property, handlers: {},
                name() { return this; },
                tooltip() { return this; },
                onChange(fn) { this.handlers.change = fn; return this; },
                onFinishChange(fn) { this.handlers.finish = fn; return this; },
                moveToFirst() { this.movedFirst = true; return this; },
                type(value) { target[property] = value; this.handlers.change?.(value); },
            };
            return controller;
        },
    };
    return folder;
}

describe("addNameControl", () => {
    afterEach(() => EventManager.removeAll?.());

    test("retitles the folder with the METHOD, calls onRename, and notifies by id", () => {
        const folder = fakeFolder();
        const target = {id: "synthBuilding_1", name: "Building 1"};
        const renamed = [];
        const events = [];
        EventManager.addEventListener(DISPLAY_NAME_CHANGED, (e) => { events.push(e.id); });
        const controller = addNameControl(folder, target, {prefix: "Building", onRename: (n) => renamed.push(n)});

        controller.type("Tower");

        expect(folder.titles).toEqual(["Building: Tower"]);
        expect(typeof folder.title).toBe("function");
        expect(renamed).toEqual(["Tower"]);
        expect(events).toEqual(["synthBuilding_1"]);
    });

    test("uses the given property and id, and can go first", () => {
        const folder = fakeFolder();
        const trackOb = {trackID: "syntheticTrack_1", displayName: "Track 1"};
        const events = [];
        EventManager.addEventListener(DISPLAY_NAME_CHANGED, (e) => { events.push(e.id); });
        const controller = addNameControl(folder, trackOb, {property: "displayName", id: trackOb.trackID, first: true});

        controller.type("Drone");

        expect(trackOb.displayName).toBe("Drone");
        expect(folder.titles).toEqual(["Drone"]);
        expect(controller.movedFirst).toBe(true);
        expect(events).toEqual(["syntheticTrack_1"]);
    });
});

test("titleFollowsDisplayName retitles an open menu and drops out once it is closed", () => {
    const menu = {domElement: {isConnected: true}, titles: [], title(text) { this.titles.push(text); }};
    let name = "Drone";
    titleFollowsDisplayName(menu, "obj1", () => `Track: ${name}`);

    EventManager.dispatchEvent(DISPLAY_NAME_CHANGED, {id: "other"});
    name = "Kite";
    EventManager.dispatchEvent(DISPLAY_NAME_CHANGED, {id: "obj1"});
    expect(menu.titles).toEqual(["Track: Kite"]);

    menu.domElement.isConnected = false;
    EventManager.dispatchEvent(DISPLAY_NAME_CHANGED, {id: "obj1"});
    menu.domElement.isConnected = true;
    EventManager.dispatchEvent(DISPLAY_NAME_CHANGED, {id: "obj1"});
    expect(menu.titles).toEqual(["Track: Kite"]);
});

test("relabelOptionInGUIMenu changes the shown name and keeps the value", () => {
    const options = [{textContent: "fixedTarget"}, {textContent: "synth_01_d"}];
    const controller = {
        _names: ["fixedTarget", "synth_01_d"],
        _values: ["fixedTarget", "synth_01_d"],
        $select: {options},
        updateDisplay: jest.fn(),
    };

    relabelOptionInGUIMenu(controller, "synth_01_d", "Drone");

    expect(controller._names).toEqual(["fixedTarget", "Drone"]);
    expect(controller._values).toEqual(["fixedTarget", "synth_01_d"]);
    expect(options[1].textContent).toBe("Drone");
    expect(controller.updateDisplay).toHaveBeenCalled();

    relabelOptionInGUIMenu(controller, "missing", "X");
    expect(controller._names).toEqual(["fixedTarget", "Drone"]);
});
