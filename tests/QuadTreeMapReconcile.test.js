jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/QuadTreeTile", () => ({QuadTreeTile: jest.fn()}));

import {QuadTreeMapTexture} from "../src/QuadTreeMapTexture";
import {PerspectiveCamera} from "three";
import {setSit} from "../src/Globals";

const LAYER = 1 << 3;

function makeTile(id, {
    z = 0,
    x = 0,
    y = 0,
    active = true,
    ready = true,
    suppressed = false,
    visible = true,
    frustumIntersects = undefined,
    coverageVisible = undefined,
} = {}) {
    const tileLayers = active ? LAYER : 0;
    const renderSuppressedLayers = suppressed ? LAYER : 0;
    const renderMask = tileLayers & ~renderSuppressedLayers;

    return {
        id,
        z,
        x,
        y,
        visible,
        frustumIntersects,
        coverageVisible,
        tileLayers,
        renderSuppressedLayers,
        loaded: ready,
        added: ready,
        geometryReady: ready,
        isDeadBranch: false,
        isLoading: false,
        children: null,
        parent: null,
        inactiveSince: undefined,
        cancelPendingLoads: jest.fn(),
        key() {
            return id;
        },
        mesh: {
            visible: true,
            parent: ready ? {} : null,
            layers: {mask: renderMask},
            geometry: {},
            getMap() {
                return this.material?.uniforms?.map || null;
            },
            material: {
                wireframe: false,
                uniforms: ready ? {map: {}} : {},
            },
        },
        skirtMesh: {
            layers: {mask: renderMask},
        },
        _updateOBBDebug: jest.fn(),
    };
}

function link(parent, children) {
    parent.children = children;
    for (const child of children) {
        if (child) child.parent = parent;
    }
    return parent;
}

function collectTiles(root, out = []) {
    out.push(root);
    if (root.children) {
        for (const child of root.children) {
            if (child) collectTiles(child, out);
        }
    }
    return out;
}

function tileCoordKey(tile) {
    return `${tile.z}/${tile.x}/${tile.y}`;
}

function makeMap(roots) {
    const map = Object.create(QuadTreeMapTexture.prototype);
    const tiles = roots.flatMap(root => collectTiles(root));

    map.allTiles = new Set(tiles);
    map.parentTiles = new Set(tiles.filter(tile => tile.children));
    map.tileCache = {};
    map._tileStateGeneration = 0;
    map.scene = {remove: jest.fn()};
    map.maxZoom = 20;
    map.currentStats = new Map();
    map.lastLoggedStats = new Map();

    for (const tile of tiles) {
        if (!map.tileCache[tile.z]) map.tileCache[tile.z] = {};
        if (!map.tileCache[tile.z][tile.x]) map.tileCache[tile.z][tile.x] = {};
        map.tileCache[tile.z][tile.x][tile.y] = tile;
    }

    map.calculateTileVisibility = jest.fn((tile, camera, options = null) => {
        const visible = options?.coverageMode === "coverageSphereOnly" && tile.coverageVisible !== undefined
            ? tile.coverageVisible
            : tile.visible !== false;
        const frustumIntersects = tile.frustumIntersects !== undefined
            ? tile.frustumIntersects
            : visible;
        return {
            visible,
            actuallyVisible: visible,
            frustumIntersects,
            screenSpaceError: 1,
        };
    });

    map.invalidateCoverageCache = jest.fn();
    map.setTileLayerMask = jest.fn((tile, layerMask) => {
        const renderMask = layerMask & ~(tile.renderSuppressedLayers || 0);
        tile.mesh.layers.mask = renderMask;
        if (tile.skirtMesh) tile.skirtMesh.layers.mask = renderMask;
    });

    map.activateTile = jest.fn((x, y, z, layerMask, useParentData = false) => {
        const tile = map.getTile(x, y, z);
        if (!tile) throw new Error(`Missing tile ${z}/${x}/${y}`);
        tile.lastUseParentData = useParentData;
        const wasActiveInLayer = (tile.tileLayers & layerMask) !== 0;
        tile.tileLayers |= layerMask;
        if (!wasActiveInLayer) {
            tile.renderSuppressedLayers = (tile.renderSuppressedLayers || 0) & ~layerMask;
        }
        tile.added = true;
        if (tile.mesh) tile.mesh.parent = tile.mesh.parent || {};
        map.setTileLayerMask(tile, tile.tileLayers);
        return tile;
    });

    map.deactivateTile = jest.fn((tile, layerMask) => {
        tile.tileLayers &= ~layerMask;
        tile.renderSuppressedLayers = (tile.renderSuppressedLayers || 0) & ~layerMask;
        map.setTileLayerMask(tile, tile.tileLayers);
        if (tile.tileLayers === 0) {
            tile.added = false;
            tile.mesh.parent = null;
        }
    });

    map.deactivateBranch = jest.fn();

    return map;
}

