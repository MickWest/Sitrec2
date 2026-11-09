import {ControlAdapter} from "./ControlAdapter";
import {registerGUIRoot, unregisterGUIRoot} from "./GUIRootRegistry";
import "./CheckboxDragPaint";

const groups = new Set();
let pollTimer, nextID = 0;
const style = `
.native-controls { font: 11px/1.2 system-ui, sans-serif; color: var(--panel-text, #e4eaf3); min-width: 0; }
.native-control { display: flex; align-items: center; gap: 5px; min-height: 22px; margin: 1px 0; min-width: 0; }
.native-control[hidden], .native-control-pair[hidden] { display: none !important; }
.native-control-label { flex: 1 1 44%; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.native-control-fields { display: flex; align-items: center; gap: 4px; flex: 1 1 56%; min-width: 0; }
.native-control input, .native-control select, .native-control button { box-sizing: border-box; min-width: 0; min-height: 20px; font: inherit; color: inherit; border: 1px solid var(--panel-border, #35465d); border-radius: 3px; background: var(--panel-field, #192433); }
.native-control input:not([type=checkbox]):not([type=range]), .native-control select { width: 100%; padding: 1px 3px; }
.native-control-number input[type=number] { width: 58px !important; flex: 1 1 58px; }
.native-control input[type=range] { width: 56px; flex: 1 1 56px; min-height: 16px; height: 18px; padding: 0; accent-color: var(--panel-accent, #80bcea); touch-action: none; }
.native-control-boolean .native-control-fields { flex: 0 0 auto; }
.native-control input[type=checkbox] { width: 15px; height: 15px; min-height: 15px; margin: 0; accent-color: var(--panel-accent, #80bcea); }
.native-control-function button { width: 100%; padding: 2px 5px; cursor: pointer; }
.native-control-function .native-control-label { display: none; }
.native-control :disabled { opacity: .45; cursor: default; }
.native-control :focus-visible { outline: 2px solid var(--panel-accent, #80bcea); outline-offset: 1px; }
.native-controls.modern-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 8px; }
.native-control-pair { display: flex; align-items: center; gap: 5px; min-height: 22px; }
.native-control-pair > .native-control-label { flex: 1; }
.native-control-pair > .native-control { flex: 0 0 auto; margin: 0; }
.native-control-pair > .native-control > .native-control-label { display: none; }
.native-control-pair .native-control-fields { position: relative; }
.native-control-letter { position: absolute; inset: 0; display: grid; place-items: center; font-size: 10px; opacity: .6; pointer-events: none; }
.native-control input:checked + .native-control-letter { opacity: 0; }
`;

function refreshGroups() { for (const group of groups) group.updateListeners(); }

