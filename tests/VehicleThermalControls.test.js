/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://local.metabunk.org/tools/vehicles/"}
 */
import fs from "fs";
import path from "path";
import {THERMAL_PARAMETERS, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {attachThermalDebug, createThermalControls, createVehicleThermalPreview, thermalControlGroups} from "../tools/vehicles/thermalPreview.js";
import {createVehicleStudio} from "../tools/vehicles/studio.js";
import {mountVehicleDesigner} from "../tools/vehicles/designer.js";
import {downloadVehicleBlob} from "../tools/vehicles/files.js";
import {Box3, Group, PerspectiveCamera, Scene, Vector3} from "three";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";

const mockDraws = [];
jest.mock("../tools/thermal/ThermalPipeline.js", () => ({ThermalPipeline: jest.fn().mockImplementation(() => ({
    render: jest.fn(() => mockDraws.push("ir")), readDetectorCounts: () => new Float32Array([10, 12, 100, 300]), dispose: jest.fn(),
}))}));
jest.mock("three", () => {
    const actual = jest.requireActual("three");
    return {...actual, WebGLRenderer: jest.fn().mockImplementation(() => ({
        domElement: globalThis.document.createElement("canvas"), setPixelRatio() {}, setClearColor() {}, setSize() {}, clear() {}, dispose() {},
        render() {mockDraws.push("visible");},
    }))};
});
jest.mock("three/addons/controls/OrbitControls.js", () => ({OrbitControls: class {
    constructor(camera) {this.camera = camera; this.target = new (jest.requireActual("three").Vector3)();}
    update() {this.camera.lookAt(this.target); this.camera.updateMatrixWorld(true);}
    addEventListener() {} dispose() {}
}}));
jest.mock("../tools/vehicles/files.js", () => ({downloadVehicleBlob: jest.fn(), downloadVehicleRecipe: jest.fn(), readVehicleRecipeFile: jest.fn()}));

beforeEach(() => {
    localStorage.clear(); delete window.vehicleThermal; document.body.replaceChildren(); mockDraws.length = 0;
    ThermalPipeline.mockClear(); downloadVehicleBlob.mockClear();
    global.ResizeObserver = class {observe() {} disconnect() {}};
    global.requestAnimationFrame = jest.fn(() => 1); global.cancelAnimationFrame = jest.fn();
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage: jest.fn()});
    jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,thumbnail");
    jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["snapshot"])));
});
afterEach(() => jest.restoreAllMocks());

test("the generated menu covers every schema parameter once, in its schema group, with units and provenance", () => {
    const mount = document.createElement("div"); let settings = settingsForPreset("MX15");
    const control = createThermalControls(mount, () => settings, jest.fn()); control.refresh();
    expect(new Set([...thermalControlGroups().values()].flat())).toEqual(new Set(THERMAL_PARAMETERS));
    expect(mount.querySelectorAll("[data-thermal-key]")).toHaveLength(THERMAL_PARAMETERS.length);
    for (const parameter of THERMAL_PARAMETERS) {
        const input = mount.querySelector(`[data-thermal-key="${parameter.key}"]`);
        expect(input.closest(".field").textContent).toContain(parameter.unit);
        expect(input.closest("details").querySelector("summary").textContent.toLowerCase()).toBe(parameter.group);
        if (settings.presetMetadata[parameter.key]) expect(input.parentNode.querySelector("small").textContent).toBe(settings.presetMetadata[parameter.key].status);
    }
    settings = settingsForPreset("ATFLIR"); control.refresh();
    // The status shown is the preset's own, whatever the research has established it to be.
    expect(mount.querySelector("#thermal-detectorWidth").parentNode.textContent).toContain(settings.presetMetadata.detectorWidth.status);
    control.dispose(); expect(mount.children).toHaveLength(0);
});

