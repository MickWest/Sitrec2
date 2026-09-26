import {Box3, BufferGeometry, PerspectiveCamera, Vector3} from "three";
import {GLTFExporter} from "three/addons/exporters/GLTFExporter.js";
import {createVehicleRecipe} from "../tools/vehicles/recipe.js";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {exportVehicleGLB} from "../tools/vehicles/exportGLB.js";
import {generateVehicle as nativeGenerate} from "../src/procedural/VehicleGenerator";
import {bakeVehicle as nativeBake} from "../src/procedural/VehicleExporter";
import {fitVehicleCamera} from "../tools/vehicles/studio.js";
import {createVehicleFilter, VEHICLE_TYPES} from "../tools/vehicles/catalog.js";
import {readVehicleRecipeFile} from "../tools/vehicles/files.js";
import {vehicleFileStem} from "../tools/vehicles/recipeFormat.js";

// GLTFExporter uses the browser FileReader API to package its binary output.
const previousFileReader = global.FileReader;
beforeAll(() => {global.FileReader = class {
    readAsArrayBuffer(blob) {blob.arrayBuffer().then(result => {this.result = result; this.onloadend?.();});}
};});
afterAll(() => {global.FileReader = previousFileReader;});

function glbJSON(bytes) {
    const view = new DataView(bytes);
    expect(view.getUint32(0,true)).toBe(0x46546c67);
    return JSON.parse(new TextDecoder().decode(bytes.slice(20,20+view.getUint32(12,true))));
}

test("standalone export and native freezing produce identical GLBs with editable and motion metadata",async () => {
    expect(nativeGenerate).toBe(generateVehicle);
    const preset = PRESETS.find(p => p.id === "heli-r44");
    const recipe = createVehicleRecipe({...preset.parameters,brandLivery:"sitrec"},"Shared helicopter",preset.id);
    const direct = await exportVehicleGLB(recipe), native = await nativeBake(recipe);
    expect(Buffer.from(native)).toEqual(Buffer.from(direct.bytes));
    expect(direct.size.z).toBeGreaterThan(5);
    const json = glbJSON(native);
    expect(json.nodes.find(node => node.extras?.sitrecVehicleRecipe).extras.sitrecVehicleRecipe).toEqual(recipe);
    expect(json.nodes.some(node => node.extras?.vehicleSpin?.axis === "y")).toBe(true);
    expect(json.nodes.some(node => node.extras?.vehicleLight && node.extras?.role)).toBe(true);
});

test("an export failure disposes the clean export model",async () => {
    const exporter = jest.spyOn(GLTFExporter.prototype,"parseAsync").mockRejectedValueOnce(new Error("Export unavailable"));
    const dispose = jest.spyOn(BufferGeometry.prototype,"dispose");
    try {
        await expect(exportVehicleGLB(createVehicleRecipe(PRESETS[0].parameters))).rejects.toThrow("Export unavailable");
        expect(dispose).toHaveBeenCalled();
    } finally {exporter.mockRestore(); dispose.mockRestore();}
});

test.each(["perspective","side","top","front"])("shared camera fitting contains a long aircraft in %s view",view => {
    for (const aspect of [.6,2.4]) {
        const bounds = new Box3(new Vector3(-35,-3,-40),new Vector3(35,12,40));
        const camera = new PerspectiveCamera(36,aspect,.01,3000);
        const controls = {target:new Vector3(),enableDamping:true,update() {camera.lookAt(this.target); camera.updateMatrixWorld(true);}};
        fitVehicleCamera(camera,controls,bounds,{view,paddingX:1.25,paddingY:1.55});
        expect(controls.enableDamping).toBe(true);
        for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
            const projected = new Vector3(x,y,z).project(camera);
            expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(projected.z)).toBeLessThanOrEqual(1);
        }
    }
});

test("the shared catalog filter handles punctuation, type, region and civil presets",() => {
    const matches = PRESETS.filter(createVehicleFilter({query:"737 800",kind:"aircraft",region:"civil"}));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every(p => !p.military && p.name.includes("737-800"))).toBe(true);
    for (const kind of Object.keys(VEHICLE_TYPES)) expect(PRESETS.filter(createVehicleFilter({kind})).length).toBeGreaterThan(0);
    expect(PRESETS.filter(createVehicleFilter({query:"China",region:"China"})).every(p => p.region === "China")).toBe(true);
});

test("shared file import migrates legacy designs and enforces the same size and revision checks",async () => {
    const legacy = {format:"sitrec-procedural-aircraft",version:1,name:"Imported",parameters:{length:31}};
    const file = {size:200,text:async () => JSON.stringify(legacy)};
    expect((await readVehicleRecipeFile(file)).parameters.length).toBe(31);
    await expect(readVehicleRecipeFile({...file,size:1000001})).rejects.toThrow("1 MB");
    const recipe = {...createVehicleRecipe(PRESETS[0].parameters),generatorRevision:999};
    await expect(readVehicleRecipeFile({...file,text:async () => JSON.stringify(recipe)})).rejects.toThrow("revision 999");
    expect(vehicleFileStem("../My vehicle / draft")).toBe("My-vehicle-draft");
});
