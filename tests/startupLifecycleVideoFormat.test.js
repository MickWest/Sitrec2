/** @jest-environment jsdom */
// Video Format Effects on a GPU that cannot build the filter (no WebGL2, no renderable
// half-float target, a shader that will not compile). Building the filter used to sit
// outside the try that switches the effect off, so the error escaped renderMain on every
// frame and stopped the render loop. Each attempt also leaked the WebGL2 context the
// filter had already created, and browsers only allow a handful of those.

import {setNodeMan} from "../src/Globals";
import {GLFilterContext} from "../src/videoFilters/GLFilterContext";
import {AnalogVideoFilter} from "../src/videoFilters/AnalogVideoFilter";
import {showErrorOnce} from "../src/showError";
import {
    deserializeVideoFormatEffects, getVideoFormatLayerSettings, updateVideoFormatLayer,
} from "../src/videoFilters/VideoFormatLayer";

jest.mock("../src/VideoExporter", () => ({getCanvasDisplayRect: jest.fn()}));
jest.mock("../src/showError", () => ({showErrorOnce: jest.fn()}));

// A stand-in for the WebGL2 context: mockFailOn picks the step that throws, the way
// GLTarget throws for an incomplete framebuffer and program() for a failed compile.
let mockFailOn = null;
const mockContexts = [];
jest.mock("../src/videoFilters/GLFilterContext", () => ({
    GLFilterContext: jest.fn().mockImplementation(() => {
        const ctx = {
            canvas: globalThis.document.createElement("canvas"),
            program: jest.fn(name => {
                if (mockFailOn === name) throw new Error(`Video filter shader "${name}" failed to compile`);
                return {name};
            }),
            createTarget: jest.fn((width, height) => {
                if (mockFailOn === "target") throw new Error("Video filter render target is not usable (framebuffer status 0x8cd6)");
                return {width, height};
            }),
            dispose: jest.fn(),
        };
        mockContexts.push(ctx);
        return ctx;
    }),
}));

const ANALOG = {signal: {format: "rs170"}, screen: {enabled: false}};

function lookView() {
    return {
        id: "lookView", canvas: document.createElement("canvas"), _effectivelyVisible: true,
        widthPx: 320, heightPx: 240,
        // jsdom has no layout, so the on-screen tests hostView() makes are faked here.
        div: {offsetParent: {}, getBoundingClientRect: () => ({left: 0, top: 0, width: 320, height: 240})},
        registerHUDLayer: jest.fn(() => jest.fn()), _clipHUDsBelowHeader: jest.fn(),
    };
}

beforeEach(() => {
    mockFailOn = null;
    mockContexts.length = 0;
    GLFilterContext.mockClear();
    showErrorOnce.mockClear();
});

describe("AnalogVideoFilter construction", () => {
    test.each([
        ["an unusable render target", "target"],
        ["a shader that fails to compile", "tape"],
    ])("releases its WebGL2 context when it hits %s", (_, failOn) => {
        mockFailOn = failOn;
        expect(() => new AnalogVideoFilter({width: 320, height: 240, settings: ANALOG})).toThrow();
        expect(mockContexts).toHaveLength(1);
        expect(mockContexts[0].dispose).toHaveBeenCalledTimes(1);
    });

    test("keeps its context when construction succeeds", () => {
        const filter = new AnalogVideoFilter({width: 320, height: 240, settings: ANALOG});
        expect(mockContexts[0].dispose).not.toHaveBeenCalled();
        filter.dispose();
        expect(mockContexts[0].dispose).toHaveBeenCalledTimes(1);
    });
});

describe("the live layer when the filter cannot be built", () => {
    test("switches the effect off once, with a message, instead of throwing every frame", async () => {
        mockFailOn = "target";
        setNodeMan({get: id => id === "lookView" ? lookView() : undefined, list: {}});
        deserializeVideoFormatEffects({enabled: true, ...ANALOG});

        // The first frame only starts loading the filter chunk.
        updateVideoFormatLayer();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(() => updateVideoFormatLayer()).not.toThrow();
        expect(GLFilterContext).toHaveBeenCalledTimes(1);
        expect(mockContexts[0].dispose).toHaveBeenCalledTimes(1);
        expect(getVideoFormatLayerSettings().enabled).toBe(false);
        expect(showErrorOnce).toHaveBeenCalledTimes(1);
        expect(showErrorOnce.mock.calls[0][1]).toMatch(/switched off[\s\S]*render target is not usable/);

        // Later frames leave it off rather than building, failing and leaking again.
        for (let i = 0; i < 3; i++) expect(() => updateVideoFormatLayer()).not.toThrow();
        expect(GLFilterContext).toHaveBeenCalledTimes(1);
    });
});
