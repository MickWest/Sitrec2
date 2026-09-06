// Compact camera geometry retained after the registration images are evicted.
// All points use decoded-image coordinates. A gap is reconstructed only once
// both endpoints have been observed, assuming constant target motion relative
// to the registered background; camera motion may vary at every frame.
export const identity3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply3(a, b) {
    const m = Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        for (let k = 0; k < 3; k++) m[3 * r + c] += a[3 * r + k] * b[3 * k + c];
    }
    const scale = m[8];
    return scale && Number.isFinite(scale) ? m.map(v => v / scale) : m;
}

export function inverse3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    return [A, c * h - b * i, b * f - c * e, B, a * i - c * g,
        c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}

export function project3(m, p) {
    if (!m) return null;
    const w = m[6] * p.x + m[7] * p.y + m[8];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-8) return null;
    const x = (m[0] * p.x + m[1] * p.y + m[2]) / w;
    const y = (m[3] * p.x + m[4] * p.y + m[5]) / w;
    return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
}

export class MotionTrackPath {
    constructor() { this.poses = new Map(); this.lastFrame = null; }
    clear() { this.poses.clear(); this.lastFrame = null; }

    record(frame, step) {
        if (this.poses.get(frame)?.step) return;
        if (!this.poses.size) this.poses.set(frame - 1, {step: null});
        this.poses.set(frame, {step: step && step.inliers !== 0 ? Array.from(step) : null});
        this.lastFrame = Math.max(this.lastFrame ?? frame, frame);
    }

    between(from, to) {
        if (!this.poses.has(from) || !this.poses.has(to)) return null;
        // Compose only the requested interval. Inverting two accumulated poses
        // from the clip's start becomes ill-conditioned after a long pan, even
        // when the latest one-frame registration is perfectly usable.
        let m = identity3();
        for (let f = Math.min(from, to) + 1; f <= Math.max(from, to); f++) {
            const step = this.poses.get(f)?.step;
            if (!step) return null;
            m = multiply3(step, m);
        }
        return from <= to ? m : inverse3(m);
    }

    transport(point, from, to) { return project3(this.between(from, to), point); }

    predict(anchors, frame) {
        const last = anchors[anchors.length - 1];
        if (!last) return null;
        // Average several measurements to avoid magnifying one pixel of jitter
        // into a long off-screen search excursion.
        const before = anchors[Math.max(0, anchors.length - 6)];
        const old = this.transport(before, before.frame, last.frame);
        const dt = last.frame - before.frame;
        const ahead = frame - last.frame;
        const point = old && dt > 0 ? {
            x: last.x + (last.x - old.x) * ahead / dt,
            y: last.y + (last.y - old.y) * ahead / dt,
        } : last;
        return this.transport(point, last.frame, frame);
    }

    reconstruct(before, after) {
        const end = this.transport(after, after.frame, before.frame);
        if (!end) return null;
        const points = new Map();
        let transform = identity3();
        for (let f = before.frame + 1; f < after.frame; f++) {
            const step = this.poses.get(f)?.step;
            if (!step) return null;
            transform = multiply3(step, transform);
            const t = (f - before.frame) / (after.frame - before.frame);
            const point = project3(transform, {x: before.x + (end.x - before.x) * t,
                y: before.y + (end.y - before.y) * t});
            if (!point) return null;
            points.set(f, point);
        }
        return points;
    }
}
