import {projectInundationMesh} from "./InundationProjection";
import {InundationRasterCache} from "./InundationRaster";
import {connectedInundation} from "./InundationGrid";
import {inundationFlowRoutes} from "./InundationFlow";

function sameArray(a, b) {
    return a === b || !!(a && b && a.length === b.length && a.every((value, i) => value === b[i]));
}

function sameRecord(old, input, projected) {
    return old && old.input.start === input.start && old.input.count === input.count
        && old.input.error === input.error && old.input.coverageSource === input.coverageSource
        && old.input.position.count === input.position.count && sameArray(old.input.index, input.index)
        && old.projected.length === projected.length && old.projected.every((part, i) =>
            part.minHeight === projected[i].minHeight && part.maxHeight === projected[i].maxHeight
            && sameArray(part.vertices, projected[i].vertices));
}

// No scene objects, DOM state or mutable global Earth model cross this boundary.
export class InundationWorkerCore {
    constructor() {
        this.records = new Map();
        this.raster = new InundationRasterCache();
    }

    async geometry(payload, checkpoint, onProgress) {
        const {domain, context, changes, active, level, requireCoverage, fineError} = payload;
        if (this.domain !== domain) {
            this.domain = domain;
            this.records = new Map();
            this.raster = new InundationRasterCache();
            this.barriers = null;
        }
        if (context.geoid) this.geoid = context.geoid;
        // A canceled edit must not replace a previously acknowledged tile.
        // Projected arrays are immutable, so only the small map is copied.
        const records = new Map(this.records);
        for (let i = 0; i < changes.length; i++) {
            const change = changes[i];
            onProgress("Projecting tiles", i, changes.length);
            const projected = await projectInundationMesh(change, {...context, geoid: this.geoid}, checkpoint);
            await checkpoint();
            const old = records.get(change.key);
            // The same tile can be decoded again after texture-cache eviction
            // or arrive from another view. Exact numeric equality preserves its
            // raster cache without treating edited geometry as unchanged.
            if (!sameRecord(old, change.input, projected) || old.retained !== change.retained) {
                records.set(change.key, {projected, input: change.input, retained: change.retained});
            }
        }
        onProgress("Projecting tiles", changes.length, changes.length);
        const activeKeys = new Set(active);
        // Photogrammetry remains after display eviction. Synthetic edits and
        // removed objects must not leave stale barriers in the retained set.
        for (const [key, record] of records) if (!record.retained && !activeKeys.has(key)) records.delete(key);
        const projections = active.map(key => records.get(key)).filter(record => record && !record.retained);
        for (const record of records.values()) if (record.retained) projections.push(record);
        const barriers = await this.raster.build(projections, context.size, level, requireCoverage, fineError,
            {checkpoint, onProgress});
        await checkpoint();
        this.records = records;
        this.barriers = barriers;
        this.geometryId = payload.geometryId;
        return {barriers, meshCount: projections.length, recordCount: records.size, geometryId: this.geometryId,
            cacheStats: this.raster.lastBuildStats};
    }

    async fill(payload, checkpoint, onProgress) {
        if (payload.terrain) this.terrain = payload.terrain;
        const terrain = this.terrain;
        if (!terrain || terrain.id !== payload.terrainId) throw new Error("Inundation terrain cache is unavailable");
        const barriers = payload.useBuildings ? this.barriers : null;
        if (payload.useBuildings && (!barriers || payload.geometryId !== this.geometryId || barriers.level !== payload.level)) {
            throw new Error("Inundation geometry changed before flood fill");
        }
        const {heights, ocean, seeds, size, cellMeters} = terrain;
        onProgress("Flood fill", 0, 1);
        await checkpoint(true);
        const trace = payload.showFlow ? {} : null;
        const wet = connectedInundation(heights, ocean, size, size, payload.level, undefined, barriers, trace, seeds);
        await checkpoint(true);
        onProgress("Flow arrows", 0, 1);
        const flowRoutes = trace ? inundationFlowRoutes(trace, heights, ocean, size, cellMeters, barriers?.surfaceHeights) : [];
        await checkpoint();
        onProgress("Complete", 1, 1);
        return {wet, flowRoutes};
    }
}
