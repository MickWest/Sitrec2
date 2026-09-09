import {HalfFloatType, LinearSRGBColorSpace, NearestFilter, RGBAFormat, WebGLRenderTarget} from "three";

function makeSceneTarget(type, samples) {
    return new WebGLRenderTarget(1, 1, {
        format: RGBAFormat,
        type,
        colorSpace: LinearSRGBColorSpace,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        samples,
    });
}

// Float color buffers do not imply float MSAA support. Check both attachment
// formats, then validate a small target through Three's actual allocation path.
// Run only when targets are created, including after context restoration.
export function createSceneRenderTarget(renderer, type, requestedSamples) {
    if (requestedSamples <= 0) return makeSceneTarget(type, 0);

    const gl = renderer.getContext();
    const colorFormat = type === HalfFloatType ? gl.RGBA16F : gl.RGBA8;
    const colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, colorFormat, gl.SAMPLES) ?? [];
    // Three uses DEPTH_COMPONENT24 for a depth renderbuffer without a stencil.
    const depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) ?? [];
    const limit = Math.min(requestedSamples, renderer.capabilities.maxSamples);
    const candidates = Array.from(colorSamples)
        .filter(samples => samples > 0 && samples <= limit && depthSamples.includes(samples))
        .sort((a, b) => b - a);

    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace();
    const previousMip = renderer.getActiveMipmapLevel();
    for (const samples of candidates) {
        const target = makeSceneTarget(type, samples);
        let complete = false;
        try {
            renderer.setRenderTarget(target);
            complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        } finally {
            renderer.setRenderTarget(previousTarget, previousFace, previousMip);
            if (!complete) target.dispose();
        }
        if (complete) return target;
    }

    return makeSceneTarget(type, 0);
}

// The renderer has already applied DPR and the user's render scale. All scene
// and effect targets must use those same physical pixels, including targets
// whose effects are currently disabled (a toggle need not resize the canvas).
export function resizeRenderTargetsToDrawingBuffer(renderer, targets, size) {
    renderer.getDrawingBufferSize(size);
    for (const target of targets) {
        if (target.width !== size.x || target.height !== size.y) {
            target.setSize(size.x, size.y);
        }
    }
    return size;
}