test("inactive controls explain their required mode and become editable when that mode is selected", () => {
    const mount=document.createElement("div"); let settings=settingsForPreset("MX15");
    const controls=createThermalControls(mount,()=>settings,jest.fn()); controls.refresh();
    const field=key=>mount.querySelector(`[data-thermal-key="${key}"]`);
    expect(field("groundTemperatureSpanK").disabled).toBe(false);
    settings={...settings,groundTemperatureMode:"uniform"};controls.refresh();
    expect(field("groundTemperatureSpanK").disabled).toBe(true);
    expect(field("groundTemperatureSpanK").title).toContain("Terrain color estimate");
    expect(field("skyTemperatureK").disabled).toBe(true); expect(field("skyTemperatureK").title).toContain("Manual temperature");
    expect(field("integrationTimeS").disabled).toBe(true); expect(field("plateauFactor").disabled).toBe(true);
    settings={...settings,skySource:"manual",exposureMode:"manual",gainMode:"plateau"};controls.refresh();
    expect(field("seaMode").disabled).toBe(true);
    expect(field("skyTemperatureK").disabled).toBe(false);expect(field("integrationTimeS").disabled).toBe(false);
    expect(field("plateauFactor").disabled).toBe(false); expect(field("wellFillFraction").disabled).toBe(true);
    settings={...settings,noiseEnabled:false,localAmount:0,scatterFraction:0};controls.refresh();
    expect(field("shotNoiseEnabled").disabled).toBe(true);expect(field("scatterSlope").disabled).toBe(true);
    expect(field("localRadiusPx").disabled).toBe(true);
    settings={...settings,opticsEnabled:false,turbulenceR0M:0,polarity:"blackHot"};controls.refresh();
    expect(field("defocusM").disabled).toBe(true);expect(field("psfTemperatureK").disabled).toBe(true);
    expect(field("polarityAffineGain").disabled).toBe(true);
    settings={...settings,opticsEnabled:true,polarity:"whiteHot"};controls.refresh();
    expect(field("defocusM").disabled).toBe(false);expect(field("psfTemperatureK").disabled).toBe(false);
    expect(field("polarityAffineGain").disabled).toBe(false);
    controls.dispose();
});

test("camera settings persist separately, linked focal edits update field of view, and local debug handles dispose", () => {
    const renderer = {domElement: document.createElement("canvas")}, panel = document.createElement("div"), readout = document.createElement("div");
    const options = {renderer, panel, readout, onChange: jest.fn(), onError: jest.fn()};
    const preview = createVehicleThermalPreview(options);
    expect(window.vehicleThermal.pipeline).toBe(preview.pipeline);
    window.vehicleThermal.set("rangeM", 300000); window.vehicleThermal.set("focalLengthM", .135);
    window.vehicleThermal.set("gainMode", "fixedRadiometric");
    expect(preview.settings.fieldMode).toBe("focalLength");
    // The field follows from the detector height and the edited focal length.
    const {detectorHeight, pixelPitchM} = preview.settings;
    expect(preview.settings.verticalFovDeg).toBeCloseTo(2 * Math.atan(detectorHeight * pixelPitchM / (2 * .135)) * 180 / Math.PI, 9);
    expect(panel.querySelector("#thermal-focalLengthM").parentNode.textContent).toContain("Edited");
    expect(() => window.vehicleThermal.set("gainMode", "invalid")).toThrow();
    preview.dispose(); expect(window.vehicleThermal).toBeUndefined();
    const next = createVehicleThermalPreview(options);
    expect(next.view.rangeM).toBe(300000); expect(next.settings.focalLengthM).toBe(.135);
    expect(next.settings.gainMode).toBe("fixedRadiometric"); next.dispose();
});

