#!/usr/bin/env node
/**
 * SitrecBridge MCP Server
 *
 * Bridges MCP clients (Claude Code, Claude Desktop, etc.) to a running Sitrec
 * instance in Chrome via a WebSocket relay to the SitrecBridge Chrome extension.
 *
 * Architecture:
 *   MCP Client <--stdio--> This Server <--WebSocket--> Chrome Extension <--message--> Sitrec Page
 *
 * Multi-sandbox isolation:
 *   Every MCP server runs as its own WebSocket primary on a unique port.
 *   - Sandbox mode (SITREC_BRIDGE_PAIRED_ORIGIN set, e.g. http://localhost:8081):
 *       binds to SITREC_BRIDGE_PORT (the container's internal port; the host-side
 *       port is forwarded by `wt sandbox`). The extension routes any tab whose
 *       origin matches PAIRED_ORIGIN to this server.
 *   - Host fallback mode (PAIRED_ORIGIN unset): scans 9799→9780 for the first
 *       free port (descending so it never steals a sandbox's reserved low port),
 *       advertises pairedOrigin=null. The extension routes any tab not matched
 *       by another MCP to a fallback server.
 *
 *   Peer/secondary relay was removed in favour of one-MCP-per-server isolation.
 */

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {WebSocket, WebSocketServer} from "ws";
import {readFileSync} from "fs";
import {spawn} from "child_process";
import {randomBytes} from "crypto";
import {fileURLToPath} from "url";
import {dirname, join} from "path";
import {createServer} from "http";
import {
    DEFAULT_IDLE_RELEASE_MS,
    DEFAULT_UNUSED_RELEASE_MS,
    idleTimeoutIsExplicit,
    isAnchorBridge,
    parseIdleTimeout,
    rankTakeoverCandidates,
    shouldIdleExit,
    shouldReleasePort,
} from "./lifecycle.js";
import {normalizeTabArgs} from "./tab-target.js";
import * as diag from "./diagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WS_PORT = parseInt(process.env.SITREC_BRIDGE_PORT || "9780", 10);
const WS_HOST = process.env.SITREC_BRIDGE_HOST || "127.0.0.1"; // Localhost only — avoids macOS firewall EPERM on 0.0.0.0; override with 0.0.0.0 in Docker
const SITREC_CWD = process.cwd(); // Used to auto-match this MCP session to the correct Sitrec tab
const STARTED_AT = Date.now();
const CONTROL_STATUS_PATH = "/__sitrec_bridge/status";
const CONTROL_SHUTDOWN_PATH = "/__sitrec_bridge/shutdown";
const CONTROL_RELEASE_PATH = "/__sitrec_bridge/release";
const CONTROL_TOKEN = randomBytes(24).toString("hex");

// Origin this server is paired to (e.g., "http://localhost:8081"). Set by
// `wt sandbox` for sandbox containers; null for host fallback servers.
const PAIRED_ORIGIN = process.env.SITREC_BRIDGE_PAIRED_ORIGIN || null;
const IDLE_TIMEOUT_MS = PAIRED_ORIGIN
    ? 0
    : parseIdleTimeout(process.env.SITREC_BRIDGE_IDLE_TIMEOUT_MS);
// A timeout the caller ASKED for is obeyed literally; the default one only reaps a bridge whose
// parent has actually gone. See shouldIdleExit for why the distinction matters.
const IDLE_TIMEOUT_EXPLICIT = idleTimeoutIsExplicit(process.env.SITREC_BRIDGE_IDLE_TIMEOUT_MS);

// Host-fallback port scan range. When PAIRED_ORIGIN is null, we scan this range
// descending so that sandbox pairings (which claim low ports 9780+N) are never
// stolen by a host Claude session.
const FALLBACK_PORT_MIN = parseInt(process.env.SITREC_BRIDGE_FALLBACK_PORT_MIN || "9780", 10);
const FALLBACK_PORT_MAX = parseInt(process.env.SITREC_BRIDGE_FALLBACK_PORT_MAX || "9799", 10);

// How long a bridge keeps a port it is not using. See shouldReleasePort — a released port is
// re-acquired on demand, so these are "step aside", not "give up".
const UNUSED_RELEASE_MS = Number(process.env.SITREC_BRIDGE_UNUSED_RELEASE_MS) >= 0
    ? Number(process.env.SITREC_BRIDGE_UNUSED_RELEASE_MS)
    : DEFAULT_UNUSED_RELEASE_MS;
const IDLE_RELEASE_MS = Number(process.env.SITREC_BRIDGE_IDLE_RELEASE_MS) >= 0
    ? Number(process.env.SITREC_BRIDGE_IDLE_RELEASE_MS)
    : DEFAULT_IDLE_RELEASE_MS;
const RELEASE_CHECK_INTERVAL_MS = 30000;

// Protocol version — bump when the wire format changes.
// 5: added JSON-level keepalive (server-ping), role announcements, and port release/re-acquire.
const PROTOCOL_VERSION = 5;

// Load the agent guide once at startup
let agentGuide = "";
try {
    agentGuide = readFileSync(join(__dirname, "sitrec-mcp-guide.md"), "utf-8");
} catch (e) {
    agentGuide = "Guide not found. See tools/SitrecBridge/sitrec-mcp-guide.md";
}
const REQUEST_TIMEOUT_MS = 15000;
const KEEPALIVE_INTERVAL_MS = 10000;

// ── Logging (stderr only — stdout is reserved for MCP stdio transport) ──────

function log(...args) {
    console.error("[SitrecBridge]", ...args);
}

// ── Orphan Detection & Graceful Shutdown ─────────────────────────────────────
// When Claude Code exits, stdin closes. The MCP SDK's StdioServerTransport
// handles the protocol side, but the WebSocket server/client keeps the process
// alive. We detect stdin close and shut down cleanly.

let wsServer = null;  // WebSocket server reference, set in startServer
let httpServer = null; // HTTP server backing the WebSocket server
const localComputeJobs = new Map(); // id -> {proc, ws, stderr, finalSent}
const localComputeSockets = new Set(); // live Local Compute client sockets
let shuttingDown = false;
let lastMcpActivityAt = STARTED_AT;

// Has this bridge ever actually relayed something to the browser? The single most useful signal
// for telling a working session apart from a pre-warm/daemon that will never touch Sitrec.
let everUsed = false;
// Did the extension name us as the fallback bridge it is talking to? Set by its `role` message.
let isActiveFallback = false;
let lastRelayAt = STARTED_AT;

