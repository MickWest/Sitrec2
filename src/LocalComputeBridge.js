const LOCAL_COMPUTE_PORT_MIN = 9780;
const LOCAL_COMPUTE_PORT_MAX = 9799;
const LOCAL_COMPUTE_CONNECT_TIMEOUT_MS = 800;
const LOCAL_COMPUTE_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_COMPUTE_PORT_KEY = "sitrec.localCompute.port";
const LOCAL_COMPUTE_PROBE_PATH = "/local-compute-probe";
const LOCAL_COMPUTE_PREFERRED_PORTS = [9796];

let singleton = null;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function getLocalComputeBridge() {
    if (!singleton) singleton = new LocalComputeBridge();
    return singleton;
}

export class LocalComputeBridge {
    constructor() {
        this.ws = null;
        this.hello = null;
        this.port = null;
        this.pending = new Map();
        this.nextId = 1;
        this.connectPromise = null;
        this.lastError = null;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this.hello;
    }

    async connect() {
        if (this.connected) return this.hello;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this.scanPorts()
            .finally(() => {
                this.connectPromise = null;
            });
        return this.connectPromise;
    }

    async scanPorts() {
        this.close();
        this.lastError = null;

        for (const candidate of this.candidatePorts()) {
            const {port, probeFirst} = candidate;
            try {
                if (probeFirst && !await this.hasPortListener(port)) continue;
                const hello = await this.tryPort(port);
                if (hello?.capabilities?.motionAnalysis) {
                    this.rememberPort(port);
                    return hello;
                }
                this.close();
            } catch (e) {
                this.lastError = e.message;
                this.close();
                await wait(10);
            }
        }

        throw new Error(this.lastError || "No SitrecBridge Local Compute server found");
    }

    candidatePorts() {
        const ports = [];
        const seen = new Set();
        const addPort = (port, probeFirst = true) => {
            const n = this.normalizePort(port);
            if (n == null || seen.has(n)) return;
            seen.add(n);
            ports.push({port: n, probeFirst});
        };

        addPort(this.rememberedPort(), false);
        for (const port of this.hintedPorts()) addPort(port, false);
        for (const port of LOCAL_COMPUTE_PREFERRED_PORTS) addPort(port, false);

        for (let port = LOCAL_COMPUTE_PORT_MAX; port >= LOCAL_COMPUTE_PORT_MIN; port--) {
            addPort(port, true);
        }
        return ports;
    }

    normalizePort(port) {
        const n = Number(port);
        if (!Number.isInteger(n)) return null;
        if (n < LOCAL_COMPUTE_PORT_MIN || n > LOCAL_COMPUTE_PORT_MAX) return null;
        return n;
    }

    rememberedPort() {
        try {
            return localStorage.getItem(LOCAL_COMPUTE_PORT_KEY);
        } catch {
            return null;
        }
    }

    hintedPorts() {
        const hints = [];
        try {
            const url = new URL(window.location.href);
            hints.push(url.searchParams.get("localComputePort"));
            hints.push(url.searchParams.get("lcPort"));
        } catch {}

        const windowHints = window.__sitrecLocalComputePorts || window.__sitrecLocalComputePort;
        if (Array.isArray(windowHints)) {
            hints.push(...windowHints);
        } else {
            hints.push(windowHints);
        }
        return hints;
    }

    rememberPort(port) {
        try {
            localStorage.setItem(LOCAL_COMPUTE_PORT_KEY, String(port));
        } catch {}
    }

    async hasPortListener(port) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300);
        try {
            await fetch(`http://127.0.0.1:${port}${LOCAL_COMPUTE_PROBE_PATH}`, {
                mode: "no-cors",
                cache: "no-store",
                signal: controller.signal,
            });
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    tryPort(port) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let ws;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };

            const timer = setTimeout(() => {
                try { ws?.close(); } catch {}
                finish(reject, new Error(`Local Compute timeout on port ${port}`));
            }, LOCAL_COMPUTE_CONNECT_TIMEOUT_MS);

            try {
                ws = new WebSocket(`ws://127.0.0.1:${port}`);
            } catch (e) {
                finish(reject, e);
                return;
            }

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: "local-compute-client",
                    origin: window.location.origin,
                    href: window.location.href,
                    userAgent: navigator.userAgent,
                }));
            };

            ws.onmessage = (event) => {
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (msg.type === "local-compute-hello") {
                    this.ws = ws;
                    this.port = port;
                    this.hello = msg;
                    ws.onmessage = (e) => this.handleMessage(e);
                    ws.onclose = () => this.handleClose();
                    ws.onerror = () => this.handleClose();
                    finish(resolve, msg);
                } else if (msg.type === "local-compute-error") {
                    finish(reject, new Error(msg.error || "Local Compute rejected connection"));
                }
            };

            ws.onerror = () => finish(reject, new Error(`Local Compute connection failed on port ${port}`));
            ws.onclose = () => finish(reject, new Error(`Local Compute connection closed on port ${port}`));
        });
    }

    handleMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        if (msg.type === "local-compute-progress") {
            const pending = this.pending.get(msg.id);
            pending?.onProgress?.(msg.progress || {});
            return;
        }

        if (msg.type === "local-compute-response") {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.ok) {
                pending.resolve(msg.result);
            } else {
                pending.reject(new Error(msg.error || "Local Compute request failed"));
            }
        }
    }

    handleClose() {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const p of pending) {
            clearTimeout(p.timer);
            p.reject(new Error("Local Compute connection closed"));
        }
        this.ws = null;
        this.hello = null;
        this.port = null;
    }

    close() {
        if (this.ws) {
            try { this.ws.close(); } catch {}
        }
        this.handleClose();
    }

    async request(action, params, onProgress = null) {
        await this.connect();
        const id = `lc-${Date.now()}-${this.nextId++}`;
        const timer = setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            pending.reject(new Error(`Local Compute ${action} timed out`));
        }, LOCAL_COMPUTE_REQUEST_TIMEOUT_MS);

        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject, onProgress, timer});
        });

        this.ws.send(JSON.stringify({
            type: "local-compute-request",
            id,
            action,
            params,
        }));

        return promise;
    }

    installOrUpdate(onProgress = null) {
        return this.request("local_compute_install", {}, onProgress);
    }

    cancel(id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({type: "local-compute-cancel", id}));
    }
}
