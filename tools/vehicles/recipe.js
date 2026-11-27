import {normalizeParameters, readParameterFile} from "./vehicleSchema.js";
import {copyVehicleRecipe, VEHICLE_GENERATOR} from "./recipeFormat.js";

export function createVehicleRecipe(parameters, name = "My vehicle", presetId = null) {
    const normalized = normalizeParameters(parameters);
    // Record the earliest generator that can reproduce this shape.
    const revisions = {pylon: 2, radioTower: 3, brickWall: 4, chainLink: 4, woodFence: 4, railing: 4};
    const pterosaur = normalized.wingTip === "membrane" || normalized.billShape === "jaws";
    const birdRevision = normalized.length > 2 || normalized.wingspan > 3.6 ? 7 : pterosaur ? 6 : normalized.headCrest > 0 ? 5 : 1;
    return {format: "sitrec-procedural-vehicle", version: 1, generator: VEHICLE_GENERATOR,
        generatorRevision: normalized.vehicleType === "bird" ? birdRevision : revisions[normalized.groundKind] ?? 1, name: String(name).slice(0, 100),
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
