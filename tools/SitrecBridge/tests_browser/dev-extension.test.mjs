import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "node:http";
import {once} from "node:events";
import {chromium} from "playwright";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {buildExtension} from "../build-extension.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function bridge(t, dev) {
    const transport = new StdioClientTransport({command: process.execPath,
        args: [join(root, "mcp-server.js"), ...(dev ? ["--dev"] : [])], stderr: "pipe",
        env: {...process.env, SITREC_BRIDGE_DEV: "0", SITREC_BRIDGE_PORT: "0",
            SITREC_BRIDGE_FALLBACK_PORT_MIN: "0", SITREC_BRIDGE_FALLBACK_PORT_MAX: "0",
            SITREC_BRIDGE_IDLE_TIMEOUT_MS: "0"},
    });
    let log = "";
    const port = new Promise(resolve => transport.stderr.on("data", chunk => {
        log += chunk.toString();
        const match = log.match(/Listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(Number(match[1]));
    }));
    const client = new Client({name: "bridge-test", version: "1.0"});
    t.after(() => client.close());
    await client.connect(transport);
    return {client, port: await port};
}

test("standard MCP server neither advertises nor relays development tools", {timeout: 15000}, async t => {
    const {client} = await bridge(t, false);
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name.startsWith("browser_")));
    const result = await client.callTool({name: "browser_tabs", arguments: {}});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Dev server/);
});

