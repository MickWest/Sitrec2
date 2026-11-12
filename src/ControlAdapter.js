import {Units} from "./Globals";

// The compatibility boundary for the old controllers. Native presentations
// consume metadata and edit operations, never their elements or event handlers.
export class ControlAdapter {
    constructor(source, options = {}) {
        this.source = source;
        this.options = options;
        if (options.listen) source.listen?.();
    }

    read() {
        const c = this.source, opts = this.options;
        const kind = ["color", "option", "number", "boolean", "function", "string"].find(type => c.domElement?.classList.contains(type))
            ?? (c._values ? "option" : typeof c.getValue());
        const unit = Units?.[c._unitType ?? c.object?.unitType];
        let name = opts.name ?? c._name ?? c.property;
        if (opts.unitLabel && opts.name !== undefined && unit) name += ` (${unit.abbrev})`;
        const removed = Array.isArray(c.parent?.controllers) && !c.parent.controllers.includes(c);
        return {
            kind, value: c.getValue(), rawValue: c.object[c.property],
            displayValue: kind === "number" && opts.displayDecimals !== undefined
                ? Number(c.getValue()).toFixed(opts.displayDecimals)
                : c.displayText ? c.displayText() : String(c.getValue() ?? ""),
            name, tooltip: opts.tooltip ?? c._tooltip ?? "",
            disabled: removed || !!c._disabled || !!c.domElement?.inert || !!c.domElement?.closest("[inert]"),
            hidden: removed || !!c._hidden, labelColor: c._labelColor,
            min: c._min, max: c._max, step: c._step, decimals: c._decimals,
            slider: !!c.$slider, logarithmic: !!c._isLog,
            options: (c._names ?? []).map((label, index) => ({label, value: c._values[index]})),
        };
    }

    canEdit() { const state = this.read(); return !state.disabled && !state.hidden; }

    setValue(value) {
        if (!this.canEdit()) return false;
        this.source.setValue(value);
        return true;
    }

    // Typed values retain their precision; slider/arrow edits retain the
    // source's snapping and wrapping behavior. This matches the old input path.
    setNumber(value, typed = true) {
        if (!this.canEdit() || !Number.isFinite(value)) return false;
        const c = this.source;
        if (!typed) {
            if (c._snapWrapSetValue) c._snapWrapSetValue(value);
            else c.setValue(value);
            return true;
        }
        if (c._isLog) value = Math.log10(Math.max(value, 1e-10));
        if (c._elastic) {
            c._elasticMax = Math.max(c._elasticMax, value);
            let max = c._max;
            while (value > max && max < c._elasticMax) {
                const next = Math.min(max > 0 ? max * 2 : value, c._elasticMax);
                if (!(next > max)) break;
                max = next;
            }
            if (max !== c._max) { c.max(max); c.updateElasticStep(); }
            c.setValue(value);
        } else {
            if (c._allowInputExpandMax && c._max !== undefined && value > c._max) c.max(value);
            if (c._allowInputExpandMin && c._min !== undefined && value < c._min
                && value >= c._inputExpandMinLimit) c.min(value);
            c.setValue(c._clamp ? c._clamp(value) : value);
        }
        return true;
    }

    increment(direction, fine = false) {
        return this.setNumber(this.source.getValue() + direction * this.source._step * (fine ? 0.01 : 1), false);
    }

    wheel(event) {
        const amount = this.source._normalizeMouseWheel?.(event) ?? -Math.sign(event.deltaY);
        return this.increment(amount);
    }

    scrub(value) {
        if (!this.canEdit() || !Number.isFinite(value)) return false;
        if (this.source._snapClampSetValue) this.source._snapClampSetValue(value);
        else this.source.setValue(value);
        return true;
    }

    beginDrag(x, track) {
        if (!this.canEdit()) return false;
        if (this.source._dragStart) this.source._dragStart(x, track);
        return true;
    }

    drag(x, track) {
        if (!this.canEdit()) return false;
        if (this.source._dragMove) this.source._dragMove(x, track);
        return true;
    }

    finish() { this.source._callOnFinishChange?.(); }

    trigger() {
        if (!this.canEdit()) return false;
        // Match FunctionController: bound action, then source/folder change
        // callbacks. Function buttons do not dispatch a finish callback.
        this.source.getValue().call(this.source.object);
        this.source._callOnChange();
        return true;
    }
}
