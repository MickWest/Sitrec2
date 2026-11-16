import {createNativeControlGroup, mirrorControl} from "./NativeControls";
import {modernControlStyle} from "./ModernControlStyle";
import {routeNativeKeys} from "./NativeKeyRouting";
import {t} from "./i18n";
import {SIMULATED_SATELLITE_COLOR} from "./SatelliteSimulation";

const categories = ["showStarlink", "showISS", "showBrightest", "showOtherSatellites"];
const presets = {all: [true, true, true, true], starlink: [true, false, false, false],
    iss: [false, true, false, false], brightest: [false, false, true, false]};
const text = (key, values) => t(`satelliteEditor.${key}`, values);

export function satelliteDisplayPreset(sats) {
    if (!sats.showSatellites) return "hidden";
    if (sats.showSatelliteList.trim()) return "custom";
    return Object.keys(presets).find(key => categories.every((property, i) => !!sats[property] === presets[key][i])) ?? "custom";
}

export class SatelliteEditor {
    constructor(container, {satellites, source, dateTime, advanced, changed}) {
        Object.assign(this, {satellites, source, dateTime, advanced, changed});
        const doc = container.ownerDocument;
        if (!doc.getElementById("sitrec-satellite-editor-style")) {
            const style = doc.createElement("style");
            style.id = "sitrec-satellite-editor-style";
            style.textContent = modernControlStyle + `
                .satellite-editor { color: var(--panel-text); font: 11px/1.35 system-ui,sans-serif; padding: 7px; min-width: 0; }
                .satellite-editor .se-row { display: flex; align-items: center; gap: 5px; margin: 5px 0; }
                .satellite-editor .se-grow { flex: 1; min-width: 0; }
                .satellite-editor input, .satellite-editor select, .satellite-editor button { min-width: 0; box-sizing: border-box; font: inherit; color: inherit; background: var(--panel-field); border: 1px solid var(--panel-border); border-radius: 4px; padding: 4px; }
                .satellite-editor button { cursor: pointer; }
                .satellite-editor.satellite-editor button { width: auto; text-align: center; flex-shrink: 0; }
                .satellite-editor [hidden] { display: none !important; }
                .satellite-editor .se-grow { width: 0; }
                .satellite-editor button:hover { background: var(--panel-hover); }
                .satellite-editor :focus-visible { outline: 2px solid #82d9b4; outline-offset: 1px; }
                .satellite-editor .se-status { font-weight: 600; }
                .satellite-editor .se-detail { color: var(--panel-muted); overflow-wrap: anywhere; }
                .satellite-editor [data-tone=warning] { color: var(--panel-warning); }
                .satellite-editor [data-tone=simulated] { color: ${SIMULATED_SATELLITE_COLOR}; }
                .satellite-editor .se-count { min-height: 15px; color: var(--panel-muted); }
                .satellite-advanced > summary { cursor: pointer; padding: 7px; font: 11px system-ui,sans-serif; }
            `;
            doc.head.append(style);
        }
        const root = this.root = doc.createElement("div");
        root.className = "satellite-editor sitrec-modern";
        root.dataset.interactionNative = "true";
        root.dataset.widgetPath = text("title");
        root.innerHTML = `<div class="se-row"><div class="se-grow"><div class="se-status" role="status" data-id="status"></div><div class="se-detail" data-id="date"></div></div><button type="button" data-id="refresh"></button></div>
            <div class="se-detail" data-id="detail"></div>
            <div class="se-row"><input class="se-grow" data-id="search" type="search"><button type="button" data-id="clear">×</button></div>
            <div class="se-row"><label class="se-grow" data-id="showLabel"></label><select class="se-grow" data-id="show"></select></div>
            <div class="se-count" data-id="count"></div><div data-id="controls"></div><button type="button" data-id="advanced"></button>`;
        container.append(root);
        const elements = new Map([...root.querySelectorAll("[data-id]")].map(element => [element.dataset.id, element]));
        this.el = id => elements.get(id);
        this.el("showLabel").textContent = text("show");
        this.el("show").setAttribute("aria-label", text("show"));
        this.el("search").placeholder = text("search");
        this.el("search").setAttribute("aria-label", text("search"));
        this.el("clear").setAttribute("aria-label", text("clear"));
        this.el("clear").title = text("clear");
        for (const key of [...Object.keys(presets), "custom", "hidden"]) {
            const option = doc.createElement("option");
            option.value = key; option.textContent = text(key); this.el("show").append(option);
        }
        this.el("search").oninput = () => this.set("nameFilter", this.el("search").value);
        this.el("clear").onclick = () => { this.set("nameFilter", ""); this.update(); this.el("search").focus(); };
        this.el("show").onchange = () => {
            const key = this.el("show").value;
            if (key === "custom") { advanced("Selection & Filters"); return; }
            this.set("showSatellites", key !== "hidden");
            if (presets[key]) {
                this.set("showSatelliteList", "");
                categories.forEach((property, i) => this.set(property, presets[key][i]));
            }
            this.update();
        };
        const group = this.group = createNativeControlGroup(this.el("controls"), {onChange: changed});
        mirrorControl(source("satScale"), group, {name: text("brightness")});
        for (const [property, view] of [["showSatelliteNamesMain", "mainView"], ["showSatelliteNames", "lookView"]]) {
            mirrorControl(source(property), group)?.asViewCheckbox(view, text("labels"));
        }
        this.el("advanced").textContent = text("advanced");
        this.el("advanced").onclick = () => advanced();
        this.el("refresh").onclick = () => {
            const loader = satellites.catalogLoader;
            if (loader.state.phase === "loading") loader.cancel();
            else loader.refresh(dateTime.dateNow);
            this.update();
        };
        routeNativeKeys(root);
        this.timer = setInterval(() => this.update(), 250);
        this.update();
    }

