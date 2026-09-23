// The Add / Edit Measurement dialog (Show > Measurements).
//
// One large panel with everything a measurement has: the type (altitude or distance), the
// point(s) it measures, and how it is drawn. A point is picked in two steps: a row of kind
// tabs (Camera, Traverse, Track, 3D Object, Pin, Building), then the list of that kind's items.
//
// It is a floating panel, not a modal: the scene stays visible and usable, and the panel can
// be moved by its title bar. Every edit is passed to onChange at once so the caller can show
// it live; the caller undoes the edits when the result is null (Cancel or Escape).
//
// Resolves to {action: "apply", config}, {action: "delete"}, or null (cancelled).

import {Globals} from "./Globals";
import {makeDraggable, removeDraggable} from "./DragResizeUtils";
import {t} from "./i18n";

// Units a measurement can override the sitch units with. The keys are the values saved in
// the sitch (see MEASUREMENT_UNITS in CNodeLabels3D.js).
const UNIT_OPTIONS = [
    ["default", "measurements.dialog.unitsDefault"],
    ["m", "measurements.dialog.unitsMeters"],
    ["km", "measurements.dialog.unitsKilometers"],
    ["ft", "measurements.dialog.unitsFeet"],
    ["mi", "measurements.dialog.unitsMiles"],
    ["nm", "measurements.dialog.unitsNautical"],
];

const BLUE = "#1976d2";
const GREY = "#757575";
const RED = "#c62828";

// Only one of these dialogs at a time: a double-click on a menu entry must not stack two.
let dialogOpen = false;
// Closes the open dialog as cancelled, or null when there is none.
let cancelOpenDialog = null;

// Close the open dialog as if Cancel was clicked. For a sitch teardown: the measurement being
// edited is about to go, and the dialog must not outlive it.
export function closeMeasurementDialog() {
    cancelOpenDialog?.();
}

function el(tag, cssText = "", text = undefined) {
    const element = document.createElement(tag);
    if (cssText) element.style.cssText = cssText;
    if (text !== undefined) element.textContent = text;
    return element;
}

function button(text, color, onClick) {
    const b = el("button", `
        padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer;
        font-family: inherit; font-size: 14px; font-weight: bold; color: white; background: ${color};
    `, text);
    b.type = "button";
    b.onclick = onClick;
    return b;
}

function sectionTitle(text) {
    return el("div", "font-size: 13px; font-weight: bold; color: #444; margin: 14px 0 6px;", text);
}

/**
 * @param {object} opts
 * @param {object} opts.config - a normalized measurement config; the dialog edits a copy
 * @param {boolean} opts.isNew - "Add" (no Delete button) rather than "Edit"
 * @param {object} opts.manager - CMeasurementManager: sourceKinds, listSources(kind), kindLabel(kind)
 * @param {function(object)} [opts.onChange] - called with the edited config after every change
 * @returns {Promise<{action:string, config?:object}|null>}
 */
