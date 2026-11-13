// CNodeCloudLayers.js - volumetric cloud layers, lit by the sun (Lighting > Clouds).
//
// One node per custom sitch, id "cloudLayers", created in CCustomManager.setup().
// It holds up to four layers (CloudLayerModel.js), their GUI, their wind, and
// their serialization. Rendering is one full-screen triangle in the world scene
// (CloudVolumeMesh.js) whose shader marches every layer on the GPU; the CPU work
// per frame is the wind of each layer here and a few dozen uniforms per camera.
//
// The noise textures are made lazily, in Web Workers, the first time a layer
// is visible (CloudNoiseTextures.js). Nothing is drawn, and nothing is
// allocated on the GPU, while there are no visible layers.
//
// This is separate from the sprite clouds of "Add Clouds" (CNodeSynthClouds),
// which are placed patches of camera-facing images and stay unchanged.

import {CNode} from "./CNode";
import {Globals, guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit, UndoManager} from "../Globals";
import {par} from "../par";
import {t} from "../i18n";
import {showConfirm} from "../showError";
import {Vector3} from "three";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {atmosphereFisheyeLens} from "../FisheyeProjection";
import {
    applyTypeDefaults,
    CLOUD_EXTENT_MODES,
    CLOUD_LIMITS,
    CLOUD_PRESET_NAMES,
    CLOUD_QUALITIES,
    CLOUD_TYPE_NAMES,
    CLOUD_WIND_MODES,
    deserializeCloudState,
    isSheetType,
    layerDefaultsFor,
    layerTitle,
    MAX_CLOUD_LAYERS,
    nextLayerId,
    normalizeLayer,
    presetLayers,
    serializeCloudState,
} from "../clouds/CloudLayerModel";
import {DEG2RAD, enuBasis, llaToECEF, METERS_PER_SECOND_PER_KNOT, windVelocityEN, WGS84_A, WGS84_B} from "../clouds/CloudMath";
import {CloudVolumeMesh} from "../clouds/CloudVolumeMesh";
import {cloudNoiseTextures, requestCloudNoiseTextures} from "../clouds/CloudNoiseTextures";

const WIND_NODE_IDS = {local: "localWind", target: "targetWind"};

export class CNodeCloudLayers extends CNode {
    constructor(v) {
        super(v);
        const state = deserializeCloudState(v.clouds ?? {});
        // Which 3D views draw the clouds: by default the look view only, which
        // also means only one view pays for the march.
        this.showMain = state.showMain;
        this.showLook = state.showLook;
        this.quality = state.quality;
        this.layers = state.layers;
        this.status = "";

        // Per-layer derived state, rebuilt on change; per-frame values in place.
        this.derived = new Map();
        this.visibleLayers = [];
        this.visibleDerived = [];
        this._windPosition = new Vector3();
        this._windPoint = [0, 0, 0];
        this._velocity = {east: 0, north: 0};
        this._enu = {east: [0, 0, 0], north: [0, 0, 0], up: [0, 0, 0]};
        this._renderState = {
            layers: this.visibleLayers, derived: this.visibleDerived, frame: 0, quality: this.quality,
            radii: {a: WGS84_A, b: WGS84_B}, sun: {dir: new Vector3(0, 0, 1), intensity: 0, angle: 90},
            ambient: 0, lens: null,
        };

        this.volume = new CloudVolumeMesh(camera => this.renderState(camera));
        this.layerFolders = new Map();
        this.setupGUI();
        this.rebuildLayers();
        this.rebuildLayerFolders();
    }

    // ---- state ---------------------------------------------------------------

    get hasVisibleLayers() {
        return this.anyView && this.layers.some(layer => layer.visible);
    }

    get anyView() {
        return this.showMain || this.showLook;
    }

