// The mapped-ground mask for Material classes: the worker round trip in ThermalGroundMask, and the rasterization of
// roads, building footprints and paved paths into the mask's color channels (rasterThermalGround).
import {LinearFilter} from "three";
import {ThermalGroundMask} from "../src/rendering/ThermalGroundMask";
import {PAVED_PATH_CLASSES, rasterThermalGround, ROAD_WIDTHS_M} from "../src/citylights/ThermalGroundRaster";
import {encodeCompact, ROAD_CLASSES} from "../src/citylights/CityLightsData";
import {cityLightsRegion} from "../src/citylights/CityLightsRegion";

test("the mask starts its worker on first use, keeps a region while the target is inside it and applies only the latest answer", () => {
    const workers = [], previous = global.Worker;
    global.Worker = class {
        constructor() {workers.push(this);}
        postMessage = jest.fn();
        terminate = jest.fn();
    };
    try {
        const onChange = jest.fn(), mask = new ThermalGroundMask(onChange);
        expect(workers).toHaveLength(0);
        const state = mask.get(34, -118, 300), worker = workers[0];
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({view: "thermalGround", id: 1, thermalGround: true,
            region: expect.objectContaining({key: cityLightsRegion(34, -118, 300).key, size: 2048})}));
        expect(state).toMatchObject({loading: true, texture: null});
        // A target that stays well inside the region asks for nothing new.
        expect(mask.get(34.001, -118.001, 300)).toBe(state); expect(worker.postMessage).toHaveBeenCalledTimes(1);
        worker.onmessage({data: {id: 1, view: "thermalGround", progress: "Loading roads and buildings: 8/40"}});
        expect(onChange).not.toHaveBeenCalled();
        const answer = id => ({data: {id, view: "thermalGround", pixels: new Uint8Array([10, 20, 30, 255]).buffer,
            meta: {size: 1}, stats: {roads: 1, paths: 0, buildings: 2, metersPerTexel: 8}}});
        worker.onmessage(answer(1));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({loading: false, error: null, rect: state.region.rect, stats: {buildings: 2}});
        expect(Array.from(state.texture.image.data)).toEqual([10, 20, 30, 255]);
        expect(state.texture).toMatchObject({flipY: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false});
        // A distant target asks for a new region; the earlier mask stays in use until the answer arrives.
        const first = state.texture;
        mask.get(36, -115, 300);
        expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({id: 2}));
        expect(state.texture).toBe(first);
        worker.onmessage(answer(1)); expect(state.texture).toBe(first);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        worker.onmessage({data: {id: 2, view: "thermalGround", error: "network"}});
        expect(state).toMatchObject({error: "network", loading: false}); expect(onChange).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1); warn.mockRestore();
        const dispose = jest.spyOn(first, "dispose");
        mask.dispose();
        expect(worker.terminate).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1); expect(state.texture).toBeNull();
    } finally {global.Worker = previous;}
});

test("roads, building footprints and paved paths fill the mask's red, green and blue channels with paved widths by road class", () => {
    // A canvas stand-in: each of the three layers reports a distinct coverage in its alpha channel.
    const canvases = [], previous = {OffscreenCanvas: global.OffscreenCanvas, Path2D: global.Path2D};
    global.Path2D = class {moveTo() {} lineTo() {} closePath() {}};
    global.OffscreenCanvas = class {
        constructor(width, height) {
            this.width = width; this.height = height; this.coverage = 40 * (canvases.length + 1); canvases.push(this);
            const canvas = this;
            this.context = {fills: [], strokes: [], fill(path, rule) {this.fills.push(rule);}, stroke() {this.strokes.push(this.lineWidth);},
                getImageData: (x, y, w, h) => ({data: Uint8ClampedArray.from({length: w * h * 4}, (_, i) => i % 4 === 3 ? canvas.coverage : 0)})};
        }
        getContext() {return this.context;}
    };
    try {
        const size = 2, meters = 40;
        const feature = (kind, style, paths) => ({kind, style, seed: 1, paths});
        const square = [[0, 0], [65535, 0], [65535, 65535], [0, 0]];
        const data = encodeCompact({size, meters, key: "fixture"}, [feature(0, 0, [square]),
            feature(1, ROAD_CLASSES.indexOf("motorway"), [[[0, 0], [65535, 65535]]]),
            feature(1, ROAD_CLASSES.indexOf("footway"), [[[0, 65535], [65535, 0]]])]);
        const result = rasterThermalGround({data, bytes: data.byteLength, loadMs: 1});
        expect(result.stats).toMatchObject({roads: 1, buildings: 1, paths: 1, metersPerTexel: meters / size});
        expect(Array.from(new Uint8Array(result.pixels))).toEqual([40, 80, 120, 255, 40, 80, 120, 255, 40, 80, 120, 255, 40, 80, 120, 255]);
        const [roads, buildings, paths] = canvases.map(canvas => canvas.context);
        expect(buildings.fills).toEqual(["nonzero"]);
        // 0.05 texels per meter: a 15 m motorway is 0.75 texels wide; a 1.5 m footway keeps the 0.5 texel minimum.
        expect(PAVED_PATH_CLASSES).toContain("footway");
        expect(roads.strokes).toEqual([ROAD_WIDTHS_M.motorway * size / meters]); expect(paths.strokes).toEqual([.5]);
        expect(canvases.map(canvas => canvas.width)).toEqual([1, 1, 1]);
    } finally {global.OffscreenCanvas = previous.OffscreenCanvas; global.Path2D = previous.Path2D;}
});
