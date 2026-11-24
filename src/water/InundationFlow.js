// Representative routes through the computed flood, not a velocity model.
// Trace links come from the same four-neighbour fill, so they cannot cross a
// seawall, unknown geometry, or a dry cell. Count the land reached through each
// link to suppress arrows for tiny puddles and group nearby coastal entrances.
export function inundationFlowRoutes(trace, heights, ocean, width, cellMeters) {
    const {parent, order} = trace;
    const area = new Uint32Array(parent.length), child = new Int32Array(parent.length).fill(-1);
    const minCells = Math.max(4, Math.ceil(10000 / (cellMeters * cellMeters)));
    const spacing = Math.max(4, Math.round(180 / cellMeters));
    const maxSteps = Math.max(4, Math.round(220 / cellMeters));
    const coast = new Map(), candidates = [];
    for (let k = order.length - 1; k >= 0; k--) {
        const i = order[k], p = parent[i];
        if (ocean[i]) continue;
        area[i]++;
        if (p >= 0 && !ocean[p]) {
            area[p] += area[i];
            if (child[p] < 0 || area[i] > area[child[p]]) child[p] = i;
        }
    }
    for (const i of order) {
        const p = parent[i];
        if (p < 0 || ocean[i]) continue;
        if (ocean[p]) {
            const key = `${Math.floor((i % width) / spacing)},${Math.floor(Math.floor(i / width) / spacing)}`;
            let inlet = coast.get(key);
            if (!inlet) { inlet = {i, area: 0, coastal: true}; coast.set(key, inlet); }
            inlet.area += area[i];
            if (area[i] > area[inlet.i]) inlet.i = i;
        } else if (area[i] >= minCells && heights[p] - heights[i] > 0.15) {
            candidates.push({i, area: area[i], coastal: false});
        }
    }
    candidates.push(...[...coast.values()].filter(c => c.area >= minCells));
    // Coastal entrances first, then significant downhill connections inland.
    candidates.sort((a, b) => Number(b.coastal) - Number(a.coastal) || b.area - a.area || a.i - b.i);
    const routes = [], occupied = new Map();
    for (const candidate of candidates) {
        const {i, coastal} = candidate, x = i % width, y = Math.floor(i / width);
        const bx = Math.floor(x / spacing), by = Math.floor(y / spacing);
        let nearby = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            for (const [px, py] of occupied.get(`${bx + dx},${by + dy}`) ?? []) {
                if (Math.hypot(x - px, y - py) < spacing) nearby = true;
            }
        }
        if (nearby) continue;
        const cells = [parent[i], i];
        let end = i;
        while (child[end] >= 0 && cells.length < maxSteps) {
            const next = child[end];
            // Inlet arrows show entry over the coastal sill. Inland arrows
            // specifically follow descending ground toward the lower area.
            if (!coastal && heights[next] > heights[end] + 0.05) break;
            cells.push(next); end = next;
        }
        if (cells.length < 3) continue;
        if (!coastal && heights[cells[0]] - heights[end] < 0.25) continue;
        const key = `${bx},${by}`, bucket = occupied.get(key) ?? [];
        bucket.push([x, y]); occupied.set(key, bucket);
        routes.push({cells, coastal, areaMeters2: candidate.area * cellMeters * cellMeters});
        if (routes.length === 512) break;
    }
    return routes;
}
