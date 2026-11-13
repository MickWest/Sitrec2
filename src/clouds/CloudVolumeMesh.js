// CloudVolumeMesh.js - the full-screen triangle that draws every cloud layer.
//
// It lives in GlobalScene, so every render of the world draws it with its own
// camera: both 3D views, the water mirror, XR and exports. As the first
// transparent object (renderOrder far below the rest) it draws right after the
// opaque geometry: terrain and buildings limit it through the opaque depth
// (SoftDepth), and tracks, sprites and contrails draw over it.
//
// RESOLUTION. Below Ultra the march runs at a fraction of the view's pixels.
// In the scene material's onBeforeRender, after SoftDepth has captured this
// draw's opaque depth, a nested renderer.render() draws the march material on
// its own one-triangle scene into a per-camera target (color + the distance to
// the first cloud), with the same camera; then the scene material's own draw
// upsamples it (cloudShaders.js). Three r187 supports the nested render (its
// render-state and render-list stacks, as its Reflector uses), and the target
// is restored afterwards exactly as SoftDepth's own blit does.
//
// The per-camera targets are made and resized in a GlobalScene.onBeforeRender
// hook, never inside an object's onBeforeRender, and only for a draw that will
// read them (a target with a readable depth, the clouds visible to that camera).
//
// COST. There is no always-on readout: GPU timer queries do not bracket a single
// pass on every platform (on Apple GPUs they also count earlier work). The node's
// Measure button times whole frames with and without the clouds instead.

import {
    BufferGeometry,
    Float32BufferAttribute,
    HalfFloatType,
    LinearFilter,
    Mesh,
    NearestFilter,
    RGFormat,
    Scene,
    Sphere,
    Vector2,
    Vector3,
    WebGLRenderTarget,
} from "three";
import {GlobalScene} from "../LocalFrame";
import * as LAYER from "../LayerMasks";
import {installSoftDepthMaterial} from "../rendering/SoftDepth";
import {excludeFromTerrestrialRefraction} from "../atmosphere/terrestrialRefraction";
import {markFisheyeNative} from "../FisheyeProjection";
import {createCloudMaterials, setMarchPixelSize, updateCloudUniforms} from "./CloudVolumeMaterial";
import {cloudQualitySettings, marchTargetSize} from "./CloudLayerModel";

export const CLOUD_RENDER_ORDER = -1e6;

export class CloudVolumeMesh {
    // getState(camera) returns the render state for that camera, or null to skip the draw.
    constructor(getState) {
        this.getState = getState;
        this.quality = "Medium";
        this.wantVisible = false;
        // Per camera: {target}.
        this.contexts = new WeakMap();

        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        // Never culled, never picked; the bounds only keep generic scene code quiet.
        geometry.boundingSphere = new Sphere(new Vector3(), 1e12);
        this.geometry = geometry;
        const {scene, march, uniforms} = createCloudMaterials();
        this.material = scene;
        this.marchMaterial = march;
        this.uniforms = uniforms;
        this._fullSize = new Vector2();

        // The march: the same triangle on its own scene, drawn into the march target.
        this.marchScene = new Scene();
        this.marchScene.matrixWorldAutoUpdate = false;
        this.marchMesh = new Mesh(geometry, march);
        this.marchMesh.frustumCulled = false;
        this.marchMesh.matrixAutoUpdate = false;
        this.marchMesh.layers.enableAll();
        this.marchScene.add(this.marchMesh);

        const material = this.material;
        material.onBeforeRender = (renderer, sceneArg, camera) => {
            const state = this.getState(camera);
            if (!state) {
                uniforms.cloudLayerCount.value = 0;
                return;
            }
            updateCloudUniforms(uniforms, camera, state);
            this._lens = state.lens;
        };
        // Wraps onBeforeRender: after the uniforms, it blits this draw's opaque
        // depth (once per draw) and binds it as softSceneDepth.
        installSoftDepthMaterial(material);
        const withDepth = material.onBeforeRender;
        const self = this;
        material.onBeforeRender = function(renderer, sceneArg, camera, ...rest) {
            withDepth.call(this, renderer, sceneArg, camera, ...rest);
            const depthOn = this.userData.softDepthUniforms.softDepthEnabled.value;
            // Where the depth cannot be read (XR, unusual targets), fall back to
            // the hardware depth test: clouds then show only against the sky.
            this.depthTest = !depthOn;
            self.prepareDraw(renderer, camera, depthOn);
        };
        // The march reads the same depth capture (shared uniform objects).
        Object.assign(uniforms, material.userData.softDepthUniforms);
        // The shader builds its own (fisheye) view rays: no vertex patch.
        markFisheyeNative(material);

        this.mesh = new Mesh(geometry, material);
        this.mesh.name = "VolumetricClouds";
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = CLOUD_RENDER_ORDER;
        // Per-view visibility is the layer mask: MAIN and/or LOOK, never WORLD,
        // which both views render. Set by setViews().
        this.mesh.layers.mask = LAYER.MASK_LOOK;
        this.mesh.raycast = () => {};
        this.mesh.matrixAutoUpdate = false;
        this.mesh.userData.ignoreContextMenu = true;
        this.mesh.userData.atmosphere = false;
        this.mesh.userData.thermal = false;
        excludeFromTerrestrialRefraction(this.mesh);
        this.mesh.visible = false;
        GlobalScene.add(this.mesh);
        this.installSceneHook(GlobalScene);
    }

    // ---- per render: visibility and targets --------------------------------------

