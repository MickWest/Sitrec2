// Called only from the background's MCP socket handler, never from a web page.
export function createDevBrowser(chrome, enabled) {
    const sessions = new Map();
    const queues = new Map();
    const desktopURL = () => chrome.runtime.getURL("desktop-capture.html");
    const integer = (value, fallback, min, max, name) => {
        value ??= fallback;
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
        return value;
    };
    const tabId = p => integer(p.tab, undefined, 1, Number.MAX_SAFE_INTEGER, "tab ID (use browser_tabs)");
    const imageOptions = p => ({
        quality: integer(p.quality, 75, 1, 100, "quality"),
        maxWidth: integer(p.maxWidth, 1920, 1, 8192, "maxWidth"),
    });
    const summarize = t => ({id: t.id, windowId: t.windowId, url: t.url, title: t.title,
        active: t.active, status: t.status, pinned: t.pinned, incognito: t.incognito});
    function navigationURL(url) {
        const parsed = new URL(url);
        if (!["https:", "http:", "file:"].includes(parsed.protocol) && url !== "about:blank") {
            throw new Error("Use an HTTP(S), file URL, or about:blank.");
        }
        return parsed.href;
    }
    async function debugTab(id) {
        const tab = await chrome.tabs.get(id); // Never fall back if it was closed.
        navigationURL(tab.url);
        if (!sessions.has(id)) {
            await chrome.debugger.attach({tabId: id}, "1.3");
            sessions.set(id, {events: [], bytes: 0, dropped: 0});
            try {
                await command(id, "Runtime.enable");
                await command(id, "Log.enable");
            } catch (error) {
                await detach(id);
                throw error;
            }
        }
    }
    const command = (id, method, params = {}) => chrome.debugger.sendCommand({tabId: id}, method, params);
    async function detach(id) {
        if (sessions.has(id)) {
            try { await chrome.debugger.detach({tabId: id}); }
            finally { sessions.delete(id); }
        }
        return {ok: true, tab: id, attached: false};
    }
    // A screenshot and an input command must not race an attach/detach on the same tab.
    async function serialized(id, fn) {
        const previous = queues.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(fn);
        queues.set(id, next);
        try { return await next; }
        finally { if (queues.get(id) === next) queues.delete(id); }
    }
    if (enabled) {
        chrome.debugger.onDetach.addListener(source => sessions.delete(source.tabId));
        chrome.debugger.onEvent.addListener((source, method, params) => {
            const session = sessions.get(source.tabId);
            if (!session) return;
            const event = {time: Date.now(), method, params};
            const size = JSON.stringify(event).length;
            if (size > 32768) { session.dropped++; return; }
            session.events.push({event, size});
            session.bytes += size;
            while (session.events.length > 200 || session.bytes > 512000) {
                session.bytes -= session.events.shift().size;
                session.dropped++;
            }
        });
    }
    async function desktop(p) {
        const pages = await chrome.tabs.query({url: desktopURL()});
        if (p.action === "start") {
            const page = pages[0] || await chrome.tabs.create({url: desktopURL(), active: true});
            if (pages[0]) await chrome.tabs.update(page.id, {active: true});
            return {tab: page.id, status: "select-source", message: "Choose a screen or window in the capture tab. Then call capture. Sharing continues until Stop sharing or stop."};
        }
        if (!["status", "capture", "stop"].includes(p.action)) throw new Error("Invalid desktop capture action");
        if (!pages.length) {
            if (p.action === "capture") throw new Error("No shared screen. Call start and select a source first.");
            return {status: "stopped"};
        }
        const result = await chrome.runtime.sendMessage({type: "dev-desktop-command", action: p.action, ...imageOptions(p)});
        if (!result) throw new Error("Capture page is starting; retry shortly.");
        if (result.error) throw new Error(result.error);
        return result;
    }
    return async function handle(action, p = {}) {
        if (!enabled) throw new Error("Browser tools require the SitrecBridge Dev extension. Disable the regular extension and load the Dev build.");
        if (action === "browser_tabs") return (await chrome.tabs.query({})).map(summarize);
        if (action === "browser_desktop_capture") return serialized("desktop", () => desktop(p));
        if (action === "browser_tab") {
            if (p.action === "open") return summarize(await chrome.tabs.create({url: navigationURL(p.url), active: p.active ?? false,
                ...(p.windowId === undefined ? {} : {windowId: p.windowId})}));
            const id = tabId(p);
            const tab = await chrome.tabs.get(id);
            switch (p.action) {
                case "navigate": return summarize(await chrome.tabs.update(id, {url: navigationURL(p.url)}));
                case "activate":
                    await chrome.windows.update(tab.windowId, {focused: true});
                    return summarize(await chrome.tabs.update(id, {active: true}));
                case "reload": await chrome.tabs.reload(id, {bypassCache: p.bypassCache ?? false}); break;
                case "close": await chrome.tabs.remove(id); break;
                case "back": await chrome.tabs.goBack(id); break;
                case "forward": await chrome.tabs.goForward(id); break;
                default: throw new Error("Unknown browser_tab action");
            }
            return {ok: true, tab: id, action: p.action};
        }
        const id = tabId(p);
        return serialized(id, async () => {
            if (action === "browser_debugger_detach") return detach(id);
            const hadSession = sessions.has(id);
            if (action === "browser_screenshot") {
                const {quality, maxWidth} = imageOptions(p);
                await debugTab(id);
                try {
                    const metrics = await command(id, "Page.getLayoutMetrics");
                    const rect = p.fullPage ? metrics.cssContentSize : metrics.cssVisualViewport;
                    const width = rect.width ?? rect.clientWidth;
                    const height = rect.height ?? rect.clientHeight;
                    // Bound pathological/infinite documents by both width and total pixel count.
                    const scale = Math.min(1, maxWidth / width, Math.sqrt(16000000 / (width * height)), 16384 / height);
                    const {data} = await command(id, "Page.captureScreenshot", {
                        format: "jpeg", quality, captureBeyondViewport: !!p.fullPage,
                        clip: {x: rect.x ?? rect.pageX, y: rect.y ?? rect.pageY, width, height, scale},
                    });
                    return {imageData: data, mimeType: "image/jpeg", tab: id, fullPage: !!p.fullPage};
                } finally { if (!hadSession) await detach(id); }
            }
            if (!["browser_eval", "browser_cdp", "browser_events"].includes(action)) throw new Error(`Unknown development tool: ${action}`);
            await debugTab(id);
            if (action === "browser_events") {
                const session = sessions.get(id);
                const limit = integer(p.limit, 100, 1, 200, "limit");
                const result = {events: session.events.slice(-limit).map(e => e.event), dropped: session.dropped};
                if (p.clear !== false) { session.events = []; session.bytes = 0; session.dropped = 0; }
                return result;
            }
            if (action === "browser_cdp") {
                if (typeof p.method !== "string" || !/^\w+\.\w+$/.test(p.method)) throw new Error("Use a CDP Domain.method name");
                return command(id, p.method, p.params);
            }
            if (typeof p.expression !== "string") throw new Error("expression must be a string");
            const timeoutMs = integer(p.timeoutMs, 10000, 1, 20000, "timeoutMs");
            let timer;
            const timeoutError = new Error(`Evaluation timed out after ${timeoutMs}ms; debugger session released.`);
            let result;
            try {
                // CDP's execution timeout alone does not bound an unresolved awaited promise.
                result = await Promise.race([
                    command(id, "Runtime.evaluate", {expression: p.expression, awaitPromise: true,
                        returnByValue: true, timeout: timeoutMs}),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); }),
                ]);
            } catch (error) {
                if (error === timeoutError) await detach(id).catch(() => {});
                throw error;
            } finally { clearTimeout(timer); }
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result;
        });
    };
}
