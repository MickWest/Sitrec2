import {CUIBar} from "./CUIBar";
import {sharedMenuKey} from "./ViewUIBarMenus";
import {t} from "./i18n";
import {setTooltip} from "./Tooltips";
import {altModifierName, shortcutLabel} from './AltShortcuts';
import {getObjectMoveMode, OBJECT_MOVE_MODES, setObjectMoveMode, subscribeObjectMoveMode} from './ObjectMoveModes';

const HIDE_DELAY_MS = 450;

const SUN_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
</svg>`;
const PIN_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7zm4 12v6"/>
</svg>`;
const MOVE_PLANE_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="#3399ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 7h10l5 11H2zM5.2 11h13.6M3.4 15h17.2M10.3 7 8.7 18M13.7 7l1.6 11"/>
</svg>`;
const PUSH_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="#ffaa33" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m9 15 7-9-3-1 7-3-1 8-2-3-6 10" fill="#dd8822" fill-opacity=".45"/>
    <path d="m13 9-7 8-3-3-1 8 9-2-3-2 7-7" fill="#ffaa33" fill-opacity=".7"/>
</svg>`;
const SURFACE_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true">
    <ellipse cx="12" cy="13" rx="9" ry="4" stroke="#66dd66" fill="#66dd66" fill-opacity=".3"/>
    <path d="M12 2v20m-3-17 3-3 3 3M9 19l3 3 3-3" stroke="#ff7777" stroke-linejoin="round"/>
</svg>`;
const SCREEN_PLANE_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="#bb88ff" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M12 6v12M6 12h12m-9-3 3-3 3 3m-6 6 3 3 3-3M9 9l-3 3 3 3m6-6 3 3-3 3"/>
</svg>`;
const MOVE_ICONS = {surface: SURFACE_ICON, lookCameraPlane: MOVE_PLANE_ICON, push: PUSH_ICON, screenPlane: SCREEN_PLANE_ICON};

// A vertical CUIBar. Its existing action, toggle and slider methods remain the
// tool API; this class only owns the left-edge reveal and pin behavior.
export class CViewToolbar extends CUIBar {
    constructor(view) {
        super(view.div, {vertical: true});
        this.view = view;
        this.pinned = false;
        this.bar.setAttribute('role', 'toolbar');
        this.bar.setAttribute('aria-orientation', 'vertical');
        this.bar.setAttribute('aria-label', t('viewToolbar.label'));
        const pin = this.addPinIcon(() => this.setPinned(!this.pinned));
        pin.innerHTML = PIN_ICON;
        setTooltip(pin, t('viewToolbar.pin'));
        pin.setAttribute('aria-label', t('viewToolbar.pin'));
        this.bar.insertBefore(this.right, this.left);
        this.right.style.borderBottom = '1px solid var(--sitrec-border-area, rgba(255,255,255,0.18))';
        this.right.style.paddingBottom = '3px';

        this.onMenuStateChange = () => {
            if (this.hasOpenMenu()) this.reveal();
            else this.scheduleHide();
        };
        this._onPointerMove = (event) => {
            if (event.buttons) return; // Do not appear while orbiting or dragging the view.
            const rect = this.bar.getBoundingClientRect();
            const host = this.host.getBoundingClientRect();
            const onEdge = event.clientX >= host.left && event.clientX <= rect.right
                && event.clientY >= rect.top && event.clientY <= host.bottom;
            this._pointerOver = (this.bar.contains(event.target) || onEdge)
                && view._headerRevealClear(event.clientX, event.clientY);
            if (this._pointerOver) this.reveal();
            else this.scheduleHide();
        };
        this._onLeave = () => { this._pointerOver = false; this.scheduleHide(); };
        this._onFocusOut = () => queueMicrotask(() => this.scheduleHide());
        this._onFocusIn = () => this.reveal();
        document.addEventListener('pointermove', this._onPointerMove, true);
        this.host.addEventListener('pointerleave', this._onLeave);
        this.host.addEventListener('pointercancel', this._onLeave);
        this.bar.addEventListener('focusin', this._onFocusIn);
        this.bar.addEventListener('focusout', this._onFocusOut);

        // Briefly show new tools so the user can discover where they live.
        this.setPinned(view.toolbarPinned ?? false);
        this.reveal();
        this.scheduleHide(1800);
    }

