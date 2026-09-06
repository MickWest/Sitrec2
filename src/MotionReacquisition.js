// Wide searches contain several plausible peaks. Keep short independent
// hypotheses until motion, rather than a single frame's brightness, resolves
// them. Hypotheses never become published track points before confirmation.
export class MotionReacquisition {
    constructor() { this.paths = []; }
    reset() { this.paths = []; }

    update(frame, candidates, camera, {threshold, scale, speed, interval, coherence = 4}) {
        const old = this.paths.filter(p => frame - p[p.length - 1].frame <= 3 * interval);
        const used = new Set(), next = [];
        for (const hit of candidates.filter(p => p.score >= threshold).sort((a, b) => b.score - a.score)) {
            let closest = null, distance = Infinity;
            for (const path of old) {
                if (used.has(path)) continue;
                const last = path[path.length - 1], dt = frame - last.frame;
                if (dt <= 0) continue;
                let predicted = camera.predict(path, frame);
                if (!predicted) {
                    const before = path[path.length - 2];
                    predicted = before ? {x: last.x + (last.x - before.x) * dt / (last.frame - before.frame),
                        y: last.y + (last.y - before.y) * dt / (last.frame - before.frame)} : last;
                }
                const d = Math.hypot(hit.x - predicted.x, hit.y - predicted.y);
                // A single sighting has no target velocity yet. In a panning
                // shot the camera may hold the target almost stationary while
                // the background travels quickly; a background-only prediction
                // must therefore allow that entire displacement. The next
                // sighting estimates velocity, and the third must corroborate it.
                const cameraSpeed = Math.hypot(predicted.x - last.x, predicted.y - last.y) / dt;
                const gate = 6 + (path.length === 1
                    ? Math.max(3, speed, cameraSpeed + coherence) : coherence) * dt;
                if (d <= gate && d < distance) { closest = path; distance = d; }
            }
            if (closest) used.add(closest);
            next.push([...(closest || []).slice(-2), {...hit, frame}]);
        }
        // One ambiguous sweep must not erase an otherwise consistent candidate.
        this.paths = [...next, ...old.filter(p => !used.has(p))].slice(0, 32);
        const confirmed = [];
        for (const path of next) {
            if (path.length < 3) continue;
            const [a, b, c] = path;
            const transportedA = camera.transport(a, a.frame, frame);
            const transportedB = camera.transport(b, b.frame, frame);
            const registered = transportedA && transportedB;
            const A = registered ? transportedA : a;
            const B = registered ? transportedB : b;
            const dt1 = b.frame - a.frame, dt2 = c.frame - b.frame;
            const v1 = {x: (B.x - A.x) / dt1, y: (B.y - A.y) / dt1};
            const v2 = {x: (c.x - B.x) / dt2, y: (c.y - B.y) / dt2};
            if (Math.hypot(v2.x - v1.x, v2.y - v1.y) > coherence) continue;
            // Residuals tied to a ground feature travel with that feature.
            if (registered && Math.hypot(c.x - A.x, c.y - A.y) / (c.frame - a.frame) < Math.max(0.2, scale * 0.1, speed * 0.15)) continue;
            // Exactly fixed screen features are usually OSD. This is deliberately
            // sub-pixel: a sensor-held real object still has measurement jitter.
            if (Math.max(Math.hypot(c.x - a.x, c.y - a.y), Math.hypot(b.x - a.x, b.y - a.y)) < 1) continue;
            const scores = path.map(p => p.score).sort((a, b) => a - b);
            confirmed.push({hit: c, score: scores[1]});
        }
        confirmed.sort((a, b) => b.score - a.score);
        if (!confirmed.length || (confirmed[1] && confirmed[0].score < 1.3 * confirmed[1].score)) return null;
        return confirmed[0].hit;
    }
}
