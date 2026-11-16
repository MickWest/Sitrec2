/** @jest-environment jsdom */
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {SatelliteEditor} from "../src/SatelliteEditor";
window.matchMedia = () => ({matches: false, addListener() {}, removeListener() {}});

test("menu and panel share filters, brightness defaults and independent view labels", () => {
    jest.useFakeTimers();
    const host = document.createElement("div"); document.body.append(host);
    const gui = new GUI({container: host, autoPlace: false});
    const sats = {showSatellites: true, showStarlink: true, showISS: true, showBrightest: true, showOtherSatellites: true,
        showSatelliteList: "", nameFilter: "", showSatelliteNames: false, showSatelliteNamesMain: false, satScale: 2};
    for (const property of Object.keys(sats)) {
        if (property === "satScale") gui.add(sats, property, 0, 50, 0.01);
        else gui.add(sats, property);
    }
    const advanced = jest.fn();
    const make = () => new SatelliteEditor(host, {satellites: sats, source: property => gui.controllers.find(c => c.property === property),
        dateTime: {dateNow: new Date("2025-09-19T12:00:00Z")}, advanced});
    const menu = make(), panel = make();
    const advancedSearch = document.createElement("div"); host.append(advancedSearch);
    menu.moveSearchTo(advancedSearch);
    expect(menu.root.contains(menu.el("search"))).toBe(false);
    expect(advancedSearch.contains(menu.el("search"))).toBe(true);
    menu.el("show").value = "iss"; menu.el("show").dispatchEvent(new Event("change")); panel.update();
    expect(panel.el("show").value).toBe("iss");
    expect(sats.showOtherSatellites).toBe(false);
    panel.el("search").value = "25544"; panel.el("search").dispatchEvent(new Event("input")); menu.update();
    expect(menu.el("search").value).toBe("25544");
    menu.el("clear").click(); panel.update(); expect(panel.el("search").value).toBe("");
    const brightness = panel.group.controllers[0];
    gui.controllers.find(c => c.property === "satScale").setValue(7);
    brightness.$name.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));
    expect(sats.satScale).toBe(2);
    menu.group.controllers[1].$input.click(); panel.update();
    expect(sats.showSatelliteNamesMain).toBe(true); expect(sats.showSatelliteNames).toBe(false);
    expect(panel.group.controllers[1].$input.checked).toBe(true);
    menu.dispose(); panel.dispose(); gui.destroy(); host.remove();
    jest.clearAllTimers(); jest.useRealTimers();
});
