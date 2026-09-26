import {GLTFExporter} from "three/addons/exporters/GLTFExporter.js";
import {generateVehicle} from "./generator.js";
import {disposeVehicle} from "./vehicle.js";

export async function exportVehicleGLB(recipe) {
    // Rebuild from the recipe, excluding studio lights, wireframe and preview poses.
    const model = generateVehicle(recipe);
    try {
        const bytes = await new GLTFExporter().parseAsync(model.scene, {binary:true});
        return {bytes, size:model.stats.size.clone()};
    } finally {disposeVehicle(model.scene);}
}

export async function bakeVehicle(recipe) {
    return (await exportVehicleGLB(recipe)).bytes;
}