function isRendering(map, tile) {
    return map.isRenderingForView(tile, LAYER);
}

describe("QuadTreeMap texture cut reconciliation", () => {
    test("ray geometry paces refinement and preserves parents at its tile ceiling", () => {
        const parents = Array.from({length: 30}, (_, x) => makeTile(`10/${x}/0`, {z: 10, x}));
        const map = makeMap(parents);
        map.canSubdivide = () => true;
        map.shouldSubdivideTile = () => true;
        map.anyProspectiveChildVisible = () => true;
        map.deactivateParentsWithLoadedChildren = jest.fn();
        map.reconcileRenderedTileCut = jest.fn();
        map.triggerLazyLoadIfNeeded = jest.fn();
        map.subdivideTile = jest.fn();
        const camera = new PerspectiveCamera(2, 1, 1, 1e6);
        const setTerrainDetailLimited = jest.fn();
        const view = {id: "lookView", cameraNode: {camera}, tileLayers: LAYER, heightPx: 500,
            raytracedRefraction: {drawsTerrainGeometry: () => true, geometryContext: () => ({rayTable: {}}),
                tool: {setTerrainDetailLimited}}};
        map.subdivideTilesViewSpecific(view);
        expect(map.subdivideTile).toHaveBeenCalledTimes(16);
        expect(map.rayGeometryDetailLimited).toBe(false);
        while (map.allTiles.size < 5996) map.allTiles.add({tileLayers: 0, children: null, _updateOBBDebug() {}});
        map.subdivideTile.mockClear();
        map.subdivideTilesViewSpecific(view);
        expect(map.subdivideTile).toHaveBeenCalledTimes(1);
        expect(map.rayGeometryDetailLimited).toBe(true);
        while (map.allTiles.size < 6000) map.allTiles.add({tileLayers: 0, children: null, _updateOBBDebug() {}});
        map.subdivideTile.mockClear();
        map.subdivideTilesViewSpecific(view);
        expect(map.subdivideTile).not.toHaveBeenCalled();
        expect(setTerrainDetailLimited).toHaveBeenCalledWith("QuadTreeMapTexture", true);
        expect(parents.every(tile => isRendering(map, tile))).toBe(true);
        delete view.raytracedRefraction;
        map.subdivideTilesViewSpecific(view);
        expect(map.subdivideTile).toHaveBeenCalledTimes(30);
    });

    test("standard refraction lifts visibility only; ray-traced geometry owns selection", () => {
        // Standard refraction is on by default. Its lift may only decide whether
        // a tile can be seen (_terrainLift); the LOD error stays physical, which
        // is the selection the visual baselines record. Only a ray-traced
        // Terrain Geometry context reaches the LOD error (_terrainRefraction).
        setSit({refraction: true, refractionTerrain: true, terrestrialRefraction: true});
        try {
            const map = makeMap([makeTile("10/0/0", {z: 10})]);
            map.deactivateParentsWithLoadedChildren = jest.fn();
            map.reconcileRenderedTileCut = jest.fn();
            map.triggerLazyLoadIfNeeded = jest.fn();
            map.mergeChildrenIfPossible = jest.fn();
            const camera = new PerspectiveCamera(30, 1, 1, 1000);
            const view = {id: "lookView", cameraNode: {camera}, tileLayers: LAYER, heightPx: 500};
            map.subdivideTilesViewSpecific(view, 1.5);
            expect(camera._terrainRefraction).toBeNull();
            expect(camera._terrainLift).toMatchObject({k: expect.any(Number)});
            expect(camera._terrainLift.rayTable).toBeUndefined();
            // A ray-traced pass on this view draws its terrain unlifted until it
            // supplies Terrain Geometry (Screen-space Mirages, or not ready yet).
            const setTerrainDetailLimited = jest.fn();
            view.raytracedRefraction = {drawsTerrainGeometry: () => true, geometryContext: () => null,
                tool: {setTerrainDetailLimited}};
            map.subdivideTilesViewSpecific(view, 1.5);
            expect(camera._terrainRefraction).toBeNull();
            expect(camera._terrainLift).toBeNull();
            const context = {rayTable: {}};
            view.raytracedRefraction.geometryContext = () => context;
            map.subdivideTilesViewSpecific(view, 1.5);
            expect(camera._terrainRefraction).toBe(context);
            expect(camera._terrainLift).toBeNull();
            // Refraction off: no context at all.
            setSit({refraction: false, refractionTerrain: true, terrestrialRefraction: false});
            delete view.raytracedRefraction;
            map.subdivideTilesViewSpecific(view, 1.5);
            expect(camera._terrainRefraction).toBeNull();
            expect(camera._terrainLift).toBeNull();
        } finally {
            setSit(undefined);
        }
    });

    test("leaving Terrain Geometry merges its extra detail without the dead band", () => {
        // Ray-traced Terrain Geometry refines distant terrain past Standard. Back in
        // Standard the parents of that detail sit in the merge dead band (1 px here,
        // between half the 1.5 px target and the target), which kept it for good.
        const children = [0, 1, 2, 3].map(i => makeTile(`1/${i & 1}/${i >> 1}`, {z: 1, x: i & 1, y: i >> 1}));
        const parent = link(makeTile("0/0/0", {active: false}), children);
        const map = makeMap([parent]);
        map.canSubdivide = () => true;
        map.deactivateParentsWithLoadedChildren = jest.fn();
        map.reconcileRenderedTileCut = jest.fn();
        map.triggerLazyLoadIfNeeded = jest.fn();
        // Merges once, as a one-level refinement would; then there is nothing left.
        map.mergeChildrenIfPossible = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
        map.updateMergeCameraStability = () => 100;     // the camera has stopped
        const camera = new PerspectiveCamera(30, 1, 1, 1000);
        const view = {id: "lookView", cameraNode: {camera}, tileLayers: LAYER, heightPx: 500,
            raytracedRefraction: {drawsTerrainGeometry: () => true, geometryContext: () => null,
                tool: {setTerrainDetailLimited: jest.fn()}}};
        map.subdivideTilesViewSpecific(view, 1.5);
        map.subdivideTilesViewSpecific(view, 1.5);
        expect(map.mergeChildrenIfPossible).not.toHaveBeenCalled();
        // Screen-space Mirages draws terrain unrefracted, as Standard selects it.
        view.raytracedRefraction.drawsTerrainGeometry = () => false;
        map.subdivideTilesViewSpecific(view, 1.5);
        expect(map.mergeChildrenIfPossible).toHaveBeenCalledWith(parent, LAYER);
        // A deeper refinement collapses one level a pass, so it goes on while
        // passes merge ...
        map.mergeChildrenIfPossible.mockClear();
        map.subdivideTilesViewSpecific(view, 1.5);
        expect(map.mergeChildrenIfPossible).toHaveBeenCalledTimes(1);
        // ... and stops at the first that merges nothing: the dead band is back.
        map.mergeChildrenIfPossible.mockClear();
        map.subdivideTilesViewSpecific(view, 1.5);
        expect(map.mergeChildrenIfPossible).not.toHaveBeenCalled();
    });

    test("an invisible tile is not kept active for having children", () => {
        // Ray-traced Terrain Geometry refines terrain beyond the horizon. Back in
        // Standard those tiles are invisible. Their leaves were deactivated, but a
        // parent stayed active for having children, drawn until timed pruning
        // removed them, and a merge activated an invisible parent in their place.
        const quarter = (z, x0, options) => [0, 1, 2, 3].map(i =>
            makeTile(`${z}/${x0 + (i & 1)}/${i >> 1}`, {z, x: x0 + (i & 1), y: i >> 1, ...options}));
        // Its children are inactive already: the parent is all that is drawn.
        const stranded = link(makeTile("1/0/0", {z: 1, visible: false}), quarter(2, 0, {active: false, visible: false}));
        // Its children are still active: it merges them, and must not replace them.
        const merging = link(makeTile("1/1/0", {z: 1, x: 1, active: false, visible: false}), quarter(2, 2, {visible: false}));
        const map = makeMap([stranded, merging]);
        const visibility = map.calculateTileVisibility;
        // An invisible tile has no screen-space error.
        map.calculateTileVisibility = jest.fn((tile, camera, options) => {
            const result = visibility(tile, camera, options);
            return result.visible ? result : {...result, screenSpaceError: 0};
        });
        map.canSubdivide = () => true;
        map.deactivateParentsWithLoadedChildren = jest.fn();
        map.reconcileRenderedTileCut = jest.fn();
        map.triggerLazyLoadIfNeeded = jest.fn();
        map.updateMergeCameraStability = () => 100;     // the camera has stopped
        const camera = new PerspectiveCamera(30, 1, 1, 1000);
        map.subdivideTilesViewSpecific({id: "lookView", cameraNode: {camera}, tileLayers: LAYER, heightPx: 500}, 1.5);
        expect(stranded.tileLayers & LAYER).toBe(0);
        expect(map.deactivateBranch).toHaveBeenCalled();
        expect(merging.tileLayers & LAYER).toBe(0);
    });

    test("ready ignores render suppression but rendering does not", () => {
        const tile = makeTile("0/0/0", {suppressed: true});
        const map = makeMap([tile]);

        expect(map.isReadyForView(tile, LAYER)).toBe(true);
        expect(map.isRenderingForView(tile, LAYER)).toBe(false);

        map.setTileRenderSuppressed(tile, LAYER, false);
        expect(map.isRenderingForView(tile, LAYER)).toBe(true);
    });

    test("areaReadyByDescendants accepts suppressed ready children", () => {
        const parent = makeTile("0/0/0");
        const children = [
            makeTile("1/0/0", {z: 1, x: 0, y: 0, suppressed: true}),
            makeTile("1/1/0", {z: 1, x: 1, y: 0, suppressed: true}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, suppressed: true}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, suppressed: true}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        expect(map.areaCoveredByDescendants(parent, LAYER)).toBe(false);
        expect(map.areaReadyByDescendants(parent, LAYER)).toBe(true);
    });

    test("full ready descendant cover reveals children and deactivates parent", () => {
        const parent = makeTile("0/0/0");
        const children = [
            makeTile("1/0/0", {z: 1, x: 0, y: 0, suppressed: true}),
            makeTile("1/1/0", {z: 1, x: 1, y: 0, suppressed: true}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, suppressed: true}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, suppressed: true}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER);

        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(false);
        for (const child of children) {
            expect(isRendering(map, child)).toBe(true);
            expect(child.renderSuppressedLayers & LAYER).toBe(0);
        }
    });

    test("partial descendant readiness keeps parent fallback and suppresses children", () => {
        const parent = makeTile("0/0/0");
        const readyChild = makeTile("1/0/0", {z: 1, x: 0, y: 0});
        const children = [
            readyChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, ready: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, ready: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, ready: false}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER);

        expect(map.deactivateTile).not.toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(true);
        expect(isRendering(map, readyChild)).toBe(false);
        expect(readyChild.renderSuppressedLayers & LAYER).toBe(LAYER);
    });

    test("inactive parent does not replace an already-rendering partial descendant cut", () => {
        const parent = makeTile("0/0/0", {active: false});
        const readyChild = makeTile("1/0/0", {z: 1, x: 0, y: 0});
        const children = [
            readyChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, active: false, ready: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, active: false, ready: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, active: false, ready: false}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER);

        expect(map.activateTile).not.toHaveBeenCalledWith(parent.x, parent.y, parent.z, LAYER);
        expect(isRendering(map, parent)).toBe(false);
        expect(isRendering(map, readyChild)).toBe(true);
        expect(readyChild.renderSuppressedLayers & LAYER).toBe(0);
    });

    test("force-visited empty wing siblings do not break a rendered cut", () => {
        // Parent + 4 children, only one child is active+rendering. The other 3
        // are inactive empty cache entries (no rendering activity, no
        // descendants) and out of strict frustum. forceFullSiblingCheck would
        // visit them, but they must not break readyCovered/renderedCovered —
        // otherwise the partial-fallback suppression block hides the single
        // rendering child and exposes the coarse parent, which is the source
        // of mass z14-disappears-for-one-frame flicker during rapid camera
        // motion when only some descendants stay in the strict frustum.
        const parent = makeTile("0/0/0");
        const offAxisChild = makeTile("1/0/0", {z: 1, x: 0, y: 0, visible: false});
        link(parent, [
            offAxisChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, visible: false, active: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, visible: false, active: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, visible: false, active: false}),
        ]);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {});

        // The one rendering child covers everything the camera can actually
        // see, so reconcile prefers the deeper cut: parent deactivated, child
        // stays rendering, no suppression.
        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, offAxisChild)).toBe(true);
        expect(offAxisChild.renderSuppressedLayers & LAYER).toBe(0);
    });

    test("coverage-invisible full rendered sibling cover can replace parent", () => {
        const parent = makeTile("0/0/0");
        const children = [
            makeTile("1/0/0", {z: 1, x: 0, y: 0, visible: false}),
            makeTile("1/1/0", {z: 1, x: 1, y: 0, visible: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, visible: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, visible: false}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {});

        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(false);
        for (const child of children) {
            expect(isRendering(map, child)).toBe(true);
            expect(child.renderSuppressedLayers & LAYER).toBe(0);
        }
    });

    test("parent visible in view mode still reconciles when coverage mode misses it", () => {
        const parent = makeTile("0/0/0", {coverageVisible: false});
        const children = [
            makeTile("1/0/0", {z: 1, x: 0, y: 0, coverageVisible: false}),
            makeTile("1/1/0", {z: 1, x: 1, y: 0, coverageVisible: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, coverageVisible: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, coverageVisible: false}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {}, {coverageMode: "main"});

        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(false);
        for (const child of children) {
            expect(isRendering(map, child)).toBe(true);
        }
    });

    test("ready covered inactive parent reveals suppressed children missed by coverage", () => {
        const parent = makeTile("0/0/0", {active: false});
        const missedChild = makeTile("1/0/0", {
            z: 1,
            x: 0,
            y: 0,
            suppressed: true,
            coverageVisible: false,
        });
        const children = [
            missedChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1}),
        ];
        link(parent, children);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {}, {coverageMode: "main"});

        expect(missedChild.renderSuppressedLayers & LAYER).toBe(0);
        expect(isRendering(map, missedChild)).toBe(true);
        expect(map.activateTile).not.toHaveBeenCalled();
    });

    test("actual view ready cover is not vetoed by coverage-only siblings", () => {
        const parent = makeTile("0/0/0");
        const visibleReadyChild = makeTile("1/0/0", {
            z: 1,
            x: 0,
            y: 0,
            suppressed: true,
        });
        const offAxisCoverageChildren = [
            makeTile("1/1/0", {
                z: 1,
                x: 1,
                y: 0,
                active: false,
                visible: false,
                coverageVisible: true,
            }),
            makeTile("1/0/1", {
                z: 1,
                x: 0,
                y: 1,
                active: false,
                visible: false,
                coverageVisible: true,
            }),
            makeTile("1/1/1", {
                z: 1,
                x: 1,
                y: 1,
                active: false,
                visible: false,
                coverageVisible: true,
            }),
        ];
        link(parent, [visibleReadyChild, ...offAxisCoverageChildren]);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {}, {coverageMode: "main"});

        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(false);
        expect(isRendering(map, visibleReadyChild)).toBe(true);
        expect(visibleReadyChild.renderSuppressedLayers & LAYER).toBe(0);
        for (const child of offAxisCoverageChildren) {
            expect(child.tileLayers & LAYER).toBe(0);
        }
    });

    test("preload-margin children do not force parent fallback over ready render cut", () => {
        const parent = makeTile("0/0/0");
        const visibleReadyChild = makeTile("1/0/0", {
            z: 1,
            x: 0,
            y: 0,
            suppressed: true,
        });
        const preloadOnlyChildren = [
            makeTile("1/1/0", {
                z: 1,
                x: 1,
                y: 0,
                active: false,
                ready: false,
                visible: true,
                frustumIntersects: false,
            }),
            makeTile("1/0/1", {
                z: 1,
                x: 0,
                y: 1,
                active: false,
                ready: false,
                visible: true,
                frustumIntersects: false,
            }),
            makeTile("1/1/1", {
                z: 1,
                x: 1,
                y: 1,
                active: false,
                ready: false,
                visible: true,
                frustumIntersects: false,
            }),
        ];
        link(parent, [visibleReadyChild, ...preloadOnlyChildren]);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER, {}, {coverageMode: "main"});

        expect(map.deactivateTile).toHaveBeenCalledWith(parent, LAYER, true);
        expect(isRendering(map, parent)).toBe(false);
        expect(isRendering(map, visibleReadyChild)).toBe(true);
        expect(visibleReadyChild.renderSuppressedLayers & LAYER).toBe(0);
        for (const child of preloadOnlyChildren) {
            expect(child.tileLayers & LAYER).toBe(0);
            expect(child.renderSuppressedLayers & LAYER).toBe(0);
        }
    });

    test("surgical reactivation preserves parent-data fallback for entering children", () => {
        const parent = makeTile("0/0/0");
        const activeChild = makeTile("1/0/0", {z: 1, x: 0, y: 0});
        const enteringChild = makeTile("1/1/0", {
            z: 1,
            x: 1,
            y: 0,
            active: false,
        });
        link(parent, [
            activeChild,
            enteringChild,
            makeTile("1/0/1", {z: 1, x: 0, y: 1, active: false, visible: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, active: false, visible: false}),
        ]);
        const map = makeMap([parent]);
        map.deactivateParentsWithLoadedChildren = jest.fn();
        map.reconcileRenderedTileCut = jest.fn();
        map.triggerLazyLoadIfNeeded = jest.fn();
        map.mergeChildrenIfPossible = jest.fn();

        const camera = new PerspectiveCamera(30, 1, 1, 1000);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        map.subdivideTilesViewSpecific({
            id: "mainView",
            cameraNode: {camera},
            tileLayers: LAYER,
            heightPx: 1000,
        }, 1.5);

        expect(map.activateTile).toHaveBeenCalledWith(
            enteringChild.x,
            enteringChild.y,
            enteringChild.z,
            LAYER,
            true
        );
        expect(enteringChild.lastUseParentData).toBe(true);
    });

    test("texture merges wait until the camera is stable", () => {
        const parent = makeTile("0/0/0");
        link(parent, [
            makeTile("1/0/0", {z: 1, x: 0, y: 0}),
            makeTile("1/1/0", {z: 1, x: 1, y: 0}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1}),
        ]);
        const map = makeMap([parent]);
        map.deactivateParentsWithLoadedChildren = jest.fn();
        map.reconcileRenderedTileCut = jest.fn();
        map.triggerLazyLoadIfNeeded = jest.fn();
        map.mergeChildrenIfPossible = jest.fn(() => true);

        const camera = new PerspectiveCamera(30, 1, 1, 1000);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const view = {
            id: "mainView",
            cameraNode: {camera},
            tileLayers: LAYER,
            heightPx: 1000,
        };

        map.subdivideTilesViewSpecific(view, 10);
        expect(map.mergeChildrenIfPossible).not.toHaveBeenCalled();

        camera.position.x += 1;
        camera.updateMatrixWorld();
        map.subdivideTilesViewSpecific(view, 10);
        expect(map.mergeChildrenIfPossible).not.toHaveBeenCalled();

        for (let i = 0; i < 13; i++) {
            map.subdivideTilesViewSpecific(view, 10);
        }
        expect(map.mergeChildrenIfPossible).toHaveBeenCalledWith(parent, LAYER);
    });

    test("activateTile applies parent-data fallback when reactivating existing texture child", () => {
        const parent = makeTile("0/0/0");
        const oldMap = {dispose: jest.fn()};
        const oldMaterial = {
            wireframe: true,
            uniforms: {},
            getMap: () => oldMap,
            dispose: jest.fn(),
        };
        const parentMaterial = {wireframe: false, uniforms: {map: {}}};
        parent.mesh.material = parentMaterial;
        parent.mesh.getMap = () => parentMaterial.uniforms.map;

        const child = makeTile("1/0/0", {
            z: 1,
            x: 0,
            y: 0,
            active: false,
            ready: false,
        });
        child.parent = parent;
        child.mesh.material = oldMaterial;
        child.mesh.parent = null;
        child.added = false;
        const parentDataMaterial = {wireframe: false, uniforms: {map: {}}};
        child.buildMaterialFromParent = jest.fn(() => parentDataMaterial);
        child.updateSkirtMaterial = jest.fn();
        child.textureUrl = jest.fn(() => "tile-url");

        const map = Object.create(QuadTreeMapTexture.prototype);
        map.maxZoom = 20;
        map.getTile = jest.fn(() => child);
        map.addTileWhenReady = jest.fn(tile => {
            tile.added = true;
            tile.mesh.parent = {};
        });
        map.setTileLayerMask = jest.fn((tile, layerMask) => {
            tile.mesh.layers.mask = layerMask & ~(tile.renderSuppressedLayers || 0);
        });
        map.invalidateCoverageCache = jest.fn();
        map.refreshDebugGeometry = jest.fn();
        map.trackTileLoading = jest.fn();

        const result = map.activateTile(child.x, child.y, child.z, LAYER, true);

        expect(result).toBe(child);
        expect(child.buildMaterialFromParent).toHaveBeenCalledWith(parent);
        expect(child.mesh.material).toBe(parentDataMaterial);
        expect(child.usingParentData).toBe(true);
        expect(child.needsHighResLoad).toBe(true);
        expect(child.loaded).toBe(true);
        expect(child.isDeadBranch).toBe(false);
        expect(child.updateSkirtMaterial).toHaveBeenCalled();
        expect(map.trackTileLoading).not.toHaveBeenCalled();
    });

    test("shallower fallback owns partial branches before deeper cuts can reveal", () => {
        const root = makeTile("0/0/0");
        const branch = makeTile("1/0/0", {z: 1, x: 0, y: 0});
        const missingSibling = makeTile("1/1/0", {z: 1, x: 1, y: 0, ready: false});
        const branchChildren = [
            makeTile("2/0/0", {z: 2, x: 0, y: 0, suppressed: true}),
            makeTile("2/1/0", {z: 2, x: 1, y: 0, suppressed: true}),
            makeTile("2/0/1", {z: 2, x: 0, y: 1, suppressed: true}),
            makeTile("2/1/1", {z: 2, x: 1, y: 1, suppressed: true}),
        ];
        link(branch, branchChildren);
        link(root, [
            branch,
            missingSibling,
            makeTile("1/0/1", {z: 1, x: 0, y: 1, ready: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, ready: false}),
        ]);
        const map = makeMap([root]);

        map.reconcileRenderedTileCut(LAYER);

        expect(map.deactivateTile).not.toHaveBeenCalledWith(branch, LAYER, true);
        expect(branch.tileLayers & LAYER).toBe(LAYER);
        expect(isRendering(map, branch)).toBe(false);
        for (const child of branchChildren) {
            expect(isRendering(map, child)).toBe(false);
            expect(child.renderSuppressedLayers & LAYER).toBe(LAYER);
        }
    });

    test("stale suppression is cleared when an active parent becomes fallback again", () => {
        const parent = makeTile("0/0/0", {suppressed: true});
        const readyChild = makeTile("1/0/0", {z: 1, x: 0, y: 0});
        link(parent, [
            readyChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, ready: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, ready: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, ready: false}),
        ]);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER);

        expect(isRendering(map, parent)).toBe(true);
        expect(parent.renderSuppressedLayers & LAYER).toBe(0);
        expect(isRendering(map, readyChild)).toBe(false);
    });

    test("mergeChildrenIfPossible does not collapse through inactive children to deep descendants", () => {
        const parent = makeTile("0/0/0", {active: false});
        const child = makeTile("1/0/0", {z: 1, x: 0, y: 0, active: false});
        const grandchild = makeTile("2/0/0", {z: 2, x: 0, y: 0});
        link(child, [grandchild, null, null, null]);
        link(parent, [
            child,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, active: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, active: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, active: false}),
        ]);
        const map = makeMap([parent]);

        expect(map.mergeChildrenIfPossible(parent, LAYER)).toBe(false);
        expect(map.activateTile).not.toHaveBeenCalled();
        expect(map.deactivateBranch).not.toHaveBeenCalled();
    });

    test("reconcileRenderedTileCut never activates an inactive parent", () => {
        const parent = makeTile("0/0/0", {active: false});
        const readySuppressedChild = makeTile("1/0/0", {
            z: 1,
            x: 0,
            y: 0,
            suppressed: true,
        });
        link(parent, [
            readySuppressedChild,
            makeTile("1/1/0", {z: 1, x: 1, y: 0, active: false, ready: false}),
            makeTile("1/0/1", {z: 1, x: 0, y: 1, active: false, ready: false}),
            makeTile("1/1/1", {z: 1, x: 1, y: 1, active: false, ready: false}),
        ]);
        const map = makeMap([parent]);

        map.reconcileRenderedTileCut(LAYER);

        expect(map.activateTile).not.toHaveBeenCalledWith(parent.x, parent.y, parent.z, LAYER);
        expect(isRendering(map, parent)).toBe(false);
        expect(readySuppressedChild.renderSuppressedLayers & LAYER).toBe(LAYER);
    });
});
