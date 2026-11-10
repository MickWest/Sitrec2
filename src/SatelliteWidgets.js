import {NodeMan} from "./Globals";
import {t} from "./i18n";
import {viewingWidgets} from "./ViewingWidgets";
import {viewingDateInput} from "./StarlinkViewing";
import {SIMULATED_SATELLITE_COLOR} from "./SatelliteSimulation";

// Composition is data. Another technique can reuse time/observer/camera and
// substitute its own widgets without inheriting the Starlink scene preset.
// `merge` puts the one button of "aim" below the camera controls, in one widget.
// That widget starts open, so the button is in view.
export const satellitePanelDefinition = {
    id: "satellite-controls", titleKey: "panels.satellite.title",
    widgets: ["time", "observer", {type: "camera", merge: ["aim"], collapsed: false}, "viewLayout", "satelliteData", "satelliteFilters", "flares", "skyGuides",
        {type: "satelliteInfo", home: "left"}, {type: "cameraInfo", home: "left"}, {type: "clockInfo", home: "right"}],
};

const count = number => number.toLocaleString();
const dateText = date => viewingDateInput(date).replace("T", " ");

// The text of each status line comes from context.satelliteStatus(), the one producer
// of satellite counts. These functions only show it.
export function showDataStatus(element, status) {
    const text = (key, values) => t(`panels.satellite.data.${key}`, values);
    element.style.color = status.simulated ? SIMULATED_SATELLITE_COLOR : "";
    if (!status.data) {
        element.classList.remove("sl-warning");
        element.textContent = text("none");
        element.title = text("noneTip");
        return;
    }
    const values = {count: count(status.total), matching: count(status.matching)};
    if (status.simulated) {
        element.classList.remove("sl-warning");
        element.textContent = text("simulated", values);
        element.title = [text("simulatedDescription"), text(status.loadedCount ? "simulatedOutOfRange" : "simulatedNoData"),
            status.savedTleFilter ? text("simulatedFilterNote") : ""].filter(Boolean).join(" ");
        return;
    }
    element.classList.toggle("sl-warning", status.outside);
    element.textContent = text(status.outside ? "extrapolated" : "loaded", values);
    element.title = status.start
        ? text(status.outside ? "epochsOutside" : "epochs", {start: dateText(status.start), end: dateText(status.end)}) : "";
}

export function showFilterStatus(element, status) {
    const text = (key, values) => t(`panels.satellite.filters.${key}`, values);
    const active = status.data && (status.searchActive || status.tleActive);
    const line = active ? text(status.tleActive ? "matchingTle" : "matching", {count: count(status.matching)}) : "";
    if (element.textContent !== line) element.textContent = line;
    element.title = status.data
        ? [status.searchActive ? text("clearSearchTip") : "", status.tleActive ? text("clearTleTip") : ""].filter(Boolean).join(" ") : "";
}

export function showSatelliteCount(element, status) {
    if (!status.data) {
        element.textContent = t("panels.satellite.data.none");
        element.title = "";
        return;
    }
    element.textContent = t(status.simulated ? "panels.satellite.info.simulatedInView" : "panels.satellite.info.inView", {count: count(status.inView)});
    element.title = t("panels.satellite.info.tooltip");
}

export const satelliteWidgets = {
    ...viewingWidgets,
    aim: {
        titleKey: "panels.widgets.aim.title", html: `<div data-id="aimControl"></div>`,
        mount: ({context: c, scope: s}) => { s.control("aimControl", c.sky, "lookTowardsFlareRegion"); return s.lifecycle(); },
    },
    satelliteData: {
        titleKey: "panels.satellite.data.title",
        html: `<div data-id="loaders"></div><p data-id="loadDate" class="sl-muted"></p><p data-id="dataStatus" class="sl-muted sl-data"></p>`,
        mount: ({context: c, scope: s}) => {
            const sats = c.sky.satellites;
            const current = c.source(sats, "updateActive") ?? c.source(sats, "updateStarlink");
            const dated = c.source(sats, "updateCustomSats") ?? c.source(sats, "updateLEOSats");
            for (const loader of [current, dated]) s.mirror(loader, "loaders");
            s.el("loadDate").hidden = !dated;
            return s.lifecycle({update: () => {
                s.el("loadDate").textContent = t("panels.satellite.data.viewingDate", {date: viewingDateInput(c.dateTime.dateNow).slice(0, 10)});
                showDataStatus(s.el("dataStatus"), c.satelliteStatus());
            }});
        },
    },
    satelliteFilters: {
        titleKey: "panels.satellite.filters.title",
        html: `<div data-id="filterControls"></div><p data-id="filterStatus" class="sl-muted sl-message" role="status"></p><div data-id="categories"></div><div data-id="magnitudeControls"></div><div data-id="satelliteToggles"></div>`,
        mount: ({context: c, scope: s}) => {
            const sky = c.sky, sats = sky.satellites;
            const text = key => t(`panels.satellite.filters.${key}`);
            s.control("filterControls", sats, "nameFilter", {name: text("search"), inputType: "search"});
            for (const property of ["filterTLEs", "clearTLEFilter"]) s.mirror(c.findSource(property), "filterControls");
            for (const [property, key] of [["showStarlink", "starlink"], ["showOtherSatellites", "other"], ["showISS", "iss"], ["showBrightest", "brightest"]]) {
                s.control("categories", sats, property, {name: text(key)});
            }
            s.group("categories").domElement.classList.add("modern-grid");
            s.control("magnitudeControls", sky, "satelliteMagnitudeLimitEnabled", {name: text("limitMagnitude")});
            s.control("magnitudeControls", sky, "satelliteMagnitudeLimit", {name: text("magnitude")});
            s.control("satelliteToggles", sats, "showSatellites", {name: text("show")});
            s.control("satelliteToggles", sats, "showSatelliteNames", {name: text("names")});
            return s.lifecycle({update: () => {
                const photometric = sats.brightnessModel === "Photometric estimate";
                s.el("magnitudeControls").title = text(photometric ? "magnitudeTip" : "magnitudeNeedsModelTip");
                showFilterStatus(s.el("filterStatus"), c.satelliteStatus());
            }});
        },
    },
    flares: {
        titleKey: "panels.satellite.flares.title", html: `<div data-id="flareGuides" data-i18n-title="panels.satellite.flares.tooltip"></div>`,
        mount: ({context: c, scope: s}) => {
            for (const property of ["showSunArrows", "showFlareBand"]) s.control("flareGuides", c.sky, property);
            for (const [property, view] of [["showFlareRegionMain", "mainView"], ["showFlareRegionLook", "lookView"]]) {
                s.control("flareGuides", c.sky, property)?.asViewCheckbox(view, t("panels.satellite.flares.region"));
            }
            return s.lifecycle();
        },
    },
    skyGuides: {
        titleKey: "panels.satellite.skyGuides.title", collapsed: true, html: `<div data-id="guides"></div>`,
        mount: ({context: c, scope: s}) => {
            for (const property of ["showConstellationsLook", "showEquatorialGridLook", "showHorizonCompassRibbonLook"]) s.control("guides", c.sky, property);
            s.control("guides", NodeMan.get("lookView_NightSkyOverlay"), "showStarNames");
            return s.lifecycle();
        },
    },
    satelliteInfo: {
        titleKey: "panels.satellite.info.title", html: `<strong data-id="count" data-i18n="panels.satellite.info.loading"></strong>`,
        mount: ({context: c, scope: s}) => ({update: () => showSatelliteCount(s.el("count"), c.satelliteStatus())}),
    },
};
