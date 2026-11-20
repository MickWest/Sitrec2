import {Vector3} from "three";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";

// A spatial (metres, not frames) height profile. Local linear regression retains
// a constant grade even at the ends; cubic interpolation makes pitch continuous.
export class RoadProfile {
    constructor(points, smoothing = 20, width = 8) {
        smoothing = Number.isFinite(smoothing) ? Math.max(2, Math.min(100, smoothing)) : 20;
        width = Number.isFinite(width) ? Math.max(2, Math.min(30, width)) : 8;
        this.origin = points[0].clone();
        this.up = getLocalUpVector(this.origin);
        this.north = getLocalNorthVector(this.origin);
        this.east = this.north.clone().cross(this.up).normalize();
        this.width = width;
        this.points = [];
        let distance = 0;
        for (const point of points) {
            const local = this.local(point);
            const previous = this.points.at(-1);
            if (previous) {
                const step = Math.hypot(local.x - previous.x, local.y - previous.y);
                if (step < 0.01) continue;
                distance += step;
            }
            this.points.push({x: local.x, y: local.y, raw: local.z, s: distance});
        }
        const p = this.points;
        const radius = Math.max(1, smoothing);
        let first = 0;
        for (let i = 0; i < p.length; i++) {
            while (p[first].s < p[i].s - radius) first++;
            let w = 0, wx = 0, wxx = 0, wz = 0, wxz = 0;
            for (let j = first; j < p.length && p[j].s <= p[i].s + radius; j++) {
                const x = p[j].s - p[i].s;
                const weight = Math.exp(-4.5 * (x / radius) ** 2);
                w += weight; wx += weight * x; wxx += weight * x * x;
                wz += weight * p[j].raw; wxz += weight * x * p[j].raw;
            }
            const determinant = w * wxx - wx * wx;
            p[i].height = determinant > 1e-9 ? (wz * wxx - wx * wxz) / determinant : p[i].raw;
        }
        for (let i = 0; i < p.length; i++) {
            const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
            p[i].slope = (b.height - a.height) / (b.s - a.s || 1);
        }
        // Spatial index: road geometry queries do not scan the entire route for
        // each vertex. Include the feathered shoulder in each segment's cells.
        this.cells = new Map();
        const margin = width;
        for (let i = 0; i < p.length - 1; i++) {
            const a = p[i], b = p[i + 1];
            for (let x = Math.floor((Math.min(a.x, b.x) - margin) / 32); x <= Math.floor((Math.max(a.x, b.x) + margin) / 32); x++) {
                for (let y = Math.floor((Math.min(a.y, b.y) - margin) / 32); y <= Math.floor((Math.max(a.y, b.y) + margin) / 32); y++) {
                    const key = `${x},${y}`;
                    if (!this.cells.has(key)) this.cells.set(key, []);
                    this.cells.get(key).push(i);
                }
            }
        }
    }

    local(point) {
        const delta = point.clone().sub(this.origin);
        return new Vector3(delta.dot(this.east), delta.dot(this.north), delta.dot(this.up));
    }

    at(point) {
        const q = this.local(point);
        const candidates = this.cells.get(`${Math.floor(q.x / 32)},${Math.floor(q.y / 32)}`) ?? [];
        let best = null;
        for (const i of candidates) {
            const a = this.points[i], b = this.points[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
            const distance = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
            if (best && best.distance <= distance) continue;
            const t2 = t * t, t3 = t2 * t, ds = b.s - a.s;
            const height = (2 * t3 - 3 * t2 + 1) * a.height + (t3 - 2 * t2 + t) * ds * a.slope
                + (-2 * t3 + 3 * t2) * b.height + (t3 - t2) * ds * b.slope;
            best = {distance, height, raw: a.raw + t * (b.raw - a.raw), z: q.z};
        }
        return best;
    }

    pointBelow(point) {
        const sample = this.at(point);
        if (!sample || sample.distance > this.width) return null;
        return point.clone().addScaledVector(this.up, sample.height - sample.z);
    }
}

// Keep sampling density independent of vehicle speed and duplicate/stopped frames.
export function sampleRoadPath(points, spacing = 2) {
    if (!points.length) return [];
    const result = [points[0].clone()];
    let remaining = spacing;
    for (let i = 1; i < points.length; i++) {
        let a = points[i - 1].clone();
        const b = points[i];
        let distance = a.distanceTo(b);
        while (distance >= remaining) {
            a.lerp(b, remaining / distance);
            result.push(a.clone());
            distance -= remaining;
            remaining = spacing;
        }
        remaining -= distance;
    }
    if (result.at(-1).distanceToSquared(points.at(-1)) > 0.0001) result.push(points.at(-1).clone());
    return result;
}
