// Fixed loopback endpoints: a page cannot turn this relay into an arbitrary fetch.
export async function requestSitMap(action, params = {}, fetchImpl = fetch) {
    const routes = {status: ["GET", "/v1/status"], view: ["POST", "/v1/view"], snapshot: ["POST", "/v1/snapshot"]};
    const route = routes[action];
    if (!route) throw new Error(`Unknown SitMap action: ${action}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === "snapshot" ? 45000 : 5000);
    try {
        const response = await fetchImpl(`http://127.0.0.1:9876${route[1]}`, {
            method: route[0], signal: controller.signal, redirect: "error", cache: "no-store",
            headers: {"Content-Type": "application/json", "X-SitMap-Client": "SitrecBridge-v1"},
            ...(route[0] === "POST" ? {body: JSON.stringify(params)} : {}),
        });
        const value = await response.json();
        if (!response.ok || value.error) throw new Error(value.error || `SitMap returned HTTP ${response.status}`);
        if (value.app !== "SitMap" || value.apiVersion !== 1) throw new Error("The listener on port 9876 is not SitMap API v1.");
        return value;
    } catch (error) {
        if (error.name === "TypeError") throw new Error("Cannot reach SitMap. Open SitMap.app on this Mac first.");
        throw error;
    } finally { clearTimeout(timer); }
}

// Two poses may be in flight, plus one pending replacement. A one-pose window
// stalls on the render-tick acknowledgement and can stay a whole frame behind.
// SitMap coalesces before applying; acknowledging N also retires superseded poses.
export class SitMapStream {
    constructor({WebSocketImpl = WebSocket, notify = () => {}} = {}) {
        this.WebSocketImpl = WebSocketImpl; this.notify = notify;
        this.socket = null; this.latest = null; this.pending = null;
        this.inFlightSequences = []; this.ready = false; this.closed = false;
        this.retryTimer = null; this.ackTimer = null;
    }
    get inFlight() { return this.inFlightSequences.length > 0; }
    connect() {
        if (this.closed) return;
        const previous = this.socket;
        const socket = this.socket = new this.WebSocketImpl("ws://127.0.0.1:9877", "sitmap-v1");
        previous?.close();
        clearTimeout(this.ackTimer); this.inFlightSequences = []; this.ready = false;
        socket.onmessage = event => {
            if (socket !== this.socket) return;
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === "ready" && message.apiVersion === 1) {
                this.ready = true; this.pending = this.latest; this.notify(message); this.flush();
            } else if (message.type === "applied" || message.type === "error") {
                if (message.type === "applied" && !Number.isInteger(message.sequence)) return;
                this.inFlightSequences = message.type === "error" ? []
                    : this.inFlightSequences.filter(sequence => sequence > message.sequence);
                this.watchAcknowledgement(); this.notify(message); this.flush();
            }
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            if (socket !== this.socket || this.closed) return;
            clearTimeout(this.ackTimer); this.ready = false; this.inFlightSequences = [];
            this.notify({type: "reconnecting"});
            this.retryTimer = setTimeout(() => this.connect(), 1000);
        };
    }
    offer(message) { this.latest = message; this.pending = message; this.flush(); }
    watchAcknowledgement() {
        clearTimeout(this.ackTimer);
        if (this.inFlight) this.ackTimer = setTimeout(() => this.socket?.close(), 3000);
    }
    flush() {
        if (!this.ready || this.inFlightSequences.length >= 2 || !this.pending || this.socket?.readyState !== 1) return;
        const pose = this.pending; this.pending = null;
        this.inFlightSequences.push(pose.sequence);
        this.socket.send(JSON.stringify(pose));
        if (this.inFlightSequences.length === 1) this.watchAcknowledgement();
    }
    close() {
        this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.ackTimer);
        this.socket?.close(); this.socket = null; this.pending = this.latest = null;
        this.ready = false; this.inFlightSequences = [];
    }
}

export function isSitMapSender(sender, extensionID) {
    if (sender.id !== extensionID || !sender.tab) return false;
    try {
        const url = new URL(sender.url || sender.tab.url);
        return (url.protocol === "https:" && (url.hostname === "local.metabunk.org"
            || url.hostname === "www.metabunk.org" && url.pathname.startsWith("/sitrec")
            || url.hostname.endsWith(".sitrec.work")))
            || url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    } catch { return false; }
}

export function installSitMapRelay(chromeAPI) {
    let activePort = null;
    chromeAPI.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type !== "sitmapRequest" || !isSitMapSender(sender, chromeAPI.runtime.id)) return false;
        requestSitMap(message.action, message.params).then(result => respond({result}), error => respond({error: error.message}));
        return true;
    });
    chromeAPI.runtime.onConnect.addListener(port => {
        if (port.name !== "sitmap-live" || !isSitMapSender(port.sender, chromeAPI.runtime.id)) return;
        activePort?.disconnect(); activePort = port;
        const stream = new SitMapStream({notify: message => { try { port.postMessage(message); } catch { stream.close(); } }});
        port.onMessage.addListener(message => {
            if (message.type === "pose" && message.camera && Number.isInteger(message.sequence)) stream.offer(message);
        });
        port.onDisconnect.addListener(() => { stream.close(); if (activePort === port) activePort = null; });
        stream.connect();
    });
}