function shutdownGracefully(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down: ${reason}`);
    diag.record("shutdown", {reason, everUsed, boundPort, uptimeMs: Date.now() - STARTED_AT});

    if (wsServer) {
        wsServer.close();
        wsServer = null;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
    if (extensionSocket) {
        extensionSocket.close();
        extensionSocket = null;
    }

    if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }

    for (const [id, req] of pendingRequests) {
        clearTimeout(req.timer);
        req.reject(new Error(`Server shutting down: ${reason}`));
    }
    pendingRequests.clear();

    for (const [, job] of localComputeJobs) {
        try { job.proc.kill("SIGTERM"); } catch {}
    }
    localComputeJobs.clear();

    setTimeout(() => process.exit(0), 200);
}

// Detect stdin close (Claude Code exited)
process.stdin.on("end", () => shutdownGracefully("stdin closed (parent exited)"));
process.stdin.on("close", () => shutdownGracefully("stdin closed (parent exited)"));
process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") shutdownGracefully("stdout pipe closed (parent exited)");
});

// Handle signals
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));
process.on("SIGINT", () => shutdownGracefully("SIGINT"));

// Safety net: detect orphaned server when parent process exits.
// Three complementary checks:
// 1. stdin close/destroy events (works for pipe-based stdio)
// 2. stdin.destroyed / readableEnded polling (catches missed events)
// 3. ppid change detection (most reliable on Unix: parent death reparents to init/launchd)
const ORPHAN_CHECK_INTERVAL_MS = 10000;
const originalPpid = process.ppid;

/**
 * Is the process that started us still running?
 *
 * signal 0 tests for existence without delivering anything. This is a stronger statement than the
 * ppid-change check below - that one only notices a parent whose death REPARENTED us, and cannot
 * fire at all if we were already a child of init - and it is what lets an idle-but-attended bridge
 * tell itself apart from an abandoned one (see shouldIdleExit).
 *
 * A ppid of 1 means we have no identifiable parent to ask about, so it is reported as NOT alive:
 * the conservative answer for a reaper, which would otherwise keep an orphan forever.
 */
function isParentAlive() {
    if (!(originalPpid > 1)) return false;
    try {
        process.kill(originalPpid, 0);
        return true;
    } catch (e) {
        // EPERM means it exists but belongs to another user - still alive.
        return e?.code === "EPERM";
    }
}
// What kind of process started us? `claude` in a terminal, a `claude bg-spare` pre-warm, a
// `claude --remote-control` instance, and a `codex app-server` daemon all look identical from
// inside the bridge, but they have wildly different lifetimes — and knowing which one is holding a
// port is the single fact that made the port-leak diagnosis possible. Captured once, best-effort.
let PARENT_COMMAND = null;

function captureParentCommand() {
    if (process.platform === "win32" || !(process.ppid > 1)) return;
    try {
        const ps = spawn("ps", ["-o", "command=", "-p", String(process.ppid)], {stdio: ["ignore", "pipe", "ignore"]});
        let out = "";
        ps.stdout.on("data", (chunk) => { out += chunk.toString(); });
        ps.on("close", () => {
            PARENT_COMMAND = out.trim().slice(0, 300) || null;
            diag.setContext({parentCommand: PARENT_COMMAND});
        });
        ps.on("error", () => {});
    } catch {
        // Never worth failing startup over.
    }
}

setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) {
        shutdownGracefully("stdin destroyed (orphan detected)");
    }
    if (process.ppid !== originalPpid) {
        shutdownGracefully("parent process exited (ppid changed from " + originalPpid + " to " + process.ppid + ")");
    }
}, ORPHAN_CHECK_INTERVAL_MS).unref();  // unref so this timer alone doesn't keep process alive

// ── WebSocket Relay ─────────────────────────────────────────────────────────

let extensionSocket = null;         // Chrome extension connection
const pendingRequests = new Map();  // id → { resolve, reject, timer }
let requestCounter = 0;
let keepaliveTimer = null;
let boundPort = null;               // The port we successfully bound to

function isBridgeBusy() {
    return pendingRequests.size > 0 || localComputeJobs.size > 0;
}

if (IDLE_TIMEOUT_MS > 0) {
    const idleCheckInterval = Math.min(
        ORPHAN_CHECK_INTERVAL_MS,
        Math.max(100, Math.floor(IDLE_TIMEOUT_MS / 4))
    );
    setInterval(() => {
        if (shouldIdleExit({
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            explicit: IDLE_TIMEOUT_EXPLICIT,
            busy: isBridgeBusy(),
            msSinceActivity: Date.now() - lastMcpActivityAt,
            parentAlive: isParentAlive(),
        })) {
            shutdownGracefully(`no MCP activity for ${IDLE_TIMEOUT_MS}ms`);
        }
    }, idleCheckInterval).unref();
}

function sendControlJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (req.method === "GET" && req.url === CONTROL_STATUS_PATH) {
                if (!isLoopbackRequest(req)) {
                    sendControlJson(res, 403, {error: "Forbidden"});
                    return;
                }
                sendControlJson(res, 200, {
                    service: "SitrecBridge",
                    protocolVersion: PROTOCOL_VERSION,
                    pid: process.pid,
                    parentPid: process.ppid,
                    parentCommand: PARENT_COMMAND,
                    startedAt: STARTED_AT,
                    lastMcpActivityAt,
                    lastRelayAt,
                    pairedOrigin: PAIRED_ORIGIN,
                    busy: isBridgeBusy(),
                    bound: boundPort !== null,
                    everUsed,
                    isActiveFallback,
                    extensionConnected: !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
                    localComputeClients: localComputeSockets.size,
                    boundPort,
                    controlToken: CONTROL_TOKEN,
                });
                return;
            }

            if (req.method === "POST" && req.url === CONTROL_SHUTDOWN_PATH) {
                if (!isLoopbackRequest(req) || req.headers["x-sitrec-bridge-token"] !== CONTROL_TOKEN) {
                    sendControlJson(res, 403, {error: "Forbidden"});
                    return;
                }
                sendControlJson(res, 202, {ok: true});
                setImmediate(() => shutdownGracefully("superseded after fallback port exhaustion"));
                return;
            }

            // Yield the port WITHOUT dying. This is what a peer asks for when the range is full:
            // the loser steps aside and re-acquires a port the next time it has work, instead of
            // losing its bridge for the rest of the session.
            if (req.method === "POST" && req.url === CONTROL_RELEASE_PATH) {
                if (!isLoopbackRequest(req) || req.headers["x-sitrec-bridge-token"] !== CONTROL_TOKEN) {
                    sendControlJson(res, 403, {error: "Forbidden"});
                    return;
                }
                // Refuse anything shouldReleasePort would refuse. rankTakeoverCandidates already
                // filters these out, but a peer must not be able to force what our own release
                // check would decline — releasePort() force-closes the extension and Local Compute
                // sockets, so the pins have to hold on both paths.
                if (isBridgeBusy()) {
                    sendControlJson(res, 409, {ok: false, error: "Bridge is busy"});
                    return;
                }
                if (isActiveFallback) {
                    sendControlJson(res, 409, {ok: false, error: "Bridge is the extension's active fallback"});
                    return;
                }
                if (localComputeSockets.size > 0) {
                    sendControlJson(res, 409, {ok: false, error: "Bridge has Local Compute clients attached"});
                    return;
                }
                sendControlJson(res, 202, {ok: true});
                setImmediate(() => releasePort("port yielded to a peer that needs one"));
                return;
            }

            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Cache-Control": "no-store",
                });
                res.end();
                return;
            }

            if (req.method === "GET" && (req.url === "/" || req.url === "/local-compute-probe")) {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                });
                res.end();
                return;
            }

            res.writeHead(404, {
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            });
            res.end();
        });
        const wss = new WebSocketServer({ server });
        wsServer = wss;
        httpServer = server;
        boundPort = port;
        let listening = false;

        server.on("listening", () => {
            listening = true;
            boundPort = server.address()?.port ?? port;
            log(`Listening on ws://${WS_HOST}:${boundPort}` +
                (PAIRED_ORIGIN ? ` (paired to ${PAIRED_ORIGIN})` : ` (host fallback)`));
            diag.setContext({port: boundPort});
            diag.record("port-bind", {port: boundPort, paired: PAIRED_ORIGIN});
            resolve();
        });

        server.on("error", (err) => {
            log("HTTP/WebSocket server error:", err.message);
            if (!listening) {
                if (wsServer === wss) wsServer = null;
                if (httpServer === server) httpServer = null;
                if (boundPort === port) boundPort = null;
                reject(err);
            }
        });

        wss.on("error", (err) => {
            log("WebSocket server error:", err.message);
        });

        wss.on("connection", (ws, req) => {
            // Wait briefly for a force-extension marker; otherwise treat as a
            // normal extension connection.
            let identified = false;

            const earlyHandler = (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    if (msg.type === "force-extension") {
                        identified = true;
                        ws.removeListener("message", earlyHandler);
                        setupExtensionConnection(ws, true);
                        return;
                    }
                    if (msg.type === "local-compute-client") {
                        identified = true;
                        ws.removeListener("message", earlyHandler);
                        setupLocalComputeConnection(ws, msg, req);
                        return;
                    }
                } catch {}
                if (!identified) {
                    identified = true;
                    ws.removeListener("message", earlyHandler);
                    setupExtensionConnection(ws, false);
                    handleExtensionMessage(raw);
                }
            };

            ws.on("message", earlyHandler);

            setTimeout(() => {
                if (!identified) {
                    identified = true;
                    ws.removeListener("message", earlyHandler);
                    setupExtensionConnection(ws, false);
                }
            }, 500);
        });

        server.listen(port, WS_HOST);
    });
}

