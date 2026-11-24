import {InundationRasterCache, inundationCoverageAtLevel} from "../src/water/InundationRaster";
import {addInundationCoverageTriangle, addInundationTriangle, connectedInundation, inundationOceanSeeds} from "../src/water/InundationGrid";
import {inundationFlowRoutes} from "../src/water/InundationFlow";

function part(vertices, error = 0, coverageSource = true, index = null, start = 0, count = Infinity) {
    vertices = new Float32Array(vertices);
    const heights = vertices.filter((_, i) => i % 3 === 2);
    return {input: {index, position: {count: vertices.length / 3}, start, count, error, coverageSource},
        projected: [{vertices, minHeight: Math.min(...heights), maxHeight: Math.max(...heights)}]};
}

function ground(x0, y0, x1, y1, height = 0, error = 0) {
    return part([x0,y0,height, x1,y0,height, x1,y1,height, x0,y1,height], error, true,
        new Uint16Array([0,1,2, 0,2,3]));
}

function wall(x, y0, y1, top = 4, error = 0, coverageSource = true) {
    return part([x,y0,0, x,y1,0, x,y1,top, x,y0,top], error, coverageSource,
        new Uint32Array([0,1,2, 0,2,3]));
}

// Reference the original complete two-pass rasterization, without any cache.
function direct(projections, size, level, requireCoverage = true, fineError = Infinity) {
    const cells = size * size;
    const barriers = {east: new Uint8Array(cells), south: new Uint8Array(cells), level,
        rawCoverage: requireCoverage ? new Uint8Array(cells) : null,
        surfaceHeights: requireCoverage ? new Float32Array(cells).fill(Infinity) : null,
        surfaceErrors: requireCoverage ? new Float32Array(cells).fill(Infinity) : null};
    for (let pass = requireCoverage ? 0 : 1; pass < 2; pass++) {
        for (const {input, projected} of projections) {
            if (pass === 0 && !input.coverageSource) continue;
            const count = input.index?.count ?? input.index?.length ?? input.position.count;
            const end = Math.min(count, input.start + input.count);
            const at = i => input.index ? input.index.getX ? input.index.getX(i) : input.index[i] : i;
            for (const {vertices, minHeight, maxHeight} of projected) {
                if (pass === 1 && (minHeight > level || maxHeight <= level)) continue;
                for (let j = input.start; j + 2 < end; j += 3) {
                    if (pass === 0) addInundationCoverageTriangle(vertices, at(j), at(j + 1), at(j + 2), barriers.rawCoverage,
                        size, size, barriers.surfaceHeights, barriers.surfaceErrors, input.error);
                    else addInundationTriangle(vertices, at(j), at(j + 1), at(j + 2), level, barriers, size, size, input.error);
                }
            }
        }
    }
    barriers.coverage = requireCoverage ? inundationCoverageAtLevel(barriers.rawCoverage, barriers.surfaceHeights,
        barriers.surfaceErrors, level, fineError) : null;
    return barriers;
}