    // Called after any change of the layer list or of a layer.
    rebuildLayers() {
        for (const layer of this.layers) {
            if (!this.derived.has(layer.id)) {
                this.derived.set(layer.id, {
                    velocity: {east: 0, north: 0}, windECEF: [0, 0, 0], windDir: [1, 0, 0],
                    east: [1, 0, 0], north: [0, 1, 0], discECEF: null, discUp: [0, 0, 1],
                });
            }
            this.updateAnchor(layer);
        }
        for (const id of [...this.derived.keys()]) {
            if (!this.layers.some(layer => layer.id === id)) this.derived.delete(id);
        }
        this.visibleLayers.length = 0;
        this.visibleDerived.length = 0;
        if (this.anyView) {
            for (const layer of this.layers) {
                if (!layer.visible) continue;
                this.visibleLayers.push(layer);
                this.visibleDerived.push(this.derived.get(layer.id));
            }
        }
        this.ensureTextures();
        this.updateVolumeVisibility();
        this.updateStatus();
        setRenderOne(true);
    }

    // The wind frame (east/north at the layer's anchor) and, for a disc, its center.
    updateAnchor(layer) {
        const derived = this.derived.get(layer.id);
        const a = Globals.equatorRadius ?? WGS84_A, b = Globals.polarRadius ?? WGS84_B;
        const disc = layer.extent.mode === "disc" && layer.extent.lat !== null && layer.extent.lon !== null;
        const lat = disc ? layer.extent.lat : (Sit?.lat ?? 0);
        const lon = disc ? layer.extent.lon : (Sit?.lon ?? 0);
        const enu = enuBasis(lat, lon, this._enu);
        derived.east = [...enu.east];
        derived.north = [...enu.north];
        if (disc) {
            derived.discECEF = llaToECEF(lat, lon, 0, a, b, [0, 0, 0]);
            derived.discUp = [...enu.up];
        } else {
            derived.discECEF = null;
        }
        derived.anchorLat = lat;
        derived.anchorLon = lon;
    }

    ensureTextures() {
        if (!this.hasVisibleLayers || this.volume.hasTextures) return;
        const ready = cloudNoiseTextures();
        if (ready) {
            this.volume.setTextures(ready);
            return;
        }
        if (this._texturesPending) return;
        this._texturesPending = true;
        this.status = t("cloudLayers.status.generating");
        requestCloudNoiseTextures().then(textures => {
            this._texturesPending = false;
            if (this._disposed) return;
            this.volume.setTextures(textures);
            this.updateVolumeVisibility();
            this.updateStatus();
            setRenderOne(true);
        }).catch(error => {
            this._texturesPending = false;
            console.error("Cloud noise generation failed", error);
            this.status = t("cloudLayers.status.failed");
        });
    }

    updateVolumeVisibility() {
        this.volume.setViews(this.showMain, this.showLook);
        this.volume.setVisible(this.hasVisibleLayers);
    }

    updateStatus() {
        if (!this.anyView) this.status = t("cloudLayers.status.off");
        else if (this.layers.length === 0) this.status = t("cloudLayers.status.noLayers");
        else if (this._texturesPending) this.status = t("cloudLayers.status.generating");
        else {
            const textures = cloudNoiseTextures();
            this.status = t("cloudLayers.status.ready", {
                layers: this.visibleLayers.length,
                milliseconds: textures ? Math.round(textures.milliseconds) : 0,
            });
        }
    }

    // ---- wind ----------------------------------------------------------------

    // Wind velocity (m/s east, north) of a layer at frame f.
    windVelocity(layer, derived, f, out) {
        const mode = layer.wind.mode;
        out.east = 0;
        out.north = 0;
        if (mode === "none") return out;
        if (mode === "custom") return windVelocityEN(layer.wind.from, layer.wind.knots * METERS_PER_SECOND_PER_KNOT, out);
        const midAltitude = layer.baseAltitude + 0.5 * layer.thickness;
        if (mode === "profile") {
            const profile = this.findProfile();
            const wind = profile?.windAtAltitude?.(midAltitude);
            // The profile keeps meters per second, and altitudes above sea level.
            if (wind && Number.isFinite(wind.windDir) && Number.isFinite(wind.windSpeed)) {
                return windVelocityEN(wind.windDir, wind.windSpeed, out);
            }
        }
        const node = NodeMan.get(WIND_NODE_IDS[mode] ?? "localWind", false);
        if (!node) return out;
        const a = Globals.equatorRadius ?? WGS84_A, b = Globals.polarRadius ?? WGS84_B;
        const point = llaToECEF(derived.anchorLat, derived.anchorLon, midAltitude, a, b, this._windPoint);
        this._windPosition.set(point[0], point[1], point[2]);
        const state = typeof node.windStateAt === "function" ? node.windStateAt(f, this._windPosition) : node;
        const from = Number.isFinite(state?.from) ? state.from : node.from;
        const knots = Number.isFinite(state?.knots) ? state.knots : node.knots;
        if (!Number.isFinite(from) || !Number.isFinite(knots)) return out;
        return windVelocityEN(from, knots * METERS_PER_SECOND_PER_KNOT, out);
    }