// ── Port lease ──────────────────────────────────────────────────────────────
// A port is borrowed, not owned. releasePort() gives it back while the process keeps running;
// ensureBound() takes one again the moment there is work. See shouldReleasePort in lifecycle.js.

let acquiring = null;   // in-flight ensureBound promise, so concurrent tool calls share one attempt

function releasePort(reason) {
    if (boundPort === null || shuttingDown) return false;

    const port = boundPort;
    log(`Releasing port ${port}: ${reason}`);
    diag.record("port-release", {port, reason, everUsed, idleMs: Date.now() - lastRelayAt});

    // Drop the extension first so it stops treating this port as live, then tear the listener
    // down. Local Compute clients are pinned by shouldReleasePort, so there should be none — but
    // close any stragglers rather than leaking sockets on a half-closed server.
    if (extensionSocket) {
        try { extensionSocket.close(); } catch {}
        extensionSocket = null;
    }
    for (const socket of localComputeSockets) {
        try { socket.close(); } catch {}
    }
    localComputeSockets.clear();

    if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }

    // wss.close() only stops new connections; sockets already established would keep the
    // underlying listener's handle alive and make the port un-rebindable.
    if (wsServer) {
        for (const client of wsServer.clients) {
            try { client.terminate(); } catch {}
        }
        try { wsServer.close(); } catch {}
        wsServer = null;
    }
    if (httpServer) {
        try { httpServer.close(); } catch {}
        try { httpServer.closeAllConnections?.(); } catch {}
        httpServer = null;
    }

    boundPort = null;
    isActiveFallback = false;
    diag.setContext({port: null});
    return true;
}

/**
 * Make sure we hold a port, acquiring one if we let ours go. Called before anything that needs the
 * browser. Concurrent callers share a single acquisition.
 */
function ensureBound() {
    if (boundPort !== null) return Promise.resolve(boundPort);
    if (acquiring) return acquiring;

    acquiring = (async () => {
        diag.record("port-reacquire-start");
        await start();
        diag.record("port-reacquire-done", {port: boundPort});
        return boundPort;
    })().finally(() => {
        acquiring = null;
    });

    return acquiring;
}

/**
 * Wait for the extension to notice a freshly-acquired port. It rescans every few seconds while a
 * Sitrec tab is open, so this is normally sub-second; the wait exists so the first call after a
 * re-acquire succeeds instead of reporting "extension not connected".
 */
function waitForExtension(timeoutMs = 8000) {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) return Promise.resolve(true);

    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const poll = setInterval(() => {
            if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
                clearInterval(poll);
                resolve(true);
            } else if (Date.now() >= deadline) {
                clearInterval(poll);
                resolve(false);
            }
        }, 150);
        poll.unref?.();
    });
}

/** Am I the oldest bound fallback bridge, and so obliged to keep my port? */
async function checkIsAnchor() {
    const ports = [];
    for (let port = FALLBACK_PORT_MIN; port <= FALLBACK_PORT_MAX; port++) ports.push(port);
    const statuses = (await Promise.all(ports.map(getBridgeControlStatus))).filter(Boolean);
    return isAnchorBridge(statuses, process.pid);
}

async function releaseCheck() {
    if (shuttingDown || boundPort === null || PAIRED_ORIGIN) return;

    // Cheap tests first — only pay for the peer scan when everything else says "release".
    const provisional = shouldReleasePort({
        bound: true,
        paired: !!PAIRED_ORIGIN,
        busy: isBridgeBusy(),
        everUsed,
        isActiveFallback,
        isAnchor: false,
        hasLocalComputeClients: localComputeSockets.size > 0,
        msSinceActivity: Date.now() - lastRelayAt,
        unusedReleaseMs: UNUSED_RELEASE_MS,
        idleReleaseMs: IDLE_RELEASE_MS,
    });
    if (!provisional) return;

    if (await checkIsAnchor()) {
        diag.record("port-release-skipped", {port: boundPort, reason: "anchor bridge — keeps the range non-empty"});
        return;
    }
    if (isBridgeBusy() || boundPort === null) return; // work may have arrived during the scan

    releasePort(everUsed ? "idle since last relay" : "never relayed a call");
}

function sendLocalCompute(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function isAllowedLocalComputeOrigin(origin) {
    if (!origin) return true;
    try {
        const {protocol, hostname} = new URL(origin);
        return protocol === "chrome-extension:" ||
            hostname === "local.metabunk.org" ||
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1";
    } catch {
        return false;
    }
}

function localComputeCapabilities() {
    return {
        motionAnalysis: true,
        motionAnalysisWorker: "python-opencv",
        localComputeInstall: true,
        cancel: true,
    };
}

function setupLocalComputeConnection(ws, hello, req) {
    const origin = req?.headers?.origin || hello?.origin || null;
    if (!isAllowedLocalComputeOrigin(origin)) {
        log(`Rejected Local Compute client from origin ${origin}`);
        sendLocalCompute(ws, {type: "local-compute-error", error: `Origin not allowed: ${origin}`});
        ws.close();
        return;
    }

    log(`Local Compute client connected${origin ? ` from ${origin}` : ""}`);
    localComputeSockets.add(ws);
    diag.record("local-compute-connect", {origin, clients: localComputeSockets.size});
    sendLocalCompute(ws, {
        type: "local-compute-hello",
        protocolVersion: 1,
        serverPid: process.pid,
        cwd: SITREC_CWD,
        boundPort,
        capabilities: localComputeCapabilities(),
    });

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            sendLocalCompute(ws, {type: "local-compute-error", error: `Bad JSON: ${e.message}`});
            return;
        }

        if (msg.type === "local-compute-ping") {
            sendLocalCompute(ws, {type: "local-compute-pong", time: Date.now()});
            return;
        }

        if (msg.type === "local-compute-cancel") {
            const job = localComputeJobs.get(msg.id);
            if (job) {
                job.finalSent = true;
                try { job.proc.kill("SIGTERM"); } catch {}
                localComputeJobs.delete(msg.id);
                sendLocalCompute(ws, {type: "local-compute-response", id: msg.id, ok: false, error: "Cancelled"});
            }
            return;
        }

        if (msg.type !== "local-compute-request") {
            sendLocalCompute(ws, {type: "local-compute-error", error: `Unknown Local Compute message type: ${msg.type}`});
            return;
        }

        runLocalComputeRequest(ws, msg).catch((e) => {
            sendLocalCompute(ws, {type: "local-compute-response", id: msg.id, ok: false, error: e.message});
        });
    });

    ws.on("close", () => {
        localComputeSockets.delete(ws);
        diag.record("local-compute-disconnect", {clients: localComputeSockets.size});
        for (const [id, job] of [...localComputeJobs]) {
            if (job.ws === ws) {
                try { job.proc.kill("SIGTERM"); } catch {}
                localComputeJobs.delete(id);
            }
        }
    });
}

