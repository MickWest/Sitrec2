import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {WebSocket} from "ws";

// A web page the user visits can open ws://127.0.0.1:<port>. The browser sets its Origin header and
// the page cannot change it, so the bridge must decide on that header who may become the extension.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(TEST_DIR, "..", "mcp-server.js");

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const HOSTILE_ORIGIN = "https://evil.example";
const SITREC_PAGE_ORIGIN = "http://localhost:8080"; // admitted for Local Compute only

async function startBridge(t) {
    const logDir = mkdtempSync(join(tmpdir(), "sitrec-bridge-origin-"));
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            SITREC_BRIDGE_PORT: "0",
            SITREC_BRIDGE_FALLBACK_PORT_MIN: "0",
            SITREC_BRIDGE_FALLBACK_PORT_MAX: "0",
            SITREC_BRIDGE_IDLE_TIMEOUT_MS: "30000",
            SITREC_BRIDGE_LOG_DIR: logDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill("SIGTERM");
            await once(child, "exit");
        }
        rmSync(logDir, {recursive: true, force: true});
    });

    const port = await new Promise((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/Listening on ws:\/\/127\.0\.0\.1:(\d+)/);
            if (match) resolve(Number(match[1]));
        });
        child.once("exit", () => reject(new Error(`Bridge exited before listening:\n${stderr}`)));
    });
    return port;
}

/** Open a socket as a browser at `origin` would. Resolves {ws, messages} or {refused: <error>}. */
function connect(t, port, origin) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? {origin} : {});
    t.after(() => ws.terminate());
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    return new Promise((resolve) => {
        ws.once("open", () => resolve({ws, messages}));
        ws.once("error", (error) => resolve({refused: error.message}));
    });
}

function waitForMessage(messages, type, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = setInterval(() => {
            const msg = messages.find((m) => m.type === type);
            if (msg) {
                clearInterval(poll);
                resolve(msg);
            } else if (Date.now() > deadline) {
                clearInterval(poll);
                reject(new Error(`No '${type}' message within ${timeoutMs}ms`));
            }
        }, 20);
    });
}

/** The close code, or null if the socket is still open after `timeoutMs`. */
function waitForClose(ws, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        ws.once("close", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

async function status(port) {
    return fetch(`http://127.0.0.1:${port}/__sitrec_bridge/status`).then((r) => r.json());
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("an upgrade from a web page origin is refused before any message", {timeout: 8000}, async (t) => {
    const port = await startBridge(t);
    const result = await connect(t, port, HOSTILE_ORIGIN);
    assert.match(result.refused ?? "upgrade was accepted", /Unexpected server response: 403/);
    assert.equal((await status(port)).extensionConnected, false);
});

test("a chrome-extension:// origin is accepted as the extension", {timeout: 8000}, async (t) => {
    const port = await startBridge(t);
    const ext = await connect(t, port, EXTENSION_ORIGIN);
    assert.ok(ext.ws, `extension upgrade refused: ${ext.refused}`);
    ext.ws.send(JSON.stringify({type: "force-extension"}));
    const info = await waitForMessage(ext.messages, "version-info");
    assert.equal(info.boundPort, port);
    assert.equal((await status(port)).extensionConnected, true);
});

test("force-extension from a refused origin never replaces the extension", {timeout: 8000}, async (t) => {
    const port = await startBridge(t);

    const ext = await connect(t, port, EXTENSION_ORIGIN);
    ext.ws.send(JSON.stringify({type: "force-extension"}));
    await waitForMessage(ext.messages, "version-info");
    let extensionClosed = false;
    ext.ws.on("close", () => { extensionClosed = true; });

    // A hostile page cannot even open the socket.
    const hostile = await connect(t, port, HOSTILE_ORIGIN);
    assert.ok(hostile.refused, "a hostile origin must not complete the upgrade");

    // A Sitrec page is admitted for Local Compute, but may not claim the extension role:
    // neither by asking for it, nor by staying silent past the identification window.
    for (const firstMessage of [{type: "force-extension"}, null]) {
        const page = await connect(t, port, SITREC_PAGE_ORIGIN);
        assert.ok(page.ws, `Sitrec page upgrade refused: ${page.refused}`);
        // A silent socket is identified after 500 ms; allow for that.
        const closed = waitForClose(page.ws, 1500);
        if (firstMessage) page.ws.send(JSON.stringify(firstMessage));
        assert.equal(await closed, 1008, "the server must close a page that claims the extension role");
        assert.equal(page.messages.some((m) => m.type === "version-info"), false,
            "the refused page must not receive the agent's working directory");
    }

    await delay(100);
    assert.equal(extensionClosed, false, "the real extension must stay connected");
    assert.equal(ext.ws.readyState, WebSocket.OPEN);
    assert.equal((await status(port)).extensionConnected, true);
});

test("Local Compute clients and local processes still connect", {timeout: 8000}, async (t) => {
    const port = await startBridge(t);

    for (const origin of [SITREC_PAGE_ORIGIN, EXTENSION_ORIGIN]) {
        const client = await connect(t, port, origin);
        assert.ok(client.ws, `${origin} upgrade refused: ${client.refused}`);
        client.ws.send(JSON.stringify({type: "local-compute-client", origin}));
        await waitForMessage(client.messages, "local-compute-hello");
    }

    // No Origin header: a local process, not a web page.
    const local = await connect(t, port, null);
    assert.ok(local.ws, `local process upgrade refused: ${local.refused}`);
    local.ws.send(JSON.stringify({type: "force-extension"}));
    await waitForMessage(local.messages, "version-info");
});
