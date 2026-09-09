/** @jest-environment jsdom */

if (!window.matchMedia) {
    window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
}

const {PerspectiveCamera} = require("three");
const {CNodeView} = require("../src/nodes/CNodeView");
const globals = require("../src/Globals");
const {par} = require("../src/par");
const {ViewMan} = require("../src/CViewManager");

test("a sky camera update preserves the pipeline's existing canvas dimensions", () => {
    const previousNodes = globals.NodeMan;
    globals.setNodeMan({exists: () => false});
    const renderer = {
        domElement: {width: 1, height: 1},
        getPixelRatio: () => 0.25,
        setSize: jest.fn(),
    };
    const view = {widthPx: 1, heightPx: 1, in: {}, renderer, camera: new PerspectiveCamera()};
    try {
        CNodeView.prototype.preRenderCameraUpdate.call(view);
        expect(view.camera.aspect).toBe(1);
        expect(renderer.setSize).not.toHaveBeenCalled();
    } finally {
        globals.setNodeMan(previousNodes);
    }
});

test("a delayed resize requests a frame without clearing the finished canvas", () => {
    const previousRenderOne = par.renderOne;
    const renderer = {setSize: jest.fn()};
    const view = {renderer, in: {canvasWidth: {v0: 1600}}, widthPx: 950, heightPx: 851};
    try {
        globals.setRenderOne(false);
        CNodeView.prototype.deferredResizeWebGL.call(view);
        expect(par.renderOne).toBe(true);
        expect(renderer.setSize).not.toHaveBeenCalled();
    } finally {
        par.renderOne = previousRenderOne;
    }
});

test("fixed-view point scaling has no hidden split-view resolution multiplier", () => {
    const split = jest.spyOn(ViewMan, "isSideBySideMode").mockReturnValue(true);
    const view = {in: {canvasWidth: {v0: 1600}}, widthPx: 950, heightPx: 851};
    try {
        expect(CNodeView.prototype.getRenderTargetHeight.call(view)).toBe(1433);
        split.mockReturnValue(false);
        expect(CNodeView.prototype.getRenderTargetHeight.call(view)).toBe(1433);
    } finally {
        split.mockRestore();
    }
});