async function runLocalComputeRequest(ws, msg) {
    const {id, action, params} = msg;
    if (!id) {
        sendLocalCompute(ws, {type: "local-compute-response", ok: false, error: "Missing request id"});
        return;
    }
    if (action === "local_compute_install") {
        runLocalComputeInstall(ws, msg);
        return;
    }
    if (action !== "motion_analysis") {
        sendLocalCompute(ws, {type: "local-compute-response", id, ok: false, error: `Unsupported Local Compute action: ${action}`});
        return;
    }
    if (localComputeJobs.has(id)) {
        sendLocalCompute(ws, {type: "local-compute-response", id, ok: false, error: `Duplicate request id: ${id}`});
        return;
    }

    const python = process.env.SITREC_LOCAL_COMPUTE_PYTHON || "python3";
    const workerPath = join(__dirname, "local-compute", "motion_analysis_worker.py");
    const proc = spawn(python, [workerPath], {
        cwd: SITREC_CWD,
        stdio: ["pipe", "pipe", "pipe"],
        env: {...process.env, PYTHONUNBUFFERED: "1"},
    });

    const job = {proc, ws, stderr: "", finalSent: false};
    localComputeJobs.set(id, job);

    const fail = (error) => {
        if (job.finalSent) return;
        job.finalSent = true;
        localComputeJobs.delete(id);
        sendLocalCompute(ws, {type: "local-compute-response", id, ok: false, error});
    };

    let buffer = "";
    proc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let payload;
            try {
                payload = JSON.parse(line);
            } catch (e) {
                log(`Local Compute worker emitted non-JSON: ${line.slice(0, 200)}`);
                continue;
            }
            if (payload.type === "progress") {
                sendLocalCompute(ws, {type: "local-compute-progress", id, progress: payload.progress || {}});
            } else if (payload.type === "result") {
                job.finalSent = true;
                localComputeJobs.delete(id);
                sendLocalCompute(ws, {type: "local-compute-response", id, ok: true, result: payload.result});
            } else if (payload.type === "error") {
                fail(payload.error || "Local Compute worker error");
                if (payload.trace) log(payload.trace);
            }
        }
    });

    proc.stderr.on("data", (chunk) => {
        job.stderr += chunk.toString();
        if (job.stderr.length > 8000) job.stderr = job.stderr.slice(-8000);
    });

    proc.on("error", (err) => {
        fail(`Failed to start Local Compute worker with ${python}: ${err.message}`);
    });

    proc.on("close", (code, signal) => {
        if (job.finalSent) {
            localComputeJobs.delete(id);
            return;
        }
        const tail = job.stderr ? `\n${job.stderr}` : "";
        fail(`Local Compute worker exited with ${signal || code}${tail}`);
    });

    proc.stdin.end(JSON.stringify(params || {}));
}

function runLocalComputeInstall(ws, msg) {
    const {id} = msg;
    if (localComputeJobs.has(id)) {
        sendLocalCompute(ws, {type: "local-compute-response", id, ok: false, error: `Duplicate request id: ${id}`});
        return;
    }

    const installer = getLocalComputeInstaller();
    const proc = spawn(installer.command, installer.args, {
        cwd: SITREC_CWD,
        stdio: ["ignore", "pipe", "pipe"],
        env: {...process.env, PYTHONUNBUFFERED: "1"},
    });

    const job = {proc, ws, stderr: "", stdout: "", finalSent: false};
    localComputeJobs.set(id, job);

    const sendLine = (line, stream) => {
        const text = line.trim();
        if (!text) return;
        sendLocalCompute(ws, {
            type: "local-compute-progress",
            id,
            progress: {phase: "install", message: text, stream},
        });
    };

    const fail = (error) => {
        if (job.finalSent) return;
        job.finalSent = true;
        localComputeJobs.delete(id);
        sendLocalCompute(ws, {type: "local-compute-response", id, ok: false, error});
    };

    let stdoutBuffer = "";
    let stderrBuffer = "";
    proc.stdout.on("data", (chunk) => {
        job.stdout += chunk.toString();
        if (job.stdout.length > 12000) job.stdout = job.stdout.slice(-12000);
        stdoutBuffer += chunk.toString();
        let nl;
        while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, nl);
            stdoutBuffer = stdoutBuffer.slice(nl + 1);
            sendLine(line, "stdout");
        }
    });

    proc.stderr.on("data", (chunk) => {
        job.stderr += chunk.toString();
        if (job.stderr.length > 12000) job.stderr = job.stderr.slice(-12000);
        stderrBuffer += chunk.toString();
        let nl;
        while ((nl = stderrBuffer.indexOf("\n")) >= 0) {
            const line = stderrBuffer.slice(0, nl);
            stderrBuffer = stderrBuffer.slice(nl + 1);
            sendLine(line, "stderr");
        }
    });

    proc.on("error", (err) => {
        fail(`Failed to start Local Compute installer (${installer.command}): ${err.message}`);
    });

    proc.on("close", (code, signal) => {
        if (job.finalSent) {
            localComputeJobs.delete(id);
            return;
        }
        if (stdoutBuffer.trim()) sendLine(stdoutBuffer, "stdout");
        if (stderrBuffer.trim()) sendLine(stderrBuffer, "stderr");
        job.finalSent = true;
        localComputeJobs.delete(id);

        if (code === 0) {
            sendLocalCompute(ws, {
                type: "local-compute-response",
                id,
                ok: true,
                result: {
                    installed: true,
                    stdout: job.stdout,
                    stderr: job.stderr,
                },
            });
        } else {
            const tail = job.stderr || job.stdout || "";
            sendLocalCompute(ws, {
                type: "local-compute-response",
                id,
                ok: false,
                error: `Local Compute installer exited with ${signal || code}${tail ? `\n${tail}` : ""}`,
            });
        }
    });
}

function getLocalComputeInstaller() {
    if (process.platform === "win32") {
        return {
            command: "powershell.exe",
            args: [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                join(__dirname, "local-compute", "install.ps1"),
            ],
        };
    }

    return {
        command: "bash",
        args: [join(__dirname, "local-compute", "install.sh")],
    };
}

function setupExtensionConnection(ws, force = false) {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        if (force) {
            log("Forced reconnect — replacing existing extension");
            extensionSocket.close();
            finishExtensionSetup(ws);
            return;
        }

        // Probe the existing socket — if stale (e.g., extension reload),
        // the pong won't arrive and we replace it with the newcomer.
        log("Extension already connected — probing liveness...");
        let pongReceived = false;
        const pongHandler = () => { pongReceived = true; };
        extensionSocket.once("pong", pongHandler);
        extensionSocket.ping();

        setTimeout(() => {
            extensionSocket?.removeListener("pong", pongHandler);
            if (pongReceived) {
                log("Existing extension is alive — rejecting new connection");
                ws.send(JSON.stringify({ type: "rejected", reason: "Another extension is already connected" }));
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.close();
                }, 5000);
            } else {
                log("Existing extension is stale — replacing with new connection");
                extensionSocket.close();
                finishExtensionSetup(ws);
            }
        }, 2000);
        return;
    }

    finishExtensionSetup(ws);
}

