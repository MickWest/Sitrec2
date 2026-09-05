import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createDevBrowser} from "../extension/dev-browser.js";
import {developmentManifest} from "../build-extension.mjs";

function fixture(enabled = true) {
    const calls = [];
    const listeners = {};
    const tab = {id: 7, windowId: 3, url: "https://example.test/", active: false};
    const chrome = {
        tabs: {
            query: async () => [tab],
            get: async id => { if (id !== 7) throw new Error("No tab"); return tab; },
            create: async p => { calls.push(["create", p]); return {...tab, ...p}; },
            update: async (id, p) => { calls.push(["update", id, p]); return {...tab, ...p}; },
            reload: async (...p) => calls.push(["reload", ...p]),
            remove: async (...p) => calls.push(["remove", ...p]),
        },
        windows: {update: async (...p) => calls.push(["window", ...p])},
        runtime: {getURL: path => `chrome-extension://test/${path}`},
        debugger: {
            attach: async (...p) => calls.push(["attach", ...p]),
            detach: async (...p) => calls.push(["detach", ...p]),
            sendCommand: async (target, method, params) => {
                calls.push([method, target, params]);
                if (method === "Page.getLayoutMetrics") return {
                    cssContentSize: {x: 0, y: 0, width: 2400, height: 6000},
                    cssVisualViewport: {pageX: 10, pageY: 20, clientWidth: 1200, clientHeight: 800},
                };
                if (method === "Page.captureScreenshot") return {data: "jpeg"};
                return {result: {type: "number", value: 42}};
            },
            onEvent: {addListener: f => listeners.event = f},
            onDetach: {addListener: f => listeners.detach = f},
        },
    };
    return {handle: createDevBrowser(chrome, enabled), calls, listeners, chrome};
}

test("standard extension rejects browser commands before accessing Chrome APIs", async () => {
    const handle = createDevBrowser({}, false);
    for (const action of ["browser_tabs", "browser_tab", "browser_screenshot", "browser_cdp", "browser_desktop_capture"]) {
        await assert.rejects(handle(action, {}), /require.*Dev extension/);
    }
});

test("Dev manifest adds browser permissions without expanding page injection or changing standard manifest", () => {
    const base = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url)));
    const before = JSON.stringify(base);
    const dev = developmentManifest(base);
    assert.equal(JSON.stringify(base), before);
    assert.deepEqual(dev.content_scripts, base.content_scripts);
    assert.deepEqual(dev.web_accessible_resources, base.web_accessible_resources);
    assert.deepEqual(dev.host_permissions, ["<all_urls>"]);
    assert.ok(dev.permissions.includes("debugger"));
    assert.ok(dev.permissions.includes("desktopCapture"));
    assert.ok(!base.permissions.includes("debugger"));
});

test("open defaults to background and preserves explicit window", async () => {
    const {handle, calls} = fixture();
    await handle("browser_tab", {action: "open", url: "https://example.test/", windowId: 10});
    assert.deepEqual(calls, [["create", {url: "https://example.test/", active: false, windowId: 10}]]);
});

test("mutations and screenshots reject missing, ambiguous, closed and executable targets", async () => {
    const {handle, calls} = fixture();
    for (const tab of [undefined, "example", "7", -1, 8]) {
        await assert.rejects(handle("browser_tab", {action: "close", tab}));
        await assert.rejects(handle("browser_screenshot", {tab}));
    }
    await assert.rejects(handle("browser_tab", {action: "open", url: "javascript:alert(1)"}), /HTTP/);
    await assert.rejects(handle("browser_tab", {action: "navigate", tab: 7, url: "chrome://settings"}), /HTTP/);
    assert.deepEqual(calls, []);
});

test("full-page capture uses document bounds, defaults to JPEG and detaches", async () => {
    const {handle, calls} = fixture();
    const result = await handle("browser_screenshot", {tab: 7, fullPage: true});
    const capture = calls.find(c => c[0] === "Page.captureScreenshot");
    assert.equal(result.mimeType, "image/jpeg");
    assert.deepEqual(capture[2], {format: "jpeg", quality: 75, captureBeyondViewport: true,
        clip: {x: 0, y: 0, width: 2400, height: 6000, scale: 0.8}});
    assert.equal(calls.at(-1)[0], "detach");
    assert.ok(!calls.some(c => ["update", "Emulation.setDeviceMetricsOverride"].includes(c[0])));
});

test("viewport capture uses current scroll origin and retains an existing debug session", async () => {
    const {handle, calls} = fixture();
    await handle("browser_eval", {tab: 7, expression: "42"});
    await handle("browser_screenshot", {tab: 7});
    assert.deepEqual(calls.find(c => c[0] === "Page.captureScreenshot")[2].clip,
        {x: 10, y: 20, width: 1200, height: 800, scale: 1});
    assert.ok(!calls.some(c => c[0] === "detach"));
    await handle("browser_debugger_detach", {tab: 7});
    assert.equal(calls.at(-1)[0], "detach");
});

test("capture failure releases a newly attached debugger", async () => {
    const {handle, chrome, calls} = fixture();
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (...args) => {
        if (args[1] === "Page.captureScreenshot") throw new Error("capture failed");
        return send(...args);
    };
    await assert.rejects(handle("browser_screenshot", {tab: 7}), /capture failed/);
    assert.equal(calls.at(-1)[0], "detach");
});

test("concurrent capture and input serialize their debugger lifetimes", async () => {
    const {handle, calls} = fixture();
    await Promise.all([
        handle("browser_screenshot", {tab: 7}),
        handle("browser_cdp", {tab: 7, method: "Input.dispatchMouseEvent", params: {type: "mouseMoved", x: 1, y: 2}}),
    ]);
    assert.deepEqual(calls.filter(c => ["attach", "detach", "Input.dispatchMouseEvent"].includes(c[0])).map(c => c[0]),
        ["attach", "detach", "attach", "Input.dispatchMouseEvent"]);
});

test("events are bounded, oversized events counted and clear semantics honored", async () => {
    const {handle, listeners} = fixture();
    await handle("browser_events", {tab: 7});
    for (let i = 0; i < 205; i++) listeners.event({tabId: 7}, "Log.entryAdded", {i});
    listeners.event({tabId: 7}, "Log.entryAdded", {text: "x".repeat(40000)});
    const result = await handle("browser_events", {tab: 7, clear: false, limit: 200});
    assert.equal(result.events.length, 200);
    assert.equal(result.dropped, 6);
    assert.equal(result.events[0].params.i, 5);
    assert.equal((await handle("browser_events", {tab: 7})).events.length, 100);
    assert.equal((await handle("browser_events", {tab: 7})).events.length, 0);
});

test("evaluation reports JavaScript exceptions", async () => {
    const {handle, chrome} = fixture();
    chrome.debugger.sendCommand = async () => ({exceptionDetails: {exception: {description: "Error: expected failure"}}});
    await assert.rejects(handle("browser_eval", {tab: 7, expression: "throw Error('expected failure')"}), /expected failure/);
});
