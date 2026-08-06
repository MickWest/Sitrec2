// CNodeWaterReflection.js
//
// Reflects the night sky in water surfaces of the map-textured terrain.
//
// How it works:
//
//  1. Water is detected in the TERRAIN SHADER by the colour of the map tile
//     texture — the flat OSM water fill by default. That is a hack, and it is
//     deliberately one: it needs no extra data, no vector tiles and no
//     geometry, and it tracks whatever the user is actually looking at. It is
//     gated on the active map source declaring a waterColor, so switching to
//     satellite/debug imagery cannot invent lakes out of similarly-coloured
//     pixels.
//
//  2. The sky comes from a CUBE MAP captured here. The celestial sphere lives
//     in its own scenes (GlobalNightSkyScene for stars/planets/constellations,
//     GlobalSunSkyScene for the visible Sun and Moon) and is always rendered
//     with the camera at the origin, so a CubeCamera at the origin captures it
//     exactly as any view would see it — no parallax to worry about, and the
//     EQJ->ECEF rotation already applied to the celestial sphere group means
//     the cube is oriented in world space. Both scenes are captured: when a day
//     sky exists CPlanets HIDES the night-scene Sun/Moon and draws visible
//     copies in GlobalSunSkyScene, so capturing only the night scene would give
//     a starfield with no Moon in it — the one thing you most want to see in a
//     lake.
//
//  3. Capture and the shader uniforms are scoped tightly around the LOOK
//     VIEW's GlobalScene render (see CNodeView3D.renderTargetAndEffects). The
//     terrain material and its per-view clones share these uniforms by
//     reference, so anything less than a push/pop around the actual draw call
//     would leak the reflection into mainView — including via the render paths
//     that bypass the node preRender hook entirely (ExportImageSet,
//     CFileManager thumbnails).
//
// Stars are rendered LARGER into the cube than they appear on screen: a 90°
// cube face at 512px has far coarser angular resolution than the look view, so
// at their true size most stars would land sub-pixel and vanish once the water
// shader samples them. The Star Boost slider exists to put them back.

import {CNode} from "./CNode";
import {
    Color,
    CubeCamera,
    HalfFloatType,
    LinearFilter,
    LinearMipmapLinearFilter,
    Vector3,
    WebGLCubeRenderTarget,
} from "three";
import {GlobalNightSkyScene, GlobalSunSkyScene} from "../LocalFrame";
import {guiMenus, NodeMan, Sit, setRenderOne, Globals} from "../Globals";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import * as LAYER from "../LayerMasks";

// Beyond this distance from the wave-phase origin, float32 world positions stop
// resolving a wavelength. Re-origin only on a jump this large so the ripple
// pattern never visibly swims while the camera moves normally.
const WAVE_ORIGIN_REANCHOR_M = 50000;

