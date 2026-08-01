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

test("a full fallback range reclaims an idle bridge instead of aborting", {timeout: 5000}, async (t) => {
    const port = await findFreePort();
    const first = startBridge(5000, port);
    let second = null;
    t.after(() => {
        if (first.exitCode === null) first.kill("SIGTERM");
        if (second?.exitCode === null) second.kill("SIGTERM");
    });

    assert.equal(await waitForListening(first), port);
    second = startBridge(5000, port);
    assert.equal(await waitForListening(second), port);
    assert.equal(await waitForExit(first), 0);

    second.kill("SIGTERM");
    assert.equal(await waitForExit(second), 0);
});
