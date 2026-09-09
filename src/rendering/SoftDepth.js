import {DepthTexture, Matrix4, NearestFilter, UnsignedIntType, Vector2, WebGLRenderTarget} from "three";

const activeDraws = new WeakMap();

const SOFT_DEPTH_GLSL = /* glsl */`
uniform bool softDepthEnabled;
uniform sampler2D softSceneDepth;
uniform vec2 softDepthSize;
uniform float softDepthLogFar;
uniform float softDepthOrthoRange;
uniform float softDepthDistance;
float softParticleFade(float particleDepth) {
    if (!softDepthEnabled) return 1.0;
    float sceneDepth = texture2D(softSceneDepth, gl_FragCoord.xy / softDepthSize).r;
    if (sceneDepth >= 1.0) return 1.0;
    float separation;
    if (softDepthOrthoRange > 0.0) {
        separation = (sceneDepth - particleDepth) * softDepthOrthoRange;
    } else {
        // Decode the difference of logarithmic depths, not a perspective z-buffer.
        separation = exp2(particleDepth * softDepthLogFar)
            * (exp2((sceneDepth - particleDepth) * softDepthLogFar) - 1.0);
    }
    return smoothstep(0.0, max(0.01, softDepthDistance), separation);
}
`;

// One lazy depth-only blit per world draw containing a visible soft particle.
// It runs just before the first particle, after opaque geometry has drawn, and
// never samples the framebuffer being written. Original materials supply depth.
export class SoftDepthPass {
    constructor() {
        this.contexts = new WeakMap();
        this.targets = new Set();
    }

    render(renderer, scene, camera, draw) {
        const previous = activeDraws.get(renderer);
        let context = this.contexts.get(camera);
        if (!context) {
            context = {target: null, inverse: new Matrix4()};
            this.contexts.set(camera, context);
        }
        const scope = {owner: this, context, camera, source: renderer.getRenderTarget(), captured: false};
        activeDraws.set(renderer, scope);
        try { return draw(); }
        finally {
            if (previous) activeDraws.set(renderer, previous);
            else activeDraws.delete(renderer);
        }
    }

    dispose() {
        for (const target of this.targets) target.dispose();
        this.targets.clear();
        this.contexts = new WeakMap();
    }
}

function captureDepth(renderer, scope) {
    const source = scope.source;
    // XR/default framebuffers and alternate transmission/shadow targets do not
    // share this draw's depth contract. Keep the soft silhouette there.
    if (!source?.depthBuffer || source.stencilBuffer || source.isXRRenderTarget
        || renderer.getRenderTarget() !== source) return null;
    if (scope.captured) return scope.context.target;
    const {context} = scope;
    if (!context.target) {
        context.target = new WebGLRenderTarget(source.width, source.height, {
            depthTexture: new DepthTexture(source.width, source.height, UnsignedIntType),
            minFilter: NearestFilter, magFilter: NearestFilter,
            depthBuffer: true, stencilBuffer: false,
        });
        scope.owner.targets.add(context.target);
    }
    context.target.setSize(source.width, source.height);
    const gl = renderer.getContext();
    const sourceFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
        renderer.setRenderTarget(context.target);
        // Use Three's state wrapper so its framebuffer cache follows the blit.
        // Reading the active multisample framebuffer resolves its existing depth.
        renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, sourceFramebuffer);
        gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, source.width, source.height,
            gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    } finally {
        renderer.setRenderTarget(source, face, mip);
    }
    scope.captured = true;
    return context.target;
}

export function installSoftDepthMaterial(material, fadeDistance = 20) {
    const uniforms = {
        softDepthEnabled: {value: false}, softSceneDepth: {value: null},
        softDepthSize: {value: new Vector2()}, softDepthLogFar: {value: 1},
        softDepthOrthoRange: {value: 0}, softDepthDistance: {value: fadeDistance},
    };
    material.userData.softDepthUniforms = uniforms;
    const compile = material.onBeforeCompile;
    const key = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${key}|soft-depth-v1`;
    material.onBeforeCompile = function(shader, renderer) {
        compile.call(this, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = SOFT_DEPTH_GLSL + shader.fragmentShader;
        if (shader.fragmentShader.includes("#include <alphatest_fragment>")) {
            shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>", `
                #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
                    diffuseColor.a *= softParticleFade(gl_FragDepth);
                #else
                    diffuseColor.a *= softParticleFade(gl_FragCoord.z);
                #endif
                #include <alphatest_fragment>`);
        } else {
            shader.fragmentShader = shader.fragmentShader.replace("// soft particle alpha",
                "gl_FragColor.a *= softParticleFade(gl_FragDepthEXT);");
        }
    };
    const before = material.onBeforeRender;
    material.onBeforeRender = function(renderer, scene, camera, ...args) {
        before.call(this, renderer, scene, camera, ...args);
        const scope = activeDraws.get(renderer);
        const target = scope?.camera === camera ? captureDepth(renderer, scope) : null;
        uniforms.softDepthEnabled.value = !!target;
        if (target) {
            uniforms.softSceneDepth.value = target.depthTexture;
            uniforms.softDepthSize.value.set(target.width, target.height);
            uniforms.softDepthLogFar.value = Math.log2(1 + camera.far);
            const ortho = camera.projectionMatrix.elements[15] === 1;
            scope.context.inverse.copy(camera.projectionMatrix).invert();
            uniforms.softDepthOrthoRange.value = ortho ? Math.abs(2 * scope.context.inverse.elements[10]) : 0;
        }
        if (this.isShaderMaterial) this.uniformsNeedUpdate = true;
    };
    return material;
}
