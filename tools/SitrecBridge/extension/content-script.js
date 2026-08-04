/**
 * SitrecBridge -- Content Script
 *
 * Runs in the content script isolated world on Sitrec pages.
 * Bridges between the background service worker (via chrome.runtime messages)
 * and the page-bridge.js script (via window.postMessage).
 *
 * Content scripts can't access page JS globals directly (window.NodeMan, etc.),
 * so page-bridge.js is injected into the page's main world to do the actual work.
 */

// Guard against duplicate execution in the same isolated-world context.
// After an extension reload, Chrome creates a fresh content-script context, so
// this flag resets naturally and allows the bridge to re-handshake.
const CONTENT_BOOT_KEY = "__sitrecBridgeContentBooted";
if (globalThis[CONTENT_BOOT_KEY]) {
    console.log("[SitrecBridge:content] Already running in this tab context, skipping");
} else {
globalThis[CONTENT_BOOT_KEY] = true;

// Nonce for authenticating the postMessage channel between content script and page bridge.
// Generated per injection; lives only in the content script's isolated world, so page
// scripts cannot read it directly.  The nonce is sent to page-bridge once via postMessage
// after the module loads; both sides then require it on every subsequent message.
let bridgeNonce = null;
const PAGE_BRIDGE_MARKER_ID = "sitrec-bridge-injected";

// Inject the page-bridge script into the main world
(function injectPageBridge() {
    bridgeNonce = crypto.randomUUID();
    const sendNonce = () => {
        console.log("[SitrecBridge:content] Sending nonce to page bridge");
        window.postMessage({ source: "sitrec-bridge-init", nonce: bridgeNonce }, "*");
    };

    const marker = document.getElementById(PAGE_BRIDGE_MARKER_ID);
    console.log("[SitrecBridge:content] Injecting page-bridge on", window.location.href);

    // Mark that a page-bridge script has been inserted into the page.
    if (!marker) {
        const newMarker = document.createElement("div");
        newMarker.id = PAGE_BRIDGE_MARKER_ID;
        newMarker.style.display = "none";
        document.documentElement.appendChild(newMarker);
    }

    const script = document.createElement("script");
    // Cache-bust so a fresh page-bridge instance is evaluated after extension
    // reloads, even if an older copy is still present in the page.
    script.src = chrome.runtime.getURL("page-bridge.js") + "?nonce=" + encodeURIComponent(bridgeNonce);
    script.type = "module";
    // After the module evaluates and sets up its listener, send the nonce
    script.addEventListener("load", () => {
        console.log("[SitrecBridge:content] page-bridge.js loaded");
        sendNonce();
    });
    script.addEventListener("error", (e) => {
        console.error("[SitrecBridge:content] Failed to load page-bridge.js:", e);
    });
    document.documentElement.appendChild(script);
})();

// -- Keep-Alive Port --------------------------------------------------------
// Opening a long-lived port to the background service worker prevents Chrome
// from suspending it (MV3 service worker lifecycle). The port stays open as
// long as this content script is alive (i.e., the Sitrec tab is open).
//
// The keepalive is only opened AFTER page-bridge.js confirms that Sitrec is
// actually running on this page.  This lets the manifest use broad localhost
// match patterns without falsely registering non-Sitrec tabs.

let keepalivePort = null;
let sitrecDetected = false;
let sitrecBuildDir = null;
let keepaliveRetryDelay = 1000;
const MAX_KEEPALIVE_RETRY_DELAY = 30000;
// Chrome suspends an MV3 service worker after 30 seconds of inactivity. Merely HAVING a port open
// does not count as activity — only traffic over it does. The port used to carry one metadata
// message and then fall silent, so the worker died on schedule, taking every MCP WebSocket with
// it. A message every 20 seconds keeps the worker resident for as long as a Sitrec tab is open.
const KEEPALIVE_HEARTBEAT_MS = 20000;
let heartbeatTimer = null;

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
        if (!keepalivePort) return;
        try {
            keepalivePort.postMessage({ type: "heartbeat" });
        } catch {
            // Port died under us; onDisconnect handles reconnection.
        }
    }, KEEPALIVE_HEARTBEAT_MS);
}

function openKeepalivePort() {
    try {
        keepalivePort = chrome.runtime.connect({ name: "sitrec-keepalive" });
        keepaliveRetryDelay = 1000; // Reset backoff on successful connect
        // Send build directory metadata so background can match MCP sessions to tabs
        if (sitrecBuildDir) {
            keepalivePort.postMessage({ type: "metadata", buildDir: sitrecBuildDir });
        }
        startHeartbeat();
        keepalivePort.onDisconnect.addListener(() => {
            keepalivePort = null;
            // Service worker may have restarted -- reconnect with backoff
            if (sitrecDetected) {
                setTimeout(openKeepalivePort, keepaliveRetryDelay);
                keepaliveRetryDelay = Math.min(keepaliveRetryDelay * 1.5, MAX_KEEPALIVE_RETRY_DELAY);
            }
        });
    } catch {
        // Extension context invalidated (e.g., extension was reloaded) — retry with backoff
        keepalivePort = null;
        if (sitrecDetected) {
            setTimeout(openKeepalivePort, keepaliveRetryDelay);
            keepaliveRetryDelay = Math.min(keepaliveRetryDelay * 1.5, MAX_KEEPALIVE_RETRY_DELAY);
        }
    }
}

// Wait for page-bridge to confirm Sitrec is present before registering
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source === "sitrec-bridge-page" && event.data.type === "sitrec-detected") {
        if (event.data.nonce !== bridgeNonce) {
            console.warn("[SitrecBridge:content] sitrec-detected nonce mismatch — ignoring");
            return;
        }
        if (!sitrecDetected) {
            const pageType = event.data.pageType || "sitrec";
            console.log("[SitrecBridge:content] " + pageType + " detected, opening keepalive port");
            sitrecDetected = true;
            sitrecBuildDir = event.data.buildDir || null;
            openKeepalivePort();
        }
    }
});

// -- Message relay: background <-> page-bridge ------------------------------

// Pending requests from the background, waiting for page-bridge responses
const pendingPageRequests = new Map();
let pageRequestCounter = 0;

/**
 * Handle messages from the background service worker.
 * Forward the action to page-bridge.js via window.postMessage.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const { action, params } = msg;
    if (!action) return false;

    const reqId = ++pageRequestCounter;

    // Set up a timeout
    const timer = setTimeout(() => {
        pendingPageRequests.delete(reqId);
        sendResponse({ error: "Timed out waiting for Sitrec page response" });
    }, 12000);

    pendingPageRequests.set(reqId, { sendResponse, timer });

    // Forward to page-bridge.js in the main world
    window.postMessage(
        {
            source: "sitrec-bridge-content",
            nonce: bridgeNonce,
            reqId,
            action,
            params,
        },
        "*"
    );

    return true; // async sendResponse
});

/**
 * Handle responses from page-bridge.js in the main world.
 */
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "sitrec-bridge-page") return;
    if (event.data.nonce !== bridgeNonce) return; // reject unverified messages

    const { reqId, result, error, asserts } = event.data;
    const pending = pendingPageRequests.get(reqId);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingPageRequests.delete(reqId);

    if (error) {
        const response = { error };
        if (asserts) response.asserts = asserts;
        pending.sendResponse(response);
    } else {
        const response = result != null && typeof result === "object" ? result : { result };
        if (asserts) response.asserts = asserts;
        pending.sendResponse(response);
    }
});

} // end double-injection guard
