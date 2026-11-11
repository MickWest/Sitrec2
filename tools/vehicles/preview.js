import {generateVehicle} from "./generator.js";
import {disposeVehicle} from "./vehicle.js";
import {animateVehicleLights} from "./vehicleLights.js";
import {createVehicleStudio} from "./studio.js";
import {poseVehicleSpinners} from "./motion.js";

// One renderer for the selected vehicle; gallery tiles use ordinary JPEGs.
export function createVehiclePreview(mount) {
    const studio = createVehicleStudio(mount,{fov:34,onChange:render});
    const {scene} = studio;
    let model, disposed = false, frameId;
    function render() {if (!disposed) studio.render({mode:"visible"});}
    // A kite's tails move as in a steady 12-knot wind. Other models are drawn once.
    function animate(now) {
        if (disposed || !model?.waves?.length) return;
        poseVehicleSpinners(model.waves,now/1000,true); render();
        frameId = requestAnimationFrame(animate);
    }
    function resize() {
        if (disposed || !studio.resize() || !model) return;
        studio.fit(model.bounds,{direction:[-1.6,.75,1]}); render();
    }
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    return {
        set(recipe) {
            const next = generateVehicle(recipe);
            if (model) disposeVehicle(model.root);
            model = next; studio.setModel(model); animateVehicleLights(model,0,false); scene.add(model.root); resize();
            cancelAnimationFrame(frameId); frameId = requestAnimationFrame(animate);
        },
        // A kite's thumbnail has its tails at one fixed moment of that motion.
        thumbnail() {poseVehicleSpinners(model?.waves,3,true); return studio.thumbnail();},
        dispose() {
            if (disposed) return;
            disposed = true; cancelAnimationFrame(frameId); observer.disconnect();
            if (model) disposeVehicle(model.root);
            studio.dispose();
        },
    };
}