export function openMeasurementDialog({config, isNew, manager, onChange}) {
    return new Promise((resolve) => {
        // No user to click in validation/regression runs.
        if (Globals.validationMode || dialogOpen) {
            resolve(null);
            return;
        }
        dialogOpen = true;

        const state = {
            ...config,
            from: config.from ? {...config.from} : null,
            to: config.to ? {...config.to} : null,
        };

        // Starts in the right half of the window, so the main view on the left stays clear.
        const width = Math.min(760, window.innerWidth * 0.46);
        const modal = el("div", `
            position: fixed; z-index: 10000; left: ${Math.round(window.innerWidth * 0.52)}px; top: 50px;
            background: white; border-radius: 8px; padding: 0 24px 20px; box-sizing: border-box;
            width: ${Math.round(width)}px; max-height: calc(100vh - 70px); overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45); font-family: Arial, sans-serif; color: #222;
        `);
        // Native UI for the InteractionRouter. It hit-tests the views by screen position, so
        // without this a press on anything here that is not a button or input (the item rows,
        // the dialog background) starts a camera drag on the view behind and captures the
        // pointer, and the row never gets its click. It also keeps the wheel for the lists.
        modal.dataset.interactionNative = "true";

        // The title bar moves the panel. Sticky, so it stays reachable when the panel scrolls.
        const titleBar = el("h3", `
            margin: 0 -24px 4px; padding: 16px 24px 8px; color: ${BLUE}; font-size: 20px;
            cursor: move; user-select: none; position: sticky; top: 0; background: white;
        `, t(isNew ? "measurements.dialog.addTitle" : "measurements.dialog.editTitle"));
        modal.appendChild(titleBar);
        // The shared floating-window drag (the same one the track filter dialog uses).
        makeDraggable(modal, {handle: titleBar});

        // --- type ----------------------------------------------------------
        modal.appendChild(sectionTitle(t("measurements.dialog.type")));
        const typeRow = el("div", "display: flex; gap: 10px;");
        modal.appendChild(typeRow);
        const typeButtons = {};
        for (const type of ["altitude", "distance"]) {
            const b = el("button", `
                flex: 1; text-align: left; padding: 10px 14px; border-radius: 6px; cursor: pointer;
                font-family: inherit; border: 2px solid #ccc; background: #f5f5f5; color: #222;
            `);
            b.type = "button";
            b.appendChild(el("div", "font-size: 15px; font-weight: bold;", t("measurements.dialog." + type)));
            b.appendChild(el("div", "font-size: 12px; opacity: 0.75; margin-top: 3px;",
                t("measurements.dialog." + type + "Hint")));
            b.onclick = () => {
                state.type = type;
                // Moving to a distance with no "To" yet: start it on something other than
                // "From", which is the usual case, rather than on nothing.
                if (type === "distance" && (!state.to || sameRef(state.from, state.to))) state.to = defaultOtherRef();
                render();
            };
            typeButtons[type] = b;
            typeRow.appendChild(b);
        }

        // --- points --------------------------------------------------------
        const fromTitle = sectionTitle("");
        modal.appendChild(fromTitle);
        const fromPicker = el("div");
        modal.appendChild(fromPicker);

        const toTitle = sectionTitle(t("measurements.dialog.to"));
        modal.appendChild(toTitle);
        const toPicker = el("div");
        modal.appendChild(toPicker);

        // The kind tab each picker is showing. Starts on the kind of the current choice.
        const shownKind = {from: state.from?.kind ?? "camera", to: state.to?.kind ?? "traverse"};

        const sameRef = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;

        // What a picker can offer for one kind: its items, less the thing "From" is set to when
        // this is the "To" picker (a distance from a thing to itself is always zero), plus the
        // current choice if it is not found (deleted, or an old save's "Other" node), so the
        // user can see what it was.
        function choices(which, kind) {
            const current = state[which];
            const items = manager.listSources(kind)
                .filter(s => !(which === "to" && sameRef(state.from, {kind, id: s.id})));
            if (current?.kind === kind && !items.some(s => s.id === current.id)
                && !(which === "to" && sameRef(state.from, current))) {
                items.unshift({id: current.id, name: t("measurements.dialog.missing", {id: current.id}), missing: true});
            }
            return items;
        }

        // Something for "To" that is not the "From" thing, or null when there is nothing else.
        function defaultOtherRef() {
            for (const kind of manager.sourceKinds) {
                const other = choices("to", kind).find(s => !s.missing);
                if (other) return {kind, id: other.id};
            }
            return null;
        }

        function renderPicker(container, which) {
            container.textContent = "";
            const current = state[which];

            // Only kinds with something to pick get a tab. When the kind on show has none left,
            // show the current choice's kind, or else the first kind that has something.
            const kinds = manager.sourceKinds.filter(kind => choices(which, kind).length > 0);
            if (!kinds.includes(shownKind[which])) {
                shownKind[which] = kinds.includes(current?.kind) ? current.kind : kinds[0];
            }

            const tabs = el("div", "display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;");
            container.appendChild(tabs);
            for (const kind of kinds) {
                const count = choices(which, kind).filter(s => !s.missing).length;
                const holdsCurrent = current?.kind === kind;
                const selected = shownKind[which] === kind;
                const tab = el("button", `
                    padding: 6px 12px; border-radius: 16px; cursor: pointer; font-family: inherit;
                    font-size: 13px; border: 1px solid ${selected ? BLUE : "#bbb"};
                    background: ${selected ? BLUE : (holdsCurrent ? "#e3f2fd" : "white")};
                    color: ${selected ? "white" : "#222"};
                `, manager.kindLabel(kind) + (kind === "node" ? "" : ` (${count})`));
                tab.type = "button";
                tab.onclick = () => { shownKind[which] = kind; render(); };
                tabs.appendChild(tab);
            }

            const list = el("div", `
                border: 1px solid #ccc; border-radius: 4px; height: 150px; overflow-y: auto;
                background: #fafafa;
            `);
            container.appendChild(list);

            if (kinds.length === 0) {
                list.appendChild(el("div", "padding: 12px; color: #888; font-size: 13px;",
                    t("measurements.dialog.nothingToPick")));
                return;
            }
            const kind = shownKind[which];
            for (const item of choices(which, kind)) {
                const selected = current?.kind === kind && current.id === item.id;
                const row = el("div", `
                    padding: 7px 12px; cursor: pointer; font-size: 14px; border-bottom: 1px solid #eee;
                    background: ${selected ? BLUE : "transparent"};
                    color: ${selected ? "white" : (item.missing ? "#999" : "#222")};
                `, item.name);
                row.title = item.id;
                row.onclick = () => {
                    state[which] = {kind, id: item.id};
                    // "From" moved onto the thing "To" was set to: move "To" to something else.
                    if (which === "from" && sameRef(state.from, state.to)) {
                        state.to = defaultOtherRef();
                        if (state.to) shownKind.to = state.to.kind;
                    }
                    render();
                };
                list.appendChild(row);
            }
        }

        // --- appearance ----------------------------------------------------
        const grid = el("div", `
            margin-top: 20px;
            display: grid; grid-template-columns: max-content 1fr max-content 1fr;
            gap: 10px 14px; align-items: center; font-size: 14px;
        `);
        modal.appendChild(grid);
        const inputCss = "font-family: inherit; font-size: 14px; padding: 5px 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;";

        const labelInput = el("input", inputCss + "width: 100%;");
        labelInput.type = "text";
        labelInput.value = state.label;
        labelInput.placeholder = t("measurements.dialog.labelPlaceholder");
        labelInput.oninput = () => { state.label = labelInput.value; notify(); };

        const colorInput = el("input", "width: 60px; height: 30px; padding: 0; border: 1px solid #ccc; cursor: pointer;");
        colorInput.type = "color";
        colorInput.value = state.color;
        colorInput.oninput = () => { state.color = colorInput.value; notify(); };

        const widthInput = el("input", inputCss + "width: 80px;");
        widthInput.type = "number";
        widthInput.min = "0.5";
        widthInput.max = "20";
        widthInput.step = "0.5";
        widthInput.value = String(state.lineWidth);
        widthInput.oninput = () => {
            const value = parseFloat(widthInput.value);
            if (Number.isFinite(value) && value > 0) { state.lineWidth = value; notify(); }
        };

        const unitsSelect = el("select", inputCss);
        for (const [value, key] of UNIT_OPTIONS) {
            const option = el("option", "", t(key));
            option.value = value;
            unitsSelect.appendChild(option);
        }
        unitsSelect.value = UNIT_OPTIONS.some(([value]) => value === state.units) ? state.units : "default";
        unitsSelect.onchange = () => { state.units = unitsSelect.value; notify(); };

        const showInput = el("input", "width: 18px; height: 18px; cursor: pointer;");
        showInput.type = "checkbox";
        showInput.checked = state.show;
        showInput.onchange = () => { state.show = showInput.checked; notify(); };

        const addField = (key, input, span = false) => {
            grid.appendChild(el("label", "font-weight: bold; color: #444;", t("measurements.dialog." + key)));
            if (span) input.style.gridColumn = "span 3";
            grid.appendChild(input);
        };
        addField("label", labelInput, true);
        addField("color", colorInput);
        addField("lineWidth", widthInput);
        addField("units", unitsSelect);
        addField("show", showInput);

        // --- buttons -------------------------------------------------------
        const buttons = el("div", "display: flex; gap: 10px; margin-top: 22px; align-items: center;");
        modal.appendChild(buttons);
        if (!isNew) buttons.appendChild(button(t("measurements.dialog.delete"), RED, () => close({action: "delete"})));
        buttons.appendChild(el("div", "flex: 1;"));
        buttons.appendChild(button(t("measurements.dialog.cancel"), GREY, () => close(null)));
        const okButton = button(t(isNew ? "measurements.dialog.add" : "measurements.dialog.ok"), BLUE, () => {
            if (canApply()) close({action: "apply", config: currentConfig()});
        });
        buttons.appendChild(okButton);

        function currentConfig() {
            return {...state, to: state.type === "altitude" ? null : state.to};
        }

        // Live preview: the caller applies every change as it is made.
        function notify() {
            onChange?.(currentConfig());
        }

        function canApply() {
            return !!state.from && (state.type === "altitude" || !!state.to);
        }

        function render() {
            for (const [type, b] of Object.entries(typeButtons)) {
                const selected = state.type === type;
                b.style.borderColor = selected ? BLUE : "#ccc";
                b.style.background = selected ? "#e3f2fd" : "#f5f5f5";
            }
            const altitude = state.type === "altitude";
            fromTitle.textContent = t(altitude ? "measurements.dialog.point" : "measurements.dialog.from");
            renderPicker(fromPicker, "from");
            toTitle.style.display = altitude ? "none" : "";
            toPicker.style.display = altitude ? "none" : "";
            if (!altitude) renderPicker(toPicker, "to");
            const ok = canApply();
            okButton.disabled = !ok;
            okButton.style.opacity = ok ? "1" : "0.45";
            okButton.style.cursor = ok ? "pointer" : "not-allowed";
            notify();
        }

        function close(result) {
            document.removeEventListener("keydown", onDocumentKey);
            removeDraggable(modal);
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            dialogOpen = false;
            cancelOpenDialog = null;
            resolve(result);
        }
        cancelOpenDialog = () => close(null);

        // Keys stay in the dialog: the app's keyboard shortcuts (space to play, and so on)
        // must not act on the sitch while typing here. Bubble phase, so the dialog's own inputs
        // get the key first; the app listens on the document (KeyBoardHandler), above the panel.
        const onKey = (e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                close(null);
            } else if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT") {
                e.preventDefault();
                okButton.click();
            }
        };
        // The panel is not modal, so focus can move to the scene while it is open. Escape still
        // cancels it from there, rolling back the preview.
        const onDocumentKey = (e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            close(null);
        };
        modal.addEventListener("keydown", onKey);
        document.addEventListener("keydown", onDocumentKey);
        modal.addEventListener("keyup", (e) => e.stopPropagation());

        render();
        document.body.appendChild(modal);
        labelInput.focus();
    });
}
