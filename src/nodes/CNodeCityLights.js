import {Vector3} from "three";
import {CNode} from "./CNode";
import {Globals, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {setCityLightsAttribution} from "../AttributionOverlay";
import {CityLightsMasks} from "../citylights/CityLightsMasks";
import {cityLightsRegion, cityLightsRegionContains} from "../citylights/CityLightsRegion";
import {cityLightsUniforms as uniforms, clearCityLightsUniforms, setCityLightsDefault} from "../citylights/CityLightsShader";

const METHODS = {"Mapped Roads and Buildings": 3, "Geometry Windows": 2, "Texture Regularity": 1, "Hybrid": 4};
const SERIALS = ["enabled", "method", "roads", "paths", "windows", "intensity", "groundBrightness"];
const ATTRIBUTION = {
    attribution: 'City lights: <a href="https://docs.overturemaps.org/attribution/">Overture Maps</a> / <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
};

function groundTarget(camera) {
    const p = camera.position, d = camera.getWorldDirection(new Vector3());
    const a2 = Globals.equatorRadius ** 2, b2 = Globals.polarRadius ** 2;
    const A = (d.x * d.x + d.y * d.y) / a2 + d.z * d.z / b2;
    const B = 2 * ((p.x * d.x + p.y * d.y) / a2 + p.z * d.z / b2);
    const C = (p.x * p.x + p.y * p.y) / a2 + p.z * p.z / b2 - 1;
    const disc = B * B - 4 * A * C;
    const distance = disc >= 0 ? (-B - Math.sqrt(disc)) / (2 * A) : -1;
    return ECEFToLLAVD_radii(distance > 0 ? p.clone().addScaledVector(d, distance) : p);
}

export class CNodeCityLights extends CNode {
    constructor(v) {
        super(v);
        Object.assign(this, {enabled: v.enabled ?? false, method: v.method ?? 3,
            roads: v.roads ?? 60, paths: v.paths ?? 8, windows: v.windows ?? 35,
            intensity: v.intensity ?? 1, groundBrightness: v.groundBrightness ?? .22,
            status: "Off"});
        this.addSimpleSerials(SERIALS);
        this.masks = new CityLightsMasks(status => {this.status = status; setRenderOne(true);});
        this.regions = new Map();
        this.gui = guiMenus.lighting?.addFolder("City Lights").close();
        if (this.gui) {
            this.gui.add(this, "enabled").name("Show City Lights").listen().onChange(() => this.recalculate())
                .tooltip("Approximate nighttime lights on 3D map tiles. Lamp positions and occupied windows are synthetic.");
            this.gui.add(this, "method", METHODS).name("Method").listen().onChange(() => this.recalculate());
            this.densityControllers = [];
            for (const [property, label] of [["roads", "Road Lights (%)"], ["paths", "Paths / Parking (%)"], ["windows", "Lit Windows (%)"]]) {
                const controller = this.gui.add(this, property, 0, 100, 1).name(label).listen()
                    .onChange(() => this.recalculate(property !== "windows"));
                controller.tooltip("Percentage of candidate lights shown. Zero turns this category off. Increasing density adds lights at stable positions.");
                if (property !== "windows") this.densityControllers.push(controller);
                else this.windowController = controller;
            }
            this.gui.add(this, "intensity", 0, 3, .05).name("Light Intensity").listen().onChange(() => this.recalculate());
            this.gui.add(this, "groundBrightness", 0, 1, .02).name("Ground Brightness").listen().onChange(() => this.recalculate());
            this.gui.add(this, "reloadLights").name("Reload Lights").tooltip("Retry loading city-light data for the current views.");
            this.gui.add(this, "status").name("Status").listen().disable();
        }
        this.recalculate();
    }

    normalize() {
        this.enabled = !!this.enabled;
        this.method = [1, 2, 3, 4].includes(Number(this.method)) ? Number(this.method) : 3;
        for (const [key, maximum, fallback] of [["roads", 100, 60], ["paths", 100, 8], ["windows", 100, 35], ["intensity", 3, 1], ["groundBrightness", 1, .22]]) {
            this[key] = Number.isFinite(Number(this[key])) ? Math.max(0, Math.min(maximum, Number(this[key]))) : fallback;
        }
    }

    recalculate(debounce = false) {
        this.normalize();
        uniforms.cityGain.value = this.intensity;
        uniforms.cityDark.value = this.groundBrightness;
        uniforms.cityWindows.value = this.windows / 100;
        setCityLightsDefault(this.enabled);
        const tiles = NodeMan.get("buildings3DTiles", false);
        if (this._applied !== this.enabled || this._tiles !== tiles) {
            tiles?.setCityLights?.(this.enabled);
            this._applied = this.enabled;
            this._tiles = tiles;
        }
        for (const controller of this.densityControllers ?? []) controller.show(this.method >= 3);
        this.windowController?.show(this.method !== 1);
        setCityLightsAttribution(this.enabled && this.method >= 3 ? ATTRIBUTION : null);
        if (!this.enabled || this.method < 3) {
            this.masks.dispose();
            this.regions.clear();
            clearCityLightsUniforms();
            this.status = this.enabled ? "Ready" : "Off";
        }
        clearTimeout(this._densityTimer);
        this._densityPending = debounce;
        if (debounce) this._densityTimer = setTimeout(() => {this._densityPending = false; setRenderOne(true);}, 200);
        setRenderOne(true);
    }

    reloadLights() {
        this.masks.dispose();
        this.regions.clear();
        clearCityLightsUniforms();
        this.recalculate();
    }

    // Called at the actual scene draw, so normal views and exports use their
    // own geographic mask. No camera position or layout is changed here.
    push(view) {
        clearCityLightsUniforms();
        if (!this.enabled) return;
        const tiles = NodeMan.get("buildings3DTiles", false);
        if (!tiles?._perView?.[view.id]) {this.status = "Requires 3D map tiles"; return;}
        if (tiles !== this._tiles) this.recalculate();
        const target = groundTarget(view.camera), observer = ECEFToLLAVD_radii(view.camera.position);
        const next = cityLightsRegion(target.x, target.y, observer.z);
        let region = this.regions.get(view.id);
        if (!region || region.across !== next.across || !cityLightsRegionContains(region, target.x, target.y)) {
            region = next;
            this.regions.set(view.id, region);
        }
        if (this.method >= 3) {
            const current = this.masks.views.get(view.id);
            const state = this._densityPending && current ? current : this.masks.get(view.id, region, this.roads, this.paths);
            if (!state.texture) return;
            uniforms.cityMask.value = state.texture;
            uniforms.cityRect.value.fromArray(state.meta.rect);
            uniforms.cityMaskSize.value = state.meta.size;
        }
        // A geographic frame keeps the shader's metre coordinates small and
        // makes the same saved camera produce the same window patterns.
        const lat = Math.round(target.x * 4) / 4, lon = Math.round(target.y * 4) / 4;
        const p = lat * Math.PI / 180, l = lon * Math.PI / 180;
        uniforms.cityOrigin.value.copy(LLAToECEF(lat, lon, 0));
        uniforms.cityEast.value.set(-Math.sin(l), Math.cos(l), 0);
        uniforms.cityNorth.value.set(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p));
        uniforms.cityUp.value.set(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p));
        uniforms.citySquash.value = (Globals.equatorRadius / Globals.polarRadius) ** 2;
        uniforms.cityMode.value = this.method;
    }

    pop() { uniforms.cityMode.value = 0; }

    modDeserialize(values) {
        super.modDeserialize(values);
        this.recalculate();
    }

    dispose() {
        clearTimeout(this._densityTimer);
        this.masks.dispose();
        this.regions.clear();
        setCityLightsDefault(false);
        NodeMan.get("buildings3DTiles", false)?.setCityLights?.(false);
        clearCityLightsUniforms();
        setCityLightsAttribution(null);
        this.gui?.destroy();
        this.gui = undefined;
        super.dispose();
    }
}