test("development extension and MCP browser workflow", {timeout: 90000}, async t => {
    const {client, port} = await bridge(t, true);
    assert.equal((await client.listTools()).tools.filter(tool => tool.name.startsWith("browser_")).length, 8);
    const dir = mkdtempSync(join(tmpdir(), "sitrec-dev-extension-"));
    const extension = join(dir, "extension");
    buildExtension(join(root, "extension"), extension, true);
    const background = join(extension, "background.js");
    // Isolate discovery: this test browser must never replace a user's live bridge socket.
    writeFileSync(background, readFileSync(background, "utf8")
        .replace("const MCP_PORT_MIN = 9780;", `const MCP_PORT_MIN = ${port};`)
        .replace("const MCP_PORT_MAX = 9799;", `const MCP_PORT_MAX = ${port};`));
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
        channel: "chromium", headless: true, viewport: {width: 1000, height: 700}, deviceScaleFactor: 2,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    t.after(async () => { await context.close(); rmSync(dir, {recursive: true, force: true}); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).hostname;
    // Wait on the real relay, with no Sitrec tab open.
    const call = async (name, args = {}) => {
        const result = await client.callTool({name, arguments: args});
        assert.ok(!result.isError, JSON.stringify(result));
        if (result.content[0].type === "image") return result;
        return JSON.parse(result.content[0].text);
    };
    await call("browser_tabs");
    const web = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><title>Bridge fixture</title><style>body{margin:0;height:2600px;background:linear-gradient(#ff6600,#0033ff)}button{width:200px;height:80px}</style><button onclick="window.clicks=(window.clicks||0)+1">Click</button><input id="text"><script>window.loads=Date.now();addEventListener('touchstart',()=>window.touches=(window.touches||0)+1);</script>`);
    });
    web.listen(0, "127.0.0.1");
    await once(web, "listening");
    t.after(() => new Promise(resolve => web.close(resolve)));
    const url = `http://127.0.0.1:${web.address().port}/fixture`;
    const pagePromise = context.waitForEvent("page");
    const created = await call("browser_tab", {action: "open", url});
    const tab = created.id;
    // Observe readiness through the browser rather than assuming navigation has finished.
    const page = await pagePromise;
    assert.ok(page);
    await page.waitForFunction(() => document.querySelector("button"));
    assert.equal((await call("browser_eval", {tab, expression: "document.title"})).value, "Bridge fixture");
    await call("browser_eval", {tab, expression: "console.error('bridge-test-console'); 42"});
    const events = await call("browser_events", {tab});
    assert.ok(JSON.stringify(events).includes("bridge-test-console"));
    const exception = await client.callTool({name: "browser_eval", arguments: {tab, expression: "throw Error('bridge-test-error')"}});
    assert.equal(exception.isError, true);
    assert.match(exception.content[0].text, /bridge-test-error/);
    const timeout = await client.callTool({name: "browser_eval", arguments: {tab, expression: "new Promise(() => {})", timeoutMs: 100}});
    assert.equal(timeout.isError, true);
    assert.match(timeout.content[0].text, /timed out/);
    for (const type of ["mousePressed", "mouseReleased"]) await call("browser_cdp", {
        tab, method: "Input.dispatchMouseEvent", params: {type, x: 80, y: 40, button: "left", clickCount: 1},
    });
    assert.equal((await call("browser_eval", {tab, expression: "window.clicks"})).value, 1);
    await call("browser_eval", {tab, expression: "document.querySelector('input').focus()"});
    await call("browser_cdp", {tab, method: "Input.insertText", params: {text: "hello dev"}});
    assert.equal((await call("browser_eval", {tab, expression: "document.querySelector('input').value"})).value, "hello dev");
    await call("browser_cdp", {tab, method: "Emulation.setTouchEmulationEnabled", params: {enabled: true}});
    await call("browser_cdp", {tab, method: "Input.dispatchTouchEvent", params: {type: "touchStart", touchPoints: [{x: 50, y: 200}]}});
    await call("browser_cdp", {tab, method: "Input.dispatchTouchEvent", params: {type: "touchEnd", touchPoints: []}});
    assert.equal((await call("browser_eval", {tab, expression: "window.touches"})).value, 1);
    await call("browser_cdp", {tab, method: "Emulation.setTouchEmulationEnabled", params: {enabled: false}});
    const dimensions = async result => page.evaluate(async data => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
        const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
    }, result.content[0].data);
    const viewport = await call("browser_screenshot", {tab, maxWidth: 500});
    assert.deepEqual(await dimensions(viewport), [500, 350]);
    const fullPage = await call("browser_screenshot", {tab, fullPage: true, maxWidth: 500});
    assert.deepEqual(await dimensions(fullPage), [500, 1300]);
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1000, 700]);
    await call("browser_debugger_detach", {tab});

    // Exercise the actual capture-page lifecycle with a synthetic video source.
    // Native screen selection/OS consent is deliberately not automated by this test.
    await context.addInitScript(() => {
        if (!location.href.includes("desktop-capture.html")) return;
        chrome.desktopCapture.chooseDesktopMedia = (_sources, cb) => { setTimeout(() => cb("fixture-stream"), 0); return 1; };
        chrome.desktopCapture.cancelChooseDesktopMedia = () => {};
        navigator.mediaDevices.getUserMedia = async () => {
            const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
            const ctx = canvas.getContext("2d"); ctx.fillStyle = "#a04020"; ctx.fillRect(0, 0, 640, 480);
            window.testCaptureStream = canvas.captureStream(10);
            return window.testCaptureStream;
        };
    });
    const capturePagePromise = context.waitForEvent("page");
    await call("browser_desktop_capture", {action: "start"});
    const capturePage = await capturePagePromise;
    await capturePage.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Sharing is active"));
    assert.equal((await call("browser_desktop_capture", {action: "status"})).status, "sharing");
    const screen = await call("browser_desktop_capture", {action: "capture", maxWidth: 320});
    assert.deepEqual(await dimensions(screen), [320, 240]);
    await call("browser_desktop_capture", {action: "stop"});
    assert.equal(await capturePage.evaluate(() => window.testCaptureStream.getVideoTracks()[0].readyState), "ended");
    const stopped = await client.callTool({name: "browser_desktop_capture", arguments: {action: "capture"}});
    assert.equal(stopped.isError, true);
    await capturePage.evaluate(() => {
        chrome.desktopCapture.chooseDesktopMedia = (_sources, callback) => {
            setTimeout(() => callback(""), 0); return 2;
        };
    });
    await capturePage.locator("#start").click();
    await capturePage.waitForFunction(() => document.querySelector("#status").textContent === "No screen shared.");
    assert.equal((await call("browser_desktop_capture", {action: "status"})).status, "stopped");
    await capturePage.close();
    await call("browser_tab", {action: "navigate", tab, url: `${url}?next=1`});
    await page.waitForURL(`${url}?next=1`);
    await call("browser_tab", {action: "back", tab});
    await page.waitForURL(url);
    await call("browser_tab", {action: "forward", tab});
    await page.waitForURL(`${url}?next=1`);
    await call("browser_tab", {action: "activate", tab});
    assert.ok((await call("browser_tabs")).find(t => t.id === tab).active);
    await call("browser_tab", {action: "reload", tab, bypassCache: true});
    await page.waitForLoadState();
    await call("browser_tab", {action: "close", tab});
    const stale = await client.callTool({name: "browser_eval", arguments: {tab, expression: "1"}});
    assert.equal(stale.isError, true);
    assert.ok(extensionId);
});
