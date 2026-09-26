import {buildVehicle} from "./vehicle.js";
import {readVehicleRecipe} from "./recipe.js";
import {registerVehicleSpinners} from "./motion.js";

// The editor, picker, native scene and GLB exporter all build the same model.
export function generateVehicle(value) {
    const recipe = readVehicleRecipe(value), model = buildVehicle(recipe.parameters);
    model.root.name = recipe.name;
    model.root.userData.sitrecVehicleRecipe = recipe;
    model.root.userData.sitrecModelFormat = "procedural";
    registerVehicleSpinners(model.propellers);
    return {...model, scene:model.root, format:"procedural", recipe};
}
