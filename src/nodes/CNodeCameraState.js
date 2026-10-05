// CNodeCameraState.js
//
// Holds a per-frame camera state table (see CameraStateTable.js): the sensor
// mode, focal length as displayed, digital zoom and polarity that a gimbal
// camera recording shows in its own symbology. Consumers call stateAt(frame)
// and get the row that applies, or null when there is no data or "Drive Look
// View" is off - in which case they keep their own saved settings.
//
// One node, id "cameraState", is made empty for every sitch that can be
// modified and has a look camera (CustomSupport.setupCameraState, beside the
// MX overlay), so it exists before a save's mods are applied. A dropped camera
// data CSV fills it (importCameraStateCSV, from CFileManagerParse's
// handleParsedFile). The rows are saved in this node's mod rather than as a
// file: a reload then needs no file and cannot race an asynchronous parse. An
// empty node writes no mod.

import {CNode} from "./CNode";
import {guiMenus, markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import {showError} from "../showError";
import {t} from "../i18n";
import {
    cameraStateAt,
    cameraStateFromSaved,
    cameraStateModes,
    cameraStateToSaved,
    emptyCameraStateTable,
    parseCameraStateCSV,
} from "../CameraStateTable";

export class CNodeCameraState extends CNode {
    constructor(v) {
        super(v);

        // Not a display node. Without this the base class saves "visible", and
        // an empty node, which every modifiable sitch has, must save nothing.
        this.simpleSerials = [];

        // The data describes the recording, so it belongs to the whole sitch:
        // sub sitches do not capture or restore it (an empty node saves no mod,
        // so a sub sitch could never restore "no data", and switching to an
        // older sub sitch would bring back an older file's rows).
        this.excludeFromSubSitches = true;

        this.table = emptyCameraStateTable();
        this.driveLookView = false;

        // Read-only text for the menu, refreshed by updateMenu().
        this.menuText = {source: "", rows: "", modes: ""};
        if (v.gui !== false) this.setupMenu(guiMenus.camera);
        this.updateMenu();
    }

    get sourceName() {
        return this.table.sourceName;
    }

    hasData() {
        return this.table.rows.length > 0;
    }

    // The row that applies at this frame ({index, frame, mode, band,
    // focalLengthMm, zoom, polarity}), or null when nothing should be driven.
    stateAt(frame) {
        if (!this.driveLookView || !this.hasData()) return null;
        return cameraStateAt(this.table, frame);
    }

    // Replace the table with new data (a dropped file). New data drives the
    // look view at once; the checkbox turns that off again.
    setTable(table) {
        this.table = table;
        this.driveLookView = true;
        this.changed();
    }

    clear() {
        this.table = emptyCameraStateTable();
        this.driveLookView = false;
        this.changed();
    }

    changed() {
        this.updateMenu();
        setRenderOne(true);
        markSitchDirty();
    }

    modSerialize() {
        const out = super.modSerialize();
        if (!this.hasData()) return out;
        return {
            ...out,
            cameraState: cameraStateToSaved(this.table),
            driveLookView: this.driveLookView,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.cameraState !== undefined) {
            try {
                this.table = cameraStateFromSaved(v.cameraState);
                this.driveLookView = v.driveLookView ?? true;
            } catch (error) {
                // A damaged save must not drive the view with half a table.
                console.warn(`cameraState: saved camera data not restored: ${error.message}`);
                this.table = emptyCameraStateTable();
                this.driveLookView = false;
            }
        }
        this.updateMenu();
        setRenderOne(true);
    }

    // Camera > Camera Data: where the rows came from, the modes and the band
    // each one is drawn in, the drive switch, and a way to remove the data.
    // Hidden while the node is empty, as the Lens folder is until a lens has
    // been fitted.
    setupMenu(parent) {
        if (!parent) return;
        const folder = this.guiFolder = parent.addFolder(t("cameraState.folder")).close();

        const readOnly = (property, key) => folder.add(this.menuText, property)
            .name(t(`cameraState.${key}.label`))
            .tooltip(t(`cameraState.${key}.tooltip`))
            .listen().disable();
        readOnly("source", "source");
        readOnly("rows", "rows");
        readOnly("modes", "modes");

        folder.add(this, "driveLookView")
            .name(t("cameraState.driveLookView.label"))
            .tooltip(t("cameraState.driveLookView.tooltip"))
            .listen()
            .onChange(() => {
                setRenderOne(true);
                markSitchDirty();
            });

        folder.add({remove: () => this.clear()}, "remove")
            .name(t("cameraState.remove.label"))
            .tooltip(t("cameraState.remove.tooltip"));
    }

    updateMenu() {
        const rows = this.table.rows;
        this.menuText.source = this.table.sourceName ?? "";
        this.menuText.rows = rows.length === 0 ? "" : t("cameraState.rows.value", {
            rows: rows.length, first: rows[0].frame, last: rows[rows.length - 1].frame,
        });
        this.menuText.modes = cameraStateModes(this.table)
            .map(({mode, band}) => `${mode} (${band})`).join(", ");
        if (this.guiFolder) {
            if (this.hasData()) this.guiFolder.show();
            else this.guiFolder.hide();
        }
    }

    dispose() {
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
        super.dispose();
    }
}

// The file name without any folder or URL part, for the menu and the save.
function baseName(filename) {
    const name = String(filename ?? "").split(/[?#]/)[0].split(/[\\/]/).pop();
    return name || String(filename ?? "");
}

/**
 * Fill the cameraState node from a camera data CSV (rows as arrays, header
 * first), replacing any table it held. Returns the node, or null after telling
 * the user why the file could not be used.
 */
export function importCameraStateCSV(filename, rows) {
    const node = NodeMan.get("cameraState", false);
    if (!node) {
        showError(t("cameraState.noNode", {file: filename}));
        return null;
    }
    let table;
    try {
        table = parseCameraStateCSV(rows, {sourceName: baseName(filename)});
    } catch (error) {
        showError(t("cameraState.importError", {file: filename, message: error.message}));
        return null;
    }
    node.setTable(table);
    console.log(`cameraState: ${table.rows.length} rows from ${filename}`);
    return node;
}