    findProfile() {
        if (this._profileId && NodeMan.exists(this._profileId)) return NodeMan.get(this._profileId);
        this._profileId = null;
        NodeMan.iterate((id, node) => {
            if (!this._profileId && id.startsWith("atmosphericProfile") && typeof node.windAtAltitude === "function") {
                this._profileId = id;
            }
        });
        return this._profileId ? NodeMan.get(this._profileId) : null;
    }

    update(f) {
        super.update(f);
        if (!this.hasVisibleLayers) return;
        for (let index = 0; index < this.visibleLayers.length; index++) {
            const layer = this.visibleLayers[index];
            const derived = this.visibleDerived[index];
            this.windVelocity(layer, derived, f, derived.velocity);
        }
    }

    // ---- rendering -------------------------------------------------------------

    // The per-camera render state (a reused object), or null to draw nothing.
    renderState(camera) {
        if (!this.hasVisibleLayers || this.visibleLayers.length === 0) return null;
        const state = this._renderState;
        const frame = Number.isFinite(par.frame) ? par.frame : 0;
        const seconds = frame / (Sit?.fps > 0 ? Sit.fps : 30);
        state.frame = frame;
        state.quality = this.quality;
        state.radii.a = Globals.equatorRadius ?? WGS84_A;
        state.radii.b = Globals.polarRadius ?? WGS84_B;
        for (let index = 0; index < this.visibleDerived.length; index++) {
            const derived = this.visibleDerived[index];
            const {velocity, east, north, windECEF, windDir} = derived;
            for (let axis = 0; axis < 3; axis++) {
                const v = east[axis] * velocity.east + north[axis] * velocity.north;
                windECEF[axis] = v * seconds;
                windDir[axis] = v;
            }
            const speed = Math.hypot(windDir[0], windDir[1], windDir[2]);
            for (let axis = 0; axis < 3; axis++) windDir[axis] = speed > 1e-6 ? windDir[axis] / speed : east[axis];
        }
        const sunPosition = Globals.sunLight?.position;
        if (sunPosition && sunPosition.lengthSq() > 0) state.sun.dir.copy(sunPosition).normalize();
        const sunNode = NodeMan.get("theSun", false);
        if (sunNode && !sunNode.moonlightMode) {
            state.sun.intensity = (sunNode.ambientOnly ? 0 : sunNode.sunIntensity) * Math.PI * (sunNode.sunBoost ?? 1);
        } else {
            state.sun.intensity = Globals.sunLight?.intensity ?? 0;
        }
        state.sun.angle = Number.isFinite(Globals.sunAngle) ? Globals.sunAngle : 90;
        state.ambient = (Globals.ambientLight?.intensity ?? 0) / Math.PI;
        state.lens = atmosphereFisheyeLens(camera);
        return state;
    }

    // ---- editing (also the API the MCP tests drive) ------------------------------

    changed({rebuildGUI = false} = {}) {
        this.rebuildLayers();
        if (rebuildGUI) this.rebuildLayerFolders();
        markSitchDirty();
        setRenderOne(true);
    }

    // Per-view visibility (the M and L title checkboxes).
    setViews(showMain = this.showMain, showLook = this.showLook) {
        this.showMain = !!showMain;
        this.showLook = !!showLook;
        this.updateViewControllers();
        this.changed();
    }

    // Both views on or off (the look view only, when turning on).
    setEnabled(enabled) {
        this.setViews(false, !!enabled);
    }

    updateViewControllers() {
        this.viewPair?.main.updateDisplay();
        this.viewPair?.look.updateDisplay();
    }

