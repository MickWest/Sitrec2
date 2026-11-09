/** @jest-environment jsdom */
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import "../src/MenuMirror";
import {updateCameraFOVControls} from "../src/CameraFOVControls";
import {Globals, guiMenus} from "../src/Globals";

let host, source, copies, fov, twin;
beforeEach(() => {
    host = document.createElement("div"); document.body.append(host);
    source = new GUI({container: host, autoPlace: false});
    copies = new GUI({container: host, autoPlace: false});
    guiMenus.cameraFOV = source;
    Globals.fisheye = {enabled: false}; Globals.panoramic = {enabled: false};
    fov = source.add({fov: 30}, "fov", 1, 120, 1);
    twin = fov.mirrorTo(copies);
});
afterEach(() => {source.destroy(); copies.destroy(); host.remove(); delete guiMenus.cameraFOV;});

test.each(["fisheye", "panoramic"])("%s changes update mirrors without a value change or listener poll", mode => {
    updateCameraFOVControls();
    Globals[mode].enabled = true;
    updateCameraFOVControls();
    expect(twin.domElement.inert).toBe(true);
    expect(twin.domElement.classList.contains("camera-projection-inactive")).toBe(true);
    expect(twin.getValue()).toBe(30);
    Globals[mode].enabled = false;
    updateCameraFOVControls();
    expect(twin.domElement.inert).toBe(false);
    expect(twin.domElement.classList.contains("camera-projection-inactive")).toBe(false);
});

test("restoring the projection preserves independent source restrictions", () => {
    fov.disable();
    Globals.fisheye.enabled = true; updateCameraFOVControls();
    Globals.fisheye.enabled = false; updateCameraFOVControls();
    expect(twin._disabled).toBe(true);
    expect(fov._disabled).toBe(true);
});
