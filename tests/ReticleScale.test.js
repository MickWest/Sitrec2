// Milliradian reticle scale: the tick spacing and the wide/narrow choice follow the
// look view's magnification, so Video Zoom does not change a reading.
// The look view's camera update (CNodeView.preRenderCameraUpdate) is run on its own,
// extracted from the source, so the browser-only dependencies of the view are not loaded.
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {
    NARROW_RETICLE, pixelsPerMrad, reticleForImage, WIDE_MIN_FIELD_MRAD, WIDE_RETICLE,
} from "../src/ReticleScale";
import {effectiveRenderMode, viewMagnification} from "../src/rendering/ViewRenderMode";

function extractMethods(file, className, names, globals = {}) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body
        .map(node => node.declaration ?? node).find(node => node.id?.name === className);
    const body = declaration.body.body.filter(node => names.includes(node.key?.name))
        .map(node => source.slice(node.start, node.end)).join("\n");
    return new Function(...Object.keys(globals), `return class {${body}}`)(...Object.values(globals));
}

// A custom-sitch look view with Video Zoom synced to the camera and the pixel zoom pass,
// as data/custom/SitCustom.js sets it up. A 2400x1500 video has a pixel-match zoom of 1.5
// in a 1600x1000 render, so 200% is 1.5x camera zoom and 133% pixel zoom.
function lookView(videoZoomPercent, {effectsEnabled = true, pixelZoomEnabled = true} = {}) {
    const pixelZoom = {value: 100, v() { return this.value; }};
    const pixelZoomNode = {effectName: "pixelZoom", enabled: pixelZoomEnabled, in: {magnifyFactor: pixelZoom}};
    const nodes = {
        videoZoom: {v0: videoZoomPercent},
        pixelZoom,
        pixelZoomNode,
        video: {videoWidth: 2400, videoHeight: 1500},
    };
    const NodeMan = {exists: id => id in nodes, get: id => nodes[id]};
    const View = extractMethods("src/nodes/CNodeView.js", "CNodeView", ["preRenderCameraUpdate"],
        {NodeMan, effectiveRenderMode});
    return Object.assign(new View(), {
        id: "lookView", renderMode: "visible", widthPx: 1600, heightPx: 1000, in: {},
        syncPixelZoomWithVideo: true, effectsEnabled,
        camera: {fov: 0.5, aspect: 1, zoom: 1, updateProjectionMatrix() {}},
        effectPasses: {pixelZoom: pixelZoomNode},
    });
}

describe("milliradian reticle scale", () => {
    test("pixels per milliradian: tangent of 1 mrad at the center, times the magnification", () => {
        // a 60 degree field on 1000 px: tan(30 deg) spans 500 px
        expect(pixelsPerMrad(1000, 60)).toBeCloseTo(500 / Math.tan(Math.PI / 6) / 1000, 12);
        expect(pixelsPerMrad(1000, 60, 2)).toBeCloseTo(2 * pixelsPerMrad(1000, 60), 12);
    });

    test("at 100% and 200% Video Zoom the ticks are as far apart as the zoomed scene", () => {
        const view100 = lookView(100);
        view100.preRenderCameraUpdate();
        const view200 = lookView(200);
        view200.preRenderCameraUpdate();
        // 200% is split between the projection zoom and the pixel zoom pass
        expect(view200.camera.zoom).toBeCloseTo(1.5, 12);
        expect(view200.effectPasses.pixelZoom.in.magnifyFactor.value).toBeCloseTo(400 / 3, 9);

        expect(viewMagnification(view100, 0)).toBeCloseTo(1, 12);
        expect(viewMagnification(view200, 0)).toBeCloseTo(2, 12);
        const at100 = pixelsPerMrad(view100.heightPx, view100.camera.fov, viewMagnification(view100, 0));
        const at200 = pixelsPerMrad(view200.heightPx, view200.camera.fov, viewMagnification(view200, 0));
        expect(at200 / at100).toBeCloseTo(2, 12);
    });

    test("the wide/narrow choice depends on the camera's field, not on Video Zoom", () => {
        // a 640 px wide image whose field is just above, and just below, the switch
        const imageWidth = 640;
        for (const [fieldMrad, expected] of [[WIDE_MIN_FIELD_MRAD * 1.01, WIDE_RETICLE], [WIDE_MIN_FIELD_MRAD * 0.99, NARROW_RETICLE]]) {
            const pxPerMrad = imageWidth / fieldMrad;
            // zooming to 200% doubles the image on screen and the spacing together
            expect(reticleForImage(imageWidth, pxPerMrad)).toBe(expected);
            expect(reticleForImage(2 * imageWidth, 2 * pxPerMrad)).toBe(expected);
        }
    });

    test("only the zoom the view really draws counts", () => {
        // effects off: Video Zoom is not applied to the look view, and the pixel zoom pass does not run
        const off = lookView(200, {effectsEnabled: false});
        off.preRenderCameraUpdate();
        expect(viewMagnification(off, 0)).toBe(1);
        // a stale pixel zoom value is ignored while the pass is disabled
        const disabled = lookView(200, {pixelZoomEnabled: false});
        disabled.effectPasses.pixelZoom.in.magnifyFactor.value = 300;
        disabled.camera.zoom = 1.25;
        expect(viewMagnification(disabled, 0)).toBe(1.25);
        // effects switched off for debugging
        const debug = lookView(200);
        debug.preRenderCameraUpdate();
        expect(viewMagnification(debug, 0, false)).toBeCloseTo(1.5, 12);
        // the physical thermal route has no effect passes; camera.zoom carries the whole zoom
        const thermal = lookView(200);
        thermal.renderMode = "physicalThermal";
        thermal.preRenderCameraUpdate();
        expect(thermal.camera.zoom).toBe(2);
        thermal.effectPasses.pixelZoom.in.magnifyFactor.value = 133;
        expect(viewMagnification(thermal, 0)).toBe(2);
    });
});
