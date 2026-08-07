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
    MeshBasicMaterial,
    Vector3,
    WebGLCubeRenderTarget,
} from "three";
import {GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "../LocalFrame";
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
        // A 90-degree cube face resolves ~0.09 degrees per pixel at 1024, so a
        // star at its true size lands sub-pixel and vanishes once the water
        // shader samples it. Boosting star SIZE inflates their total flux by
        // roughly the square of the boost, so it stays deliberately small — a
        // little goes a long way before the water turns milky.
        this.starBoost = v.starBoost ?? 1.4;
        // The Moon gets the same treatment for the same reason: its disc is
        // only a few pixels across in the cube, so once stars are boosted the
        // moonglade — which in reality dominates a night lake — reads weaker
        // than the starfield. Boosting size raises flux by roughly its square.
        this.moonBoost = v.moonBoost ?? 1.4;
        this.waveStrength = v.waveStrength ?? 0.02;
        this.waveLength = v.waveLength ?? 30.0;
        this.waveSpeed = v.waveSpeed ?? 1.0;
        // Only allocated while the effect is on, so 1024 (~88MB with the
        // occlusion mask) is a fair default — 512 is visibly chunkier.
        this.cubeResolution = v.cubeResolution ?? 1024;
        this.occlusion = v.occlusion ?? true;
        // Paint OSM's water fill into whatever imagery is loaded, so water is
        // detectable on sources that have no flat colour for it (satellite
        // photography). Owned here rather than by the terrain UI because it
        // exists to serve this effect; the terrain UI only decides whether the
        // current source's tiles line up with OSM's.
        this.combineWithOSM = v.combineWithOSM ?? false;

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
            "occlusion",
            "combineWithOSM",
        ]);

        // Per-renderer cube targets. Each CNodeView3D owns its own
        // WebGLRenderer, and a cube render target belongs to one GL context.
        this.cubeTargets = new Map();
        this.occlusionTargets = new Map();
        this._occlusionKey = null;

        this.waveTime = 0;
        this.waveOrigin = new Vector3();
        this.waveOriginSet = false;
        this._captureKey = null;

        // GUI — a submenu under Effects. Guarded so the node still works in
        // headless contexts where the menu bar does not exist.
        this.gui = guiMenus.effects ? guiMenus.effects.addFolder("Water Reflection") : undefined;
        if (this.gui) {
            const changed = () => {
                this._captureKey = null; // force a fresh capture
                this._occlusionKey = null;
                setRenderOne(true);
            };
            const addValue = (property, start, end, step, name) =>
                this.gui.add(this, property, start, end, step).name(name).listen().onChange(changed);

            this.gui.add(this, "enabled").name("Water Reflection").listen().onChange(changed)
                .tooltip("Reflect the night sky in water. Water is detected by the colour of the map texture, "
                    + "so it needs a map source with a flat water fill (OSM) — or Combine Terrain with OSM "
                    + "below. Look view only.");
            this.combineController = this.gui.add(this, "combineWithOSM")
                .name("Combine Terrain with OSM").listen()
                .tooltip("Also load the matching Open Streetmap tile for each terrain tile and copy its water "
                    + "areas into the current imagery, so water can be detected on satellite sources. Costs one "
                    + "extra tile fetch per tile and reloads the terrain when changed. Only available for "
                    + "sources that share OSM's tile layout.")
                .onChange(() => {
                    // Same reload path as switching map source: every tile's
                    // texture has to be rebuilt, and cached materials are keyed
                    // separately for combined vs plain.
                    const terrainNode = NodeMan.get("TerrainModel", false);
                    if (terrainNode) {
                        terrainNode.loadMapTexture(terrainNode.UI.mapType);
                        terrainNode.UI.requestSubdivisionPass();
                    }
                    this._captureKey = null;
                    setRenderOne(true);
                });
            addValue("strength", 0, 2, 0.01, "Reflection Strength")
                .tooltip("Brightness of the reflected sky. 1.0 is the physical Fresnel amount.");
            addValue("darken", 0, 1, 0.01, "Water Darkening")
                .tooltip("How far the flat map water colour is pulled towards black while the reflection is on. "
                    + "0.9 leaves 10% of it, so the reflected sky dominates instead of being washed out by map blue.");
            addValue("starBoost", 1, 3, 0.01, "Star Boost")
                .tooltip("How much bigger stars are drawn into the reflection cube map than they appear on screen. "
                    + "At their true size most stars are sub-pixel in the cube and disappear from the reflection. "
                    + "Brightness rises with roughly the square of this, so small changes go a long way.");
            addValue("moonBoost", 1, 3, 0.01, "Moon Boost")
                .tooltip("Same idea for the Moon, so the moonglade stays brighter than the reflected stars.");
            addValue("waveStrength", 0, 0.2, 0.001, "Wave Strength")
                .tooltip("How much ripples tilt the water surface. 0 gives a perfect mirror.");
            addValue("waveLength", 1, 200, 0.5, "Wave Length (m)")
                .tooltip("Distance between wave crests.");
            addValue("waveSpeed", 0, 5, 0.01, "Wave Speed")
                .tooltip("How fast ripples move. 0 freezes them (and stops forcing re-renders while paused).");
            // A dropdown rather than a slider: cube sizes want to be powers of
            // two, and a slider would dispose and rebuild the render target on
            // every drag step — at 2048 that is a ~270MB texture each time.
            // Every label carries a non-digit: a key that looks like an integer
            // ("512") is hoisted to the front of the object in numeric order by
            // the JS engine, which scrambles the menu.
            this.gui.add(this, "cubeResolution", {
                "256 (fastest)": 256,
                "512 (low)": 512,
                "1024 (default)": 1024,
                "2048 (heavy)": 2048,
            }).name("Env Map Resolution").listen().onChange(changed)
                .tooltip("Cube map size for the reflected sky. Higher gives finer, sharper stars and a crisper "
                    + "Moon, at the cost of video memory — a 2048 cube is around 270MB, and the sky is re-rendered "
                    + "into it whenever time moves. 512 or 1024 is the sweet spot. The terrain occlusion mask "
                    + "follows this but stops at 1024.");
            this.gui.add(this, "occlusion").name("Terrain Occlusion").listen().onChange(changed)
                .tooltip("Stop the water reflecting sky that is hidden behind terrain. Captures the terrain "
                    + "silhouette from the observer and masks the reflection with it.");
            addValue("tolerance", 0.01, 0.5, 0.005, "Water Colour Tolerance")
                .tooltip("How close a map pixel must be to the source's water colour to count as water. "
                    + "Raise it to fill in antialiased shorelines, lower it if land is being flooded.");
        }
    }

    dispose() {
        for (const map of [this.cubeTargets, this.occlusionTargets]) {
            for (const {target, camera} of map.values()) {
                target.dispose();
                camera.children.length = 0;
            }
            map.clear();
        }
        this._occluderMaterial?.dispose();
        this._occluderMaterial = undefined;
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
    // The combine only works where the source's tiles line up with OSM's, and
    // that can change under us — the terrain node may not even exist yet when
    // this node is built, and the user can switch map source at any time. Cheap
    // enough to re-check each frame rather than wiring up change notifications.
    updateCombineAvailability() {
        if (!this.combineController) return;
        const ui = NodeMan.get("TerrainModel", false)?.UI;
        const available = ui ? ui.canCombineWithOSM() : false;
        if (available !== this._combineAvailable) {
            this._combineAvailable = available;
            this.combineController.enable(available);
        }
        // Keep the flag honest: left on under an incompatible source it would
        // read as enabled while doing nothing.
        if (!available && this.combineWithOSM) {
            this.combineWithOSM = false;
        }
    }

    update(frame) {
        super.update(frame);
        this.updateCombineAvailability();

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

    // Water detection needs a map source that declares its water colour —
    // or "Combine Terrain with OSM", which stamps OSM's fill into whatever
    // imagery is loaded and so makes any compatible source detectable.
    getWaterColor() {
        const ui = NodeMan.get("TerrainModel", false)?.UI;
        const ownColor = ui?.getSourceDef?.()?.waterColor;
        if (ownColor) return ownColor;
        if (this.combineWithOSM && ui?.canCombineWithOSM()) {
            return ui.mapSources?.osm?.waterColor;
        }
        return undefined;
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

    // The occlusion mask is a silhouette, not a starfield, so it gains far less
    // from resolution than the sky cube does — and it is a full extra cube of
    // VRAM. Track the sky resolution but stop at 1024.
    get occlusionResolution() {
        return Math.min(this.cubeResolution, 1024);
    }

    getOcclusionTarget(renderer) {
        const key = renderer.domElement;
        const resolution = this.occlusionResolution;
        const existing = this.occlusionTargets.get(key);
        if (existing && existing.resolution === resolution) {
            return existing;
        }
        if (existing) {
            existing.target.dispose();
            this.occlusionTargets.delete(key);
        }
        // A plain byte target: this holds a coverage mask, not radiance. No
        // mipmaps — minifying a hard ridge line would bleed terrain into the
        // sky either side of it.
        const target = new WebGLCubeRenderTarget(resolution, {
            generateMipmaps: false,
            minFilter: LinearFilter,
            magFilter: LinearFilter,
        });
        // Far enough to reach a distant mountain skyline. Depth testing is off
        // for this pass, so the range costs no precision.
        const camera = new CubeCamera(1, 2000000, target);
        const entry = {target, camera, resolution};
        this.occlusionTargets.set(key, entry);
        return entry;
    }

    // Capture the terrain skyline as seen from the observer: white where the
    // sky is open, black where terrain blocks it. Cached on observer position
    // and tile count rather than on time — the skyline does not care what the
    // sky is doing, which is exactly why this is a separate cube from the sky
    // capture that re-renders every frame during playback.
    captureOcclusion(view) {
        const terrainNode = NodeMan.get("TerrainModel", false);
        const terrainGroup = terrainNode?.getGroup?.();
        if (!terrainGroup || !terrainGroup.visible) return false;

        const buildingsGroup = terrainNode.UI?.buildingsNode?.group;
        const renderer = view.renderer;
        const {target, camera} = this.getOcclusionTarget(renderer);
        const p = view.camera.position;

        const key = [
            Math.round(p.x / 2), Math.round(p.y / 2), Math.round(p.z / 2),
            terrainGroup.children.length,
            buildingsGroup ? buildingsGroup.children.length : 0,
            this.occlusionResolution,
        ].join(",");
        if (key === this._occlusionKey) return true;
        this._occlusionKey = key;

        // Everything that is not landscape is hidden: tracks, LOS lines and
        // markers are annotations, and punching their silhouettes into the sky
        // mask would carve black streaks across the reflection.
        const keep = new Set([terrainGroup, buildingsGroup].filter(Boolean));
        const hidden = [];
        for (const child of GlobalScene.children) {
            if (!keep.has(child) && child.visible) {
                child.visible = false;
                hidden.push(child);
            }
        }

        this._occluderMaterial ??= new MeshBasicMaterial({
            color: 0x000000,
            fog: false,
            // Silhouette only: whatever terrain covers is blocked, and drawing
            // it last over a white clear means depth never enters into it.
            depthTest: false,
            depthWrite: false,
        });

        const savedTarget = renderer.getRenderTarget();
        const savedAutoClear = renderer.autoClear;
        const savedClearAlpha = renderer.getClearAlpha();
        const savedClearColor = renderer.getClearColor(this._clearColorScratch ??= new Color());
        const savedOverride = GlobalScene.overrideMaterial;
        // Six renders of GlobalScene would otherwise drag six shadow-map
        // updates along with them — with most of the scene hidden, which is
        // both wasted work and pointless for a flat black silhouette.
        const savedShadows = renderer.shadowMap.enabled;

        camera.position.copy(p);
        camera.updateMatrixWorld();
        for (const faceCamera of camera.children) {
            faceCamera.layers.mask = LAYER.MASK_LOOKRENDER;
        }

        try {
            GlobalScene.overrideMaterial = this._occluderMaterial;
            renderer.shadowMap.enabled = false;
            renderer.setClearColor(0xffffff, 1);
            renderer.autoClear = true;
            camera.update(renderer, GlobalScene);
        } finally {
            GlobalScene.overrideMaterial = savedOverride;
            renderer.shadowMap.enabled = savedShadows;
            renderer.autoClear = savedAutoClear;
            renderer.setClearColor(savedClearColor, savedClearAlpha);
            renderer.setRenderTarget(savedTarget);
            for (const obj of hidden) obj.visible = true;
        }

        return true;
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
        // Nothing in the celestial scenes casts or receives shadows.
        const savedShadows = renderer.shadowMap.enabled;

        // The six cube-camera child cameras carry their own layer masks.
        for (const faceCamera of camera.children) {
            faceCamera.layers.mask = LAYER.MASK_LOOKRENDER;
        }

        try {
            renderer.shadowMap.enabled = false;
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
            renderer.shadowMap.enabled = savedShadows;
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
        sharedUniforms.waterOcclusion.value = 0.0;
        sharedUniforms.waterOcclusionCube.value = null;
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

        if (this.occlusion && this.captureOcclusion(view)) {
            sharedUniforms.waterOcclusionCube.value = this.getOcclusionTarget(view.renderer).target.texture;
            sharedUniforms.waterOcclusion.value = 1.0;
        } else {
            sharedUniforms.waterOcclusion.value = 0.0;
        }

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
