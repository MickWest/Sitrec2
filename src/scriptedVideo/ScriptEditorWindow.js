// ScriptEditorWindow.js — the Scripted Video script editor UI.
//
// A floating draggable/resizable in-page panel (toolbar + textarea + status +
// timeline canvas) that can also be popped out into a real separate browser
// window (drag it to another monitor) and docked back.
//
// The editor is a transparent textarea over a styled backdrop: the textarea keeps
// native caret/typing/selection but renders its text transparent; the backdrop
// underneath renders the same text and adds the styling a textarea can't — bold
// the current line, and box a hovered control number. Hovered numbers (durations,
// distances, degrees, fov, &offsets) are scroll-wheel editable.
//
// Holds a back-reference `sv` to the CScriptedVideoManager (model + modes); the
// shared hover state (_hoverSeg/_hoverNum) lives on the manager because the
// timeline widget reads/writes it too.

import {blockViewEvents, clampBelowMenuBar} from "../DragResizeUtils";
import {CNodeView} from "../nodes/CNodeView";
import {CustomManager, guiMenus, markSitchDirty, NodeMan, TrackManager} from "../Globals";
import {VIEW_MAP} from "./ScriptCommands";
import {
    buildScriptSnippet,
    deleteLine,
    duplicateLine,
    ensureAmpOffsetSpan,
    insertLineAfter,
    replaceNumberSpan,
} from "./ScriptAuthoring";

export const STORAGE_KEY = "sitrec_scripted_video_script";   // legacy single-script key (migrated to tabs)
export const TABS_KEY = "sitrec_scripting_tabs";             // {tabs:[{name,text}], activeTab}

export const DEFAULT_SCRIPT =
`// Scripted Video demo  (Parse, then Preview or Render)
// The script is JS: await a command to wait for it to finish; un-awaited
// commands run concurrently. Flat lines work too:  zoom OE-LNC 6
view("main");
const z = zoom("OE-LNC", 6);
text("OE-LNC", 4);              // caption starts with the zoom
await z;
const o = orbit("OE-LNC", 9, 110);
await sleep(1);
text("tracking inbound", 4);    // 1 s after the orbit starts
await o;
await track("OE-LNC", 4);
view("look");
await wait(2);`;

