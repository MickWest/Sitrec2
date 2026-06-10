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

import {makeDraggable, blockViewEvents, clampBelowMenuBar} from "../DragResizeUtils";
import {markSitchDirty} from "../Globals";

export const STORAGE_KEY = "sitrec_scripted_video_script";

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

export class CScriptEditorWindow {
    constructor(sv) {
        this.sv = sv;                // the CScriptedVideoManager
        this.panel = null;           // the floating in-page window
        this.external = null;        // popped-out browser window (or null)
        this.textarea = null;
        this.backdrop = null;
        this.statusEl = null;
        this._content = null;        // movable editor content (panel <-> popup)
        this._charW = null;          // cached character width for hover hit-testing
    }

    // current script text (used by the parser; falls back to the demo script)
    getText() {
        return (this.textarea && this.textarea.value !== undefined)
            ? this.textarea.value : DEFAULT_SCRIPT;
    }

    // is the editor visible anywhere (in-page panel shown, or popped out)?
    isOpen() {
        return (this.panel && this.panel.style.display !== "none")
            || (this.external && !this.external.closed);
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
        const panel = document.createElement("div");
        panel.style.cssText = `position:fixed; top:70px; left:70px; width:400px; height:440px;
            min-width:280px; min-height:240px; display:none; flex-direction:column;
            background:rgba(20,24,29,0.96); color:#eef2f6; border:1px solid rgba(255,255,255,0.15);
            border-radius:9px; box-shadow:0 14px 40px rgba(0,0,0,0.5); overflow:hidden; resize:both; z-index:2000;`;

        // header / drag handle
        const header = document.createElement("div");
        header.style.cssText = `display:flex; align-items:center; gap:8px; padding:7px 10px; cursor:move;
            background:rgba(255,255,255,0.06); border-bottom:1px solid rgba(255,255,255,0.08);
            font:600 13px sans-serif; user-select:none; flex:0 0 auto;`;
        const title = document.createElement("div");
        title.textContent = "Scripted Video";
        title.style.cssText = "flex:1 1 auto;";
        const closeBtn = this._winButton("Close", () => this.hide());
        header.appendChild(title); header.appendChild(closeBtn);

        // movable content container (adopted into a popup when popped out)
        const content = this._buildEditorContent();
        this._content = content;

        panel.appendChild(header);
        panel.appendChild(content);
        document.body.appendChild(panel);
        this.panel = panel;

        // make it draggable by the header, and don't let the 3D view eat mouse events.
        // Dragging it up under the menu bar closes it (re-opening drops it back below).
        blockViewEvents(panel);
        makeDraggable(panel, { handle: header, excludeElements: [closeBtn], closeOnDragOffTop: () => this.hide() });

        // redraw timeline when the window is resized
        try { new ResizeObserver(() => this.sv.timeline.draw()).observe(panel); } catch (e) {}
    }

    // The editor content (toolbar + textarea + status + timeline) as a single div so it
    // can be moved between the in-page panel and a popped-out browser window.
    _buildEditorContent() {
        const sv = this.sv;
        const content = document.createElement("div");
        content.style.cssText = "display:flex; flex-direction:column; flex:1 1 auto; min-height:0;";

        const toolbar = document.createElement("div");
        toolbar.style.cssText = "display:flex; gap:6px; padding:6px 8px; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.06); flex:0 0 auto;";
        toolbar.appendChild(this._winButton("Parse", () => sv.doParse()));
        toolbar.appendChild(this._winButton("Preview", () => sv.startPreview()));
        toolbar.appendChild(this._winButton("Stop", () => sv.stopAll()));
        toolbar.appendChild(this._winButton("Render", () => sv.renderVideo()));
        this._popoutBtn = this._winButton("⧉ New Window", () => this._togglePopout());
        this._popoutBtn.style.marginLeft = "auto";
        toolbar.appendChild(this._popoutBtn);

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
        let saved = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
        ta.value = saved || DEFAULT_SCRIPT;
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

        const tl = document.createElement("canvas");
        tl.style.cssText = "display:block; width:calc(100% - 16px); height:60px; margin:0 8px 10px; border:1px solid #333; border-radius:4px; flex:0 0 auto;";
        sv.timeline.attach(tl);
        sv.timeline.editorCanvas = tl;

        content.appendChild(toolbar);
        content.appendChild(editWrap);
        content.appendChild(st);
        content.appendChild(tl);
        setTimeout(() => this._renderBackdrop(), 0);
        return content;
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

    // -----------------------------------------------------------------------
    // SHOW / HIDE / POPOUT
    // -----------------------------------------------------------------------

    show() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        if (this.panel) {
            this.panel.style.display = "flex";
            clampBelowMenuBar(this.panel);   // never re-open off the top of the screen
            this.sv.parse();
            setTimeout(() => { this.sv.timeline.draw(); this._renderBackdrop(); }, 0);
        }
    }

