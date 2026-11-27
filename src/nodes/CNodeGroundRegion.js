import {DataTexture} from "three";
import {CNodeGroundOverlay} from "./CNodeGroundOverlay";
import {resolveFootprintBounds} from "../GroundFootprint";
import {FileManager, Globals, guiMenus, markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import {isSecureBuild} from "../configUtils";
import {fetchRegionPowerGrid, overpassServers} from "../OverpassPowerGrid";
import {t} from "../i18n";
import {writeToClipboard} from "../urlUtils";

function areaKey(corners) {
    return JSON.stringify(corners.map(({lat, lon}) => [lat.toFixed(7), lon.toFixed(7)]));
}

// The overlay editor supplies terrain draping, corner and rotation handles,
// picking, drag undo and mirroring into the floating edit window.
export class CNodeGroundRegion extends CNodeGroundOverlay {
    constructor(v) {
        super({...resolveFootprintBounds(v), imageURL: "", imageFileID: null, opacity: 0.16, showBorder: true, noGUI: true});
        this.kindName = "region";
        this.gridImports = v.gridImports ?? [];
        this.importStatus = "";
        this.downloadURL = "";
        this.server = "overpass-api.de";
        if (!v.noGUI) this.createRegionGUI();
    }

    loadTexture() {
        const tint = new DataTexture(new Uint8Array([42, 160, 195, 255]), 1, 1);
        tint.needsUpdate = true;
        this.setTexture(tint);
    }

    updateMesh() {
        super.updateMesh();
        this.showHighlightBorder();
        if (this.downloadURL && this.downloadArea !== areaKey(this.getCornerLLAs())) this.setDownloadURL();
    }

    // Image registration points belong to photo overlays.
    onContextMenu() {}

    createRegionGUI() {
        const folder = guiMenus.objects.addFolder(t("groundRegion.folder", {name: this.name}));
        this.guiFolder = folder;
        folder.add(this, "name").name(t("groundRegion.name")).onChange(() => {
            folder.title(t("groundRegion.folder", {name: this.name}));
            markSitchDirty();
        }).keepLiveWhenFolderOff();
        folder.add(this, "visible").name(t("groundRegion.visible")).onChange(value => {
            this.show(value);
            markSitchDirty();
            setRenderOne(true);
        }).asFolderToggle();
        const edit = {editMode: this.editMode};
        this.editModeController = folder.add(edit, "editMode").name(t("groundRegion.edit")).onChange(value => this.setEditMode(value));
        folder.add(this, "rotation", -180, 180, 0.1).name(t("groundGrid.rotation.label")).onChange(() => {
            this.updateMesh();
            markSitchDirty();
        });
        if (!isSecureBuild) {
            folder.add(this, "server", Object.keys(overpassServers)).name(t("groundRegion.server"))
                .onChange(() => this.setDownloadURL());
            folder.add(this, "importPowerGrid").name(t("groundRegion.import")).tooltip(t("groundRegion.importTip"));
            this.statusController = folder.add(this, "importStatus").name(t("groundRegion.status")).listen().disable();
            this.downloadController = folder.add(this, "downloadURL").name(t("groundRegion.downloadURL")).asDisplayRow().listen().hide();
            this.copyController = folder.add({copy: () => writeToClipboard(this.downloadURL)}, "copy")
                .name(t("groundRegion.copyURL")).hide();
        }
        folder.add(this, "gotoOverlay").name(t("groundRegion.goto")).keepLiveWhenFolderOff();
        folder.add(this, "deleteOverlay").name(t("groundRegion.remove")).keepLiveWhenFolderOff();
        folder.close();
    }

    setImportStatus(message) {
        this.importStatus = message;
        this.statusController?.tooltip(message);
    }

    setDownloadURL(url = "", area, retryAt) {
        if (this.downloadURL && !url) this.setImportStatus("");
        this.downloadURL = url;
        this.downloadArea = area;
        this.downloadController?.show(!!url);
        this.copyController?.show(!!url && !!globalThis.navigator?.clipboard?.writeText);
        if (url) {
            const tip = t("groundRegion.manualTip", {time: new Date(retryAt).toLocaleTimeString()});
            this.downloadController?.tooltip(tip);
            this.copyController?.tooltip(tip);
        }
    }

    async importPowerGrid() {
        if (isSecureBuild || this.pendingImport) return;
        const corners = this.getCornerLLAs();
        const area = areaKey(corners);
        const server = this.server;
        this.setDownloadURL();
        if (this.gridImports.some(entry => entry.area === area && FileManager.exists(entry.file))) {
            this.setImportStatus(t("groundRegion.already"));
            return;
        }
        const request = new AbortController();
        const generation = Globals.loadGeneration;
        const stillHere = () => generation === Globals.loadGeneration && NodeMan.get(this.id, false) === this;
        const current = () => !request.signal.aborted && stillHere();
        const timeout = setTimeout(() => request.abort(), 45000);
        this.pendingImport = request;
        this.setImportStatus(t("groundRegion.loading"));
        try {
            const data = await fetchRegionPowerGrid(corners, request.signal, server);
            clearTimeout(timeout);
            if (!current()) return;
            if (!data.features.length) {
                this.setImportStatus(t("groundRegion.empty"));
                return;
            }
            const {DragDropHandler} = await import("../DragDropHandler");
            if (!current()) return;
            const name = this.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 64) || "Region";
            const file = DragDropHandler.reserveUniqueName(name + " power grid", "geojson");
            try {
                const bytes = new TextEncoder().encode(JSON.stringify(data)).buffer;
                await FileManager.parseResult(file, bytes, null, {canApply: current});
            } finally {
                DragDropHandler.reservedImportNames.delete(file);
            }
            if (!current()) return;
            this.gridImports.push({area, file});
            this.setImportStatus(t("groundRegion.ready", {file}));
            markSitchDirty();
        } catch (error) {
            if (stillHere() && server === this.server && area === areaKey(this.getCornerLLAs())) {
                this.setImportStatus(request.signal.aborted ? t("groundRegion.timeout") : error.message);
                if (error.downloadURL) this.setDownloadURL(error.downloadURL, area, error.retryAt);
            } else if (stillHere()) {
                this.setImportStatus("");
            }
        } finally {
            clearTimeout(timeout);
            this.pendingImport = null;
        }
    }

    serialize() {
        const {north, south, west, east, rotation, name, visible, id, gridImports} = this;
        return {type: "region", id, name, visible, north, south, west, east, rotation, gridImports};
    }

    dispose() {
        this.pendingImport?.abort();
        super.dispose();
    }
}
