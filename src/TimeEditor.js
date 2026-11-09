import {modernControlStyle} from "./ModernControlStyle";
import {timeEditorStyle} from "./TimeEditorStyle";
import {parseTimeEntry, replaceTimePart, shiftTimePart, wallTimeISO} from "./TimeEditing";

const digit = part => `<input class="te-digit" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-part="${part}" aria-label="${part[0].toUpperCase() + part.slice(1)}" title="${part[0].toUpperCase() + part.slice(1)}: click left/right to subtract/add; drag to scrub. Tab/Shift+Tab selects digits to type. ↑/↓ steps; Shift ×10. Enter applies; Escape cancels and leaves.">`;

// One editor for menus and panels. The adapter owns scene time, playback, undo
// and zones; this class only owns presentation, drafts and pointer gestures.
export class TimeEditor {
    constructor(container, adapter) {
        this.adapter = adapter;
        this.target = "now";
        const doc = container.ownerDocument;
        if (!doc.getElementById("sitrec-time-editor-style")) {
            const style = doc.createElement("style");
            style.id = "sitrec-time-editor-style";
            style.textContent = modernControlStyle + timeEditorStyle;
            doc.head.append(style);
        }
        this.root = doc.createElement("div");
        this.root.className = "sitrec-time-editor sitrec-modern";
        this.root.dataset.interactionNative = "true";
        this.root.setAttribute("role", "group");
        this.root.setAttribute("aria-label", "Date and time editor");
        this.root.innerHTML = `
            <div class="te-row te-target" aria-label="Time to edit">
                <button type="button" data-target="now">Current frame</button>
                <button type="button" data-target="start">Start · frame 0</button>
            </div>
            <div class="te-row">
                <select class="te-grow" data-id="zone" aria-label="Edit in time zone" title="Changes how time is displayed and entered. The instant stays the same."></select>
                <button type="button" data-action="cameraZone" title="Use the time zone at the camera location on the scene date">From camera</button>
            </div>
            <div class="te-date">
                ${digit("year")}<span aria-hidden="true">−</span>${digit("month")}<span aria-hidden="true">−</span>${digit("day")}
                <input class="te-calendar" type="date" data-id="calendar" aria-label="Choose date from calendar" title="Choose date from calendar" min="1700-01-01" max="9999-12-31">
            </div>
            <div class="te-clock">${["hour", "minute", "second"].map(digit).join('<span aria-hidden="true">:</span>')}</div>
            <div class="te-row">
                <label class="te-ms">ms ${digit("millisecond")}</label>
                <span class="te-context" data-id="frame"></span>
                <span class="te-status" data-id="status"></span>
            </div>
            <div class="te-error" role="status" data-id="error"></div>
            <div class="te-row">
                <button type="button" data-action="play" class="te-grow" title="Play or pause the timeline"></button>
                <button type="button" data-action="live" title="Follow the real clock continuously">● Live</button>
                <button type="button" data-action="undo" title="Undo the last time edit">↶ Undo</button>
                <select data-id="speed" aria-label="Simulation speed" title="Simulation speed; the current time stays fixed when this changes">
                    ${[1, 5, 10, 60, 300].map(speed => `<option value="${speed}">${speed}×</option>`).join("")}
                </select>
            </div>
            <details><summary title="Enter an ISO date and time. Include Z for UTC or an offset; otherwise use the selected zone.">Paste a date & time</summary>
                <input class="te-paste" data-id="paste" type="text" placeholder="2026-11-08 21:30:00.000Z" aria-label="Paste date and time" title="ISO date and time. Include Z for UTC or an offset; otherwise use the selected zone. Enter applies.">
                <div class="te-row"><button type="button" data-action="paste" class="te-grow">Set time</button><button type="button" data-action="now" title="Set the current frame to the real clock once, and stay paused">Now once</button></div>
            </details>`;
        container.append(this.root);
        this.inputs = [...this.root.querySelectorAll("input[data-part]")];
        // Tab stays on the date/time digits, in both editor locations. Other
        // controls remain clickable; Escape releases focus back to the scene.
        for (const control of this.root.querySelectorAll("button, select, summary, input:not([data-part])")) control.tabIndex = -1;
        for (const name of adapter.zones) this.el("zone").add(new Option(name, name));
        this.el("zone").prepend(new Option("UTC", "__utc__"));
        this.el("zone").onchange = () => { adapter.zone(this.el("zone").value); this.clearError(); this.refresh(true); };
        this.el("speed").onchange = () => { adapter.speed(Number(this.el("speed").value)); this.refresh(); };
        this.el("calendar").onchange = () => {
            const state = this.adapter.read();
            this.apply(replaceTimePart(this.date(state), "date", this.el("calendar").value, state.offset));
        };
        this.root.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key !== "Tab") return;
            event.preventDefault();
            const index = this.inputs.indexOf(doc.activeElement);
            const next = index < 0 ? (event.shiftKey ? this.inputs.length - 1 : 0)
                : (index + (event.shiftKey ? -1 : 1) + this.inputs.length) % this.inputs.length;
            this.inputs[next].focus();
        });
        this.root.addEventListener("keyup", event => event.stopPropagation());
        this.root.addEventListener("click", event => this.click(event));
        for (const input of this.inputs) {
            input.addEventListener("focus", () => { adapter.pause(); input.select(); });
            input.addEventListener("input", () => this.clearError());
            input.addEventListener("change", () => this.commit(input));
            input.addEventListener("keydown", event => this.key(event, input));
            this.bindScrub(input, input.dataset.part);
        }
        this.el("paste").addEventListener("focus", () => adapter.pause());
        this.el("paste").addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); this.paste(); }
            if (event.key === "Escape") { this.el("paste").value = ""; this.clearError(); this.el("paste").blur(); }
        });
        this.onBlur = () => this.stopGesture();
        window.addEventListener("blur", this.onBlur);
        this.refresh();
        // Paused scenes sleep the render loop. Never poll closed/hidden editors.
        this.timer = setInterval(() => { if (this.root.getClientRects().length) this.refresh(); }, 100);
    }

    el(id) { return this.root.querySelector(`[data-id="${id}"]`); }
    date(state = this.adapter.read()) { return this.target === "start" ? state.start : state.now; }
    clearError() {
        this.el("error").textContent = "";
        for (const input of this.inputs) input.removeAttribute("aria-invalid");
    }
    apply(date, begin = true) {
        if (!date || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1700 || date.getUTCFullYear() > 9999) {
            this.el("error").textContent = "Enter a valid date (year 1700–9999) and time.";
            return false;
        }
        this.clearError();
        this.adapter.edit(date, this.target, begin);
        this.refresh(true);
        return true;
    }
    commit(input) {
        const state = this.adapter.read();
        const date = replaceTimePart(this.date(state), input.dataset.part, input.value, state.offset);
        if (!this.apply(date)) input.setAttribute("aria-invalid", "true");
    }
    paste() {
        this.apply(parseTimeEntry(this.el("paste").value, this.adapter.read().offset));
    }
    step(part, amount, begin = true) {
        const state = this.adapter.read();
        this.apply(shiftTimePart(this.date(state), part, amount, state.offset), begin);
    }
    key(event, input) {
        if (event.key === "Escape") {
            event.preventDefault(); this.clearError(); this.refresh(true); input.blur();
        } else if (event.key === "Enter") {
            event.preventDefault(); this.commit(input); input.blur();
        } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
            event.preventDefault();
            const sign = event.key.endsWith("Up") ? 1 : -1;
            this.step(input.dataset.part, sign * (event.shiftKey || event.key.startsWith("Page") ? 10 : 1), !event.repeat);
        }
    }
    click(event) {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.target) {
            this.target = button.dataset.target;
            this.clearError(); this.refresh(true);
        }
        const action = button.dataset.action;
        if (action === "paste") this.paste();
        if (action === "now") { this.target = "now"; this.apply(new Date()); }
        if (action === "play") this.adapter.play();
        if (action === "live") { this.target = "now"; this.adapter.live(); }
        if (action === "undo") this.adapter.undo();
        if (action === "cameraZone") this.adapter.cameraZone();
        this.refresh();
    }
    bindScrub(element, part) {
        element.addEventListener("pointerdown", event => {
            if (event.button !== 0 || event.isPrimary === false) return;
            event.preventDefault();
            document.activeElement?.blur();
            this.stopGesture();
            this.adapter.pause();
            const state = this.adapter.read();
            const base = this.date(state).getTime();
            const x = event.clientX;
            const bounds = element.getBoundingClientRect();
            const direction = x < bounds.left + bounds.width / 2 ? -1 : 1;
            let previous = 0, changed = false, scrubbed = false, pending;
            element.setPointerCapture?.(event.pointerId);
            const flush = () => {
                if (this.raf != null) cancelAnimationFrame(this.raf);
                this.raf = null;
                if (pending === undefined || pending === previous) return;
                changed = this.apply(shiftTimePart(new Date(base), part, pending, state.offset), !changed) || changed;
                previous = pending;
            };
            const move = e => {
                if (e.pointerId !== event.pointerId) return;
                // Six pixels per unit: relative, unbounded scrubbing with natural carry.
                pending = Math.trunc((e.clientX - x) / 6) * (event.shiftKey ? 10 : 1);
                if (pending !== 0) scrubbed = true;
                if (pending === previous) return;
                element.classList.add("te-scrubbing");
                this.raf ??= requestAnimationFrame(flush);
            };
            const end = e => {
                if (e.pointerId !== event.pointerId) return;
                if (e.type === "pointerup") { move(e); flush(); }
                this.stopGesture();
                if (e.type === "pointerup") {
                    if (!scrubbed) this.step(part, direction * (event.shiftKey ? 10 : 1));
                    element.focus(); element.select();
                }
            };
            element.addEventListener("pointermove", move);
            element.addEventListener("pointerup", end);
            element.addEventListener("pointercancel", end);
            element.addEventListener("lostpointercapture", end);
            this.cleanupGesture = () => {
                element.removeEventListener("pointermove", move);
                element.removeEventListener("pointerup", end);
                element.removeEventListener("pointercancel", end);
                element.removeEventListener("lostpointercapture", end);
                element.classList.remove("te-scrubbing");
                if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
            };
        });
    }
    stopGesture() {
        this.cleanupGesture?.(); this.cleanupGesture = null;
        if (this.raf != null) cancelAnimationFrame(this.raf);
        this.raf = null;
    }
    refresh(force = false) {
        const state = this.adapter.read();
        const wall = wallTimeISO(this.date(state), state.offset);
        const values = {year: wall.slice(0, 4), month: wall.slice(5, 7), day: wall.slice(8, 10), hour: wall.slice(11, 13), minute: wall.slice(14, 16), second: wall.slice(17, 19), millisecond: wall.slice(20, 23)};
        for (const input of this.inputs) {
            if ((force || document.activeElement !== input) && !input.hasAttribute("aria-invalid") && input.value !== values[input.dataset.part]) input.value = values[input.dataset.part];
        }
        this.el("calendar").value = wall.slice(0, 10);
        for (const button of this.root.querySelectorAll("[data-target]")) {
            const start = button.dataset.target === "start";
            button.setAttribute("aria-pressed", String(button.dataset.target === this.target));
            button.title = `${start ? "Start" : "Current"}: ${wallTimeISO(start ? state.start : state.now, state.offset).replace("T", " ")} ${state.useZone ? state.zone : "UTC"}. Editing pauses playback and keeps the current frame fixed; start and current times shift together.`;
        }
        const zone = state.useZone ? state.zone : "__utc__";
        if (![...this.el("zone").options].some(o => o.value === zone)) this.el("zone").add(new Option(zone, zone));
        this.el("zone").value = zone;
        const elapsed = (state.now - state.start) / 1000;
        this.el("frame").textContent = `Frame ${state.frame}`;
        this.el("frame").title = `${elapsed >= 0 ? "+" : ""}${elapsed.toFixed(3)} s from start. Time edits keep this frame fixed; use the playback bar to move between frames.`;
        this.root.querySelector('[data-action="play"]').textContent = state.live || !state.paused ? "Ⅱ Pause" : "▶ Play";
        this.root.querySelector('[data-action="live"]').setAttribute("aria-pressed", String(state.live));
        this.root.querySelector('[data-action="undo"]').disabled = !state.canUndo;
        this.el("status").textContent = state.live ? "LIVE" : state.paused ? "PAUSED" : "PLAYING";
        this.el("status").title = state.live ? "Following the real clock" : state.paused ? "Playback paused; current frame held" : `Effective playback speed: ${state.speed * state.playbackSpeed}×`;
        const speed = this.el("speed");
        speed.querySelector('[data-custom]')?.remove();
        if (![...speed.options].some(o => Number(o.value) === state.speed)) {
            const option = new Option(`${state.speed}×`, String(state.speed));
            option.dataset.custom = "true"; speed.add(option);
        }
        speed.value = String(state.speed);
        speed.disabled = state.live;
    }
    dispose() {
        this.stopGesture(); clearInterval(this.timer);
        window.removeEventListener("blur", this.onBlur);
        this.root.remove();
    }
}
