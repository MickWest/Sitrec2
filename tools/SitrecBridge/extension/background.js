/**
 * SitrecBridge — Background Service Worker
 *
 * Connects to one or more MCP servers (each on its own port in 9780-9799) and
 * relays commands to/from Sitrec tabs. Each MCP server advertises a
 * `pairedOrigin` (e.g., "http://localhost:8081") on connect; the extension
 * routes that server's commands to the matching tab. Servers without a paired
 * origin (host fallback) handle any tab not claimed by another server.
 */

const MCP_PORT_MIN = 9780;
const MCP_PORT_MAX = 9799;
const KEEPALIVE_ALARM_NAME = "sitrec-bridge-keepalive";
const KEEPALIVE_ALARM_PERIOD_MIN = 0.5; // 30 seconds, minimum Chrome allows
const FALLBACK_PRUNE_DELAY_MS = 750;
// While the worker is awake and a Sitrec tab is open, look for servers far more often than the
// 30-second alarm floor. Bridges now release and re-acquire ports on demand, so a port can appear
// at any moment and a 30-second discovery lag would show up as a failed first tool call.
const FAST_RESCAN_MS = 4000;

// -- Persistent diagnostics -------------------------------------------------
// The service worker console is wiped every time Chrome kills the worker — which is exactly the
// event worth investigating. chrome.storage.local survives, so the log lives there and is readable
// later through the sitrec_diagnostics tool.

const WORKER_STARTED_AT = Date.now();
const DIAG_KEY = "sitrecBridgeDiagLog";
const DIAG_MAX = 300;
let diagQueue = Promise.resolve();

function diag(event, fields = {}) {
    const entry = {t: Date.now(), ts: new Date().toISOString(), event, ...fields};
    console.log(`[SitrecBridge:diag] ${event}`, fields);
    diagQueue = diagQueue.then(async () => {
        try {
            const stored = await chrome.storage.local.get(DIAG_KEY);
            const log = Array.isArray(stored[DIAG_KEY]) ? stored[DIAG_KEY] : [];
            log.push(entry);
            await chrome.storage.local.set({[DIAG_KEY]: log.slice(-DIAG_MAX)});
        } catch {
            // Storage failures must never break the bridge.
        }
    });
}

async function readDiagLog(limit = 100) {
    try {
        const stored = await chrome.storage.local.get(DIAG_KEY);
        const log = Array.isArray(stored[DIAG_KEY]) ? stored[DIAG_KEY] : [];
        return log.slice(-Math.max(1, limit));
    } catch (e) {
        return [{event: "diag-read-failed", error: e.message}];
    }
}

// Connection state, keyed by port number.
//   { ws, pairedOrigin, serverPid, sourceVersion, port, cwd, startedAt, lastSeenAt, localComputeCapabilities }
const connections = new Map();

// Tabs we know are running Sitrec, keyed by Chrome tab ID.
//   { url, origin, buildDir }
const knownSitrecTabs = new Map();

let currentCommand = null;       // Currently executing MCP command
let commandHistory = [];
const MAX_HISTORY = 8;
let preferredFallbackPort = null;
let fallbackPruneTimer = null;
let lastScanSignature = null;

// -- URL helpers ------------------------------------------------------------

function tabOrigin(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

function isSitrecUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const path = parsed.pathname || "/";
        // On the public metabunk host, only /sitrec* paths are Sitrec.
        if (host === "www.metabunk.org") {
            return path.startsWith("/sitrec");
        }
        return (
            host === "local.metabunk.org" ||
            host === "localhost" ||
            host === "127.0.0.1"
        );
    } catch {
        return false;
    }
}

// -- Connection management --------------------------------------------------

async function hasPortListener(port) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 400);
    try {
        // A plain HTTP request to a WebSocket server normally gets a non-2xx
        // response, but it still proves something is listening. Closed ports
        // fail quietly here, avoiding Chrome's noisy WebSocket refusal logs.
        await fetch(`http://127.0.0.1:${port}/`, {
            mode: "no-cors",
            cache: "no-store",
            signal: controller.signal,
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

async function probePort(port) {
    if (!await hasPortListener(port)) return false;

    return new Promise((resolve) => {
        let settled = false;
        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch (e) {
            console.warn(`[SitrecBridge:${port}] WebSocket constructor threw:`, e.message);
            resolve(false);
            return;
        }
        const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch {}
            resolve(false);
        }, 1500);
        ws.onopen = () => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            console.log(`[SitrecBridge:${port}] probe OPEN`);
            resolve(ws);
        };
        ws.onerror = (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            console.warn(`[SitrecBridge:${port}] probe error`, e?.message || e);
            resolve(false);
        };
    });
}

