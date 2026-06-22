import GUI from "./js/lil-gui.esm";

/**
 * CUIBar — a per-view header / UI bar (Blender-style "area header").
 *
 * An OVERLAY strip floating above the top edge of a view's content. It NEVER insets the
 * canvas: the viewport always renders full-size and the bar is drawn on top (shown when
 * pinned, or revealed on hover — driven by the owner, e.g. CNodeView). Showing/hiding it
 * changes NO rendering. Nothing here is serialized — pure runtime chrome.
 *
 * Layout: [ titleMenu | extra menus … ][ spacer ][ … icons | pin | close ]
 *   - The TITLE is itself a lil-gui menu (the view's primary menu) — the home for per-view
 *     options (like the old custom-graph tab menu). Named with a friendly, capitalised view
 *     name ("Main", "Look", "Video", "Assistant", …).
 *   - addMenu(title)            — host another lil-gui menu as a tab.
 *   - addIcon(html,onClick,tip,action) — an icon button (appended right, in call order).
 *   - addPinIcon / addCloseIcon — the standard chrome icons.
 */
export class CUIBar {
    constructor(host, options = {}) {
        this.host = host;
        this.menus = [];
        this.icons = [];
        this.onPinToggle = null;
        this.onClose = null;

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

        // Left section (title menu + extra menus), elastic spacer, right section (icons).
        this.left = section('flex-start');
        this.spacer = document.createElement('div');
        this.spacer.style.flex = '1 1 auto';
        this.right = section('flex-end');
        bar.append(this.left, this.spacer, this.right);
        host.appendChild(bar);

        // Swallow the mouse events the document-level view handlers act on, so clicking the
        // header doesn't orbit the camera (mousedown), open a context menu, or fullscreen via
        // onDocumentDoubleClick (dblclick). WHEEL is NOT blocked (the header is a thin overlay
        // — scrolling over it should still zoom the view). Pointer events are NOT blocked, so
        // the drag handle works.
        for (const type of ['mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
            bar.addEventListener(type, (e) => e.stopPropagation());
        }

        // The title is itself the view's primary lil-gui menu (like the custom-graph tab menu).
        if (options.title) this.titleMenu = this.addMenu(options.title);
    }

    // Host a lil-gui menu as a tab on the bar. Mirrors createStandaloneMenu's hosting pattern:
    // a relative slot whose GUI title acts as the tab, dropdown opens below.
    addMenu(title) {
        const slot = document.createElement('div');
        slot.className = 'view-uibar-menuslot';
        slot.style.position = 'relative';
        slot.style.pointerEvents = 'auto';
        // NOTE: the slot does NOT stop pointerdown — the whole bar (title included) is a drag
        // handle. Only the dropdown ITEMS block dragging (below).
        this.left.appendChild(slot);

        const gui = new GUI({ container: slot, autoPlace: false, title, closeFolders: false });
        gui.domElement.style.position = 'relative';
        gui.domElement.style.pointerEvents = 'auto';
        gui.close();

        // Float the dropdown BELOW the title (absolute) so OPENING the menu doesn't push the
        // title (or the rest of the bar) around, and the dropdown isn't constrained by the
        // bar height. Interacting with the dropdown ITEMS must NOT start a header drag.
        gui.$children.style.position = 'absolute';
        gui.$children.style.top = '100%';
        gui.$children.style.left = '0';
        gui.$children.style.minWidth = '180px';
        gui.$children.style.zIndex = '70';
        gui.$children.addEventListener('pointerdown', (e) => e.stopPropagation());

        // The title is BOTH a drag handle (the whole bar drags) and a menu toggle. To keep
        // both: suppress lil-gui's native mousedown toggle (openAnimated is gated so only our
        // tap path may open it) and toggle on a TAP — a pointerup with no movement — so
        // *dragging* the title moves the view without opening the menu. An empty menu never
        // opens.
        const _openAnimated = gui.openAnimated.bind(gui);
        gui.openAnimated = (open = true) => {
            if (open && (!gui.children || gui.children.length === 0)) return gui;  // empty
            if (!gui._uibarAllowToggle) return gui;                                // only via tap
            return _openAnimated(open);
        };
        let tapX = null, tapY = null;
        gui.$title.addEventListener('pointerdown', (e) => { tapX = e.clientX; tapY = e.clientY; });
        gui.$title.addEventListener('pointerup', (e) => {
            if (tapX === null) return;
            const moved = Math.abs(e.clientX - tapX) + Math.abs(e.clientY - tapY);
            tapX = null;
            if (moved > 5) return;   // it was a drag, not a tap
            gui._uibarAllowToggle = true;
            gui.openAnimated(gui._closed);
            gui._uibarAllowToggle = false;
        });

        this.menus.push(gui);
        return gui;
    }

    // action: optional stable identifier set as data-uibar-action (for tests / per-view
    // control wiring) so behaviour doesn't depend on the user-facing tooltip string.
    // left: place the icon in the LEFT section (next to the title) instead of the right.
    addIcon(html, onClick, tooltip, action, left = false) {
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
        btn.addEventListener('pointerleave', () => { btn.style.opacity = btn.dataset.uibarPinned === 'true' ? '1' : '0.7'; });
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => { e.stopPropagation(); if (onClick) onClick(e); });
        (left ? this.left : this.right).appendChild(btn);
        this.icons.push(btn);
        return btn;
    }

    addPinIcon(onToggle) {
        this.onPinToggle = onToggle;
        this._pin = this.addIcon('\u{1F4CC}', () => this.onPinToggle && this.onPinToggle(), 'Pin this header (keep it shown)', 'pin');
        return this._pin;
    }

    addCloseIcon(onClose) {
        this.onClose = onClose;
        this._close = this.addIcon('✕', () => this.onClose && this.onClose(), 'Close this view', 'close');
        return this._close;
    }

    setShown(shown) {
        this.bar.style.opacity = shown ? '1' : '0';
        this.bar.style.pointerEvents = shown ? 'auto' : 'none';
    }

    setPinned(pinned) {
        if (!this._pin) return;
        // Make the pinned state legible (opacity alone matched a normal idle icon).
        this._pin.dataset.uibarPinned = pinned ? 'true' : 'false';
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
