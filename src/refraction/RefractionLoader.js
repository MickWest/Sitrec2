// The only eager part of the simulator. No worker, editor, shader or GPU resource
// exists until the user opens the tool or restores an enabled saved experiment.
import {guiMenus, Sit, setRenderOne} from "../Globals";

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

export function setupRefractionToolMenu() {
    const state = {
        get enabled() { return !!Sit?.raytracedRefraction?.enabled; },
        set enabled(value) {
            if (!Sit.raytracedRefraction) Sit.raytracedRefraction = {};
            Sit.raytracedRefraction.enabled = value;
        },
        open: () => openRefractionTool().catch(() => {}),
    };
    const folder = guiMenus.raytracedRefraction;
    folder.tooltip("Trace light rays through an atmosphere that you define by temperature and humidity profiles, for one 3D view.\n"
        + "Other views keep the normal atmospheric refraction (View > Atmospheric Refraction).");
    folder.add(state, "enabled").name("Enable Ray-traced Refraction").listen().perm()
        .tooltip("Draw the selected 3D view (the look view by default) through the ray-traced atmosphere.\n"
            + "Choose the view and edit the atmosphere in Profiles, Rays & Lasers. The setting is saved with the sitch.")
        .onChange(value => {
            if (value) openRefractionTool(false).catch(() => {});
            else instance?.sync();
            setRenderOne(true);
        });
    folder.add(state, "open").name("Profiles, Rays & Lasers…").perm()
        .tooltip("Open the Ray-traced Refraction panel. In it you choose the view, edit the temperature and humidity profiles, see the ray paths, add lasers, and export or import a profile.");
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
