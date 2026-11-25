// Visible renders follow the display clock. Hidden MCP work uses timers, which
// the worker heartbeat can drain when the browser throttles the main thread.
// The injected clock/callback APIs also let the lifecycle run without a browser.
export class RenderLoopScheduler {
    constructor({run, hidden, requestFrame, cancelFrame, setTimer, clearTimer, now}) {
        Object.assign(this, {run, hidden, requestFrame, cancelFrame, setTimer, clearTimer, now});
        this.pending = null;
    }

    schedule(delay = 0) {
        if (this.pending) return;
        const pending = {kind: this.hidden ? "timer" : "frame", id: null};
        this.pending = pending;
        const fire = timestamp => {
            // A visibility transition or worker tick can cancel a callback
            // that the browser has already queued. Never run it a second time.
            if (this.pending !== pending) return;
            this.pending = null;
            this.run(pending.kind === "frame" ? timestamp : this.now(), pending.kind === "frame");
        };
        pending.id = pending.kind === "frame"
            ? this.requestFrame(fire)
            : this.setTimer(fire, Math.max(0, delay));
    }

    cancel() {
        if (!this.pending) return;
        const {kind, id} = this.pending;
        this.pending = null;
        if (kind === "frame") this.cancelFrame(id);
        else this.clearTimer(id);
    }

    setHidden(hidden, keepPending = true) {
        if (hidden === this.hidden) return;
        const hadPending = !!this.pending;
        this.cancel();
        this.hidden = hidden;
        if (hadPending && keepPending) this.schedule();
    }

    // A hidden worker tick must not wake an idle, paused loop.
    runPending() {
        if (!this.pending) return;
        this.cancel();
        this.run(this.now(), false);
    }
}