async function connectToPort(port) {
    const existing = connections.get(port);
    if (existing && existing.ws && (existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN)) {
        return;
    }

    const ws = await probePort(port);
    if (!ws) {
        if (connections.has(port) && !connections.get(port).ws) {
            connections.delete(port);
        }
        return;
    }

    const conn = {
        ws,
        pairedOrigin: null,
        serverPid: null,
        sourceVersion: null,
        cwd: null,
        startedAt: null,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        localComputeCapabilities: null,
        port,
    };
    connections.set(port, conn);

    // Always force-replace any existing extension socket on the bridge side.
    // Each MCP is origin-paired so there's no legitimate "competing extension"
    // scenario — only stale/zombie sockets from a suspended service worker.
    // Sending this immediately skips the bridge's 2-second liveness probe.
    try { ws.send(JSON.stringify({ type: "force-extension" })); } catch {}

    ws.onmessage = async (event) => {
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === "rejected") {
                console.warn(`[SitrecBridge:${port}] Server rejected (unexpected — force should have replaced): ${msg.reason || ""}`);
                try { ws.close(); } catch {}
                updatePopupState();
                return;
            }

            if (msg.type === "version-info") {
                conn.sourceVersion = msg.sourceVersion || null;
                conn.serverPid = msg.serverPid || null;
                conn.pairedOrigin = msg.pairedOrigin || null;
                conn.cwd = msg.cwd || null;
                conn.startedAt = msg.startedAt || null;
                conn.localComputeCapabilities = msg.localComputeCapabilities || null;
                conn.lastSeenAt = Date.now();
                console.log(`[SitrecBridge:${port}] Connected — pairedOrigin=${conn.pairedOrigin || "(fallback)"} pid=${conn.serverPid}`);
                diag("connected", {port, pid: conn.serverPid, pairedOrigin: conn.pairedOrigin, cwd: conn.cwd});
                if (!conn.pairedOrigin) scheduleFallbackPrune();
                updatePopupState();
                return;
            }

            // The server's application-level keepalive. Receiving this message is what resets the
            // MV3 idle timer — a WebSocket protocol ping frame is answered by Chrome's network
            // stack and never wakes this script. Replying keeps the timer reset at both ends.
            if (msg.type === "server-ping") {
                conn.lastSeenAt = Date.now();
                try { ws.send(JSON.stringify({type: "server-pong", t: msg.t})); } catch {}
                return;
            }

            if (msg.type === "pong") {
                conn.serverPid = msg.serverPid || conn.serverPid;
                if (msg.pairedOrigin !== undefined) conn.pairedOrigin = msg.pairedOrigin;
                conn.cwd = msg.cwd || conn.cwd;
                conn.startedAt = msg.startedAt || conn.startedAt;
                conn.localComputeCapabilities = msg.localComputeCapabilities || conn.localComputeCapabilities;
                conn.lastSeenAt = Date.now();
                if (!conn.pairedOrigin) scheduleFallbackPrune();
                updatePopupState();
                return;
            }

            await handleServerMessage(port, msg);
        } catch (e) {
            console.error(`[SitrecBridge:${port}] Error handling message:`, e);
        }
    };

    ws.onclose = () => {
        // Only clear the map entry if it still points at *this* ws. When we
        // force-replace a stale socket, the old ws's close fires AFTER the new
        // ws has already taken its slot — deleting unconditionally would untrack
        // the live connection and trigger an infinite reconnect loop.
        if (connections.get(port)?.ws === ws) {
            console.log(`[SitrecBridge:${port}] Disconnected`);
            // connectedAt, not startedAt: how long THIS socket lasted is the number that reveals
            // service-worker churn. startedAt is the server process's birthday.
            diag("disconnected", {port, pid: conn.serverPid, connectionAliveMs: Date.now() - conn.connectedAt});
            connections.delete(port);
            if (preferredFallbackPort === port) preferredFallbackPort = null;
            updatePopupState();
        } else {
            console.log(`[SitrecBridge:${port}] Stale socket closed (replaced)`);
        }
    };

    ws.onerror = () => {
        // onclose will follow
    };
}

