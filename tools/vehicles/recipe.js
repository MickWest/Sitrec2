import {normalizeParameters, readParameterFile} from "./vehicleSchema.js";
import {copyVehicleRecipe, VEHICLE_GENERATOR, VEHICLE_GENERATOR_REVISION} from "./recipeFormat.js";

export function createVehicleRecipe(parameters, name = "My vehicle", presetId = null) {
    return {format: "sitrec-procedural-vehicle", version: 1, generator: VEHICLE_GENERATOR,
        generatorRevision: VEHICLE_GENERATOR_REVISION, name: String(name).slice(0, 100),
        presetId, parameters: normalizeParameters(parameters)};
}
export function readVehicleRecipe(value) {
    if (value?.format === "sitrec-procedural-aircraft") {
        const legacy = readParameterFile(value);
        return createVehicleRecipe(legacy.parameters, legacy.name);
    }
    const recipe = copyVehicleRecipe(value);
    return {...recipe, parameters: normalizeParameters(recipe.parameters)};
}
