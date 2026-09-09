import {HalfFloatType, UnsignedByteType, Vector2, WebGLRenderTarget} from "three";
import {createSceneRenderTarget, resizeRenderTargetsToDrawingBuffer} from "../src/ViewRenderTargets";

function makeRenderer({half = [4, 2], byte = [4, 2], depth = [4, 2], max = 4, incomplete = []} = {}) {
    const originalTarget = {name: "previous cube target"};
    let boundTarget = originalTarget;
    const attemptedTargets = [];
    const gl = {
        RENDERBUFFER: "renderbuffer", RGBA16F: "half", RGBA8: "byte",
        DEPTH_COMPONENT24: "depth", SAMPLES: "samples",
        FRAMEBUFFER: "framebuffer", FRAMEBUFFER_COMPLETE: "complete",
        getInternalformatParameter: jest.fn((_, format) => new Int32Array({half, byte, depth}[format])),
        checkFramebufferStatus: jest.fn(() => incomplete.includes(boundTarget.samples) ? "incomplete" : "complete"),
    };
    const renderer = {
        capabilities: {maxSamples: max},
        getContext: () => gl,
        getRenderTarget: () => boundTarget,
        getActiveCubeFace: () => 3,
        getActiveMipmapLevel: () => 2,
        setRenderTarget: jest.fn(target => {
            boundTarget = target;
            if (target !== originalTarget) {
                jest.spyOn(target, "dispose");
                attemptedTargets.push(target);
            }
        }),
    };
    return {renderer, gl, originalTarget, attemptedTargets};
}

describe("scene target MSAA", () => {
    test.each([HalfFloatType, UnsignedByteType])("uses supported MSAA for color type %s", type => {
        const {renderer, originalTarget} = makeRenderer();
        const target = createSceneRenderTarget(renderer, type, 4);
        expect(target.samples).toBe(4);
        expect(target.texture.type).toBe(type);
        expect(target.depthBuffer).toBe(true);
        expect(target.stencilBuffer).toBe(false);
        expect(renderer.getRenderTarget()).toBe(originalTarget);
        expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(originalTarget, 3, 2);
        expect(target.dispose).not.toHaveBeenCalled();
    });

    test("uses the float format's sample limits instead of the byte format's", () => {
        const {renderer} = makeRenderer({half: [2], byte: [8, 4, 2], max: 8});
        expect(createSceneRenderTarget(renderer, HalfFloatType, 4).samples).toBe(2);
        expect(createSceneRenderTarget(renderer, UnsignedByteType, 4).samples).toBe(4);
    });

    test.each([
        ["user limit", {}, 2, 2],
        ["renderer limit", {max: 2}, 8, 2],
        ["depth attachment limit", {depth: [2]}, 4, 2],
        ["no multisampled float support", {half: []}, 4, 0],
        ["no shared attachment count", {half: [4], depth: [2]}, 4, 0],
        ["no supported count within requested budget", {half: [4]}, 2, 0],
    ])("respects %s", (_, options, requested, expected) => {
        expect(createSceneRenderTarget(makeRenderer(options).renderer, HalfFloatType, requested).samples).toBe(expected);
    });

    test("AA off allocates no probe and does not disturb an active target", () => {
        const {renderer, gl, originalTarget} = makeRenderer();
        expect(createSceneRenderTarget(renderer, HalfFloatType, 0).samples).toBe(0);
        expect(gl.getInternalformatParameter).not.toHaveBeenCalled();
        expect(renderer.setRenderTarget).not.toHaveBeenCalled();
        expect(renderer.getRenderTarget()).toBe(originalTarget);
    });

    test("falls back after an advertised sample count fails framebuffer validation", () => {
        const {renderer, attemptedTargets, originalTarget} = makeRenderer({incomplete: [4]});
        expect(createSceneRenderTarget(renderer, HalfFloatType, 4).samples).toBe(2);
        expect(attemptedTargets[0].dispose).toHaveBeenCalledTimes(1);
        expect(renderer.getRenderTarget()).toBe(originalTarget);
    });

    test("disposes all rejected probes before falling back to single-sample HDR", () => {
        const {renderer, attemptedTargets} = makeRenderer({incomplete: [4, 2]});
        const target = createSceneRenderTarget(renderer, HalfFloatType, 4);
        expect(target.samples).toBe(0);
        expect(target.texture.type).toBe(HalfFloatType);
        expect(attemptedTargets).toHaveLength(2);
        for (const probe of attemptedTargets) expect(probe.dispose).toHaveBeenCalledTimes(1);
    });

    test("rechecks capabilities when recreating targets after a context change", () => {
        const {renderer, gl} = makeRenderer();
        expect(createSceneRenderTarget(renderer, HalfFloatType, 4).samples).toBe(4);
        gl.getInternalformatParameter.mockReturnValue(new Int32Array([2]));
        expect(createSceneRenderTarget(renderer, HalfFloatType, 4).samples).toBe(2);
    });
});

describe("scene and effect target resolution", () => {
    test.each([
        ["Retina main at 85%", 1615, 1446],
        ["fixed sensor at 85%", 1360, 1218],
        ["DPR 1", 950, 851],
        ["supersampled export", 3840, 2160],
        ["odd-size resize", 813, 457],
    ])("matches drawing-buffer pixels for %s", (_, width, height) => {
        const renderer = {getDrawingBufferSize: size => size.set(width, height)};
        const targets = Array.from({length: 3}, () => new WebGLRenderTarget(256, 256));
        const disposals = targets.map(target => jest.spyOn(target, "dispose"));
        const size = resizeRenderTargetsToDrawingBuffer(renderer, targets, new Vector2());
        expect(size.toArray()).toEqual([width, height]);
        for (const target of targets) expect([target.width, target.height]).toEqual([width, height]);
        resizeRenderTargetsToDrawingBuffer(renderer, targets, size);
        // Unchanged frames must not dispose/reallocate targets.
        for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    });

    test("sizes inactive and recreated effects without requiring a window resize", () => {
        const renderer = {getDrawingBufferSize: size => size.set(1920, 1080)};
        const scene = new WebGLRenderTarget(1920, 1080);
        let effects = [new WebGLRenderTarget(256, 256), new WebGLRenderTarget(256, 256)];
        const size = new Vector2();
        resizeRenderTargetsToDrawingBuffer(renderer, [scene, ...effects], size);
        expect(effects.every(t => t.width === 1920 && t.height === 1080)).toBe(true);
        effects = [new WebGLRenderTarget(1, 1), new WebGLRenderTarget(1, 1)];
        resizeRenderTargetsToDrawingBuffer(renderer, [scene, ...effects], size);
        expect(effects.every(t => t.width === 1920 && t.height === 1080)).toBe(true);
    });
});
