import fs from "fs";
import path from "path";
import {debugLogViewLabel, isSoftwareRenderer, logRendererGPU} from "../src/RendererGPUInfo";

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
    const info = logRendererGPU(renderer, "mainView");
    expect(info).toMatchObject({rendererName: "ANGLE (Example Discrete GPU)", identity: "unmasked", softwareRendererDetected: false});
    expect(renderer.getContext).toHaveBeenCalledTimes(1);
    expect(gl.getExtension).toHaveBeenCalledWith("WEBGL_debug_renderer_info");
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0][0];
    expect(message).toContain('view "mainView" (created)');
    expect(message).toContain('renderer (unmasked)="ANGLE (Example Discrete GPU)"');
    expect(message).toContain('vendor="Example GPU vendor"');
    expect(message).toContain('requested power preference="high-performance" (hint)');
});

test.each([
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
    "Google SwiftShader",
    "llvmpipe (LLVM 18.1.8, 256 bits)",
    "softpipe",
    "swrast",
    "Software Rasterizer",
    "Software Renderer",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
    "GDI Generic",
    "ANGLE (Microsoft, WARP Direct3D11)",
])("recognizes the explicit software renderer %s", name => {
    expect(isSoftwareRenderer(name)).toBe(true);
    const original = gl.getParameter.getMockImplementation();
    gl.getParameter.mockImplementation(parameter => parameter === 1 ? name : original(parameter));
    expect(logRendererGPU(renderer, "mainView").softwareRendererDetected).toBe(true);
    expect(log.mock.calls[0][0]).toContain("software renderer=detected");
});

test.each([
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11)",
    "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11)",
    "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11)",
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)",
    "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
    "WebKit WebGL", "ANGLE", "Microsoft", "WarpSpeed GPU", "WARP", "", undefined,
])("does not flag hardware, generic or unavailable identities: %s", name => {
    expect(isSoftwareRenderer(name)).toBe(false);
});

test("recognizes WARP only with Microsoft renderer/vendor context", () => {
    expect(isSoftwareRenderer("WARP", "Microsoft Corporation")).toBe(true);
    expect(isSoftwareRenderer("WARP", "Example vendor")).toBe(false);
});

test("a software renderer can still be identified through the standard renderer query", () => {
    gl.getExtension.mockReturnValue(null);
    gl.getParameter.mockImplementation(parameter => parameter === 3 ? "llvmpipe" : "Mesa");
    expect(logRendererGPU(renderer, "mainView")).toMatchObject({
        rendererName: "llvmpipe", softwareRendererDetected: true,
        identity: "masked; hardware identity unavailable",
    });
});

test("console failures do not hide a software renderer from the user-facing check", () => {
    gl.getParameter.mockImplementation(() => "SwiftShader");
    log.mockImplementation(() => { throw new Error("Console unavailable"); });
    expect(logRendererGPU(renderer, "mainView").softwareRendererDetected).toBe(true);
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

test("the debug log view label names only the code-defined views", () => {
    expect(debugLogViewLabel("mainView")).toBe("mainView");
    expect(debugLogViewLabel("lookView")).toBe("lookView");
    expect(debugLogViewLabel("lookView2")).toBe("other 3D view");
    expect(debugLogViewLabel(undefined)).toBe("other 3D view");
});

test("CNodeView3D console lines do not write a raw view ID", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNodeView3D.js"), "utf-8");
    const rawIdLines = source.split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .filter(line => /console\.(log|warn|error|info|debug)\(/.test(line))
        .filter(line => line.includes("${this.id}"));
    expect(rawIdLines).toEqual([]);
});
