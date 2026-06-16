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

function onMouseDown(event) {
    const path = buildMenuPath(event.target);
    if (!path) return;
    if (buffer.length >= MAX_BUFFER) return;   // drop rather than grow unbounded
    buffer.push({ts: Date.now(), path});
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

    setInterval(() => flushUILog(false), FLUSH_INTERVAL_MS);

    // Best-effort flush when the page is being hidden/closed.
    window.addEventListener("pagehide", () => flushUILog(true));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushUILog(true);
    });
}
