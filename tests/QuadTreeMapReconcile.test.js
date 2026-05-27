jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/QuadTreeTile", () => ({QuadTreeTile: jest.fn()}));

import {QuadTreeMapTexture} from "../src/QuadTreeMapTexture";

const LAYER = 1 << 3;

function makeTile(id, {
    z = 0,
    x = 0,
    y = 0,
    active = true,
    ready = true,
    suppressed = false,
    visible = true,
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
            material: {
                wireframe: false,
                uniforms: ready ? {map: {}} : {},
            },
        },
        skirtMesh: {
            layers: {mask: renderMask},
        },
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

    for (const tile of tiles) {
        if (!map.tileCache[tile.z]) map.tileCache[tile.z] = {};
        if (!map.tileCache[tile.z][tile.x]) map.tileCache[tile.z][tile.x] = {};
        map.tileCache[tile.z][tile.x][tile.y] = tile;
    }

    map.calculateTileVisibility = jest.fn(tile => ({
        visible: tile.visible !== false,
        actuallyVisible: tile.visible !== false,
        screenSpaceError: 1,
    }));

    map.invalidateCoverageCache = jest.fn();
    map.setTileLayerMask = jest.fn((tile, layerMask) => {
        const renderMask = layerMask & ~(tile.renderSuppressedLayers || 0);
        tile.mesh.layers.mask = renderMask;
        if (tile.skirtMesh) tile.skirtMesh.layers.mask = renderMask;
    });

    map.activateTile = jest.fn((x, y, z, layerMask) => {
        const tile = map.getTile(x, y, z);
        if (!tile) throw new Error(`Missing tile ${z}/${x}/${y}`);
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
});
