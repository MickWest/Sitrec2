import {readVehicleRecipe} from "./recipe.js";
import {vehicleFileStem} from "./recipeFormat.js";

export async function readVehicleRecipeFile(file) {
    if (file.size > 1000000) throw new Error("Choose a design file smaller than 1 MB.");
    return readVehicleRecipe(JSON.parse(await file.text()));
}

export function downloadVehicleBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; document.body.append(link);
    link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),10000);
}

export function downloadVehicleRecipe(value) {
    const recipe = readVehicleRecipe(value);
    downloadVehicleBlob(new Blob([JSON.stringify(recipe,null,2)],{type:"application/json"}),`${vehicleFileStem(recipe.name)}.vehicle.json`);
}