    moveSearchTo(container) {
        this.searchRow = this.el("search").parentElement;
        container.append(this.searchRow);
        routeNativeKeys(container);
    }

    set(property, value) { this.source(property)?.setValue(value); this.changed?.(); }

    update() {
        const sats = this.satellites, loader = sats.catalogLoader, state = loader?.state;
        const data = sats.renderTLEData;
        const now = this.dateTime.dateNow;
        const simulated = !!data?.simulated;
        const outside = data && (now < data.startDate || now > data.endDate);
        const phase = state?.phase;
        const key = phase === "loading" ? "loading" : simulated ? "simulated" : !data?.satData.length ? "none" : outside ? "outdated" : "loaded";
        this.el("status").textContent = text(key);
        this.el("status").dataset.tone = simulated ? "simulated" : outside ? "warning" : "";
        this.el("date").textContent = text("date", {date: now.toISOString().slice(0, 10)});
        this.el("refresh").hidden = !loader;
        this.el("refresh").textContent = text(phase === "loading" ? "cancel" : "refresh");
        this.el("refresh").title = text(loader?.automatic ? "refreshTip" : "fixedTip");
        let detail = simulated ? text("simulationTip") : loader?.automatic ? "" : text("fixed");
        if (phase === "loading") detail = text("downloading", {size: ((state.bytes ?? 0) / 1048576).toFixed(1)}) + (simulated ? ` · ${text("simulated")}` : "");
        if (phase === "error") detail = text("error", {error: state.error});
        if (phase === "cancelled") detail = text("cancelled");
        if (outside && !simulated && phase !== "loading" && phase !== "error") detail = text("outdatedTip");
        this.el("detail").textContent = detail;
        this.el("detail").hidden = !detail;
        if (this.root.ownerDocument.activeElement !== this.el("search")) this.el("search").value = sats.nameFilter;
        this.el("clear").disabled = !sats.nameFilter;
        this.el("show").value = satelliteDisplayPreset(sats);
        // Both editors can read the same catalog. Counts only need a small reduction,
        // once a second, while either editor is visible.
        if (!sats._editorCount || performance.now() - sats._editorCount.at > 1000 || sats._editorCount.data !== data) {
            sats._editorCount = {at: performance.now(), data, total: data?.satData.length ?? 0,
                matching: data?.satData.filter(sat => sat.visible).length ?? 0};
        }
        const {total, matching} = sats._editorCount;
        this.el("count").textContent = text("count", {total: total.toLocaleString(), matching: (sats.showSatellites ? matching : 0).toLocaleString()})
            + (sats.tleFilterResults && !simulated ? ` · ${text("filtered")}` : "");
        this.group.updateListeners();
    }

    dispose() { clearInterval(this.timer); this.group.destroy(); this.searchRow?.remove(); this.root.remove(); }
}
