import {createHash} from "crypto";
import {Box3, PerspectiveCamera, Quaternion, Raycaster, Vector3} from "three";
import {PRESETS} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe, readVehicleRecipe} from "../tools/vehicles/recipe.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {disposeVehicle} from "../tools/vehicles/vehicle.js";
import {VEHICLE_THERMAL_GROUP, vehicleThermalDefaults} from "../tools/vehicles/thermalTags.js";
import {configureSensorCamera, detectorPixelAt, detectorStatistics, normalizeSensorView,
    resolveVehicleThermal, withThermalVehicle} from "../tools/vehicles/thermalPreview.js";
import {recoveryTemperature, resolveSignatures, ZONE_TABLE} from "../tools/thermal/signatures.js";
import {settingsForPreset} from "../tools/thermal/thermalSchema.js";

function recipe(id, changes = {}) {
    const preset = PRESETS.find(item => item.id === id);
    return createVehicleRecipe({...preset.parameters, ...changes}, preset.name, id);
}
function meshes(root) {const result = []; root.traverse(mesh => {if (mesh.isMesh) result.push(mesh);}); return result;}

test("A340-600 has four aft-facing separate-flow outlets at recipe positions", () => {
    const model = generateVehicle(recipe("a340-600", {thermalAmbientK: 239.40, thermalPower: .90})), p = model.recipe.parameters;
    try {
        const engines = model.root.children.filter(part => /^Engine \d+$/.test(part.name));
        expect(engines).toHaveLength(4); expect(model.thermalAnchors).toHaveLength(4);
        for (const [engineIndex, engine] of engines.entries()) {
            const pair = Math.floor(engineIndex / 2), side = engineIndex % 2 ? -1 : 1;
            const x = p.span / 2 * (p.engineSpacing + pair * p.engineStep) / 100;
            expect(engine.position.x).toBeCloseTo(side * x, 9);
            // Published aircraft planning document: engine centers at 9.37 m and 19.27 m.
            expect(Math.abs(engine.position.x - side * [9.37, 19.27][pair])).toBeLessThan(0.01);
            expect(engine.position.y).toBeCloseTo(p.diameter / 2 * p.bodyHeight * p.wingHeight + Math.tan(p.dihedral * Math.PI / 180) * x - p.engineDiameter * p.engineDrop, 9);
            const originalExhaust = engine.getObjectByName("Exhaust"), nacelle = engine.getObjectByName("Nacelle"), anchor = model.thermalAnchors[engineIndex];
            const cavity = anchor.cavity;
            expect(nacelle.userData.thermal.zone).toBe("nacelle_skin");
            expect(originalExhaust.userData.thermalHidden).toBe(true);
            expect(cavity.userData.thermal.zone).toBe("turbofan_cavity");
            expect(anchor.wall.userData.thermal.zone).toBe("turbofan_core_nozzle");
            expect(cavity.position.toArray()).toEqual([0, 0, -p.engineLength / 2]);
            expect(cavity.getWorldPosition(new Vector3()).distanceTo(engine.position.clone().add(new Vector3(0, 0, -p.engineLength / 2)))).toBeLessThan(1e-9);
            expect(new Vector3(0, 0, 1).applyQuaternion(cavity.getWorldQuaternion(new Quaternion())).z).toBeCloseTo(-1);
            expect(meshes(engine).filter(mesh => mesh.userData.thermal.zone === "hot_outlet")).toHaveLength(1);
            expect(meshes(engine).filter(mesh => mesh.userData.thermal.zone === "turbofan_cavity")).toHaveLength(1);
            expect(anchor.wall.visible).toBe(false);
            // The center hits the plug; an annular sightline hits the effective cavity.
            withThermalVehicle(model, () => {
                const center = cavity.getWorldPosition(new Vector3());
                const ray = new Raycaster(center.clone().add(new Vector3(.1, 0, -100)), new Vector3(0, 0, 1));
                const visible = meshes(engine).filter(mesh => mesh.visible);
                expect(originalExhaust.visible).toBe(false);
                expect(ray.intersectObjects(visible, false)[0].object).toBe(anchor.plug);
                ray.ray.origin.x += .4;
                expect(ray.intersectObjects(visible, false)[0].object).toBe(cavity);
            });
        }
        expect(resolveVehicleThermal(model.recipe).resolveZone("turbofan_cavity").temperatureK).toBeCloseTo(750, 8);
    } finally {disposeVehicle(model.root);}
});

