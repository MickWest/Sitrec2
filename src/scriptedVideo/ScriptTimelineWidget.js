import {commandModifier, wheelPixels, wheelZoomFactor} from "../GestureActions";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
// ScriptTimelineWidget.js — the Scripted Video timeline canvas widget.
//
// Draws the labelled event blocks / view cuts / playhead onto one or two canvases
// (the tall one in the script editor window, and a compact strip that replaces the
// normal frame slider during preview/scrub), and handles all timeline interaction:
// scrubbing, zoom (Cmd/Ctrl +/-/0), wheel-pan, scrollbar-pan, and hovering/wheel-
// editing a segment's duration number.
//
// The widget holds a back-reference `sv` to the CScriptedVideoManager, which owns
// the parsed model (events, totalDuration, _currentT) and the shared hover state
// (_hoverSeg/_hoverNum, shared with the editor's number-token hover).

import {clamp} from "./ScriptMath";
import {commandColor, eventLabel} from "./ScriptCommands";
import {getControlsContainer} from "../PageStructure";

export class CScriptTimelineWidget {

    // height (px) of the draggable scrollbar strip at the bottom of the timeline
    static get SCROLLBAR_H() { return 6; }

    constructor(sv) {
        this.sv = sv;                 // the CScriptedVideoManager (model + modes)
        this.editorCanvas = null;     // tall timeline in the script window
        this.bottomCanvas = null;     // compact strip in #ControlsBottom during preview
        this._hiddenControls = null;  // saved frame-slider children while replaced

        // timeline view (zoom/scroll)
        this.tlZoom = 1;              // 1 = whole timeline visible; >1 = zoomed in
        this.tlOffset = 0;            // left-edge time (seconds) of the visible window
        this._tlDragging = false;     // dragging the playhead
        this._dragCanvas = null;
        this._editDragging = false;   // dragging a segment edge/body edit
    }

    draw() {
        if (this.sv._previewing) this._followPlayhead();
        if (this.editorCanvas && this.editorCanvas.clientWidth > 0) this._drawTimelineTo(this.editorCanvas);
        if (this.bottomCanvas && this.bottomCanvas.clientWidth > 0) this._drawTimelineTo(this.bottomCanvas);
    }

    // Shared timeline geometry so the draw and the hit-test never drift apart.
    _timelineGeom(c) {
        const w = c.clientWidth || 320, h = c.clientHeight || 40;
        const total = this.sv.totalDuration || 1;
        const span = total / this.tlZoom;                 // visible time window
        const x = (t) => ((t - this.tlOffset) / span) * w;
        const compact = h < 44;
        const numLanes = this.sv._numLanes || 1;
        // top "ruler" strip: a dedicated always-scrub zone (~22% of height). Lanes
        // start below it. ~10px on the compact strip, ~13px in the editor.
        const rulerH = Math.max(9, Math.round(h * 0.22));
        const padTop = rulerH;
        const padBot = compact ? 1 : 13;   // room for duration label when not compact
        const gap = compact ? 1 : 2;
        const laneH = Math.max(3, (h - padTop - padBot - gap * (numLanes - 1)) / numLanes);
        return {w, h, total, span, x, compact, numLanes, rulerH, padTop, padBot, gap, laneH};
    }

    // x pixel of the playhead on canvas c (content-box coords)
    _playheadX(c) { return this._timelineGeom(c).x(this.sv._currentT); }

    // is a content-box x within the playhead's fat (±6px) grab zone?
    _nearPlayhead(c, px) { return Math.abs(px - this._playheadX(c)) <= 6; }

    // Snap a scrub time to nearby view-cut / segment edges (within ~5px), unless
    // bypassed (Cmd/Ctrl held for free positioning).
    _snapTime(c, t, bypass) {
        if (bypass) return t;
        const g = this._timelineGeom(c);
        const tol = 5 / (g.w || 1) * g.span;   // 5px in seconds at the current zoom
        let best = t, bestD = tol;
        const consider = (tt) => { const d = Math.abs(tt - t); if (d < bestD) { bestD = d; best = tt; } };
        for (const e of this.sv.events) {
            if (e.type === "view") consider(e.start);
            if (e.dur > 0) { consider(e.start); consider(e.start + e.dur); }
        }
        return best;
    }

