// Both the sky and the two satellite tracks add controls here. Use the GUI's
// stored identity, not rendered header text (which can contain other controls).
export function satelliteTracksFolder(menu) {
    const title = "Tracks & Guides";
    const folder = menu.folders.find(f => f._lookupId === title || f._title === title)
        ?? menu.addFolder(title).close();
    folder._lookupId = title;
    return folder;
}