test("the near IR view renders through the visible preview's camera with the sensor's rows, pitch and f-number", () => {
    // The near view shows the same picture as the visible preview: same camera position, direction and field of view.
    const renderer = {domElement: document.createElement("canvas")}, panel = document.createElement("div"), readout = document.createElement("div");
    const viewCamera = new PerspectiveCamera(36, 1.6, .05, 3000); viewCamera.position.set(-40, 15, 30);
    const orbit = {target: new Vector3(), update: jest.fn()};
    const options = {renderer, panel, readout, onChange: jest.fn(), onError: jest.fn(), viewCamera, orbit};
    const preview = createVehicleThermalPreview(options);
    const preset = PRESETS.find(entry => entry.id === "a340-600");
    const vehicle = {root: new Group(), recipe: createVehicleRecipe(preset.parameters, preset.name, preset.id),
        bounds: new Box3(new Vector3(-30, -5, -35), new Vector3(30, 10, 35))};
    const center = vehicle.bounds.getCenter(new Vector3()), last = () => preview.pipeline.render.mock.calls.at(-1)[0];
    let now = 1000; jest.spyOn(performance, "now").mockImplementation(() => now);
    try {
        expect(preview.usesViewCamera).toBe(true);
        preview.render(new Scene(), vehicle, 7);
        const sensor = preview.settings, near = last().settings;
        expect(last().camera).toBe(viewCamera);
        expect(near.verticalFovDeg).toBeCloseTo(36, 9);
        expect([near.detectorWidth, near.detectorHeight]).toEqual([Math.round(sensor.detectorHeight * 1.6), sensor.detectorHeight]);
        expect(near.pixelPitchM).toBe(sensor.pixelPitchM); expect(near.digitalZoom).toBe(1);
        expect(near.focalLengthM / near.apertureM).toBeCloseTo(sensor.focalLengthM / sensor.apertureM, 9);
        expect(last().psfRangeM).toBeCloseTo(viewCamera.position.distanceTo(center), 9);
        expect(readout.textContent).toContain("Near");
        expect(panel.querySelector("input[max='300000'][step='100']").closest("label").hidden).toBe(true);
        // The distance field moves the shared camera along its line from the vehicle's center.
        const direction = viewCamera.position.clone().sub(center).normalize();
        preview.set("nearDistanceM", 120);
        expect(viewCamera.position.distanceTo(center)).toBeCloseTo(120, 9);
        expect(viewCamera.position.clone().sub(center).normalize().dot(direction)).toBeCloseTo(1, 12);
        expect(orbit.target.equals(center)).toBe(true); expect(orbit.update).toHaveBeenCalled();
        // A changed distance becomes the point-response range once it has been still for 300 ms.
        const previous = last().psfRangeM;
        now += 10; preview.render(new Scene(), vehicle, 8);
        expect(last().psfRangeM).toBe(previous); expect(readout.textContent).toContain("point response updating");
        now += 300; preview.render(new Scene(), vehicle, 9);
        expect(last().psfRangeM).toBeCloseTo(120, 9); expect(readout.textContent).not.toContain("updating");
        // Far: the sensor's own camera at range, the range as the point-response range; the choice persists.
        preview.set("irView", "far");
        expect(preview.usesViewCamera).toBe(false);
        preview.render(new Scene(), vehicle, 10);
        expect(last().camera).not.toBe(viewCamera); expect(last().psfRangeM).toBe(preview.view.rangeM);
        expect(last().settings).toBe(preview.settings); expect(readout.textContent).toContain("Far");
        preview.dispose();
        const restored = createVehicleThermalPreview(options);
        expect(restored.view.irView).toBe("far"); restored.dispose();
    } finally {performance.now.mockRestore?.();}
});

test("the near IR view keeps the visible camera, its orbit and the full canvas; the far view letterboxes and locks orbit", async () => {
    const mount = document.createElement("div");
    Object.defineProperty(mount, "clientWidth", {value: 1600}); Object.defineProperty(mount, "clientHeight", {value: 1000});
    const studio = createVehicleStudio(mount);
    try {
        await studio.loadThermal({panel: document.createElement("div"), readout: document.createElement("div"), onChange: jest.fn(), onError: jest.fn()});
        studio.setMode("ir");
        expect(studio.sharesCamera).toBe(true); expect(studio.controls.enabled).toBe(true);
        expect(studio.renderer.domElement.style.width).toBe("1600px"); expect(studio.camera.aspect).toBeCloseTo(1.6, 12);
        studio.thermal.set("irView", "far"); studio.resize();
        const {detectorWidth, detectorHeight} = studio.thermal.settings;
        expect(studio.sharesCamera).toBe(false); expect(studio.controls.enabled).toBe(false);
        expect(studio.renderer.domElement.style.width).toBe(`${1000 * detectorWidth / detectorHeight}px`);
        studio.setMode("visible");
        expect(studio.controls.enabled).toBe(true); expect(studio.camera.aspect).toBeCloseTo(1.6, 12);
    } finally {studio.dispose();}
});

test("the shared editor lazily activates IR, snapshots it, uses visible thumbnails and restores IR", async () => {
    const parsed = new DOMParser().parseFromString(fs.readFileSync(path.join(__dirname, "../tools/vehicles/index.html"), "utf8"), "text/html");
    document.body.innerHTML = parsed.body.innerHTML;
    const editor = mountVehicleDesigner(document, {persist: false});
    try {
        expect(ThermalPipeline).not.toHaveBeenCalled();
        const mode = document.querySelector("#renderMode"); mode.value = "ir"; mode.dispatchEvent(new Event("change"));
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
        expect(ThermalPipeline).toHaveBeenCalledTimes(1);
        expect(document.querySelector("#thermalPanel").hidden).toBe(false);
        window.vehicleThermal.set("rangeM", 125000);
        document.querySelector("#fitView").click(); expect(window.vehicleThermal.settings.rangeM).toBe(125000);
        mockDraws.length = 0; document.querySelector("#screenshot").click();
        expect(mockDraws).toEqual(["ir"]); expect(downloadVehicleBlob).toHaveBeenCalledTimes(1);
        expect(document.querySelector("#thermalReadout").textContent).toContain("median 56");
        mockDraws.length = 0; expect(editor.thumbnail()).toContain("image/jpeg");
        expect(mockDraws).toEqual(["visible", "ir"]);
        expect(editor.getRecipe().parameters.rangeM).toBeUndefined();
        mode.value = "visible"; mode.dispatchEvent(new Event("change"));
        mockDraws.length = 0; document.querySelector("#screenshot").click(); expect(mockDraws).toEqual(["visible"]);
    } finally {editor.dispose();}
    expect(window.vehicleThermal).toBeUndefined();
});