async function scanForServers() {
    const probes = [];
    for (let port = MCP_PORT_MIN; port <= MCP_PORT_MAX; port++) {
        if (connections.has(port)) continue;
        probes.push(connectToPort(port));
    }
    await Promise.all(probes);
    scheduleFallbackPrune();

    // The fast rescan runs every few seconds, so only speak up when the picture actually changes.
    const found = [...connections.keys()].sort((a, b) => a - b).join(",");
    if (found !== lastScanSignature) {
        lastScanSignature = found;
        console.log(`[SitrecBridge] scan complete — connected ports: ${found || "(none)"}`);
        updatePopupState();
    }
}

function fallbackRank(conn) {
    // Prefer the server that most recently handled a command. Otherwise prefer
    // the newest server process; this is usually the currently opened agent
    // session after a cleanup/reconnect.
    if (preferredFallbackPort && conn.port === preferredFallbackPort) return Number.MAX_SAFE_INTEGER;
    return Number(conn.startedAt || conn.lastSeenAt || 0);
}

function pruneFallbackConnections() {
    const fallbackConns = [...connections.values()].filter((conn) =>
        !conn.pairedOrigin &&
        (conn.serverPid || conn.sourceVersion || conn.startedAt) &&
        conn.ws &&
        (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)
    );

    if (fallbackConns.length === 0) return;

    fallbackConns.sort((a, b) => {
        const byRank = fallbackRank(b) - fallbackRank(a);
        return byRank || b.port - a.port;
    });

    const keep = fallbackConns[0];
    const changed = preferredFallbackPort !== keep.port;
    preferredFallbackPort = keep.port;

    // Tell every fallback server whether it is the one we route to. A server that is NOT the
    // active fallback is free to release its port back to the pool; the active one must keep its
    // port, because the Sitrec page discovers Local Compute by scanning the range directly, with
    // no MCP call involved. Exactly one bridge is always told active:true, so the range is never
    // left empty.
    for (const conn of fallbackConns) {
        announceRole(conn, conn.port === keep.port);
    }

    if (fallbackConns.length > 1) {
        console.log(`[SitrecBridge] Active host-fallback connection is :${keep.port}; ${fallbackConns.length - 1} duplicate fallback connection(s) kept idle`);
    }
    if (changed) diag("active-fallback", {port: keep.port, pid: keep.serverPid, of: fallbackConns.length});
}

function announceRole(conn, active) {
    if (conn.announcedActive === active) return;
    conn.announcedActive = active;
    try {
        conn.ws.send(JSON.stringify({type: "role", active}));
    } catch {
        conn.announcedActive = null; // retry on the next prune
    }
}

function scheduleFallbackPrune() {
    if (fallbackPruneTimer) clearTimeout(fallbackPruneTimer);
    fallbackPruneTimer = setTimeout(() => {
        fallbackPruneTimer = null;
        pruneFallbackConnections();
        updatePopupState();
    }, FALLBACK_PRUNE_DELAY_MS);
}

function sendToServer(port, msg) {
    const conn = connections.get(port);
    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify(msg));
    }
}

// -- Tab tracking -----------------------------------------------------------

function rememberTab(tabId, url) {
    if (!isSitrecUrl(url)) return false;
    const existing = knownSitrecTabs.get(tabId) || {};
    knownSitrecTabs.set(tabId, {
        ...existing,
        url,
        origin: tabOrigin(url),
        buildDir: existing.buildDir || null,
    });
    return true;
}

async function refreshKnownTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        const seen = new Set();
        for (const tab of tabs) {
            if (rememberTab(tab.id, tab.url)) seen.add(tab.id);
        }
        // Drop entries for tabs that no longer exist or no longer match
        for (const tabId of [...knownSitrecTabs.keys()]) {
            if (!seen.has(tabId)) knownSitrecTabs.delete(tabId);
        }
    } catch {}
}

