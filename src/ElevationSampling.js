// The same bilinear surface used by terrain queries and height-grid simulations.
// x/y are fractional tile coordinates (0..1), not pixel coordinates.
export function sampleElevationTile(tile, x, y, rejectNoData = false) {
    if (!tile?.elevation || tile.elevationLoadFailed) return null;
    const [width, height] = tile.shape ?? [Math.sqrt(tile.elevation.length), Math.sqrt(tile.elevation.length)];
    const px = x * width, py = y * height;
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(py)));
    const x1 = Math.max(0, Math.min(width - 1, Math.ceil(px)));
    const y1 = Math.max(0, Math.min(height - 1, Math.ceil(py)));
    const a = y0 * width + x0, b = y0 * width + x1;
    const c = y1 * width + x0, d = y1 * width + x1;
    if (rejectNoData && tile.elevationNoData &&
        (tile.elevationNoData[a] || tile.elevationNoData[b] || tile.elevationNoData[c] || tile.elevationNoData[d])) return null;
    const values = tile.elevation;
    const top = values[a] + (values[b] - values[a]) * (px - x0);
    const bottom = values[c] + (values[d] - values[c]) * (px - x0);
    const result = top + (bottom - top) * (py - y0);
    return rejectNoData && !Number.isFinite(result) ? null : result;
}
