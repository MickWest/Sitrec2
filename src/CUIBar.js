import GUI from "./js/lil-gui.esm";
import {Globals} from "./Globals";
import {registerGUIRoot, unregisterGUIRoot} from "./GUIRootRegistry";

const DROPDOWN_MARGIN_PX = 8;    // breathing room between the menu and the window edge
const DROPDOWN_MIN_PX = 80;      // never squash a low-docked view's menu to nothing

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
        // Fired whenever a menu on this bar opens or closes. The owner (CNodeView) uses it to
        // recompute what the header covers — an open menu must keep the bar shown.
        this.onMenuStateChange = null;
        this.shown = false;

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

        // An open menu stays open until you tap its title again or press somewhere else — the
        // usual menu contract, and the thing that lets go of the "keep the bar shown" latch.
        // Capture phase, because the dropdown's own items stop propagation. The dropdown is a
        // DOM descendant of the bar (it just paints outside its box), so one contains() covers
        // the title, the rows and the icons.
        this._onDocumentPointerDown = (e) => {
            if (!this.hasOpenMenu() || this.bar.contains(e.target)) return;
            this.closeMenus();
        };
        document.addEventListener('pointerdown', this._onDocumentPointerDown, true);

        // The title is itself the view's primary lil-gui menu (like the custom-graph tab menu).
        if (options.title) this.titleMenu = this.addMenu(options.title);
    }

    // Is any menu on this bar open? While one is, the bar must stay VISIBLE: the dropdown hangs
    // BELOW the strip, so moving the pointer down to click an item leaves the bar's hover
    // region, and hover-reveal would fade the menu out from under the click.
    hasOpenMenu() {
        return this.menus.some(gui => !gui._closed);
    }

    // What this bar paints, in page coordinates — the full-width strip, plus any open dropdown
    // hanging below it (a narrow column, not a full-width band). Reported as three numbers
    // because that is the exact shape: everything above `barBottom`, and everything left of
    // `menuRight` down to `bottom`.
    //
    // The dropdown's HEIGHT is measured from its content rather than its rect, so the answer is
    // right on the frame the menu opens instead of 80ms later when the open animation lands.
    chromeRect() {
        const bar = this.bar.getBoundingClientRect();
        const rect = {left: bar.left, barBottom: bar.bottom, bottom: bar.bottom, menuRight: bar.left};
        for (const gui of this.menus) {
            if (gui._closed) continue;
            const children = gui.$children.getBoundingClientRect();
            const cap = parseFloat(gui.$children.style.maxHeight) || Infinity;
            rect.bottom = Math.max(rect.bottom, children.top + Math.min(cap, gui.$children.scrollHeight));
            rect.menuRight = Math.max(rect.menuRight, children.right);
        }
        return rect;
    }

    closeMenus() {
        let changed = false;
        for (const gui of this.menus) {
            if (gui._closed) continue;
            gui._uibarAllowToggle = true;
            gui.openAnimated(false);
            gui._uibarAllowToggle = false;
            changed = true;
        }
        if (changed) this.onMenuStateChange?.();
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
        // Fit the title to its TEXT, not lil-gui's fixed 245px default width. The left/right bar
        // sections are flex:0 0 auto (don't shrink), so a 245px title overflows a narrow view and
        // shoves the icons off the right edge; max-content lets the icons abut the title instead.
        // (The dropdown is absolute with its own min-width, so it's unaffected.)
        gui.domElement.style.width = 'max-content';
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
        // opens — "empty" meaning nothing the user can SEE, since a per-view menu pre-creates
        // its groups hidden and reveals them only if their controls turn up (ViewUIBarMenus).
        const _openAnimated = gui.openAnimated.bind(gui);
        gui.openAnimated = (open = true) => {
            if (open && !hasVisibleItems(gui)) return gui;
            if (!gui._uibarAllowToggle) return gui;                                // only via tap
            if (open) fitDropdownToWindow(gui);
            return _openAnimated(open);
        };
        let tapX = null, tapY = null;
        gui.$title.addEventListener('pointerdown', (e) => { tapX = e.clientX; tapY = e.clientY; });
        gui.$title.addEventListener('pointerup', (e) => {
            if (tapX === null) return;
            const moved = Math.abs(e.clientX - tapX) + Math.abs(e.clientY - tapY);
            tapX = null;
            if (moved > 5) return;   // it was a drag, not a tap
            // Only one menu on a bar at a time, like a menu bar.
            for (const other of this.menus) if (other !== gui && !other._closed) {
                other._uibarAllowToggle = true;
                other.openAnimated(false);
                other._uibarAllowToggle = false;
            }
            gui._uibarAllowToggle = true;
            gui.openAnimated(gui._closed);
            gui._uibarAllowToggle = false;
            this.onMenuStateChange?.();
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
        // In regression mode keep every view header hidden. The bar is hover-reveal chrome, so
        // whether it's visible at screenshot time is timing-dependent — that non-determinism makes
        // the visual baselines flake. Hiding it deterministically (the same way split-tree tiling
        // is skipped under Globals.regression) keeps the compared viewport stable. It changes no
        // 3D rendering — the bar is a pure DOM overlay above the canvas.
        if (Globals.regression) shown = false;
        this.shown = shown;
        this.bar.style.opacity = shown ? '1' : '0';
        this.bar.style.pointerEvents = shown ? 'auto' : 'none';
        // These menus are lil-gui ROOTS, not menu-bar slots, so nothing polls their .listen()
        // controllers unless they say so — and a mirrored row that is not polled shows whatever
        // was true when it was built. Poll only while the bar is up: a hidden header would cost
        // a full tree walk per frame for nothing, and it catches up the frame it reappears.
        if (shown) this.menus.forEach(registerGUIRoot);
        else this.menus.forEach(unregisterGUIRoot);
        if (!shown) this.closeMenus();
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
        document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
        this.onMenuStateChange = null;
        this.menus.forEach(unregisterGUIRoot);
        for (const g of this.menus) { try { g.destroy(); } catch (e) { /* best effort */ } }
        this.menus.length = 0;          // nothing is open once the bar is gone
        this.shown = false;
        this.bar.remove();
    }
}

// Does this menu have anything the user would see if it opened? Folders count only when shown,
// because a per-view menu creates its groups up front and hides them until something lands in
// one — otherwise a sitch with no night sky and no video would open a box full of nothing.
function hasVisibleItems(gui) {
    return gui.controllers.some(c => !c._hidden) || gui.folders.some(f => !f._hidden);
}

// The dropdown hangs below the bar with no flip and no scroll of its own, so a view docked low
// in the window would run its menu off the bottom of the screen. Cap it to the space actually
// below the title and let it scroll. Measured per open, because the view moves.
function fitDropdownToWindow(gui) {
    const below = window.innerHeight - gui.$title.getBoundingClientRect().bottom - DROPDOWN_MARGIN_PX;
    gui.$children.style.maxHeight = Math.max(DROPDOWN_MIN_PX, below) + 'px';
    gui.$children.style.overflowY = 'auto';
}

// The clip-path that hides whatever a header's chrome already covers, expressed in the box of
// ONE thing being clipped (clip-path is box-relative). `chrome` is a CUIBar.chromeRect(); `box`
// is a DOMRect in the same page coordinates.
//
// The covered shape is the full-width bar strip plus, when a menu is open, the narrow column of
// the dropdown below it. That shape touches the top edge, so its complement is a plain 6-point
// polygon — no hole, no even-odd rule. With no menu open the column has no width and it
// degenerates to a top inset. Returns "" for a box entirely clear of the chrome.
export function hudClipPath(chrome, box) {
    const strip = Math.round(chrome.barBottom - box.top);
    const deep = Math.round(chrome.bottom - box.top);
    const wide = Math.round(Math.min(chrome.menuRight, box.right) - box.left);
    if (deep <= 0) return "";
    if (wide <= 0 || deep <= strip) return strip > 0 ? `inset(${strip}px 0 0 0)` : "";
    const top = Math.max(0, strip);
    return `polygon(${wide}px ${top}px, 100% ${top}px, 100% 100%, 0 100%, 0 ${deep}px, ${wide}px ${deep}px)`;
}

function section(justify) {
    const d = document.createElement('div');
    d.style.display = 'flex';
    d.style.alignItems = 'center';
    d.style.justifyContent = justify;
    d.style.flex = '0 0 auto';
    return d;
}