export function setNativeControlGroupActive(group, active) {
    if (!group || group.disposed) return;
    group.active = active;
    if (active) {
        groups.add(group);
        registerGUIRoot(group);
        group.updateListeners();
        // A paused scene does not run the frame poller. One shared timer keeps
        // metadata and code-driven values current in visible native groups.
        if (!pollTimer) pollTimer = setInterval(refreshGroups, 250);
    } else {
        groups.delete(group);
        unregisterGUIRoot(group);
        if (!groups.size && pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
    }
}

export function createNativeControlGroup(container, {beforeEdit, onChange} = {}) {
    const doc = container.ownerDocument;
    if (!doc.getElementById("sitrec-native-controls-style")) {
        const sheet = doc.createElement("style");
        sheet.id = "sitrec-native-controls-style";
        sheet.textContent = style;
        doc.head.append(sheet);
    }
    const domElement = doc.createElement("div");
    domElement.className = "native-controls";
    domElement.dataset.interactionNative = "true";
    domElement.dataset.checkboxPaint = "true";
    container.append(domElement);
    const group = {
        domElement, controllers: [], disposed: false, beforeEdit, onChange,
        updateListeners() { if (!this.disposed) for (const row of this.controllers) row.updateDisplay(); },
        destroy() {
            if (this.disposed) return;
            setNativeControlGroupActive(this, false);
            this.disposed = true;
            for (const row of [...this.controllers]) row.destroy();
            this.domElement.remove();
        },
    };
    if (beforeEdit) domElement.addEventListener("pointerdown", beforeEdit, true);
    domElement.addEventListener("keydown", event => {
        if (!["Tab", "Escape", "Shift", "Control", "Alt", "Meta"].includes(event.key)) beforeEdit?.();
    }, true);
    for (const type of ["keydown", "keyup"]) domElement.addEventListener(type, event => event.stopPropagation());
    setNativeControlGroupActive(group, true);
    return group;
}

export function mirrorControl(source, group, options = {}) {
    if (!source || !group || group.disposed) return null;
    return bindControl(new ControlAdapter(source, options), group, options);
}

// The renderer accepts the control contract, not a particular legacy class.
// New bindings can implement this interface without creating an OUI controller.
export function bindControl(adapter, group, options = {}) {
    const doc = group.domElement.ownerDocument;
    const initial = adapter.read();
    if (!["boolean", "function", "option", "number", "string"].includes(initial.kind)) {
        throw new Error(`Native control renderer is not available for ${initial.kind}`);
    }
    const row = {
        adapter, parent: group, disposed: false,
        domElement: doc.createElement("div"), $name: doc.createElement("label"), $widget: doc.createElement("div"),
        noSlider() { this.withoutSlider = true; this.$slider?.remove(); this.$slider = null; return this; },
        asListCheckbox() { return this; },
        asViewCheckbox(viewId, name, key = name) {
            if (initial.kind !== "boolean" || !["mainView", "lookView"].includes(viewId)) return this;
            this.viewCheckbox = {viewId, name, key};
            const other = group.controllers.find(control => control !== this && control.viewCheckbox?.key === key
                && control.viewCheckbox.viewId !== viewId);
            if (other && !this.pair) pairRows(viewId === "mainView" ? this : other, viewId === "lookView" ? this : other, name);
            return this;
        },
        updateDisplay(force = false) {
            if (this.disposed) return;
            const state = adapter.read();
            this.domElement.hidden = state.hidden;
            this.domElement.title = state.tooltip || state.name;
            this.$name.textContent = state.name;
            this.$name.style.color = state.labelColor ?? "";
            for (const field of [this.$input, this.$slider]) if (field) {
                field.disabled = state.disabled;
                field.setAttribute("aria-label", state.name);
            }
            const input = this.$input;
            if (state.kind === "boolean") input.checked = !!state.value;
            else if (state.kind === "function") input.textContent = state.name;
            else if (state.kind === "option") {
                if (!this.optionList || this.optionList.length !== state.options.length
                    || state.options.some((option, i) => option.label !== this.optionList[i].label || option.value !== this.optionList[i].value)) {
                    input.replaceChildren(...state.options.map((option, i) => {
                        const element = doc.createElement("option"); element.textContent = option.label; element.value = String(i); return element;
                    }));
                    this.optionList = state.options;
                }
                input.value = String(state.options.findIndex(option => option.value === state.value));
            } else {
                if (force || doc.activeElement !== input) {
                    input.value = state.displayValue;
                }
                if (state.kind === "number") {
                    // Typed values deliberately have no native min/max constraint:
                    // the source adapter owns elastic ranges and allowed expansion.
                    input.step = "any";
                    if (this.$slider) {
                        this.$slider.min = state.min;
                        this.$slider.max = state.max;
                        this.$slider.step = state.step > 0 ? state.step : "any";
                        this.$slider.value = state.rawValue;
                    }
                }
            }
            if (this.pair) this.pair.hidden = [...this.pair.querySelectorAll(".native-control")].every(element => element.hidden);
        },
        destroy() {
            if (this.disposed) return;
            this.dragCleanup?.();
            this.disposed = true;
            group.controllers.splice(group.controllers.indexOf(this), 1);
            this.domElement.remove();
            if (this.pair && !this.pair.querySelector(".native-control")) this.pair.remove();
        },
    };
    row.domElement.className = `native-control native-control-${initial.kind}`;
    if (initial.kind === "boolean") row.domElement.dataset.checkboxRow = "true";
    row.$name.className = "native-control-label";
    row.$widget.className = "native-control-fields";
    row.domElement.append(row.$name, row.$widget);
    group.domElement.append(row.domElement);
    group.controllers.push(row);

    const changed = success => {
        if (!success) { row.updateDisplay(true); return; }
        group.onChange?.({value: adapter.read().value, controller: row});
        refreshGroups();
    };
    const finish = () => adapter.finish();
    const input = row.$input = doc.createElement(initial.kind === "function" ? "button" : initial.kind === "option" ? "select" : "input");
    input.id = `native-control-${++nextID}`;
    row.$name.htmlFor = input.id;
    row.$widget.append(input);
    if (initial.kind === "boolean") {
        input.type = "checkbox";
        input.addEventListener("change", () => { changed(adapter.setValue(input.checked)); finish(); });
    } else if (initial.kind === "function") {
        input.type = "button";
        input.addEventListener("click", () => changed(adapter.trigger()));
    } else if (initial.kind === "option") {
        input.addEventListener("change", () => { changed(adapter.setValue(adapter.read().options[input.selectedIndex]?.value)); finish(); });
    } else if (initial.kind === "number") {
        input.type = "number";
        input.addEventListener("input", () => {
            // Preserve an unfinished '-' or decimal draft while it is edited.
            if (Number.isFinite(input.valueAsNumber)) changed(adapter.setNumber(input.valueAsNumber));
        });
        input.addEventListener("blur", () => { finish(); row.updateDisplay(true); });
        bindNumberKeys(input, adapter, changed, finish);
        input.addEventListener("wheel", event => {
            if (doc.activeElement !== input || !event.deltaY && !event.deltaX) return;
            group.beforeEdit?.();
            if (!adapter.canEdit()) return;
            event.preventDefault();
            changed(adapter.wheel(event));
            row.updateDisplay(true);
        }, {passive: false});
        input.addEventListener("pointerdown", event => {
            if (event.button > 0 || event.isPrimary === false || !adapter.canEdit()) return;
            row.dragCleanup?.();
            const startX = event.clientX, startY = event.clientY, value = adapter.read().value;
            let scrubbing = false;
            const move = e => {
                const dx = e.clientX - startX, dy = e.clientY - startY;
                if (!scrubbing) {
                    if (Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) { row.dragCleanup?.(); return; }
                    if (Math.abs(dy) <= 5) return;
                    scrubbing = true;
                }
                e.preventDefault();
                changed(adapter.scrub(value - dy * adapter.read().step * (e.shiftKey ? 0.01 : 1)));
                row.updateDisplay(true);
            };
            const stop = () => { row.dragCleanup?.(); if (scrubbing) finish(); };
            row.dragCleanup = () => {
                doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", stop); doc.removeEventListener("pointercancel", stop);
                row.dragCleanup = null;
            };
            doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", stop); doc.addEventListener("pointercancel", stop);
        });
        if (initial.slider) {
            const slider = row.$slider = doc.createElement("input");
            slider.type = "range";
            row.$widget.prepend(slider);
            slider.addEventListener("input", () => { if (!row.dragCleanup) changed(adapter.setNumber(slider.valueAsNumber, false)); });
            slider.addEventListener("change", finish);
            slider.addEventListener("blur", finish);
            bindNumberKeys(slider, adapter, changed, finish);
            slider.addEventListener("pointerdown", event => {
                if (event.button > 0 || event.isPrimary === false || !adapter.canEdit()) return;
                if (!slider.getBoundingClientRect().width) return;
                event.preventDefault();
                slider.focus();
                row.dragCleanup?.();
                changed(adapter.beginDrag(event.clientX, slider));
                const move = e => { e.preventDefault(); changed(adapter.drag(e.clientX, slider)); };
                const stop = () => { row.dragCleanup?.(); finish(); };
                row.dragCleanup = () => {
                    doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", stop); doc.removeEventListener("pointercancel", stop);
                    row.dragCleanup = null;
                };
                doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", stop); doc.addEventListener("pointercancel", stop);
            });
        }
    } else {
        input.type = options.inputType ?? "text";
        input.addEventListener("input", () => changed(adapter.setValue(input.value)));
        input.addEventListener("blur", finish);
        input.addEventListener("keydown", event => { if (event.key === "Enter") input.blur(); });
    }
    row.updateDisplay();
    return row;
}

function bindNumberKeys(input, adapter, changed, finish) {
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); finish(); input.blur(); }
        const direction = ["ArrowUp", "ArrowRight"].includes(event.key) ? 1 : ["ArrowDown", "ArrowLeft"].includes(event.key) ? -1 : 0;
        if (!direction || input.type !== "range" && ["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        changed(adapter.increment(direction, event.shiftKey));
        if (input.type !== "range") input.value = adapter.read().value;
    });
    input.addEventListener("keyup", event => { if (event.key.startsWith("Arrow")) finish(); });
}

function pairRows(main, look, name) {
    const doc = main.domElement.ownerDocument;
    const pair = doc.createElement("div"), label = doc.createElement("span");
    pair.className = "native-control-pair";
    pair.setAttribute("role", "group"); pair.setAttribute("aria-label", name);
    label.className = "native-control-label"; label.textContent = name;
    main.domElement.before(pair); pair.append(label);
    for (const [row, letter] of [[main, "M"], [look, "L"]]) {
        row.pair = pair; pair.append(row.domElement);
        const marker = doc.createElement("span"); marker.className = "native-control-letter"; marker.textContent = letter;
        marker.setAttribute("aria-hidden", "true"); row.$widget.append(marker);
    }
}