    hide() {
        if (this.external && !this.external.closed) { this.dockWindow(); return; }
        this.sv._exitAllModes();   // closing the editor leaves preview mode
        if (this.panel) this.panel.style.display = "none";
    }

    toggle() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        if (this.panel) (this.panel.style.display === "none" ? this.show() : this.hide());
    }

    _togglePopout() {
        if (this.external && !this.external.closed) this.dockWindow();
        else this.openExternalWindow();
    }

    // Pop the editor out into a real, separate browser window.
    openExternalWindow() {
        if (this.external && !this.external.closed) { this.external.focus(); return; }
        const win = window.open("", "SitrecScriptEditor", "popup,width=520,height=640");
        if (!win) { alert("Popup blocked — please allow popups for this site, then try again."); return; }
        this.external = win;
        try { win.document.title = "Sitrec — Scripted Video"; } catch (e) {}
        win.document.body.style.cssText = "margin:0; background:#14181d; color:#eef2f6; height:100vh; display:flex; flex-direction:column; overflow:hidden;";
        win.document.body.appendChild(win.document.adoptNode(this._content));
        this._charW = null;   // remeasure in the popup (zoom/DPI may differ)
        if (this.panel) this.panel.style.display = "none";
        this.sv.timeline.attachKeyZoom(win);
        win.addEventListener("resize", () => this.sv.timeline.draw());
        this._setPopoutLabel(true);
        win.addEventListener("beforeunload", () => this._dockFromExternal());
        // fallback poll in case beforeunload doesn't fire
        this._extPoll = setInterval(() => {
            if (!this.external || this.external.closed) this._dockFromExternal();
        }, 600);
        // The popup has no scripts of its own — if the MAIN window goes away its
        // editor becomes an inert orphan, so take it along. pagehide fires only
        // AFTER the global beforeunload unsaved-work dialog (which script edits
        // arm via markSitchDirty) has been confirmed, or immediately when there
        // is nothing unsaved — cancelling the dialog keeps both windows.
        if (!this._closePopupOnUnloadWired) {
            this._closePopupOnUnloadWired = true;
            window.addEventListener("pagehide", () => {
                if (this.external && !this.external.closed) this.external.close();
            });
        }
        setTimeout(() => this.sv.timeline.draw(), 60);
    }

    dockWindow() {
        this._dockShow = true;   // explicit dock → bring the in-page panel back up
        if (this.external && !this.external.closed) this.external.close();   // → beforeunload → _dockFromExternal
        else this._dockFromExternal();
    }

    _dockFromExternal() {
        if (this._extPoll) { clearInterval(this._extPoll); this._extPoll = null; }
        if (this._content && this._content.ownerDocument !== document) {
            this.panel.appendChild(document.adoptNode(this._content));
        }
        this._charW = null;   // remeasure back in the main document
        this.external = null;
        this._setPopoutLabel(false);
        // explicit Dock shows the panel; closing the popup just parks it hidden
        if (this.panel) this.panel.style.display = this._dockShow ? "flex" : "none";
        this._dockShow = false;
        setTimeout(() => this.sv.timeline.draw(), 60);
    }

    _setPopoutLabel(popped) {
        if (this._popoutBtn) this._popoutBtn.textContent = popped ? "⧉ Dock" : "⧉ New Window";
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
                // up = increment: synthesize the wheel's deltaY convention
                const deltaY = accum > 0 ? -1 : 1;
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
        const dir = deltaY < 0 ? 1 : -1;
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
