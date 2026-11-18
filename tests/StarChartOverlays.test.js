/** @jest-environment jsdom */
import {Matrix4, PerspectiveCamera, Vector3} from "three";
import {setSit} from "../src/Globals";
import {raDec2Celestial} from "../src/CelestialMath";
import {PLEIADES} from "../src/DeepSkyObjects";

jest.mock("../src/nodes/CNodeViewUI", () => ({CNodeViewUI: class {
    constructor(v) { this.overlayView = v.overlayView; this.visible = v.overlayView.visible; }
    addInput() {}
    addSimpleSerial() {}
}}));
import {CNodeDisplaySkyOverlay} from "../src/nodes/CNodeDisplaySkyOverlay";

test("the video sky overlay follows a video that starts hidden and is revealed by importing", () => {
    const control = {};
    for (const method of ["asListCheckbox", "onChange", "name", "tooltip", "listen", "shareAs", "asViewCheckbox", "enable"]) {
        control[method] = () => control;
    }
    const overlay = new CNodeDisplaySkyOverlay({overlayView: {id: "video", visible: false},
        nightSky: {}, gui: {add: () => control}});
    expect(overlay.visible).toBe(true);
});

test("a small Pleiades uses one group label; zooming in restores individual member names", () => {
    setSit({starLimit: 10});
    const date = new Date("2025-09-20T04:50:26Z");
    const ra = PLEIADES.ra * Math.PI / 180, dec = PLEIADES.dec * Math.PI / 180;
    const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
    camera.lookAt(raDec2Celestial(ra, dec, 100));
    camera.updateMatrixWorld();
    const drawn = [];
    const ctx = {globalAlpha: 1, save() {}, restore() {}, beginPath() {}, ellipse() {}, stroke() {}, setLineDash() {},
        measureText: text => ({width: text.length * 6}), fillText: text => drawn.push(text)};
    const overlay = Object.assign(Object.create(CNodeDisplaySkyOverlay.prototype), {
        isVideo: true, ctx, onlyLabelPlanets: false,
        _renderedRect: {x: 0, y: 0, w: 600, h: 600},
        nightSky: {celestialSphere: {matrix: new Matrix4()}, celestialLabelSize: 12, groupPleiades: true,
            showDeepSkyObjectsVideo: false, starField: {commonNames: {1: "Alcyone", 2: "Atlas"},
                getStarRA: () => ra, getStarDEC: () => dec, getStarMagnitude: () => 3},
            planets: {planetSprites: {}}},
    });
    const draw = () => {
        drawn.length = 0;
        overlay.renderDeepSkyObjects(camera, null, new Vector3(), date, true, 1);
        overlay.renderStarNames(camera, null, new Vector3(), date);
    };
    draw();
    expect(drawn).toEqual(["Pleiades"]);
    camera.fov = 2;
    camera.updateProjectionMatrix();
    draw();
    expect(drawn).toEqual(["Alcyone", "Atlas"]);
});
