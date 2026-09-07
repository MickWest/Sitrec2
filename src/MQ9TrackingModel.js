// Observable tracking behavior for a simulation, not a device firmware model.
// Observations contain scene objects only; OSD graphics are never candidates.
export const MQ9_TRACKING_DEFAULTS = Object.freeze({
    acquireSeconds: 0.9, refineSeconds: 4 / 3, searchSeconds: 2,
    boxPixels: 180, confidenceThreshold: 0.75, tentativeThreshold: 0.4,
    flashHalfPeriod: 0.25, lostFlashes: 3, paddingPixels: 4,
});

const mix = (a, b, t) => a + (b - a) * t;
const clamp = x => Math.max(0, Math.min(1, x));

export class MQ9TrackingModel {
    constructor(options = {}) {
        this.options = {...MQ9_TRACKING_DEFAULTS, ...options};
        this.reset();
    }

    reset() {
        this.state = "manual";
        this.acquisitionMode = "manual";
        this.started = 0; this.lastTime = null; this.refinedSeconds = 0;
        this.lastObservation = null; this.velocity = [0, 0, 0];
        this.targetId = null; this.lostAt = null; this.resumeState = null;
        this.seenAcquisitionTarget = false;
        this.hasCandidateLock = false;
        this.lastBounds = {width: 6, height: 6};
        this.acquisitionCenter = {x: 320, y: 240};
        this.history = [];
    }

    transition(state, time, reason) {
        if (state !== this.state) this.history.push({time, from: this.state, to: state, reason});
        this.state = state; this.started = time;
    }

    command(command, time) {
        if (command === "acquire") {
            this.acquisitionMode = this.cameraMode === "ground" ? "ground" : "manual";
            this.refinedSeconds = 0; this.lastObservation = null; this.targetId = null;
            this.velocity = [0, 0, 0]; this.lostAt = null;
            this.seenAcquisitionTarget = false;
            this.hasCandidateLock = false;
            this.transition("acquiring", time, "operator acquisition");
        } else if (command === "manual" || command === "ground") {
            this.lastObservation = null; this.targetId = null; this.lostAt = null;
            this.transition(command, time, "operator selection");
        }
    }

    get cameraMode() {
        if (this.state === "acquiring") return this.acquisitionMode;
        if (this.state === "refining" || this.state === "tracking") return "object";
        if (this.state === "coasting") return "coast";
        return this.state;
    }

    estimate(time) {
        if (!this.lastObservation) return null;
        return this.lastObservation.position.map((p, i) => p + this.velocity[i] * (time - this.lastObservation.time));
    }

    remember(observation, time) {
        const dt = this.lastObservation && time - this.lastObservation.time;
        if (dt > 0) this.velocity = observation.position.map((p, i) => (p - this.lastObservation.position[i]) / dt);
        this.lastObservation = {position: [...observation.position], time};
        this.lastBounds = {width: observation.width, height: observation.height};
        this.targetId = observation.id;
    }

    box(time, pixel = this.acquisitionCenter) {
        if (this.state === "manual" || this.state === "ground") return null;
        const o = this.options;
        const refining = clamp(this.refinedSeconds / o.refineSeconds);
        const p = refining * refining * (3 - 2 * refining);
        const acquiring = this.state === "acquiring";
        const size = mix(2, o.boxPixels, clamp((time - this.started) / o.acquireSeconds));
        const box = {
            x: this.hasCandidateLock ? pixel.x : this.acquisitionCenter.x,
            y: this.hasCandidateLock ? pixel.y : this.acquisitionCenter.y,
            width: acquiring ? size : mix(o.boxPixels, Math.max(8, this.lastBounds.width + o.paddingPixels), p),
            height: acquiring ? size : mix(o.boxPixels, Math.max(8, this.lastBounds.height + o.paddingPixels), p),
            style: acquiring ? "square" : "corners", visible: true, progress: refining,
        };
        if (this.state === "coasting") {
            box.visible = Math.floor((time - this.lostAt + 1e-9) / o.flashHalfPeriod) % 2 === 1;
        }
        return box;
    }

    step(time, observations = [], predictedPixel = null) {
        const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
        this.lastTime = time;
        if (this.state === "manual" || this.state === "ground") return;
        const o = this.options, box = this.box(time, predictedPixel ?? this.acquisitionCenter);
        const gate = box;
        const inside = d => d.visible !== false && d.confidence >= o.tentativeThreshold
            && (!this.targetId || d.id === this.targetId)
            && Math.abs(d.x - gate.x) <= (gate.width + d.width) / 2
            && Math.abs(d.y - gate.y) <= (gate.height + d.height) / 2;
        const candidates = observations.filter(inside).sort((a, b) =>
            Math.hypot(a.x - gate.x, a.y - gate.y) - Math.hypot(b.x - gate.x, b.y - gate.y));
        const detection = candidates[0];
        if (this.state === "acquiring") {
            if (detection) { this.seenAcquisitionTarget = true; this.remember(detection, time); }
            if (time - this.started >= o.acquireSeconds - 1e-9 && detection) {
                this.remember(detection, time);
                this.hasCandidateLock = true;
                this.transition("refining", time, "candidate detected");
            } else if ((!detection && this.seenAcquisitionTarget) || time - this.started >= o.acquireSeconds + o.searchSeconds - 1e-9) {
                this.resumeState = "refining"; this.lostAt = time;
                this.transition("coasting", time, "acquisition failed");
            }
            return;
        }
        if (this.state === "coasting") {
            if (time - this.lostAt >= o.flashHalfPeriod * 2 * o.lostFlashes - 1e-9) {
                this.transition("ground", time, "three flashes without recovery");
                this.lastObservation = null; this.targetId = null;
            } else if (detection?.confidence >= o.confidenceThreshold) {
                // Recovery resumes the retained estimate; low-confidence
                // measurements never update the predictor during coast.
                this.remember(detection, time);
                this.hasCandidateLock = true;
                this.transition(this.resumeState, time, "lock recovered");
                this.lostAt = null;
            }
            return;
        }
        if (!detection || detection.confidence < o.tentativeThreshold
            || detection.confidence < o.confidenceThreshold) {
            this.resumeState = this.state; this.lostAt = time;
            this.transition("coasting", time, "target outside gate or low confidence");
            return;
        }
        this.remember(detection, time);
        if (this.state === "refining" && detection.confidence >= o.confidenceThreshold) {
            this.refinedSeconds = Math.min(o.refineSeconds, this.refinedSeconds + dt);
            if (this.refinedSeconds >= o.refineSeconds - 1e-9) this.transition("tracking", time, "refinement complete");
        }
    }

    snapshot() { return JSON.parse(JSON.stringify(this)); }
    restore(snapshot) { Object.assign(this, JSON.parse(JSON.stringify(snapshot))); }
}
