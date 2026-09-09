// A short-lived message centred at the top of ONE view — the view-local equivalent of a toast.
//
// For telling the user about something that just happened TO A VIEW, at the moment it happened
// and where they are already looking. A dialog (src/showError.js) is the wrong shape for that:
// it is modal, it is global, and it has to be dismissed. This is neither modal nor clickable —
// it says its piece over the viewport and goes away.
//
// One element per view, reused: a second message while the first is still up replaces the text
// and restarts the clock rather than stacking a second box on top of it.

const HOLD_MS = 3000;    // fully visible for this long...
const FADE_MS = 600;     // ...then fades out over this long

/**
 * Show `text` at the top centre of `view`, then fade it out.
 *
 * @param {object} view      a CNodeView (anything with a positioned .div)
 * @param {string} text      the message; plain text, never markup
 * @param {object} [options] {hold, fade} in ms
 * @returns {HTMLElement|null} the message element, or null if there was no view to put it in
 */
export function showViewMessage(view, text, {hold = HOLD_MS, fade = FADE_MS} = {}) {
    const host = view?.div;
    if (!host) return null;

    // Re-parented views (docking, pop-out) get a new div, so an element that is no longer in
    // this view's div is not ours to reuse.
    let el = view._viewMessage;
    if (!el || el.parentElement !== host) {
        el = makeMessageElement();
        host.appendChild(el);
        view._viewMessage = el;
    }

    el.textContent = text;
    clearTimeout(el._viewMessageTimer);

    // Restart from fully opaque with the transition OFF. A message that arrives while the last
    // one is half-faded must not inherit that opacity, and a transition to a value the element
    // already has fires nothing at all — so the reflow between the two writes is load-bearing.
    el.style.transition = 'none';
    el.style.opacity = '1';
    void el.offsetWidth;

    el._viewMessageTimer = setTimeout(() => {
        el.style.transition = `opacity ${fade}ms ease`;
        el.style.opacity = '0';
        // Emptied once it is invisible, so a screen reader reading the live region does not
        // keep finding a message that is no longer on screen.
        el._viewMessageTimer = setTimeout(() => { el.textContent = ''; }, fade);
    }, hold);

    return el;
}

function makeMessageElement() {
    const el = document.createElement('div');
    el.className = 'view-message';
    // A polite live region: announced when it changes, never interrupting whatever else is
    // being read. The text is also the whole content, so no label is needed.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    Object.assign(el.style, {
        position: 'absolute',
        // Clear of the view's header bar, which is an overlay at the very top (src/CUIBar.js)
        // and would otherwise cover this whenever it is pinned or hovered.
        top: 'calc(var(--sitrec-header-h, 26px) + 10px)',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100% - 24px)',
        boxSizing: 'border-box',
        padding: '4px 12px',
        borderRadius: '4px',
        background: 'rgba(0, 0, 0, 0.62)',
        color: 'var(--sitrec-text, #ebebeb)',
        font: '13px sans-serif',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        // Legible over a bright sky as well as over a dark one.
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)',
        // Never in the way of the view it is reporting on: the gesture that triggered the
        // message is often the start of another one.
        pointerEvents: 'none',
        zIndex: '55',            // over the canvas, under the header bar (60)
        opacity: '0',
    });
    return el;
}
