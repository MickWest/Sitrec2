import {NodeMan} from "./Globals";
import {viewingWidgets} from "./ViewingWidgets";

export const SATELLITE_PANEL_NAME = "Satellite Controls";

// Composition is data. Another technique can reuse time/observer/camera and
// substitute its own widgets without inheriting the Starlink scene preset.
export const satellitePanelDefinition = {
    id: "satellite-controls", title: SATELLITE_PANEL_NAME,
    widgets: ["time", "observer", "aim", "camera", "viewLayout", "satelliteData", "satelliteFilters", "flares", "skyGuides",
        {type: "satelliteInfo", home: "left"}, {type: "cameraInfo", home: "left"}, {type: "clockInfo", home: "right"}],
};

export const satelliteWidgets = {
    ...viewingWidgets,
    aim: {
        title: "View adjustments", html: `<div data-id="aimControl"></div>`,
        mount: ({context: c}) => { c.control("aimControl", c.sky, "lookTowardsFlareRegion"); return c.groupLifecycle(["aimControl"]); },
    },
    satelliteData: {
        title: "Satellite data",
        html: `<div data-id="loaders"></div><p data-id="loadDate" class="sl-muted"></p><p data-id="dataStatus" class="sl-muted sl-data"></p>`,
        mount: ({context: c}) => {
            const sats = c.sky.satellites;
            const current = c.source(sats, "updateActive") ?? c.source(sats, "updateStarlink");
            const dated = c.source(sats, "updateCustomSats") ?? c.source(sats, "updateLEOSats");
            for (const loader of [current, dated]) c.mirror(loader, "loaders");
            c.el("loadDate").hidden = !dated;
            return c.groupLifecycle(["loaders"]);
        },
    },
    satelliteFilters: {
        title: "Satellite filters",
        html: `<div data-id="filterControls"></div><p data-id="filterStatus" class="sl-muted sl-message" role="status"></p><div data-id="categories"></div><div data-id="magnitudeControls"></div><div data-id="satelliteToggles"></div>`,
        mount: ({context: c}) => {
            const sky = c.sky, sats = sky.satellites;
            c.control("filterControls", sats, "nameFilter", {name: "Search", inputType: "search"});
            for (const property of ["filterTLEs", "clearTLEFilter"]) c.mirror(c.findSource(property), "filterControls");
            for (const [property, name] of [["showStarlink", "Starlink"], ["showOtherSatellites", "Other loaded"], ["showISS", "ISS"], ["showBrightest", "Brightest"]]) c.control("categories", sats, property, {name});
            c.group("categories").domElement.classList.add("modern-grid");
            c.control("magnitudeControls", sky, "satelliteMagnitudeLimitEnabled", {name: "Limit magnitude"});
            c.control("magnitudeControls", sky, "satelliteMagnitudeLimit", {name: "Magnitude"});
            c.control("satelliteToggles", sats, "showSatellites", {name: "Show satellites"});
            c.control("satelliteToggles", sats, "showSatelliteNames", {name: "Names in Look"});
            return c.groupLifecycle(["filterControls", "categories", "magnitudeControls", "satelliteToggles"]);
        },
    },
    flares: {
        title: "Flares", html: `<div data-id="flareGuides" title="Flare Band marks observing locations on Earth. Flare Region marks where to look in the sky."></div>`,
        mount: ({context: c}) => {
            for (const property of ["showSunArrows", "showFlareBand"]) c.control("flareGuides", c.sky, property);
            for (const [property, view] of [["showFlareRegionMain", "mainView"], ["showFlareRegionLook", "lookView"]]) c.control("flareGuides", c.sky, property)?.asViewCheckbox(view, "Flare Region");
            return c.groupLifecycle(["flareGuides"]);
        },
    },
    skyGuides: {
        title: "Sky guides", collapsed: true, html: `<div data-id="guides"></div>`,
        mount: ({context: c}) => {
            for (const property of ["showConstellationsLook", "showEquatorialGridLook", "showHorizonCompassRibbonLook"]) c.control("guides", c.sky, property);
            c.control("guides", NodeMan.get("lookView_NightSkyOverlay"), "showStarNames");
            return c.groupLifecycle(["guides"]);
        },
    },
    satelliteInfo: {
        title: "Satellites in view", html: `<strong data-id="count">Loading satellites…</strong>`,
    },
};
