export const viewingMenuKeys = ["satellites", "time", "camera"];

// Restore the old panel as ordinary menus, after saved menu positions have been
// applied. Existing floating/sidebar menus keep the user's chosen positions.
export function applyViewingMenuLayout(sitch, menus, menuBar) {
    const legacyVisible = sitch.mods?.starlinkViewing?.visible
        ?? sitch.starlinkViewing?.visible ?? sitch.showSatelliteControls;
    const keys = sitch.guiMenus ? (legacyVisible ? viewingMenuKeys : [])
        : (sitch.sidebarMenus ?? (legacyVisible ? viewingMenuKeys : []));
    for (const key of keys) {
        const menu = menus[key];
        if (menu && (!menu.mode || menu.mode === "DOCKED")) menuBar.dockToSidebar(menu);
    }
}