    // Adding clouds while both views are off would show nothing: turn the look view on.
    ensureSomeView() {
        if (!this.anyView) {
            this.showLook = true;
            this.updateViewControllers();
        }
    }

    setQuality(quality) {
        this.quality = CLOUD_QUALITIES.includes(quality) ? quality : "Medium";
        this.qualityController?.updateDisplay();
        this.changed();
    }

    // A point about 50 km ahead of the look camera, on the ground: where a new disc goes.
    defaultDiscCenter() {
        const camera = NodeMan.get("lookCamera", false)?.camera ?? NodeMan.get("mainCamera", false)?.camera;
        if (!camera) return {lat: Sit?.lat ?? 0, lon: Sit?.lon ?? 0};
        const position = camera.position;
        const lla = ECEFToLLAVD_radii(position);
        const forward = new Vector3();
        camera.getWorldDirection(forward);
        const enu = enuBasis(lla.x, lla.y, this._enu);
        const east = forward.x * enu.east[0] + forward.y * enu.east[1] + forward.z * enu.east[2];
        const north = forward.x * enu.north[0] + forward.y * enu.north[1] + forward.z * enu.north[2];
        const length = Math.hypot(east, north);
        if (length < 1e-6) return {lat: lla.x, lon: lla.y};
        const distance = 50000;
        const radiusM = Globals.equatorRadius ?? WGS84_A;
        const lat = lla.x + (north / length) * distance / radiusM / DEG2RAD;
        const lon = lla.y + (east / length) * distance / (radiusM * Math.cos(lla.x * DEG2RAD)) / DEG2RAD;
        return {lat, lon};
    }

    fillDiscCenter(layer) {
        if (layer.extent.mode === "disc" && (layer.extent.lat === null || layer.extent.lon === null)) {
            const center = this.defaultDiscCenter();
            layer.extent.lat = center.lat;
            layer.extent.lon = center.lon;
        }
        return layer;
    }

    // Add a layer from a partial description; returns it, or null when full.
    addLayer(partial = {}) {
        if (this.layers.length >= MAX_CLOUD_LAYERS) return null;
        const type = partial.type ?? "cumulus";
        const defaults = layerDefaultsFor(type);
        const layer = this.fillDiscCenter(normalizeLayer({
            ...defaults,
            ...partial,
            extent: {...defaults.extent, ...(partial.extent ?? {})},
            wind: {...defaults.wind, ...(partial.wind ?? {})},
            seed: partial.seed ?? this.layers.length * 17,
        }, {id: nextLayerId(this.layers)}));
        this.layers.push(layer);
        this.ensureSomeView();
        this.changed({rebuildGUI: true});
        return layer;
    }

    // Change fields of a layer (as the GUI does). Returns the layer.
    setLayer(id, changes = {}) {
        const index = this.layers.findIndex(layer => layer.id === id);
        if (index < 0) return null;
        let layer = this.layers[index];
        if (changes.type && changes.type !== layer.type) layer = applyTypeDefaults(layer, changes.type);
        layer = normalizeLayer({
            ...layer, ...changes,
            extent: {...layer.extent, ...(changes.extent ?? {})},
            wind: {...layer.wind, ...(changes.wind ?? {})},
        });
        this.fillDiscCenter(layer);
        // Keep the same object so GUI proxies stay bound to it.
        Object.assign(this.layers[index], layer);
        this.changed();
        this.refreshLayerFolder(this.layers[index]);
        return this.layers[index];
    }

    removeLayer(id) {
        const index = this.layers.findIndex(layer => layer.id === id);
        if (index < 0) return null;
        const [removed] = this.layers.splice(index, 1);
        this.changed({rebuildGUI: true});
        return {layer: removed, index};
    }

