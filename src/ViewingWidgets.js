import {NodeMan} from "./Globals";
import {t} from "./i18n";
import {compassHeading, viewingDateInput} from "./StarlinkViewing";
import {resolveLocationString} from "./CoordinateInput";
import {disableFreeLook} from "./FreeLookGuard";

// Reusable observer widgets. The context supplies the existing scene adapters;
// these definitions contain presentation, never copies of scientific state.
//
// Each widget is self-contained. mount() gets the context (scene state and sources)
// and a scope (the elements and control groups of this instance only). It returns its
// hooks: `update` refreshes its own elements from the scene, and the scope adds
// `setActive` and `dispose` for its control groups.
// Text is not in the templates: each string is a key in src/i18n/en.js, section panels.

const observerText = key => t(`panels.widgets.observer.${key}`);

// A field that the user edits keeps its draft while it has the focus.
function syncValue(input, value) {
    if (input.ownerDocument.activeElement !== input && input.value !== String(value)) input.value = value;
}

function mountObserver(c, s) {
    // A newer edit or search cancels the result of an older search.
    let ticket = 0, pending = 0;
    const message = text => { s.el("locationMessage").textContent = text; };
    s.group("altitudeControls", {onChange: () => { ticket++; }});
    s.mirror(c.observer.guiAlt?.guiEntry, "altitudeControls", {name: observerText("altitude"), unitLabel: true, displayDecimals: 3})?.noSlider();

    const setLocation = id => {
        if (!c.observerIsManual) return;
        const input = s.el(id);
        if (input.value === "" || !input.checkValidity()) {
            message(observerText("invalid"));
            return;
        }
        ticket++;
        // Display precision must not change the untouched coordinates.
        const lla = c.observer._LLA.slice();
        const index = ["lat", "lon"].indexOf(id);
        const value = input.valueAsNumber;
        if (lla[index] !== value) {
            lla[index] = value;
            c.observer.gotoLLA(...lla, c.observer.agl);
        }
        message("");
        c.sync();
    };

    const findLocation = async () => {
        if (!c.observerIsManual) return;
        const query = s.el("search").value.trim();
        if (!query) return;
        const mine = ++ticket;
        pending = mine;
        s.el("go").disabled = true;
        message(observerText("finding"));
        try {
            const result = await resolveLocationString(query);
            if (c.disposed || mine !== ticket || !c.observerIsManual) return;
            if (!result) {
                message(observerText("notFound"));
                return;
            }
            c.observer.gotoLLA(result.lat, result.lon, result.alt ?? 2, result.alt === undefined);
            message(t("panels.widgets.observer.moved", {place: query}));
            c.sync();
        } catch (error) {
            if (!c.disposed && mine === ticket) message(observerText("failed"));
        } finally {
            if (!c.disposed && pending === mine) {
                pending = 0;
                c.sync();
            }
        }
    };

    s.el("locationForm").onsubmit = event => { event.preventDefault(); findLocation(); };
    for (const id of ["lat", "lon"]) s.el(id).onchange = () => setLocation(id);
    s.el("heightRef").onchange = () => { c.setControl(c.observer, "agl", s.el("heightRef").value === "agl"); c.sync(); };

    return s.lifecycle({update: () => {
        const manual = c.observerIsManual;
        ["lat", "lon"].forEach((id, i) => {
            syncValue(s.el(id), Number(c.observer._LLA[i].toFixed(5)));
            s.el(id).disabled = !manual;
        });
        s.el("altitudeControls").inert = !manual;
        s.el("altitudeControls").setAttribute("aria-disabled", String(!manual));
        s.el("heightRef").value = c.observer.agl ? "agl" : "msl";
        for (const id of ["heightRef", "search"]) s.el(id).disabled = !manual;
        s.el("go").disabled = !manual || !!pending;
        s.el("observerNote").textContent = manual ? "" : observerText("trackControlled");
        s.el("locationControls").title = manual ? "" : observerText("trackControlledTip");
    }});
}

