// CloudVolumeMesh.js - the one full-screen triangle that draws every cloud layer.
//
// It lives in GlobalScene, so every render of the world draws it with its own
// camera: both 3D views, the water mirror, XR and exports. As the first
// transparent object (renderOrder far below the rest) it draws right after the
// opaque geometry: terrain and buildings limit it through the opaque depth
// (SoftDepth), and tracks, sprites and contrails draw over it.

import {BufferGeometry, Float32BufferAttribute, Mesh, Sphere, Vector3} from "three";
import {GlobalScene} from "../LocalFrame";
import * as LAYER from "../LayerMasks";
import {installSoftDepthMaterial} from "../rendering/SoftDepth";
import {excludeFromTerrestrialRefraction} from "../atmosphere/terrestrialRefraction";
import {createCloudVolumeMaterial, updateCloudUniforms} from "./CloudVolumeMaterial";

export const CLOUD_RENDER_ORDER = -1e6;

export class CloudVolumeMesh {
    // getState(camera) returns the render state for that camera, or null to skip the draw.
    constructor(getState) {
        this.getState = getState;
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        // Never culled, never picked; the bounds only keep generic scene code quiet.
        geometry.boundingSphere = new Sphere(new Vector3(), 1e12);
        this.material = createCloudVolumeMaterial();
        const material = this.material;
        material.onBeforeRender = (renderer, scene, camera) => {
            const state = this.getState(camera);
            if (!state) {
                material.uniforms.cloudLayerCount.value = 0;
                return;
            }
            updateCloudUniforms(material.uniforms, camera, state);
        };
        // Wraps onBeforeRender: after the uniforms, it blits this draw's opaque
        // depth (once per draw) and binds it as softSceneDepth.
        installSoftDepthMaterial(material);
        const withDepth = material.onBeforeRender;
        material.onBeforeRender = function(renderer, scene, camera, ...rest) {
            withDepth.call(this, renderer, scene, camera, ...rest);
            // Where the depth cannot be read (XR, unusual targets), fall back to
            // the hardware depth test: clouds then show only against the sky.
            this.depthTest = !this.userData.softDepthUniforms.softDepthEnabled.value;
        };

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
    }

    setTextures(textures) {
        const uniforms = this.material.uniforms;
        uniforms.cloudShapeTex.value = textures.shape;
        uniforms.cloudDetailTex.value = textures.detail;
        uniforms.cloudWeatherTex.value = textures.weather;
    }

    get hasTextures() {
        return !!this.material.uniforms.cloudShapeTex.value;
    }

    setViews(showMain, showLook) {
        this.mesh.layers.mask = (showMain ? LAYER.MASK_MAIN : 0) | (showLook ? LAYER.MASK_LOOK : 0);
    }

    setVisible(visible) {
        this.mesh.visible = !!visible && this.hasTextures;
    }

    dispose() {
        GlobalScene?.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        // The noise textures are shared by every sitch on the page; they stay.
    }
}