    async deleteLayer(id, {confirm = true} = {}) {
        const index = this.layers.findIndex(layer => layer.id === id);
        if (index < 0) return false;
        const layer = this.layers[index];
        const title = layerTitle(layer, index);
        if (confirm && !await showConfirm(t("cloudLayers.deleteConfirm.message", {name: title}),
            {title: t("cloudLayers.deleteConfirm.title")})) return false;
        const saved = serializeCloudState({layers: [layer]}).layers[0];
        this.removeLayer(id);
        UndoManager?.add({
            undo: () => {
                if (this.layers.length >= MAX_CLOUD_LAYERS || this.layers.some(other => other.id === saved.id)) return;
                this.layers.splice(Math.min(index, this.layers.length), 0, normalizeLayer(saved));
                this.changed({rebuildGUI: true});
            },
            redo: () => this.removeLayer(saved.id),
            description: t("cloudLayers.deleteConfirm.undo", {name: title}),
        });
        return true;
    }

    // Replace every layer with a named preset.
    async applyPreset(name, {confirm = true} = {}) {
        const layers = presetLayers(name);
        if (!layers) return false;
        if (confirm && this.layers.length > 0 && !await showConfirm(
            t("cloudLayers.presetConfirm.message", {name: t(`cloudLayers.presets.${presetKey(name)}`, {defaultValue: name})}),
            {title: t("cloudLayers.presetConfirm.title")})) return false;
        const before = serializeCloudState(this);
        this.layers = layers.map(layer => this.fillDiscCenter(layer));
        this.ensureSomeView();
        this.changed({rebuildGUI: true});
        const after = serializeCloudState(this);
        UndoManager?.add({
            undo: () => this.restoreState(before),
            redo: () => this.restoreState(after),
            description: t("cloudLayers.presetConfirm.undo"),
        });
        return true;
    }

    restoreState(saved) {
        const state = deserializeCloudState(saved);
        this.showMain = state.showMain;
        this.showLook = state.showLook;
        this.quality = state.quality;
        this.layers = state.layers;
        this.updateViewControllers();
        this.qualityController?.updateDisplay();
        this.changed({rebuildGUI: true});
    }

    // ---- serialization -----------------------------------------------------------

    modSerialize() {
        const out = {...super.modSerialize()};
        // A sitch without clouds saves nothing, so existing saves are unchanged.
        if (this.layers.length > 0 || this.showMain || !this.showLook || this.quality !== "Medium") {
            out.clouds = serializeCloudState(this);
        }
        return out;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        // Through the same path the GUI uses: rebuild derived state and folders.
        this.restoreState(v.clouds ?? {});
    }

    // ---- GUI ---------------------------------------------------------------------

    setupGUI() {
        const parent = guiMenus.lighting;
        if (!parent) return;
        this.gui = parent.addFolder(t("cloudLayers.folder.label")).close()
            .tooltip(t("cloudLayers.folder.tooltip"));
        // The M/L title checkboxes: Main view, Look view.
        this.viewPair = this.gui.addCheckboxPair(this, "showMain", "showLook", t("cloudLayers.show.label"));
        this.viewPair.main.tooltip(t("cloudLayers.show.mainTooltip")).onChange(() => this.changed());
        this.viewPair.look.tooltip(t("cloudLayers.show.lookTooltip")).onChange(() => this.changed());
        this.viewPair.main.asFolderToggle({paired: true});
        const qualities = Object.fromEntries(CLOUD_QUALITIES.map(name => [t(`cloudLayers.qualities.${name}`), name]));
        this.qualityController = this.gui.add(this, "quality", qualities).name(t("cloudLayers.quality.label"))
            .tooltip(t("cloudLayers.quality.tooltip"))
            .onChange(() => this.changed());
        this.presetChoice = "";
        const presets = {[t("cloudLayers.preset.choose")]: ""};
        for (const name of CLOUD_PRESET_NAMES) presets[t(`cloudLayers.presets.${presetKey(name)}`, {defaultValue: name})] = name;
        this.presetController = this.gui.add(this, "presetChoice", presets).name(t("cloudLayers.preset.label"))
            .tooltip(t("cloudLayers.preset.tooltip"))
            .onChange(name => {
                this.presetChoice = "";
                this.presetController.updateDisplay();
                if (name) this.applyPreset(name);
            })
            .keepLiveWhenFolderOff();
        const actions = {addLayer: () => this.addLayer({type: "cumulus"})};
        this.addLayerController = this.gui.add(actions, "addLayer").name(t("cloudLayers.addLayer.label"))
            .tooltip(t("cloudLayers.addLayer.tooltip"))
            .keepLiveWhenFolderOff();
        this.gui.add(this, "status").name(t("cloudLayers.status.label")).listen().disable()
            .tooltip(t("cloudLayers.status.tooltip"));
    }