export const viewingWidgets = {
    time: {
        titleKey: "panels.widgets.time.title",
        mount: ({body, context}) => {
            const editor = context.dateTime.createTimeEditor(body);
            return {dispose: () => editor.dispose()};
        },
    },
    observer: {
        titleKey: "panels.widgets.observer.title",
        html: `<div data-id="locationControls">
            <form data-id="locationForm" class="sl-row"><input data-id="search" type="search" data-i18n-label="panels.widgets.observer.search.label" data-i18n-placeholder="panels.widgets.observer.search.placeholder" data-i18n-title="panels.widgets.observer.search.tooltip"><button type="submit" data-id="go" data-i18n="panels.widgets.observer.go"></button></form>
            <div class="sl-grid">
                <label><span data-i18n="panels.widgets.observer.latitude.label"></span><input data-id="lat" type="number" min="-90" max="90" step="any" data-i18n-title="panels.widgets.observer.latitude.tooltip"></label>
                <label><span data-i18n="panels.widgets.observer.longitude.label"></span><input data-id="lon" type="number" min="-180" max="180" step="any" data-i18n-title="panels.widgets.observer.longitude.tooltip"></label>
                <div data-id="altitudeControls"></div>
                <label><span data-i18n="panels.widgets.observer.heightRef.label"></span><select data-id="heightRef" data-i18n-title="panels.widgets.observer.heightRef.tooltip"><option value="agl" data-i18n="panels.widgets.observer.heightRef.agl"></option><option value="msl" data-i18n="panels.widgets.observer.heightRef.msl"></option></select></label>
            </div>
            <p data-id="observerNote" class="sl-muted"></p>
            <p data-id="locationMessage" class="sl-muted sl-message" role="status"></p>
        </div>`,
        mount: ({context, scope}) => mountObserver(context, scope),
    },
    camera: {
        titleKey: "panels.widgets.camera.title", collapsed: true,
        html: `<div data-id="cameraControls"><div data-id="angles"></div><div data-id="zoom"></div></div>`,
        mount: ({context: c, scope: s}) => {
            s.group("angles", {beforeEdit: disableFreeLook});
            s.control("angles", NodeMan.get("CameraLOSController"), "choice");
            for (const controller of [c.ptz.azController, c.ptz.elController]) s.mirror(controller, "angles", {listen: true});
            s.mirror(c.ptz.fovController, "zoom", {listen: true});
            return s.lifecycle({update: () => {
                s.el("cameraControls").title = t(c.headingIsManual ? "panels.widgets.camera.manualTip" : "panels.widgets.camera.sourceTip");
            }});
        },
    },
    viewLayout: {
        titleKey: "panels.widgets.viewLayout.title",
        html: `<div class="sl-row sl-segments" data-i18n-label="panels.widgets.viewLayout.title"><button data-action="sky" data-i18n="panels.widgets.viewLayout.sky"></button><button data-action="split" data-i18n="panels.widgets.viewLayout.split"></button></div>`,
        mount: ({body, context: c}) => {
            body.addEventListener("click", event => {
                const action = event.target.closest("button")?.dataset.action;
                if (action) c.action(action);
            });
            return {update: () => {
                body.querySelector('[data-action="sky"]').setAttribute("aria-pressed", String(c.skyOverviewLayout));
                body.querySelector('[data-action="split"]').setAttribute("aria-pressed", String(c.splitLayout));
            }};
        },
    },
    clockInfo: {
        titleKey: "panels.widgets.clockInfo.title",
        html: `<strong data-id="clock"></strong><small data-id="clockState"></small>`,
        mount: ({context: c, scope: s}) => ({update: () => {
            const {live, paused, speed} = c.playback;
            const status = t(`timeEditor.status.${live ? "live" : paused ? "paused" : "playing"}`);
            s.el("clock").textContent = t("panels.widgets.clockInfo.utc", {time: viewingDateInput(c.dateTime.dateNow).replace("T", " ")});
            s.el("clockState").textContent = live ? status : t("panels.widgets.clockInfo.state", {status, speed});
        }}),
    },
    cameraInfo: {
        titleKey: "panels.widgets.cameraInfo.title",
        html: `<small data-id="heading"></small>`,
        mount: ({context: c, scope: s}) => ({update: () => {
            s.el("heading").textContent = t("panels.widgets.cameraInfo.heading",
                {compass: compassHeading(c.ptz.az), elevation: c.ptz.el.toFixed(1), fov: c.ptz.fov.toFixed(1)});
        }}),
    },
};
