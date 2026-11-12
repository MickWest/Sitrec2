// The only eager part of the simulator. No worker, editor, shader or GPU resource
// exists until the user opens the tool or restores an enabled saved experiment.
import {Sit} from "../Globals";

let instance = null;
let pending = null;
let generation = 0;

export async function openRefractionTool(show = true) {
    if (instance) {
        instance.sync();
        if (show) instance.show();
        return instance;
    }
    if (!pending) {
        const token = generation;
        const operation = import(/* webpackChunkName: "refraction-tool" */ "./RefractionTool")
            .then(({RefractionTool}) => {
                if (token !== generation) return null;
                instance = new RefractionTool();
                return instance;
            }).catch(error => {
                if (token === generation && Sit.raytracedRefraction) Sit.raytracedRefraction.enabled = false;
                console.error("Could not load the refraction tool", error);
                throw error;
            }).finally(() => { if (pending === operation) pending = null; });
        pending = operation;
    }
    const tool = await pending;
    if (show) tool?.show();
    return tool;
}

// The loaded tool, or null while the ray-traced model has never been chosen in
// this sitch. The Effects > Atmospheric Refraction menu forwards its ray-traced
// rows through it, so the menu never has to load the tool's chunk itself.
export function getRefractionTool() {
    return instance;
}

export function restoreRefractionTool() {
    return Sit?.raytracedRefraction?.enabled ? openRefractionTool(false).catch(() => null) : Promise.resolve(null);
}

export function disposeRefractionTool() {
    generation++;
    pending = null;
    instance?.dispose();
    instance = null;
}