    rebuildLayerFolders() {
        if (!this.gui) return;
        for (const folder of this.layerFolders.values()) folder.destroy();
        this.layerFolders.clear();
        for (let index = 0; index < this.layers.length; index++) this.addLayerFolder(this.layers[index], index);
        this.addLayerController?.enable(this.layers.length < MAX_CLOUD_LAYERS);
    }

    addLayerFolder(layer, index) {
        const folder = this.gui.addFolder(layerTitle(layer, index)).close().tooltip(t("cloudLayers.layer.tooltip"));
        this.layerFolders.set(layer.id, folder);
        const controls = {};
        folder._cloudControls = controls;
        const edit = changes => this.setLayer(layer.id, changes);

        controls.visible = folder.add(layer, "visible").name(t("cloudLayers.visible.label"))
            .tooltip(t("cloudLayers.visible.tooltip"))
            .onChange(value => edit({visible: value}))
            .asFolderToggle();
        const types = Object.fromEntries(CLOUD_TYPE_NAMES.map(name => [t(`cloudLayers.types.${name}`), name]));
        const typeProxy = {type: layer.type};
        controls.type = folder.add(typeProxy, "type", types).name(t("cloudLayers.type.label"))
            .tooltip(t("cloudLayers.type.tooltip"))
            .onChange(value => edit({type: value}));
        controls.typeProxy = typeProxy;

        const length = (key, min, max, step, label, read, write) => {
            const proxy = {value: read()};
            const controller = folder.add(proxy, "value", min, max, step).name(t(`cloudLayers.${label}.label`))
                .tooltip(t(`cloudLayers.${label}.tooltip`))
                .setUnitType("small")
                .onChange(() => edit(write(controller.getSIValue())));
            controller._cloudRead = read;
            controls[key] = controller;
            return controller;
        };
        const number = (key, min, max, step, label, read, write) => {
            const proxy = {value: read()};
            const controller = folder.add(proxy, "value", min, max, step).name(t(`cloudLayers.${label}.label`))
                .tooltip(t(`cloudLayers.${label}.tooltip`))
                .onChange(value => edit(write(value)));
            controller._cloudRead = read;
            controller._cloudProxy = proxy;
            controls[key] = controller;
            return controller;
        };
        const current = () => this.layers.find(other => other.id === layer.id) ?? layer;

        length("baseAltitude", ...CLOUD_LIMITS.baseAltitude, 10, "baseAltitude",
            () => current().baseAltitude, value => ({baseAltitude: value}));
        length("thickness", ...CLOUD_LIMITS.thickness, 10, "thickness",
            () => current().thickness, value => ({thickness: value}));
        number("coverage", 0, 1, 0.01, "coverage", () => current().coverage, value => ({coverage: value}));
        number("density", 0, 5, 0.05, "density", () => current().density, value => ({density: value}));
        length("scale", ...CLOUD_LIMITS.scale, 10, "scale", () => current().scale, value => ({scale: value}));
        number("detail", 0, 1, 0.01, "detail", () => current().detail, value => ({detail: value}));
        number("windSkew", 0, 1, 0.01, "windSkew", () => current().windSkew, value => ({windSkew: value}));

        const extents = Object.fromEntries(CLOUD_EXTENT_MODES.map(name => [t(`cloudLayers.extents.${name}`), name]));
        const extentProxy = {mode: layer.extent.mode};
        controls.extent = folder.add(extentProxy, "mode", extents).name(t("cloudLayers.extent.label"))
            .tooltip(t("cloudLayers.extent.tooltip"))
            .onChange(value => edit({extent: {mode: value}}));
        controls.extentProxy = extentProxy;
        number("lat", -90, 90, 0.0001, "lat", () => current().extent.lat ?? 0, value => ({extent: {lat: value}}));
        number("lon", -180, 180, 0.0001, "lon", () => current().extent.lon ?? 0, value => ({extent: {lon: value}}));
        length("radius", ...CLOUD_LIMITS.radius, 100, "radius", () => current().extent.radius, value => ({extent: {radius: value}}));
        length("feather", ...CLOUD_LIMITS.feather, 100, "feather", () => current().extent.feather, value => ({extent: {feather: value}}));
        const discActions = {centerOnView: () => {
            const center = this.defaultDiscCenter();
            edit({extent: {lat: center.lat, lon: center.lon}});
        }};
        controls.centerOnView = folder.add(discActions, "centerOnView").name(t("cloudLayers.centerOnView.label"))
            .tooltip(t("cloudLayers.centerOnView.tooltip"));
        number("seed", 0, 9999, 1, "seed", () => current().seed, value => ({seed: value}));

        const windFolder = folder.addFolder(t("cloudLayers.wind.label")).close().tooltip(t("cloudLayers.wind.tooltip"));
        const windModes = Object.fromEntries(CLOUD_WIND_MODES.map(name => [t(`cloudLayers.windModes.${name}`), name]));
        const windProxy = {mode: layer.wind.mode};
        controls.windMode = windFolder.add(windProxy, "mode", windModes).name(t("cloudLayers.windSource.label"))
            .tooltip(t("cloudLayers.windSource.tooltip"))
            .onChange(value => edit({wind: {mode: value}}));
        controls.windProxy = windProxy;
        const windNumber = (key, min, max, step, label, read, write) => {
            const proxy = {value: read()};
            const controller = windFolder.add(proxy, "value", min, max, step).name(t(`cloudLayers.${label}.label`))
                .tooltip(t(`cloudLayers.${label}.tooltip`))
                .onChange(value => edit(write(value)));
            controller._cloudRead = read;
            controller._cloudProxy = proxy;
            controls[key] = controller;
        };
        windNumber("windFrom", 0, 359, 1, "windFrom", () => current().wind.from, value => ({wind: {from: value}}));
        windNumber("windKnots", 0, 300, 1, "windKnots", () => current().wind.knots, value => ({wind: {knots: value}}));

        const actions = {deleteLayer: () => this.deleteLayer(layer.id)};
        folder.add(actions, "deleteLayer").name(t("cloudLayers.deleteLayer.label"))
            .tooltip(t("cloudLayers.deleteLayer.tooltip"))
            .keepLiveWhenFolderOff();
        this.refreshLayerFolder(layer);
    }