function equalBytes(a, b) {
    if (a === null || b === null) expect(a).toBe(b);
    else expect(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).toEqual(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function expectParity(actual, expected, size, level) {
    for (const name of ["east", "south", "rawCoverage", "coverage", "surfaceHeights", "surfaceErrors"]) {
        equalBytes(actual[name], expected[name]);
    }
    const heights = new Float32Array(size * size).fill(0.25);
    const ocean = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < 3; x++) ocean[y * size + x] = 1;
    const seeds = inundationOceanSeeds(ocean, size, size, 1);
    const traceA = {}, traceB = {};
    const wetA = connectedInundation(heights, ocean, size, size, level, undefined, actual, traceA, seeds);
    const wetB = connectedInundation(heights, ocean, size, size, level, undefined, expected, traceB, seeds);
    equalBytes(wetA, wetB);
    equalBytes(traceA.parent, traceB.parent);
    equalBytes(traceA.order, traceB.order);
    expect(inundationFlowRoutes(traceA, heights, ocean, size, 50, actual.surfaceHeights))
        .toEqual(inundationFlowRoutes(traceB, heights, ocean, size, 50, expected.surfaceHeights));
}

test("streaming coverage and cached wall edges retain full-raster bytes and flood routes", async () => {
    const size = 24, cache = new InundationRasterCache();
    const parts = [ground(-1,-1,25,25,0,6), wall(7.5,0,24,4,6),
        ground(5,-1,16,25,-0.2,0.1), wall(12,0,10,3,0.1), wall(12,14,24,3,0.1),
        ground(13,-1,25,25,0.12345678,0.05), wall(18,0,9,8,0,false)];
    for (let n = 1; n <= parts.length; n++) {
        const loaded = parts.slice(0,n);
        const result = await cache.build(loaded,size,1,true,0.25);
        expectParity(result,direct(loaded,size,1,true,0.25),size,1);
        expect(cache.lastBuildStats.coveragePartsReused).toBe(loaded.slice(0,-1).filter(p => p.input.coverageSource).length);
        expect(cache.lastBuildStats.barrierPartsReused).toBe(n - 1);
        expect(cache.lastBuildStats.coverageTriangles).toBe(parts[n - 1].input.coverageSource ? 2 : 0);
    }
    // The new fine surface replaces the parent's coarse waterline obstruction.
    expect((await cache.build(parts,size,1,true,0.25)).east[11 * size + 7]).toBe(0);
    for (const level of [8, 0.1, -1, 1]) {
        const result = await cache.build(parts,size,level,true,0.25);
        expectParity(result,direct(parts,size,level,true,0.25),size,level);
        expect(cache.lastBuildStats.coverageTriangles).toBe(0);
    }
});

test("close LOD errors retain their original order across appends and reorder rebuilds", async () => {
    const size = 8, cache = new InundationRasterCache();
    const a = ground(-1,-1,9,9,4.1234567,1);
    const b = ground(-1,-1,9,9,2.8765432,1 - 0.75e-5);
    const c = ground(-1,-1,9,9,3.4567891,1 - 1.5e-5);
    await cache.build([a],size,3,true,2);
    await cache.build([a,b],size,3,true,2);
    expectParity(await cache.build([a,b,c],size,3,true,2),direct([a,b,c],size,3,true,2),size,3);
    const reordered = [c,b,a];
    expectParity(await cache.build(reordered,size,3,true,2),direct(reordered,size,3,true,2),size,3);
    expect(cache.lastBuildStats.coveragePartsReused).toBe(0);
    expect(cache.lastBuildStats.coverageTriangles).toBe(6);
});

test("edits, removals, index versions, and grid changes invalidate the necessary cached contributions", async () => {
    const size = 12, cache = new InundationRasterCache();
    const a = ground(-1,-1,15,15,0,0), b = wall(6,0,12);
    await cache.build([a,b],size,1,true,1);
    const edited = wall(8,0,12);
    expectParity(await cache.build([a,edited],size,1,true,1),direct([a,edited],size,1,true,1),size,1);
    expect(cache.lastBuildStats.coveragePartsReused).toBe(0);
    expect(cache.lastBuildStats.barrierPartsReused).toBe(1);
    expectParity(await cache.build([a],size,1,true,1),direct([a],size,1,true,1),size,1);
    expect(cache.edges.size).toBe(1);
    const index = {count: 6, version: 0, getX: i => [0,1,2,0,2,3][i]};
    a.input.index = index;
    await cache.build([a],size,1,true,1);
    index.version++;
    expectParity(await cache.build([a],size,1,true,1),direct([a],size,1,true,1),size,1);
    expect(cache.lastBuildStats.coveragePartsReused).toBe(0);
    expectParity(await cache.build([a],size + 2,1,true,1),direct([a],size + 2,1,true,1),size + 2,1);
    expect(cache.lastBuildStats.barrierPartsReused).toBe(0);
});

test("cancellation leaves completed grids and edge caches untouched", async () => {
    const size = 16, cache = new InundationRasterCache();
    const a = ground(-1,-1,8,17,0,2), b = ground(7,-1,17,17,-1,0.1), c = wall(10,0,16);
    const before = await cache.build([a],size,1,true,2);
    const rawBefore = before.rawCoverage.slice(), heightsBefore = before.surfaceHeights.slice();
    const state = cache.coverageState, edges = cache.edges, stats = cache.lastBuildStats;
    let calls = 0;
    await expect(cache.build([a,b,c],size,1,true,2,{checkpoint: () => {
        if (++calls === 2) throw new Error("canceled");
    }})).rejects.toThrow("canceled");
    expect(cache.coverageState).toBe(state);
    expect(cache.edges).toBe(edges);
    expect(cache.lastBuildStats).toBe(stats);
    equalBytes(before.rawCoverage,rawBefore);
    equalBytes(before.surfaceHeights,heightsBefore);
    expectParity(await cache.build([a,b,c],size,1,true,2),direct([a,b,c],size,1,true,2),size,1);
});

test("draw ranges, non-indexed faces, multiple instances, and coverage toggles share exact rasterization", async () => {
    const size = 12, cache = new InundationRasterCache();
    const groundPart = ground(-1,-1,13,13,0,0);
    const range = part([3,0,0, 3,12,0, 3,12,4, 7,0,0, 7,12,0, 7,12,4],0,false,null,3,3);
    const instanced = wall(9,0,5,4,0,false);
    instanced.projected.push(wall(9,7,12,4,0,false).projected[0]);
    const parts = [groundPart,range,instanced];
    for (const coverage of [true,false,true]) {
        expectParity(await cache.build(parts,size,1,coverage,1),direct(parts,size,1,coverage,1),size,1);
    }
    expect(cache.lastBuildStats.coverageTriangles).toBe(0);
    cache.clear();
    expectParity(await cache.build(parts,size,1,true,1),direct(parts,size,1,true,1),size,1);
    expect(cache.lastBuildStats.coveragePartsReused).toBe(0);
    expect(cache.lastBuildStats.barrierPartsReused).toBe(0);
});

test("deterministic mixed triangle batches match the direct rasterizer across coverage and tide changes", async () => {
    let seed = 186742;
    const random = () => { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const size = 32, cache = new InundationRasterCache(), parts = [];
    for (let batch = 0; batch < 12; batch++) {
        const vertices = [];
        for (let i = 0; i < 30; i++) vertices.push(random() * 40 - 4,random() * 40 - 4,random() * 12 - 3);
        parts.push(part(vertices,[0,0.1,3,Infinity][batch % 4],batch % 3 !== 0));
        const level = batch % 4, coverage = batch % 5 !== 0;
        expectParity(await cache.build(parts,size,level,coverage,0.2),direct(parts,size,level,coverage,0.2),size,level);
    }
});
