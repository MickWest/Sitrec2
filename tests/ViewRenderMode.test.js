/** @jest-environment jsdom */
// Per-frame render route: per-frame camera data can put the look view of a physical-thermal sitch on the visible route
// for a visible-light frame. One helper gives the route, and every reader uses it.
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {Group, Vector3} from "three";
import {effectiveRenderMode, frameEffectPasses, frameRenderModeFor} from "../src/rendering/ViewRenderMode";
import {splitViewEffects, viewColorPolicy} from "../src/rendering/ViewColorPipeline";

const ROOT = path.join(__dirname, "..");

function methods(file, className, names, scope = {}, base = class {}) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body.map(n => n.declaration ?? n).find(n => n.id?.name === className);
    const code = declaration.body.body.filter(n => names.includes(n.key?.name)).map(n => source.slice(n.start, n.end)).join("\n");
    return new Function(...Object.keys(scope), "Base", `return class extends Base {${code}}`)(...Object.values(scope), base);
}

// Synthetic camera data: an infrared row from frame 10, a visible-light row from frame 20, no row from frame 30.
function cameraData() {
    const par = {frame: 10};
    const rows = [{frame: 10, band: "IR"}, {frame: 20, band: "EO"}];
    const node = {stateAt: frame => frame >= 30 ? null : rows.findLast(row => row.frame <= Math.floor(frame)) ?? rows[0]};
    const NodeMan = {get: (id, required) => {expect(required).toBe(false); return id === "cameraState" ? node : undefined;}};
    return {par, NodeMan};
}
const FRAME_GETTERS = ["frameCameraState", "frameBand", "frameRenderMode"];

test("the helper prefers the frame's route and keeps the saved mode when there is none", () => {
    expect(effectiveRenderMode({renderMode: "physicalThermal"})).toBe("physicalThermal");
    expect(effectiveRenderMode({renderMode: "physicalThermal", frameRenderMode: null})).toBe("physicalThermal");
    expect(effectiveRenderMode({renderMode: "physicalThermal", frameRenderMode: "visible"})).toBe("visible");
    expect(effectiveRenderMode({})).toBeUndefined();
    expect(frameRenderModeFor("physicalThermal", "EO")).toBe("visible");
    for (const [mode, band] of [["physicalThermal", "IR"], ["physicalThermal", null], ["visible", "EO"], ["visible", "IR"]])
        expect(frameRenderModeFor(mode, band)).toBeNull();
});

test("only the look view follows the camera data; visible-light frames drop the infrared look", () => {
    const {par, NodeMan} = cameraData();
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", [...FRAME_GETTERS, "updateIsIR"],
        {NodeMan, par, frameRenderModeFor});
    const look = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal",
        effectPasses: [{effectName: "FLIRShader", enabled: true}]});
    const main = Object.assign(new View(), {id: "mainView", renderMode: "physicalThermal", effectPasses: look.effectPasses});
    // Infrared frame: the thermal route, and the legacy shader still counts as infrared.
    expect(look.frameBand).toBe("IR"); expect(effectiveRenderMode(look)).toBe("physicalThermal");
    look.updateIsIR(); expect(look.isIR).toBe(true);
    // Visible-light frame: the visible route, without the infrared look.
    par.frame = 20.5;
    expect(look.frameBand).toBe("EO"); expect(effectiveRenderMode(look)).toBe("visible");
    look.updateIsIR(); expect(look.isIR).toBe(false);
    // The main view does not describe the recording's camera.
    expect(main.frameCameraState).toBeNull(); expect(effectiveRenderMode(main)).toBe("physicalThermal");
    main.updateIsIR(); expect(main.isIR).toBe(true);
    // A saved visible view stays on the visible route; frames without data keep the saved mode.
    look.renderMode = "visible"; expect(effectiveRenderMode(look)).toBe("visible");
    look.renderMode = "physicalThermal"; par.frame = 30;
    expect(look.frameCameraState).toBeNull(); expect(effectiveRenderMode(look)).toBe("physicalThermal");
    // No camera-data node at all: nothing changes.
    const Plain = methods("src/nodes/CNodeView3D.js", "CNodeView3D", FRAME_GETTERS,
        {NodeMan: {get: () => undefined}, par, frameRenderModeFor});
    const plain = Object.assign(new Plain(), {id: "lookView", renderMode: "physicalThermal"});
    expect(plain.frameRenderMode).toBeNull(); expect(effectiveRenderMode(plain)).toBe("physicalThermal");
});