    // Show the layer's current values and only the controls that apply to it.
    refreshLayerFolder(layer) {
        const folder = this.layerFolders.get(layer.id);
        if (!folder) return;
        const index = this.layers.indexOf(layer);
        folder.title(layerTitle(layer, index));
        const controls = folder._cloudControls;
        controls.typeProxy.type = layer.type;
        controls.type.updateDisplay();
        controls.extentProxy.mode = layer.extent.mode;
        controls.extent.updateDisplay();
        controls.windProxy.mode = layer.wind.mode;
        controls.windMode.updateDisplay();
        controls.visible.updateDisplay();
        for (const controller of Object.values(controls)) {
            if (!controller?._cloudRead) continue;
            if (controller._unitType) controller.setSIValue(controller._cloudRead());
            else {
                controller._cloudProxy.value = controller._cloudRead();
                controller.updateDisplay();
            }
        }
        const sheet = isSheetType(layer.type);
        const disc = layer.extent.mode === "disc";
        controls.thickness.show(!sheet);
        controls.windSkew.show(!sheet);
        for (const key of ["lat", "lon", "radius", "feather", "centerOnView"]) controls[key].show(disc);
        const custom = layer.wind.mode === "custom";
        controls.windFrom.show(custom);
        controls.windKnots.show(custom);
    }

    dispose() {
        this._disposed = true;
        this.volume.dispose();
        this.gui?.destroy();
        this.gui = undefined;
        this.layerFolders.clear();
        super.dispose();
    }
}

// "Few Cumulus" -> "fewCumulus": the i18n key of a preset name.
export function presetKey(name) {
    const words = name.split(/\s+/);
    return words.map((word, index) => index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
}
