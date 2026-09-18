// Perspective projection from the sampled camera pose. The final transform
// is a uniform image-plane crop/zoom: it does not move or re-aim the camera.
export function projectCameraPoint(point, pose) {
    if (!point || !pose) return null;
    const dx = point[0] - pose.position[0], dy = point[1] - pose.position[1], dz = point[2] - pose.position[2];
    const dot = axis => dx * axis[0] + dy * axis[1] + dz * axis[2];
    const depth = dot(pose.forward);
    if (!Number.isFinite(depth) || depth <= 1e-8) return null;
    const x = dot(pose.right) / depth, y = dot(pose.up) / depth;
    return Number.isFinite(x) && Number.isFinite(y) ? {x, y, depth} : null;
}

export function cameraTrackProjection(series, pose, viewport) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const include = point => {
        const p = projectCameraPoint(point, pose);
        if (!p) return;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    };
    for (const s of series) {
        // Full-resolution bounds keep thumbnails and detail on the same
        // framing and include extrema between their decimated line samples.
        if (s.positionAt && s.frameCount) {
            for (let f = 0; f < s.frameCount; f++) include(s.positionAt(f));
        } else {
            for (const p of s.pts ?? []) include(p);
        }
    }
    if (!Number.isFinite(minX)) return null;
    const spanX = Math.max(1e-5, maxX - minX), spanY = Math.max(1e-5, maxY - minY);
    const scale = 0.86 * Math.min(viewport.width / spanX, viewport.height / spanY);
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    return point => {
        const p = projectCameraPoint(point, pose);
        return p && {
            x: viewport.left + viewport.width / 2 + (p.x - centerX) * scale,
            y: viewport.top + viewport.height / 2 - (p.y - centerY) * scale,
            depth: p.depth,
        };
    };
}