test("the camera-data row is looked up once per frame, and again when the data or Drive Look View changes", () => {
    const par = {frame: 10};
    const node = {table: {rows: 1}, driveLookView: true,
        stateAt: jest.fn(frame => node.driveLookView ? {band: frame >= 20 ? "EO" : "IR", table: node.table} : null)};
    const NodeMan = {get: () => node};
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", FRAME_GETTERS, {NodeMan, par, frameRenderModeFor});
    const look = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal"});
    for (let read = 0; read < 5; read++) expect(look.frameBand).toBe("IR");
    expect(node.stateAt).toHaveBeenCalledTimes(1);
    par.frame = 20;
    expect(look.frameBand).toBe("EO");
    // a new file at the same frame
    const newTable = {rows: 2};
    node.table = newTable;
    expect(look.frameCameraState.table).toBe(newTable);
    // Drive Look View turned off at the same frame
    node.driveLookView = false;
    expect(look.frameCameraState).toBeNull();
    expect(node.stateAt).toHaveBeenCalledTimes(4);
});

test("an infrared frame takes the thermal route and a visible-light frame the visible route, in the real dispatcher", () => {
    const {par, NodeMan} = cameraData();
    let cameraUnavailable = false;
    const unavailable = jest.fn(() => cameraUnavailable), ensureThermalView = jest.fn(), clearThermalStatus = jest.fn();
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", [...FRAME_GETTERS, "thermalRouteUnavailable",
        "renderTargetAndEffects"], {NodeMan, par, frameRenderModeFor, effectiveRenderMode, thermalUnavailable: unavailable,
        thermalStatus: jest.fn(), clearThermalStatus, ensureThermalView, isPanoramicCamera: () => false,
        isFisheyeCamera: () => false, Globals: {}, PanoramicRenderer: jest.fn()});
    const restore = jest.fn();
    const view = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal", camera: {},
        renderTargetAndEffectsInternal: jest.fn(), clearThermalOutput: jest.fn(), isXRPresenting: () => false,
        raytracedRefraction: {begin: jest.fn(() => restore)}, thermalStatus: "readout"});
    view.renderTargetAndEffects();
    expect(unavailable).toHaveBeenCalledTimes(1); expect(view.renderTargetAndEffectsInternal).toHaveBeenLastCalledWith();
    expect(view.raytracedRefraction.begin).not.toHaveBeenCalled(); expect(clearThermalStatus).not.toHaveBeenCalled();
    expect(ensureThermalView).not.toHaveBeenCalled();
    // A visible-light frame clears the thermal readout.
    par.frame = 20; view.renderTargetAndEffects();
    expect(clearThermalStatus).toHaveBeenCalledTimes(1); expect(clearThermalStatus).toHaveBeenLastCalledWith(view);
    expect(view.renderTargetAndEffectsInternal).toHaveBeenLastCalledWith(view.raytracedRefraction);
    expect(restore).toHaveBeenCalledTimes(1);
    // The visible-light frame of a physical thermal view loads the sensor for the next infrared frame...
    expect(ensureThermalView).toHaveBeenCalledTimes(1); expect(ensureThermalView).toHaveBeenLastCalledWith(view);
    // ...but not for a saved visible view, after a failed load, or for a camera the sensor cannot draw.
    view.renderMode = "visible"; view.renderTargetAndEffects();
    view.renderMode = "physicalThermal"; view._thermalError = new Error("failed"); view.renderTargetAndEffects();
    view._thermalError = null; cameraUnavailable = true; view.renderTargetAndEffects();
    expect(ensureThermalView).toHaveBeenCalledTimes(1);
});

