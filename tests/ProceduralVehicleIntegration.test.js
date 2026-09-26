import {Color, Group} from "three";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe, readVehicleRecipe} from "../tools/vehicles/recipe.js";
import {copyProceduralModel, copyVehicleRecipe} from "../tools/vehicles/recipeFormat.js";
import {generateVehicle} from "../src/procedural/VehicleGenerator";
import {disposeVehicle} from "../tools/vehicles/vehicle.js";
import {collectVehicleSpinners, poseVehicleSpinners} from "../src/procedural/VehicleAnimation";
import {captureVehicleLightOverrides, applyVehicleLightOverrides, vehicleLightState} from "../src/procedural/VehicleLightState";
import {proceduralObjectMethods} from "../src/nodes/CNode3DObjectProcedural";
import {Globals, FileManager} from "../src/Globals";
import {loadProceduralVehicle, exportProceduralVehicle, openVehicleBrowser} from "../src/procedural/VehicleLoader";
import {loadModelAsset} from "../src/ModelLoader";
import {disposeScene} from "../src/threeExt";
import {refreshVehicleBakeUsage} from "../src/procedural/VehicleBakeAssets";
import fs from "fs";
import path from "path";

jest.mock("../src/Globals", () => ({Globals:{pendingActions:0,loadGeneration:1},Sit:{fps:30,simSpeed:1},
    markSitchDirty:jest.fn(),setRenderOne:jest.fn(),FileManager:{UniqueName:jest.fn(name=>name),add:jest.fn(),list:{}}}));
jest.mock("../src/ModelLoader", () => ({loadModelAsset:jest.fn()}));
jest.mock("../src/threeExt", () => ({disposeScene:jest.fn()}));
jest.mock("../src/showError", () => ({showError:jest.fn()}));
jest.mock("../src/procedural/VehicleLoader", () => ({loadProceduralVehicle:jest.fn(),exportProceduralVehicle:jest.fn(),openVehicleBrowser:jest.fn()}));

