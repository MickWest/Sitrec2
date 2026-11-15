// Styled tooltips for the view header and toolbar buttons (CUIBar).
//
// These buttons keep their text in data-tooltip, with an empty title to suppress native
// tooltips (including inherited titles). Menu items keep the browser's own tooltips.

// How long the pointer must rest on a button before its tooltip appears.
export const TOOLTIP_DELAY_MS = 1500;

// Once a tooltip has been shown, moving to another button within this window shows the
// next one with no delay at all. This is the usual desktop-UI behavior, and it is what
// actually makes the bar feel fast when you scan along its row of buttons.
export const TOOLTIP_WARM_MS = 600;

// The elements that get the styled tooltip: CUIBar's icon buttons, and the "peek" copies of
// them that stand in while the bar is hidden.
const TOOLTIP_SELECTOR = ".view-uibar-icon, .view-uibar-peek";

let tipEl = null;
let showTimer = null;
let coolTimer = null;
let warm = false;               // true = the next tooltip appears immediately

let hostEl = null;              // the hovered button
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

// Use this for every update, including mirrored controls repainted during a hover.
export function setTooltip(el, text) {
    const value = text ?? "";
    if (el.dataset.tooltip !== value) el.dataset.tooltip = value;
    if (el.getAttribute("title") !== "") el.setAttribute("title", "");
    if (el === hostEl && hostText !== value) {
        hostText = value;
        if (addedAria) el.setAttribute("aria-label", value);
        if (!value) hide();
        else if (tipEl?.classList.contains("visible")) {
            tipEl.textContent = value;
            position();
        }
    }
}

function activate(el) {
    hostEl = el;
    hostText = el.dataset.tooltip;
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) {
        el.setAttribute("aria-label", hostText);
        addedAria = true;
    }
}

function deactivate() {
    if (hostEl !== null) {
        if (addedAria) hostEl.removeAttribute("aria-label");
    }
    hostEl = null;
    hostText = "";
    addedAria = false;
}

// The header-bar button under `node`, if it has a tooltip to show.
function findHost(node) {
    const el = (node && node.closest) ? node.closest(TOOLTIP_SELECTOR) : null;
    if (el === null) return null;
    return el.dataset.tooltip?.trim() ? el : null;
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
    deactivate();
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
    activate(el);
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