export class CNodeWaterReflection extends CNode {
    constructor(v) {
        super(v);

        this.enabled = v.enabled ?? false;
        this.strength = v.strength ?? 1.0;
        this.tolerance = v.tolerance ?? 0.10;
        // How far the flat map water colour is pulled towards black while the
        // reflection is active. 0.9 leaves 10% of it.
        this.darken = v.darken ?? 0.9;
        // A 90-degree cube face at 512px resolves ~0.18 degrees per pixel, so a
        // star at its true size lands sub-pixel and vanishes once the water
        // shader samples it. Boosting star SIZE inflates their total flux by
        // roughly the square of the boost, so keep this modest: past ~4 the
        // starfield out-glares a full Moon and the water turns milky.
        this.starBoost = v.starBoost ?? 3.0;
        // The Moon gets the same treatment for the same reason: its disc is
        // only ~3 pixels across in the cube, so once stars are boosted the
        // moonglade — which in reality dominates a night lake — reads weaker
        // than the starfield. Boosting size raises flux by roughly its square.
        this.moonBoost = v.moonBoost ?? 2.5;
        this.waveStrength = v.waveStrength ?? 0.02;
        this.waveLength = v.waveLength ?? 30.0;
        this.waveSpeed = v.waveSpeed ?? 1.0;
        this.cubeResolution = v.cubeResolution ?? 512;

        this.addSimpleSerials([
            "enabled",
            "strength",
            "darken",
            "tolerance",
            "starBoost",
            "moonBoost",
            "waveStrength",
            "waveLength",
            "waveSpeed",
            "cubeResolution",
        ]);

        // Per-renderer cube targets. Each CNodeView3D owns its own
        // WebGLRenderer, and a cube render target belongs to one GL context.
        this.cubeTargets = new Map();

        this.waveTime = 0;
        this.waveOrigin = new Vector3();
        this.waveOriginSet = false;
        this._captureKey = null;

        // GUI — a submenu under Show. Guarded so the node still works in
        // headless contexts where the menu bar does not exist.
        this.gui = guiMenus.showhide ? guiMenus.showhide.addFolder("Water Reflection") : undefined;
        if (this.gui) {
            const changed = () => {
                this._captureKey = null; // force a fresh capture
                setRenderOne(true);
            };
            const addValue = (property, start, end, step, name) =>
                this.gui.add(this, property, start, end, step).name(name).listen().onChange(changed);

            this.gui.add(this, "enabled").name("Water Reflection").listen().onChange(changed)
                .tooltip("Reflect the night sky in water. Water is detected by the colour of the map texture, "
                    + "so it needs a map source with a flat water fill (OSM). Look view only.");
            addValue("strength", 0, 4, 0.01, "Reflection Strength")
                .tooltip("Brightness of the reflected sky. 1.0 is the physical Fresnel amount.");
            addValue("darken", 0, 1, 0.01, "Water Darkening")
                .tooltip("How far the flat map water colour is pulled towards black while the reflection is on. "
                    + "0.9 leaves 10% of it, so the reflected sky dominates instead of being washed out by map blue.");
            addValue("starBoost", 1, 30, 0.1, "Star Boost")
                .tooltip("How much bigger stars are drawn into the reflection cube map than they appear on screen. "
                    + "At their true size most stars are sub-pixel in the cube and disappear from the reflection.");
            addValue("moonBoost", 1, 10, 0.1, "Moon Boost")
                .tooltip("Same idea for the Moon, so the moonglade stays brighter than the reflected stars.");
            addValue("waveStrength", 0, 0.2, 0.001, "Wave Strength")
                .tooltip("How much ripples tilt the water surface. 0 gives a perfect mirror.");
            addValue("waveLength", 1, 200, 0.5, "Wave Length (m)")
                .tooltip("Distance between wave crests.");
            addValue("waveSpeed", 0, 5, 0.01, "Wave Speed")
                .tooltip("How fast ripples move. 0 freezes them (and stops forcing re-renders while paused).");
            addValue("tolerance", 0.01, 0.5, 0.005, "Water Colour Tolerance")
                .tooltip("How close a map pixel must be to the source's water colour to count as water. "
                    + "Raise it to fill in antialiased shorelines, lower it if land is being flooded.");
        }
    }

    dispose() {
        for (const {target, camera} of this.cubeTargets.values()) {
            target.dispose();
            camera.children.length = 0;
        }
        this.cubeTargets.clear();
        this.clearUniforms();
        if (this.gui) {
            this.gui.destroy();
            this.gui = undefined;
        }
        super.dispose();
    }

    // Ripple animation. Pinned to the locked frame in fixed-frame/regression
    // mode so identical frames render identically; free-running otherwise so
    // ripples keep moving even when the timeline is paused.
    update(frame) {
        super.update(frame);

        const animating = this.enabled && this.waveSpeed > 0;
        // Only keep the render loop awake while there is actually something
        // moving — a permanently-true updateWhilePaused never lets a visible
        // tab sleep.
        this.updateWhilePaused = animating;

        if (!animating) return;

        if (Globals.fixedFrame !== undefined) {
            this.waveTime = Globals.fixedFrame * 0.05 * this.waveSpeed;
        } else {
            this.waveTime += 0.05 * this.waveSpeed;
            setRenderOne(true);
        }
    }

    // Water detection needs a map source that declares its water colour.
    getWaterColor() {
        const terrainNode = NodeMan.get("TerrainModel", false);
        const sourceDef = terrainNode?.UI?.getSourceDef?.();
        return sourceDef?.waterColor;
    }