const recipe = (id="737",changes={}) => {
    const preset = PRESETS.find(p=>p.id===id);
    return createVehicleRecipe({...preset.parameters,...changes},`${preset.name} custom`,id);
};
const asset = () => ({scene:new Group(),format:"procedural"});
const deferred = () => {let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function object(value=recipe()) {
    const target = {...proceduralObjectMethods,proceduralModel:{mode:"procedural",recipe:value},modelOrGeometry:"model",lights:[],
        vehicleLightOverrides:{},vehicleAnimation:true,vehicleControls:{freeze:{disable:jest.fn(),enable:jest.fn()}},
        updateVehicleControls:jest.fn(),rebuildBoundingBox:jest.fn(),common:{applyMaterial:true},modelLengthNode:{setValue:jest.fn()}};
    target.installModelAsset=jest.fn(a=>{target.model=a.scene;target.configureVehicleModel(a);});
    target.rebuild=jest.fn(()=>target.rebuildProceduralModel());
    return target;
}
beforeEach(()=>{jest.clearAllMocks();Globals.pendingActions=0;Globals.loadGeneration=1;FileManager.list={};});

test.each(["737","heli-r44","road-dump","drone-mini4pro","balloon-hotair"])("recipe snapshot regenerates %s independently of the preset catalog",id=>{
    // Catalog IDs differ across manufacturers; pick a representative if this alias is absent.
    const preset=PRESETS.find(p=>p.id===id) || PRESETS.find(p=>p.vehicleType===(id.startsWith("drone")?"drone":"balloon"));
    const original=createVehicleRecipe({...preset.parameters,brandLivery:"sitrec"},"Custom","removed-catalog-id");
    const restored=readVehicleRecipe(JSON.parse(JSON.stringify(original)));
    expect(restored).toEqual(original);
    const model=generateVehicle(restored);
    expect(model.scene.userData.sitrecVehicleRecipe).toEqual(original);
    expect(model.scene.children.length).toBeGreaterThan(0);disposeVehicle(model.scene);
});
test("legacy recipes migrate; unsupported generators fail without interpreting new parameters",()=>{
    const legacy={format:"sitrec-procedural-aircraft",version:1,name:"Legacy",parameters:{length:31}};
    expect(readVehicleRecipe(legacy).parameters.length).toBe(31);
    const future={...recipe(),generatorRevision:99};
    expect(()=>readVehicleRecipe(future)).toThrow(/revision 99/);
    expect(copyProceduralModel({mode:"frozen",recipe:future,file:"permanent.glb"}).recipe.generatorRevision).toBe(99);
    expect(()=>copyVehicleRecipe({...recipe(),parameters:{length:Infinity}})).toThrow(/invalid/);
    expect(()=>copyVehicleRecipe({...recipe(),parameters:[]})).toThrow();
});
test("every catalog entry has a small, pre-rendered thumbnail",()=>{
    for (const preset of PRESETS) {
        const bytes=fs.readFileSync(path.join(__dirname,"../tools/vehicles/thumbnails",`${preset.id}.jpg`));
        expect(bytes.subarray(0,2).toString("hex")).toBe("ffd8");
        expect(bytes.length).toBeGreaterThan(1000);expect(bytes.length).toBeLessThan(50000);
    }
});
test("unused generated bakes do not inflate recipe-only saves; shared bakes remain available",()=>{
    const files={"baked.glb":{proceduralBake:true},"import.glb":{dynamicLink:true}};
    const nodes={one:{data:{modelOrGeometry:"model",proceduralModel:{mode:"procedural",recipe:recipe()}}}};
    refreshVehicleBakeUsage(files,nodes);expect(files["baked.glb"].skipSerialization).toBe(true);
    expect(files["import.glb"].skipSerialization).toBeUndefined();
    nodes.two={data:{modelOrGeometry:"model",proceduralModel:{mode:"frozen",file:"baked.glb"}}};
    refreshVehicleBakeUsage(files,nodes);expect(files["baked.glb"].skipSerialization).toBe(false);
});
test("moving parts use absolute frame time, including backwards scrubbing and disabled animation",()=>{
    const model=generateVehicle(recipe("heli-r44"));
    const parts=collectVehicleSpinners(model.scene);expect(parts.length).toBeGreaterThan(0);
    poseVehicleSpinners(parts,2,true);const first=parts.map(p=>p.rotation[p.userData.vehicleSpin.axis]);
    poseVehicleSpinners(parts,9,true);poseVehicleSpinners(parts,2,true);
    expect(parts.map(p=>p.rotation[p.userData.vehicleSpin.axis])).toEqual(first);
    poseVehicleSpinners(parts,2,false);expect(parts.every(p=>p.rotation[p.userData.vehicleSpin.axis]===p.userData.vehicleSpin.rest)).toBe(true);
    disposeVehicle(model.scene);
});
test("light overrides preserve edits while untouched fields follow revised design defaults",()=>{
    const node={light:{name:"Left Position Red",color:new Color("red"),intensity:500},lightVisible:true,lightIlluminates:false};
    const baseline={[node.light.name]:vehicleLightState(node)};
    node.light.intensity=1200;node.lightVisible=false;
    const overrides=captureVehicleLightOverrides([node],baseline);
    expect(overrides[node.light.name]).toEqual({intensity:1200,visible:false});
    const target={light:{name:node.light.name},intensityControl:{setValue:jest.fn()},lightVisibleControl:{setValue:jest.fn()}};
    applyVehicleLightOverrides([target],overrides);
    expect(target.intensityControl.setValue).toHaveBeenCalledWith(1200);
    expect(target.lightVisibleControl.setValue).toHaveBeenCalledWith(0);
    node.light.intensity=500;expect(captureVehicleLightOverrides([node],baseline,overrides)[node.light.name]).toEqual({visible:false});
});
test("asynchronous model swaps install only the latest request and balance pending actions",async()=>{
    const a=deferred(),b=deferred();loadProceduralVehicle.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const target=object();target.rebuildProceduralModel();const first=target._vehicleReady;
    target.proceduralModel.recipe=recipe("heli-r44");target.rebuildProceduralModel();const second=target._vehicleReady;
    expect(Globals.pendingActions).toBe(2);await Promise.resolve();
    const latest=asset();b.resolve(latest);await second;
    const stale=asset();a.resolve(stale);await first;
    expect(target.installModelAsset).toHaveBeenCalledTimes(1);expect(target.model).toBe(latest.scene);
    expect(disposeScene).toHaveBeenCalledWith(stale.scene);expect(Globals.pendingActions).toBe(0);
});
test.each(["disposed","generation","geometry"])("a pending load is discarded after %s",async reason=>{
    const pending=deferred();loadProceduralVehicle.mockReturnValueOnce(pending.promise);
    const target=object();target.rebuildProceduralModel();await Promise.resolve();
    if(reason==="disposed")target._vehicleDisposed=true;
    if(reason==="generation")Globals.loadGeneration++;
    if(reason==="geometry")target.modelOrGeometry="geometry";
    const loaded=asset();pending.resolve(loaded);await target._vehicleReady;
    expect(target.installModelAsset).not.toHaveBeenCalled();expect(disposeScene).toHaveBeenCalledWith(loaded.scene);expect(Globals.pendingActions).toBe(0);
});
test("synchronous loader failures preserve the displayed model and expose retry without blocking sitch loading",async()=>{
    const log=jest.spyOn(console,"error").mockImplementation(()=>{});
    loadProceduralVehicle.mockImplementationOnce(()=>{throw new Error("Unavailable");});
    const target=object();target.model=new Group();const previous=target.model;
    target.rebuildProceduralModel();await target._vehicleReady;
    expect(target.model).toBe(previous);expect(target._vehicleLoadFailed).toBe(true);expect(Globals.pendingActions).toBe(0);log.mockRestore();
});
test("frozen models load through the asset manager even for an unavailable generator revision",async()=>{
    const target=object();target.proceduralModel={mode:"frozen",file:"frozen.glb",recipe:{...recipe(),generatorRevision:99}};
    loadModelAsset.mockResolvedValueOnce(asset());target.rebuildProceduralModel();await target._vehicleReady;
    expect(loadModelAsset).toHaveBeenCalledWith("frozen.glb");expect(loadProceduralVehicle).not.toHaveBeenCalled();expect(Globals.pendingActions).toBe(0);
});
test("freeze registers the GLB as a dynamic asset and retains the editable snapshot",async()=>{
    const target=object(),original=target.proceduralModel.recipe,bytes=new ArrayBuffer(24);
    exportProceduralVehicle.mockResolvedValueOnce(bytes);loadModelAsset.mockResolvedValueOnce(asset());
    FileManager.add.mockImplementationOnce(id=>{FileManager.list[id]={data:bytes,original:bytes};});
    await target.freezeVehicle();
    expect(target.proceduralModel.mode).toBe("frozen");expect(target.proceduralModel.recipe).toEqual(original);
    expect(FileManager.list[target.proceduralModel.file]).toMatchObject({dynamicLink:true,dataType:"glb"});
    expect(target.vehicleControls.freeze.enable).toHaveBeenCalled();expect(Globals.pendingActions).toBe(0);
});
test("a freeze finishing after the source changes does not create an orphan asset",async()=>{
    const pending=deferred();exportProceduralVehicle.mockReturnValueOnce(pending.promise);
    const target=object(),freeze=target.freezeVehicle();target.proceduralModel.recipe=recipe("heli-r44");
    pending.resolve(new ArrayBuffer(24));await freeze;expect(FileManager.add).not.toHaveBeenCalled();
});
test("a dialog finishing its lazy load after object disposal is closed",async()=>{
    const pending=deferred(),dialog={dispose:jest.fn()};openVehicleBrowser.mockReturnValueOnce(pending.promise);
    const target=object(),opening=target.openVehicleDesigner(true);target._vehicleDisposed=true;
    pending.resolve(dialog);await opening;expect(dialog.dispose).toHaveBeenCalled();expect(target._vehicleDialog).toBeUndefined();
});
test("editing preserves independent object size/material settings; selecting a new preset uses native dimensions",async()=>{
    loadProceduralVehicle.mockImplementation(()=>Promise.resolve(asset()));
    const target=object();target.applyVehicleRecipe(recipe("737",{length:47}),{preserveObjectSettings:true});await target._vehicleReady;
    expect(target.modelLengthNode.setValue).not.toHaveBeenCalled();expect(target.common.applyMaterial).toBe(true);
    target.applyVehicleRecipe(recipe("heli-r44"));await target._vehicleReady;
    expect(target.modelLengthNode.setValue).toHaveBeenCalledWith(0);expect(target.common.applyMaterial).toBe(false);
});
