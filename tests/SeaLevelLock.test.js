import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";

// Exercise the UI lifecycle without constructing terrain or starting tile loads.
const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNodeTerrainUI.js"), "utf8");
const node = parse(source, {sourceType: "module"}).program.body.map(n => n.declaration ?? n)
    .find(n => n.id?.name === "CNodeTerrainUI");
const methods = node.body.body.filter(n => ["updateOceanSurface", "setOceanSurfaceVisible",
    "recalculateInundation", "modDeserialize"].includes(n.key?.name))
    .map(n => source.slice(n.start, n.end)).join("\n");
const Menu = new Function("Base", `return class extends Base {${methods}}`)(class { modDeserialize() {} });

test("locked views keep their surface, mask and arrows without sampling the camera or tiles", () => {
    const ui = Object.assign(new Menu(), {
        oceanSurfaceCalculationLocked: true,
        oceanSurfaceTransparent: true, oceanSurfaceTransparency: 60,
        oceanSurfaceGroup: {setTransparency: jest.fn(), updateSurface: jest.fn()},
        inundation: {update: jest.fn(), dispose: jest.fn(), suspend: jest.fn()},
        inundationArrows: {update: jest.fn(), visible: true},
        inundationStatus: "Locked", ensureOceanSurface: jest.fn(),
        buildingsNode: {setInundationRegion: jest.fn()},
    });
    // No camera globals are supplied: even a large move must not be sampled.
    ui.updateOceanSurface();
    expect(ui.oceanSurfaceGroup.setTransparency).toHaveBeenCalledWith(true, 60);
    expect(ui.oceanSurfaceGroup.updateSurface).not.toHaveBeenCalled();
    expect(ui.inundation.update).not.toHaveBeenCalled();
    expect(ui.inundationArrows.update).not.toHaveBeenCalled();
    ui.recalculateInundation();
    expect(ui.inundation.dispose).not.toHaveBeenCalled();
    ui.setOceanSurfaceVisible(false);
    expect(ui.oceanSurfaceGroup.visible).toBe(false);
    expect(ui.inundation.suspend).not.toHaveBeenCalled();
    expect(ui.inundationStatus).toBe("Locked");
    ui.setOceanSurfaceVisible(true);
    expect(ui.oceanSurfaceGroup.visible).toBe(true);
    expect(ui.inundationArrows.visible).toBe(true);
    expect(ui.inundation.update).not.toHaveBeenCalled();
    ui.oceanSurfaceCalculationLocked = false;
    ui.setOceanSurfaceVisible(false);
    expect(ui.inundation.suspend).toHaveBeenCalledTimes(1);
});

test("loading a sitch clears the session lock before updating its water surface", () => {
    const controller = {disable: jest.fn()};
    const ui = Object.assign(new Menu(), {
        oceanSurfaceCalculationLocked: true, props: {},
        seaLevelCalculationControls: [controller], disarmManualEdit: jest.fn(),
    });
    ui.setOceanSurfaceVisible = jest.fn(() => expect(ui.oceanSurfaceCalculationLocked).toBe(false));
    ui.modDeserialize({showOceanSurface: true, oceanSurfaceLevelFeet: 40});
    expect(controller.disable).toHaveBeenCalledWith(false);
    expect(ui.setOceanSurfaceVisible).toHaveBeenCalledWith(true);
    expect(ui.oceanSurfaceLevelFeet).toBe(40);
});

test("a paused timeline keeps advancing calculation blocks until completed or locked", () => {
    const update = node.body.body.find(n => n.key?.name === "update");
    const assignment = update.body.body.find(n => n.expression?.left?.property?.name === "updateWhilePaused");
    const keepAlive = new Function("texMapPending", "elevMapPending",
        `${source.slice(assignment.start, assignment.end)}; return this.updateWhilePaused;`);
    const ui = {showOceanSurface: true, oceanSurfaceCalculationLocked: false,
        groundPaintParams: {}, buildingsNode: {inundationLoading: () => true}};
    expect(keepAlive.call(ui, false, false)).toBe(true);
    ui.oceanSurfaceCalculationLocked = true;
    expect(keepAlive.call(ui, false, false)).toBe(false);
    ui.oceanSurfaceCalculationLocked = false;
    ui.showOceanSurface = false;
    expect(keepAlive.call(ui, false, false)).toBe(false);
    ui.showOceanSurface = true;
    ui.buildingsNode.inundationLoading = () => false;
    expect(keepAlive.call(ui, false, false)).toBe(false);
});
