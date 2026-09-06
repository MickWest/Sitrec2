// Separate measured stationary scenery from unavailable registration. Target
// velocity relative to the scenery survives a camera pan/ground-lock transition.
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];

export class MotionTrackingRegime {
    constructor() { this.reset(); }
    reset() {
        this.state = 'unknown';
        this.lastKnownState = 'unknown';
        this.cameraSpeed = null;
        this.cameraSamples = [];
        this.lastCameraFrame = null;
        this.lastTarget = null;
        this.targetHistory = [];
        this.velocitySamples = [];
        this.relativeVelocity = null;
        this.transitionUntil = -Infinity;
    }

    updateCamera(camera, frame, width, height) {
        const from = this.lastCameraFrame ?? frame - 1;
        this.lastCameraFrame = frame;
        const dt = frame - from;
        const speeds = [];
        if (dt > 0) for (const [u, v] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const p = {x: u * width, y: v * height};
            const q = camera.transport?.(p, from, frame);
            if (q) speeds.push(Math.hypot(q.x - p.x, q.y - p.y) / dt);
        }
        if (!speeds.length) {
            // An identity fallback from a failed fit is not evidence of a lock.
            this.cameraSpeed = null;
            this.cameraSamples = [];
            this.state = 'unknown';
            return;
        }
        this.cameraSpeed = median(speeds);
        this.cameraSamples.push(this.cameraSpeed);
        if (this.cameraSamples.length > 12) this.cameraSamples.shift();
        if (this.cameraSamples.length < 3) return;
        // Low-rate footage may repeat five or more frames between updates.
        // Average over a longer window and require the entire window before
        // declaring a lock; three quiet samples are not evidence of a stop.
        const speed = this.cameraSamples.reduce((sum, v) => sum + v, 0) / this.cameraSamples.length;
        const next = speed > 1 ? 'moving'
            : speed < 0.5 && this.cameraSamples.length === 12 ? 'stationary' : this.state;
        if (next !== 'unknown' && next !== this.lastKnownState && this.lastKnownState !== 'unknown') {
            this.transitionUntil = frame + 15;
        }
        if (next !== 'unknown') this.lastKnownState = next;
        this.state = next;
    }

    observeTarget(point, camera) {
        this.lastTarget = point;
        this.targetHistory = this.targetHistory.filter(p => point.frame - p.frame <= 8);
        this.targetHistory.push(point);
        // Measure across several frames. A median of adjacent velocities would
        // become zero when a low-rate video repeats most frames, erasing the
        // relative motion just when a pan-to-lock transition needs it.
        let old = null, dt = 0;
        // A zoom can break the oldest pair while more recent observations
        // already span a valid interval. Recover without waiting for eviction.
        for (const before of this.targetHistory) {
            dt = point.frame - before.frame;
            if (dt < 3) break;
            old = camera.transport?.(before, before.frame, point.frame);
            if (old) break;
        }
        if (!old || dt < 3) return;
        this.velocitySamples.push({x: (point.x - old.x) / dt, y: (point.y - old.y) / dt});
        if (this.velocitySamples.length > 5) this.velocitySamples.shift();
        this.relativeVelocity = {
            x: median(this.velocitySamples.map(v => v.x)),
            y: median(this.velocitySamples.map(v => v.y)),
        };
    }

    get relativeSpeed() {
        return this.relativeVelocity ? Math.hypot(this.relativeVelocity.x, this.relativeVelocity.y) : 0;
    }

    stationaryPrediction(last, frame) {
        if (this.state !== 'stationary' || this.cameraSpeed === null || !this.relativeVelocity || !last) return null;
        const dt = frame - last.frame;
        return {x: last.x + this.relativeVelocity.x * dt, y: last.y + this.relativeVelocity.y * dt};
    }
}
