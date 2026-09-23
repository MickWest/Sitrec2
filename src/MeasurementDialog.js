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
        titleBar.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startX = e.clientX - modal.offsetLeft;
            const startY = e.clientY - modal.offsetTop;
            // Capture keeps the drag going when the pointer runs ahead of the panel.
            try { titleBar.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
            const move = (ev) => {
                // Keep at least the title bar on screen, so the panel can always be moved back.
                const x = Math.min(Math.max(ev.clientX - startX, 40 - modal.offsetWidth), window.innerWidth - 40);
                const y = Math.min(Math.max(ev.clientY - startY, 0), window.innerHeight - 40);
                modal.style.left = x + "px";
                modal.style.top = y + "px";
            };
            const up = () => {
                titleBar.removeEventListener("pointermove", move);
                titleBar.removeEventListener("pointerup", up);
                titleBar.removeEventListener("pointercancel", up);
            };
            titleBar.addEventListener("pointermove", move);
            titleBar.addEventListener("pointerup", up);
            titleBar.addEventListener("pointercancel", up);
        });

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
                if (type === "distance" && !state.to) state.to = defaultOtherRef(state.from);
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

        function defaultOtherRef(from) {
            for (const kind of manager.sourceKinds) {
                const other = manager.listSources(kind).find(s => !(from && from.kind === kind && from.id === s.id));
                if (other) return {kind, id: other.id};
            }
            return null;
        }

        function renderPicker(container, which) {
            container.textContent = "";
            const current = state[which];

            const tabs = el("div", "display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;");
            container.appendChild(tabs);
            for (const kind of manager.sourceKinds) {
                const count = manager.listSources(kind).length;
                const holdsCurrent = current?.kind === kind;
                // "Other" is only for an old save's odd reference; it has no list of its own.
                if (kind === "node" && !holdsCurrent) continue;
                const selected = shownKind[which] === kind;
                const tab = el("button", `
                    padding: 6px 12px; border-radius: 16px; cursor: pointer; font-family: inherit;
                    font-size: 13px; border: 1px solid ${selected ? BLUE : "#bbb"};
                    background: ${selected ? BLUE : (holdsCurrent ? "#e3f2fd" : "white")};
                    color: ${selected ? "white" : (count || holdsCurrent ? "#222" : "#999")};
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

            const kind = shownKind[which];
            const items = manager.listSources(kind).map(s => ({...s}));
            // The current choice is always listed, even when it is not found (deleted, or an
            // old save's "Other" node), so the user can see what it was.
            if (current?.kind === kind && !items.some(s => s.id === current.id)) {
                items.unshift({id: current.id, name: t("measurements.dialog.missing", {id: current.id}), missing: true});
            }
            if (items.length === 0) {
                list.appendChild(el("div", "padding: 12px; color: #888; font-size: 13px;",
                    t("measurements.dialog.nothingOfKind", {kind: manager.kindLabel(kind)})));
            }
            for (const item of items) {
                const selected = current?.kind === kind && current.id === item.id;
                const row = el("div", `
                    padding: 7px 12px; cursor: pointer; font-size: 14px; border-bottom: 1px solid #eee;
                    background: ${selected ? BLUE : "transparent"};
                    color: ${selected ? "white" : (item.missing ? "#999" : "#222")};
                `, item.name);
                row.title = item.id;
                row.onclick = () => { state[which] = {kind, id: item.id}; render(); };
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
