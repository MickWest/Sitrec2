// Faster tooltips for the view header-bar buttons (CUIBar).
//
// Sitrec's tooltips are all plain `title` attributes — Controller.prototype.tooltip in
// lil-gui-extras.js sets domElement.title, and the hand-built panels write title="..."
// inline. The delay before a NATIVE tooltip appears belongs to the browser (about a
// second in Chrome) and no CSS property or JS setting can shorten it. The only lever is
// to suppress the native tooltip and draw our own.
//
// That is done ONLY for the header-bar buttons: glyphs with no words, where the tooltip is
// the only way to learn what a button does. Everything else, menu items included, keeps
// the browser's own tooltip.
//
// One delegated listener borrows the hovered button's `title` (removing the attribute is
// what stops the browser drawing its own), shows a styled div after TOOLTIP_DELAY_MS, and
// hands the attribute back on the way out.

// How long the pointer must rest on a button before its tooltip appears.
export const TOOLTIP_DELAY_MS = 250;

// Once a tooltip has been shown, moving to another button within this window shows the
// next one with no delay at all. This is the usual desktop-UI behavior, and it is what
// actually makes the bar feel fast when you scan along its row of buttons.
export const TOOLTIP_WARM_MS = 600;

// The elements that get the fast tooltip: CUIBar's icon buttons, and the "peek" copies of
// them that stand in while the bar is hidden.
const FAST_TOOLTIP_SELECTOR = ".view-uibar-icon, .view-uibar-peek";

let tipEl = null;
let showTimer = null;
let coolTimer = null;
let warm = false;               // true = the next tooltip appears immediately

let hostEl = null;              // the element whose title we have borrowed
let hostText = "";
let addedAria = false;          // true if the aria-label below is ours to remove

let mouseX = 0;
let mouseY = 0;

let installed = false;

function ensureTip() {
    if (tipEl === null) {
        tipEl = document.createElement("div");
        tipEl.className = "sitrec-tooltip";
        tipEl.setAttribute("role", "tooltip");
    }
    return tipEl;
}

// Take the title off the element so the browser will not draw its own tooltip. The
// attribute is also the element's accessible name, so stand in for it while it is gone.
function borrow(el, text) {
    hostEl = el;
    hostText = text;
    el.removeAttribute("title");
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
        el.setAttribute("aria-label", text);
        addedAria = true;
    }
}

function giveBack() {
    if (hostEl !== null) {
        // Only restore if nothing has set a title in the meantime: a toggle button can swap
        // its own title as it changes state, and that newer text must win.
        if (!hostEl.hasAttribute("title")) hostEl.setAttribute("title", hostText);
        if (addedAria) hostEl.removeAttribute("aria-label");
    }
    hostEl = null;
    hostText = "";
    addedAria = false;
}

// The header-bar button under `node`, if it has a tooltip to show.
function findHost(node) {
    const el = (node && node.closest) ? node.closest(FAST_TOOLTIP_SELECTOR) : null;
    if (el === null) return null;
    // The button whose title we borrowed has none while its tip is up; it is still the host.
    if (el === hostEl) return el;
    const title = el.getAttribute("title");
    return (title !== null && title.trim() !== "") ? el : null;
}

function position() {
    const tip = ensureTip();
    const pad = 6;
    const offX = 14;
    const offY = 18;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = mouseX + offX;
    let y = mouseY + offY;
    // Flip to the other side of the cursor rather than let the tip hang off the edge.
    if (x + w + pad > window.innerWidth) x = Math.max(pad, mouseX - offX - w);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, mouseY - offY - h);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
}

function show() {
    showTimer = null;
    if (hostEl === null || hostText === "" || !hostEl.isConnected) return;
    const tip = ensureTip();
    tip.textContent = hostText;
    // A fullscreen element renders only its own subtree, so a tip parented to <body>
    // would be invisible while a graph panel is fullscreen.
    const root = document.fullscreenElement ?? document.body;
    if (tip.parentNode !== root) root.appendChild(tip);
    // Lay out at the natural size first, then place it — position() measures the tip.
    tip.classList.add("visible");
    position();
    warm = true;
}

function hide() {
    if (showTimer !== null) {
        clearTimeout(showTimer);
        showTimer = null;
    }
    giveBack();
    if (tipEl !== null) tipEl.classList.remove("visible");
    if (warm) {
        if (coolTimer !== null) clearTimeout(coolTimer);
        coolTimer = setTimeout(() => {
            coolTimer = null;
            warm = false;
        }, TOOLTIP_WARM_MS);
    }
}

// A click, a keypress or a scroll means the user is doing something, not reading. Drop
// the warm window too, so the next hover waits the full delay again.
function dismiss() {
    warm = false;
    if (coolTimer !== null) {
        clearTimeout(coolTimer);
        coolTimer = null;
    }
    hide();
}

function onOver(e) {
    const el = findHost(e.target);
    if (el === hostEl) return;
    hide();
    if (el === null) return;
    borrow(el, el.getAttribute("title"));
    if (warm) show();
    else showTimer = setTimeout(show, TOOLTIP_DELAY_MS);
}

function onMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    // A bar is torn down with its view, so the host can vanish with no mouseout to tell
    // us. Without this the tooltip would sit there until the next hover.
    if (hostEl !== null && !hostEl.isConnected) hide();
}

export function initTooltips() {
    if (installed) return;
    installed = true;

    // Capture phase: some views stop propagation on their own pointer handling.
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousemove", onMove, {capture: true, passive: true});
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("wheel", dismiss, {capture: true, passive: true});
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("mouseleave", hide, false);
    document.addEventListener("visibilitychange", dismiss, false);
    window.addEventListener("blur", dismiss, false);
    // Leaving fullscreen moves the tip's parent out from under it.
    document.addEventListener("fullscreenchange", dismiss, false);
}