test("the IR preview draws new sensor frames only for detector noise and reads counts after a change or a pointer move", async () => {
    const parsed = new DOMParser().parseFromString(fs.readFileSync(path.join(__dirname, "../tools/vehicles/index.html"), "utf8"), "text/html");
    document.body.innerHTML = parsed.body.innerHTML;
    const editor = mountVehicleDesigner(document, {persist: false});
    try {
        const mode = document.querySelector("#renderMode"); mode.value = "ir"; mode.dispatchEvent(new Event("change"));
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
        const reads = jest.spyOn(ThermalPipeline.mock.results[0].value, "readDetectorCounts");
        const frameMs = 1000 / window.vehicleThermal.settings.frameRateHz;
        let time = 10000;
        const tick = (steps = 1) => {time += steps * frameMs; requestAnimationFrame.mock.calls.at(-1)[0](time);};
        tick(); mockDraws.length = 0; reads.mockClear();
        // Detector noise on: each sensor frame is drawn, but nothing else changed, so no counts are read back.
        expect(window.vehicleThermal.settings.noiseEnabled).toBe(true);
        tick(); tick(); tick();
        expect(mockDraws).toEqual(["ir", "ir", "ir"]); expect(reads).not.toHaveBeenCalled();
        // The pointer asks for the counts under it.
        document.querySelector("#canvasMount canvas").dispatchEvent(new MouseEvent("pointermove", {clientX: 1, clientY: 1}));
        expect(reads).toHaveBeenCalledTimes(1);
        // An edit draws once and reads the counts for the readout; without noise, time alone draws nothing.
        window.vehicleThermal.set("noiseEnabled", false); mockDraws.length = 0; reads.mockClear();
        tick(); expect(mockDraws).toEqual(["ir"]); expect(reads).toHaveBeenCalledTimes(1);
        tick(); tick(5); expect(mockDraws).toEqual(["ir"]); expect(reads).toHaveBeenCalledTimes(1);
    } finally {editor.dispose();}
});

test("closing a studio during lazy load does not create a pipeline or a debug hook", async () => {
    const studio = createVehicleStudio(document.createElement("div"));
    const loading = studio.loadThermal({}); studio.dispose();
    await expect(loading).resolves.toBeNull();
    expect(ThermalPipeline).not.toHaveBeenCalled(); expect(window.vehicleThermal).toBeUndefined();
});

test.each(["localhost", "local.metabunk.org", "www.metabunk.org", "metabunk.org", "localhost.example.org"])("debug exposure obeys the exact hostname allowlist on %s", hostname => {
    const host = {location: {hostname}}, debug = {};
    const detach = attachThermalDebug(host, debug);
    expect(host.vehicleThermal === debug).toBe(["localhost", "local.metabunk.org"].includes(hostname));
    detach(); expect(host.vehicleThermal).toBeUndefined();
});

test("the raw import map versions the thermal dependency graph and ordinary startup keeps it lazy", () => {
    const directory = path.resolve(__dirname, "../tools/vehicles");
    const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
    const imports = JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/)[1]).imports;
    const visited = new Set();
    function visit(file, includeLazy) {
        if (visited.has(file)) return;
        visited.add(file);
        const source = fs.readFileSync(file, "utf8");
        const references = [...source.matchAll(/(?:from\s*|import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?)["']([^"']+)["']/g)];
        for (const reference of references) {
            if (!includeLazy && reference[0].startsWith("import")) continue;
            const name = reference[1]; if (!name.startsWith(".")) continue;
            const dependency = path.resolve(path.dirname(file), name);
            const mapKey = path.relative(directory, dependency).replace(/^(?!\.)/, "./");
            expect(imports[mapKey]).toBe(`${mapKey}?v=__BUILD_V__`);
            visit(dependency, includeLazy);
        }
    }
    visit(path.join(directory, "designer.js"), false);
    expect([...visited].some(file => file.startsWith(path.resolve(directory, "../thermal") + path.sep))).toBe(false);
    expect(visited.has(path.join(directory, "thermalPreview.js"))).toBe(false);
    visited.clear(); visit(path.join(directory, "designer.js"), true);
    expect(visited.has(path.resolve(directory, "../thermal/ThermalPipeline.js"))).toBe(true);
});