function finishExtensionSetup(ws) {
    extensionSocket = ws;
    log("Extension connected");
    diag.record("extension-connect", {port: boundPort});

    try {
        const sourceManifest = JSON.parse(readFileSync(join(__dirname, "extension", "manifest.json"), "utf-8"));
        ws.send(JSON.stringify({
            type: "version-info",
            sourceVersion: sourceManifest.version,
            serverPid: process.pid,
            protocolVersion: PROTOCOL_VERSION,
            pairedOrigin: PAIRED_ORIGIN,
            boundPort,
            cwd: SITREC_CWD,
            startedAt: STARTED_AT,
            localComputeCapabilities: localComputeCapabilities(),
        }));
    } catch (e) {
        log("Could not read source manifest for version check:", e.message);
    }

    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
        if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
            // A protocol ping frame proves the socket is alive, but Chrome answers it down in the
            // network stack without ever waking the extension's JavaScript — so it does NOT reset
            // the MV3 service worker's 30-second idle timer. The worker was therefore dying every
            // ~30s, taking every WebSocket with it, and the alarm rebuilt the whole thing a moment
            // later: a permanent reconnect sawtooth, with any tool call landing in the gap failing
            // as "extension is not connected". An application-level message DOES dispatch a JS
            // event, which keeps the worker alive. Send both: the frame for liveness, the message
            // for the timer.
            extensionSocket.ping();
            try {
                extensionSocket.send(JSON.stringify({type: "server-ping", t: Date.now()}));
            } catch {}
        }
    }, KEEPALIVE_INTERVAL_MS);

    ws.on("message", (raw) => handleExtensionMessage(raw));

    ws.on("close", () => {
        // Only treat this as a real disconnect if the current extensionSocket
        // is the one that closed. When force-extension replaces a stale socket,
        // the old ws's close fires AFTER the new one has taken over — clearing
        // pendings then would kill in-flight requests issued on the new socket.
        if (extensionSocket !== ws) {
            log("Stale extension socket closed (already replaced)");
            return;
        }
        log("Chrome extension disconnected");
        diag.record("extension-disconnect", {port: boundPort, pending: pendingRequests.size});
        extensionSocket = null;
        isActiveFallback = false;
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;

        for (const [id, pending] of pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Extension disconnected"));
        }
        pendingRequests.clear();
    });

    ws.on("error", (err) => {
        log("Extension WebSocket error:", err.message);
    });
}

function handleExtensionMessage(raw) {
    try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "ping") {
            if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
                extensionSocket.send(JSON.stringify({
                    type: "pong",
                    serverPid: process.pid,
                    pairedOrigin: PAIRED_ORIGIN,
                    boundPort,
                    cwd: SITREC_CWD,
                    startedAt: STARTED_AT,
                    everUsed,
                    localComputeCapabilities: localComputeCapabilities(),
                }));
            }
            return;
        }

        // The extension's answer to server-ping. Nothing to do — receiving it is the point.
        if (msg.type === "server-pong") return;

        // The extension routes to exactly one host-fallback bridge at a time and tells each of us
        // which. Being the chosen one pins our port: it is the bridge the browser (and Local
        // Compute) is actually talking to.
        if (msg.type === "role") {
            const active = !!msg.active;
            if (active !== isActiveFallback) {
                diag.record("role-change", {active, port: boundPort});
            }
            isActiveFallback = active;
            return;
        }

        if (msg.id != null && pendingRequests.has(msg.id)) {
            const { resolve, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);
            resolve(msg);
        }
    } catch (e) {
        log("Bad message from extension:", e.message);
    }
}

/**
 * Get this bridge ready to talk to the browser: claim a port if we released ours, and give the
 * extension a moment to find us. Every path that reaches the extension must go through here —
 * anything that pokes `extensionSocket` directly will simply fail on a bridge that is between
 * leases, and will keep failing until some *other* call happens to re-acquire a port.
 */
async function ensureRelayReady() {
    everUsed = true;
    lastRelayAt = Date.now();

    if (boundPort === null) {
        await ensureBound();
        if (boundPort === null) {
            throw new Error(
                `No free SitrecBridge port in ${FALLBACK_PORT_MIN}-${FALLBACK_PORT_MAX}. ` +
                `Every port is held by a busy bridge. Close an unused Claude Code or Codex session, ` +
                `or run sitrec_diagnostics to see which processes hold them.`
            );
        }
        await waitForExtension();
    }

    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
        // The service worker may simply be mid-restart; it rescans within a few seconds.
        await waitForExtension(5000);
    }
}

async function sendToExtension(action, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    await ensureRelayReady();
    return relayRaw(action, params, timeoutMs);
}

/** Send on the existing socket. No port acquisition, no "used" bookkeeping. */
function relayRaw(action, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            diag.record("relay-no-extension", {action, port: boundPort});
            return reject(new Error(
                "Chrome extension is not connected. Make sure:\n" +
                "1. The SitrecBridge extension is installed and enabled\n" +
                "2. Sitrec is open in a browser tab" +
                (PAIRED_ORIGIN ? ` at ${PAIRED_ORIGIN}` : "") + "\n" +
                "3. The extension popup shows this server (port " + boundPort + ") as connected"
            ));
        }

        const id = ++requestCounter;
        const startedAt = Date.now();
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            diag.record("relay-timeout", {action, port: boundPort, timeoutMs});
            reject(new Error(`Timed out waiting for '${action}' response (${timeoutMs}ms)`));
        }, timeoutMs);

        pendingRequests.set(id, {
            resolve: (msg) => {
                diag.record("relay-ok", {action, ms: Date.now() - startedAt});
                resolve(msg);
            },
            reject: (error) => {
                diag.record("relay-fail", {action, ms: Date.now() - startedAt, error: error?.message});
                reject(error);
            },
            timer,
        });
        extensionSocket.send(JSON.stringify({ id, action, params, _cwd: SITREC_CWD }));
    });
}

// ── Startup ─────────────────────────────────────────────────────────────────

function tryBind(port) {
    return new Promise((resolve) => {
        const testServer = new WebSocketServer({ host: WS_HOST, port });
        testServer.on("listening", () => {
            testServer.close(() => resolve(true));
        });
        testServer.on("error", (err) => {
            resolve(err.code === "EADDRINUSE" ? false : { error: err });
        });
    });
}

