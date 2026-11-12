// UILogging.js
//
// Lightweight, opt-in logging of which menu items the user clicks.
//
// When LOG_UI_INTERACTIONS is enabled (build-time env var, see config/shared.env),
// every mousedown on a lil-gui menu element records {ts, path} where `path` is the
// full slash-separated label hierarchy, e.g. "Camera/Smoothing/Camera Smooth Window".
//
// Events are buffered in memory and flushed to sitrecServer/uilog.php every 10s
// (and on pagehide via sendBeacon). The server appends them, with user id and IP,
// to sitrec-upload/ui-stats/ for later aggregation (admin dashboard "Top 10").
//
// Gating is defence-in-depth: this module no-ops on serverless builds (no PHP) and
// when the client env flag is off, AND uilog.php independently refuses to write when
// its own LOG_UI_INTERACTIONS is off.

import {getEnvBool} from "./envUtils";
import {isServerless, SITREC_SERVER} from "./configUtils";
import {withTestUser} from "./Globals";

const FLUSH_INTERVAL_MS = 10000;   // send to server every 10 seconds
const MAX_BUFFER = 500;            // hard cap so a runaway never grows unbounded
const MAX_PATH_LEN = 300;          // matches server-side sanitization cap

let buffer = [];
let initialized = false;

/**
 * Build the full menu path for a clicked DOM element by walking up the lil-gui
 * structure. Returns a string like "Camera/Smoothing/Camera Smooth Window", or
 * null if the click was not on a recognizable menu element.
 *
 * lil-gui DOM shape (see src/js/lil-gui.esm.js):
 *   <div class="lil-gui">            // a GUI / folder
 *     <button class="title">Camera</button>
 *     <div class="children">
 *       <div class="lil-gui"> ... </div>      // nested folder
 *       <div class="controller"><div class="name">Label</div>...</div>
 *     </div>
 *   </div>
 */
export function buildMenuPath(el) {
    if (!el || !el.closest) return null;

    const parts = [];
    let ancestorStart;   // element from which to begin walking up the folder chain

    const controller = el.closest('.controller');
    if (controller) {
        const nameEl = controller.querySelector(':scope > .name');
        const leaf = (nameEl ? nameEl.textContent : controller.textContent).trim();
        if (leaf) parts.push(leaf);
        ancestorStart = controller.parentElement;
    } else {
        // Maybe a folder/menu header (the .title button) was clicked directly.
        const title = el.closest('.title');
        if (!title) return null;   // not part of the menu system
        const leaf = title.textContent.trim();
        if (leaf) parts.push(leaf);
        // Skip the GUI this title belongs to (already captured) and start above it.
        const ownGui = title.closest('.lil-gui');
        ancestorStart = ownGui ? ownGui.parentElement : title.parentElement;
    }

    // Walk up the ancestor .lil-gui folders, prepending each folder's own title.
    let gui = ancestorStart ? ancestorStart.closest('.lil-gui') : null;
    while (gui) {
        const t = gui.querySelector(':scope > .title');
        if (t) {
            const label = t.textContent.trim();
            if (label) parts.unshift(label);
        }
        gui = gui.parentElement ? gui.parentElement.closest('.lil-gui') : null;
    }

    if (parts.length === 0) return null;
    let path = parts.join('/');
    if (path.length > MAX_PATH_LEN) path = path.slice(0, MAX_PATH_LEN);
    return path;
}

// The label of a native control, as the user sees it.
function panelControlLabel(control) {
    // A row of a native control group has its name in a label element. A Main/Look
    // pair has one name for two checkboxes, so the letter tells them apart.
    const row = control.closest('.native-control');
    if (row) {
        const pair = row.closest('.native-control-pair');
        const name = (pair ?? row).querySelector(':scope > .native-control-label')?.textContent.trim();
        const letter = pair ? row.querySelector('.native-control-letter')?.textContent.trim() : '';
        return [name, letter].filter(Boolean).join(' ') || control.getAttribute('aria-label');
    }
    const text = control.textContent.trim();
    if (control.matches('button, summary, [role="menuitem"]') && text) return text;
    const wrapper = control.closest('label');
    const wrapperText = wrapper ? Array.from(wrapper.childNodes)
        .filter(node => node !== control && !node.contains?.(control)).map(node => node.textContent).join(' ').trim() : '';
    return control.getAttribute('aria-label') || wrapperText || control.getAttribute('placeholder') || control.title || null;
}