    // The timeline segment (event bar) at a client position, or null.
    _segAtTimeline(c, clientX, clientY) {
        const hit = this._hitAtTimeline(c, clientX, clientY);
        return hit ? hit.seg : null;
    }

    _hitAtTimeline(c, clientX, clientY) {
        if (this.sv.totalDuration <= 0 || !this.sv.events) return null;
        const r = c.getBoundingClientRect();
        const px = clientX - r.left - (c.clientLeft || 0);   // strip the canvas border
        const py = clientY - r.top - (c.clientTop || 0);
        const g = this._timelineGeom(c);
        // the bottom strip is the scrollbar when zoomed — don't treat it as a segment
        const sb = this.tlZoom > 1.001 ? CScriptTimelineWidget.SCROLLBAR_H : 0;
        // the top ruler is the dedicated scrub zone — never a segment
        if (py < g.rulerH || py > g.h - sb) return null;
        for (const e of this.sv.events) {
            if (!(e.dur > 0)) continue;
            const y0 = g.padTop + (e._lane || 0) * (g.laneH + g.gap);
            const x0 = g.x(e.start), bw = Math.max(2, g.x(e.start + e.dur) - x0);
            if (px >= x0 && px <= x0 + bw && py >= y0 && py <= y0 + g.laneH) {
                const edge = Math.min(7, Math.max(3, bw / 3));
                const part = px >= x0 + bw - edge ? "right" : "body";
                return {seg: e, part, x0, bw};
            }
        }
        return null;
    }

    _canMoveEvent(e) {
        if (!e || !e.line) return false;
        const line = (this.sv.getScriptText().split("\n")[e.line - 1]) || "";
        return /^\s*&/.test(line);
    }

    _drawTimelineTo(c) {
        const sv = this.sv;
        const w = c.clientWidth || 320, h = c.clientHeight || 40;
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#16181d"; ctx.fillRect(0, 0, w, h);

        const g = this._timelineGeom(c);
        const total = g.total, span = g.span, x = g.x, compact = g.compact;
        const padTop = g.padTop, gap = g.gap, laneH = g.laneH;

        // top ruler strip: the always-scrub zone (subtly tinted, with a divider)
        ctx.fillStyle = "#202531"; ctx.fillRect(0, 0, w, g.rulerH);
        ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, g.rulerH + 0.5); ctx.lineTo(w, g.rulerH + 0.5); ctx.stroke();