/**
 * Find the best tab for an incoming MCP request.
 *  - Sandbox MCP (pairedOrigin set) → only tabs at that origin
 *  - Host fallback MCP (pairedOrigin null) → tabs whose origin isn't claimed
 *    by any sandbox connection
 *  - Optional explicit `tabTarget` (numeric ID or URL substring) takes priority
 *  - Optional `cwd` hint disambiguates among multiple matches via buildDir
 */
async function findTabForRequest(port, tabTarget, cwd) {
    const conn = connections.get(port);
    const pairedOrigin = conn ? conn.pairedOrigin : null;

    // Refresh URLs so origin matching is accurate
    await refreshKnownTabs();

    // Explicit target takes priority
    if (tabTarget != null) {
        // A tab ID can arrive as a number or as a numeric string (JSON-RPC clients
        // are free to send either, and the schema accepts both). Try the ID reading
        // FIRST for anything all-digits: treating "78797930" as a URL substring
        // silently matched nothing — or, worse, could match some unrelated tab whose
        // URL happens to contain those digits — and the caller had no way to tell
        // that its explicit target had been reinterpreted.
        const asId = typeof tabTarget === "number" ? tabTarget
            : (/^\d+$/.test(String(tabTarget).trim()) ? Number(String(tabTarget).trim()) : null);
        if (asId !== null) {
            try {
                const tab = await chrome.tabs.get(asId);
                if (isSitrecUrl(tab.url)) {
                    rememberTab(tab.id, tab.url);
                    return tab.id;
                }
            } catch {}
            // Not a live Sitrec tab. A numeric STRING may still have been meant as a
            // URL substring (sitch URLs contain digits, e.g. the user id in
            // "?custom=99999999/..."), so fall through to substring matching for
            // those. A real number was unambiguously an ID: give up so the caller
            // gets the closed-tab error instead of a silent match elsewhere.
            if (typeof tabTarget === "number") return null;
        }
        const needle = String(tabTarget).toLowerCase();
        for (const [tabId, info] of knownSitrecTabs) {
            if (info.url && info.url.toLowerCase().includes(needle)) return tabId;
        }
        return null;
    }

    // Origin-paired routing
    const claimedOrigins = new Set();
    for (const c of connections.values()) {
        if (c.pairedOrigin) claimedOrigins.add(c.pairedOrigin);
    }

    let candidates = [];
    if (pairedOrigin) {
        for (const [tabId, info] of knownSitrecTabs) {
            if (info.origin === pairedOrigin) candidates.push(tabId);
        }
    } else {
        // Fallback: any tab whose origin isn't claimed by another (sandbox) MCP
        for (const [tabId, info] of knownSitrecTabs) {
            if (!claimedOrigins.has(info.origin)) candidates.push(tabId);
        }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // cwd hint: prefer a tab whose buildDir matches
    if (cwd) {
        for (const tabId of candidates) {
            const info = knownSitrecTabs.get(tabId);
            if (info && info.buildDir && info.buildDir === cwd) return tabId;
        }
    }
    return candidates[0];
}

async function findAllSitrecTabs() {
    await refreshKnownTabs();
    const results = [];
    for (const [tabId, info] of knownSitrecTabs) {
        results.push({ id: tabId, url: info.url || "", origin: info.origin, buildDir: info.buildDir || null });
    }
    return results;
}

// -- Command tracking -------------------------------------------------------

function commandDetail(action, params) {
    if (!params) return "";
    switch (action) {
        case "sitrec_eval":
            return (params.expression || params.code || "").slice(0, 80).replace(/\n/g, " ");
        case "sitrec_api_call":
            return params.function || "";
        case "sitrec_load_sitch":
            return params.name || "";
        case "sitrec_get_node":
            return params.id || "";
        case "sitrec_list_nodes":
            return params.filter || params.type || "";
        case "sitrec_set_frame":
            return `frame ${params.frame}`;
        case "sitrec_screenshot":
            return params.fullWindow ? "full window" : "canvas";
        default:
            return "";
    }
}

function trackCommandStart(action, params, cwd, tabId, port) {
    currentCommand = {
        action,
        detail: commandDetail(action, params),
        startTime: Date.now(),
        cwd: cwd || null,
        tabId: tabId || null,
        port: port || null,
    };
    updatePopupState();
}

function trackCommandEnd(ok) {
    if (currentCommand) {
        commandHistory.unshift({ ...currentCommand, endTime: Date.now(), ok });
        if (commandHistory.length > MAX_HISTORY) commandHistory.pop();
    }
    currentCommand = null;
    updatePopupState();
}

// -- Handle server messages -------------------------------------------------

async function handleServerMessage(port, msg) {
    const { id, action, params, _cwd } = msg;
    const conn = connections.get(port);
    if (conn && !conn.pairedOrigin) {
        preferredFallbackPort = port;
        scheduleFallbackPrune();
    }

    if (action === "reload") {
        trackCommandStart(action, params, _cwd, null, port);
        sendToServer(port, { id, result: { ok: true, reloading: true } });
        trackCommandEnd(true);
        setTimeout(() => chrome.runtime.reload(), 100);
        return;
    }

    if (action === "sitrec_list_tabs") {
        trackCommandStart(action, params, _cwd, null, port);
        const tabs = await findAllSitrecTabs();
        sendToServer(port, { id, result: tabs });
        trackCommandEnd(true);
        return;
    }

    // Diagnostics: hand back the persisted worker log plus the live connection picture. Answered
    // without touching a tab, so it still works when no Sitrec page is loaded.
    if (action === "sitrec_diag_log") {
        sendToServer(port, {
            id,
            result: {
                installedVersion: chrome.runtime.getManifest().version,
                workerStartedAt: WORKER_STARTED_AT,
                workerAliveMs: Date.now() - WORKER_STARTED_AT,
                connections: [...connections.values()].map((c) => ({
                    port: c.port,
                    serverPid: c.serverPid,
                    pairedOrigin: c.pairedOrigin,
                    cwd: c.cwd,
                    active: c.port === preferredFallbackPort,
                    readyState: c.ws?.readyState ?? null,
                })),
                knownTabs: [...knownSitrecTabs.entries()].map(([tabId, info]) => ({
                    tabId, url: info.url, buildDir: info.buildDir || null,
                })),
                commandHistory,
                events: await readDiagLog(params?.limit ?? 100),
            },
        });
        return;
    }

    if (action === "sitrec_reload_tab") {
        const target = params?.tab;
        if (params?.tab !== undefined) delete params.tab;
        const tabId = await findTabForRequest(port, target, _cwd);
        trackCommandStart(action, params, _cwd, tabId, port);
        if (!tabId) {
            sendToServer(port, { id, error: await noTabError(port, target) });
            trackCommandEnd(false);
            return;
        }
        try {
            await chrome.tabs.reload(tabId);
            sendToServer(port, { id, result: { ok: true, reloading: true, tabId } });
            trackCommandEnd(true);
        } catch (e) {
            sendToServer(port, { id, error: `Tab reload failed: ${e.message}` });
            trackCommandEnd(false);
        }
        return;
    }

    // Full-page screenshot via chrome.tabs.captureVisibleTab
    if (action === "sitrec_screenshot" && params?.view === "page") {
        const target = params?.tab;
        if (params?.tab !== undefined) delete params.tab;
        const tabId = await findTabForRequest(port, target, _cwd);
        trackCommandStart(action, params, _cwd, tabId, port);
        if (!tabId) {
            sendToServer(port, { id, error: await noTabError(port, target) });
            trackCommandEnd(false);
            return;
        }
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab.active) {
                await chrome.tabs.update(tabId, { active: true });
                await new Promise(r => setTimeout(r, 250));
            }

            const usePng = params.quality === "png";
            const format = usePng ? "png" : "jpeg";
            const quality = usePng ? undefined : Math.min(100, Math.max(1, Number(params.quality) || 75));
            const mimeType = usePng ? "image/png" : "image/jpeg";

            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
            let imageData = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");

            if (params.maxWidth) {
                const maxW = Number(params.maxWidth);
                const blob = await (await fetch(dataUrl)).blob();
                const bitmap = await createImageBitmap(blob);
                if (bitmap.width > maxW) {
                    const scale = maxW / bitmap.width;
                    const w = Math.round(bitmap.width * scale);
                    const h = Math.round(bitmap.height * scale);
                    const oc = new OffscreenCanvas(w, h);
                    oc.getContext("2d").drawImage(bitmap, 0, 0, w, h);
                    const resizedBlob = await oc.convertToBlob({
                        type: mimeType,
                        quality: usePng ? undefined : quality / 100,
                    });
                    const buf = await resizedBlob.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    const CHUNK = 0x8000;
                    let binary = "";
                    for (let i = 0; i < bytes.length; i += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                    }
                    imageData = btoa(binary);
                }
                bitmap.close();
            }

            sendToServer(port, { id, result: { imageData, mimeType } });
            trackCommandEnd(true);
        } catch (e) {
            sendToServer(port, { id, error: `Page capture failed: ${e.message}` });
            trackCommandEnd(false);
        }
        return;
    }

    // Default path: relay to content script in the matched tab
    const target = params?.tab;
    if (params?.tab !== undefined) delete params.tab;

    const tabId = await findTabForRequest(port, target, _cwd);

    trackCommandStart(action, params, _cwd, tabId, port);

    if (!tabId) {
        sendToServer(port, { id, error: await noTabError(port, target) });
        trackCommandEnd(false);
        return;
    }

    try {
        const result = await chrome.tabs.sendMessage(tabId, { action, params });
        sendToServer(port, { id, result });
        trackCommandEnd(true);
    } catch {
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
            const result = await chrome.tabs.sendMessage(tabId, { action, params });
            sendToServer(port, { id, result });
            trackCommandEnd(true);
        } catch (e2) {
            sendToServer(port, { id, error: `Failed to communicate with Sitrec tab: ${e2.message}` });
            trackCommandEnd(false);
        }
    }
}

