// This is a browser hint, not a guarantee that a particular GPU is selected.
export const WEBGL_POWER_PREFERENCE = "high-performance";

function readStringParameter(gl, parameter) {
    if (parameter === undefined) return undefined;
    try {
        const value = gl.getParameter(parameter);
        return typeof value === "string" && value.length ? value : undefined;
    } catch {
        return undefined;
    }
}

// A view ID can come from sitch data, and the console goes into the exported debug
// log, so log only the names that the code itself defines. Use this for every
// console line that names a 3D view.
const LOGGED_VIEW_NAMES = new Set(["mainView", "lookView"]);
export function debugLogViewLabel(viewId) {
    return LOGGED_VIEW_NAMES.has(viewId) ? viewId : "other 3D view";
}

// Read the view's existing context only at creation/restoration. Privacy settings
// may hide the hardware identity or reject queries; diagnostics must not stop rendering.
export function logRendererGPU(renderer, viewId, event = "created") {
    let rendererName, vendorName;
    let identity = "unavailable";
    try {
        const gl = renderer.getContext();
        let debugInfo;
        try {
            debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        } catch {
            // Continue with the standard, masked renderer information.
        }
        rendererName = readStringParameter(gl, debugInfo?.UNMASKED_RENDERER_WEBGL);
        vendorName = readStringParameter(gl, debugInfo?.UNMASKED_VENDOR_WEBGL);
        if (rendererName) {
            identity = "unmasked";
        } else {
            rendererName = readStringParameter(gl, gl.RENDERER);
            vendorName = readStringParameter(gl, gl.VENDOR);
            if (rendererName) identity = "masked; hardware identity unavailable";
        }
    } catch {
        // A lost or unavailable context must not make GPU diagnostics fatal.
    }
    try {
        console.log(`[WebGL] GPU on view "${debugLogViewLabel(viewId)}" (${event}): `
            + `renderer (${identity})="${rendererName ?? "unavailable"}"; `
            + `vendor="${vendorName ?? "unavailable"}"; `
            + `requested power preference="${WEBGL_POWER_PREFERENCE}" (hint)`);
    } catch {
        // Console capture must not block renderer startup or context recovery.
    }
}