    installSceneHook(scene) {
        const previous = scene.onBeforeRender;
        this._hookedScene = scene;
        this._previousHook = previous;
        scene.onBeforeRender = (renderer, sceneArg, camera, renderTarget) => {
            if (typeof previous === "function") previous.call(scene, renderer, sceneArg, camera, renderTarget);
            this.beforeSceneRender(renderer, sceneArg, camera, renderTarget);
        };
        this._hook = scene.onBeforeRender;
    }

    beforeSceneRender(renderer, scene, camera, renderTarget) {
        // An override-material pass (occlusion masks, silhouettes) must not draw
        // the triangle with its material: at the ECEF origin it would be a speck.
        this.mesh.visible = this.wantVisible && !scene.overrideMaterial;
        if (!this.mesh.visible || !camera || camera.isArrayCamera || !this.mesh.layers.test(camera.layers)) return;
        const resolution = cloudQualitySettings(this.quality).resolution;
        if (resolution >= 1) return;
        // Only a target whose depth SoftDepth can read can be upsampled with depth.
        if (!renderTarget || !renderTarget.depthBuffer || renderTarget.stencilBuffer
            || renderTarget.isXRRenderTarget || renderTarget.isWebGLCubeRenderTarget) return;
        const size = marchTargetSize(renderTarget.width, renderTarget.height, resolution);
        let context = this.contexts.get(camera);
        if (!context) {
            context = {target: null};
            this.contexts.set(camera, context);
        }
        if (!context.target) {
            const target = new WebGLRenderTarget(size.width, size.height, {
                count: 2, type: HalfFloatType, depthBuffer: false, stencilBuffer: false,
                minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
            });
            target.textures[0].name = "cloudMarchColor";
            // The distances to the first cloud and to the opaque scene: never interpolated.
            target.textures[1].name = "cloudMarchFront";
            target.textures[1].format = RGFormat;
            target.textures[1].minFilter = NearestFilter;
            target.textures[1].magFilter = NearestFilter;
            context.target = target;
            this._targets ??= new Set();
            this._targets.add(target);
        } else if (context.target.width !== size.width || context.target.height !== size.height) {
            context.target.setSize(size.width, size.height);
        }
    }

    // In the scene material's onBeforeRender, after the depth capture: run the
    // march into this camera's target, or set up a direct full-resolution march.
    prepareDraw(renderer, camera, depthOn) {
        const uniforms = this.uniforms;
        if (uniforms.cloudLayerCount.value === 0) {
            uniforms.cloudComposite.value = false;
            return;
        }
        const target = this.contexts.get(camera)?.target;
        const full = uniforms.softDepthSize.value;
        const resolution = cloudQualitySettings(this.quality).resolution;
        const expected = depthOn && target && resolution < 1 ? marchTargetSize(full.x, full.y, resolution) : null;
        if (expected && target.width === expected.width && target.height === expected.height) {
            uniforms.cloudMarchSize.value.set(target.width, target.height);
            setMarchPixelSize(uniforms, camera, target.height, this._lens);
            const previousTarget = renderer.getRenderTarget();
            const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
            const autoClear = renderer.autoClear, autoReset = renderer.info.autoReset;
            try {
                renderer.autoClear = false;
                renderer.info.autoReset = false;
                renderer.setRenderTarget(target);
                renderer.render(this.marchScene, camera);
            } finally {
                renderer.setRenderTarget(previousTarget, face, mip);
                renderer.autoClear = autoClear;
                renderer.info.autoReset = autoReset;
            }
            uniforms.cloudMarchColor.value = target.textures[0];
            uniforms.cloudMarchFront.value = target.textures[1];
            uniforms.cloudComposite.value = true;
            return;
        }
        // Direct march at the draw's own resolution.
        uniforms.cloudComposite.value = false;
        // (With a depth capture the march must map 1:1 onto its pixels.)
        const current = renderer.getRenderTarget();
        const size = depthOn ? full
            : current ? this._fullSize.set(current.width, current.height) : renderer.getDrawingBufferSize(this._fullSize);
        uniforms.cloudMarchSize.value.set(Math.max(1, size.x), Math.max(1, size.y));
        setMarchPixelSize(uniforms, camera, size.y, this._lens);
    }

    // ---- state ---------------------------------------------------------------------

    setTextures(textures) {
        const uniforms = this.uniforms;
        uniforms.cloudShapeTex.value = textures.shape;
        uniforms.cloudDetailTex.value = textures.detail;
        uniforms.cloudWeatherTex.value = textures.weather;
        uniforms.cloudBlueNoise.value = textures.blueNoise;
    }

    get hasTextures() {
        return !!this.uniforms.cloudShapeTex.value;
    }

    setQuality(quality) {
        this.quality = quality;
    }

    setViews(showMain, showLook) {
        this.mesh.layers.mask = (showMain ? LAYER.MASK_MAIN : 0) | (showLook ? LAYER.MASK_LOOK : 0);
    }

    setVisible(visible) {
        this.wantVisible = !!visible && this.hasTextures;
        this.mesh.visible = this.wantVisible;
    }

    dispose() {
        if (this._hookedScene && this._hookedScene.onBeforeRender === this._hook) {
            this._hookedScene.onBeforeRender = this._previousHook;
        } else if (this._hookedScene) {
            // A later hook chained over ours: keep the chain, make ours a no-op.
            this.beforeSceneRender = () => {};
        }
        GlobalScene?.remove(this.mesh);
        this.geometry.dispose();
        this.material.dispose();
        this.marchMaterial.dispose();
        for (const target of this._targets ?? []) target.dispose();
        this._targets?.clear();
        // The noise textures are shared by every sitch on the page; they stay.
    }
}
