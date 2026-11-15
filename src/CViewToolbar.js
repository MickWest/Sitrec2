import {CUIBar} from "./CUIBar";
import {sharedMenuKey} from "./ViewUIBarMenus";
import {t} from "./i18n";
import {setTooltip} from "./Tooltips";

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
        super.dispose();
    }
}

export function createMainViewToolbar(view) {
    const bar = new CViewToolbar(view);
    bar.addSliderIcon(sharedMenuKey('ambientIntensity'), {
        html: SUN_ICON, action: 'ambient-light', toggle: false,
        label: t('viewMenus.ambientIntensity'), tooltip: t('viewToolbar.ambientTooltip'),
    });
    return bar;
}
