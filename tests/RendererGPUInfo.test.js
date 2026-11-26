import {logRendererGPU} from "../src/RendererGPUInfo";

const debugInfo = {UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2};
let gl, renderer, log;
beforeEach(() => {
    gl = {
        RENDERER: 3,
        VENDOR: 4,
        getExtension: jest.fn(() => debugInfo),
        getParameter: jest.fn(parameter => ({
            1: "ANGLE (Example Discrete GPU)",
            2: "Example GPU vendor",
            3: "WebKit WebGL",
            4: "WebKit",
        })[parameter]),
    };
    renderer = {getContext: jest.fn(() => gl)};
    log = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("logs the existing context's GPU separately from the requested performance hint", () => {
    logRendererGPU(renderer, "mainView");
    expect(renderer.getContext).toHaveBeenCalledTimes(1);
    expect(gl.getExtension).toHaveBeenCalledWith("WEBGL_debug_renderer_info");
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0][0];
    expect(message).toContain('view "mainView" (created)');
    expect(message).toContain('renderer (unmasked)="ANGLE (Example Discrete GPU)"');
    expect(message).toContain('vendor="Example GPU vendor"');
    expect(message).toContain('requested power preference="high-performance" (hint)');
});

test.each(["missing extension", "extension query rejected", "unmasked query rejected"])(
    "%s falls back to clearly labelled masked information", failure => {
        if (failure === "missing extension") gl.getExtension.mockReturnValue(null);
        if (failure === "extension query rejected") {
            gl.getExtension.mockImplementation(() => { throw new Error("Restricted"); });
        }
        if (failure === "unmasked query rejected") {
            const original = gl.getParameter.getMockImplementation();
            gl.getParameter.mockImplementation(parameter => {
                if (parameter === debugInfo.UNMASKED_RENDERER_WEBGL) throw new Error("Restricted");
                return original(parameter);
            });
        }
        expect(() => logRendererGPU(renderer, "lookView")).not.toThrow();
        expect(log.mock.calls[0][0]).toContain(
            'renderer (masked; hardware identity unavailable)="WebKit WebGL"; vendor="WebKit"');
    });

test("unavailable context or renderer queries never prevent startup", () => {
    renderer.getContext.mockImplementationOnce(() => { throw new Error("Context unavailable"); });
    expect(() => logRendererGPU(renderer, "mainView")).not.toThrow();
    gl.getParameter.mockImplementation(() => { throw new Error("Restricted"); });
    expect(() => logRendererGPU(renderer, "lookView")).not.toThrow();
    for (const [message] of log.mock.calls) {
        expect(message).toContain('renderer (unavailable)="unavailable"');
    }
});

test("restoration reads the current GPU again instead of reporting cached hardware", () => {
    logRendererGPU(renderer, "mainView");
    gl.getParameter.mockImplementation(parameter => parameter === 1 ? "Replacement GPU" : "Vendor");
    logRendererGPU(renderer, "mainView", "restored");
    expect(renderer.getContext).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain('view "mainView" (restored)');
    expect(log.mock.calls[1][0]).toContain('renderer (unmasked)="Replacement GPU"');
});

test("a view ID from sitch data is not written to the debug log", () => {
    logRendererGPU(renderer, "lookView");
    logRendererGPU(renderer, "My private sitch view name");
    expect(log.mock.calls[0][0]).toContain('view "lookView" (created)');
    expect(log.mock.calls[1][0]).toContain('view "other 3D view" (created)');
    expect(log.mock.calls[1][0]).not.toContain("My private sitch view name");
});
