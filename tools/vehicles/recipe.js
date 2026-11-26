import {normalizeParameters, readParameterFile} from "./vehicleSchema.js";
import {copyVehicleRecipe, VEHICLE_GENERATOR, VEHICLE_GENERATOR_REVISION} from "./recipeFormat.js";

export function createVehicleRecipe(parameters, name = "My vehicle", presetId = null) {
    const normalized = normalizeParameters(parameters);
    // Revision 2 changes transmission towers. Other model families can still
    // exchange newly saved recipes with revision 1 readers.
    const tower = normalized.vehicleType === "ground" && normalized.groundKind === "pylon";
    return {format: "sitrec-procedural-vehicle", version: 1, generator: VEHICLE_GENERATOR,
        generatorRevision: tower ? VEHICLE_GENERATOR_REVISION : 1, name: String(name).slice(0, 100),
        presetId, parameters: normalized};
}
export function readVehicleRecipe(value) {
    if (value?.format === "sitrec-procedural-aircraft") {
        const legacy = readParameterFile(value);
        return createVehicleRecipe(legacy.parameters, legacy.name);
    }
    const recipe = copyVehicleRecipe(value);
    return {...recipe, parameters: normalizeParameters(recipe.parameters)};
}
