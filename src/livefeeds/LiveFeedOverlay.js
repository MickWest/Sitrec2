/**
 * LiveFeedOverlay — screen-space labels and a hover info box for the live feeds.
 *
 * DOM over the main view's div, not sprites in the scene. Text drawn as 3D
 * objects has to fight the depth buffer, re-render on every camera move, and
 * still ends up blurry at a readable size; a DOM layer gets crisp text, real
 * font metrics for collision boxes, and costs nothing when nothing is on screen.
 * `pointerEvents: none` throughout, so it never intercepts a click meant for the
 * scene underneath.
 *
 * THE HARD PART IS DECLUTTER, not drawing. A busy view carries 130 aircraft and
 * a thousand ships; labelling all of them produces an unreadable mat of
 * overlapping text that hides both the map and the markers. So labels are
 * budgeted and placed greedily by priority, and a label that would overlap one
 * already placed is simply dropped. This is the small, honest version of the
 * label-arbiter idea in GodsEyeViewReview.md Tier-1 #5.
 */

import {ViewMan} from "../CViewManager";
import {NodeMan} from "../Globals";
import {Vector3} from "three";

// At most this many labels on screen at once. Beyond roughly this count the view
// stops being readable no matter how well they are placed, and every extra label
// costs a collision test against all the ones already down.
const MAX_LABELS = 36;

// Screen padding around a label's box when testing overlap, so text from two
// labels never quite touches.
const LABEL_PAD_PX = 3;

// Labels are re-laid-out at this rate rather than every frame. Projection plus
// collision testing for a few hundred candidates is cheap but not free, and text
// that re-flows at 60 Hz reads as jitter rather than as precision.
const LAYOUT_INTERVAL_MS = 100;

let overlay = null;

/** The singleton, created on first use and attached to the main view. */
export function getLiveFeedOverlay() {
    if (!overlay) overlay = new CLiveFeedOverlay();
    return overlay;
}

class CLiveFeedOverlay {
    constructor() {
        this.root = null;
        this.labelPool = [];
        this.hoverBox = null;
        this.hover = null;
        this.lastLayoutMs = 0;
        this._scratch = new Vector3();
        this.showLabels = true;
    }

    /** Attach to the main view's div, or do nothing until it exists. */
    _ensureRoot() {
        if (this.root && this.root.isConnected) return true;
        const view = ViewMan.exists("mainView") ? ViewMan.list["mainView"].data : null;
        if (!view?.div) return false;

        this.root = document.createElement('div');
        Object.assign(this.root.style, {
            position: 'absolute',
            left: '0', top: '0', right: '0', bottom: '0',
            // Never intercept a click: everything under here is decoration over
            // a scene the user is trying to click on.
            pointerEvents: 'none',
            overflow: 'hidden',
            // Above the canvas, below the view's own UI bar.
            zIndex: '2',
        });
        view.div.appendChild(this.root);

        this.hoverBox = document.createElement('div');
        Object.assign(this.hoverBox.style, {
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            padding: '6px 9px',
            borderRadius: '5px',
            background: 'rgba(12,16,22,0.92)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 3px 12px rgba(0,0,0,0.55)',
            color: '#eef2f7',
            font: '12px/1.45 system-ui, sans-serif',
            whiteSpace: 'nowrap',
            maxWidth: '340px',
        });
        this.root.appendChild(this.hoverBox);
        return true;
    }

    /** A pooled label element, so a busy frame does not churn the DOM. */
    _label(index) {
        while (this.labelPool.length <= index) {
            const el = document.createElement('div');
            Object.assign(el.style, {
                position: 'absolute',
                pointerEvents: 'none',
                padding: '1px 5px 1px 4px',
                borderRadius: '3px',
                background: 'rgba(10,14,20,0.72)',
                borderLeft: '2px solid #fff',
                color: '#eef2f7',
                font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
                whiteSpace: 'nowrap',
                textShadow: '0 1px 2px rgba(0,0,0,0.9)',
                display: 'none',
            });
            this.root.appendChild(el);
            this.labelPool.push(el);
        }
        return this.labelPool[index];
    }

    /**
     * Every live layer currently on, whichever kind it is.
     *
     * Found through NodeMan by id prefix rather than by importing the layers, so
     * this module carries no dependency on either — both are lazy chunks, and an
     * import here would drag them into whatever bundle the overlay lands in.
     */
    _layers() {
        const out = [];
        NodeMan.iterate((id, node) => {
            if (typeof node.labelCandidates !== 'function') return;
            if (!node.polling) return;
            out.push(node);
        });
        return out;
    }

    /** Set (or clear) what the cursor is over. Called from the view's mouse handler. */
    setHover(hit, mouseX, mouseY) {
        this.hover = hit ? {hit, mouseX, mouseY} : null;
        if (!hit) this._hideHover();
        else this._drawHover();
    }

    _hideHover() {
        if (this.hoverBox) this.hoverBox.style.display = 'none';
    }

