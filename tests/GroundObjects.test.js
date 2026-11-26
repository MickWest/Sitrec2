import {ColorManagement} from "three";
import {PRESETS, parameterFile, readParameterFile} from "../tools/vehicles/vehicleParameters.js";
import {createVehicleRecipe, readVehicleRecipe} from "../tools/vehicles/recipe.js";
import {generateVehicle} from "../tools/vehicles/generator.js";
import {disposeVehicle} from "../tools/vehicles/vehicle.js";

const ground = PRESETS.filter(p => p.vehicleType === "ground");

test.each([false, true])("oak materials use linear RGB with host color management %s", enabled => {
    const oak = ground.find(p => p.id === "ground-oak");
    const recipe = createVehicleRecipe({...oak.parameters, woodColor: "#804020", leafColor: "#408020"});
    const previous = ColorManagement.enabled;
    let model;
    try {
        ColorManagement.enabled = enabled;
        model = generateVehicle(recipe);
        expect(ColorManagement.enabled).toBe(enabled);
        // IEC sRGB channels 128, 64 and 32, decoded before the foliage tint is applied.
        const bark = model.root.getObjectByName("Bark").material.color;
        expect(bark.r).toBeCloseTo(.215861, 6);
        expect(bark.g).toBeCloseTo(.051269, 6);
        expect(bark.b).toBeCloseTo(.014444, 6);
        const leaves = model.root.getObjectByName("Foliage 2").material.color;
        expect(leaves.r).toBeCloseTo(.051269 * .88, 6);
        expect(leaves.g).toBeCloseTo(.215861 * .88, 6);
        expect(leaves.b).toBeCloseTo(.014444 * .88, 6);
    } finally {
        ColorManagement.enabled = previous;
        if (model) disposeVehicle(model.root);
    }
});

test.each(ground.map(p => [p.id,p]))("%s restores its design in metres at ground level", (_,preset) => {
    const recipe = createVehicleRecipe(preset.parameters,preset.name,preset.id);
    const restored = readVehicleRecipe(JSON.parse(JSON.stringify(recipe)));
    expect(restored).toEqual(recipe);
    expect(readParameterFile(parameterFile(recipe.parameters)).parameters).toEqual(recipe.parameters);
    const model = generateVehicle(restored);
    try {
        expect(model.bounds.min.y).toBeCloseTo(0, 4);
        expect(Math.abs(model.stats.size.y - recipe.parameters.height)).toBeLessThan(.05);
        expect(model.stats.size.toArray().every(v => Number.isFinite(v) && v > 0)).toBe(true);
        expect(model.root.children.length).toBeLessThan(10);
        expect(model.lamps).toHaveLength(0);
        if (["pole","pylon"].includes(recipe.parameters.groundKind)) {
            const points = model.root.userData.connectionPoints;
            const incoming = points.filter(p => p.tag === "in"), outgoing = points.filter(p => p.tag === "out");
            expect(incoming.length).toBeGreaterThan(0);
            expect(incoming.map(p => p.position)).toEqual(outgoing.map(p => p.position));
            expect(points.every(p => p.position.every(Number.isFinite))).toBe(true);
        }
    } finally {disposeVehicle(model.root);}
});

test.each(ground.filter(p => p.parameters.seed).map(p => [p.id,p]))("%s regenerates the same shape from its saved seed", (_,preset) => {
    const shape = seed => {
        const model = generateVehicle(createVehicleRecipe({...preset.parameters, seed}));
        try {return model.root.children.flatMap(mesh => Array.from(mesh.geometry.attributes.position.array.slice(-30)));}
        finally {disposeVehicle(model.root);}
    };
    expect(shape(47)).toEqual(shape(47));
    expect(shape(48)).not.toEqual(shape(47));
});
