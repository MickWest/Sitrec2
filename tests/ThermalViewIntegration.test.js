/** @jest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector2, Vector3} from "three";
import {thermalRenderMode, thermalUnavailable, objectThermalState, setupThermalMenu} from "../src/rendering/ThermalLoader";
import {effectiveRenderMode} from "../src/rendering/ViewRenderMode";
import {createThermalViewAdapter, lensStepValidated, saveThermalSettings, setupThermalVehicleControls, thermalFieldMapping, thermalGeometry,
    thermalSettings, thermalSettingsForCameraState, thermalSettingsForViewField, thermalSolarGeometry, THERMAL_LOOK_HIDDEN} from "../src/rendering/ThermalViewAdapter";
import {createThermalSceneAdapter, sceneVehicleThermal, thermalSceneAtmosphere, thermalParticipation, withThermalRefraction, withThermalScene} from "../src/rendering/ThermalSceneAdapters";
import {terrestrialRefractionUniforms, patchTerrestrialRefractionVertexShader, liftWorldPoint, terrestrialLiftContext} from "../src/atmosphere/terrestrialRefraction";
import {THERMAL_PARAMETERS, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {gainStatistics} from "../tools/thermal/sensorMath.js";
import {integrateTurbulence} from "../tools/thermal/turbulence.js";
import GUI, {Controller} from "../src/js/lil-gui.esm.js";
import {createThermalControls} from "../tools/vehicles/thermalPreview.js";
import {radianceVertex, radianceFragment} from "../tools/thermal/shaders.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {withThermalVehicle} from "../tools/vehicles/thermalPreview.js";
import {recoveryTemperature, TURBOFAN_CLIMB_REFERENCE} from "../tools/thermal/signatures.js";
import {meanSeaLevelOffset} from "../src/EGM96Geoid";
import {getCelestialDirection} from "../src/CelestialMath";
import {Globals, markSitchDirty, NodeMan, Sit} from "../src/Globals";
import en from "../src/i18n/en.js";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000},
    GlobalDateTimeNode: {dateNow: new Date("2014-11-11T16:55:00Z")},
    NodeMan: {get: jest.fn(), iterate: jest.fn()}, Sit: {fps: 30, lat: 0, lon: 0}, markSitchDirty: jest.fn(), setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: jest.fn(() => 0)}));
jest.mock("../src/par", () => ({par: {frame: 7, trackToTrackStopAt: 0}}));
jest.mock("../src/i18n", () => ({t: (key, values = {}) => {
    const en = jest.requireActual("../src/i18n/en.js").default;
    return key.split(".").reduce((value, part) => value?.[part], en)?.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]) ?? key;
}}));

function methods(file, className, names, scope = {}, base = class {}) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body.map(n => n.declaration ?? n).find(n => n.id?.name === className);
    const code = declaration.body.body.filter(n => names.includes(n.key?.name)).map(n => source.slice(n.start, n.end)).join("\n");
    return new Function(...Object.keys(scope), "Base", `return class extends Base {${code}}`)(...Object.values(scope), base);
}

const native = () => settingsForPreset("MX15");
const cameraFor = settings => new PerspectiveCamera(settings.verticalFovDeg, settings.detectorWidth / settings.detectorHeight, 1, 500000);

test("old modes default to visible; unsupported projections cannot select the thermal renderer", () => {
    expect(thermalRenderMode(undefined)).toBe("visible"); expect(thermalRenderMode("legacyIR")).toBe("visible");
    const view = {id: "lookView", camera: cameraFor(native()), isXRPresenting: () => false};
    expect(thermalUnavailable(view)).toBe(false);
    for (const flag of ["fisheye", "flatEarth", "panorama"]) expect(thermalUnavailable(view, {[flag]: true})).toBe(true);
    expect(thermalUnavailable({...view, isXRPresenting: () => true})).toBe(true);
    expect(thermalUnavailable({...view, id: "mainView"})).toBe(true);
    expect(thermalUnavailable({...view, cameraNode: {orthographic: true}})).toBe(true);
});

test("the real view routes physical mode ahead of panorama and raytraced visible passes", () => {
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", ["thermalRouteUnavailable", "renderTargetAndEffects"], {
        thermalUnavailable, thermalStatus: jest.fn(), isPanoramicCamera: () => false, isFisheyeCamera: () => false,
        Globals: {}, PanoramicRenderer: jest.fn(), effectiveRenderMode,
    });
    const view = Object.assign(new View(), {id: "lookView", camera: cameraFor(native()), renderMode: "physicalThermal",
        renderTargetAndEffectsInternal: jest.fn(), clearThermalOutput: jest.fn(), isXRPresenting: () => false,
        raytracedRefraction: {begin: jest.fn()}});
    view.renderTargetAndEffects();
    expect(view.renderTargetAndEffectsInternal).toHaveBeenCalledWith();
    expect(view.raytracedRefraction.begin).not.toHaveBeenCalled();
    view.id = "mainView"; view.renderTargetAndEffects(); expect(view.clearThermalOutput).toHaveBeenCalledTimes(1);
    view.renderMode = "visible"; const restore = jest.fn(); view.raytracedRefraction.begin.mockReturnValue(restore);
    view.renderTargetAndEffects(); expect(restore).toHaveBeenCalledTimes(1);
});

test("camera preparation precedes thermal draw; pan, compression and offset restore on a throw", () => {
    const camera = cameraFor(native()); camera.updateMatrixWorld(true);
    const originalUpdate = camera.updateProjectionMatrix, originalProjection = camera.projectionMatrix.clone();
    const video = {panOffsetX: .1, panOffsetY: .2, videoWidth: 1280, videoHeight: 1024};
    const scope = {NodeMan: {exists: key => key === "video", get: key => key === "video" ? video : {}},
        Globals: {renderDebugFlags: {}}, globalProfiler: null, Vector2, GlobalDaySkyScene: undefined,
        setLineViewHeight() {}, resizeRenderTargetsToDrawingBuffer: () => new Vector2(640,512), effectiveRenderMode};
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", ["renderTargetAndEffectsInternal"], scope);
    const draw = jest.fn(() => {expect(camera.projectionMatrix.elements[8]).not.toBe(0);
        expect(camera.projectionMatrix.elements[5]).toBeLessThan(originalProjection.elements[5]); throw Error("draw");});
    const view = Object.assign(new View(), {id: "lookView", renderMode: "physicalThermal", visible: true,
        widthPx: 640, heightPx: 512, in: {}, camera, cameraNode: {id: "lookCamera"}, syncVideoZoom: true, yCompress: 2,
        renderer: {getPixelRatio: () => 1, setSize() {}, setRenderTarget() {}},
        getColorPolicy: () => ({}), applyCameraOffset: () => "offset", removeCameraOffset: jest.fn(), renderPhysicalThermal: draw});
    expect(() => view.renderTargetAndEffectsInternal()).toThrow("draw");
    expect(draw).toHaveBeenCalledTimes(1); expect(view.removeCameraOffset).toHaveBeenCalledWith("offset");
    expect(draw).toHaveBeenCalledWith(native().verticalFovDeg);
    expect(camera.updateProjectionMatrix).toBe(originalUpdate); expect(camera.projectionMatrix).toEqual(originalProjection);
});

test("native optics remain fixed for narrow and wide fields, aspect, pan and compression", () => {
    const settings = native(), camera = cameraFor(settings), original = JSON.stringify(settings);
    expect(thermalFieldMapping(camera, settings).scale).toEqual([1, 1]);
    camera.zoom = 2; camera.updateProjectionMatrix();
    expect(thermalFieldMapping(camera, settings)).toMatchObject({scale: [.5,.5], effectiveDigitalZoom: 2});
    camera.zoom = .5; camera.updateProjectionMatrix();
    expect(thermalFieldMapping(camera, settings)).toMatchObject({scale: [2,2], effectiveDigitalZoom: 1, fieldMagnification: .5});
    camera.aspect *= 2; camera.updateProjectionMatrix(); camera.projectionMatrix.elements[8] = .25;
    const mapping = thermalFieldMapping(camera, settings);
    expect(mapping.scale).toEqual([4,2]); expect(mapping.offset).toEqual([.5,0]);
    expect(JSON.stringify(settings)).toBe(original);
    const counts = Float32Array.from({length:64}, (_, i) => i);
    expect(gainStatistics(counts, 8, 8, {...settings, gainRegion: "displayed"}, {scale:[.5,.5],offset:[.25,0]}))
        .toEqual(new Float32Array([20,21,22,23,28,29,30,31,36,37,38,39,44,45,46,47]));
});

test("schema owners round trip without storing derived geometry or moving environment with the sensor", () => {
    const camera = {}, sit = {};
    const settings = normalizeSettings({...native(), groundTemperatureK: 301, gainMode: "automatic", turbulenceMode: "geometry"});
    saveThermalSettings(settings, camera, sit);
    for (const p of THERMAL_PARAMETERS) {
        expect(Object.hasOwn(camera.thermalSensor,p.key)).toBe(p.owner === "sensor");
        expect(Object.hasOwn(sit.thermalEnvironment,p.key)).toBe(p.owner === "environment");
        expect(en.thermal.parameters[p.key].label).toBeTruthy();
    }
    const copied = JSON.parse(JSON.stringify({camera,sit}));
    expect(thermalSettings(copied.camera,copied.sit)).toEqual(settings);
    expect(thermalSettings({},{}).turbulenceMode).toBe("geometry");
    const instance = objectThermalState({mode:"uniform",temperatureK:500,emissivity:.7,zones:{jet_cavity:{temperatureK:750}}});
    expect(objectThermalState(JSON.parse(JSON.stringify(instance)))).toEqual(instance);
});

test("thermal sunlight follows scene time and observer location independently of saved XYZ values", () => {
    const position = new Vector3(1653239, -5037239, -3536562);
    const morning = new Date("2014-11-11T12:00:00Z"), afternoon = new Date("2014-11-11T17:00:00Z");
    const a = thermalSolarGeometry(position, morning), b = thermalSolarGeometry(position, afternoon);
    expect(a.direction.distanceTo(getCelestialDirection("Sun", morning, position))).toBeLessThan(1e-12);
    expect(b.direction.distanceTo(getCelestialDirection("Sun", afternoon, position))).toBeLessThan(1e-12);
    expect(a.direction.distanceTo(b.direction)).toBeGreaterThan(.5);
    expect([...THERMAL_LOOK_HIDDEN]).toEqual(expect.arrayContaining(["sunDirectionX", "sunDirectionY", "sunDirectionZ", "objectTemperatureK", "emissivity"]));
});

test("real camera and view deserializers keep old saves visible and omit an unused sensor", () => {
    const Camera = methods("src/nodes/CNodeCamera.js", "CNodeCamera", ["modDeserialize"], {}, class {modDeserialize() {}});
    const camera = Object.assign(new Camera(), {camera: cameraFor(native()),resetCamera: jest.fn()});
    camera.modDeserialize({fov: 1,thermalSensor:{focalLengthM:.675}});
    expect(camera.thermalSensor).toEqual({focalLengthM:.675});
    camera.modDeserialize({fov: 1}); expect(camera.thermalSensor).toBeUndefined();
    const View = methods("src/nodes/CNodeView3D.js", "CNodeView3D", ["modDeserialize"],
        {thermalRenderMode, NodeMan:{get:()=>null}}, class {modDeserialize() {}});
    const view = Object.assign(new View(),{updateYCompressIndicator() {}});
    view.modDeserialize({renderMode:"physicalThermal"}); expect(view.renderMode).toBe("physicalThermal");
    view.modDeserialize({}); expect(view.renderMode).toBe("visible");
    const serialize = fs.readFileSync(path.join(__dirname,"../src/CustomManagerSerialize.js"),"utf8");
    expect(serialize.slice(serialize.indexOf("const SitNeeded"))).toContain('"thermalEnvironment"');
});

test("explicit participation grants objects and terrain, independent of mesh names", () => {
    const root = new Group(), ground = new Group(), clouds = new Group();
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); root.add(mesh); mesh.name = "cloud";
    const roots = new Map([[root,{kind:"object"}],[ground,{kind:"ground"}]]);
    expect(thermalParticipation(mesh,roots)).toEqual({kind:"object"});
    clouds.add(mesh); mesh.name = "aircraft"; expect(thermalParticipation(mesh,roots)).toBe(false);
    ground.add(mesh); expect(thermalParticipation(mesh,roots)).toEqual({kind:"ground"});
    ground.userData.thermal = false; expect(thermalParticipation(mesh,roots)).toBe(false);
    delete ground.userData.thermal;
    const adapter = createThermalSceneAdapter([], [ground], cameraFor(native()), {enabled:false});
    expect(adapter.attributes(mesh,native())).toEqual({temperatureK:288.15,emissivity:1,terrainColor:true});
    expect(adapter.attributes(mesh,{...native(),groundTemperatureMode:"uniform"})).toEqual({temperatureK:288.15,emissivity:1});
    expect(adapter.attributes(mesh,{...native(),groundTemperatureSpanK:0})).toEqual({temperatureK:288.15,emissivity:1});
});

test("procedural zone resolution is the Designer path; uniform and partial zone overrides restore", () => {
    const preset = PRESETS.find(p => p.id === "a340-600");
    const model = generateVehicle(createVehicleRecipe(preset.parameters,preset.name,preset.id));
    const node = {model:model.root,proceduralModel:{recipe:model.recipe},thermal:objectThermalState()};
    const resolved = root => {const values=[];root.traverse(m=>{if(m.isMesh)values.push([m.visible,{...m.userData.thermal}]);});return values;};
    let designer; withThermalVehicle(model,()=>{designer=resolved(model.root);});
    const original = resolved(model.root);
    expect(()=>withThermalScene([node],()=>{expect(resolved(model.root)).toEqual(designer);throw Error("draw");})).toThrow("draw");
    expect(resolved(model.root)).toEqual(original);
    const adapter = createThermalSceneAdapter([node],[],cameraFor(native()),{enabled:false});
    const mesh = new Mesh(); model.root.add(mesh); mesh.userData.thermal={zone:"jet_cavity",temperatureK:750,emissivity:.95};
    node.thermal.zones.jet_cavity={temperatureK:800};
    expect(adapter.attributes(mesh,native())).toMatchObject({temperatureK:800,emissivity:.95});
    node.thermal.mode="uniform"; expect(adapter.attributes(mesh,native())).toEqual({temperatureK:293,emissivity:1});
});

test("ECEF geometry supplies rolled local up, physical range and the shared turbulence integral", () => {
    const camera = cameraFor(native());camera.position.set(6371000+1382,0,0);camera.up.set(1,0,0);
    const target = new Vector3(6371000+1382,125000,0);camera.lookAt(target);camera.rotateZ(Math.PI/2);camera.updateMatrixWorld(true);
    const geometry = thermalGeometry(camera,target,Globals,()=>0);
    expect(geometry.sensorAltitudeM).toBeCloseTo(1382,6);expect(geometry.rangeM).toBe(125000);
    // Height above mean sea level: a geoid 38.46 m below the ellipsoid raises the camera by that much.
    expect(thermalGeometry(camera,target,Globals,()=>-38.46).sensorAltitudeM).toBeCloseTo(1382+38.46,6);
    const lowCamera = cameraFor(native());lowCamera.position.set(6371000-17.46,0,0);lowCamera.updateMatrixWorld(true);
    expect(thermalGeometry(lowCamera,target,Globals,()=>-38.46).sensorAltitudeM).toBeCloseTo(21,6);
    expect(geometry.pathElevationDeg).toBeCloseTo(0,10);expect(Math.abs(geometry.skyUp.x)).toBeCloseTo(1,10);
    const expected = integrateTurbulence(geometry.path);
    const oceanSurfaceGroup=new Group(), water=new Mesh(new BoxGeometry(),new MeshBasicMaterial());oceanSurfaceGroup.add(water);
    NodeMan.get.mockImplementation(id=>id==="targetTrackSwitchSmooth"?{p:()=>target}:id==="TerrainModel"?
        {getGroup:()=>null,UI:{oceanSurfaceGroup}}:undefined); NodeMan.iterate.mockImplementation(()=>{});
    Sit.thermalEnvironment=undefined;
    const view={camera,cameraNode:{},renderer:{},renderMode:"physicalThermal"};
    const adapter=createThermalViewAdapter(view);const render=jest.spyOn(adapter.pipeline,"render").mockImplementation(()=>{});
    adapter.render(new Scene(),7);
    expect(render.mock.calls[0][0].settings.turbulenceR0M).toBeCloseTo(expected.r0ReferenceM,12);
    expect(render.mock.calls[0][0].camera.fov).toBeCloseTo(native().verticalFovDeg,12);
    expect(render.mock.calls[0][0].settings.seaMode).toBe("statistical");
    expect(render.mock.calls[0][0].radianceAdapter.attributes(water,render.mock.calls[0][0].settings)).toEqual({sea:true});
    expect(render.mock.calls[0][0].radianceAdapter.attributes(water,{...render.mock.calls[0][0].settings,seaMode:"smooth"})).toEqual({temperatureK:288.15,emissivity:1});
    adapter.set("turbulenceMode","manual");adapter.set("turbulenceR0M",.7);adapter.render(new Scene(),7);
    expect(render.mock.calls[1][0].settings.turbulenceR0M).toBe(.7);
    jest.spyOn(adapter.pipeline,"readDetectorCounts").mockReturnValue(new Float32Array([100,200]));
    const other={render:jest.fn(),readDetectorCounts:()=>new Float32Array([100,201])};
    window.lookThermal.compareWith(other);adapter.render(new Scene(),7);
    expect(other.render).toHaveBeenCalledWith(render.mock.calls[2][0]);
    expect(window.lookThermal.comparison).toMatchObject({frame:7,width:640,height:512,maxCountDifference:1});
    expect(window.lookThermal.comparison.rmsCountDifference).toBeCloseTo(Math.sqrt(.5),12);
    // Playback can stop between video frames; the detector still receives a whole frame.
    adapter.render(new Scene(),126.5);expect(render.mock.calls.at(-1)[0].frame).toBe(126);
    // GPU pacing only for the main loop's draws; a comparison (or an export) reads the image right after rendering.
    expect(render.mock.calls.slice(0, 3).map(([inputs])=>inputs.pace)).toEqual([false,false,false]);
    Globals.inMainViewRender=true;
    try {
        adapter.render(new Scene(),7);expect(render.mock.calls.at(-1)[0].pace).toBe(true);
        window.lookThermal.compareWith(other);adapter.render(new Scene(),7);expect(render.mock.calls.at(-1)[0].pace).toBe(false);
    } finally {Globals.inMainViewRender=false;}
    adapter.dispose();expect(window.lookThermal).toBeUndefined();
});

test("refraction leaves physical range in the shader and restores shared uniforms on failure", () => {
    const camera=cameraFor(native());camera.position.set(6378137+1382,0,0);camera.lookAt(6378137+1382,125000,0);camera.updateMatrixWorld(true);
    const saved=terrestrialRefractionUniforms.uTerrK.value;
    expect(()=>withThermalRefraction(camera,{enabled:true,k:.176},()=>{expect(terrestrialRefractionUniforms.uTerrK.value).toBe(.176);throw Error("draw");})).toThrow("draw");
    expect(terrestrialRefractionUniforms.uTerrK.value).toBe(saved);
    const patched=patchTerrestrialRefractionVertexShader(radianceVertex).vertexShader;
    expect(patched).toContain("gl_Position = applyTerrestrialRefraction_clip(mvPosition)");
    expect(patched).toContain("vViewPosition = mvPosition.xyz");
    expect(patched).toContain("#include <logdepthbuf_vertex>");expect(radianceFragment).toContain("#include <logdepthbuf_fragment>");
    const point=new Vector3(6378137+1382,125000,0), options={enabled:true,k:.176};
    const adapter=createThermalSceneAdapter([],[],camera,options), relative=point.clone().applyMatrix4(camera.matrixWorldInverse);
    adapter.projectPoint(relative,camera);
    expect(relative.distanceTo(liftWorldPoint(terrestrialLiftContext(camera.position,options),point).applyMatrix4(camera.matrixWorldInverse))).toBeLessThan(1e-8);
});

test("object mods retain thermal overrides through rebuild and old mods restore inheritance", () => {
    const ObjectNode=methods("src/nodes/CNode3DObject.js","CNode3DObject",["modSerialize","modDeserialize"],
        {objectThermalState,resolveModelAlias:x=>x,copyProceduralModel:x=>x},class {modSerialize(){return {};}modDeserialize(){}});
    const node=Object.assign(new ObjectNode(),{common:{},geometryParams:{},materialParams:{},thermal:objectThermalState(),
        flock:{isDefault:()=>true,deserialize(){},setEnabled(){}},rebuild:jest.fn(),rebuildMaterial(){},show(){},syncForceAboveSurfaceGUI(){}});
    const binding=node.thermal;
    node.modDeserialize({thermal:{mode:"uniform",temperatureK:502,emissivity:.8,airTemperatureK:275,mach:.4,power:.8,zones:{jet_cavity:{temperatureK:760}}}});
    expect(node.thermal).toBe(binding);expect(node.rebuild).toHaveBeenCalled();
    const saved=node.modSerialize();expect(saved.thermal).toMatchObject({temperatureK:502,airTemperatureK:275,mach:.4,power:.8,zones:{jet_cavity:{temperatureK:760}}});
    saved.thermal.zones.jet_cavity.temperatureK=800;expect(node.thermal.zones.jet_cavity.temperatureK).toBe(760);
    node.modDeserialize({});expect(node.thermal).toEqual(objectThermalState());
    expect(node.thermal).toMatchObject({airTemperatureK:null,mach:null,power:null});
    node.modDeserialize({thermal:{mode:"inherit",temperatureK:293}});
    expect(node.thermal).toMatchObject({airTemperatureK:null,mach:null,power:null});
});

// Estimated synthetic scene inputs; expected standard temperature is calculated
// from the U.S. Standard Atmosphere lapse in tools/thermal/atmosphere.js.
function sceneVehicleFixture({altitudeM = 3200, velocity = new Vector3(0, 200, 0), simSpeed = 1} = {}) {
    const model = new Group(), group = new Group(); group.add(model);
    group.position.set(Globals.equatorRadius + altitudeM, 0, 0);
    const recipe = Object.freeze({parameters: Object.freeze({vehicleType:"aircraft",engineType:"jet"})});
    const track = {frames:61, p:jest.fn(f => new Vector3(Globals.equatorRadius + altitudeM, 0, 0)
        .addScaledVector(velocity, f * simSpeed / Sit.fps))};
    const node = {id:"airliner",isThermalObject:true,group,model,proceduralModel:{recipe},
        thermal:objectThermalState(), getSourceTrack:()=>track};
    return {node, track, recipe, atmosphere:thermalSceneAtmosphere(native()), sit:{fps:Sit.fps,frames:track.frames,simSpeed}};
}

test("vehicle altitude samples standard air and changed surface settings; track speed sets Mach at endpoints", () => {
    const {node,track,recipe,atmosphere,sit} = sceneVehicleFixture({simSpeed:2});
    const before = JSON.stringify(recipe);
    for (const frame of [0,30,60]) {
        const state = sceneVehicleThermal(node,frame,atmosphere,{sit});
        expect(state.airTemperatureK).toBeCloseTo(288.15 - .0065 * 3200,10);
        expect(state.speedMps).toBeCloseTo(200,10);
        expect(state.mach).toBeCloseTo(200 / Math.sqrt(1.4 * 287.05287 * state.airTemperatureK),10);
        expect(state.power).toBe(TURBOFAN_CLIMB_REFERENCE.powerFraction);
        expect(state.sources).toEqual({airTemperatureK:"standard",mach:"groundSpeed",power:"climbReference"});
    }
    expect(track.p.mock.calls.every(([f]) => f >= 0 && f < track.frames)).toBe(true);
    const warmer = thermalSceneAtmosphere({...native(),surfaceTemperatureK:298.15});
    expect(sceneVehicleThermal(node,30,warmer,{sit}).airTemperatureK).toBeCloseTo(298.15 - .0065 * 3200,10);
    // The profile is sampled at height above mean sea level, ellipsoid height minus the geoid height.
    expect(sceneVehicleThermal(node,30,atmosphere,{sit,geoidHeight:()=>-38.46}).airTemperatureK)
        .toBeCloseTo(288.15 - .0065 * (3200 + 38.46),10);
    expect(JSON.stringify(recipe)).toBe(before);
    expect(node.thermal).toEqual(objectThermalState());
    node.proceduralModel.recipe={...recipe,parameters:{...recipe.parameters,thermalAmbientK:340,thermalMach:4,thermalPower:.35}};
    const recipeState=sceneVehicleThermal(node,30,atmosphere,{sit});
    expect(recipeState.airTemperatureK).toBeCloseTo(267.35,10);
    expect(recipeState.mach).toBeCloseTo(200 / Math.sqrt(1.4 * 287.05287 * recipeState.airTemperatureK),10);
    expect(recipeState).toMatchObject({power:.35,sources:{power:"recipe"}});
    node.thermal.power=.7;
    expect(sceneVehicleThermal(node,30,atmosphere,{sit})).toMatchObject({power:.7,sources:{power:"override"}});
});

test("vehicle air follows sounding interpolation and temperature override also sets the Mach denominator", () => {
    const {node,sit} = sceneVehicleFixture();
    const sounding = {levels:[{geopotentialHeightM:2000,pressurePa:80000,temperatureK:280,relativeHumidityPct:40},
        {geopotentialHeightM:4000,pressurePa:60000,temperatureK:260,relativeHumidityPct:30}]};
    const atmosphere = thermalSceneAtmosphere({...native(),surfaceTemperatureK:330},sounding);
    const state = sceneVehicleThermal(node,30,atmosphere,{sit,atmosphereSource:"sounding"});
    expect(state.airTemperatureK).toBeCloseTo(280 + (260 - 280) * (3200 - 2000) / (4000 - 2000),10);
    expect(state.sources.airTemperatureK).toBe("sounding");
    node.thermal.airTemperatureK = 300;
    const overridden = sceneVehicleThermal(node,30,atmosphere,{sit});
    expect(overridden.mach).toBeCloseTo(200 / Math.sqrt(1.4 * 287.05287 * 300),10);
    node.thermal.mach = 0; node.thermal.power = 0;
    expect(sceneVehicleThermal(node,30,atmosphere,{sit})).toMatchObject({airTemperatureK:300,mach:0,power:0,
        sources:{airTemperatureK:"override",mach:"override",power:"override"}});
});

test("altitude wind is converted from east/north m/s, with explicit ground-speed and bound-wind fallbacks", () => {
    const {node,atmosphere,sit} = sceneVehicleFixture({velocity:new Vector3(0,210,30),simSpeed:2});
    const windField = {source:"igra2",sampleWindAtAltitude:jest.fn(()=>({u:10,v:30}))};
    meanSeaLevelOffset.mockReturnValue(25);
    try {
        const state = sceneVehicleThermal(node,30,atmosphere,{sit,windField});
        expect(windField.sampleWindAtAltitude).toHaveBeenCalledWith(0,0,3175);
        expect(state.speedMps).toBeCloseTo(200,10);
        expect(state.groundSpeedMps).toBeCloseTo(Math.hypot(210,30),10);
        expect(state.speedSource).toBe("windField");
        const wind = {windVectorAt:jest.fn(()=>new Vector3(0,10,30).multiplyScalar(sit.simSpeed/sit.fps))};
        node.inputs = {tilt:{isController:true,in:{wind}}};
        windField.sampleWindAtAltitude.mockReturnValue(null);
        expect(sceneVehicleThermal(node,30,atmosphere,{sit,windField})).toMatchObject({speedSource:"groundSpeed"});
        expect(wind.windVectorAt).not.toHaveBeenCalled();
        const bound = sceneVehicleThermal(node,30,atmosphere,{sit});
        expect(bound.speedSource).toBe("objectWind"); expect(bound.speedMps).toBeCloseTo(200,10);
        expect(wind.windVectorAt).toHaveBeenCalledWith(30,node.group.position);
        delete node.inputs; node.getSourceTrack=()=>null;
        expect(sceneVehicleThermal(node,30,atmosphere,{sit})).toMatchObject({mach:0,speedSource:"stationary"});
    } finally {meanSeaLevelOffset.mockReturnValue(0);}
});

test("look draw updates each inherited vehicle, reports used values and leaves recipe and mesh tags untouched", () => {
    const {node,recipe} = sceneVehicleFixture(), second = sceneVehicleFixture({altitudeM:1000}).node;
    second.id="second";second.thermal=objectThermalState({airTemperatureK:290,mach:.2,power:.6});
    const mesh = new Mesh(new BoxGeometry(),new MeshBasicMaterial()); mesh.userData.thermal={zone:"painted_skin"};node.model.add(mesh);
    const original=mesh.userData.thermal, before=JSON.stringify(recipe);
    const camera=cameraFor(native());camera.position.set(Globals.equatorRadius+100,0,0);camera.updateMatrixWorld(true);
    const view={camera,cameraNode:{},renderer:{},renderMode:"physicalThermal",div:document.createElement("div")};
    Sit.thermalEnvironment={turbulenceMode:"manual"};
    NodeMan.get.mockReturnValue(undefined); NodeMan.iterate.mockImplementation(fn=>{fn(node.id,node);fn(second.id,second);});
    const adapter=createThermalViewAdapter(view);
    jest.spyOn(adapter.pipeline,"render").mockImplementation(()=>{
        adapter.pipeline.hasFrame = true;
        adapter.pipeline.lastFrame = {opticsCache: {message: "Coarse optical preview; calculated kernel L1 bound: 2."}};
        const state=window.lookThermal.vehicles.find(v=>v.id===node.id);
        expect(mesh.userData.thermal.temperatureK).toBeCloseTo(recoveryTemperature(state.airTemperatureK,state.mach),10);
    });
    try {
        adapter.render(new Scene(),30);
        expect(window.lookThermal.vehicles).toHaveLength(2);
        expect(window.lookThermal.vehicles[1]).toMatchObject({id:"second",airTemperatureK:290,mach:.2,power:.6});
        expect(view.thermalStatus).toContain("air 267.35 K");
        expect(view.thermalStatus).toContain("Coarse optical preview; calculated kernel L1 bound: 2.");
        expect(view.thermalStatus).toContain("ground speed; no wind at altitude");
        expect(view.thermalStatus).toContain("power 0.900 (climb reference, estimated)");
        node.group.position.x=Globals.equatorRadius+5000; adapter.render(new Scene(),31);
        expect(window.lookThermal.vehicles[0].airTemperatureK).toBeCloseTo(288.15-.0065*5000,10);
        second.thermal.mode="uniform";adapter.render(new Scene(),32);
        expect(window.lookThermal.vehicles.map(v=>v.id)).toEqual([node.id]);
        expect(mesh.userData.thermal).toBe(original);expect(JSON.stringify(recipe)).toBe(before);
    } finally {adapter.dispose();Sit.thermalEnvironment=undefined;NodeMan.iterate.mockImplementation(()=>{});}
});

test("instance menu defaults to scene, creates numeric overrides, and resets without changing recipe values", () => {
    window.matchMedia ??= () => ({matches:false,addEventListener(){},removeEventListener(){}});
    const tooltip=Controller.prototype.tooltip;Controller.prototype.tooltip=function(){return this;};
    const gui=new GUI({autoPlace:false}), {node,atmosphere,sit,recipe}=sceneVehicleFixture();
    let values=sceneVehicleThermal(node,30,atmosphere,{sit});
    try {
        setupThermalVehicleControls(node,gui,()=>values);
        const controls=gui.controllersRecursive(), controller=key=>controls.find(c=>c.property===key);
        expect(controls).toHaveLength(6);
        for (const key of ["airTemperatureK","mach","power"]) {
            expect(controller(`${key}Source`).getValue()).toBe("scene");
            expect(controller(key)._disabled).toBe(true);
            controller(`${key}Source`).setValue("override");
            expect(controller(key)._disabled).toBe(false);
            expect(node.thermal[key]).toBe(values[key]);
        }
        controller("airTemperatureK").setValue(280);controller("mach").setValue(.1);controller("power").setValue(.4);
        expect(objectThermalState(JSON.parse(JSON.stringify(node.thermal)))).toMatchObject({airTemperatureK:280,mach:.1,power:.4});
        for (const key of ["airTemperatureK","mach","power"]) controller(`${key}Source`).setValue("scene");
        expect(node.thermal).toMatchObject({airTemperatureK:null,mach:null,power:null});
        values={...values,airTemperatureK:260};expect(controller("airTemperatureK").getValue()).toBe(260);
        expect(recipe.parameters).toEqual({vehicleType:"aircraft",engineType:"jet"});
    } finally {gui.destroy();Controller.prototype.tooltip=tooltip;}
});

test("the closed menu performs no thermal initialization, and its fields remain standard menu controllers",()=>{
    const control={name(){return this;},listen(){return this;},onChange:jest.fn().mockReturnThis()};
    const folder={_closed:true,close(){return this;},add:jest.fn(()=>control),onOpenClose:jest.fn()};
    const view={renderMode:"visible"};setupThermalMenu(view,{addFolder:()=>folder});
    expect(view._thermalAdapter).toBeUndefined();expect(view._thermalLoading).toBeUndefined();
    expect(folder.add).toHaveBeenCalledWith(view,"renderMode",expect.any(Object));
    const loader=fs.readFileSync(path.join(__dirname,"../src/rendering/ThermalLoader.js"),"utf8");
    const imports=parse(loader,{sourceType:"module"}).program.body.filter(n=>n.type==="ImportDeclaration").map(n=>n.source.value);
    expect(imports.some(value=>/tools\/|ThermalViewAdapter/.test(value))).toBe(false);
});

test("thermal look pre-render skips RGB reflection capture while preserving visible main behavior",()=>{
    const Lifecycle=methods("src/nodes/CNode3DObject.js","CNode3DObject",["preRender","applyViewScale","postRender"],{Globals:{objectScaleMain:1},effectiveRenderMode});
    const node=Object.assign(new Lifecycle(),{common:{},group:new Group(),baseScale:1,updateEnvMap:jest.fn()});
    node.preRender({id:"lookView",renderMode:"physicalThermal"});expect(node.updateEnvMap).not.toHaveBeenCalled();
    node.preRender({id:"mainView",renderMode:"visible"});expect(node.updateEnvMap).toHaveBeenCalledTimes(1);
});

test("shared schema controllers support setMenuValue/getMenuValue and keep coupled optics synchronized",()=>{
    window.matchMedia ??= () => ({matches:false,addEventListener(){},removeEventListener(){}});
    const tooltip=Controller.prototype.tooltip;Controller.prototype.tooltip=function(){return this;};
    const gui=new GUI({autoPlace:false});let settings=native();
    const controls=createThermalControls(gui,()=>settings,(key,value)=>{settings=normalizeSettings({...settings,[key]:value,
        fieldMode:key==="focalLengthM"?"focalLength":settings.fieldMode});},{translate:key=>key});
    const API=methods("src/CSitrecAPI.js","CSitrecAPI",["_setMenuValue","_getMenuValue"]);
    const api=Object.assign(new API(),{invalidateMenuDocCache(){},_resolveControl(menu,key){
        const controller=gui.controllersRecursive().find(c=>c.property===key);return {success:!!controller,controller};}});
    try {
        expect(api._setMenuValue("effects","focalLengthM",.8).success).toBe(true);
        expect(api._getMenuValue("effects","focalLengthM")).toEqual({success:true,value:.8});
        expect(settings.verticalFovDeg).toBeCloseTo(2*Math.atan(512*20e-6/(2*.8))*180/Math.PI,12);
        controls.refresh();expect(gui.controllersRecursive()).toHaveLength(THERMAL_PARAMETERS.length);
    } finally {controls.dispose();gui.destroy();Controller.prototype.tooltip=tooltip;}
});

// A synthetic camera-data row as the cameraState node returns it (frame, recorded mode, band, focal length in mm).
const cameraRow = (focalLengthMm, extra = {}) => ({index: 0, frame: 30, mode: "IR", band: "IR", focalLengthMm, zoom: 1, polarity: null, ...extra});

test("backward and forward field changes select the estimated optical step without changing saved optics", () => {
    const saved = native(), before = JSON.stringify(saved);
    // Agua's editor uses 4 and 0.8 degrees. Native detector coverage must stay
    // comparable across these fields, rather than shrinking fivefold at 4 deg.
    for (const [field, step] of [[.8, "675"], [4, "135"], [.4, "1012"], [20, "27"], [4, "135"], [.8, "675"]]) {
        const {settings, report} = thermalSettingsForViewField(saved, field);
        expect(settings.focalStep).toBe(step);
        expect(report).toEqual({focalLengthMm: Number(step), verticalFovDeg: field, reason: null});
        const coverage = settings.detectorWindow.height * settings.pixelPitchM /
            (2 * settings.focalLengthM * Math.tan(field * Math.PI / 360));
        expect(coverage).toBeGreaterThan(1); expect(coverage).toBeLessThan(1.1);
    }
    expect(JSON.stringify(saved)).toBe(before);
    for (const field of [NaN, 0, 180]) expect(thermalSettingsForViewField(saved, field)).toEqual({settings: saved, report: null});
    const free = normalizeSettings({...saved, focalStep: "free"}), fixed = settingsForPreset("ATFLIR");
    expect(thermalSettingsForViewField(free, 4).settings.focalStep).toBe("135");
    expect(thermalSettingsForViewField(fixed, 4)).toEqual({settings:fixed, report:null});
    const keep = normalizeSettings({...saved, pupilPolicy: "keepPupil"});
    expect(thermalSettingsForViewField(keep, 20)).toMatchObject({settings: keep,
        report: {focalLengthMm: 27, reason: expect.stringMatching(/numerical aperture/)}});
});

test("lens source survives sensor saves and the camera round trip", () => {
    const camera = {thermalSensor: {lensSource: "sensor"}}, sit = {};
    saveThermalSettings(native(), camera, sit);
    expect(camera.thermalSensor.lensSource).toBe("sensor");
    expect(sit.thermalEnvironment.lensSource).toBeUndefined();
    const Camera = methods("src/nodes/CNodeCamera.js", "CNodeCamera", ["modSerialize", "modDeserialize"], {
        Vector3, ECEFToLLAVD_radii: position => position,
    }, class {modSerialize() {return {};} modDeserialize() {}});
    const node = Object.assign(new Camera(), {camera: cameraFor(native()), resetCamera() {}, psfGlare: {}, thermalSensor: camera.thermalSensor});
    const saved = JSON.parse(JSON.stringify(node.modSerialize()));
    node.thermalSensor = undefined; node.modDeserialize(saved);
    expect(node.thermalSensor).toEqual(camera.thermalSensor);
    expect(node.thermalSensor).not.toBe(camera.thermalSensor);
});

test("camera data selects each lens step's focal length, pupil and window for one frame and never edits the saved settings", () => {
    const saved = normalizeSettings({...native(), polarity: "blackHot"}), before = JSON.stringify(saved);
    // Preset lens steps; hold f-number scales the estimated reference pupil (0.150 m at 0.675 m) with focal length.
    const steps = {27: [.027, .006, 640, 512], 135: [.135, .03, 640, 512], 675: [.675, .15, 640, 512], 1012: [1.012, .15 * 1.012 / .675, 480, 384]};
    for (const [step, [focalLengthM, apertureM, width, height]] of Object.entries(steps)) {
        const {settings, report} = thermalSettingsForCameraState(saved, cameraRow(Number(step)));
        expect(report).toMatchObject({lens: "step", reason: null, polarity: "saved"});
        expect(settings).toMatchObject({focalStep: step, polarity: "blackHot", detectorWindow: {width, height}});
        expect(settings.focalLengthM).toBeCloseTo(focalLengthM, 12); expect(settings.apertureM).toBeCloseTo(apertureM, 12);
        expect(settings.opticalSampling).toMatchObject({factor: 4, nyquistMet: true});
    }
    // The saved step and polarity: the same object, bit for bit. No data, or a visible-light row: unchanged too.
    expect(thermalSettingsForCameraState(saved, cameraRow(675)).settings).toBe(saved);
    expect(thermalSettingsForCameraState(saved, null)).toEqual({settings: saved, report: null});
    expect(thermalSettingsForCameraState(saved, cameraRow(200, {mode: "EOW", band: "EO", zoom: 2})).settings).toBe(saved);
    const white = thermalSettingsForCameraState(saved, cameraRow(1012, {polarity: "whiteHot"}));
    expect(white.settings.polarity).toBe("whiteHot"); expect(white.report.polarity).toBe("row");
    // Digital zoom reaches the sensor through the look camera's field of view, not twice.
    expect(thermalSettingsForCameraState(saved, cameraRow(1012, {zoom: 2})).settings.digitalZoom).toBe(saved.digitalZoom);
    expect(JSON.stringify(saved)).toBe(before);
    expect([27, 135, 675, 1012].map(step => lensStepValidated({...saved, focalStep: String(step)}))).toEqual([false, false, true, true]);
    expect(lensStepValidated({...saved, focalStep: "free"})).toBe(true);
});

test("a focal length that is no lens step, a preset without steps and an impossible pupil keep the saved lens", () => {
    const saved = native();
    const other = thermalSettingsForCameraState(saved, cameraRow(300, {polarity: "whiteHot"}));
    expect(other.report).toMatchObject({lens: "saved", reason: "notStep"});
    expect(other.settings).toMatchObject({focalStep: "675", focalLengthM: .675, polarity: "whiteHot"});
    const noSteps = settingsForPreset("ATFLIR");
    expect(thermalSettingsForCameraState(noSteps, cameraRow(1012))).toMatchObject({settings: noSteps, report: {reason: "noSteps"}});
    // Keep pupil with a short step: the saved pupil exceeds twice the focal length (numerical aperture above 1).
    const keep = normalizeSettings({...saved, pupilPolicy: "keepPupil"});
    const wide = thermalSettingsForCameraState(keep, cameraRow(27, {polarity: "whiteHot"}));
    expect(wide.report).toMatchObject({lens: "saved", reason: "invalid", message: expect.stringMatching(/numerical aperture/)});
    expect(wide.settings).toMatchObject({focalStep: "675", polarity: "whiteHot"});
    // Keep pupil at 135 mm is f/0.9: allowed, but the largest grid that fits cannot meet optical Nyquist.
    expect(thermalSettingsForCameraState(keep, cameraRow(135)).settings.opticalSampling).toMatchObject({factor: 4, nyquistMet: false});
});

test("the look draw applies camera data per frame, reports it, locks the driven controls and saves nothing", () => {
    window.matchMedia ??= () => ({matches:false,addEventListener(){},removeEventListener(){}});
    const tooltip=Controller.prototype.tooltip;Controller.prototype.tooltip=function(text){this._tooltip=text;return this;};
    const gui=new GUI({autoPlace:false});
    const camera=cameraFor(native());camera.position.set(Globals.equatorRadius+100,0,0);camera.updateMatrixWorld(true);
    const view={camera,cameraNode:{},renderer:{},renderMode:"physicalThermal",div:document.createElement("div"),_thermalFolder:gui};
    let row=null, optics={outsideValidatedDomain:false,quality:"full",message:""};
    NodeMan.get.mockImplementation(id=>id==="cameraState"?{stateAt:()=>row}:undefined); NodeMan.iterate.mockImplementation(()=>{});
    Sit.thermalEnvironment={turbulenceMode:"manual"};
    const adapter=createThermalViewAdapter(view);
    const render=jest.spyOn(adapter.pipeline,"render").mockImplementation(inputs=>
        Object.assign(adapter.pipeline,{hasFrame:true,settings:inputs.settings,lastFrame:{opticsCache:optics}}));
    const controller=key=>gui.controllersRecursive().find(c=>c.property===key);
    const readout=()=>view.thermalStatus, saved=()=>JSON.stringify([view.cameraNode,Sit.thermalEnvironment]);
    const driven=["focalStep","focalLengthM","verticalFovDeg","fieldMode","apertureM"];
    markSitchDirty.mockClear();
    try {
        const savedBefore=saved();
        adapter.render(new Scene(),40);
        const plain=render.mock.calls[0][0].settings;
        expect(plain.focalStep).toBe("675"); expect(readout()).not.toContain("Camera data");
        for (const key of driven) expect(controller(key)._disabled).toBe(true);
        expect(controller("polarity")._disabled).toBe(false);
        expect(readout()).toContain("675 mm estimated");
        // The new lens step's optics are not ready: the image keeps the previous lens's kernels and says so.
        row=cameraRow(1012,{polarity:"whiteHot"}); optics={outsideValidatedDomain:true,quality:"retained",message:"Previous optical kernel retained while rebuilding."};
        adapter.render(new Scene(),40);
        const inputs=render.mock.calls[1][0];
        expect(inputs.settings).toMatchObject({focalStep:"1012",focalLengthM:1.012,polarity:"whiteHot",detectorWindow:{width:480,height:384}});
        expect(inputs.presentation.nativeVerticalFovDeg).toBeCloseTo(2*Math.atan(512*20e-6/(2*1.012))*180/Math.PI,12);
        // The look camera keeps its field (the 675 mm native field here), so the 1012 mm detector covers 675/1012 of it.
        expect(inputs.presentation.scale[1]).toBeCloseTo(1.012/.675,12);
        expect(readout()).toContain("Camera data: IR · 1012 mm · White hot · row at frame 30");
        expect(readout()).toContain("The 1012 mm optics are still being built; until they are ready, this frame uses the optics of the previous lens (675 mm).");
        for (const key of [...driven,"polarity"]) {
            expect(controller(key)._disabled).toBe(true); expect(controller(key)._tooltip).toContain("Set by the per-frame camera data");
        }
        expect(controller("pupilPolicy")._disabled).toBe(false); expect(controller("sensorAltitudeM")._disabled).toBe(true);
        optics={outsideValidatedDomain:false,quality:"full",message:""};
        adapter.render(new Scene(),40); expect(readout()).not.toContain("previous lens");
        // A wide step without measured values, and a row without polarity (the saved polarity applies).
        row=cameraRow(135); adapter.render(new Scene(),41);
        expect(readout()).toContain("Camera data: IR · 135 mm · Black hot (saved) · row at frame 30");
        expect(readout()).toContain("Lens step 135 mm has no measured values in this sensor preset, so this frame is outside the validated lens steps.");
        expect(controller("polarity")._disabled).toBe(false); expect(controller("focalStep")._disabled).toBe(true);
        // A focal length that is no lens step keeps the saved lens, which stays editable.
        row=cameraRow(300); adapter.render(new Scene(),42);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("675");
        expect(readout()).toContain("The camera data's 300 mm is not a lens step of this sensor preset; the saved lens (675 mm) is kept.");
        expect(controller("focalStep")._disabled).toBe(false);
        // Without data the frame's settings are bit-identical to the first draw.
        row=null; adapter.render(new Scene(),40);
        expect(JSON.stringify(render.mock.calls.at(-1)[0].settings)).toBe(JSON.stringify(plain));
        expect(saved()).toBe(savedBefore); expect(markSitchDirty).not.toHaveBeenCalled();
        expect(window.lookThermal.cameraData).toEqual({settings:expect.any(Object),report:null});
    } finally {adapter.dispose();gui.destroy();Controller.prototype.tooltip=tooltip;Sit.thermalEnvironment=undefined;
        NodeMan.get.mockReset();NodeMan.iterate.mockImplementation(()=>{});}
});

test("field-following lens uses the base field, respects camera data and permits a persistent manual lens", () => {
    const camera = cameraFor(native()); camera.position.set(Globals.equatorRadius + 100, 0, 0); camera.updateMatrixWorld(true);
    const view = {camera, cameraNode: {}, renderer: {}, div: document.createElement("div")};
    let row = null;
    NodeMan.get.mockImplementation(id => id === "cameraState" ? {stateAt: () => row} : undefined);
    NodeMan.iterate.mockImplementation(() => {}); Sit.thermalEnvironment = {turbulenceMode: "manual"};
    const adapter = createThermalViewAdapter(view);
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(inputs => Object.assign(adapter.pipeline,
        {hasFrame: true, settings: inputs.settings, lastFrame: {opticsCache: {outsideValidatedDomain: false}}}));
    try {
        camera.fov = 4; camera.zoom = 3; camera.aspect = 2; camera.updateProjectionMatrix();
        camera.projectionMatrix.elements[8] = .2; camera.projectionMatrix.elements[5] /= 2;
        adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("135");
        expect(window.lookThermal.fieldLens.report.verticalFovDeg).toBe(4);
        expect(view.cameraNode.thermalSensor).toBeUndefined();
        adapter.set("groundTemperatureSpanK", 12);
        expect(view.cameraNode.thermalSensor.lensSource).toBe("view");
        adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("135");
        adapter.set("lensSource", "sensor");
        expect(view.cameraNode.thermalSensor).toMatchObject({focalStep: "135", lensSource: "sensor"});
        adapter.set("lensSource", "view");
        row = cameraRow(1012); adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("1012");
        expect(window.lookThermal.fieldLens).toBeNull();
        row = null; adapter.set("lensSource", "sensor"); adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("135");
        adapter.set("groundTemperatureSpanK", 12);
        expect(view.cameraNode.thermalSensor.lensSource).toBe("sensor");
        adapter.set("lensSource", "view"); adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("135");
        adapter.set("focalStep", "675"); adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("675");
        expect(view.cameraNode.thermalSensor.lensSource).toBe("sensor");
        adapter.set("focalStep", "free"); adapter.set("lensSource", "view"); adapter.render(new Scene(), 444, 4);
        expect(render.mock.calls.at(-1)[0].settings.focalStep).toBe("135");
        expect(() => adapter.set("lensSource", "invalid")).toThrow(/lens source/);
    } finally {adapter.dispose(); Sit.thermalEnvironment = undefined; NodeMan.get.mockReset(); NodeMan.iterate.mockImplementation(() => {});}
});
