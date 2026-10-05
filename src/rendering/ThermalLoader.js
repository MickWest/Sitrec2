import {markSitchDirty, NodeMan, setRenderOne} from "../Globals";
import {t} from "../i18n";

export function thermalRenderMode(value) {
    return value === "physicalThermal" ? value : "visible";
}

export function thermalUnavailable(view, {fisheye = false, flatEarth = false, panorama = false} = {}) {
    return view.id !== "lookView" || !view.camera?.isPerspectiveCamera || view.cameraNode?.orthographic ||
        view.isXRPresenting?.() || fisheye || flatEarth || panorama;
}

// The text goes to the Thermal Readout view (CNodeViewThermalReadout), not over the image.
export function thermalStatus(view, key, values = {}, details = []) {
    view.thermalStatus = [t(`thermal.${key}`, values), ...details].join("\n");
    NodeMan.get("thermalReadoutView", false)?.setText(view.thermalStatus);
}

// The view does not draw a physical thermal image now (visible mode, or a visible-light frame).
export function clearThermalStatus(view) {
    view.thermalStatus = null;
    NodeMan.get("thermalReadoutView", false)?.setText(null);
}

export function ensureThermalView(view) {
    if (view._thermalAdapter || view._thermalLoading || view._thermalDisposed) return;
    const generation = view._thermalGeneration ?? 0;
    thermalStatus(view, "loading");
    view._thermalLoading = import(/* webpackChunkName: "physical-thermal" */ "./ThermalViewAdapter.js")
        .then(module => {
            if (view._thermalDisposed || generation !== (view._thermalGeneration ?? 0)) return;
            view._thermalAdapter = module.createThermalViewAdapter(view);
        }).catch(error => {
            view._thermalError = error;
            thermalStatus(view, "failed", {message: error.message});
        }).finally(() => {
            if (generation === (view._thermalGeneration ?? 0)) view._thermalLoading = null;
            setRenderOne(true);
        });
}

export function disposeThermalView(view, permanent = false) {
    view._thermalGeneration = (view._thermalGeneration ?? 0) + 1;
    view._thermalAdapter?.dispose(); view._thermalAdapter = null;
    view._thermalLoading = null; view._thermalError = null;
    view._thermalDisposed = permanent;
    if (view.thermalStatus) clearThermalStatus(view);
}

export function setupThermalMenu(view, parent, readoutView) {
    const folder = parent.addFolder(t("thermal.title")).close();
    view._thermalFolder = folder;
    folder.add(view, "renderMode", {[t("thermal.visible")]: "visible", [t("thermal.physicalThermal")]: "physicalThermal"})
        .name(t("thermal.mode")).listen().onChange(() => {
            view._thermalError = null;
            // The saved choice, not this frame's route: a choice made on a visible-light frame of camera data
            // still loads the sensor for the infrared frames.
            if (view.renderMode === "physicalThermal") ensureThermalView(view);
            else clearThermalStatus(view);
            markSitchDirty(); setRenderOne(true);
        });
    // The same flag as the view's entry in Show/Hide > Views. The view saves it with the sitch.
    if (readoutView) {
        folder.add(readoutView, "visible").name(t("thermal.readoutView.show")).listen().onChange(value => {
            readoutView.visible = undefined; // force update
            readoutView.setVisible(value);
        }).tooltip(t("thermal.readoutView.showTooltip"));
    }
    // Opening the settings is also an explicit first use. Closed, visible-mode
    // startup imports neither the schema's physics dependencies nor GPU code.
    folder.onOpenClose(changed => {
        if (changed === folder && !folder._closed) ensureThermalView(view);
    });
}

export function setupObjectThermalMenu(node) {
    const folder = node.gui.addFolder(t("thermal.object.title")).close();
    const update = () => {markSitchDirty(); setRenderOne(true);};
    folder.add(node.thermal, "mode", {[t("thermal.object.inherit")]: "inherit", [t("thermal.object.uniform")]: "uniform"})
        .name(t("thermal.mode")).onChange(update);
    // Same ranges and steps as the shared schema's objectTemperatureK and emissivity.
    folder.add(node.thermal, "temperatureK", 0, 3000, 1)
        .name(t("thermal.object.temperatureK")).onChange(update);
    folder.add(node.thermal, "emissivity", 0, 1, 0.01)
        .name(t("thermal.object.emissivity")).onChange(update);
    // Zone controls use the same resolved vehicle signature, loaded on demand.
    folder.onOpenClose(changed => {
        if (changed !== folder || folder._closed || node._thermalZonesLoading) return;
        node._thermalZonesLoading = true;
        import(/* webpackChunkName: "physical-thermal" */ "./ThermalViewAdapter.js").then(module => {
            if (!node._vehicleDisposed) module.setupThermalZoneControls(node, folder);
        }).catch(error => console.error(error)).finally(() => {node._thermalZonesLoading = false;});
    });
}

export function objectThermalState(value = {}) {
    // Estimated authoring default: ambient reference in thermalSchema.js.
    return {mode: value?.mode === "uniform" ? "uniform" : "inherit",
        temperatureK: value?.temperatureK ?? 293, emissivity: value?.emissivity ?? 1,
        // Null means from scene, including saves made before instance controls.
        airTemperatureK: Number.isFinite(value?.airTemperatureK) ? value.airTemperatureK : null,
        mach: Number.isFinite(value?.mach) ? value.mach : null,
        power: Number.isFinite(value?.power) ? value.power : null,
        zones: JSON.parse(JSON.stringify(value?.zones ?? {}))};
}
