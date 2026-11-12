import {generateVehicle} from "./generator.js";
import {disposeVehicle} from "./vehicle.js";
import {animateVehicleLights} from "./vehicleLights.js";
import {createVehicleStudio} from "./studio.js";
import {poseVehicleSpinners} from "./motion.js";
import {visibleVehicleBounds} from "./thermalTags.js";

// One renderer for the selected vehicle; gallery tiles use ordinary JPEGs.
export function createVehiclePreview(mount) {
    const studio = createVehicleStudio(mount,{fov:34,onChange:render});
    const {scene} = studio;
    let model, disposed = false, frameId;
    function render() {if (!disposed) studio.render({mode:"visible"});}
    const direction = [-1.6,.75,1];
    // A bird has `sweepBounds`: all the space that its wings move through.
    function frame() {studio.fit(model.sweepBounds ?? model.bounds,{direction});}
    // A kite's tails move as in a steady 12-knot wind, and a bird's wings beat. Other models are drawn once.
    function animate(now) {
        if (disposed || !model?.waves?.length) return;
        poseVehicleSpinners(model.waves,now/1000,true); render();
        frameId = requestAnimationFrame(animate);
    }
    function resize() {
        if (disposed || !studio.resize() || !model) return;
        frame(); render();
    }
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    return {
        set(recipe) {
            const next = generateVehicle(recipe);
            if (model) disposeVehicle(model.root);
            model = next; studio.setModel(model); animateVehicleLights(model,0,false); scene.add(model.root); resize();
            cancelAnimationFrame(frameId); frameId = requestAnimationFrame(animate);
        },
        // A kite's thumbnail has its tails at one fixed moment of that motion. A bird's thumbnail
        // has its wings at one moment of the wingbeat, and the picture is fitted to that one pose.
        thumbnail() {
            poseVehicleSpinners(model?.waves,3,true,model?.stillPose);
            if (!model?.sweepBounds) return studio.thumbnail();
            studio.fit(visibleVehicleBounds(model.root),{direction,paddingX:1,paddingY:1});
            const image = studio.thumbnail();
            frame(); return image;
        },
        dispose() {
            if (disposed) return;
            disposed = true; cancelAnimationFrame(frameId); observer.disconnect();
            if (model) disposeVehicle(model.root);
            studio.dispose();
        },
    };
}
