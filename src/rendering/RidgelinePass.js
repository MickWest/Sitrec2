import {Color, LinearFilter, MeshBasicMaterial, ShaderMaterial, UnsignedByteType, Vector2, WebGLRenderTarget} from "three";
import {Globals, NodeMan} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {createSceneRenderTarget} from "../ViewRenderTargets";
import {installTerrestrialRefractionOnMaterial} from "../atmosphere/terrestrialRefraction";
import {installFisheyeOnMaterial} from "../FisheyeProjection";

export function ridgelineEnabled(view) {
    const property = view.id === "mainView" ? "showRidgelineMain"
        : view.id === "lookView" ? "showRidgelineLook" : null;
    return property !== null && !!NodeMan.get("NightSkyNode", false)?.[property];
}

// Called with the world draw's exact projection, observer and tile visibility.
// Off is an early return: no scene traversal, targets, materials or GPU work.
export function captureRidgeline(view) {
    if (!ridgelineEnabled(view)) return;
    const terrain = NodeMan.get("TerrainModel", false);
    const groups = [terrain?.getGroup?.(), terrain?.UI?.buildingsNode?.group].filter(group => group?.visible);
    if (!groups.length) {
        if (view.ridgelinePass) view.ridgelinePass.ready = false;
        return;
    }
    (view.ridgelinePass ??= new RidgelinePass()).capture(view, groups);
}

export function renderRidgeline(view, mask = view.ridgelinePass?.target) {
    if (!ridgelineEnabled(view) || !view.ridgelinePass?.ready || !mask) return;
    view.ridgelinePass.render(view, mask);
}

export function refractRidgeline(view, refraction) {
    if (!ridgelineEnabled(view) || !view.ridgelinePass?.ready || !refraction.usable) return;
    view.ridgelinePass.refract(view, refraction);
}

export class RidgelinePass {
    constructor() {
        this.targets = new Map();
        this.clearColor = new Color();
        this.size = new Vector2();
        this.maskMaterial = new MeshBasicMaterial({color: 0xffffff, fog: false, toneMapped: false});
        installTerrestrialRefractionOnMaterial(this.maskMaterial);
        installFisheyeOnMaterial(this.maskMaterial);
        this.material = new ShaderMaterial({
            depthTest: false, depthWrite: false, transparent: true,
            uniforms: {mask: {value: null}, size: {value: new Vector2()}, width: {value: 0.5}},
            vertexShader: `varying vec2 vUv;
                void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: `
                uniform sampler2D mask;
                uniform vec2 size;
                uniform float width;
                varying vec2 vUv;
                void main() {
                    vec2 step = 0.5 / size;
                    // Coverage gradient traces only the boundary of the union
                    // of landscape meshes, never their internal triangle edges.
                    vec2 gradient = vec2(
                        texture2D(mask, vUv + vec2(step.x, 0.0)).r - texture2D(mask, vUv - vec2(step.x, 0.0)).r,
                        texture2D(mask, vUv + vec2(0.0, step.y)).r - texture2D(mask, vUv - vec2(0.0, step.y)).r);
                    gl_FragColor = vec4(vec3(0.6), clamp(length(gradient) * width, 0.0, 1.0));
                }`,
        });
    }

    capture(view, groups) {
        this.ready = false;
        const renderer = view.renderer, camera = view.camera;
        const source = renderer.getRenderTarget();
        if (!source) { this.ready = false; return; }
        // Panorama faces can have different sizes. Retain their targets so
        // dragging does not reallocate the same attachments between faces.
        const key = view._panoramaFace ? `face${view._panoramaFace.index}` : "view";
        let target = this.targets.get(key);
        if (!target) {
            target = createSceneRenderTarget(renderer, UnsignedByteType, 4);
            target.texture.minFilter = target.texture.magFilter = LinearFilter;
            this.targets.set(key, target);
        }
        target.setSize(source.width, source.height);
        Globals.flatEarthPatchMaterial?.(this.maskMaterial);
        const keep = new Set();
        for (const group of groups) for (let node = group; node && node !== GlobalScene; node = node.parent) keep.add(node);
        const hidden = [];
        const isolate = node => {
            for (const child of node.children) {
                if (groups.includes(child)) continue;
                if (keep.has(child)) isolate(child);
                else if (child.visible) { hidden.push(child); child.visible = false; }
            }
        };
        const saved = {override: GlobalScene.overrideMaterial, background: GlobalScene.background,
            autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
            shadows: renderer.shadowMap.enabled, face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel()};
        renderer.getClearColor(this.clearColor);
        try {
            isolate(GlobalScene);
            GlobalScene.overrideMaterial = this.maskMaterial;
            GlobalScene.background = null;
            renderer.shadowMap.enabled = false;
            renderer.autoClear = false;
            renderer.setClearColor(0x000000, 1);
            renderer.setRenderTarget(target);
            renderer.clear(true, true, true);
            renderer.render(GlobalScene, camera);
            this.target = target;
            this.ready = true;
        } finally {
            for (const child of hidden) child.visible = true;
            GlobalScene.overrideMaterial = saved.override;
            GlobalScene.background = saved.background;
            renderer.autoClear = saved.autoClear;
            renderer.shadowMap.enabled = saved.shadows;
            renderer.setClearColor(this.clearColor, saved.alpha);
            renderer.setRenderTarget(source, saved.face, saved.mip);
        }
    }

    refract(view, refraction) {
        let target = this.targets.get("refraction");
        if (!target) {
            target = new WebGLRenderTarget(1, 1, {
                minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
            });
            this.targets.set("refraction", target);
        }
        target.setSize(this.target.width, this.target.height);
        this.target = refraction.renderMask(view, this.target, target);
    }

    render(view, mask) {
        const renderer = view.renderer, material = view.fullscreenQuad.material;
        const target = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        const u = this.material.uniforms;
        renderer.getDrawingBufferSize(this.size);
        u.mask.value = mask.texture;
        u.size.value.set(mask.width, mask.height);
        u.width.value = 0.5 * this.size.y / Math.max(1, view.heightPx * view.letterboxScaleY);
        try {
            renderer.autoClear = false;
            renderer.setRenderTarget(null);
            view.fullscreenQuad.material = this.material;
            renderer.render(view.fullscreenQuad, view.fullscreenQuadCamera);
        } finally {
            renderer.autoClear = autoClear;
            view.fullscreenQuad.material = material;
            renderer.setRenderTarget(target);
        }
    }

    dispose() {
        for (const target of this.targets.values()) target.dispose();
        this.targets.clear();
        this.maskMaterial.dispose();
        this.material.dispose();
        this.target = null;
        this.ready = false;
    }
}
