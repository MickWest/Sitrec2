import {Globals, setRenderOne} from "./Globals";

// Point edits must be explicit menu actions. Opening or dismissing this menu
// never changes the model, including when an editing panel is already open.
export function showPointContextMenu(event, title, actions) {
    const menu = Globals.menuBar?.createStandaloneMenu(title, event.clientX, event.clientY, true, true);
    if (!menu) return null;
    for (const {label, action, enabled = true} of actions) {
        const controller = menu.add({run: () => {
            menu.destroy();
            if (enabled) action();
            setRenderOne(true);
        }}, "run").name(label);
        if (!enabled) controller.disable();
    }
    menu.open();
    return menu;
}
