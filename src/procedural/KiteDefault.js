import {KITE_PRESETS} from "../../tools/vehicles/kitePresets.js";
import {createVehicleRecipe} from "../../tools/vehicles/recipe.js";

// The design a new kite starts with (Add Kite). Change it with Browse custom objects…
export function defaultKiteRecipe() {
    const preset = KITE_PRESETS.find(item => item.id === "kite-diamond");
    return createVehicleRecipe(preset.parameters, preset.name, preset.id);
}