    getCubeTarget(renderer) {
        const key = renderer.domElement;
        const existing = this.cubeTargets.get(key);
        if (existing && existing.resolution === this.cubeResolution) {
            return existing;
        }
        if (existing) {
            existing.target.dispose();
            this.cubeTargets.delete(key);
        }
        // HalfFloat: the Moon's disc is orders of magnitude brighter than the
        // sky around it, and an 8-bit target clamps it to the same value as a
        // saturated star — which is exactly backwards. Mipmaps let the water
        // shader's minification filter smooth the sky instead of aliasing it
        // into shimmer at grazing angles.
        const target = new WebGLCubeRenderTarget(this.cubeResolution, {
            type: HalfFloatType,
            generateMipmaps: true,
            minFilter: LinearMipmapLinearFilter,
            magFilter: LinearFilter,
        });
        // The celestial sphere sits at radius 100 and is rendered from the
        // origin, so the frustum only has to contain it.
        const camera = new CubeCamera(1, 1000, target);
        const entry = {target, camera, resolution: this.cubeResolution};
        this.cubeTargets.set(key, entry);
        return entry;
    }

    // Render both sky scenes into the cube. Returns false if it could not.
    captureSky(view, skyFactor) {
        const nightSky = NodeMan.get("NightSkyNode", false);
        if (!nightSky || GlobalNightSkyScene === undefined) return false;

        const renderer = view.renderer;
        const {target, camera} = this.getCubeTarget(renderer);

        // Skip the six renders when nothing that affects the cube has changed.
        // Keyed on content rather than a frame counter: one timeline frame can
        // be rendered from several camera poses (image-set export), and the sky
        // is identical for all of them. Observer position is included coarsely
        // because refraction and aberration are computed from it — quantised so
        // ordinary camera movement doesn't re-capture every frame.
        const p = view.camera.position;
        const q = nightSky.celestialSphere.quaternion;
        const key = [
            q.x.toFixed(7), q.y.toFixed(7), q.z.toFixed(7), q.w.toFixed(7),
            Math.round(p.x / 1000), Math.round(p.y / 1000), Math.round(p.z / 1000),
            skyFactor.toFixed(4), this.starBoost, this.moonBoost, this.cubeResolution,
            Sit.starScale, nightSky.showStars,
        ].join(",");
        if (key === this._captureKey) return true;
        this._captureKey = key;

        // Diagnostics (RA/Dec grid, constellation lines and names) are display
        // aids, not light in the sky — they must not show up in the water.
        const hidden = [];
        const hide = (obj) => {
            if (obj && obj.visible) {
                obj.visible = false;
                hidden.push(obj);
            }
        };
        hide(nightSky.equatorialSphereGroup);
        hide(nightSky.constellationsGroup);

        // Draw stars at cube-face scale rather than look-view scale. This is
        // the same chain CNodeView.adjustPointScale applies, with the cube's
        // 90° face FOV and pixel height substituted, times the user's boost.
        const cloud = nightSky.starField?.lightCloud;
        let savedStarScale, savedStarFOV;
        if (cloud?.material) {
            savedStarScale = cloud.material.uniforms.baseScale.value;
            savedStarFOV = cloud.material.uniforms.cameraFOV.value;
            let scale = 1.4 / 1.78 * 2 * Sit.starScale / window.devicePixelRatio;
            scale *= skyFactor;
            scale *= this.cubeResolution / view.nominalViewHeight;
            scale *= 45 / 90;
            scale /= 2;
            cloud.material.uniforms.baseScale.value = scale * this.starBoost;
            cloud.material.uniforms.cameraFOV.value = 90;
        }

        // Enlarge the Moon for the capture only. Whichever copy is visible is
        // the one being rendered — CPlanets hides the night-scene Moon when a
        // day scene exists — so scale both and restore both.
        const moonData = nightSky.planets?.planetSprites?.["Moon"];
        const boostedMoons = [];
        if (this.moonBoost !== 1) {
            for (const mesh of [moonData?.sprite, moonData?.daySkySprite]) {
                if (mesh) {
                    boostedMoons.push({mesh, scale: mesh.scale.clone()});
                    mesh.scale.multiplyScalar(this.moonBoost);
                }
            }
        }

        const savedTarget = renderer.getRenderTarget();
        const savedAutoClear = renderer.autoClear;
        const savedClearAlpha = renderer.getClearAlpha();
        const savedClearColor = renderer.getClearColor(this._clearColorScratch ??= new Color());

        // The six cube-camera child cameras carry their own layer masks.
        for (const faceCamera of camera.children) {
            faceCamera.layers.mask = LAYER.MASK_LOOKRENDER;
        }

        try {
            renderer.setClearColor(0x000000, 1);
            // renderCanvas leaves autoClear off; without a clear each face
            // accumulates the previous capture and stars smear into trails.
            renderer.autoClear = true;
            camera.update(renderer, GlobalNightSkyScene);

            // Visible Sun/Moon live in the other scene — draw them on top of
            // the stars rather than clearing them away.
            if (GlobalSunSkyScene !== undefined) {
                renderer.autoClear = false;
                camera.update(renderer, GlobalSunSkyScene);
            }
        } finally {
            renderer.autoClear = savedAutoClear;
            renderer.setClearColor(savedClearColor, savedClearAlpha);
            renderer.setRenderTarget(savedTarget);
            for (const obj of hidden) obj.visible = true;
            for (const {mesh, scale} of boostedMoons) mesh.scale.copy(scale);
            if (cloud?.material) {
                cloud.material.uniforms.baseScale.value = savedStarScale;
                cloud.material.uniforms.cameraFOV.value = savedStarFOV;
            }
        }

        return true;
    }