async function noTabError(port, target) {
    const conn = connections.get(port);
    const paired = conn?.pairedOrigin;
    if (target !== undefined && target !== null && target !== "") {
        // A numeric target that no longer resolves is almost always a tab that was
        // closed: Chrome tab IDs are per-session and a caller holding one from
        // earlier in a long session has no way to know it went stale. Say so
        // explicitly — "no tab found matching 123" reads like a bad argument and
        // sends the caller looking in the wrong place.
        const numeric = typeof target === "number" ? target
            : (/^\d+$/.test(String(target)) ? Number(target) : null);
        if (numeric !== null) {
            let closed = true;
            let existingUrl = null;
            try {
                const tab = await chrome.tabs.get(numeric);
                closed = false;
                existingUrl = tab.url || "";
            } catch {}
            if (closed) {
                return `Tab ${numeric} no longer exists — it was almost certainly closed. ` +
                    `Chrome tab IDs are not stable across a session, so an ID captured earlier ` +
                    `can go stale. Run sitrec_list_tabs for current IDs. ` +
                    `(Refusing to fall back to another tab: that would answer from the wrong page.)`;
            }
            return `Tab ${numeric} exists but is not a Sitrec tab (url: ${existingUrl}), ` +
                `and no Sitrec tab's URL contains "${target}" either. ` +
                `Run sitrec_list_tabs to see the Sitrec tabs.`;
        }
        return `No Sitrec tab found matching "${target}". Use sitrec_list_tabs to see available tabs.`;
    }
    if (paired) {
        return `No Sitrec tab open at ${paired}. Open one in your browser and retry.`;
    }
    return "No Sitrec tab found. Please open Sitrec in a browser tab.";
}

