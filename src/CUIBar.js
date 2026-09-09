import GUI from "./js/lil-gui.esm";
import {Globals} from "./Globals";
import {registerGUIRoot, unregisterGUIRoot} from "./GUIRootRegistry";

// Everything on a bar that is a thing in its own right rather than backdrop. A menu SLOT (not
// the lil-gui root inside it) because the slot is the tab's box; the dropdown hangs outside it
// and below the strip, so it never widens this.
const BAR_HIT_TARGETS = '.view-uibar-menuslot, .view-uibar-icon, .view-uibar-label';

// How long a button with a double action waits before committing to the single one. A double
// click always delivers its two clicks FIRST, so a button that has both has no way to know which
// it is looking at until the window closes. Only such buttons pay the delay.
const DOUBLE_CLICK_MS = 250;

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
 *   - addControlIcon(key, ...)  — an icon bound to a control that lives elsewhere (see below).
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

        // Left section (title menu + extra menus, then the view's own icons), elastic spacer,
        // right section (window chrome).
        this.left = section('flex-start');
        // The left side may SHRINK; the right side may not. A narrow view cannot fit a dozen
        // toggle icons, and if something has to give it must not be the close button.
        this.left.style.flex = '0 1 auto';
        this.left.style.minWidth = '0';
        // The icons live in their own box, which is the thing that clips — `left` itself must
        // not, because the title menu's dropdown is a descendant of it that deliberately paints
        // outside the strip. Clipped icons are still reachable: every one of them is also a row
        // in the menu right beside them (src/ViewUIBarMenus.js).
        this.leftIcons = section('flex-start');
        this.leftIcons.style.flex = '0 1 auto';
        this.leftIcons.style.minWidth = '0';
        this.leftIcons.style.overflow = 'hidden';
        this.left.appendChild(this.leftIcons);
        this.spacer = document.createElement('div');
        this.spacer.style.flex = '1 1 auto';
        this.spacer.style.minWidth = '0';
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
        this.left.insertBefore(slot, this.leftIcons);

        const gui = new GUI({ container: slot, autoPlace: false, title, closeFolders: false });
        gui.domElement.style.position = 'relative';
        gui.domElement.style.pointerEvents = 'auto';
        // Fit the title to its TEXT, not lil-gui's fixed 245px default width. The left/right bar
        // sections are flex:0 0 auto (don't shrink), so a 245px title overflows a narrow view and
        // shoves the icons off the right edge; max-content lets the icons abut the title instead.
        // (The dropdown is absolute with its own width, so it's unaffected.)
        gui.domElement.style.width = 'max-content';
        gui.close();

        // Float the dropdown BELOW the title (absolute) so OPENING the menu doesn't push the
        // title (or the rest of the bar) around, and the dropdown isn't constrained by the
        // bar height. Interacting with the dropdown ITEMS must NOT start a header drag.
        gui.$children.style.position = 'absolute';
        gui.$children.style.top = '100%';
        gui.$children.style.left = '0';
        // Same width as the docked menu-bar dropdowns, from the same source: lil-gui sizes a
        // root with `width: var(--width, 245px)` and the main menus take that default. Here the
        // root box is title-fit (above), so the dropdown asks for the width itself instead of
        // inheriting it — content-fitting made every header menu a different width.
        gui.$children.style.width = 'var(--width, 245px)';
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
    // onDoubleClick: an optional second, blunter action. Giving one makes the SINGLE click wait
    //   DOUBLE_CLICK_MS to find out which it was — see the constant.
    addIcon(html, onClick, tooltip, action, left = false, onDoubleClick = null) {
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
        btn.addEventListener('pointerenter', () => { btn._uibarHover = true; btn.style.opacity = '1'; });
        btn.addEventListener('pointerleave', () => { btn._uibarHover = false; btn.style.opacity = idleOpacity(btn); });
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        let pending = null;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!onDoubleClick) { onClick?.(e); return; }
            if (pending) return;                    // the second of a pair; dblclick takes it
            pending = setTimeout(() => { pending = null; onClick?.(); }, DOUBLE_CLICK_MS);
        });
        if (onDoubleClick) {
            btn.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (pending) { clearTimeout(pending); pending = null; }
                onDoubleClick(e);
            });
        }
        (left ? this.leftIcons : this.right).appendChild(btn);
        this.icons.push(btn);
        return btn;
    }

    // An icon bound to a control that lives somewhere ELSE — the Show menu's "Lines of Sight",
    // the sky overlay's "Star Names", the View menu's "Video Zoom %". It is not a second
    // control: it mirrors the same slot as the header-menu row beside it (src/MenuMirror.js),
    // so the flag, the global menu row, the header row and the icon are four faces of one
    // value, and nothing downstream can tell which of them the user clicked.
    //
    // Two shapes, from one option:
    //   no `value`  — a TOGGLE. Clicking inverts a boolean; the icon lights when it is true.
    //   with `value`— a SNAP, and still a toggle: the first press remembers where the control
    //                 was and moves it to `value`; the next press puts it back where it was.
    //                 The icon lights while the control is at `value`, so "100%" also reads as
    //                 "am I at 1:1?". Pressing it twice must leave the view exactly as it was
    //                 found — which is why the old value is remembered rather than assumed.
    //
    // `doubleKey` names a second, mirrored ACTION control to run on a DOUBLE click — the blunt
    // version of what the single click does ("really, all of them, off"). It is mirrored like
    // everything else here, so it is a real control with a real label somewhere in the menus,
    // not a gesture that only exists on this button.
    //
    // Bound through a real (hidden) TWIN rather than by reading the source directly, because a
    // twin is what MenuMirror already keeps correct on every path into the value: a click on
    // any other copy, a rename, a hide — and, since a twin inherits the source's `.listen()`
    // and this host is a polled GUI root while the bar is up (src/GUIRootRegistry.js), a sitch
    // load, the API or a script writing the value with no controller involved at all.
    //
    // Hidden until its source exists, so a sitch with no lines of sight simply has no LOS icon,
    // and it disappears again if that control is hidden or destroyed.
    addControlIcon(key, {html, action, label, tooltip, value, doubleKey, left = true} = {}) {
        let twin = null;                       // filled in by the mirror, possibly much later
        let doubleTwin = null;
        let restore;                           // where a snap icon found the control
        const click = () => {
            if (!twin) return;
            if (value === undefined) return twin.setValue(!twin.getValue());
            if (twin.getValue() !== value) {
                restore = twin.getValue();
                twin.setValue(value);
            } else if (restore !== undefined) {
                twin.setValue(restore);
            }
            // Already at `value` with nothing remembered: the control is where the button would
            // put it and there is nowhere to go back to, so the press does nothing.
        };
        // A lil-gui function controller IS its bound function, so running it is calling that.
        const doublePress = doubleKey
            ? () => doubleTwin?.object?.[doubleTwin.property]?.()
            : null;
        const btn = this.addIcon(html, click, null, action, left, doublePress);
        btn.style.display = 'none';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        // One height for all of them, so the "on" highlight is the same band whether the icon
        // is a 15px drawing or an 11px line of text. WIDTH is left to the content: an icon that
        // says "100%" is wider than the bar is tall, which is the point of writing it out.
        btn.style.height = '18px';
        // Tighter than the text chrome icons on the right, so a row of them packs.
        btn.style.padding = '0 3px';
        this._toggleHost().addMirror(key, {
            // A new source means a different control (a sitch change, a video reloaded): what
            // the last one was set to is not somewhere to send this one back to.
            onMirror: (t) => {
                restore = undefined;
                bindControlIcon(btn, twin = t, {value, label, tooltip});
            },
        });
        if (doubleKey) this._toggleHost().addMirror(doubleKey, {onMirror: (t) => { doubleTwin = t; }});
        return btn;
    }

    // One icon over MANY mirrored controls: "Declutter" turns off every overlay this view draws
    // and, pressed again, puts back exactly the ones that were on. It cannot be an addControlIcon
    // because there is no single control behind it — but each of its targets is one, so it works
    // the same way, through the same twins, and stays right when any of them is changed
    // elsewhere.
    //
    // It lights when the group is CLEAR (every target off), which is the state the button puts
    // you in — so a lit Declutter reads as "this view is decluttered", not "press me".
    //
    // Targets that this sitch does not have are skipped rather than counted as "already off":
    // otherwise a sitch with no night sky and no compass would show Declutter lit before anyone
    // touched it.
    addGroupIcon(keys, {html, action, tooltip, left = true} = {}) {
        const twins = new Map();               // key -> twin, as each source turns up
        let restore = null;                    // what was on when the group was last cleared

        const live = () => [...twins].filter(([, twin]) => !twin._hidden);
        const clear = () => live().every(([, twin]) => !twin.getValue());
        const repaint = () => {
            const targets = live();
            btn.style.display = targets.length ? 'flex' : 'none';
            paintIcon(btn, targets.length > 0 && clear());
        };

        const click = () => {
            const targets = live();
            if (!targets.length) return;
            if (clear()) {
                if (!restore) return;           // already clear, nothing to come back to
                for (const [key, twin] of targets) {
                    const was = restore.get(key);
                    if (was !== undefined && twin.getValue() !== was) twin.setValue(was);
                }
            } else {
                restore = new Map(targets.map(([key, twin]) => [key, twin.getValue()]));
                for (const [, twin] of targets) if (twin.getValue()) twin.setValue(false);
            }
            repaint();
        };

        const btn = this.addIcon(html, click, tooltip, action, left);
        btn.style.display = 'none';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.height = '18px';
        btn.style.padding = '0 3px';
        for (const key of keys) {
            this._toggleHost().addMirror(key, {
                onMirror: (twin) => {
                    twins.set(key, twin);
                    andThen(twin, 'updateDisplay', repaint);
                    andThen(twin, 'show', repaint);
                    andThen(twin, 'destroy', () => { twins.delete(key); repaint(); });
                    repaint();
                },
            });
        }
        return btn;
    }

    // A hairline between two groups of things on the bar — the view's MENU and the view's
    // TOGGLES read as different kinds of control, and abutting them makes the first icon look
    // like part of the title.
    addSeparator(left = false) {
        const el = document.createElement('div');
        el.className = 'view-uibar-sep';
        Object.assign(el.style, {
            width: '1px', alignSelf: 'center', height: '60%', margin: '0 4px',
            background: 'var(--sitrec-border-area, rgba(255,255,255,0.18))',
            pointerEvents: 'none', flex: '0 0 auto',
        });
        (left ? this.leftIcons : this.right).appendChild(el);
        return el;
    }

    // The hidden lil-gui that owns those twins. A real GUI because the mirror registry deals in
    // lil-gui controllers, and a real controller is what carries the `.listen()` polling. Never
    // shown — the icons ARE its display — and deliberately NOT in `this.menus`, which is the
    // list of things the bar treats as openable tabs.
    _toggleHost() {
        if (!this._toggleGui) {
            const slot = document.createElement('div');
            slot.style.display = 'none';
            this.bar.appendChild(slot);
            this._toggleGui = new GUI({container: slot, autoPlace: false, title: ''});
            if (this.shown) registerGUIRoot(this._toggleGui);
        }
        return this._toggleGui;
    }

    // Is (x, y) on the BLANK part of this bar — inside the strip, but clear of everything on it
    // that is itself clickable? The menu tab, the toggle icons and the window chrome all have
    // their own jobs, and a double-click landing on one must do that job (or nothing) rather
    // than the strip's own action of toggling fullscreen. The fullscreen icon is the one
    // exception, because that IS the strip's action: a double-click there is two toggles, which
    // is how a button behaves.
    //
    // Tested by RECT rather than by an event's target, so the answer does not depend on whether
    // the bar happens to be taking pointer events at that instant — a hover-revealed bar is
    // mid-fade at exactly the moment a caller asks.
    isBlankAt(x, y) {
        const strip = this.bar.getBoundingClientRect();
        if (x < strip.left || x > strip.right || y < strip.top || y > strip.bottom) return false;
        for (const el of this.bar.querySelectorAll(BAR_HIT_TARGETS)) {
            if (el.dataset.uibarAction === 'fullscreen') continue;
            const r = el.getBoundingClientRect();
            // An icon whose control does not exist in this sitch is display:none, which measures
            // 0x0 AT THE PAGE ORIGIN — not where it would have been. Left in, it would claim the
            // top-left pixel of a view docked at (0, 0).
            if (r.width === 0 || r.height === 0) continue;
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return false;
        }
        return true;
    }

    // A read-only strip of text in the bar. Not an icon and not a menu: it reports state
    // rather than offering an action, so it takes no pointer events and no hover styling —
    // clicking it should do nothing rather than look broken.
    addLabel(text, tooltip, action, left = false) {
        const el = document.createElement('span');
        el.className = 'view-uibar-label';
        el.textContent = text ?? '';
        if (tooltip) el.title = tooltip;
        if (action) el.dataset.uibarAction = action;
        Object.assign(el.style, {
            display: 'flex', alignItems: 'center', padding: '0 6px',
            font: '11px sans-serif', opacity: '0.6', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%',
            pointerEvents: 'none', userSelect: 'none',
        });
        (left ? this.leftIcons : this.right).appendChild(el);
        return el;
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
        if (this._toggleGui) {
            // Same argument for the icons' hidden twins — plus one repaint on the way in: they
            // are only polled while the bar is up, and lil-gui compares against a value cached
            // from before it went away, so the first frame back would otherwise paint stale
            // state.
            if (shown) { registerGUIRoot(this._toggleGui); refreshToggleIcons(this._toggleGui); }
            else unregisterGUIRoot(this._toggleGui);
        }
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
        if (this._toggleGui) {
            unregisterGUIRoot(this._toggleGui);
            try { this._toggleGui.destroy(); } catch (e) { /* best effort */ }
            this._toggleGui = null;
        }
        this.shown = false;
        this.bar.remove();
    }
}