// keys that move the text cursor (used to sync the timeline to the cursor's line)
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export class CScriptEditorWindow extends CNodeView {
    constructor(sv) {
        // A tileable view: it registers in ViewMan and joins the seam/layout system, hosting the
        // editor content below the standard CUIBar header. Hidden until opened from the Video menu.
        super({
            id: "scriptEditor",
            menuName: "Scripting",           // CUIBar title
            draggable: true, resizable: true, freeAspect: true,
            visible: false,
            alwaysOnTop: true,               // a tool window — keep it above the other views
            poppable: true,                  // ⧉ pop out into a window (same path as the other views)
            left: 0.04, top: 0.10, width: 0.32, height: 0.62,
            excludeFromViewsMenu: true,
        });
        this.panel = this.div;       // alias — the view div IS the editor panel
        this.sv = sv;                // the CScriptedVideoManager
        this.textarea = null;
        this.backdrop = null;
        this.statusEl = null;
        this.detailEl = null;
        this._content = null;        // movable editor content (view div <-> popup)
        this._palette = null;
        this._charW = null;          // cached character width for hover hit-testing
        // A runtime tool window, NOT sitch content — never serialize it. (If it were saved, the
        // node-graph factory would recreate it via new CScriptEditorWindow(nodeDef), with no
        // manager reference.) The manager wires + builds it via ensureEditor() on first use.
        this.modSerialize = undefined;
    }

    // current script text (used by the parser; falls back to the demo script)
    getText() {
        return (this.textarea && this.textarea.value !== undefined)
            ? this.textarea.value : DEFAULT_SCRIPT;
    }

    // is the editor visible anywhere (in-page panel shown, or popped out)?
    isOpen() {
        return !!this.visible || !!this.windowed;   // visible in-page, or popped out into a window
    }

    setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // the 1-based script line the text cursor is on (-1 if no editor yet)
    cursorLine1() {
        const ta = this.textarea;
        if (!ta) return -1;
        return ta.value.slice(0, ta.selectionStart).split("\n").length;
    }

    // -----------------------------------------------------------------------
    // WINDOW CONSTRUCTION
    // -----------------------------------------------------------------------

    build() {
        // The view div + CUIBar header (title "Scripted Video", ⛶/pin/✕) were created by the
        // CNodeView base constructor — and the base also wires the header drag-handle, Q-body-
        // drag and edge-resize. Here we just fill the editor content in below the header strip.
        this.div.style.background = 'rgba(20,24,29,0.96)';
        this.div.style.color = '#eef2f6';
        blockViewEvents(this.div);               // don't let editor clicks leak to the 3D view

        const content = this._buildEditorContent();
        this._content = content;
        content.style.position = 'absolute';
        content.style.inset = 'var(--sitrec-header-h, 26px) 0 0 0';   // fill below the header
        this.div.appendChild(content);
    }

    // Re-fit the timeline canvas whenever the view resizes (base fires changedSize on any resize).
    changedSize() {
        super.changedSize();
        this.sv?.timeline?.draw();
    }

    // The editor content (toolbar + textarea + status + timeline) as a single div so it
    // can be moved between the in-page panel and a popped-out browser window.
    _buildEditorContent() {
        const sv = this.sv;
        const content = document.createElement("div");
        content.style.cssText = "display:flex; flex-direction:column; flex:1 1 auto; min-height:0;";

        // --- tab bar: one tab per script, "+" to add a new one ---
        const tabBar = document.createElement("div");
        tabBar.style.cssText = "display:flex; gap:3px; padding:4px 6px 0; flex-wrap:wrap; flex:0 0 auto;";
        this.tabBar = tabBar;
        content.appendChild(tabBar);

        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display:flex; gap:6px; padding:6px 8px; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.06); flex:0 0 auto;";
        toolbar.appendChild(this._winButton("Parse", () => sv.doParse()));
        toolbar.appendChild(this._winButton("Preview", () => sv.startPreview()));
        toolbar.appendChild(this._winButton("Stop", () => sv.stopAll()));
        toolbar.appendChild(this._winButton("Render", () => sv.renderVideo()));
        toolbar.appendChild(this._winButton("Insert", () => this.openInsertPalette()));
        // (Pop-out is the ⧉ icon in the CUIBar header — same as the other poppable views.)

        // --- editor: a transparent textarea over a styled backdrop ---
        const editWrap = document.createElement("div");
        editWrap.style.cssText = "position:relative; flex:1 1 auto; min-height:80px; margin:8px;";
        // identical text-layout box for both layers so they line up exactly
        const EDIT_CSS = "position:absolute; inset:0; box-sizing:border-box; margin:0;" +
            " font:12px/1.4 monospace; padding:6px; border:1px solid; border-radius:4px;" +
            " white-space:pre; overflow:auto; letter-spacing:0; tab-size:4;";
        const backdrop = document.createElement("div");
        backdrop.style.cssText = EDIT_CSS + " color:#ddd; background:#111; border-color:#333; pointer-events:none; z-index:0;";
        this.backdrop = backdrop;

        const ta = document.createElement("textarea");
        ta.spellcheck = false;
        ta.wrap = "off";   // match the backdrop's white-space:pre so rows line up
        ta.style.cssText = EDIT_CSS + " color:transparent; background:transparent; caret-color:#fff;" +
            " border-color:transparent; resize:none; z-index:1;";
        sv._loadTabs();                         // ensure the tabs model exists (migrates legacy key)
        ta.value = sv.activeTabText();
        for (const ev of ["keydown", "keyup", "keypress"]) ta.addEventListener(ev, (e) => e.stopPropagation());
        // script edits count as unsaved work (arms the leave-page warning)
        ta.addEventListener("input", () => { markSitchDirty(); sv.doParse(); this._renderBackdrop(); });
        ta.addEventListener("click", () => {
            // a completed number-drag must not re-scrub to the (unmoved) caret
            if (this._suppressClick) { this._suppressClick = false; return; }
            sv._scrubToCursorLine(); this._renderBackdrop();
        });
        ta.addEventListener("keyup", (e) => { if (NAV_KEYS.has(e.key)) sv._scrubToCursorLine(); this._renderBackdrop(); });
        ta.addEventListener("scroll", () => { backdrop.scrollTop = ta.scrollTop; backdrop.scrollLeft = ta.scrollLeft; });
        ta.addEventListener("mousemove", (e) => this._onEditorHover(e));
        ta.addEventListener("mousedown", (e) => this._onEditorMouseDown(e));
        ta.addEventListener("mouseleave", () => { if (sv._hoverNum || sv._hoverSeg) { sv._hoverNum = null; sv._hoverSeg = null; ta.style.cursor = ""; this._renderBackdrop(); sv.timeline.draw(); } });
        ta.addEventListener("wheel", (e) => this._onEditorWheel(e), { passive: false });
        this.textarea = ta;

        editWrap.appendChild(backdrop);
        editWrap.appendChild(ta);

        const st = document.createElement("div");
        st.style.cssText = "font:11px sans-serif; color:#9aa; padding:0 10px 4px; flex:0 0 auto;";
        st.textContent = "Press Parse";
        this.statusEl = st;

        const detail = document.createElement("div");
        detail.style.cssText = "display:none; align-items:center; gap:6px; padding:3px 8px 5px; flex:0 0 auto; border-top:1px solid rgba(255,255,255,0.04); font:11px sans-serif; color:#cbd3df;";
        this.detailEl = detail;

        const tl = document.createElement("canvas");
        tl.style.cssText = "display:block; width:calc(100% - 16px); height:60px; margin:0 8px 10px; border:1px solid #333; border-radius:4px; flex:0 0 auto;";
        sv.timeline.attach(tl);
        sv.timeline.editorCanvas = tl;

        content.appendChild(toolbar);
        content.appendChild(editWrap);
        content.appendChild(st);
        content.appendChild(detail);
        content.appendChild(tl);
        this._refreshTabs();
        setTimeout(() => this._renderBackdrop(), 0);
        return content;
    }

    // (Re)build the tab bar from the manager's tabs model. Click selects, the ×
    // closes (kept when only one remains), double-click renames, "+" adds.
    _refreshTabs() {
        const bar = this.tabBar, sv = this.sv;
        if (!bar) return;
        bar.replaceChildren();
        sv._loadTabs();
        sv.tabs.forEach((t, i) => {
            const active = i === sv.activeTab;
            const tab = document.createElement("div");
            tab.style.cssText = `display:flex; align-items:center; gap:4px; padding:2px 6px; border-radius:6px 6px 0 0;
                cursor:pointer; font:11px sans-serif; user-select:none;
                background:${active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)"};
                color:${active ? "#fff" : "#aeb6c2"};`;
            const label = document.createElement("span");
            label.textContent = t.name;
            label.addEventListener("click", () => sv.selectTab(i));
            label.addEventListener("dblclick", () => {
                const n = prompt("Rename script:", t.name);
                if (n && n.trim()) sv.renameTab(i, n.trim());
            });
            tab.appendChild(label);
            if (sv.tabs.length > 1) {
                const close = document.createElement("span");
                close.textContent = "×";
                close.title = "Close this script";
                close.style.cssText = "opacity:0.6; padding:0 1px;";
                close.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (confirm(`Close script "${t.name}"?`)) sv.removeTab(i);
                });
                tab.appendChild(close);
            }
            bar.appendChild(tab);
        });
        const add = document.createElement("div");
        add.textContent = "+";
        add.title = "New script";
        add.style.cssText = `padding:2px 8px; border-radius:6px 6px 0 0; cursor:pointer; font:12px sans-serif;
            background:rgba(255,255,255,0.06); color:#9aa;`;
        add.addEventListener("click", () => sv.addTab());
        bar.appendChild(add);
    }

    _winButton(label, onClick) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label;
        b.style.cssText = `border:0; border-radius:6px; padding:4px 10px; background:rgba(255,255,255,0.10);
            color:#eef2f6; cursor:pointer; font:12px sans-serif;`;
        b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,0.18)");
        b.addEventListener("mouseleave", () => b.style.background = "rgba(255,255,255,0.10)");
        b.addEventListener("click", onClick);
        return b;
    }

    _miniButton(label, onClick, title = "") {
        const b = this._winButton(label, onClick);
        b.style.padding = "2px 7px";
        b.style.font = "11px sans-serif";
        if (title) b.title = title;
        return b;
    }

    _setText(nextText, caretRow = null, caretCol = null) {
        const ta = this.textarea;
        if (!ta) return Promise.resolve();
        ta.value = nextText;
        if (caretRow != null) {
            const lines = ta.value.split("\n");
            const row = Math.max(0, Math.min(lines.length - 1, caretRow));
            const col = Math.max(0, Math.min(lines[row].length, caretCol == null ? lines[row].length : caretCol));
            let idx = 0;
            for (let r = 0; r < row; r++) idx += lines[r].length + 1;
            try { ta.setSelectionRange(idx + col, idx + col); } catch (e) {}
        }
        markSitchDirty();
        this._parsePromise = this.sv.doParse();
        this._renderBackdrop();
        return this._parsePromise;
    }

    _insertSnippet(snippet) {
        const ta = this.textarea;
        if (!ta || !snippet) return;
        const sel = this.sv.selectedEvent();
        const row = sel && sel.line ? sel.line - 1 : Math.max(0, this._cursorLine());
        const next = insertLineAfter(ta.value, row, snippet);
        this.sv.selectEvent(null);
        this._setText(next, row + 1, snippet.length).then(() => {
            const inserted = this.sv._anyEventOnLine(row + 2);
            if (inserted) this.sv.selectEvent(inserted);
            if (this.sv._previewing) this.sv._scrubTo(inserted ? inserted.start : this.sv._currentT);
        });
    }

    selectLine(line1) {
        const ta = this.textarea;
        if (!ta || line1 < 1) return;
        const lines = ta.value.split("\n");
        const row = Math.max(0, Math.min(lines.length - 1, line1 - 1));
        let idx = 0;
        for (let r = 0; r < row; r++) idx += lines[r].length + 1;
        ta.focus();
        try { ta.setSelectionRange(idx, idx + lines[row].length); } catch (e) {}
        this._renderBackdrop();
    }

    deleteLine(row) {
        const ta = this.textarea;
        if (!ta) return;
        const next = deleteLine(ta.value, row);
        this.sv.selectEvent(null);
        this._setText(next, Math.max(0, Math.min(row, next.split("\n").length - 1)));
    }

    duplicateLine(row) {
        const ta = this.textarea;
        if (!ta) return;
        const next = duplicateLine(ta.value, row);
        this._setText(next, row + 1).then(() => {
            const dupe = this.sv._anyEventOnLine(row + 2);
            if (dupe) this.sv.selectEvent(dupe);
        });
    }

    setNumberToken(row, span, value, minVal = 0) {
        const ta = this.textarea;
        if (!ta || !span) return null;
        const res = replaceNumberSpan(ta.value, row, span, value, {min: minVal});
        if (!res) return null;
        this._setText(res.text);
        return res.span;
    }

    ensureOffsetToken(row) {
        const ta = this.textarea;
        if (!ta) return null;
        const res = ensureAmpOffsetSpan(ta.value, row);
        if (!res) return null;
        if (res.text !== ta.value) {
            ta.value = res.text;
            markSitchDirty();
        }
        return res.span;
    }

    updateSelectionDetails() {
        const detail = this.detailEl;
        if (!detail) return;
        const e = this.sv.selectedEvent();
        detail.replaceChildren();
        if (!e) {
            detail.style.display = "none";
            return;
        }
        detail.style.display = "flex";
        const label = document.createElement("span");
        label.style.cssText = "flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        const bits = [`line ${e.line}`, e.type, `${(e.start || 0).toFixed(1)}s`];
        if (e.dur > 0) bits.push(`${e.dur.toFixed(1)}s`);
        if (e.target) bits.push(String(e.target));
        if (e.view || e.preset) bits.push(String(e.view || e.preset));
        if (e.text) bits.push(`"${e.text}"`);
        label.textContent = bits.join("  ");
        detail.appendChild(label);
        detail.appendChild(this._miniButton("Line", () => this.selectLine(e.line), "Select the script line"));
        detail.appendChild(this._miniButton("Copy", () => this.duplicateLine(e.line - 1), "Duplicate this script line"));
        detail.appendChild(this._miniButton("Delete", () => this.deleteLine(e.line - 1), "Delete this script line"));
    }

    _targetOptions() {
        const seen = new Set();
        const out = [];
        const add = (label, value = label) => {
            if (!value || seen.has(value)) return;
            seen.add(value);
            out.push({label: String(label || value), value: String(value)});
        };
        try {
            TrackManager?.iterate?.((id, trackOb) => {
                const shortName = trackOb?.shortName || trackOb?.menuText || trackOb?.trackNode?.shortName;
                add(shortName || id, shortName || id);
                if (id !== shortName) add(id, id);
                if (trackOb?.trackDataNode?.id) add(trackOb.trackDataNode.id, trackOb.trackDataNode.id);
            });
        } catch (e) {}
        try {
            NodeMan?.iterate?.((id, node) => {
                if (id.startsWith("Track_")) add(id.slice(6), id.slice(6));
                if (id.endsWith("_ob")) add(id.slice(0, -3), id.slice(0, -3));
                if (typeof node?.p === "function" || typeof node?.getValueFrame === "function") add(id, id);
            });
        } catch (e) {}
        return out.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 200);
    }

    _viewOptions() {
        const out = [];
        const seen = new Set();
        const add = (label, value = label) => {
            if (!value || seen.has(value)) return;
            seen.add(value);
            out.push({label: String(label), value: String(value)});
        };
        for (const k of Object.keys(VIEW_MAP)) add(k, k);
        add("VideoOverlay", "VideoOverlay");
        add("photo", "photo");          // witness photo letterboxed over the 3D main view
        try {
            for (const k of Object.keys(CustomManager?.viewPresets || {})) add(k, k);
        } catch (e) {}
        return out;
    }

    _settingOptions() {
        const out = [];
        const seen = new Set();
        const walk = (menuId, gui, prefix = []) => {
            if (!gui) return;
            for (const c of gui.controllers || []) {
                const name = c._name || c.property;
                if (!name) continue;
                const path = [...prefix, name].join("/");
                const key = `${menuId}:${path}`;
                if (seen.has(key)) continue;
                seen.add(key);
                let value = null;
                try { value = c.getValue?.(); } catch (e) {}
                out.push({label: `${path}`, value: path, menuId, currentValue: value, values: c._values || null});
            }
            for (const child of gui.children || []) {
                if (child && child.controllers) walk(menuId, child, [...prefix, child._title || child._name || "Folder"]);
            }
        };
        try {
            for (const [menuId, gui] of Object.entries(guiMenus || {})) walk(menuId, gui);
        } catch (e) {}
        return out.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 500);
    }

    _parsePaletteValue(raw) {
        const s = String(raw ?? "").trim();
        if (s === "true") return true;
        if (s === "false") return false;
        if (s !== "" && isFinite(+s)) return +s;
        return s;
    }

    openInsertPalette() {
        this.closeInsertPalette();
        const doc = this._content?.ownerDocument || document;
        const overlay = doc.createElement("div");
        overlay.style.cssText = "position:fixed; inset:0; z-index:2147483600; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.45);";
        const box = doc.createElement("div");
        box.style.cssText = "width:min(520px, calc(100vw - 30px)); max-height:calc(100vh - 40px); overflow:auto; background:#181d24; color:#edf2f7; border:1px solid rgba(255,255,255,0.18); border-radius:8px; box-shadow:0 18px 50px rgba(0,0,0,0.55); font:12px sans-serif;";
        overlay.appendChild(box);
        this._palette = overlay;

        const header = doc.createElement("div");
        header.style.cssText = "display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.08); font-weight:600;";
        const title = doc.createElement("div");
        title.textContent = "Insert Script Step";
        title.style.flex = "1 1 auto";
        header.appendChild(title);
        header.appendChild(this._miniButton("Close", () => this.closeInsertPalette()));
        box.appendChild(header);

        const form = doc.createElement("div");
        form.style.cssText = "display:grid; grid-template-columns:110px 1fr; gap:8px 10px; padding:10px;";
        box.appendChild(form);

        const addLabel = (text) => {
            const l = doc.createElement("label");
            l.textContent = text;
            l.style.cssText = "align-self:center; color:#b8c0cc;";
            form.appendChild(l);
            return l;
        };
        const addInput = (el) => {
            el.style.cssText = "box-sizing:border-box; width:100%; padding:5px 7px; border:1px solid #3a414d; border-radius:5px; background:#0f1217; color:#edf2f7; font:12px sans-serif;";
            form.appendChild(el);
            return el;
        };
        const makeRow = (label, el) => ({label: addLabel(label), input: addInput(el)});

        const command = doc.createElement("select");
        [
            ["text", "Caption"],
            ["wait", "Wait"],
            ["view", "View Cut"],
            ["zoom", "Zoom To Target"],
            ["orbit", "Orbit Target"],
            ["track", "Track Target"],
            ["rise", "Rise From Target"],
            ["flyto", "Fly To Look Camera"],
            ["fade", "Fade View"],
            ["show", "Show Setting"],
            ["hide", "Hide Setting"],
            ["set", "Set Setting"],
        ].forEach(([value, label]) => {
            const o = doc.createElement("option");
            o.value = value; o.textContent = label;
            command.appendChild(o);
        });
        const commandRow = makeRow("Command", command);

        const caption = makeRow("Caption", doc.createElement("input"));
        caption.input.value = "Caption";

        const targets = this._targetOptions();
        const targetListId = "script-targets-" + Math.random().toString(36).slice(2);
        const targetList = doc.createElement("datalist");
        targetList.id = targetListId;
        targets.forEach((t) => {
            const o = doc.createElement("option");
            o.value = t.value; o.label = t.label;
            targetList.appendChild(o);
        });
        box.appendChild(targetList);
        const target = makeRow("Target", doc.createElement("input"));
        target.input.setAttribute("list", targetListId);
        target.input.value = targets[0]?.value || "target";

        const view = makeRow("View", doc.createElement("select"));
        this._viewOptions().forEach((v) => {
            const o = doc.createElement("option");
            o.value = v.value; o.textContent = v.label;
            view.input.appendChild(o);
        });

        const duration = makeRow("Seconds", doc.createElement("input"));
        duration.input.type = "number"; duration.input.min = "0"; duration.input.step = "0.1"; duration.input.value = "3";

        const extra = makeRow("Extra", doc.createElement("input"));
        extra.input.type = "number"; extra.input.step = "1"; extra.input.value = "90";

        const settings = this._settingOptions();
        const setting = makeRow("Setting", doc.createElement("select"));
        settings.forEach((s) => {
            const o = doc.createElement("option");
            o.value = s.value; o.textContent = s.label;
            setting.input.appendChild(o);
        });

        const value = makeRow("Value", doc.createElement("input"));
        value.input.value = "true";

        const concurrent = doc.createElement("input");
        concurrent.type = "checkbox";
        const concurrentWrap = doc.createElement("label");
        concurrentWrap.style.cssText = "display:flex; align-items:center; gap:6px; color:#cbd3df;";
        concurrentWrap.appendChild(concurrent);
        concurrentWrap.appendChild(doc.createTextNode("start with previous line"));
        addLabel("");
        form.appendChild(concurrentWrap);

        const footer = doc.createElement("div");
        footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; padding:0 10px 10px;";
        const insert = this._winButton("Insert", () => {
            const kind = command.value;
            const opt = {
                caption: caption.input.value,
                target: target.input.value,
                view: view.input.value,
                duration: Number(duration.input.value),
                control: setting.input.value,
                value: this._parsePaletteValue(value.input.value),
            };
            if (kind === "orbit") opt.degrees = Number(extra.input.value);
            if (kind === "rise") opt.meters = Number(extra.input.value);
            if (kind === "zoom" && extra.input.value !== "") opt.distance = Number(extra.input.value);
            if (kind === "fade") opt.to = this._parsePaletteValue(extra.input.value);
            let line = buildScriptSnippet(kind, opt);
            if (concurrent.checked) line = "& " + line;
            this._insertSnippet(line);
            this.closeInsertPalette();
        });
        footer.appendChild(insert);
        box.appendChild(footer);

        const setRow = (row, show) => {
            row.label.style.display = show ? "" : "none";
            row.input.style.display = show ? "" : "none";
        };
        const refresh = () => {
            const k = command.value;
            const needsTarget = ["zoom", "orbit", "track", "rise"].includes(k);
            const needsView = ["view", "fade"].includes(k);
            const needsCaption = k === "text";
            const needsSetting = ["show", "hide", "set"].includes(k);
            const needsValue = k === "set";
            setRow(caption, needsCaption);
            setRow(target, needsTarget);
            setRow(view, needsView);
            setRow(duration, !["show", "hide", "set"].includes(k));
            setRow(setting, needsSetting);
            setRow(value, needsValue);
            setRow(extra, ["zoom", "orbit", "rise", "fade"].includes(k));
            extra.label.textContent = k === "orbit" ? "Degrees" : k === "rise" ? "Meters" : k === "fade" ? "Opacity" : "Distance";
            extra.input.value = k === "orbit" ? "90" : k === "rise" ? "800" : k === "fade" ? "0" : "";
            duration.input.value = k === "view" ? "0" : k === "wait" ? "1" : k === "flyto" ? "0" : "3";
            const current = settings.find((s) => s.value === setting.input.value)?.currentValue;
            if (k === "set" && current !== null && current !== undefined) value.input.value = typeof current === "boolean" ? String(!current) : String(current);
            commandRow.input.focus();
        };
        command.addEventListener("change", refresh);
        setting.input.addEventListener("change", refresh);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.closeInsertPalette(); });
        overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") this.closeInsertPalette(); }, true);
        doc.body.appendChild(overlay);
        refresh();
    }

    closeInsertPalette() {
        if (this._palette && this._palette.parentNode) this._palette.parentNode.removeChild(this._palette);
        this._palette = null;
    }

    // -----------------------------------------------------------------------
    // SHOW / HIDE / POPOUT
    // -----------------------------------------------------------------------

    // Single visibility hook — the base show()/hide() both route through setVisible(). Opening
    // parses + draws the timeline; closing leaves preview mode.
    setVisible(visible) {
        if (!visible && this.visible) {
            this.sv?._exitAllModes?.();      // closing the editor leaves preview mode
        }
        super.setVisible(visible);
        if (visible) {
            clampBelowMenuBar(this.div);     // never open off the top of the screen
            this.sv?.parse?.();
            setTimeout(() => { this.sv?.timeline?.draw?.(); this._renderBackdrop(); }, 0);
        }
    }

    hide() {
        if (this.windowed) this.dockWindow();   // pull the content back from the popup first
        super.hide();                           // → setVisible(false)
    }

    toggle() { this.setVisible(!this.visible); }

    // Pop-out / dock reuse the generic CNodeView path (the ⧉ header icon — same as the other
    // poppable views, e.g. Notes / the AI chat). We only add the editor-specific extras: the
    // timeline canvas needs its key-zoom + resize re-wired to the popup window, and the hover
    // hit-testing's cached character width must be re-measured (popup DPI/zoom may differ).
    popOut() {
        super.popOut();
        const win = this._poppedWindow;
        if (win && !win.closed) {
            this._charW = null;
            this.sv.timeline.attachKeyZoom(win);
            win.addEventListener("resize", () => this.sv.timeline.draw());
            setTimeout(() => this.sv.timeline.draw(), 60);
        }
    }

    dockWindow() {
        super.dockWindow();
        this._charW = null;                      // remeasure back in the main document
        setTimeout(() => this.sv?.timeline?.draw?.(), 60);
    }

    // -----------------------------------------------------------------------
    // BACKDROP  (bold current line + box the hovered number)
    // -----------------------------------------------------------------------

    _cursorLine() {
        const ta = this.textarea;
        if (!ta) return -1;
        return ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    }

    _escHtml(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    _renderBackdrop() {
        const ta = this.textarea, bd = this.backdrop;
        if (!ta || !bd) return;
        const lines = ta.value.split("\n");
        const cur = this._cursorLine();
        const hov = this.sv._hoverNum;
        const selectedLine = this.sv._selectedEventLine;
        // during preview, tint the lines active at the current time yellow
        const active = this.sv._previewing ? this.sv._activeLineSet(this.sv._currentT) : null;
        const box = '<span style="outline:1.5px solid #ffd24a;border-radius:2px;background:rgba(255,210,74,0.18)">';
        let html = "";
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let h;
            if (hov && hov.line === i) {
                h = this._escHtml(line.slice(0, hov.start)) + box + this._escHtml(line.slice(hov.start, hov.end))
                    + "</span>" + this._escHtml(line.slice(hov.end));
            } else {
                h = this._escHtml(line);
            }
            if (active && active.has(i + 1)) h = '<span style="color:#ffd24a">' + h + "</span>";
            if (selectedLine === i + 1) h = '<span style="background:rgba(120,170,255,0.18)">' + h + "</span>";
            if (i === cur) h = "<b>" + h + "</b>";
            html += h + (i < lines.length - 1 ? "\n" : "");
        }
        bd.innerHTML = html;
        bd.scrollTop = ta.scrollTop; bd.scrollLeft = ta.scrollLeft;
    }

    // -----------------------------------------------------------------------
    // NUMBER-TOKEN HOVER + WHEEL EDITING
    // -----------------------------------------------------------------------

    _charMetrics() {
        const ta = this.textarea;
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.4);
        if (!this._charW) {
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:" + cs.font;
            probe.textContent = "0000000000";
            (ta.ownerDocument.body || document.body).appendChild(probe);
            this._charW = probe.getBoundingClientRect().width / 10;
            probe.remove();
        }
        return {cw: this._charW || 7.2, lh, padL: parseFloat(cs.paddingLeft), padT: parseFloat(cs.paddingTop)};
    }

    // The editable control-number under (row,col): ONLY a parser-recognised number
    // (duration / distance / degrees / fov / &offset) — never a digit inside a quoted
    // caption or a lat,lon,alt coordinate, which control nothing on the timeline.
    // Accepts the mouse up to `pad` chars to either side; nearest wins. Returns
    // {line,start,end,text,field} or null.
    _editableNumberAt(row, col, pad = 0) {
        const ev = this.sv._anyEventOnLine(row + 1);
        if (!ev) return null;
        const lt = (this.textarea.value.split("\n")[row]) || "";
        const cands = [];
        if (ev.spans) for (const f of ["dur", "dist", "deg", "fov"]) if (ev.spans[f]) cands.push({s: ev.spans[f], field: f});
        if (ev.offSpan) cands.push({s: ev.offSpan, field: "off"});
        let best = null, bestDist = Infinity;
        for (const {s, field} of cands) {
            let dist = 0;
            if (col < s.start) dist = s.start - col;            // chars to the left
            else if (col >= s.end) dist = col - (s.end - 1);    // chars to the right
            if (dist <= pad && dist < bestDist) {
                best = {line: row, start: s.start, end: s.end, text: lt.slice(s.start, s.end), field};
                bestDist = dist;
            }
        }
        return best;
    }

    _onEditorHover(e) {
        if (this._numDragging) return;   // keep the dragged number hovered
        const sv = this.sv;
        const ta = this.textarea;
        const {cw, lh, padL, padT} = this._charMetrics();
        const rect = ta.getBoundingClientRect();
        const x = e.clientX - rect.left - padL + ta.scrollLeft;
        const y = e.clientY - rect.top - padT + ta.scrollTop;
        const row = Math.floor(y / lh);
        const col = Math.floor(x / cw);
        // accept the mouse up to 2 chars on either side of a control number
        const found = (y < 0) ? null : this._editableNumberAt(row, col, 2);
        const a = sv._hoverNum;
        const same = (!a && !found) || (a && found && a.line === found.line && a.start === found.start && a.end === found.end);
        ta.style.cursor = found ? "ns-resize" : "";
        if (!same) {
            sv._hoverNum = found;
            sv._hoverSeg = found ? sv._eventOnLine(found.line + 1) : null;
            this._renderBackdrop();
            sv.timeline.draw();   // highlight (or clear) the linked timeline segment
        }
    }

    // per-field floor: a duration must stay > 0 (else its bar vanishes); fov ≥ 1;
    // distance / degrees / offset may legitimately be 0
    _minValForField(field) {
        if (field === "dist" || field === "deg" || field === "off") return 0;
        if (field === "fov") return 1;
        return 0.1;   // dur (and anything unlabelled)
    }

    // Click-drag up/down on a control number adjusts it (the wheel still works).
    // mousedown over a number prevents the textarea's native text selection, so
    // a drag-less click places the caret manually — click-to-edit still works.
    _onEditorMouseDown(e) {
        const sv = this.sv;
        if (e.button !== 0 || !sv._hoverNum) return;
        e.preventDefault();
        const PX_PER_STEP = 7;            // vertical pixels per value step
        const startX = e.clientX, startY = e.clientY;
        let lastY = e.clientY, accum = 0, dragged = false;
        this._numDragging = true;
        const move = (ev) => {
            const dy = lastY - ev.clientY;
            lastY = ev.clientY;
            if (!dragged && Math.abs(ev.clientY - startY) < 3 && Math.abs(ev.clientX - startX) < 3) return;
            dragged = true;
            accum += dy;
            let changed = false;
            while (Math.abs(accum) >= PX_PER_STEP) {
                // dragging up (accum > 0) increments — synthesize the matching
                // deltaY for adjustNumberToken (positive deltaY = increment)
                const deltaY = accum > 0 ? 1 : -1;
                accum -= accum > 0 ? PX_PER_STEP : -PX_PER_STEP;
                const h = sv._hoverNum;
                if (!h) break;
                const res = this.adjustNumberToken(h.line, {start: h.start, end: h.end},
                    deltaY, ev.shiftKey, this._minValForField(h.field));
                if (!res) break;
                h.start = res.start; h.end = res.end; h.text = res.text;
                changed = true;
            }
            if (changed) {
                (this._parsePromise || Promise.resolve()).then(() => {
                    const h = sv._hoverNum;
                    sv._hoverSeg = h ? sv._eventOnLine(h.line + 1) : null;
                    this._renderBackdrop();
                    sv.timeline.draw();
                    if (sv._previewing) sv._scrubTo(sv._currentT);
                });
            }
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            this._numDragging = false;
            if (dragged) this._suppressClick = true;
            else this._placeCaretAt(e);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    }

    // place the caret at the character under a mouse event (used because the
    // number-drag mousedown suppressed the textarea's own caret placement)
    _placeCaretAt(e) {
        const ta = this.textarea;
        const {cw, lh, padL, padT} = this._charMetrics();
        const rect = ta.getBoundingClientRect();
        const x = e.clientX - rect.left - padL + ta.scrollLeft;
        const y = e.clientY - rect.top - padT + ta.scrollTop;
        const lines = ta.value.split("\n");
        const row = Math.max(0, Math.min(lines.length - 1, Math.floor(y / lh)));
        const col = Math.max(0, Math.min(lines[row].length, Math.round(x / cw)));
        let idx = 0;
        for (let r = 0; r < row; r++) idx += lines[r].length + 1;
        ta.focus();
        try { ta.setSelectionRange(idx + col, idx + col); } catch (e2) {}
    }

    _onEditorWheel(e) {
        const sv = this.sv;
        if (!sv._hoverNum) return;            // not over a control number → normal scroll
        e.preventDefault();
        const h = sv._hoverNum;
        const res = this.adjustNumberToken(h.line, {start: h.start, end: h.end}, e.deltaY, e.shiftKey, this._minValForField(h.field));
        if (!res) return;
        h.start = res.start; h.end = res.end; h.text = res.text;
        // the re-parse is async (JS scheduling run) — re-resolve against the new model
        (this._parsePromise || Promise.resolve()).then(() => {
            sv._hoverSeg = sv._eventOnLine(h.line + 1);
            if (!sv._hoverSeg) sv._hoverNum = null;   // keep both highlight surfaces consistent
            this._renderBackdrop();
            sv.timeline.draw();
            if (sv._previewing) sv._scrubTo(sv._currentT);
        });
    }

    // Increment/decrement the number token at lines[row][span.start..span.end] by a
    // mouse-wheel step (1 for ints, 0.1 for decimals, ×10 with Shift), never below
    // minVal. Rewrites the textarea, keeps the caret aligned across width changes,
    // re-parses, and returns the new {start,end,text} span (null if not a clean
    // number). Shared by the editor and the timeline-segment wheel.
    adjustNumberToken(row, span, deltaY, shiftKey, minVal = 0) {
        const ta = this.textarea;
        if (!ta || !span) return null;
        const lines = ta.value.split("\n");
        const line = lines[row];
        if (line === undefined) return null;
        const cur = line.slice(span.start, span.end);
        if (!/^\d*\.?\d+$/.test(cur)) return null;     // only adjust a clean numeric token
        const hasDot = cur.includes(".");
        let step = hasDot ? 0.1 : 1;
        if (shiftKey) step *= 10;
        // Scroll UP increases. macOS "natural scrolling" (the common case here)
        // reports an upward scroll/swipe as deltaY > 0, so positive = increment.
        const dir = deltaY > 0 ? 1 : -1;
        let val = parseFloat(cur) + dir * step;
        if (!isFinite(val)) return null;
        if (val < minVal) val = minVal;
        // Keep a decimal token decimal (so the 0.1 step survives the whole-number
        // boundary, e.g. 0.9→1.0→1.1) and floor AFTER rounding so an integer step
        // can't collapse the value back below minVal (Math.round(0.1)=0 would).
        let out;
        if (hasDot) {
            out = (Math.round(val * 10) / 10).toFixed(1);
            if (parseFloat(out) < minVal) out = minVal.toFixed(1);
        } else {
            out = String(Math.round(val));
            if (parseFloat(out) < minVal) out = String(Math.ceil(minVal));
        }
        // adjust the caret for any change in the token's character width
        const delta = out.length - (span.end - span.start);
        let lineStart = 0;
        for (let r = 0; r < row; r++) lineStart += lines[r].length + 1;
        const absStart = lineStart + span.start, absEnd = lineStart + span.end;
        let caret = ta.selectionStart;
        if (caret >= absEnd) caret += delta;
        else if (caret > absStart) caret = absStart + out.length;
        lines[row] = line.slice(0, span.start) + out + line.slice(span.end);
        ta.value = lines.join("\n");
        try { ta.selectionStart = ta.selectionEnd = caret; } catch (e2) {}
        markSitchDirty();   // wheel/drag number edits are unsaved work too
        this._parsePromise = this.sv.doParse();   // async; callers chain on it to see the new model
        return {start: span.start, end: span.start + out.length, text: out};
    }
}
