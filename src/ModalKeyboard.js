import {isTextEntry} from "./NativeKeyRouting";

export const MODAL_OPEN_EVENT = "sitrec-modal-open";

const activeModals = [];
const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]';

// Shared by choice dialogs and text prompts. Capture before the application's
// document shortcuts, while leaving native typing and caret movement intact.
export function captureModalKeyboard(modal, {initialFocus, onCancel, onConfirm} = {}) {
    const doc = modal.ownerDocument;
    const win = doc.defaultView;
    const previousFocus = doc.activeElement;
    let lastFocus = initialFocus;
    let disposed = false;
    const entry = {modal, dispose};

    if (!doc.getElementById('sitrec-modal-focus-style')) {
        const style = doc.createElement('style');
        style.id = 'sitrec-modal-focus-style';
        style.textContent = `
            .sitrec-keyboard-modal .sitrec-modal-current {
                outline: 3px solid #39d353 !important;
                outline-offset: 2px !important;
            }
        `;
        doc.head.appendChild(style);
    }
    modal.classList.add('sitrec-keyboard-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.tabIndex = -1;

    const controls = () => [...modal.querySelectorAll(FOCUSABLE)].filter(element =>
        !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden], [inert]')
        && win.getComputedStyle(element).display !== 'none'
        && win.getComputedStyle(element).visibility !== 'hidden');

    function isTop() {
        // A scene reload can remove a dialog without its usual close path.
        // Never leave a detached dialog swallowing the application's keyboard.
        for (const item of [...activeModals]) {
            if (!item.modal.isConnected) item.dispose(false);
        }
        return activeModals.at(-1) === entry;
    }

    function focusControl(element) {
        (element || controls()[0] || modal).focus();
        // Browsers may update activeElement without emitting focusin while
        // the tab/window is inactive. Keep the current option visible anyway.
        if (modal.contains(doc.activeElement)) markCurrent(doc.activeElement);
    }

    function markCurrent(element) {
        lastFocus = element;
        for (const current of modal.querySelectorAll('.sitrec-modal-current')) current.classList.remove('sitrec-modal-current');
        lastFocus.classList.add('sitrec-modal-current');
    }

    function onFocus(event) {
        if (!isTop()) return;
        if (modal.contains(event.target)) {
            markCurrent(event.target);
        }
        else focusControl(controls().includes(lastFocus) ? lastFocus : null);
    }

    function onKey(event) {
        if (!isTop()) return;
        event.stopImmediatePropagation();
        if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return;

        const focused = doc.activeElement;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!event.repeat) onCancel?.();
            return;
        }

        const arrow = event.key.startsWith('Arrow');
        const nativeArrows = focused?.matches('textarea, select, input[type="number"], input[type="range"], input[type="radio"]')
            || focused?.isContentEditable
            || (isTextEntry(focused) && ['ArrowLeft', 'ArrowRight'].includes(event.key));
        if (event.key === 'Tab' || (arrow && !nativeArrows && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)) {
            event.preventDefault();
            const items = controls();
            const backwards = event.key === 'Tab' ? event.shiftKey : ['ArrowUp', 'ArrowLeft'].includes(event.key);
            const index = items.indexOf(focused);
            const next = index < 0 ? (backwards ? items.length - 1 : 0)
                : (index + (backwards ? -1 : 1) + items.length) % items.length;
            focusControl(items[next]);
            return;
        }

        const button = focused?.matches('button, input[type="button"], input[type="submit"]');
        if ((button && (event.key === 'Enter' || event.key === ' '))
            || (event.key === 'Enter' && onConfirm && !focused?.matches('textarea') && !focused?.isContentEditable)) {
            event.preventDefault();
            if (event.repeat) return;
            if (button) focused.click();
            else onConfirm();
        }
    }

    function dispose(restoreFocus = true) {
        if (disposed) return;
        disposed = true;
        const wasTop = activeModals.at(-1) === entry;
        activeModals.splice(activeModals.indexOf(entry), 1);
        for (const type of ['keydown', 'keyup', 'keypress']) win.removeEventListener(type, onKey, true);
        doc.removeEventListener('focusin', onFocus, true);
        if (restoreFocus && wasTop && previousFocus?.isConnected) previousFocus.focus();
    }

    activeModals.push(entry);
    for (const type of ['keydown', 'keyup', 'keypress']) win.addEventListener(type, onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    // Release scene movement keys held when the dialog opened; their keyup now
    // belongs to the dialog and will not reach the scene's keyboard manager.
    doc.dispatchEvent(new win.Event(MODAL_OPEN_EVENT));
    focusControl(controls().includes(initialFocus) ? initialFocus : null);
    return dispose;
}