test("a visible-light frame skips only the FLIR and thermal look passes; other effects stay as set", () => {
    const {par, NodeMan} = cameraData();
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", [...FRAME_GETTERS, "renderEffectsAndOutput"], {
        NodeMan, par, frameRenderModeFor, frameEffectPasses, splitViewEffects, globalProfiler: null,
        Globals: {renderDebugFlags: {dbg_renderEffects: true, dbg_copyToScreen: false}},
        forceFilterChange() {}, LinearFilter: 1, NearestFilter: 2, renderFisheyeMask() {}});
    const drawn = [];
    const pass = effectName => ({effectName, enabled: true, filter: "Linear", pass: {uniforms: {tDiffuse: {}}, material: effectName}});
    const view = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal", effectsEnabled: true,
        effectPasses: ["FLIRShader", "Thermal", "StaticNoise", "Levels"].map(pass),
        renderTargetA: {texture: {}}, renderTargetB: {texture: {}}, fullscreenQuad: {}, fullscreenQuadCamera: {},
        renderer: {setRenderTarget() {}, render: () => drawn.push(view.fullscreenQuad.material)}});
    const policy = {active: false, toneMapping: false, exposure: 1, opticsBeforeSensor: false};
    par.frame = 20; view.renderEffectsAndOutput(view.renderTargetA, policy);
    expect(drawn).toEqual(["StaticNoise", "Levels"]);
    drawn.length = 0; par.frame = 10; view.renderEffectsAndOutput(view.renderTargetA, policy);
    expect(drawn).toEqual(["FLIRShader", "Thermal", "StaticNoise", "Levels"]);
    // A keyed pass list (addEffectPass) filters the same way.
    expect(frameEffectPasses({frameBand: "EO", effectPasses: {a: pass("FLIRShader"), b: pass("Invert")}}).map(e => e.effectName)).toEqual(["Invert"]);
    const list = [pass("FLIRShader")];
    expect(frameEffectPasses({frameBand: "IR", effectPasses: list})).toBe(list);
});

test("a visible-light frame gets the visible color policy and reflections; an infrared frame keeps the thermal gates", () => {
    const view = {id: "lookView", isIR: false, isXRPresenting: () => false, toneMappingEnabled: true, viewExposure: .5,
        opticsBeforeSensor: true, renderMode: "physicalThermal"};
    expect(viewColorPolicy(view, 2)).toEqual({active: false, toneMapping: false, exposure: 1, opticsBeforeSensor: false});
    expect(viewColorPolicy({...view, frameRenderMode: null}, 2).active).toBe(false);
    expect(viewColorPolicy({...view, frameRenderMode: "visible"}, 2)).toEqual({active: true, toneMapping: true, exposure: 1, opticsBeforeSensor: true});
    const ObjectNode = methods("src/nodes/CNode3DObject.js", "CNode3DObject", ["preRender", "applyViewScale", "postRender"],
        {Globals: {objectScaleMain: 1}, effectiveRenderMode});
    const node = Object.assign(new ObjectNode(), {common: {}, group: new Group(), baseScale: 1, updateEnvMap: jest.fn()});
    node.preRender({id: "lookView", renderMode: "physicalThermal", frameRenderMode: null});
    expect(node.updateEnvMap).not.toHaveBeenCalled();
    node.preRender({id: "lookView", renderMode: "physicalThermal", frameRenderMode: "visible"});
    expect(node.updateEnvMap).toHaveBeenCalledTimes(1);
});

test("a reflection update reads the band of the frame being drawn, not of the last frame drawn", () => {
    const {par, NodeMan} = cameraData();
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", [...FRAME_GETTERS, "updateIsIR"], {NodeMan, par, frameRenderModeFor});
    const view = Object.assign(new View(), {id: "lookView", renderMode: "visible",
        effectPasses: [{effectName: "FLIRShader", enabled: true}], renderer: {getRenderTarget: () => null, setRenderTarget() {}}});
    view.updateIsIR(); expect(view.isIR).toBe(true);   // the infrared frame was drawn last
    const scene = {background: "saved"}, backgrounds = [];
    const ObjectNode = methods("src/nodes/CNode3DObject.js", "CNode3DObject", ["updateEnvMap"], {
        GlobalScene: scene, Color: class {constructor(hex) {this.hex = hex;}}, LAYER: {MASK_LOOKRENDER: 1},
        NodeMan: {get: id => id === "theSun" ? {calculateSkyColor: () => "sky"} : undefined}});
    const node = Object.assign(new ObjectNode(), {_perViewEnvMaps: true, material: {}, group: new Group(),
        applyEnvMapToModel() {}, getOrCreateEnvMap: () => ({renderTarget: {texture: {}}, cubeCamera: {children: [],
            position: new Vector3(), update: () => backgrounds.push(scene.background.hex ?? scene.background)}})});
    // An export sets the frame and runs the node pre-renders (NodeMan.preRenderAll) before the view's renderCanvas.
    const Manager = methods("src/nodes/CNodeManager.js", "CNodeManager", ["preRenderAll"]);
    const manager = Object.assign(new Manager(), {getPreRenderNodes: () => [{preRender: v => node.updateEnvMap(v)}]});
    par.frame = 20; manager.preRenderAll(view);
    par.frame = 10; manager.preRenderAll(view);
    expect(backgrounds).toEqual(["sky", 0xFFFFFF]); expect(scene.background).toBe("saved");
});

