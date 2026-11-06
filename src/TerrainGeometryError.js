// Measure the height detail lost by a regular triangular terrain mesh against
// the elevation samples it actually uses. Flat water and planar slopes need
// no extra tiles merely because the imagery has more pixels than mesh cells.
export function terrainMeshHeightError(data, size, segments, x0 = 0, y0 = 0, fraction = 1,
    scale = 1, seaLevel = 0) {
    const sample = (u, v) => {
        const x = Math.max(0, Math.min(size - 1, (x0 + u * fraction) * (size - 1)));
        const y = Math.max(0, Math.min(size - 1, (y0 + v * fraction) * (size - 1)));
        const ix = Math.min(size - 2, Math.floor(x)), iy = Math.min(size - 2, Math.floor(y));
        const fx = x - ix, fy = y - iy, i = iy * size + ix;
        const a = data[i] * (1 - fx) + data[i + 1] * fx;
        const b = data[i + size] * (1 - fx) + data[i + size + 1] * fx;
        return Math.max(seaLevel, (a * (1 - fy) + b * fy) * scale);
    };
    if (size < 2 || !(segments > 0)) return 0;
    const mesh = new Float64Array((segments + 1) ** 2);
    for (let y = 0; y <= segments; y++) for (let x = 0; x <= segments; x++) {
        mesh[y * (segments + 1) + x] = sample(x / segments, y / segments);
    }
    const coordinates = start => {
        const values = new Set([0, 1]);
        const first = start * (size - 1), span = fraction * (size - 1);
        for (let i = Math.ceil(first); i <= Math.floor(first + span); i++) values.add((i - first) / span);
        for (let i = 1; i < segments; i++) values.add(i / segments);
        return [...values];
    };
    const xs = coordinates(x0), ys = coordinates(y0);
    let error = 0;
    for (const v of ys) for (const u of xs) {
        const ix = Math.min(segments - 1, Math.floor(u * segments));
        const iy = Math.min(segments - 1, Math.floor(v * segments));
        const fx = u * segments - ix, fy = v * segments - iy, i = iy * (segments + 1) + ix;
        const a = mesh[i], b = mesh[i + 1], c = mesh[i + segments + 1], d = mesh[i + segments + 2];
        const height = fx + fy <= 1 ? a + (b - a) * fx + (c - a) * fy
            : d + (c - d) * (1 - fx) + (b - d) * (1 - fy);
        error = Math.max(error, Math.abs(sample(u, v) - height));
    }
    return error;
}
