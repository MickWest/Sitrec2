// Browser-wide tools are advertised only by an explicitly enabled development server.
const tab = {type: "integer", minimum: 1, description: "Exact Chrome tab ID from browser_tabs. Required; never defaults to another tab."};
const quality = {type: "integer", minimum: 1, maximum: 100, default: 75};
const maxWidth = {type: "integer", minimum: 1, maximum: 8192, default: 1920};
const tool = (name, description, properties = {}, required = []) => ({
    name, description: `SitrecBridge Dev only. ${description}`,
    inputSchema: {type: "object", properties, required, additionalProperties: false},
});

export const DEV_TOOLS = [
    tool("browser_tabs", "List every browser tab, including non-Sitrec pages, with IDs, titles, URLs and window IDs."),
    tool("browser_tab", "Open, navigate, activate, reload, close, go back or go forward. Opening defaults to a background tab. Other operations require an exact tab ID. Navigation/reload/close can discard unsaved work.", {
        action: {type: "string", enum: ["open", "navigate", "activate", "reload", "close", "back", "forward"]},
        tab, url: {type: "string", description: "HTTP(S), file URL (requires Chrome file access), or about:blank."},
        active: {type: "boolean", default: false}, windowId: {type: "integer"}, bypassCache: {type: "boolean"},
    }, ["action"]),
    tool("browser_screenshot", "Capture a tab viewport or the entire scrollable page as JPEG, including page UI. No tab activation or viewport resizing. For browser chrome or the physical monitor use browser_desktop_capture.", {
        tab, fullPage: {type: "boolean", default: false}, quality, maxWidth,
    }, ["tab"]),
    tool("browser_eval", "Evaluate JavaScript in any web tab through DevTools. Awaits promises and returns JSON values; reports thrown exceptions. Leaves the debugger attached for subsequent calls; detach when finished.", {
        tab, expression: {type: "string"}, timeoutMs: {type: "integer", minimum: 1, maximum: 20000, default: 10000},
    }, ["tab", "expression"]),
    tool("browser_cdp", "Send a Chrome DevTools Protocol command to an exact tab. Supports DOM/Accessibility inspection, Input.dispatchMouseEvent/dispatchKeyEvent/dispatchTouchEvent, Input.insertText, Emulation touch/device settings, Network/Performance debugging and Page dialogs. Uses Chrome's supported debugger domains. The session persists until browser_debugger_detach; reset emulation/other overrides when done.", {
        tab, method: {type: "string"}, params: {type: "object", additionalProperties: true},
    }, ["tab", "method"]),
    tool("browser_events", "Read bounded DevTools console/error events from the attached session. Network and other events are available after enabling their CDP domain. No historical events before attachment. Clear after reading by default.", {
        tab, clear: {type: "boolean", default: true}, limit: {type: "integer", minimum: 1, maximum: 200, default: 100},
    }, ["tab"]),
    tool("browser_debugger_detach", "Release this extension's debugger session and buffered events for a tab. Use when finished, or before opening Chrome DevTools.", {tab}, ["tab"]),
    tool("browser_desktop_capture", "Capture an actual screen/window, including browser chrome. 'start' opens a capture control tab; the user chooses a source in Chrome's picker. Then use 'status' or 'capture' for JPEG frames while sharing remains active, and 'stop' to release it. Capture does not silently select or bypass screen permission.", {
        action: {type: "string", enum: ["start", "status", "capture", "stop"]}, quality, maxWidth,
    }, ["action"]),
];