// -- Local Compute popup actions -------------------------------------------

function liveLocalComputeConnections() {
    return [...connections.values()].filter((conn) =>
        conn.ws &&
        conn.ws.readyState === WebSocket.OPEN &&
        conn.localComputeCapabilities?.localComputeInstall
    );
}

function chooseLocalComputeConnection(origin) {
    const candidates = liveLocalComputeConnections();
    if (candidates.length === 0) return null;

    if (origin) {
        const paired = candidates.find((conn) => conn.pairedOrigin === origin);
        if (paired) return paired;

        const fallback = candidates.find((conn) => !conn.pairedOrigin);
        if (fallback) return fallback;
    }

    return candidates.sort((a, b) => fallbackRank(b) - fallbackRank(a) || b.port - a.port)[0];
}

function sendLocalComputePopupProgress(port, progress) {
    chrome.runtime.sendMessage({
        type: "localComputeInstallProgress",
        port,
        progress,
    }).catch(() => {});
}

function runLocalComputeRequestOnPort(port, action, params = {}) {
    return new Promise((resolve, reject) => {
        const id = `extension-${action}-${Date.now()}`;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch {}
            reject(new Error(`Local Compute ${action} timed out`));
        }, 10 * 60 * 1000);

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch {}
            fn(value);
        };

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: "local-compute-client",
                origin: chrome.runtime.getURL(""),
                userAgent: self.navigator?.userAgent || "SitrecBridge extension",
            }));
        };

        ws.onerror = () => {
            finish(reject, new Error(`Could not connect to Local Compute on port ${port}`));
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            if (msg.type === "local-compute-hello") {
                ws.send(JSON.stringify({
                    type: "local-compute-request",
                    id,
                    action,
                    params,
                }));
                return;
            }

            if (msg.type === "local-compute-progress") {
                sendLocalComputePopupProgress(port, msg.progress || {});
                return;
            }

            if (msg.type === "local-compute-response") {
                if (msg.id !== id) return;
                if (msg.ok) {
                    finish(resolve, msg.result);
                } else {
                    finish(reject, new Error(msg.error || "Local Compute request failed"));
                }
            }

            if (msg.type === "local-compute-error") {
                finish(reject, new Error(msg.error || "Local Compute rejected connection"));
            }
        };
    });
}