test.each(["a340-600", "cessna", "atr", "heli-r44", "heli-h145", "mil-v22", "mil-harrier", "mil-f16c",
    "drone-mavic3", "balloon-hotair", "balloon-foil-round", "balloon-lantern-white", "road-sedan", "road-dump"])("every generated mesh in %s has a known zone, including livery and lamps", id => {
    const model = generateVehicle(recipe(id, {brandLivery: "sitrec"}));
    try {
        const known = new Set(ZONE_TABLE.map(zone => zone.id));
        expect(meshes(model.root).length).toBeGreaterThan(0);
        for (const mesh of meshes(model.root)) expect({name: mesh.name, valid: known.has(mesh.userData.thermal?.zone)}).toEqual({name: mesh.name, valid: true});
    } finally {disposeVehicle(model.root);}
});

// Version-1 visible vertex buffers, indices and world transforms before thermal metadata.
const visibleGeometryHashes = {
    "a340-600": "e7c7b56e3d8890a95dc8eeb94247efe96f1b91e9e92c41c129290278a21fdc52",
    "heli-r44": "b8bcee73244d5bcf06e94e4a4269deac98cad10f5775f16c4d5534beb53fd967",
    "road-sedan": "49dd3aeccd1f629e128ede76ef718f2aa1afa5d66cddbf153bccae49efb80248",
    "drone-mavic3": "b8788a062a63ccc60345f9ff26ad4fdd38bd0c147fcd66112919db9c3de2ac81",
    "balloon-hotair": "2f6b119f03bd1bad215467776baf244438921b969ae52bee67fb51b441a4cc96",
};
// A recipe saved before a later preset correction keeps the values it was saved with. These
// restore what each preset held when its hash above was recorded.
const savedBeforeCorrection = {"a340-600": {engineSpacing: 28}};
test.each(Object.keys(visibleGeometryHashes))("old %s recipe gains defaults and round-trips the same visible geometry", id => {
    const old = recipe(id, savedBeforeCorrection[id]);
    for (const field of VEHICLE_THERMAL_GROUP.fields) delete old.parameters[field.key];
    // engineStep did not exist when these recipes were saved; its default keeps their engines in place.
    delete old.parameters.engineStep;
    const loaded = readVehicleRecipe(JSON.parse(JSON.stringify(old)));
    expect(loaded.version).toBe(1); expect(loaded.generatorRevision).toBe(1);
    expect(loaded.parameters).toMatchObject(vehicleThermalDefaults(old.parameters));
    const saved = createVehicleRecipe(loaded.parameters, loaded.name, loaded.presetId);
    expect(readVehicleRecipe(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const model = generateVehicle(saved);
    try {
        const hash = createHash("sha256");
        model.root.traverseVisible(mesh => {
            if (!mesh.isMesh) return;
            hash.update(mesh.name);
            for (const attribute of Object.values(mesh.geometry.attributes)) hash.update(Buffer.from(attribute.array.buffer));
            if (mesh.geometry.index) hash.update(Buffer.from(mesh.geometry.index.array.buffer));
            hash.update(JSON.stringify(mesh.matrixWorld.elements));
        });
        expect(hash.digest("hex")).toBe(visibleGeometryHashes[id]);
    } finally {disposeVehicle(model.root);}
});

test("vehicle thermal edits persist without sensor settings and change the resolved signature", () => {
    const cold = recipe("a340-600", {thermalPower: 0, thermalMach: 0, thermalEmissivity: .42, rangeM: 300000});
    const restored = readVehicleRecipe(JSON.parse(JSON.stringify(cold)));
    expect(restored).toEqual(cold); expect(restored.parameters.rangeM).toBeUndefined();
    const resolved = resolveVehicleThermal(restored);
    expect(resolved.resolveZone("turbofan_cavity").temperatureK).toBe(220);
    expect(resolved.airframe.emissivity).toBe(.42);
});

test("IR draw restoration survives failure, with no duplicate emitting nacelle", () => {
    const model = generateVehicle(recipe("a340-600", {thermalAmbientK: 239.40, thermalPower: .90}));
    const before = meshes(model.root).map(mesh => [mesh, mesh.visible, mesh.userData.thermal]);
    try {
        expect(() => withThermalVehicle(model, () => {
            expect(model.root.getObjectByName("Nacelle").visible).toBe(false);
            expect(model.thermalAnchors[0].wall.visible).toBe(true);
            expect(model.thermalAnchors[0].cavity.userData.thermal.temperatureK).toBeCloseTo(750);
            throw new Error("Draw failed");
        })).toThrow("Draw failed");
        for (const [mesh, visible, thermal] of before) {expect(mesh.visible).toBe(visible); expect(mesh.userData.thermal).toBe(thermal);}
    } finally {disposeVehicle(model.root);}
});

// Estimated synthetic operating points, chosen to distinguish per-draw values
// from saved inputs; expected temperatures use the shared signature equations.
test.each(["a340-600", "balloon-hotair"])("%s accepts per-draw air, Mach and power without changing Designer inputs", id => {
    const model=generateVehicle(recipe(id,{thermalAmbientK:293,thermalMach:.8,thermalPower:.65}));
    const originalRecipe=JSON.stringify(model.recipe), designer=resolveVehicleThermal(model.recipe);
    const before=meshes(model.root).map(mesh=>[mesh,mesh.visible,mesh.userData.thermal]);
    const values={airTemperatureK:267.35,mach:.3,power:0};
    Object.freeze(model.recipe.parameters);Object.freeze(model.recipe);
    try {
        const signature=resolveVehicleThermal(model.recipe,values);
        expect(signature.airframe.temperatureK).toBeCloseTo(recoveryTemperature(values.airTemperatureK,values.mach),10);
        expect(signature.airframe.temperatureK).not.toBe(designer.airframe.temperatureK);
        expect(()=>withThermalVehicle(model,resolved=>{
            expect(resolved.airframe).toEqual(signature.airframe);
            if(id==="a340-600")expect(model.thermalAnchors[0].cavity.userData.thermal.temperatureK).toBeCloseTo(signature.airframe.temperatureK,10);
            else {
                const burner=meshes(model.root).find(mesh=>mesh.userData.thermal.zone==="lantern_flame");
                expect(burner).toBeDefined();
                expect(burner.userData.thermal.temperatureK).toBeCloseTo(resolveSignatures({thermal:{profile:"lantern",
                    mach:values.mach,powerFraction:values.power}},values.airTemperatureK).resolveZone("lantern_flame").temperatureK,10);
            }
            throw Error("draw");
        },values)).toThrow("draw");
        for(const [mesh,visible,thermal] of before){expect(mesh.visible).toBe(visible);expect(mesh.userData.thermal).toBe(thermal);}
        expect(JSON.stringify(model.recipe)).toBe(originalRecipe);
        expect(resolveVehicleThermal(model.recipe).airframe).toEqual(designer.airframe);
        withThermalVehicle(model,resolved=>expect(resolved.airframe).toEqual(designer.airframe));
    } finally {disposeVehicle(model.root);}
});

test.each([125000, 300000])("sensor at %i m has a physical field and tight clipping planes", rangeM => {
    const bounds = new Box3(new Vector3(-32, -4, -38), new Vector3(32, 14, 38));
    const center = bounds.getCenter(new Vector3()), camera = new PerspectiveCamera(), settings = settingsForPreset("MX15");
    const view = normalizeSensorView({rangeM});
    const scale = configureSensorCamera(camera, bounds, settings, view);
    expect(camera.position.distanceTo(center)).toBeCloseTo(rangeM, 7);
    expect(camera.position.z).toBeLessThan(center.z);
    expect(camera.fov).toBe(settings.verticalFovDeg); expect(scale.pixelSizeM).toBeCloseTo(rangeM * settings.pixelPitchM / settings.focalLengthM, 8);
    expect(camera.far - camera.near).toBeLessThan(250);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z])
        expect(Math.abs(new Vector3(x, y, z).project(camera).z)).toBeLessThan(1);
    configureSensorCamera(camera, bounds, settings, {...view, azimuthDeg: 90, elevationDeg: 20});
    expect(camera.position.distanceTo(center)).toBeCloseTo(rangeM, 7);
    expect(camera.position.y).toBeGreaterThan(center.y); expect(camera.position.x).toBeGreaterThan(center.x);
});

test("count readouts use the full detector and map top-down pointer coordinates through digital zoom", () => {
    expect(detectorStatistics(new Float32Array([0, 12, 10, 16383]))).toEqual({min: 0, max: 16383, median: 11});
    const rect = {left: 100, top: 50, width: 800, height: 400}, settings = {detectorWidth: 8, detectorHeight: 4, digitalZoom: 1};
    expect(detectorPixelAt(101, 51, rect, settings)).toEqual({column: 0, row: 3, index: 24});
    expect(detectorPixelAt(899, 449, rect, settings)).toEqual({column: 7, row: 0, index: 7});
    expect(detectorPixelAt(101, 51, rect, {...settings, digitalZoom: 2})).toEqual({column: 2, row: 2, index: 18});
    expect(detectorPixelAt(50, 100, rect, settings)).toBeNull();
});
