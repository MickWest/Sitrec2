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
