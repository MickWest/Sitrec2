// Perspective projection from the sampled camera pose. The final transform
// is a uniform image-plane crop/zoom: it does not move or re-aim the camera.
function cameraPoint(point, pose) {
    if (!point || !pose) return null;
    const dx = point[0] - pose.position[0], dy = point[1] - pose.position[1], dz = point[2] - pose.position[2];
    const dot = axis => dx * axis[0] + dy * axis[1] + dz * axis[2];
    const p = [dot(pose.right), dot(pose.up), dot(pose.forward)];
    return p.every(Number.isFinite) ? p : null;
}

export function projectCameraPoint(point, pose) {
    const p = cameraPoint(point, pose);
    return p && p[2] > 1e-8 ? {x: p[0] / p[2], y: p[1] / p[2], depth: p[2]} : null;
}

export function cameraTrackProjection(series, pose, viewport) {
    // Fit only the camera's visible field. Points almost on its image plane
    // otherwise project to infinity and shrink the useful tracks to a pixel.
    const fov = pose.vFOV > 0 && pose.vFOV < 180 ? pose.vFOV : 90;
    const tanY = Math.tan(fov * Math.PI / 360);
    const tanX = tanY * (pose.aspect > 0 ? pose.aspect : viewport.width / viewport.height);
    const planes = [[0, 0, 1, -1e-8], [1, 0, tanX, 0], [-1, 0, tanX, 0],
        [0, 1, tanY, 0], [0, -1, tanY, 0]];
    const distance = (p, plane) => p[0] * plane[0] + p[1] * plane[1] + p[2] * plane[2] + plane[3];
    const inside = p => p && planes.every(plane => distance(p, plane) >= -1e-12);
    // Clip in camera space BEFORE dividing by depth. A segment can cross the
    // field even when both its endpoints are outside, or one is behind us.
    const clip = (a, b) => {
        if (!a || !b) return null;
        let lo = 0, hi = 1;
        for (const plane of planes) {
            const da = distance(a, plane), db = distance(b, plane);
            if (da < 0 && db < 0) return null;
            if (da < 0) lo = Math.max(lo, da / (da - db));
            else if (db < 0) hi = Math.min(hi, da / (da - db));
            if (lo > hi) return null;
        }
        const at = t => a.map((v, i) => v + t * (b[i] - v));
        return [lo > 0 ? at(lo) : a, hi < 1 ? at(hi) : b];
    };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const include = p => {
        const x = p[0] / p[2], y = p[1] / p[2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    for (const s of series) {
        // Full-resolution bounds keep thumbnails and detail on the same
        // framing and include extrema between their decimated line samples.
        const full = s.positionAt && s.frameCount;
        let previous = null, previousInside = false;
        for (let f = 0; f < (full ? s.frameCount : s.pts?.length ?? 0); f++) {
            const p = cameraPoint(full ? s.positionAt(f) : s.pts[f], pose);
            const visible = inside(p);
            if (visible) include(p);
            if (previous && p && !(previousInside && visible)) {
                const segment = clip(previous, p);
                if (segment) segment.forEach(include);
            }
            previous = p;
            previousInside = visible;
        }
    }
    if (!Number.isFinite(minX)) return null;
    const spanX = Math.max(1e-5, maxX - minX), spanY = Math.max(1e-5, maxY - minY);
    const scale = 0.86 * Math.min(viewport.width / spanX, viewport.height / spanY);
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    const imagePoint = p => ({
        x: viewport.left + viewport.width / 2 + (p[0] / p[2] - centerX) * scale,
        y: viewport.top + viewport.height / 2 - (p[1] / p[2] - centerY) * scale,
        depth: p[2],
    });
    const project = point => {
        const p = cameraPoint(point, pose);
        return inside(p) ? imagePoint(p) : null;
    };
    project.segment = (a, b) => clip(cameraPoint(a, pose), cameraPoint(b, pose))?.map(imagePoint) ?? null;
    return project;
}
