/**
 * A floating read-out that hovers above a slider's cursor.
 *
 * The frame slider has always shown one of these above the playhead (frame
 * number, video time, local time). The big-slider popup needs exactly the same
 * thing for a lil-gui number, so the box itself - its styling, its horizontal
 * tracking of the cursor, and its show/hide state - lives here, and each caller
 * supplies only the text.
 */

// Keep this much clear space between the box and the edge of the window.
const EDGE_MARGIN = 4;

export class CValueBox {
    /**
     * @param {object} [options]
     * @param {string} [options.bottom] - CSS distance from the bottom of the viewport
     * @param {number} [options.zIndex]
     * @param {string} [options.fontSize]
     */
    constructor({bottom = '45px', zIndex = 1004, fontSize = '12px'} = {}) {
        const el = document.createElement('div');
        el.style.position = 'fixed';
        el.style.bottom = bottom;
        el.style.zIndex = String(zIndex);
        el.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        el.style.color = 'white';
        el.style.padding = '4px 8px';
        el.style.borderRadius = '4px';
        el.style.fontSize = fontSize;
        el.style.fontFamily = 'monospace';
        el.style.whiteSpace = 'pre';            // callers pass multi-line text
        el.style.pointerEvents = 'none';
        el.style.transform = 'translateX(-50%)'; // centred on the cursor
        el.style.display = 'none';
        document.body.appendChild(el);

        this.el = el;
        this.lastText = null;
        this.lastWidth = 0;
    }

    get visible() {
        return this.el !== null && this.el.style.display === 'block';
    }

    // Show the box (if hidden) and put it over the given viewport X.
    show(text, centerX) {
        if (!this.el) return;
        if (!this.visible) {
            this.el.style.display = 'block';
            this.lastWidth = 0;     // a hidden box measures zero, so re-measure now
        }
        this.setText(text);
        this.moveTo(centerX);
    }

    // Move/retext an already-visible box. Does nothing while hidden, so callers
    // can fire it from a render loop without worrying about the display state.
    update(text, centerX) {
        if (!this.visible) return;
        this.setText(text);
        this.moveTo(centerX);
    }

    hide() {
        if (this.el) this.el.style.display = 'none';
    }

    dispose() {
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
    }

    // The width is only re-measured when the text changes. Reading offsetWidth
    // forces a layout, and moveTo() needs the width on every pointer move.
    setText(text) {
        if (text === this.lastText && this.lastWidth > 0) return;
        this.el.textContent = text;
        this.lastText = text;
        this.lastWidth = this.el.offsetWidth;
    }

    // Keep the whole box on screen. It is centred on the cursor, so at either end
    // of a full-width slider half of it would otherwise fall off the edge.
    moveTo(centerX) {
        const half = this.lastWidth / 2;
        const clamped = Math.max(half + EDGE_MARGIN,
            Math.min(centerX, window.innerWidth - half - EDGE_MARGIN));
        this.el.style.left = clamped + 'px';
    }
}