// -- Tab change tracking ----------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" || changeInfo.url) {
        if (isSitrecUrl(tab.url)) {
            rememberTab(tabId, tab.url);
            // A new Sitrec tab may need a new MCP connection — scan in case
            // the user just spun up a new sandbox.
            scanForServers();
        } else {
            knownSitrecTabs.delete(tabId);
        }
        updatePopupState();
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    knownSitrecTabs.delete(tabId);
    updatePopupState();
});

// -- Keep-Alive: persistent port from content scripts -----------------------

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "sitrec-keepalive") return;

    const tabId = port.sender?.tab?.id;
    const url = port.sender?.tab?.url;
    if (tabId && url) rememberTab(tabId, url);

    port.onMessage.addListener((msg) => {
        if (msg.type === "metadata" && tabId && knownSitrecTabs.has(tabId)) {
            const info = knownSitrecTabs.get(tabId);
            if (msg.buildDir) info.buildDir = msg.buildDir;
        }
        // The heartbeat's job is simply to arrive — an incoming port message is what resets
        // Chrome's 30-second suspend timer. Re-registering the tab costs nothing and repairs the
        // known-tab map if this message is the first thing a restarted worker hears.
        if (msg.type === "heartbeat" && tabId && url) {
            rememberTab(tabId, url);
        }
    });

    scanForServers();
    updatePopupState();

    port.onDisconnect.addListener(() => {
        if (tabId) knownSitrecTabs.delete(tabId);
        updatePopupState();
    });
});

// -- Keep-Alive: alarm fallback ---------------------------------------------

chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_ALARM_PERIOD_MIN });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    await refreshKnownTabs();
    if (knownSitrecTabs.size > 0) {
        await scanForServers();
    }
    // Send a ping on every open connection so the server keeps the worker awake
    for (const [, conn] of connections) {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            try { conn.ws.send(JSON.stringify({ type: "ping" })); } catch {}
        }
    }
});

// -- Keep-Alive: fast rescan while awake ------------------------------------
// The alarm can only fire every 30 seconds, which is Chrome's floor. That is the right cadence for
// waking a dead worker, but far too slow for noticing a bridge that has just re-acquired a port.
// While the worker is alive, poll much more often. This interval dies with the worker, which is
// fine — the alarm brings it back.

let fastRescanTimer = null;

function startFastRescan() {
    if (fastRescanTimer) return;
    fastRescanTimer = setInterval(async () => {
        if (knownSitrecTabs.size === 0) return;
        const before = connections.size;
        await scanForServers();
        if (connections.size !== before) {
            diag("rescan-change", {before, after: connections.size});
        }
    }, FAST_RESCAN_MS);
}

startFastRescan();

// -- Popup communication ----------------------------------------------------

