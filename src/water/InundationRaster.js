import {addInundationCoverageTriangle, addInundationTriangle} from "./InundationGrid";

const BATCH_TRIANGLES = 16384;
const BATCH_EDGES = 16384;

function snapshot({input, projected}) {
    return {projected, index: input.index, indexVersion: input.index?.version,
        positionCount: input.position.count, start: input.start ?? 0, count: input.count ?? Infinity,
        error: input.error ?? 0, coverageSource: input.coverageSource};
}

function same(a, b) {
    return a?.projected === b.projected && a.index === b.index && a.indexVersion === b.indexVersion
        && a.positionCount === b.positionCount && a.start === b.start && a.count === b.count
        && a.error === b.error && a.coverageSource === b.coverageSource;
}

function indexCount(part) {
    return part.index?.count ?? part.index?.length ?? part.positionCount;
}

function indexAt(index, i) {
    return index ? index.getX ? index.getX(i) : index[i] : i;
}

export function inundationCoverageAtLevel(coverage, heights, errors, level, fineError) {
    const result = new Uint8Array(coverage.length);
    for (let i = 0; i < result.length; i++) {
        if (coverage[i] && (errors[i] <= fineError || heights[i] + errors[i] < level || heights[i] - errors[i] > level)) result[i] = 1;
    }
    return result;
}

// Pure calculation state, suitable for a worker or the cooperative fallback.
// Projected arrays and indices are immutable for a cache entry's lifetime; a
// geometry edit supplies a new projected array. Returned grids must not be
// transferred or edited in place, because a later batch can reuse them.
export class InundationRasterCache {
    constructor() {
        this.clear();
    }

    clear() {
        this.coverageState = null;
        this.edges = new Map();
        this.lastBuildStats = null;
    }

    async build(projections, size, level, requireCoverage, fineError, {checkpoint, onProgress} = {}) {
        const parts = projections.map(snapshot);
        const coverageParts = parts.filter(part => part.coverageSource);
        const old = this.coverageState;
        const append = requireCoverage && old?.size === size && old.parts.length <= coverageParts.length
            && old.parts.every((part, i) => same(part, coverageParts[i]));
        const coverageStart = append ? old.parts.length : 0;
        const unchangedCoverage = append && coverageStart === coverageParts.length;
        const cells = size * size;
        // Copy only when adding coverage. A canceled batch must not modify the
        // last completed grids, even if cancellation arrives halfway through it.
        const coverage = !requireCoverage ? null : unchangedCoverage ? old.coverage
            : append ? old.coverage.slice() : new Uint8Array(cells);
        const surfaceHeights = !requireCoverage ? null : unchangedCoverage ? old.surfaceHeights
            : append ? old.surfaceHeights.slice() : new Float32Array(cells).fill(Infinity);
        const surfaceErrors = !requireCoverage ? null : unchangedCoverage ? old.surfaceErrors
            : append ? old.surfaceErrors.slice() : new Float32Array(cells).fill(Infinity);
        const stats = {coverageTriangles: 0, barrierTriangles: 0,
            coveragePartsReused: coverageStart, barrierPartsReused: 0};
        await checkpoint?.();

        if (requireCoverage) {
            onProgress?.("Coverage", coverageStart, coverageParts.length);
            for (let p = coverageStart; p < coverageParts.length; p++) {
                const part = coverageParts[p], end = Math.min(indexCount(part), part.start + part.count);
                for (const {vertices} of part.projected) {
                    for (let j = part.start; j + 2 < end; j += 3) {
                        addInundationCoverageTriangle(vertices, indexAt(part.index, j), indexAt(part.index, j + 1),
                            indexAt(part.index, j + 2), coverage, size, size, surfaceHeights, surfaceErrors, part.error);
                        if (++stats.coverageTriangles % BATCH_TRIANGLES === 0) await checkpoint?.();
                    }
                }
                onProgress?.("Coverage", p + 1, coverageParts.length);
            }
        }

        // Cache the sparse water-plane intersections independently of the LOD
        // grid. New fine coverage can suppress an old coarse wall without
        // intersecting all its triangles again. Edited/removed parts disappear
        // from the next map; changes of level or grid size rebuild their edges.
        const nextEdges = new Map(), contributions = [];
        onProgress?.("Water barriers", 0, parts.length);
        for (let p = 0; p < parts.length; p++) {
            const part = parts[p], cached = this.edges.get(part.projected);
            let edges;
            if (cached?.size === size && cached.level === level && same(cached.part, part)) {
                edges = cached;
                stats.barrierPartsReused++;
            } else {
                const east = new Set(), south = new Set();
                const collector = {recordEdge: (horizontal, i) => (horizontal ? east : south).add(i)};
                const end = Math.min(indexCount(part), part.start + part.count);
                for (const {vertices, minHeight, maxHeight} of part.projected) {
                    if (minHeight > level || maxHeight <= level) continue;
                    for (let j = part.start; j + 2 < end; j += 3) {
                        addInundationTriangle(vertices, indexAt(part.index, j), indexAt(part.index, j + 1),
                            indexAt(part.index, j + 2), level, collector, size, size, part.error);
                        if (++stats.barrierTriangles % BATCH_TRIANGLES === 0) await checkpoint?.();
                    }
                }
                edges = {part, size, level, east: Uint32Array.from(east), south: Uint32Array.from(south)};
            }
            nextEdges.set(part.projected, edges);
            contributions.push(edges);
            onProgress?.("Water barriers", p + 1, parts.length);
        }

        const barriers = {east: new Uint8Array(cells), south: new Uint8Array(cells), level,
            rawCoverage: coverage, surfaceHeights, surfaceErrors};
        let combined = 0;
        for (const edges of contributions) {
            const error = edges.part.error;
            for (const horizontal of [true, false]) {
                const target = horizontal ? barriers.east : barriers.south;
                const indices = horizontal ? edges.east : edges.south;
                const stride = horizontal ? 1 : size;
                for (const i of indices) {
                    // Keep the same comparison and precision as the direct
                    // rasterizer, including unknown (infinite) surface errors.
                    if (!surfaceErrors || !(surfaceErrors[i] < error - 1e-5 && surfaceErrors[i + stride] < error - 1e-5)) target[i] = 1;
                    if (++combined % BATCH_EDGES === 0) await checkpoint?.();
                }
            }
        }
        barriers.coverage = requireCoverage
            ? inundationCoverageAtLevel(coverage, surfaceHeights, surfaceErrors, level, fineError) : null;
        await checkpoint?.();
        // Publish all cache state together only after a successful calculation.
        if (requireCoverage) this.coverageState = {size, parts: coverageParts, coverage, surfaceHeights, surfaceErrors};
        this.edges = nextEdges;
        this.lastBuildStats = stats;
        return barriers;
    }
}
