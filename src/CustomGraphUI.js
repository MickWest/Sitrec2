import {EventManager} from "./CEventManager";
import {t} from "./i18n";

// Menus can be created before the graph manager is ready. Resolve their live
// entity and name when clicked, and use an event to avoid an object/manager cycle.
export function addCustomGraphControl(folder, entity) {
    folder._customGraphEntity = entity;
    if (folder._addEntityGraphController) return folder._addEntityGraphController;
    const action = {
        addCustomGraph() {
            const target = folder._customGraphEntity();
            if (!target?.entityId) return;
            EventManager.dispatchEvent("addCustomGraphForEntity", target);
        },
    };
    const controller = folder.add(action, "addCustomGraph")
        .name(t("menus.showHide.graphs.addCustom.label"))
        .tooltip("Make a new custom graph of the ground speed and altitude of this track or object.\n"
            + "Its controls are in Show > Graphs.");
    controller.keepLiveWhenFolderOff();
    folder._addEntityGraphController = controller;
    return controller;
}
