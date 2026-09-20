// One real-time clock for all charts in an analysis gallery. Dataset fps is
// already frames per real second, including any simulation-speed adjustment.
export class TraverseTimeline {
    constructor({frameCount, fps, frame = 0, onChange}) {
        this.lastFrame = Math.max(0, frameCount - 1);
        this.fps = fps;
        this.frame = this.clamp(frame);
        this.onChange = onChange;
        this.playing = false;
        this.disposed = false;
        this.raf = 0;
    }

    clamp(frame) {
        return Math.max(0, Math.min(this.lastFrame, Math.round(frame)));
    }

    seek(frame) {
        if (this.disposed) return;
        this.frame = this.clamp(frame);
        this.anchorFrame = this.frame;
        this.anchorTime = performance.now();
        if (this.frame === this.lastFrame) this.stopClock();
        this.onChange();
    }

    toggle() {
        if (this.disposed) return;
        if (this.playing) {
            this.stopClock();
        } else {
            if (!(this.fps > 0) || !Number.isFinite(this.fps) || !this.lastFrame) return;
            if (this.frame === this.lastFrame) this.frame = 0;
            this.anchorFrame = this.frame;
            this.anchorTime = performance.now();
            this.playing = true;
            this.raf = requestAnimationFrame(time => this.tick(time));
        }
        this.onChange();
    }

    tick(time) {
        this.raf = 0;
        if (!this.playing || this.disposed) return;
        const frame = Math.min(this.lastFrame,
            this.anchorFrame + Math.floor(Math.max(0, time - this.anchorTime) * this.fps / 1000));
        const changed = frame !== this.frame;
        this.frame = frame;
        if (frame === this.lastFrame) this.playing = false;
        if (changed) this.onChange();
        if (this.playing && !this.disposed) this.raf = requestAnimationFrame(t => this.tick(t));
    }

    stopClock() {
        this.playing = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
    }

    dispose() {
        this.stopClock();
        this.disposed = true;
    }
}
