import GUI from "./js/lil-gui.esm";

/**
 * CUIBar — a per-view header / UI bar (Blender-style "area header").
 *
 * It is an OVERLAY strip that floats above the top edge of a view's content. It NEVER
 * insets the canvas: the viewport always renders at full size and the bar is drawn on
 * top (optionally — hover-reveal + pin are driven by the owner, e.g. CNodeView). Showing
 * or hiding the bar therefore changes NO rendering.
 *
 * It is a "more complex UIBar that supports menus plus icons":
 *   - addTitle(text)            — a label on the left.
 *   - addMenu(title)            — a lil-gui menu hosted as a tab on the bar (same pattern
 *                                 as the main menu bar / createStandaloneMenu / the old
 *                                 CNodeTabbedCanvasView.createTabMenu). Returns the GUI so
 *                                 callers add controls to it (e.g. the FOV editor's menu).
 *   - addIcon(html,onClick,tip) — an icon button on the right.
 *
 * Styling uses the shared design tokens (--sitrec-bg-header etc.). Nothing here is
 * serialized — it is pure runtime chrome, so saved/legacy sitches are unaffected.
 */
export class CUIBar {
    constructor(host, options = {}) {
        this.host = host;
        this.menus = [];
        this.icons = [];
        this.onPinToggle = null;

        const bar = document.createElement('div');
        bar.className = 'view-uibar';
        Object.assign(bar.style, {
            position: 'absolute', top: '0', left: '0', width: '100%',
            height: 'var(--sitrec-header-h, 26px)', boxSizing: 'border-box',
            background: 'var(--sitrec-bg-header, #303030)',
            color: 'var(--sitrec-text, #ebebeb)',
            borderBottom: '1px solid var(--sitrec-border-area, rgba(255,255,255,0.08))',
            font: '12px sans-serif',
            display: 'flex', alignItems: 'stretch', gap: '2px',
            zIndex: '60',                       // above the canvas + HUD overlays
            userSelect: 'none',
            opacity: '0', pointerEvents: 'none', // hidden until the owner shows it
            transition: 'opacity 0.08s ease',
        });
        this.bar = bar;

        // Left section (title + menus), elastic spacer, right section (icons + pin).
        this.left = section('flex-start');
        this.spacer = document.createElement('div');
        this.spacer.style.flex = '1 1 auto';
        this.right = section('flex-end');
        bar.append(this.left, this.spacer, this.right);
        host.appendChild(bar);

        // Swallow the mouse events the document-level view handlers act on, so clicking the
        // header doesn't orbit the camera (mousedown), open a context menu (contextmenu), or
        // fullscreen the view via onDocumentDoubleClick (dblclick). WHEEL is intentionally NOT
        // blocked — the header is a thin transient overlay, so scrolling over it should still
        // zoom the view underneath. Pointer events are NOT blocked either, so the drag handle
        // (pointerdown on the bar) still works.
        for (const type of ['mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
            bar.addEventListener(type, (e) => e.stopPropagation());
        }

        if (options.title) this.addTitle(options.title);
        if (options.pin !== false) {
            this._pin = this.addIcon('\u{1F4CC}', () => this.onPinToggle && this.onPinToggle(), 'Pin this header (keep it shown)', 'pin');
        }
    }

    addTitle(text) {
        const el = document.createElement('span');
        el.className = 'view-uibar-title';
        el.textContent = text;
        Object.assign(el.style, {
            display: 'flex', alignItems: 'center', padding: '0 8px',
            fontWeight: '600', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%',
        });
        this.left.appendChild(el);
        this.title = el;
        return el;
    }

    // Host a lil-gui menu as a tab on the bar. Mirrors createStandaloneMenu's hosting
    // pattern: a relative slot whose GUI title acts as the tab, dropdown opens below.
    addMenu(title) {
        const slot = document.createElement('div');
        slot.className = 'view-uibar-menuslot';
        slot.style.position = 'relative';
        slot.style.pointerEvents = 'auto';
        // A menu interaction must NOT start a header drag (the bar is the drag handle).
        slot.addEventListener('pointerdown', (e) => e.stopPropagation());
        this.left.appendChild(slot);

        const gui = new GUI({ container: slot, autoPlace: false, title, closeFolders: false });
        gui.domElement.style.position = 'relative';
        gui.domElement.style.pointerEvents = 'auto';
        gui.close();

        // The forked lil-gui does NOT toggle a hosted root menu on title click (the main
        // menu bar drives open/close itself), so wire an explicit click-to-toggle. This
        // replaces the old CNodeTabbedCanvasView.toggleTabMenu that the FOV/curve editors
        // relied on. (pointerdown on the slot already stops a header drag from starting.)
        gui.$title.style.cursor = 'pointer';
        gui.$title.addEventListener('click', (e) => {
            e.stopPropagation();
            if (gui._closed) gui.open(); else gui.close();
        });

        this.menus.push(gui);
        return gui;
    }

    // action: optional stable identifier set as data-uibar-action (for tests / per-view
    // control wiring) so behaviour doesn't depend on the user-facing tooltip string.
    addIcon(html, onClick, tooltip, action) {
        const btn = document.createElement('button');
        btn.className = 'view-uibar-icon';
        btn.type = 'button';
        btn.innerHTML = html;
        if (tooltip) { btn.title = tooltip; btn.setAttribute('aria-label', tooltip); }
        if (action) btn.dataset.uibarAction = action;
        Object.assign(btn.style, {
            border: 'none', background: 'transparent', color: 'inherit',
            cursor: 'pointer', font: '13px sans-serif', padding: '0 6px',
            opacity: '0.7', pointerEvents: 'auto', borderRadius: '3px',
        });
        btn.addEventListener('pointerenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('pointerleave', () => { btn.style.opacity = '0.7'; });
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => { e.stopPropagation(); if (onClick) onClick(e); });
        // keep the pin button rightmost: insert new icons before it.
        this.right.insertBefore(btn, this._pin || null);
        this.icons.push(btn);
        return btn;
    }

    setShown(shown) {
        this.bar.style.opacity = shown ? '1' : '0';
        this.bar.style.pointerEvents = shown ? 'auto' : 'none';
    }

    setPinned(pinned) {
        if (!this._pin) return;
        // Make the pinned state legible (opacity alone matched a normal idle icon).
        this._pin.style.opacity = pinned ? '1' : '0.7';
        this._pin.style.background = pinned ? 'var(--sitrec-hover, #4f4f4f)' : 'transparent';
        this._pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    }

    dispose() {
        for (const g of this.menus) { try { g.destroy(); } catch (e) { /* best effort */ } }
        this.bar.remove();
    }
}

function section(justify) {
    const d = document.createElement('div');
    d.style.display = 'flex';
    d.style.alignItems = 'center';
    d.style.justifyContent = justify;
    d.style.flex = '0 0 auto';
    return d;
}
