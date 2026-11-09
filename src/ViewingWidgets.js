import {NodeMan} from "./Globals";

// Reusable observer widgets. The context supplies the existing scene adapters;
// these definitions contain presentation, never copies of scientific state.
export const viewingWidgets = {
    time: {
        title: "Time & playback",
        mount: ({body, context}) => {
            const editor = context.dateTime.createTimeEditor(body);
            return {dispose: () => editor.dispose()};
        },
    },
    observer: {
        title: "Observer location",
        html: `<div data-id="locationControls">
            <form data-id="locationForm" class="sl-row"><input data-id="search" type="search" aria-label="Search observer location" placeholder="Place or coordinates…" title="Enter a place name or latitude, longitude."><button type="submit" data-id="go">Go</button></form>
            <div class="sl-grid">
                <label>Latitude<input data-id="lat" type="number" min="-90" max="90" step="any" title="Latitude in degrees, from −90 to 90."></label>
                <label>Longitude<input data-id="lon" type="number" min="-180" max="180" step="any" title="Longitude in degrees, from −180 to 180."></label>
                <div data-id="altitudeControls"></div>
                <label>Altitude reference<select data-id="heightRef" title="Measure altitude above the terrain or mean sea level."><option value="agl">Above ground</option><option value="msl">Above sea level</option></select></label>
            </div>
            <p data-id="observerNote" class="sl-muted"></p>
            <p data-id="locationMessage" class="sl-muted sl-message" role="status"></p>
        </div>`,
        mount: ({context: c}) => {
            c.mirror(c.observer.guiAlt.guiEntry, "altitudeControls", {name: "Altitude", unitLabel: true, displayDecimals: 3}).noSlider();
            c.el("locationForm").onsubmit = e => { e.preventDefault(); c.findLocation(); };
            for (const id of ["lat", "lon"]) c.el(id).onchange = () => c.setLocation(id);
            c.el("heightRef").onchange = () => { c.setControl(c.observer, "agl", c.el("heightRef").value === "agl"); c.sync(); };
            return c.groupLifecycle(["altitudeControls"]);
        },
    },
    camera: {
        title: "Camera direction & zoom", collapsed: true,
        html: `<div data-id="cameraControls"><div data-id="angles"></div><div data-id="zoom"></div></div>`,
        mount: ({context: c}) => {
            c.control("angles", NodeMan.get("CameraLOSController"), "choice");
            for (const controller of [c.ptz.azController, c.ptz.elController]) c.mirror(controller, "angles", {listen: true});
            c.mirror(c.ptz.fovController, "zoom", {listen: true});
            return c.groupLifecycle(["angles", "zoom"]);
        },
    },
    viewLayout: {
        title: "View layout",
        html: `<div class="sl-row sl-segments" aria-label="View layout"><button data-action="sky">Sky + overview</button><button data-action="split">Split views</button></div>`,
        mount: ({body, context}) => {
            body.addEventListener("click", event => {
                const action = event.target.closest("button")?.dataset.action;
                if (action) context.action(action);
            });
        },
    },
    clockInfo: {
        title: "Scene time",
        html: `<strong data-id="clock"></strong><small data-id="clockState"></small>`,
    },
    cameraInfo: {
        title: "Look camera",
        html: `<small data-id="heading"></small>`,
    },
};