function buildPopupState() {
    const installedVersion = chrome.runtime.getManifest().version;
    const tabList = [];
    for (const [tabId, info] of knownSitrecTabs) {
        tabList.push({ id: tabId, url: info.url || "", origin: info.origin, buildDir: info.buildDir || null });
    }
    const connList = [];
    pruneFallbackConnections();
    for (const [port, conn] of connections) {
        if (!conn.pairedOrigin && preferredFallbackPort && port !== preferredFallbackPort) {
            continue;
        }
        connList.push({
            port,
            pairedOrigin: conn.pairedOrigin,
            serverPid: conn.serverPid,
            sourceVersion: conn.sourceVersion,
            cwd: conn.cwd,
            startedAt: conn.startedAt,
            lastSeenAt: conn.lastSeenAt,
            localComputeCapabilities: conn.localComputeCapabilities || null,
            connected: !!(conn.ws && conn.ws.readyState === WebSocket.OPEN),
        });
    }
    connList.sort((a, b) => {
        if (!!a.pairedOrigin !== !!b.pairedOrigin) return a.pairedOrigin ? -1 : 1;
        return b.port - a.port;
    });
    return {
        connections: connList,
        knownTabs: tabList,
        installedVersion,
        currentCommand,
        commandHistory,
        localComputeAvailable: liveLocalComputeConnections().length > 0,
    };
}

function updatePopupState() {
    chrome.runtime.sendMessage({ type: "stateUpdate", ...buildPopupState() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "getState") {
        refreshKnownTabs().then(() => sendResponse(buildPopupState()));
        return true;
    }

    if (msg.type === "reconnect") {
        // Drop all connections and force a fresh scan
        for (const [, conn] of connections) {
            try { conn.ws?.close(); } catch {}
        }
        connections.clear();
        scanForServers().then(() => sendResponse({ ok: true }));
        return true;
    }

    if (msg.type === "reload") {
        sendResponse({ ok: true, reloading: true });
        setTimeout(() => chrome.runtime.reload(), 100);
        return false;
    }

    if (msg.type === "closeOtherTabs") {
        // Close every known Sitrec tab except the one the user is keeping
        // (the active tab when the popup was opened). We deliberately only
        // touch tabs in knownSitrecTabs so unrelated tabs (email, docs, etc.)
        // are never closed. chrome.tabs.remove works regardless of how a tab
        // was opened, so there's no need to ask pages to window.close()
        // themselves.
        const keepId = msg.keepTabId;
        (async () => {
            await refreshKnownTabs();
            const toClose = [...knownSitrecTabs.keys()].filter((id) => id !== keepId);
            let closed = 0;
            for (const id of toClose) {
                try {
                    await chrome.tabs.remove(id);
                    closed++;
                } catch (e) {
                    console.warn(`[SitrecBridge] Failed to close tab #${id}: ${e.message}`);
                }
            }
            // onRemoved already prunes knownSitrecTabs and pushes a stateUpdate,
            // but refresh once more in case any remove() raced the listener.
            await refreshKnownTabs();
            updatePopupState();
            sendResponse({ ok: true, closed, kept: keepId ?? null });
        })();
        return true;
    }

    if (msg.type === "installLocalCompute") {
        (async () => {
            const conn = chooseLocalComputeConnection(msg.origin || null);
            if (!conn) {
                sendResponse({
                    ok: false,
                    error: "No connected SitrecBridge server supports Local Compute install/update. Update or restart SitrecBridge first.",
                });
                return;
            }

            trackCommandStart("local_compute_install", {}, conn.cwd, null, conn.port);
            try {
                const result = await runLocalComputeRequestOnPort(conn.port, "local_compute_install", {});
                trackCommandEnd(true);
                sendResponse({ok: true, port: conn.port, result});
            } catch (e) {
                trackCommandEnd(false);
                sendResponse({ok: false, port: conn.port, error: e.message});
            }
        })();
        return true;
    }
});

// -- Initialize -------------------------------------------------------------

(async function init() {
    // Every one of these lines is a worker restart. A burst of them in the log is the signature of
    // the service worker being repeatedly killed and revived — the thing that used to make the
    // bridge feel like it needed constant reconnecting.
    diag("worker-start", {version: chrome.runtime.getManifest().version});
    await refreshKnownTabs();
    if (knownSitrecTabs.size > 0) {
        await scanForServers();
    }
})();