        for (const e of sv.events) {
            if (!(e.dur > 0)) continue;
            const lane = e._lane || 0;
            const y = padTop + lane * (laneH + gap);
            const x0 = x(e.start), bw = Math.max(2, x(e.start + e.dur) - x0);
            ctx.fillStyle = e.invalid ? "#7a2a2a" : commandColor(e.type);
            ctx.fillRect(x0, y, bw, laneH);
            ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y + 0.5, bw - 1, laneH - 1);
            // highlight the segment linked to the hovered number / hovered segment
            if (sv._hoverSeg && e.line === sv._hoverSeg.line) {
                ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2;
                ctx.strokeRect(x0 + 1, y + 1, Math.max(1, bw - 2), Math.max(1, laneH - 2));
            }
            if (sv._selectedEventLine === e.line && (!sv._selectedEventType || sv._selectedEventType === e.type)) {
                ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
                ctx.strokeRect(x0 + 1.5, y + 1.5, Math.max(1, bw - 3), Math.max(1, laneH - 3));
            }
            if (bw > 24 && laneH >= 11) {
                ctx.fillStyle = "#fff"; ctx.font = "10px sans-serif";
                ctx.textBaseline = "middle"; ctx.textAlign = "left";
                ctx.save(); ctx.beginPath(); ctx.rect(x0, y, bw, laneH); ctx.clip();
                ctx.fillText(eventLabel(e), x0 + 3, y + laneH / 2);
                ctx.restore();
            }
        }

        // view cuts: full-height line, label sits just BELOW the ruler (out of the
        // scrub zone) so it never competes with the ruler / playhead handle
        for (const e of sv.events) {
            if (e.type !== "view") continue;
            const xx = x(e.start);
            ctx.strokeStyle = "#cfd3da"; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(xx, g.rulerH); ctx.lineTo(xx, h); ctx.stroke();
            if (!compact) {
                ctx.fillStyle = "#cfd3da"; ctx.font = "9px sans-serif";
                ctx.textBaseline = "top"; ctx.textAlign = "left";
                ctx.fillText(e.view, xx + 2, g.rulerH + 1);
            }
        }

        // playhead (always shown so scrubbing position is visible too); the grab
        // triangle lives in the ruler. Brighter when hovered/dragging.
        const px = x(sv._currentT);
        if (px >= -1 && px <= w + 1) {
            const hot = this._playheadHot || this._tlDragging;
            ctx.fillStyle = hot ? "#ffe680" : "#ffd24a";
            const th2 = Math.min(7, g.rulerH);
            ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, th2); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = hot ? "#ffe680" : "#ffd24a"; ctx.lineWidth = hot ? 2 : 1.5;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
        }

        // scrollbar showing/controlling the visible window when zoomed in
        if (this.tlZoom > 1.001) {
            const sbH = CScriptTimelineWidget.SCROLLBAR_H;
            const bx0 = (this.tlOffset / total) * w, bw = (span / total) * w;
            ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(0, h - sbH, w, sbH);
            ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.fillRect(bx0, h - sbH, Math.max(10, bw), sbH);
        }

        // current-time / duration label (only where there's room)
        if (!compact) {
            ctx.fillStyle = "#aab"; ctx.font = "10px sans-serif";
            ctx.textAlign = "right"; ctx.textBaseline = "bottom";
            ctx.fillText(sv._currentT.toFixed(1) + " / " + total.toFixed(1) + "s"
                + (this.tlZoom > 1.001 ? "  ×" + this.tlZoom.toFixed(1) : ""), w - 3, h - 1);
        }
    }

    // time at a pixel x on a timeline canvas (accounts for zoom/scroll). Strips the
    // canvas border and divides by the content-box width so it lands exactly on the
    // drawn bars/playhead (same convention as _segAtTimeline / _drawTimelineTo).
    _timeAtX(c, clientX) {
        const r = c.getBoundingClientRect();
        const px = clientX - r.left - (c.clientLeft || 0);
        const frac = clamp(px / (c.clientWidth || r.width), 0, 1);
        const span = this.sv.totalDuration / this.tlZoom;
        return clamp(this.tlOffset + frac * span, 0, this.sv.totalDuration);
    }

    // A canvas has one owner for scrub, event editing and scrollbar movement.
    attach(c, view) {
        c._timelineDispose?.();
        c.style.cursor = "ew-resize";
        c.title = "Drag to scrub (top strip or the playhead) • ⌘/Ctrl-wheel to zoom • wheel to pan";
        const leave = () => this._onTimelineLeave(c);
        c.addEventListener("pointerleave", leave);
        const unregister = registerSurfaceInteraction(c, {
            profile: "timeline",
            model: this, view, id: `timeline:${c === this.bottomCanvas ? "bottom" : "editor"}`,
            begin: e => {
                this._gestureMove = this._gestureEnd = null;
                this._navigationBefore = {time: this.sv._currentT, offset: this.tlOffset};
                this._onTimelineMouseDown(c, e);
            },
            move: e => this._gestureMove?.(e),
            end: (e, reason) => {
                this._gestureEnd?.(e);
                this._gestureMove = this._gestureEnd = null;
                if (reason === "rollback") {
                    this.tlOffset = this._navigationBefore.offset;
                    this.sv._scrubTo(this._navigationBefore.time);
                }
            },
            hover: e => { if (e) this._updateTimelineHover(c, e.clientX, e.clientY); else leave(); },
            wheel: e => this._onTimelineWheel(c, e),
            snapshot: () => this.sv.editor.captureEdit(),
            restore: state => { this.sv.editor.restoreEdit(state).then(() => this.draw()); },
            undo: "Edit timeline event",
        });
        c._timelineDispose = () => { unregister(); c.removeEventListener("pointerleave", leave); };
    }

    // Hovering a timeline segment highlights it + its duration number in the editor,
    // and arms the wheel to edit that duration. Hovering elsewhere = scrub/pan cursor.
    _updateTimelineHover(c, clientX, clientY) {
        if (this._tlDragging || this._editDragging) return;
        const sv = this.sv;
        const r = c.getBoundingClientRect();
        const px = clientX - r.left - (c.clientLeft || 0);
        // playhead grab zone highlight (redraw only when it changes)
        const wasHot = !!this._playheadHot;
        this._playheadHot = this._nearPlayhead(c, px);
        if (this._playheadHot !== wasHot) this.draw();
        const hit = this._hitAtTimeline(c, clientX, clientY);
        const seg = hit ? hit.seg : null;
        // cursor: playhead/ruler/empty = scrub (ew-resize); segment edge = resize;
        // movable & body = grab; a segment with a duration = ns-resize (wheel-edit)
        if (this._playheadHot) c.style.cursor = "ew-resize";
        else if (hit && hit.part === "right" && seg.spans && seg.spans.dur) c.style.cursor = "ew-resize";
        else if (hit && hit.part === "body" && this._canMoveEvent(seg)) c.style.cursor = "grab";
        else c.style.cursor = (seg && seg.spans && seg.spans.dur) ? "ns-resize" : "ew-resize";
        const prevLine = sv._hoverSeg ? sv._hoverSeg.line : null;
        const newLine = seg ? seg.line : null;
        // the boxed duration only changes via a wheel edit (which re-renders itself),
        // so a same-line mousemove needs no rebuild
        if (prevLine !== newLine) {
            sv._hoverSeg = seg;
            sv._hoverNum = seg ? sv._durTokenForEvent(seg) : null;
            sv.editor._renderBackdrop();
            this.draw();
        }
    }

    _onTimelineLeave(c) {
        if (this._tlDragging) return;
        const sv = this.sv;
        c.style.cursor = "ew-resize";
        if (this._playheadHot) { this._playheadHot = false; this.draw(); }
        if (sv._hoverSeg || sv._hoverNum) {
            sv._hoverSeg = null; sv._hoverNum = null;
            sv.editor._renderBackdrop(); this.draw();
        }
    }

    _onTimelineMouseDown(c, ev) {
        const r = c.getBoundingClientRect();
        const y = ev.clientY - r.top;
        // bottom strip drags the scrollbar (only meaningful when zoomed in)
        if (this.tlZoom > 1.001 && y >= r.height - CScriptTimelineWidget.SCROLLBAR_H) {
            this._beginScrollDrag(c, ev);
            return;
        }
        // the playhead's fat grab zone wins over everything below it, so you can
        // grab and drag it even when it sits on top of a segment
        const px = ev.clientX - r.left - (c.clientLeft || 0);
        if (this._nearPlayhead(c, px)) { this._beginTimelineDrag(c, ev); return; }
        const hit = this._hitAtTimeline(c, ev.clientX, ev.clientY);
        if (hit && hit.seg) {
            this.sv.selectEvent(hit.seg);
            if (hit.part === "right" && hit.seg.spans && hit.seg.spans.dur) {
                this._beginDurationDrag(c, ev, hit.seg);
            } else if (hit.part === "body" && this._canMoveEvent(hit.seg)) {
                this._beginOffsetDrag(c, ev, hit.seg);
            } else {
                this.sv._scrubTo(hit.seg.start);
            }
        } else {
            this._beginTimelineDrag(c, ev);
        }
    }

    _beginDurationDrag(c, ev, seg) {
        ev.preventDefault();
        this._editDragging = true;
        c.style.cursor = "ew-resize";
        const row = seg.line - 1;
        let span = {...seg.spans.dur};
        const startTime = this._timeAtX(c, ev.clientX), startDuration = seg.dur;
        const apply = (e) => {
            const dur = Math.max(0.1, startDuration + this._timeAtX(c, e.clientX) - startTime);
            const nextSpan = this.sv.editor.setNumberToken(row, span, dur, 0.1);
            if (nextSpan) span = nextSpan;
            this.draw();
            if (this.sv._previewing) this.sv._scrubTo(this.sv._currentT);
        };
        apply(ev);
        const up = (e) => {
            this._editDragging = false;
            if (e) this._updateTimelineHover(c, e.clientX, e.clientY);
        };
        this._gestureMove = apply; this._gestureEnd = up;
    }

    _beginOffsetDrag(c, ev, seg) {
        ev.preventDefault();
        this._editDragging = true;
        c.style.cursor = "grabbing";
        const row = seg.line - 1;
        let span = seg.offSpan ? {...seg.offSpan} : this.sv.editor.ensureOffsetToken(row);
        if (!span) { this._editDragging = false; return; }
        const line = (this.sv.getScriptText().split("\n")[row]) || "";
        const startOffset = parseFloat(line.slice(span.start, span.end)) || 0;
        const grabDt = this._timeAtX(c, ev.clientX) - seg.start;
        const apply = (e) => {
            const newStart = this._timeAtX(c, e.clientX) - grabDt;
            const newOffset = Math.max(0, startOffset + (newStart - seg.start));
            const nextSpan = this.sv.editor.setNumberToken(row, span, newOffset, 0);
            if (nextSpan) span = nextSpan;
            this.draw();
            if (this.sv._previewing) this.sv._scrubTo(this.sv._currentT);
        };
        apply(ev);
        const up = (e) => {
            this._editDragging = false;
            if (e) this._updateTimelineHover(c, e.clientX, e.clientY);
        };
        this._gestureMove = apply; this._gestureEnd = up;
    }

    // The surface adapter routes scrub movement through its document session.
    _beginTimelineDrag(c, ev) {
        ev.preventDefault();
        const sv = this.sv;
        if (sv.totalDuration <= 0) { sv.parse(); sv.prepare(); }
        if (sv.totalDuration <= 0) return;
        this._tlDragging = true;
        this._dragCanvas = c;
        const scrubAt = (e) => {
            const cc = this._dragCanvas; if (!cc) return;
            sv._scrubTo(this._snapTime(cc, this._timeAtX(cc, e.clientX), commandModifier(e)));
        };
        scrubAt(ev);
        const move = (e) => scrubAt(e);
        const up = (e) => {
            this._tlDragging = false; this._dragCanvas = null;
            // re-evaluate hover at the release point (clears a stale highlight if the
            // drag ended off a bar / off the canvas)
            if (e) this._updateTimelineHover(c, e.clientX, e.clientY);
        };
        this._gestureMove = move; this._gestureEnd = up;
    }

    _beginScrollDrag(c, ev) {
        ev.preventDefault();
        if (this.sv.totalDuration <= 0) return;
        const pan = (e) => {
            const r = c.getBoundingClientRect();
            const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
            const span = this.sv.totalDuration / this.tlZoom;
            this.tlOffset = clamp(fx * this.sv.totalDuration - span / 2, 0, Math.max(0, this.sv.totalDuration - span));
            this.draw();
        };
        pan(ev);
        const up = () => {
        };
        this._gestureMove = pan; this._gestureEnd = up;
    }

    // Cmd/Ctrl + '=' / '-' zoom the timeline (and suppress the browser's own zoom).
    attachKeyZoom(win) {
        const handler = (e) => {
            if (!(commandModifier(e))) return;
            const sv = this.sv;
            const editorOpen = sv.editor.isOpen() || sv._previewing;
            if (!editorOpen) return;
            const k = e.key, code = e.code;
            if (k === "=" || k === "+" || code === "Equal" || code === "NumpadAdd") {
                e.preventDefault(); e.stopPropagation(); this._zoomTimeline(1.5);
            } else if (k === "-" || k === "_" || code === "Minus" || code === "NumpadSubtract") {
                e.preventDefault(); e.stopPropagation(); this._zoomTimeline(1 / 1.5);
            } else if (k === "0" || code === "Digit0") {
                e.preventDefault(); e.stopPropagation(); this.tlZoom = 1; this.tlOffset = 0; this.draw();
            }
        };
        win.addEventListener("keydown", handler, true);   // capture phase to beat the browser
    }

    _onTimelineWheel(c, ev) {
        const sv = this.sv;
        if (sv.totalDuration <= 0) return;
        // Cmd/Ctrl + wheel → zoom centered on the cursor's time (matches the
        // Cmd/Ctrl +/-/0 keys). Takes priority over duration-edit/pan.
        if (commandModifier(ev)) {
            ev.preventDefault();
            const factor = wheelZoomFactor(ev, "timeline");
            if (factor === 1) return;
            this._zoomTimelineAt(factor, this._timeAtX(c, ev.clientX));
            return;
        }
        // over a segment → the wheel edits that segment's duration (like the editor)
        const seg = this._segAtTimeline(c, ev.clientX, ev.clientY);
        if (seg && seg.spans && seg.spans.dur && wheelPixels(ev) !== 0) {
            ev.preventDefault();
            sv.editor.adjustNumberTokenWheel(seg.line - 1, seg.spans.dur, ev, 0.1);
            // events are rebuilt by the (async) doParse(); re-resolve the hovered
            // segment + number once the new model has committed
            (sv.editor._parsePromise || Promise.resolve()).then(() => {
                sv._hoverSeg = sv._eventOnLine(seg.line);
                sv._hoverNum = sv._durTokenForEvent(sv._hoverSeg);
                c.style.cursor = "ns-resize";
                sv.editor._renderBackdrop();
                this.draw();
                if (sv._previewing) sv._scrubTo(sv._currentT);
            });
            return;
        }
        // otherwise pan the visible window
        ev.preventDefault();
        const span = sv.totalDuration / this.tlZoom;
        const d = wheelPixels(ev, {dominant: true});
        this.tlOffset = clamp(this.tlOffset + d * span / (c.clientWidth || 300),
            0, Math.max(0, sv.totalDuration - span));
        this.draw();
    }

    // zoom the timeline about the playhead (or visible centre if it's off-screen)
    _zoomTimeline(factor) {
        const span = (this.sv.totalDuration || 1) / this.tlZoom;
        let centerT = this.sv._currentT;
        if (centerT < this.tlOffset || centerT > this.tlOffset + span) centerT = this.tlOffset + span / 2;
        this._zoomTimelineAt(factor, centerT);
    }

    // zoom keeping the given time anchored under its current pixel (zoom-at-cursor)
    _zoomTimelineAt(factor, centerT) {
        const total = this.sv.totalDuration || 1;
        const span = total / this.tlZoom;
        const frac = span > 0 ? clamp((centerT - this.tlOffset) / span, 0, 1) : 0.5;
        const maxZoom = Math.max(1, total / 0.5);
        this.tlZoom = clamp(this.tlZoom * factor, 1, maxZoom);
        const newSpan = total / this.tlZoom;
        this.tlOffset = clamp(centerT - frac * newSpan, 0, Math.max(0, total - newSpan));
        this.draw();
    }

    // keep the playhead in view while previewing if zoomed in
    _followPlayhead() {
        if (this.tlZoom <= 1.001) return;
        const span = this.sv.totalDuration / this.tlZoom;
        if (this.sv._currentT < this.tlOffset || this.sv._currentT > this.tlOffset + span) {
            this.tlOffset = clamp(this.sv._currentT - span / 2, 0, Math.max(0, this.sv.totalDuration - span));
        }
    }

    // Replace the normal bottom frame slider with the scripted timeline during preview.
    showBottomStrip() {
        const cc = getControlsContainer();
        if (!cc || this.bottomCanvas) return;
        this._hiddenControls = [];
        for (const child of Array.from(cc.children)) {
            this._hiddenControls.push([child, child.style.display]);
            child.style.display = "none";
        }
        const c = document.createElement("canvas");
        c.style.cssText = "display:block;width:100%;height:100%;z-index:1002;position:relative;";
        this.attach(c);
        cc.appendChild(c);
        this.bottomCanvas = c;
    }

    hideBottomStrip() {
        this.bottomCanvas?._timelineDispose?.();
        if (this.bottomCanvas && this.bottomCanvas.parentNode) {
            this.bottomCanvas.parentNode.removeChild(this.bottomCanvas);
        }
        this.bottomCanvas = null;
        if (this._hiddenControls) {
            for (const [el, d] of this._hiddenControls) el.style.display = d;
            this._hiddenControls = null;
        }
    }
}
