import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(TEST_DIR, "..", "mcp-server.js");

function startBridge(idleTimeoutMs, port = 0) {
    return spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            SITREC_BRIDGE_PORT: String(port),
            SITREC_BRIDGE_FALLBACK_PORT_MIN: String(port),
            SITREC_BRIDGE_FALLBACK_PORT_MAX: String(port),
            SITREC_BRIDGE_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}

async function waitForListening(child) {
    return new Promise((resolve, reject) => {
        let stderr = "";
        const onData = (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/Listening on ws:\/\/127\.0\.0\.1:(\d+)/);
            if (match) {
                child.stderr.off("data", onData);
                child.off("exit", onExit);
                resolve(Number(match[1]));
            }
        };
        const onExit = () => {
            child.stderr.off("data", onData);
            reject(new Error(`Bridge exited before listening:\n${stderr}`));
        };
        child.stderr.on("data", onData);
        child.once("exit", onExit);
    });
}

async function waitForExit(child) {
    if (child.exitCode !== null) return child.exitCode;
    const [code] = await once(child, "exit");
    return code;
}

async function findFreePort() {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const {port} = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("bridge exits after its MCP transport is idle", {timeout: 5000}, async () => {
    const child = startBridge(200);
    await waitForListening(child);
    assert.equal(await waitForExit(child), 0);
});

test("an MCP message renews the idle timeout", {timeout: 5000}, async (t) => {
    const child = startBridge(600);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);
    await delay(350);
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
    }) + "\n");
    await delay(350);
    assert.equal(child.exitCode, null);
    assert.equal(await waitForExit(child), 0);
});

test("local takeover requires the per-process control token", {timeout: 5000}, async (t) => {
    const child = startBridge(5000);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    const port = await waitForListening(child);

    const statusResponse = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.service, "SitrecBridge");

    const forbidden = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/shutdown`, {method: "POST"});
    assert.equal(forbidden.status, 403);

    const accepted = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/shutdown`, {
        method: "POST",
        headers: {"X-Sitrec-Bridge-Token": status.controlToken},
    });
    assert.equal(accepted.status, 202);
    assert.equal(await waitForExit(child), 0);
});

test("a full fallback range takes a port from an idle bridge WITHOUT killing it", {timeout: 8000}, async (t) => {
    // This used to assert that the loser exited. It no longer does, and that is the fix: killing
    // the loser destroyed a live session's bridge and forced the user to reconnect. Now it yields
    // the port and stays alive to re-acquire one later.
    const port = await findFreePort();
    const first = startBridge(30000, port);
    let second = null;
    t.after(() => {
        if (first.exitCode === null) first.kill("SIGTERM");
        if (second?.exitCode === null) second.kill("SIGTERM");
    });

    assert.equal(await waitForListening(first), port);
    second = startBridge(30000, port);
    assert.equal(await waitForListening(second), port);

    // The port changed hands...
    const owner = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/status`).then((r) => r.json());
    assert.equal(owner.pid, second.pid, "the new bridge should own the port");

    // ...and the bridge that gave it up is still running.
    await delay(200);
    assert.equal(first.exitCode, null, "yielding a port must not kill the bridge");

    first.kill("SIGTERM");
    second.kill("SIGTERM");
    assert.equal(await waitForExit(first), 0);
    assert.equal(await waitForExit(second), 0);
});

// ── Port lease ──────────────────────────────────────────────────────────────

function startLeaseBridge(port, extraEnv = {}) {
    return spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            SITREC_BRIDGE_PORT: String(port),
            SITREC_BRIDGE_FALLBACK_PORT_MIN: String(port),
            SITREC_BRIDGE_FALLBACK_PORT_MAX: String(port),
            SITREC_BRIDGE_IDLE_TIMEOUT_MS: "60000",
            // Keep the automatic reaper out of the way; these tests drive release explicitly.
            SITREC_BRIDGE_UNUSED_RELEASE_MS: "600000",
            SITREC_BRIDGE_IDLE_RELEASE_MS: "600000",
            SITREC_BRIDGE_LOG_DIR: join(TEST_DIR, "..", ".test-logs"),
            ...extraEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}

async function status(port) {
    const response = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/status`);
    return response.json();
}

async function portIsFree(port) {
    const server = createServer();
    try {
        server.listen(port, "127.0.0.1");
        await once(server, "listening");
        await new Promise((resolve) => server.close(resolve));
        return true;
    } catch {
        return false;
    }
}

