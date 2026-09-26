import {generateVehicle} from "./generator.js";
import {disposeVehicle} from "./vehicle.js";
import {animateVehicleLights} from "./vehicleLights.js";
import {createVehicleStudio} from "./studio.js";

// One renderer for the selected vehicle; gallery tiles use ordinary JPEGs.
export function createVehiclePreview(mount) {
    const studio = createVehicleStudio(mount,{fov:34,onChange:render});
    const {renderer,scene,camera} = studio;
    let model, disposed = false;
    function render() {if (!disposed) renderer.render(scene,camera);}
    function resize() {
        if (disposed || !studio.resize() || !model) return;
        studio.fit(model.bounds,{direction:[-1.6,.75,1]}); render();
    }
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    return {
        set(recipe) {
            const next = generateVehicle(recipe);
            if (model) disposeVehicle(model.root);
            model = next; animateVehicleLights(model,0,false); scene.add(model.root); resize();
        },
        thumbnail() {return studio.thumbnail();},
        dispose() {
            if (disposed) return;
            disposed = true; observer.disconnect();
            if (model) disposeVehicle(model.root);
            studio.dispose();
        },
    };
}