    _drawHover() {
        if (!this._ensureRoot() || !this.hover) return;
        const {hit, mouseX, mouseY} = this.hover;
        const view = ViewMan.list["mainView"].data;

        const color = hit.color !== undefined
            ? '#' + hit.color.toString(16).padStart(6, '0') : '#ffffff';
        // textContent per line rather than innerHTML: these strings come from
        // live third-party feeds, and a vessel name is exactly the kind of field
        // that can carry markup.
        this.hoverBox.replaceChildren();
        const title = document.createElement('div');
        title.textContent = hit.label || '';
        Object.assign(title.style, {fontWeight: '600', color, marginBottom: hit.detail ? '2px' : '0'});
        this.hoverBox.appendChild(title);
        if (hit.detail) {
            const detail = document.createElement('div');
            detail.textContent = hit.detail;
            detail.style.opacity = '0.85';
            this.hoverBox.appendChild(detail);
        }
        if (hit.hint) {
            const hint = document.createElement('div');
            hint.textContent = hit.hint;
            Object.assign(hint.style, {opacity: '0.6', marginTop: '3px', fontSize: '11px'});
            this.hoverBox.appendChild(hint);
        }

        // Position relative to the view, and flipped when it would run off the
        // right or bottom edge — a tooltip clipped by the viewport is worse than
        // one on the other side of the cursor.
        this.hoverBox.style.display = 'block';
        const w = this.hoverBox.offsetWidth;
        const h = this.hoverBox.offsetHeight;
        let x = mouseX - view.leftPx + 14;
        let y = mouseY - view.topPx + 14;
        if (x + w > view.widthPx - 4) x = mouseX - view.leftPx - w - 12;
        if (y + h > view.heightPx - 4) y = mouseY - view.topPx - h - 12;
        this.hoverBox.style.left = Math.max(2, x) + 'px';
        this.hoverBox.style.top = Math.max(2, y) + 'px';
    }

    /**
     * Lay out the labels. Called from a layer's per-frame update, throttled here
     * rather than by the caller so several layers cannot each pay for it.
     */
    update() {
        if (!this._ensureRoot()) return;
        const now = performance.now();
        if (now - this.lastLayoutMs < LAYOUT_INTERVAL_MS) return;
        this.lastLayoutMs = now;

        const view = ViewMan.list["mainView"].data;
        const camera = view?.camera;
        if (!camera || !this.showLabels) {
            this._hideLabelsFrom(0);
            return;
        }

        // Gather, project, and keep only what is on screen and close enough.
        const candidates = [];
        for (const layer of this._layers()) {
            for (const c of layer.labelCandidates()) {
                // NO distance gate. An absolute cutoff in metres is the wrong
                // instrument: what makes labels unreadable is how CROWDED they
                // are on screen, not how far away the things are, and crowding is
                // already handled exactly — by the collision test below and the
                // MAX_LABELS budget. A 400 km gate was tried first and simply
                // made labels vanish at ordinary viewing distances (a camera
                // framing Los Angeles sits ~2,300 km out), which reads as the
                // feature being broken.
                const distance = camera.position.distanceTo(c.ecef);
                this._scratch.copy(c.ecef).project(camera);
                if (this._scratch.z > 1) continue;   // behind the camera
                const sx = (this._scratch.x * 0.5 + 0.5) * view.widthPx;
                const sy = (1 - (this._scratch.y * 0.5 + 0.5)) * view.heightPx;
                if (sx < 0 || sx > view.widthPx || sy < 0 || sy > view.heightPx) continue;
                candidates.push({...c, sx, sy, distance});
            }
        }

        // Nearest first. Distance is the honest priority here: the thing you are
        // closest to is the thing you are most likely asking about, and it keeps
        // labels stable as the camera moves rather than reshuffling on ties.
        candidates.sort((a, b) => a.distance - b.distance);

        const placed = [];
        let used = 0;
        for (const c of candidates) {
            if (used >= MAX_LABELS) break;
            const el = this._label(used);
            el.textContent = c.label;
            el.style.borderLeftColor = '#' + (c.color ?? 0xffffff).toString(16).padStart(6, '0');
            // Measured after the text is set, because a collision box guessed
            // from character count is wrong for proportional glyphs and for any
            // non-Latin name a vessel might carry.
            el.style.display = 'block';
            el.style.left = '-9999px';
            const w = el.offsetWidth;
            const h = el.offsetHeight;

            // Offset up and right of the marker, so the label never sits on top
            // of the thing it names.
            const x = c.sx + 9;
            const y = c.sy - h - 6;
            const box = {l: x - LABEL_PAD_PX, t: y - LABEL_PAD_PX,
                r: x + w + LABEL_PAD_PX, b: y + h + LABEL_PAD_PX};

            if (box.r > view.widthPx || box.t < 0 || box.b > view.heightPx
                || placed.some(p => !(box.r < p.l || box.l > p.r || box.b < p.t || box.t > p.b))) {
                // Dropped rather than nudged. Nudging a label away from a
                // collision moves it off the thing it labels, which is a worse
                // failure than the label simply not being there.
                el.style.display = 'none';
                continue;
            }

            el.style.left = x + 'px';
            el.style.top = y + 'px';
            placed.push(box);
            used++;
        }
        this._hideLabelsFrom(used);
    }

    _hideLabelsFrom(index) {
        for (let i = index; i < this.labelPool.length; i++) {
            this.labelPool[i].style.display = 'none';
        }
    }

    /** Tear the DOM down — used when the last live layer goes away. */
    clear() {
        this._hideLabelsFrom(0);
        this._hideHover();
        this.hover = null;
    }
}