test("releasing a port frees it WITHOUT killing the bridge", {timeout: 10000}, async (t) => {
    // The old behaviour was to shut the loser down, which permanently destroyed that session's
    // bridge and forced the user to reconnect. A release has to be survivable.
    const port = await findFreePort();
    const child = startLeaseBridge(port);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);

    const {controlToken} = await status(port);
    const released = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/release`, {
        method: "POST",
        headers: {"X-Sitrec-Bridge-Token": controlToken},
    });
    assert.equal(released.status, 202);

    // The listener goes away...
    let free = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !free) {
        free = await portIsFree(port);
        if (!free) await delay(50);
    }
    assert.equal(free, true, "released port should become bindable");

    // ...but the process does not.
    assert.equal(child.exitCode, null, "bridge must survive releasing its port");
});

test("release requires the control token", {timeout: 10000}, async (t) => {
    const port = await findFreePort();
    const child = startLeaseBridge(port);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);

    const forbidden = await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/release`, {method: "POST"});
    assert.equal(forbidden.status, 403);
    assert.equal((await status(port)).bound, true);
});

test("a released bridge re-acquires a port when work arrives", {timeout: 25000}, async (t) => {
    const port = await findFreePort();
    const child = startLeaseBridge(port);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);

    const {controlToken} = await status(port);
    await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/release`, {
        method: "POST",
        headers: {"X-Sitrec-Bridge-Token": controlToken},
    });
    await delay(300);
    assert.equal(await portIsFree(port), true);

    // A tool call that needs the browser must transparently take a port again. There is no
    // extension in this test, so the call itself will fail — the point is that the port comes back.
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "test", version: "1"}},
    }) + "\n");
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {name: "sitrec_list_tabs", arguments: {}},
    }) + "\n");

    let rebound = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !rebound) {
        try {
            rebound = (await status(port)).bound === true;
        } catch {
            // Not listening yet.
        }
        if (!rebound) await delay(100);
    }
    assert.equal(rebound, true, "bridge should re-acquire a port for a tool call");
});

test("a full range no longer kills the bridge at startup", {timeout: 15000}, async () => {
    // Previously this called process.exit(1), leaving the session with a dead MCP server for good.
    const port = await findFreePort();
    const blocker = createServer();
    blocker.on("connection", (socket) => socket.destroy());
    blocker.listen(port, "127.0.0.1");
    await once(blocker, "listening");

    const child = startLeaseBridge(port);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !/Staying alive without one/.test(stderr)) {
            if (child.exitCode !== null) break;
            await delay(100);
        }
        assert.equal(child.exitCode, null, `bridge should stay alive unbound, stderr:\n${stderr}`);
        assert.match(stderr, /Staying alive without one/);
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGTERM");
            await waitForExit(child);
        }
        await new Promise((resolve) => blocker.close(resolve));
    }
});

test("sitrec_reload_extension re-acquires a port instead of giving up", {timeout: 25000}, async (t) => {
    // Regression: this handler used to read extensionSocket directly, so on a bridge that had
    // released its port it answered "Extension not connected. Nothing to reload." forever — making
    // the documented recovery command the one command that could not recover anything.
    const port = await findFreePort();
    const child = startLeaseBridge(port);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);

    const {controlToken} = await status(port);
    await fetch(`http://127.0.0.1:${port}/__sitrec_bridge/release`, {
        method: "POST",
        headers: {"X-Sitrec-Bridge-Token": controlToken},
    });
    await delay(300);
    assert.equal(await portIsFree(port), true, "port should be released before the test starts");

    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "test", version: "1"}},
    }) + "\n");
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {name: "sitrec_reload_extension", arguments: {}},
    }) + "\n");

    let rebound = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !rebound) {
        try {
            rebound = (await status(port)).bound === true;
        } catch {
            // Not listening yet.
        }
        if (!rebound) await delay(100);
    }
    assert.equal(rebound, true, "sitrec_reload_extension should take a port again");
});

test("sitrec_diagnostics survives an absurd days value instead of hanging", {timeout: 25000}, async (t) => {
    // Regression: `days` drives one file read per iteration, so an unclamped huge value spun the
    // bridge forever. A debugging tool must never be able to hang the thing being debugged.
    const port = await findFreePort();
    const child = startLeaseBridge(port);
    t.after(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
    });
    await waitForListening(child);

    let stdout = "";
    const gotResponse = new Promise((resolve) => {
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            for (const line of stdout.split("\n")) {
                if (!line.trim()) continue;
                try {
                    if (JSON.parse(line).id === 2) resolve(true);
                } catch {
                    // Partial line.
                }
            }
        });
    });

    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "test", version: "1"}},
    }) + "\n");
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {name: "sitrec_diagnostics", arguments: {days: 1e308, includeExtension: false}},
    }) + "\n");

    const answered = await Promise.race([
        gotResponse,
        delay(18000).then(() => false),
    ]);
    assert.equal(answered, true, "sitrec_diagnostics should answer promptly, not spin");
});