    reveal() {
        if (this._disposed) return;
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        this.setShown(true);
    }

    scheduleHide(delay = HIDE_DELAY_MS) {
        if (this._disposed || this.pinned || this._pointerOver || this.hasOpenMenu()
            || this.bar.querySelector(':focus-visible') || this._hideTimer) return;
        this._hideTimer = setTimeout(() => {
            this._hideTimer = null;
            if (!this.pinned && !this._pointerOver && !this.hasOpenMenu()
                && !this.bar.querySelector(':focus-visible')) this.setShown(false);
        }, delay);
    }

    setPinned(pinned) {
        this.pinned = !!pinned;
        this.view.toolbarPinned = this.pinned;
        super.setPinned(this.pinned);
        if (this.pinned) this.reveal();
        else this.scheduleHide();
    }

    addMovementPicker() {
        const popup = {open: false};
        const button = this.moveModeButton = this.addIcon('', () => {
            if (popup.open) popup.close();
            else popup.show();
        }, '', 'move-mode', true);
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button._uibarIdleOpacity = '1';
        button.style.opacity = '1';
        this.addMovementPeek();
        const el = popup.el = document.createElement('div');
        el.className = 'view-uibar-popup';
        el.setAttribute('role', 'menu');
        el.setAttribute('aria-label', t('viewToolbar.moveMode'));
        Object.assign(el.style, {position: 'absolute', display: 'none', flexDirection: 'column', gap: '3px',
            minWidth: '190px', padding: '5px', borderRadius: '6px', zIndex: '70', pointerEvents: 'auto',
            background: 'var(--sitrec-bg-header, #303030)', color: 'var(--sitrec-text, #ebebeb)',
            border: '1px solid var(--sitrec-border-area, #555)', boxShadow: '0 3px 12px rgba(0,0,0,.4)'});
        el.addEventListener('pointerdown', event => event.stopPropagation());
        const choices = OBJECT_MOVE_MODES.map(mode => {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitemradio');
            item.dataset.moveMode = mode;
            item.innerHTML = MOVE_ICONS[mode];
            const label = document.createElement('span');
            label.textContent = t(`viewToolbar.moveModes.${mode}.label`);
            item.append(label);
            setTooltip(item, t(`viewToolbar.moveModes.${mode}.tooltip`));
            Object.assign(item.style, {display: 'flex', alignItems: 'center', gap: '9px', padding: '5px 9px',
                color: 'inherit', border: '1px solid transparent', borderRadius: '4px', cursor: 'pointer',
                font: '12px sans-serif', textAlign: 'left'});
            item.addEventListener('click', event => {
                event.stopPropagation();
                setObjectMoveMode(mode, {userAction: true});
                popup.close();
                button.focus();
            });
            el.append(item);
            return item;
        });
        this.bar.append(el);
        popup.show = () => {
            this.closeMenus();
            this.reveal();
            el.style.display = 'flex';
            const bar = this.bar.getBoundingClientRect(), box = button.getBoundingClientRect();
            const host = this.host.getBoundingClientRect();
            const x = Math.max(host.left + 4, Math.min(bar.right + 6, Math.min(host.right, window.innerWidth) - el.offsetWidth - 4));
            const y = Math.max(host.top, Math.min(box.top, Math.min(host.bottom, window.innerHeight) - el.offsetHeight - 4));
            el.style.left = `${x - bar.left}px`;
            el.style.top = `${y - bar.top}px`;
            popup.open = true;
            button.setAttribute('aria-expanded', 'true');
            this.onMenuStateChange?.();
            choices[OBJECT_MOVE_MODES.indexOf(getObjectMoveMode())].focus();
        };
        popup.close = () => {
            el.style.display = 'none';
            popup.open = false;
            button.setAttribute('aria-expanded', 'false');
            this.onMenuStateChange?.();
        };
        el.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); popup.close(); button.focus();
            } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                const index = choices.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
                choices[next].focus();
            }
        });
        const unsubscribe = subscribeObjectMoveMode(mode => {
            const label = `${t('viewToolbar.moveMode')}: ${t(`viewToolbar.moveModes.${mode}.label`)}`;
            const tooltip = `${label}. ${t('viewToolbar.moveModeTooltip', {
                shortcut: shortcutLabel('M', {required: true}), modifier: altModifierName(undefined, {short: true}),
            })}`;
            for (const icon of [button, this.moveModePeek]) {
                icon.innerHTML = MOVE_ICONS[mode];
                icon.setAttribute('aria-label', label);
                icon.dataset.moveMode = mode;
                setTooltip(icon, tooltip);
            }
            for (const item of choices) {
                const selected = item.dataset.moveMode === mode;
                item.setAttribute('aria-checked', String(selected));
                item.style.background = selected ? 'var(--sitrec-hover, #505050)' : 'transparent';
                item.style.borderColor = selected ? 'var(--sitrec-border, #888)' : 'transparent';
            }
            this._syncPeeks();
        });
        popup.dispose = () => { unsubscribe(); popup.close(); };
        (this._popups ??= []).push(popup);
    }

    addMovementPeek() {
        const button = this.moveModeButton;
        this.moveModePeek = this._addPeek(button, button.innerHTML, () => !!this._altHeld, () => button.click());
        this.moveModePeek.dataset.uibarAction = 'move-mode-peek';
        this.moveModePeek.setAttribute('aria-haspopup', 'menu');
        this._onAltPeek = event => this.setAltHeld(event.altKey);
        this._onAltPeekBlur = () => this.setAltHeld(false);
        this._onAltPeekResize = () => this._syncPeeks(true);
        document.addEventListener('keydown', this._onAltPeek, true);
        document.addEventListener('keyup', this._onAltPeek, true);
        document.addEventListener('pointermove', this._onAltPeek, true);
        window.addEventListener('blur', this._onAltPeekBlur);
        window.addEventListener('resize', this._onAltPeekResize);
    }

    setAltHeld(held) {
        if (this._disposed || this._altHeld === !!held) return;
        this._altHeld = !!held;
        this._syncPeeks(true);
    }

    _syncPeeks(reposition = false) {
        super._syncPeeks(reposition);
        // This peek opens a menu, rather than being a pressed toggle itself.
        this.moveModePeek?.removeAttribute('aria-pressed');
        this.moveModePeek?.setAttribute('aria-expanded', this.moveModeButton.getAttribute('aria-expanded'));
    }

    setShown(shown) {
        super.setShown(shown);
        // A faded toolbar must not leave invisible buttons over the canvas.
        this.bar.inert = !this.shown;
    }

    dispose() {
        this._disposed = true;
        clearTimeout(this._hideTimer);
        document.removeEventListener('pointermove', this._onPointerMove, true);
        this.host.removeEventListener('pointerleave', this._onLeave);
        this.host.removeEventListener('pointercancel', this._onLeave);
        this.bar.removeEventListener('focusin', this._onFocusIn);
        this.bar.removeEventListener('focusout', this._onFocusOut);
        document.removeEventListener('keydown', this._onAltPeek, true);
        document.removeEventListener('keyup', this._onAltPeek, true);
        document.removeEventListener('pointermove', this._onAltPeek, true);
        window.removeEventListener('blur', this._onAltPeekBlur);
        window.removeEventListener('resize', this._onAltPeekResize);
        super.dispose();
    }
}

export function createMainViewToolbar(view) {
    const bar = new CViewToolbar(view);
    bar.addSliderIcon(sharedMenuKey('ambientIntensity'), {
        html: SUN_ICON, action: 'ambient-light', toggle: false,
        label: t('viewMenus.ambientIntensity'), tooltip: t('viewToolbar.ambientTooltip'),
    });
    bar.addMovementPicker();
    return bar;
}

export function createLookViewToolbar(view) {
    const bar = new CViewToolbar(view);
    bar.addMovementPicker();
    return bar;
}
