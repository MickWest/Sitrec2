import {applyViewingMenuLayout} from "../src/ViewingMenuLayout";

const makeMenus = () => Object.fromEntries(["satellites", "time", "camera", "file"].map(key => [key, {key, mode: "DOCKED"}]));

test("a fresh template docks only its requested menus, in order", () => {
    const menus = makeMenus(), bar = {dockToSidebar: jest.fn()};
    applyViewingMenuLayout({sidebarMenus: ["satellites", "time", "camera"]}, menus, bar);
    expect(bar.dockToSidebar.mock.calls.map(([menu]) => menu.key)).toEqual(["satellites", "time", "camera"]);
});

test("saved template layouts do not reapply defaults over the user's choices", () => {
    const bar = {dockToSidebar: jest.fn()};
    applyViewingMenuLayout({guiMenus: {}, sidebarMenus: ["satellites", "time", "camera"]}, makeMenus(), bar);
    expect(bar.dockToSidebar).not.toHaveBeenCalled();
});

test("an old visible panel becomes standard menus while existing menu positions survive", () => {
    const menus = makeMenus(), bar = {dockToSidebar: jest.fn()};
    menus.time.mode = "SIDEBAR_RIGHT";
    menus.camera.mode = "FLOATING";
    applyViewingMenuLayout({guiMenus: {}, mods: {starlinkViewing: {visible: true}}}, menus, bar);
    expect(bar.dockToSidebar.mock.calls).toEqual([[menus.satellites]]);
});

test("a saved hidden panel overrides the old template's visible default", () => {
    const bar = {dockToSidebar: jest.fn()};
    applyViewingMenuLayout({showSatelliteControls: true, mods: {starlinkViewing: {visible: false}}}, makeMenus(), bar);
    expect(bar.dockToSidebar).not.toHaveBeenCalled();
});
