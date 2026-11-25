// A page-side client; only SitrecBridge's isolated extension world opens sockets.
export class SitMapClient {
    constructor({targetWindow = window, sampleCamera}) {
        this.window = targetWindow; this.sampleCamera = sampleCamera;
        this.pending = new Map(); this.nextID = 0; this.sequence = 0;
        this.sync = {enabled: false, connected: false, view: "lookView", error: null};
        this.lastPose = null;
        this.syncGeneration = 0;
        this.receive = event => {
            if (event.source !== this.window || event.origin !== this.window.location.origin || event.data?.source !== "sitmap-extension") return;
            const {id, result, error, live} = event.data;
            if (live) {
                if (live.type === "ready") { this.sync.connected = true; this.sync.error = null; this.lastPose = null; }
                if (live.type === "reconnecting") { this.sync.connected = false; this.sync.error = "Reconnecting to SitMap…"; }
                if (live.type === "stopped") { this.sync.enabled = false; this.sync.connected = false; }
                if (live.type === "error") this.sync.error = live.error;
                if (live.type === "applied") {
                    this.sync.lastAppliedSequence = live.sequence;
                    // Both processes run on this Mac; clocks share Unix milliseconds.
                    this.sync.lastLatencyMs = live.appliedAt - live.sentAt;
                    this.sync.error = null;
                    if (Number.isFinite(live.nativePitch) && (!Number.isFinite(this.sync.nativePitch)
                        || Math.abs(live.nativePitch - this.sync.nativePitch) > 0.05)) {
                        this.sync.nativePitch = live.nativePitch;
                        this.publish(); // Refine the source terrain even while Sitrec is paused.
                    }
                }
                return;
            }
            const pending = this.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(id);
            error ? pending.reject(new Error(error)) : pending.resolve(result);
        };
        this.window.addEventListener("message", this.receive);
    }
    post(action, params, id) {
        this.window.postMessage({source: "sitmap-client", action, params, id}, this.window.location.origin);
    }
    request(action, params = {}) {
        const id = `sitmap-${++this.nextID}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("SitMap did not respond. Open SitMap.app and reload the updated SitrecBridge extension."));
            }, action === "snapshot" ? 48000 : 6500);
            this.pending.set(id, {resolve, reject, timer}); this.post(action, params, id);
        });
    }
    status() { return this.request("status"); }
    setView(camera) { return this.request("view", camera); }
    snapshot(options = {}) { return this.request("snapshot", options); }
    async sendView({view = "lookView", ...options} = {}) {
        const camera = {...this.sampleCamera(view), ...options};
        const result = await this.setView(camera);
        const pitch = result.applied?.pitch;
        if (Number.isFinite(pitch) && Math.abs(pitch - (90 + camera.elevation)) > 0.05) {
            const refined = {...this.sampleCamera(view, pitch), ...options};
            if (refined.sourceGroundTarget) return this.setView(refined);
        }
        return result;
    }
    async startSync({view = "lookView", ...options} = {}) {
        const generation = ++this.syncGeneration;
        // Fail before opening a connection if the selected camera cannot be sampled.
        this.sampleCamera(view);
        await this.request("start");
        if (generation !== this.syncGeneration) return {...this.sync};
        this.sync = {enabled: true, connected: true, view, options, error: null};
        this.lastPose = null; this.publish();
        return {...this.sync};
    }
    async stopSync() {
        ++this.syncGeneration;
        this.sync.enabled = false; this.sync.connected = false; this.lastPose = null;
        return this.request("stop");
    }
    publish() {
        if (!this.sync.enabled) return;
        try {
            const camera = {...this.sampleCamera(this.sync.view, this.sync.nativePitch), ...this.sync.options};
            const signature = JSON.stringify(camera);
            if (signature === this.lastPose) return;
            this.lastPose = signature;
            this.post("pose", {camera, sequence: ++this.sequence, sentAt: Date.now()});
        } catch (error) { this.sync.error = error.message; }
    }
}