// What an icon fades back to when the pointer leaves it. A toggle icon owns its idle level (that
// is how "on" reads at a glance); everything else uses the pin's convention.
function idleOpacity(btn) {
    return btn._uibarIdleOpacity ?? (btn.dataset.uibarPinned === 'true' ? '1' : '0.7');
}

// Wire one icon to its twin. Everything the icon shows is READ FROM the twin — value, label,
// tooltip, whether it exists at all — so there is no second copy of any of it to fall out of
// step, and a source that is renamed, hidden or replaced takes its icon with it.
// How an icon shows that its control is on: lit and coloured, or dim and drained. The colour is
// half the message — the red lines of sight and the cyan frustum say what they are, and taking
// that away says which of them are actually being drawn, with no second badge to read.
function paintIcon(btn, on) {
    btn._uibarIdleOpacity = on ? '1' : '0.4';
    btn.style.opacity = btn._uibarHover ? '1' : btn._uibarIdleOpacity;
    btn.style.background = on ? 'var(--sitrec-hover, #4f4f4f)' : 'transparent';
    btn.style.filter = on ? 'none' : 'grayscale(1)';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function bindControlIcon(btn, twin, {value, label, tooltip} = {}) {
    const paint = () => paintIcon(btn,
        value === undefined ? !!twin.getValue() : twin.getValue() === value);
    const showHide = () => { btn.style.display = twin._hidden ? 'none' : 'flex'; };

    // A toggle icon is the shorthand for exactly one control, so it borrows that control's
    // explanation rather than inventing a third wording to translate. The NAME comes from the
    // caller when it has one — the menu row's short label — because some controls are named for
    // their internals ("compassMain"), which is no use over a button. A SNAP icon does something
    // the control's own label does not describe ("Video Zoom %" is not what a 100% button does),
    // so those bring their own line and use it for both.
    const name = tooltip ?? label ?? twin._name ?? '';
    btn.title = tooltip ?? (twin._tooltip ? `${name} — ${twin._tooltip}` : name);
    if (name) btn.setAttribute('aria-label', name);

    // updateDisplay is the one call every path into the value ends at, so it is the one place
    // the icon has to repaint from.
    andThen(twin, 'updateDisplay', paint);
    andThen(twin, 'show', showHide);
    andThen(twin, 'destroy', () => { btn.style.display = 'none'; });
    showHide();
    paint();
}

// Run `after` whenever `method` is called on `controller`, keeping the original behaviour and
// its return value.
function andThen(controller, method, after) {
    const inherited = controller[method].bind(controller);
    controller[method] = (...args) => {
        const result = inherited(...args);
        after();
        return result;
    };
}

// Repaint every icon from its bound value, defeating lil-gui's "unchanged since last time"
// guard — used when the bar reappears after a spell of not being polled.
function refreshToggleIcons(gui) {
    for (const controller of gui.controllers) {
        controller._lastDisplayedValue = undefined;
        controller.updateDisplay();
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
