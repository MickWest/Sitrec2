/** @jest-environment jsdom */
// The date range of the loaded TLE data was shown only at the top right of the main view, so a
// user who works in the look view only could not see it. The Satellites menu now has two
// read-only rows with the same dates, updated on every load, merge or replacement.
// The full night-sky node needs star catalogs and views, so these tests run the real prototype
// methods on a minimal instance with a real lil-gui folder.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {EventManager} from "../src/CEventManager";

function setup() {
    const satGUI = new GUI({container: document.body, autoPlace: false, title: "Satellites"});
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.satellites = {TLEData: undefined};
    node.addTLERangeMenu(satGUI);
    const row = (property) => satGUI.controllers.find(c => c.object === node.tleRange && c.property === property);
    return {satGUI, node, from: row("from"), to: row("to")};
}

function tleData(start, end, count = 2) {
    return {satData: new Array(count).fill({}), startDate: new Date(start), endDate: new Date(end)};
}

// What the row shows once the main loop has polled the listened controllers
function shown(satGUI, controller) {
    satGUI.updateListeners();
    return controller.$input.value;
}

afterEach(() => {
    EventManager.removeAll();
    document.body.innerHTML = "";
});

test("the Satellites menu has read-only From and To rows that say nothing is loaded", () => {
    const {satGUI, from, to} = setup();
    expect(from.$name.textContent).toBe("TLEs From");
    expect(to.$name.textContent).toBe("TLEs To");
    expect(from._disabled).toBe(true);
    expect(to._disabled).toBe(true);
    expect(shown(satGUI, from)).toBe("None loaded");
    expect(shown(satGUI, to)).toBe("None loaded");
});

test("loading TLE data shows its range in the main-view format (UTC, to the second)", () => {
    const {satGUI, node, from, to} = setup();
    node.satellites.TLEData = tleData("2025-03-01T04:05:06.789Z", "2025-03-02T22:33:44.001Z");
    EventManager.dispatchEvent("tleLoaded", {});
    expect(shown(satGUI, from)).toBe("2025-03-01 04:05:06");
    expect(shown(satGUI, to)).toBe("2025-03-02 22:33:44");
});

test("a merge or a replacement updates the rows, and data with no satellites shows none", () => {
    const {satGUI, node, from, to} = setup();
    node.satellites.TLEData = tleData("2025-03-01T00:00:00Z", "2025-03-02T00:00:00Z");
    EventManager.dispatchEvent("tleLoaded", {});

    // A merge changes the range of the same data object, then fires the event again
    node.satellites.TLEData.endDate = new Date("2025-03-05T12:00:00Z");
    EventManager.dispatchEvent("tleLoaded", {});
    expect(shown(satGUI, from)).toBe("2025-03-01 00:00:00");
    expect(shown(satGUI, to)).toBe("2025-03-05 12:00:00");

    // A replacement is a new data object
    node.satellites.TLEData = tleData("2024-07-10T01:02:03Z", "2024-07-11T04:05:06Z");
    EventManager.dispatchEvent("tleLoaded", {});
    expect(shown(satGUI, from)).toBe("2024-07-10 01:02:03");
    expect(shown(satGUI, to)).toBe("2024-07-11 04:05:06");

    // A failed load replaces the data with an empty set, as the main view then shows no range
    node.satellites.TLEData = tleData("2100-01-01T00:00:00Z", "1950-01-01T00:00:00Z", 0);
    EventManager.dispatchEvent("tleLoaded", {});
    expect(shown(satGUI, from)).toBe("None loaded");
    expect(shown(satGUI, to)).toBe("None loaded");
});