test("an export waits for this frame's image, optics and fenced gain, not for a prefetch build", () => {
    const {par, NodeMan} = cameraData();
    let cameraUnavailable = false;
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", [...FRAME_GETTERS, "thermalRouteUnavailable",
        "getPendingLoadState"], {NodeMan, par, frameRenderModeFor, effectiveRenderMode, Globals: {},
        thermalUnavailable: () => cameraUnavailable, isPanoramicCamera: () => false, isFisheyeCamera: () => false});
    const pipeline = {hasFrame: true, lastFrame: {frame: 10}, pendingOptics: null,
        opticsReport: {outsideValidatedDomain: false, pending: true}, gainReport: {mode: "gpu", settled: true},
        opticsScheduler: {pending: true}};
    const view = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal", camera: {}, visible: true,
        _effectivelyVisible: true, _thermalAdapter: {pipeline}});
    // A prefetch build (scheduler pending) while the kernels shown are validated does not hold the export.
    expect(view.getPendingLoadState()).toEqual({hasPending: false,
        perView: {lookView: {thermal: false, image: false, optics: false, gain: false}}, error: undefined});
    pipeline.opticsReport = {outsideValidatedDomain: true};
    expect(view.getPendingLoadState()).toMatchObject({hasPending: true, perView: {lookView: {optics: true}}});
    pipeline.opticsReport = {outsideValidatedDomain: false}; pipeline.pendingOptics = {};
    expect(view.getPendingLoadState().hasPending).toBe(true);
    pipeline.pendingOptics = null; pipeline.hasFrame = false;
    expect(view.getPendingLoadState()).toMatchObject({hasPending: true, perView: {lookView: {image: true}}});
    pipeline.hasFrame = true; pipeline.gainReport = {mode: "fenced", settled: false};
    expect(view.getPendingLoadState()).toMatchObject({hasPending: true, perView: {lookView: {gain: true}}});
    pipeline.gainReport.settled = true;
    expect(view.getPendingLoadState().hasPending).toBe(false);
    expect(view.getPendingLoadState(["mainView"])).toBeNull();
    // The image shown is an earlier frame's (a paced draw): wait for this frame's own draw.
    par.frame = 11.5;
    expect(view.getPendingLoadState()).toMatchObject({hasPending: true, perView: {lookView: {image: true}}});
    pipeline.lastFrame = {frame: 11};
    expect(view.getPendingLoadState().hasPending).toBe(false);
    // A failed render waits for nothing.
    pipeline.opticsReport = {outsideValidatedDomain: true}; view._thermalError = new Error("failed");
    expect(view.getPendingLoadState()).toMatchObject({hasPending: false, error: "failed"});
    view._thermalError = null;
    // Nor does a view that does not draw the thermal route this frame, whose stale state no later draw would clear:
    // hidden, hidden by another view's full screen, or a camera the sensor cannot draw. Module loading still counts.
    for (const [key, value] of [["visible", false], ["_effectivelyVisible", false]]) {
        view[key] = value;
        expect(view.getPendingLoadState()).toMatchObject({hasPending: false, perView: {lookView: {optics: false}}});
        view[key] = true;
    }
    // An adapter made from the menu for a camera the sensor cannot draw never draws a frame.
    cameraUnavailable = true; pipeline.hasFrame = false;
    expect(view.getPendingLoadState().hasPending).toBe(false);
    view._thermalLoading = Promise.resolve();
    expect(view.getPendingLoadState()).toMatchObject({hasPending: true, perView: {lookView: {thermal: true}}});
    cameraUnavailable = false; view._thermalLoading = null;
    expect(view.getPendingLoadState().hasPending).toBe(true);
    // A visible-light frame takes the visible route, which has no thermal state to wait for.
    par.frame = 20;
    expect(view.getPendingLoadState()).toBeNull();
});

