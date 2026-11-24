import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {Group, Sphere, Vector3} from "three";
import {inundationLoadMask} from "../src/water/InundationLoadMask";
import {InundationLoadSchedule} from "../src/water/InundationLoadSchedule";

// Exercise the real region lifecycle without starting the browser tile loader.
const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNodeBuildings3DTiles.js"), "utf8");
const declarations = parse(source, {sourceType: "module"}).program.body.map(n => n.declaration ?? n);
const node = declarations.find(n => n.id?.name === "CNodeBuildings3DTiles");
const method = node.body.body.find(n => n.key?.name === "setInundationRegion");
const methods = source.slice(method.start, method.end);

test("the calculation load mask does not enable the plugin's display mask mode", () => {
    const declaration = declarations.find(n => n.id?.name === "InundationLoadRegion");
    const BaseRegion = class {
        constructor(options) { this.mask = false; Object.assign(this, options); }
    };
    const Region = new Function("SphereRegion", "Sphere", "inundationLoadMask", "InundationLoadSchedule",
        `return ${source.slice(declaration.start, declaration.end)}`)(BaseRegion, Sphere, inundationLoadMask, InundationLoadSchedule);
    const region = new Region({sphere: new Sphere(new Vector3(), 20), errorTarget: 5}, {frameCount: 0});
    const grid = {level: 2, size: 2, cellMeters: 10, heights: new Float32Array(4), ocean: new Uint8Array(4),
        geometry: {maskRect: {}}, buildings: null};
    region.setGrid(grid);
    // A truthy BaseRegion.mask suppresses ordinary camera tiles outside the
    // calculation region, including areas whose samples have already loaded.
    expect(region.mask).toBe(false);
    expect(region.loadMask).toBeInstanceOf(Uint32Array);
    expect(region.loadMask[8]).toBe(4);
    const schedule = region.schedule;
    grid.buildings = {barriers: {level: 2, coverage: new Uint8Array(4)}};
    region.setGrid(grid);
    expect(region.schedule).toBe(schedule);
    grid.heights[0] = 7.5;
    grid.level = 2.1;
    region.setGrid(grid);
    expect(region.schedule).not.toBe(schedule);
    expect(region.loadMask[8]).toBe(3); // Match the coverage report's exact level + 5 m margin.
    region.schedule.current = null;
    expect(region.intersectsTile({})).toBe(false);
});

test("inundation loads a fixed region in one view and releases it when disabled or the source changes", () => {
    const Region = class {
        constructor(options) { Object.assign(this, options); }
        setGrid(grid) { const changed = this.grid !== grid; this.grid = grid; return changed; }
        advance() { return false; }
    };
    const Plugin = class { constructor(options) { Object.assign(this, options); } };
    const views = {mainView: {visible: true}, lookView: {visible: true}};
    const Node = new Function("NodeMan", "Sphere", "InundationLoadRegion", "LoadRegionPlugin", `return class {${methods}}`)
        ({get: id => views[id]}, Sphere, Region, Plugin);
    const pv = () => ({renderer: {group: new Group(), registerPlugin: jest.fn(), unregisterPlugin: jest.fn()}});
    const instance = Object.assign(new Node(), {source: "google-photorealistic", _perView: {mainView: pv(), lookView: pv()}});
    const center = new Vector3(1, 2, 3), grid = {heights: new Float32Array(4)};
    instance.setInundationRegion(center, 2500, 5, grid);
    const look = instance._perView.lookView, main = instance._perView.mainView;
    expect(look.renderer.registerPlugin).toHaveBeenCalledTimes(1);
    expect(main.renderer.registerPlugin).not.toHaveBeenCalled();
    expect(look.inundationRegion.sphere.center.equals(center)).toBe(true);
    look._needsLibUpdate = false;
    instance.setInundationRegion(center, 2500, 5, grid);
    expect(look._needsLibUpdate).toBe(false);
    instance.setInundationRegion(center, 3000, 8, grid);
    expect(look._needsLibUpdate).toBe(true);
    expect(look.inundationRegion.sphere.radius).toBe(3000);
    views.lookView.visible = false;
    instance.setInundationRegion(center, 3000, 8, grid);
    expect(look.renderer.unregisterPlugin).toHaveBeenCalledTimes(1);
    expect(main.renderer.registerPlugin).toHaveBeenCalledTimes(1);
    instance.setInundationRegion();
    expect(main.inundationLoadPlugin).toBeNull();
    instance.source = "cesium-osm";
    instance.setInundationRegion(center, 3000, 8, grid);
    expect(main.renderer.registerPlugin).toHaveBeenCalledTimes(1);
});