/**
 * Build the path for a click in a native panel: a widget, the date and time editor, or a
 * native control group. Returns a string like "Satellite Controls/Time & playback/Edit Start",
 * or null if the click was not on a control of a native panel.
 *
 * Each widget host has its path in `data-widget-path` (see WidgetPanel.createHost). The
 * path is the one of its home, so it stays the same when the widget is in a rail or a float.
 * The date and time editor in the Time menu has no widget; its path starts with the menu.
 */
export function buildPanelPath(el) {
    if (!el || !el.closest) return null;
    const control = el.closest('button, select, input, textarea, summary, [role="menuitem"]');
    if (!control) return null;
    const host = control.closest('[data-widget-path]');
    if (!host && !control.closest('.sitrec-time-editor, .native-controls')) return null;

    const parts = [];
    if (host) parts.push(host.dataset.widgetPath);
    else {
        // No widget: start from the titles of the menus that hold the control.
        for (let gui = control.closest('.lil-gui'); gui; gui = gui.parentElement?.closest('.lil-gui')) {
            const label = gui.querySelector(':scope > .title')?.textContent.trim();
            if (label) parts.unshift(label);
        }
    }
    // A click on a widget title is the widget itself. Other controls add their label.
    if (!control.classList.contains('widget-title')) {
        const label = panelControlLabel(control);
        if (label) parts.push(label);
    }
    if (parts.length === 0) return null;
    return parts.join('/').slice(0, MAX_PATH_LEN);
}

function record(path) {
    if (!path) return;
    if (buffer.length >= MAX_BUFFER) return;   // drop rather than grow unbounded
    buffer.push({ts: Date.now(), path});
}

function onMouseDown(event) {
    record(buildMenuPath(event.target));
}

// Native panels are recorded from pointerdown. Some of their controls (a digit that
// scrubs, a slider) prevent the default action of the pointer, and then the browser
// sends no mousedown. A menu element gives no panel path, so no click is recorded twice.
function onPointerDown(event) {
    if (event.isPrimary === false || event.button > 0) return;
    record(buildPanelPath(event.target));
}

/**
 * Flush the buffer to the server. `useBeacon` uses navigator.sendBeacon for the
 * pagehide/unload case where a normal fetch may be cancelled.
 */
export function flushUILog(useBeacon = false) {
    if (buffer.length === 0) return;

    const events = buffer;
    buffer = [];   // optimistic clear; we accept rare loss on network error

    const url = withTestUser(SITREC_SERVER + "uilog.php");
    const payload = JSON.stringify({events});

    try {
        if (useBeacon && navigator.sendBeacon) {
            // sendBeacon can't set arbitrary headers; send as text/plain, the
            // endpoint reads the raw request body regardless of content-type.
            navigator.sendBeacon(url, new Blob([payload], {type: "text/plain"}));
            return;
        }
        fetch(url, {
            method: "POST",
            mode: "cors",
            headers: {"Content-Type": "application/json"},
            body: payload,
            keepalive: true,
        }).catch(() => { /* logging is best-effort; ignore network errors */ });
    } catch (e) {
        // never let UI logging throw into the app
    }
}

/**
 * Initialize UI interaction logging. Safe to call unconditionally; it no-ops
 * unless LOG_UI_INTERACTIONS is enabled and we are running against a PHP backend.
 */
export function initUILogging() {
    if (initialized) return;
    if (isServerless) return;   // no PHP endpoint to receive logs
    if (!getEnvBool("LOG_UI_INTERACTIONS", process.env.LOG_UI_INTERACTIONS)) return;
    initialized = true;

    // Capture phase so we see the click even if a handler stops propagation.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);

    setInterval(() => flushUILog(false), FLUSH_INTERVAL_MS);

    // Best-effort flush when the page is being hidden/closed.
    window.addEventListener("pagehide", () => flushUILog(true));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushUILog(true);
    });
}