function controlUrl(port, path) {
    const host = WS_HOST === "0.0.0.0" || WS_HOST === "::" ? "127.0.0.1" : WS_HOST;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    return `http://${urlHost}:${port}${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {...options, signal: controller.signal});
    } finally {
        clearTimeout(timer);
    }
}

async function getBridgeControlStatus(port) {
    try {
        const response = await fetchWithTimeout(controlUrl(port, CONTROL_STATUS_PATH));
        if (!response.ok) return null;
        const status = await response.json();
        return {...status, port};
    } catch {
        return null;
    }
}

/**
 * Ask a peer for its port.
 *
 * Prefer /release: the peer drops its listener and stays alive, so it simply re-acquires a port
 * next time it has work. Killing it (the old behaviour, and still the fallback for pre-v5 bridges
 * that have no /release endpoint) permanently destroys that session's bridge — which is one of the
 * ways "the MCP just stopped working, I had to reconnect" happened.
 */
async function requestBridgePort(candidate) {
    try {
        const released = await fetchWithTimeout(controlUrl(candidate.port, CONTROL_RELEASE_PATH), {
            method: "POST",
            headers: {"X-Sitrec-Bridge-Token": candidate.controlToken},
        });
        if (released.status === 202) return "released";
        if (released.status === 409) return false; // busy — leave it alone
    } catch {
        // Fall through to the shutdown path.
    }

    try {
        const response = await fetchWithTimeout(controlUrl(candidate.port, CONTROL_SHUTDOWN_PATH), {
            method: "POST",
            headers: {"X-Sitrec-Bridge-Token": candidate.controlToken},
        });
        return response.status === 202 ? "shutdown" : false;
    } catch {
        return false;
    }
}

async function reclaimFallbackPort(occupiedPorts) {
    const statuses = await Promise.all(occupiedPorts.map(getBridgeControlStatus));
    const candidates = rankTakeoverCandidates(statuses, process.ppid);

    for (const candidate of candidates) {
        log(`Fallback ports full; reclaiming port ${candidate.port} from idle bridge ` +
            `PID ${candidate.pid} (last MCP activity ${new Date(candidate.lastMcpActivityAt).toISOString()}).`);
        const how = await requestBridgePort(candidate);
        diag.record("reclaim-attempt", {
            port: candidate.port,
            victimPid: candidate.pid,
            victimEverUsed: !!candidate.everUsed,
            victimParent: candidate.parentCommand || null,
            outcome: how || "refused",
        });
        if (!how) continue;

        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const ok = await tryBind(candidate.port);
            if (ok === true) return candidate.port;
            if (ok?.error) throw ok.error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    return null;
}

async function start() {
    if (process.env.SITREC_BRIDGE_PEER) {
        log("Note: SITREC_BRIDGE_PEER is no longer supported — running standalone.");
    }

    if (PAIRED_ORIGIN) {
        // Sandbox mode: bind exactly to SITREC_BRIDGE_PORT or fail.
        const ok = await tryBind(WS_PORT);
        if (ok === true) {
            await startServer(WS_PORT);
        } else {
            log(`Could not bind paired port ${WS_PORT} (in use). ` +
                `Each paired sandbox needs an exclusive MCP port. Aborting.`);
            process.exit(1);
        }
        return;
    }

    // Host fallback: scan high → low so sandbox-paired low ports stay free.
    const startPort = WS_PORT === 9780 ? FALLBACK_PORT_MAX : WS_PORT;
    const occupiedPorts = [];
    for (let port = startPort; port >= FALLBACK_PORT_MIN; port--) {
        const ok = await tryBind(port);
        if (ok === true) {
            try {
                await startServer(port);
                return;
            } catch (error) {
                if (error.code !== "EADDRINUSE") throw error;
            }
        }
        if (ok?.error) {
            throw ok.error;
        }
        occupiedPorts.push(port);
    }

    const reclaimedPort = await reclaimFallbackPort(occupiedPorts);
    if (reclaimedPort !== null) {
        await startServer(reclaimedPort);
        return;
    }

    // Staying alive unbound beats exiting. Exiting here left the session with a dead MCP server
    // for the rest of its life — the user's only recovery was a manual reconnect. Unbound, we
    // simply try again on the next call that needs the browser, by which time a quiet peer has
    // very likely released one.
    log(`No free port in ${FALLBACK_PORT_MIN}-${FALLBACK_PORT_MAX} right now. ` +
        `Staying alive without one; will retry when a tool call needs the browser.`);
    diag.record("port-acquire-failed", {min: FALLBACK_PORT_MIN, max: FALLBACK_PORT_MAX});
}

// ── MCP Tool Definitions ────────────────────────────────────────────────────

// Optional 'tab' parameter added to tools that relay to extension.
// Allows targeting a specific Sitrec tab by numeric ID or URL substring.
const TAB_PROPERTY = {
    tab: {
        type: ["string", "number"],
        description:
            "Target a specific Sitrec tab. Pass a URL substring (e.g. 'build2', '/sitrec') " +
            "or a numeric Chrome tab ID (alias: tabId). Omit to use the default (first) Sitrec " +
            "tab — which is ambiguous when several are open, so pass this whenever more than one " +
            "tab exists. Use sitrec_list_tabs to see available tabs and their IDs.",
    },
    tabId: {
        type: ["string", "number"],
        description: "Alias for `tab`. Accepted because sitrec_list_tabs reports tabs under `id` " +
            "and chrome calls it tabId; passing it no longer silently targets the default tab.",
    },
};


const TOOLS = [
    {
        name: "sitrec_status",
        description:
            "Get the connection status of SitrecBridge — whether the extension is connected " +
            "and whether Sitrec is loaded and ready in the browser.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "sitrec_diagnostics",
        description:
            "Diagnose SitrecBridge connection problems. Returns this server's port-lease state, a " +
            "scan of every bridge process on ports 9780-9799 (which parent process holds each port, " +
            "whether it has ever relayed a call), this process's recent event trail, and — unless " +
            "disabled — the extension's service-worker event log, which survives worker restarts. " +
            "Use this when tool calls fail with 'extension is not connected', when ports look " +
            "exhausted, or to see why a bridge dropped.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {type: "number", description: "Max event-log entries to return (default 60)."},
                includeExtension: {
                    type: "boolean",
                    description: "Include the extension's persisted log. Default true; set false if the extension is down.",
                },
                days: {type: "number", description: "Days of on-disk cross-session log to include (default 1)."},
            },
            required: [],
        },
    },
    {
        name: "sitrec_list_tabs",
        description:
            "List all open Sitrec tabs in the browser. Returns each tab's numeric ID, URL, " +
            "and title. Use the ID or a URL substring as the 'tab' parameter on other tools " +
            "to target a specific Sitrec instance (e.g. 'build2' vs '/sitrec').",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "sitrec_get_sitch",
        description:
            "Get information about the currently loaded situation (sitch): name, frame count, " +
            "FPS, center coordinates, time range, and whether it's a custom sitch.",
        inputSchema: { type: "object", properties: { ...TAB_PROPERTY }, required: [] },
    },
    {
        name: "sitrec_load_sitch",
        description: "Load a named situation (sitch) into Sitrec.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                name: {
                    type: "string",
                    description: "Sitch name, e.g. 'gimbal', 'chilean', 'gofast', 'agua', 'flir1'",
                },
            },
            required: ["name"],
        },
    },
    {
        name: "sitrec_list_sitches",
        description: "List all available sitches (situations) that can be loaded.",
        inputSchema: { type: "object", properties: { ...TAB_PROPERTY }, required: [] },
    },
    {
        name: "sitrec_list_nodes",
        description:
            "List all nodes in the current node graph. Each node has an ID, a class name, " +
            "and connections to other nodes. Optionally filter by ID substring or class name.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                filter: {
                    type: "string",
                    description: "Substring filter on node ID (case-insensitive)",
                },
                typeFilter: {
                    type: "string",
                    description: "Filter on node class name (case-insensitive)",
                },
            },
            required: [],
        },
    },
    {
        name: "sitrec_get_node",
        description:
            "Get detailed information about a specific node: its class name, input connections, " +
            "output connections, visibility, and current value at a given frame.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                id: { type: "string", description: "Node ID" },
                frame: {
                    type: "number",
                    description: "Frame number to evaluate getValue() at (defaults to current frame)",
                },
            },
            required: ["id"],
        },
    },
    {
        name: "sitrec_get_frame",
        description: "Get the current frame number, total frame count, FPS, and paused state.",
        inputSchema: { type: "object", properties: { ...TAB_PROPERTY }, required: [] },
    },
    {
        name: "sitrec_set_frame",
        description: "Set the current frame number (jumps the playhead).",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                frame: { type: "number", description: "Frame number to jump to (0-based)" },
            },
            required: ["frame"],
        },
    },
    {
        name: "sitrec_play_pause",
        description: "Toggle or explicitly set the play/pause state of the animation.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                paused: {
                    type: "boolean",
                    description: "If provided, sets paused state. If omitted, toggles current state.",
                },
            },
            required: [],
        },
    },
    {
        name: "sitrec_screenshot",
        description:
            "Capture a screenshot of the Sitrec viewport. By default, composites all visible views " +
            "and overlays into a single image (same as 'Render Viewport Video'). " +
            "Pass view='mainView' or view='lookView' to capture a single view instead. " +
            "Pass view='page' to capture the full browser tab (DOM elements + canvas — " +
            "includes GUI panels, labels, and all visible UI). " +
            "Returns a base64-encoded image (JPEG by default, use quality='png' for lossless).",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                view: {
                    type: "string",
                    description: "Capture a single named view. Accepts 'main'/'mainView', 'look'/'lookView', 'video'/'videoView'. Use 'page' to capture the full browser tab including DOM UI elements. If omitted, composites all visible views.",
                },
                quality: {
                    type: ["number", "string"],
                    description: "JPEG quality 1-100 (default 75). Use 'png' for lossless PNG output. Lower values = smaller file size.",
                },
                maxWidth: {
                    type: "number",
                    description: "Maximum image width in pixels. If the captured image is wider, it will be downscaled (maintaining aspect ratio). Useful on high-DPI displays to reduce image size.",
                },
            },
            required: [],
        },
    },
    {
        name: "sitrec_get_video_frame",
        description:
            "Capture the raw video frame at a given frame number from the loaded video source. " +
            "Returns the decoded video image (before any view rendering, overlays, or effects). " +
            "Useful for analyzing video content, comparing frames, or extracting stills. " +
            "Returns a base64-encoded image (JPEG by default). " +
            "Requires a sitch with a loaded video.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                frame: {
                    type: "number",
                    description: "Frame number to capture (0-based). Defaults to the current playback frame.",
                },
                quality: {
                    type: ["number", "string"],
                    description: "JPEG quality 1-100 (default 75). Use 'png' for lossless PNG output.",
                },
                maxWidth: {
                    type: "number",
                    description: "Maximum image width in pixels. Downscaled if wider (maintains aspect ratio).",
                },
            },
            required: [],
        },
    },
    {
        name: "sitrec_debug_log",
        description:
            "Control debug log capture in the Sitrec page. Intercepts console.log/error/warn " +
            "and stores them in a buffer. Works in both dev and production builds. " +
            "Actions: 'enable' starts capture, 'disable' stops, 'export' returns the log text, " +
            "'clear' empties the buffer, or omit for status.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                action: {
                    type: "string",
                    enum: ["enable", "disable", "export", "clear", "status"],
                    description: "Action to perform. Omit for status.",
                },
                tail: {
                    type: "number",
                    description: "For 'export': only return the last N entries (default: all). Use to avoid huge exports.",
                },
            },
            required: [],
        },
    },
    {
        name: "sitrec_eval",
        description:
            "Evaluate a JavaScript expression in the Sitrec page context. Has access to all " +
            "Sitrec globals: NodeMan, Sit, par, Globals, FileManager, LocalFrame, GlobalScene, etc. " +
            "The expression must return a JSON-serializable value. Use for advanced queries " +
            "not covered by other tools.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                expression: {
                    type: "string",
                    description: "JavaScript expression to evaluate (must return JSON-serializable value)",
                },
            },
            required: ["expression"],
        },
    },
    {
        name: "sitrec_api_call",
        description:
            "Call a Sitrec API function by name. These are the same functions available to the " +
            "built-in AI chatbot. Use sitrec_api_list to see available functions and their parameters. " +
            "Common functions: gotoLLA, setDateTime, setFrame, play, pause, satellitesLoadCurrentStarlink, " +
            "addObjectAtLLA, setMenuValue, showView, hideView, setLayout, toggleFullscreen.",
        inputSchema: {
            type: "object",
            properties: {
                ...TAB_PROPERTY,
                fn: {
                    type: "string",
                    description: "API function name (e.g. 'gotoLLA', 'setDateTime', 'setFrame')",
                },
                args: {
                    type: "object",
                    description: "Arguments object for the function (e.g. {lat: 51.5, lon: -0.13, alt: 0})",
                },
            },
            required: ["fn"],
        },
    },
    {
        name: "sitrec_api_list",
        description:
            "List all available Sitrec API functions with their documentation, parameters, " +
            "and available menu controls. Returns the full API reference.",
        inputSchema: { type: "object", properties: { ...TAB_PROPERTY }, required: [] },
    },
    {
        name: "sitrec_reload_extension",
        description:
            "Reload the SitrecBridge Chrome extension. Use after modifying extension files " +
            "(background.js, content-script.js, page-bridge.js, manifest.json) to pick up changes " +
            "without manually clicking reload in chrome://extensions. The extension will disconnect " +
            "briefly and reconnect automatically.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "sitrec_reload_tab",
        description:
            "Reload a Sitrec page, so a new `npm run build` is actually running before you measure " +
            "anything. Use this rather than evaluating location.reload(): a reload returned from " +
            "sitrec_eval never executes (the page just keeps running, and the stale bundle then " +
            "looks like a fix that did not work). Reloads via chrome.tabs.reload. Allow a few " +
            "seconds for the sitch to load, and ~30s more for Google 3D tiles to stream, before " +
            "measuring anything ground-related.",
        inputSchema: { type: "object", properties: { ...TAB_PROPERTY }, required: [] },
    },
    {
        name: "sitrec_guide",
        description:
            "Get the Sitrec MCP Agent Guide — a comprehensive reference for the node system, " +
            "API functions, data structures, views, cameras, tracks, menus, and common patterns. " +
            "Read this first before interacting with Sitrec to avoid repeated trial-and-error inspection.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
];

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
    { name: "sitrec-bridge", version: "1.1.0" },
    { capabilities: { tools: {}, resources: {} } }
);

// ── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    let args;
    try {
        args = normalizeTabArgs(rawArgs);
    } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }

    // sitrec_status is handled locally — no extension needed
    if (name === "sitrec_status") {
        const connected = !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN);
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    pairedOrigin: PAIRED_ORIGIN,
                    boundPort,
                    bound: boundPort !== null,
                    protocolVersion: PROTOCOL_VERSION,
                    extensionConnected: connected,
                    pendingRequests: pendingRequests.size,
                    everUsed,
                    isActiveFallback,
                    lastMcpActivityAt,
                    idleTimeoutMs: IDLE_TIMEOUT_MS,
                    cwd: SITREC_CWD,
                }, null, 2),
            }],
        };
    }

    // sitrec_diagnostics is answered locally — it has to work when the extension does not.
    if (name === "sitrec_diagnostics") {
        const limit = Number(args?.limit) > 0 ? Math.floor(args.limit) : 60;
        // readLog does one file read per day, so `days` drives a loop. Clamp it: an oversized value
        // (a typo, or a model picking a big number) would otherwise spin the bridge for effectively
        // ever — a debugging tool must never be able to hang the thing being debugged. Logs are
        // pruned after a week anyway, so 30 is already more than exists.
        const days = Math.min(30, Math.max(1, Math.floor(Number(args?.days) || 1)));

        const ports = [];
        for (let port = FALLBACK_PORT_MIN; port <= FALLBACK_PORT_MAX; port++) ports.push(port);
        const peers = (await Promise.all(ports.map(getBridgeControlStatus)))
            .filter(Boolean)
            .map((status) => ({
                port: status.port,
                pid: status.pid,
                self: status.pid === process.pid,
                parentPid: status.parentPid,
                parentCommand: status.parentCommand || null,
                pairedOrigin: status.pairedOrigin,
                everUsed: !!status.everUsed,
                busy: !!status.busy,
                isActiveFallback: !!status.isActiveFallback,
                extensionConnected: !!status.extensionConnected,
                localComputeClients: status.localComputeClients ?? null,
                ageMinutes: Math.round((Date.now() - (status.startedAt ?? Date.now())) / 60000),
                idleMinutes: status.lastRelayAt
                    ? Math.round((Date.now() - status.lastRelayAt) / 60000)
                    : null,
            }));

        // Only ask the extension if we already hold a port and a live socket. Going through
        // sendToExtension would acquire a port and mark this bridge "used" — a diagnostic must not
        // change the thing it is measuring.
        let extensionLog = null;
        if (args?.includeExtension === false) {
            extensionLog = {skipped: "includeExtension=false"};
        } else if (boundPort === null) {
            extensionLog = {unavailable: "this bridge currently holds no port (released while idle)"};
        } else if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            extensionLog = {unavailable: "extension is not connected to this bridge"};
        } else {
            try {
                const response = await relayRaw("sitrec_diag_log", {limit}, 5000);
                extensionLog = response.result ?? response;
            } catch (e) {
                extensionLog = {error: e.message};
            }
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    self: {
                        pid: process.pid,
                        parentPid: process.ppid,
                        parentCommand: PARENT_COMMAND,
                        cwd: SITREC_CWD,
                        boundPort,
                        bound: boundPort !== null,
                        everUsed,
                        isActiveFallback,
                        extensionConnected: !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
                        pendingRequests: pendingRequests.size,
                        localComputeClients: localComputeSockets.size,
                        uptimeMinutes: Math.round((Date.now() - STARTED_AT) / 60000),
                        idleMinutes: Math.round((Date.now() - lastRelayAt) / 60000),
                        protocolVersion: PROTOCOL_VERSION,
                    },
                    portPool: {
                        range: `${FALLBACK_PORT_MIN}-${FALLBACK_PORT_MAX}`,
                        held: peers.length,
                        capacity: FALLBACK_PORT_MAX - FALLBACK_PORT_MIN + 1,
                        neverUsed: peers.filter((p) => !p.everUsed).length,
                        peers,
                    },
                    logDir: diag.LOG_DIR,
                    serverEvents: diag.recent(limit),
                    crossSessionLog: await diag.readLog({limit, days}),
                    extensionLog,
                }, null, 2),
            }],
        };
    }

    // sitrec_list_tabs is relayed to extension (needs chrome.tabs API)
    if (name === "sitrec_list_tabs") {
        try {
            const response = await sendToExtension("sitrec_list_tabs", {});
            return {
                content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    }

    // sitrec_guide is handled locally — returns the agent guide markdown
    if (name === "sitrec_guide") {
        return {
            content: [{ type: "text", text: agentGuide }],
        };
    }

    // sitrec_reload_extension — fire a reload command at the connected extension.
    // This must acquire a port like any other relay. It is the documented recovery action, so a
    // bridge that had released its port must not answer "nothing to reload" and leave the user
    // stuck; that would make the one command meant to fix things the one command that cannot.
    if (name === "sitrec_reload_extension") {
        try {
            await ensureRelayReady();
        } catch (e) {
            return {content: [{type: "text", text: `Error: ${e.message}`}], isError: true};
        }
        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
            return {
                content: [{ type: "text", text: "Extension not connected. Nothing to reload." }],
                isError: true,
            };
        }
        extensionSocket.send(JSON.stringify({ id: ++requestCounter, action: "reload" }));
        return {
            content: [{ type: "text", text: "Extension reloading. It will reconnect automatically in a few seconds." }],
        };
    }

    try {
        const response = await sendToExtension(name, args || {});

        // Build assert warning text if any asserts fired during this call
        let assertText = "";
        const asserts = response.result?.asserts;
        if (asserts && asserts.length > 0) {
            assertText = "\n\n⚠️ ASSERT(S) FIRED DURING THIS CALL:\n" +
                asserts.map((a, i) => `[${i + 1}] ${a.message}\n${a.stack}`).join("\n\n");
        }

        if (response.error) {
            return {
                content: [{ type: "text", text: `Error: ${response.error}${assertText}` }],
                isError: true,
            };
        }

        // Image responses: save to temp file AND return inline for Claude to see
        const isImageResult = (name === "sitrec_screenshot" || name === "sitrec_get_video_frame")
            && response.result?.imageData;
        if (isImageResult) {
            const mimeType = response.result.mimeType || "image/jpeg";
            const ext = mimeType.includes("png") ? "png" : "jpg";
            const prefix = name === "sitrec_get_video_frame" ? "sitrec-videoframe" : "sitrec-screenshot";
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const tmpDir = process.env.TMPDIR || "/tmp";
            const filePath = join(tmpDir, `${prefix}-${timestamp}.${ext}`);

            // Save full-resolution image to temp file for persistence
            const {writeFileSync} = await import("fs");
            writeFileSync(filePath, Buffer.from(response.result.imageData, "base64"));

            let caption = `Screenshot saved to: ${filePath}`;
            if (name === "sitrec_get_video_frame") {
                const f = response.result.frame;
                const w = response.result.width;
                const h = response.result.height;
                caption = `Video frame ${f} (${w}×${h}) saved to: ${filePath}`;
            }
            const content = [{
                type: "image",
                data: response.result.imageData,
                mimeType,
            }, {
                type: "text",
                text: caption,
            }];
            if (assertText) {
                content.push({ type: "text", text: assertText });
            }
            return { content };
        }

        // Remove asserts from the result before serializing (already extracted above)
        const resultToShow = response.result;
        if (resultToShow && typeof resultToShow === "object") {
            delete resultToShow.asserts;
        }

        const text = typeof resultToShow === "string"
            ? resultToShow
            : JSON.stringify(resultToShow, null, 2);

        return { content: [{ type: "text", text: text + assertText }] };
    } catch (e) {
        return {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
        };
    }
});

// ── Resource Handlers ───────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: "sitrec://sitch/current",
            name: "Current Sitch",
            description: "The currently loaded situation in Sitrec",
            mimeType: "application/json",
        },
        {
            uri: "sitrec://nodes",
            name: "Node Graph",
            description: "All nodes in the current Sitrec node graph",
            mimeType: "application/json",
        },
        {
            uri: "sitrec://guide",
            name: "Agent Guide",
            description: "Comprehensive reference for AI agents interacting with Sitrec",
            mimeType: "text/markdown",
        },
    ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
        let action;
        let params = {};

        if (uri === "sitrec://guide") {
            return {
                contents: [{ uri, mimeType: "text/markdown", text: agentGuide }],
            };
        }

        if (uri === "sitrec://sitch/current") {
            action = "sitrec_get_sitch";
        } else if (uri === "sitrec://nodes") {
            action = "sitrec_list_nodes";
        } else {
            return {
                contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }],
            };
        }

        const response = await sendToExtension(action, params);
        return {
            contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify(response.result, null, 2),
            }],
        };
    } catch (e) {
        return {
            contents: [{ uri, mimeType: "text/plain", text: `Error: ${e.message}` }],
        };
    }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
    diag.setContext({pid: process.pid, ppid: process.ppid, cwd: SITREC_CWD, paired: PAIRED_ORIGIN});
    diag.record("start", {protocolVersion: PROTOCOL_VERSION, node: process.version});
    captureParentCommand();

    await start();

    if (!PAIRED_ORIGIN) {
        setInterval(() => {
            releaseCheck().catch((e) => diag.record("release-check-error", {error: e?.message}));
        }, RELEASE_CHECK_INTERVAL_MS).unref();
    }

    const transport = new StdioServerTransport();
    transport.onmessage = () => {
        lastMcpActivityAt = Date.now();
    };
    transport.onclose = () => shutdownGracefully("MCP stdio transport closed");
    await server.connect(transport);
    log("MCP server running (stdio transport)");
}

main().catch((e) => {
    log("Fatal error:", e);
    process.exit(1);
});