// Every reader chooses its route through effectiveRenderMode. These read the saved choice on purpose:
const SAVED_MODE_READERS = new Set([
    "src/nodes/CNodeView3D.js#renderXR",              // headsets have no thermal route and do not follow camera data
    "src/rendering/ThermalLoader.js#setupThermalMenu", // the menu's own value decides whether to load the sensor
    "src/nodes/CNodeView3D.js#modDeserialize",        // a restored saved mode decides whether to release the sensor
]);

function renderModeComparisons(file, source = fs.readFileSync(path.join(ROOT, file), "utf8")) {
    const ast = parse(source, {sourceType: "module", plugins: file.endsWith(".ts") ? ["typescript"] : []});
    const named = key => key?.name === "renderMode" || key?.value === "renderMode";
    // view.renderMode, view?.renderMode and view["renderMode"].
    const isRenderMode = node => (node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression") &&
        named(node.property);
    const found = [];
    const walk = (node, owner) => {
        if (!node || typeof node.type !== "string") return;
        const name = node.key?.name ?? node.id?.name;
        if (/Function|Method/.test(node.type) && name) owner = name;
        if ((node.type === "BinaryExpression" && /^[!=]==?$/.test(node.operator) && (isRenderMode(node.left) || isRenderMode(node.right))) ||
            (node.type === "SwitchStatement" && isRenderMode(node.discriminant)) ||
            // A destructured renderMode is compared under its own name, so the destructuring itself counts.
            (node.type === "ObjectPattern" && node.properties.some(property => named(property.key))))
            found.push(`${file}#${owner} (line ${node.loc.start.line})`);
        for (const [key, value] of Object.entries(node)) {
            if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
            if (Array.isArray(value)) value.forEach(child => walk(child, owner));
            else if (value && typeof value.type === "string") walk(value, owner);
        }
    };
    walk(ast.program, "module");
    return found;
}

test("no direct renderMode comparison remains outside the helper", () => {
    // The scan itself finds comparisons in either order, in a switch, through optional chaining and after
    // destructuring, and names the enclosing method.
    expect(renderModeComparisons("fixture.js", "class A {draw(v) {if (v.renderMode !== 'x') return; if ('y' == this['renderMode']) return;" +
        " switch (v.renderMode) {} if (v?.renderMode === 'x') return; const {renderMode} = v; return renderMode === 'x';}" +
        " ok(v) {return effectiveRenderMode(v) === 'x';}}"))
        .toEqual(Array(5).fill("fixture.js#draw (line 1)"));
    const files = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(path.join(ROOT, directory), {withFileTypes: true})) {
            const relative = path.posix.join(directory, entry.name);
            if (entry.isDirectory()) visit(relative);
            else if (/\.(m?js|ts)$/.test(entry.name) && fs.readFileSync(path.join(ROOT, relative), "utf8").includes("renderMode"))
                files.push(relative);
        }
    };
    visit("src");
    const comparisons = files.filter(file => file !== "src/rendering/ViewRenderMode.js").flatMap(file => renderModeComparisons(file));
    const direct = comparisons.filter(entry => !SAVED_MODE_READERS.has(entry.replace(/ \(line \d+\)$/, "")));
    expect(direct).toEqual([]);
    // The allowed readers still exist, so this list cannot silently go stale.
    expect([...new Set(comparisons.map(entry => entry.replace(/ \(line \d+\)$/, "")))].sort()).toEqual([...SAVED_MODE_READERS].sort());
    // And these readers use the helper. ThermalLoader.js does not read the frame's mode:
    // CNodeView3D.renderTargetAndEffects clears the thermal readout on a visible-light frame.
    for (const file of ["src/nodes/CNodeView3D.js", "src/nodes/CNodeView.js", "src/nodes/CNode3DObject.js",
        "src/rendering/ViewColorPipeline.js"])
        expect(fs.readFileSync(path.join(ROOT, file), "utf8")).toMatch(/effectiveRenderMode\((this|view)\)/);
});
