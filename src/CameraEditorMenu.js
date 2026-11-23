import {markSitchDirty, setRenderOne} from "./Globals";

// Use and visibility are independent: closing a graph never disables its animation.
export function setupCameraEditorMenu(parent, editor, label, changed = () => editor.recalculateCascade()) {
    editor.editorView.enableCameraEditorTools(label);
    const folder = parent.addFolder(`${label} Editor`).close();
    folder.tooltip(`Animate offsets on top of the selected Camera ${label} source.`);
    editor.gui = folder;
    folder.add(editor, "useEditor").name(`Use ${label} Editor`)
        .onChange(() => { changed(); markSitchDirty(); setRenderOne(true); })
        .asFolderToggle();
    const show = editor.editorView.showHideController;
    if (show) {
        const key = `${editor.id}:show`;
        show.shareAs(key);
        folder.addMirror(key, {
            name: `Show ${label} Editor`,
            tooltip: "Show or hide the graph without changing whether its animation is used.",
            onMirror: twin => twin.keepLiveWhenFolderOff(),
        });
    }
    return folder;
}