    clearUniforms() {
        sharedUniforms.waterReflection.value = 0.0;
        sharedUniforms.waterSkyCube.value = null;
    }

    // Called immediately before the look view renders GlobalScene. Returns
    // true if the reflection is active, so the caller knows to pop it.
    push(view) {
        if (!this.enabled) return false;
        // Look view only, by design — the reflection is an eye-level effect
        // and the shared terrain uniforms would otherwise reach mainView too.
        if (view.id !== "lookView") return false;

        const waterColor = this.getWaterColor();
        if (waterColor === undefined) return false;

        const nightSky = NodeMan.get("NightSkyNode", false);
        if (!nightSky) return false;

        // Fade with the sky exactly as the night sky itself does: renderSky
        // skips the stars entirely once skyOpacity reaches 1.
        const sunNode = NodeMan.get("theSun", true);
        const skyOpacity = sunNode ? sunNode.calculateSkyOpacity(view.camera.position) : 0;
        const nightFactor = Math.max(0, 1 - skyOpacity);
        if (nightFactor <= 0) return false;

        const skyBrightness = sunNode ? sunNode.calculateSkyBrightness(view.camera.position) : 0;
        const skyFactor = Math.max(0, 1 - skyBrightness);

        if (!this.captureSky(view, skyFactor)) return false;

        const {target} = this.getCubeTarget(view.renderer);

        // Re-anchor the wave phase origin only on a big jump — see the constant.
        if (!this.waveOriginSet || this.waveOrigin.distanceTo(view.camera.position) > WAVE_ORIGIN_REANCHOR_M) {
            this.waveOrigin.copy(view.camera.position);
            this.waveOriginSet = true;
        }

        sharedUniforms.waterReflection.value = nightFactor;
        sharedUniforms.waterSkyCube.value = target.texture;
        sharedUniforms.waterColor.value.set(waterColor[0] / 255, waterColor[1] / 255, waterColor[2] / 255);
        sharedUniforms.waterTolerance.value = this.tolerance;
        sharedUniforms.waterStrength.value = this.strength;
        sharedUniforms.waterDarken.value = this.darken;
        sharedUniforms.waterWaveStrength.value = this.waveStrength;
        sharedUniforms.waterWaveLength.value = this.waveLength;
        sharedUniforms.waterWaveTime.value = this.waveTime;
        sharedUniforms.waterWaveOrigin.value.copy(this.waveOrigin);

        // Geodetic up correction for the active earth model — 1.0 if it is a
        // sphere, (a/b)^2 for the WGS84 ellipsoid.
        const a = Globals.equatorRadius;
        const b = Globals.polarRadius;
        sharedUniforms.waterUpSquash.value = (a && b) ? (a * a) / (b * b) : 1.0;

        const camera = view.camera;
        if (camera.__sitrecOrthoMatrixActive) {
            camera.getWorldDirection(this._orthoDir ??= new Vector3());
            sharedUniforms.waterOrthoDir.value.set(this._orthoDir.x, this._orthoDir.y, this._orthoDir.z, 1);
        } else {
            sharedUniforms.waterOrthoDir.value.set(0, 0, 0, 0);
        }

        return true;
    }

    pop() {
        this.clearUniforms();
    }
}
