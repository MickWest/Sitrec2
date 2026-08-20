// CNodeWaterReflection.js
//
// Reflects the night sky in water surfaces of the map-textured terrain.
//
// How it works:
//
//  1. Water is detected in the TERRAIN SHADER by the color of the map tile
//     texture — the flat OSM water fill by default. That is a hack, and it is
//     deliberately one: it needs no extra data, no vector tiles and no
//     geometry, and it tracks whatever the user is actually looking at. It is
//     gated on the active map source declaring a waterColor, so switching to
//     satellite/debug imagery cannot invent lakes out of similarly-colored
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
    DataTexture,
    FloatType,
    NearestFilter,
    RGBAFormat,
    HalfFloatType,
    LinearFilter,
    LinearMipmapLinearFilter,
    MeshBasicMaterial,
    Vector3,
    WebGLCubeRenderTarget,
} from "three";
import {GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "../LocalFrame";
import {guiMenus, NodeMan, Sit, setRenderOne, Globals, GlobalDateTimeNode} from "../Globals";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {CWaterPlanarMirror} from "../WaterPlanarMirror";
import {OCEAN_MAX_WAVES} from "../ocean/OceanBRDF.glsl.js";
import {altitudeHAE} from "../SphericalMath";
import * as Astronomy from "astronomy-engine";
import {
    buildWaveComponents,
    coxMunkSlopeVariance,
    spectrumParams,
    totalSlopeVariance,
    u10ToU125,
    waterLeavingReflectance,
    whitecapCoverage,
} from "../ocean/OceanSpectrum";
import * as LAYER from "../LayerMasks";

// Beyond this distance from the wave-phase origin, float32 world positions stop
// resolving a wavelength. Re-origin only on a jump this large so the ripple
// pattern never visibly swims while the camera moves normally.
const WAVE_ORIGIN_REANCHOR_M = 50000;

// Clearance a skirt's lower edge must keep above the water before it is left
// alone. Skirts that stop short of this never intrude on the lake, so they keep
// covering their own LOD cracks.
const SKIRT_HIDE_MARGIN_M = 50;

// Apparent magnitude of a full Moon, the reference the phase scaling is measured
// against. Astronomy.Illumination gives the Moon's magnitude directly, which carries
// both its phase and its distance, so a crescent correctly makes a fainter glade than
// a full Moon at perigee.
const FULL_MOON_MAGNITUDE = -12.7;

// What share of the night ambient the Moon is treated as supplying.
//
// This one number is a RENDERING CHOICE, not a measurement, and it is worth being
// plain about why. Sitrec's night ambient was measured at exactly 0.4*pi whether the
// Moon sits at 21 degrees or at 61 — it is a fixed floor, not moonlight — and the
// night scene overall renders only about 1.5x darker than the day scene, against a
// reality of roughly a million to one. Night here is heavily exposure-boosted by
// design, and a moonglade has to be boosted with it or it cannot appear in the same
// image at all.
//
// So the absolute level is a free parameter, chosen so that zero stops of glitter
// exposure suits day and night alike. What is NOT free, and is modelled properly, is
// how the glade varies: with the Moon's phase and distance through its magnitude, and
// with the geometry through the BRDF.
const MOON_AMBIENT_SHARE = 1 / 16;

// A tile whose LOWEST point is this far above the water cannot contain the body
// being reflected. Its blue pixels are streams, rivers and reservoirs at some
// other elevation, and reflecting those in a plane fitted to the lake is
// meaningless — they light up as bright lines threading through the hills.
const WATER_TILE_ALT_MARGIN_M = 20;

// ...and a tile only a sliver of which is water is a watercourse, not a body of
// it. A shoreline tile runs from a few percent to most of a tile; a river is far
// below this even where it fills its whole tile lengthwise.
const WATER_TILE_MIN_FRACTION = 0.02;

export class CNodeWaterReflection extends CNode {
    constructor(v) {
        super(v);

        this.enabled = v.enabled ?? false;
        this.strength = v.strength ?? 1.0;
        this.tolerance = v.tolerance ?? 0.10;
        // How far the flat map water color is pulled towards the real water
        // color while the reflection is active. 0.9 leaves 10% of the map fill.
        this.darken = v.darken ?? 0.9;
        // Daytime deep-water color, sRGB 0-1. At night this fades to black,
        // where the only thing left on the surface is what it reflects.
        this.dayColor = v.dayColor ?? [0.06, 0.13, 0.20];
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
        // detectable on sources that have no flat color for it (satellite
        // photography). Owned here rather than by the terrain UI because it
        // exists to serve this effect; the terrain UI only decides whether the
        // current source's tiles line up with OSM's.
        this.combineWithOSM = v.combineWithOSM ?? false;

        // "cube" reflects the celestial sphere only, from a cube map (the
        // original, cheap, and exact for the sky). "mirror" re-renders the
        // entire world from a mirrored camera, so the far shore lands in the
        // water too — at the cost of a second full scene render, and of
        // pretending a 35 km lake is flat. See WaterPlanarMirror.js.
        this.mode = v.mode ?? "cube";
        // Mirror render target size relative to the look view's own.
        this.mirrorScale = v.mirrorScale ?? 1.0;
        this.mirrorClip = v.mirrorClip ?? true;
        // Metres the clip plane is lifted above the water, so the lake surface
        // itself does not fight its own reflection at the near plane.
        this.mirrorClipBias = v.mirrorClipBias ?? 0.2;
        this.mirrorDistance = v.mirrorDistance ?? 1500;
        this.mirrorAutoLevel = v.mirrorAutoLevel ?? true;
        this.mirrorLevel = v.mirrorLevel ?? 0;
        // Widest terrain tile (metres) whose map texture is still trusted to
        // identify water. See the shader; 0 disables the fade.
        this.mirrorMaxTile = v.mirrorMaxTile ?? 4000;
        this.mirrorHideSkirts = v.mirrorHideSkirts ?? true;

        // Ocean (spectral) mode. These are PHYSICAL inputs, not look knobs: the
        // wind speed drives a published wave spectrum whose integrated slope
        // variance reproduces Cox & Munk's sun-glitter measurements, and every
        // visible property of the surface follows from that. Turning the wind up
        // does not "add more ripples", it moves the sea along the same one-parameter
        // family that a real sea moves along.
        this.windSpeed = v.windSpeed ?? 5.0;          // U10, m/s
        this.windDirection = v.windDirection ?? 270;  // degrees, direction wind blows FROM
        // Inverse wave age. 0.84 is a fully developed sea with unlimited fetch; a
        // young, short-fetch sea is steeper for the same wind and runs up towards 5.
        this.waveAge = v.waveAge ?? 0.84;
        this.waterType = v.waterType ?? "ocean";
        this.whitecaps = v.whitecaps ?? true;
        this.gustiness = v.gustiness ?? 0.5;
        // Wavenumber bands in the resolved wave field, four directions each. Sixteen
        // bands is 64 trains, which is the shader's maximum.
        this.waveDetail = v.waveDetail ?? 16;
        this.debugView = v.debugView ?? "off";
        // What the glitter term is divided by before the tone shoulder. The
        // specular image of the Sun is thousands of times brighter than the sky, so
        // in any real photograph the apparent LENGTH of a glitter path is set by
        // where it crosses saturation rather than by the width of the slope
        // distribution — which means an exposure control is part of the physics
        // here, not a cheat bolted on after it.
        // In STOPS, so the control is photographic and the range can span the four
        // orders of magnitude that separate a specular image of the Sun from the sky
        // around it. Each step doubles the glitter.
        //
        // Zero is the calibrated default, and it is calibrated against the RATIO
        // rather than against any one scene: with the source radiance reconstructed
        // from delivered irradiance, the glade peaks at roughly twenty times the
        // reflected sky, which is what a real glitter path does. Tuning it against a
        // night scene instead gives about -8, because a near-black sea makes almost
        // anything visible — and that value then renders nothing at all by day.
        this.glitterExposure = v.glitterExposure ?? 0;

        this.addSimpleSerials([
            "enabled",
            "mode",
            "mirrorScale",
            "mirrorClip",
            "mirrorClipBias",
            "mirrorDistance",
            "mirrorAutoLevel",
            "mirrorLevel",
            "mirrorMaxTile",
            "mirrorHideSkirts",
            "windSpeed",
            "windDirection",
            "waveAge",
            "waterType",
            "whitecaps",
            "gustiness",
            "waveDetail",
            "debugView",
            "glitterExposure",
            "strength",
            "darken",
            "dayColor",
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
                .tooltip("Reflect the night sky in water. Water is detected by the color of the map texture, "
                    + "so it needs a map source with a flat water fill (OSM) — or Combine Terrain with OSM "
                    + "below. Look view only.");
            this.gui.add(this, "mode", {
                "Sky Cube": "cube",
                "Planar Mirror (experimental)": "mirror",
                "Ocean (spectral)": "ocean",
            }).name("Method").listen().onChange(() => {
                this.applyMode();
                changed();
            }).tooltip("Sky Cube reflects only the celestial sphere — stars, Moon and Sun — captured into a "
                + "cube map. Planar Mirror finds the flat surface of the water and re-renders the whole world "
                + "from a camera mirrored through it, so hills, buildings and objects appear in the water too. "
                + "The mirror costs a second full render of the scene, and treats the lake as flat, which it "
                + "is not over more than a few kilometres.");
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
                .tooltip("How far the flat map water color is pulled towards real water color while the "
                    + "reflection is on. 0.9 leaves 10% of the map fill, so the reflection dominates instead "
                    + "of being washed out by map blue.");
            this.gui.addColor(this, "dayColor").name("Daylight Water Color").listen().onChange(changed)
                .tooltip("What water attenuates towards in daylight — deep water is dark blue, not the pale "
                    + "flat fill the map paints it. Fades to black at night, where only reflected light is left.");
            this.cubeOnly = [];
            this.cubeOnly.push(addValue("starBoost", 1, 3, 0.01, "Star Boost")
                .tooltip("How much bigger stars are drawn into the reflection cube map than they appear on screen. "
                    + "At their true size most stars are sub-pixel in the cube and disappear from the reflection. "
                    + "Brightness rises with roughly the square of this, so small changes go a long way."));
            this.cubeOnly.push(addValue("moonBoost", 1, 3, 0.01, "Moon Boost")
                .tooltip("Same idea for the Moon, so the moonglade stays brighter than the reflected stars."));
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
            this.cubeOnly.push(this.gui.add(this, "cubeResolution", {
                "256 (fastest)": 256,
                "512 (low)": 512,
                "1024 (default)": 1024,
                "2048 (heavy)": 2048,
            }).name("Env Map Resolution").listen().onChange(changed)
                .tooltip("Cube map size for the reflected sky. Higher gives finer, sharper stars and a crisper "
                    + "Moon, at the cost of video memory — a 2048 cube is around 270MB, and the sky is re-rendered "
                    + "into it whenever time moves. 512 or 1024 is the sweet spot. The terrain occlusion mask "
                    + "follows this but stops at 1024."));
            this.cubeOnly.push(this.gui.add(this, "occlusion").name("Terrain Occlusion").listen().onChange(changed)
                .tooltip("Stop the water reflecting sky that is hidden behind terrain. Captures the terrain "
                    + "silhouette from the observer and masks the reflection with it."));
            addValue("tolerance", 0.01, 0.5, 0.005, "Water Color Tolerance")
                .tooltip("How close a map pixel must be to the source's water color to count as water. "
                    + "Raise it to fill in antialiased shorelines, lower it if land is being flooded.");

            // Ocean settings, in their own folder. Every one of these is a
            // physical quantity that feeds a published model, so the panel reads
            // like a sea state rather than like a shader.
            this.oceanGui = this.gui.addFolder("Ocean");
            this.oceanGui.add(this, "windSpeed", 0.5, 20, 0.1).name("Wind Speed (m/s)")
                .listen().onChange(changed)
                .tooltip("Wind at 10 m, which sets the whole sea state. It drives the Elfouhaily wave "
                    + "spectrum, and the slope variance that comes out of it reproduces the sun-glitter "
                    + "measurements Cox and Munk made in 1954 — so this is a physical input, not a "
                    + "roughness slider. 2 is glassy, 5 a light breeze, 10 a fresh wind with the first "
                    + "whitecaps, 15 a near gale.");
            this.oceanGui.add(this, "windDirection", 0, 360, 1).name("Wind From (deg)")
                .listen().onChange(changed)
                .tooltip("Compass direction the wind blows FROM. A real sea is measurably steeper along "
                    + "the wind than across it, so this rotates the glitter path and the surface texture.");
            this.oceanGui.add(this, "waveAge", 0.84, 5, 0.01).name("Sea Youth")
                .listen().onChange(changed)
                .tooltip("Inverse wave age. 0.84 is a fully developed sea after the wind has blown a long "
                    + "time over a long fetch; higher values are a young sea close to shore, which is "
                    + "steeper and choppier for the same wind speed.");
            this.oceanGui.add(this, "waterType", {
                "Open ocean (deep blue)": "ocean",
                "Coastal (blue-green)": "coastal",
                "Turbid (green-brown)": "turbid",
            }).name("Water Type").listen().onChange(changed)
                .tooltip("What the water body itself does to light that enters it. The color of the sea "
                    + "is not a surface property — it is light that went in and came back out, so without "
                    + "this the water is grey glass however good the reflection is.");
            this.oceanGui.add(this, "waveDetail", 4, 16, 1).name("Wave Detail")
                .listen().onChange(changed)
                .tooltip("How many wavenumber bands of the spectrum are drawn as actual travelling "
                    + "waves, four directions each. Waves too short for a pixel to resolve become "
                    + "roughness instead, so lowering this shifts the surface from geometry towards "
                    + "statistics rather than removing anything — the sea state stays the same.");
            this.oceanGui.add(this, "gustiness", 0, 1, 0.01).name("Gustiness")
                .listen().onChange(changed)
                .tooltip("How patchy the wind is. Gusts and Langmuir circulation break a real sea "
                    + "into streaks of rougher and smoother water hundreds of metres across, running "
                    + "along the wind. It is the most conspicuous large-scale structure on a real sea "
                    + "seen from altitude. The average roughness is unchanged, so this redistributes "
                    + "the sea state rather than adding to it.");
            this.oceanGui.add(this, "whitecaps").name("Whitecaps").listen().onChange(changed)
                .tooltip("Breaking-wave foam. Coverage follows wind speed steeply, so there is essentially "
                    + "none below 7 m/s and a few percent by 15.");
            this.oceanGui.add(this, "debugView", {
                "Off": "off",
                "Gustiness": "gust",
                "Resolved waves": "waves",
                "Unresolved roughness": "roughness",
                "Reflection source": "blend",
            }).name("Debug View").listen().onChange(changed)
                .tooltip("False-color one of the intermediate quantities into the water. A surface "
                    + "whose job is to look smooth is very hard to debug by eye — more than one real "
                    + "defect here stayed invisible until the quantity behind it was put on screen.");
            this.oceanGui.add(this, "glitterExposure", -14, 4, 0.25).name("Glitter Exposure")
                .listen().onChange(changed)
                .tooltip("Exposure of the glitter path, in stops. The specular image of the Sun is "
                    + "thousands of times brighter than the sky, so in any real photograph the apparent "
                    + "LENGTH of a glitter path is set by where it crosses the sensor's saturation, not "
                    + "by the width of the wave slope distribution. This is that exposure: it changes "
                    + "how far the glitter reaches without changing the physics underneath it.");

            // Planar-mirror-only settings, in their own folder so the main
            // panel does not grow a row of controls that do nothing in the
            // default mode.
            this.mirrorGui = this.gui.addFolder("Planar Mirror");
            const addMirror = (property, start, end, step, name) =>
                this.mirrorGui.add(this, property, start, end, step).name(name).listen().onChange(changed);

            addMirror("mirrorDistance", 10, 20000, 10, "Ripple Reach (m)")
                .tooltip("How far away the reflected scenery is assumed to be. Ripples displace the reflection "
                    + "by tilting the reflected ray, and how far that moves the image depends on how distant "
                    + "what it hits is. Too small and the water goes glassy; too large and it churns.");
            this.mirrorGui.add(this, "mirrorScale", {
                "Full (sharpest)": 1.0,
                "Half (faster)": 0.5,
                "Quarter (fastest)": 0.25,
            }).name("Mirror Resolution").listen().onChange(changed)
                .tooltip("Size of the mirrored render relative to the look view. The reflection is broken up by "
                    + "ripples and dimmed by Fresnel, so half resolution is usually indistinguishable and costs "
                    + "a quarter of the fill.");
            this.mirrorGui.add(this, "mirrorClip").name("Clip Below Water").listen().onChange(changed)
                .tooltip("Bend the mirrored camera's near plane onto the water surface so nothing below the "
                    + "waterline is drawn into the reflection. Turn it off to see what it was hiding — around "
                    + "Tahoe the land to the east is 500 m below lake level and floods the reflection.");
            addMirror("mirrorClipBias", 0, 5, 0.05, "Clip Bias (m)")
                .tooltip("How far above the water the clip plane sits. The lake surface is exactly coplanar with "
                    + "the mirror, so a small lift stops it fighting its own reflection at the near plane.");
            this.mirrorGui.add(this, "mirrorAutoLevel").name("Auto Water Level").listen().onChange(changed)
                .tooltip("Find the water surface by firing a grid of rays into the view and taking the largest "
                    + "cluster of equal ground altitudes — a lake is perfectly flat in the elevation data, so it "
                    + "stands out. Turn off to set the level by hand when the automatic pick lands on the wrong "
                    + "flat thing.");
            this.mirrorGui.add(this, "mirrorHideSkirts").name("Hide Waterline Skirts").listen().onChange(changed)
                .tooltip("Hide the downward skirts terrain tiles carry to cover the cracks between detail "
                    + "levels, for tiles at or near the waterline. A skirt is a tenth of its tile wide, so a "
                    + "distant tile hangs a wall over a kilometre deep — invisible looking down, but at eye "
                    + "level over water they stand across the view and block the surface being reflected. "
                    + "Terrain well above the water keeps its skirts, so hillsides keep their crack covers. "
                    + "Turn off to see them.");
            addMirror("mirrorMaxTile", 0, 20000, 100, "Max Tile Size (m)")
                .tooltip("Fade the reflection out where the terrain tile is wider than this. Water is found by "
                    + "the color of the map texture, and distant water is drawn by huge low-detail tiles that "
                    + "still carry only a 512-pixel texture — one texel covers kilometres, the flat water fill "
                    + "gets averaged with the coastline, and the reflection breaks into blotches. This makes it "
                    + "stop cleanly instead. 0 turns the fade off, to see what it was hiding.");
            addMirror("mirrorLevel", 0, 9000, 0.1, "Water Level (m HAE)")
                .tooltip("Manual water surface height, in metres above the WGS84 ellipsoid — NOT sea level. "
                    + "Ignored while Auto Water Level is on, which reports the height it found here.");

            this.applyMode();
        }
    }

    // A saved sitch restores `mode` by writing the property directly, which
    // does not run the dropdown's onChange — so the panel would keep showing
    // the other mode's controls until the user touched it.
    modDeserialize(v) {
        super.modDeserialize(v);
        this.applyMode();
    }

    // Show only the controls that do something in the current mode.
    applyMode() {
        if (!this.gui) return;
        const mirror = this.mode === "mirror";
        const ocean = this.mode === "ocean";
        // The cube-only controls are about drawing stars and Moon INTO a cube map,
        // which neither of the other two methods does.
        for (const controller of this.cubeOnly) controller.show(!mirror && !ocean);
        // Ocean borrows the mirror's render target, so its settings apply too.
        this.mirrorGui.show(mirror || ocean);
        this.oceanGui.show(ocean);
    }

    dispose() {
        this._waveTexture?.dispose();
        this._waveTexture = null;
        for (const map of [this.cubeTargets, this.occlusionTargets]) {
            for (const {target, camera} of map.values()) {
                target.dispose();
                camera.children.length = 0;
            }
            map.clear();
        }
        this._occluderMaterial?.dispose();
        this._occluderMaterial = undefined;
        this.planarMirror?.dispose();
        this.planarMirror = undefined;
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

    // Water detection needs a map source that declares its water color —
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
            // Tangent ratio, matching adjustPointScale's FOV term. Was 45/90, the
            // small-angle stand-in — and 90 deg is exactly where that is worst, so the
            // reflected stars came out ~17% brighter than the sky they reflect.
            scale *= Math.tan(45 * Math.PI / 360) / Math.tan(90 * Math.PI / 360);
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

    // Hide the Sun and Moon discs for the duration of the mirror capture.
    //
    // Both bodies can have two meshes: CPlanets hides the night-scene copy and draws a
    // separate day-sky copy whenever a day scene exists, so whichever is currently
    // visible is the one being rendered. Hide both and restore exactly what was hidden
    // — never blanket-restore visible=true, which would reveal the copy that CPlanets
    // deliberately keeps hidden.
    hideCelestialDiscs(nightSky) {
        this._hiddenDiscs = [];
        const sprites = nightSky?.planets?.planetSprites;
        if (!sprites) return;
        for (const body of ["Sun", "Moon"]) {
            for (const mesh of [sprites[body]?.sprite, sprites[body]?.daySkySprite]) {
                if (mesh?.visible) {
                    this._hiddenDiscs.push(mesh);
                    mesh.visible = false;
                }
            }
        }
    }

    restoreCelestialDiscs() {
        if (!this._hiddenDiscs) return;
        for (const mesh of this._hiddenDiscs) mesh.visible = true;
        this._hiddenDiscs = null;
    }

    // Pack the resolved wave trains into a texture the shader can walk.
    //
    // A texture rather than a uniform array because the count is a user control and
    // uniform arrays are fixed at compile time — changing the detail level would
    // otherwise recompile every terrain material on the scene.
    //
    // Float textures are guaranteed in WebGL2; the wavevector components run to a few
    // tens of rad/m and amplitudes down to millimetres, so half-float would quantise
    // the long waves into steps.
    buildWaveTexture(params) {
        const built = buildWaveComponents(params, {
            bands: this.waveDetail,
            directionsPerBand: 4,
        });
        const components = built.components.slice(0, OCEAN_MAX_WAVES);
        const data = new Float32Array(OCEAN_MAX_WAVES * 4);
        for (let index = 0; index < components.length; index++) {
            const wave = components[index];
            data[index * 4 + 0] = wave.kx;
            data[index * 4 + 1] = wave.ky;
            data[index * 4 + 2] = wave.amplitude;
            data[index * 4 + 3] = wave.phase;
        }

        this._waveTexture?.dispose();
        const texture = new DataTexture(data, OCEAN_MAX_WAVES, 1, RGBAFormat, FloatType);
        // NEAREST throughout: these are discrete wave parameters, and interpolating
        // between two unrelated wave trains would invent a component that is in no
        // spectrum at all.
        texture.minFilter = NearestFilter;
        texture.magFilter = NearestFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        this._waveTexture = texture;
        this._waveCount = components.length;
        this._waveTexels = OCEAN_MAX_WAVES;
        // Slope variance outside the represented band. The shader adds this to
        // whatever the trains leave unresolved; without it the sea loses about two
        // fifths of its roughness everywhere.
        this._waveResidual = [built.residual.up, built.residual.cross];
        // Reported so the residual can be inspected: it is the share of the sea's
        // roughness that no camera in this scene is close enough to resolve, and it
        // being large is correct rather than a shortfall.
        this.waveResidualShare = built.total.up > 0
            ? built.residual.up / built.total.up
            : 0;
    }

    // Turn the wind controls into the physical quantities the shader needs.
    //
    // Everything here comes out of one number — the wind speed — by way of the
    // Elfouhaily spectrum, whose integrated slope variance reproduces what Cox and
    // Munk measured from sun-glitter photographs. Nothing is tuned by eye.
    //
    // Recomputed only when a control actually moves: integrating the spectrum is
    // thousands of curvature evaluations, which is nothing once but not something to
    // do every frame.
    applyOceanUniforms(view, skyColor, nightFactor = 0) {
        const key = `${this.windSpeed}|${this.waveAge}|${this.waterType}|${this.whitecaps}|${this.waveDetail}`;
        if (this._oceanKey !== key) {
            this._oceanKey = key;
            const params = spectrumParams(this.windSpeed, this.waveAge);
            const variance = totalSlopeVariance(params);
            this._oceanSigma2 = [variance.up, variance.cross];
            this.buildWaveTexture(params);
            this._oceanUpwelling = waterLeavingReflectance(this.waterType);
            this._oceanWhitecap = this.whitecaps ? whitecapCoverage(this.windSpeed) : 0;
            // Kept for the readout and for anyone checking the model against the
            // measurements it claims to reproduce.
            this.measuredSlopeVariance = variance.total;
            this.coxMunkSlopeVariance = coxMunkSlopeVariance(u10ToU125(this.windSpeed)).total;
        }

        sharedUniforms.waterSigma2.value.set(this._oceanSigma2[0], this._oceanSigma2[1]);
        sharedUniforms.waterWaveData.value = this._waveTexture ?? null;
        sharedUniforms.waterWaveCount.value = this._waveCount ?? 0;
        sharedUniforms.waterWaveTexels.value = Math.max(1, this._waveTexels ?? 1);
        sharedUniforms.waterResidualSigma2.value.set(
            this._waveResidual?.[0] ?? 0, this._waveResidual?.[1] ?? 0);
        sharedUniforms.waterUpwelling.value.set(...this._oceanUpwelling);
        sharedUniforms.waterWhitecap.value = this._oceanWhitecap;

        // Wind direction as (east, north) in the local tangent frame. The control is
        // the direction the wind blows FROM, as every weather report gives it, so the
        // vector it travels along is the reverse.
        const fromRadians = this.windDirection * Math.PI / 180;
        sharedUniforms.waterWindDir.value.set(-Math.sin(fromRadians), -Math.cos(fromRadians));

        // Lighting, in the renderer's own units rather than a parallel photometry.
        // sunGlobalTotal is what the rest of the terrain shader already uses for the
        // total, and subtracting the ambient part leaves the direct beam — the same
        // split the shader makes a few lines above the water block.
        const totalLight = sharedUniforms.sunGlobalTotal.value;
        const ambientLight = sharedUniforms.sunAmbientIntensity.value;
        const directLight = Math.max(0, totalLight - ambientLight);
        sharedUniforms.waterIrradiance.value = totalLight;

        // ONE source, whichever body the scene's light is currently aimed at. At
        // night Sitrec re-aims the same directional light at the Moon at a reduced
        // intensity, so following it is automatically right in both cases — and it
        // cannot double-count the way a separate Sun term and Moon term could. The
        // two discs subtend almost the same angle (0.53 vs 0.52 degrees), so a single
        // solid angle serves both.
        const sunLight = Globals.sunLight;
        if (sunLight && directLight > 0) {
            this._sunDir ??= new Vector3();
            this._sunDir.copy(sunLight.position).normalize();
            sharedUniforms.waterSunDir.value.copy(this._sunDir);
            // Radiance of the disc = irradiance it delivers / the solid angle it
            // covers. No invented photometry: the numerator is the scene's own light.
            const radiance = directLight / sharedUniforms.waterSunSolidAngle.value;
            sharedUniforms.waterSunRadiance.value.set(radiance, radiance, radiance);
        } else {
            sharedUniforms.waterSunRadiance.value.set(0, 0, 0);
        }

        // The Moon, when it is up. Unlike the Sun it drives no scene light — at night
        // the directional light's intensity is zero — so there is no scene light to
        // read a radiance from, and it has to be reconstructed the same way the Sun's
        // is: magnitude from the night ambient, which IS the scene's moonlight budget
        // once the Sun is down, divided by the solid angle the disc covers.
        //
        // Sampling the Moon out of the sky cube instead LOOKS like the principled
        // choice and is not — see the waterMoonDir comment in SharedUniforms.js. A
        // rendered disc is clipped to about 1.0 like everything else on screen, so
        // feeding it into an energy relationship put the glade four orders of
        // magnitude too dark.
        //
        // The shader drops the term by itself whenever the Moon is below the
        // fragment's horizon.
        //
        // Gated on the night factor rather than on directLight. The two shader
        // lighting parameters are NOT the three.js light intensities: at midnight
        // sunGlobalTotal is still 1.20 against an ambient of 0.65, so a "is the direct
        // beam zero" test reports broad daylight and silently deletes the moonglade.
        const toMoon = Globals.toMoon;
        let moonIrradiance = ambientLight * nightFactor * MOON_AMBIENT_SHARE;

        // Phase and distance, from the Moon's apparent magnitude. This is the part of
        // the moonglade that is real physics rather than exposure: a crescent gives a
        // glade an order of magnitude fainter than a full Moon, and the model should
        // say so.
        try {
            const date = GlobalDateTimeNode?.dateNow;
            if (date) {
                const magnitude = Astronomy.Illumination("Moon", new Date(date)).mag;
                moonIrradiance *= Math.min(1, Math.pow(10, -0.4 * (magnitude - FULL_MOON_MAGNITUDE)));
            }
        } catch (error) {
            // An unavailable ephemeris is not a reason to lose the reflection; fall
            // back to treating the Moon as full.
        }

        if (toMoon && moonIrradiance > 0) {
            sharedUniforms.waterMoonDir.value.copy(toMoon);
            const radiance = moonIrradiance / sharedUniforms.waterMoonSolidAngle.value;
            sharedUniforms.waterMoonRadiance.value.set(radiance, radiance, radiance);
        } else {
            sharedUniforms.waterMoonRadiance.value.set(0, 0, 0);
        }

        sharedUniforms.waterGlitterExposure.value = Math.pow(2, this.glitterExposure);
        sharedUniforms.waterGustiness.value = this.gustiness;
        // Gust patches grow with the wind that makes them. The floor keeps them from
        // collapsing to noise in a dead calm, where there is nothing to modulate anyway.
        sharedUniforms.waterGustScale.value = Math.max(40, 60 * this.windSpeed);
        sharedUniforms.waterDebug.value = {
            off: 0, gust: 1, waves: 2, roughness: 3, blend: 4,
        }[this.debugView] ?? 0;

        // Two-point sky for the reflection lobe, from the same model the view draws
        // its own sky and haze with — so the water cannot disagree with the sky above
        // it. Zenith is the sky color, horizon is the haze color, which is already
        // the desaturated brighter thing a clear sky becomes near the horizon.
        //
        // sRGB to linear, because the reflection is added to linear radiance after the
        // shader's own sRGB conversion.
        const toLinear = (channel) => channel <= 0.04045
            ? channel / 12.92
            : Math.pow((channel + 0.055) / 1.055, 2.4);
        const sunNode = NodeMan.get("theSun", true);
        const zenith = skyColor ?? view.background;
        if (zenith && zenith.r !== undefined) {
            sharedUniforms.waterSkyZenith.value.set(
                toLinear(zenith.r), toLinear(zenith.g), toLinear(zenith.b));
        }
        if (sunNode?.calculateHazeColor) {
            const haze = sunNode.calculateHazeColor(view.camera.position);
            sharedUniforms.waterSkyHorizon.value.set(
                toLinear(haze.r), toLinear(haze.g), toLinear(haze.b));
        } else {
            sharedUniforms.waterSkyHorizon.value.copy(sharedUniforms.waterSkyZenith.value);
        }

        // Radians per pixel, for the footprint that decides how much of the wave
        // spectrum this pixel can resolve. Taken from the camera's real vertical FOV
        // and the view's pixel height, not from a nominal value, because the look
        // view's projection has usually been patched by the time we get here.
        const camera = view.camera;
        const heightPx = view.heightPx || view.div?.clientHeight || 1080;
        sharedUniforms.waterPixelAngle.value =
            (camera.fov * Math.PI / 180) / Math.max(heightPx, 1);
        // The mirror camera copies the look camera's projection, so they share a
        // field of view. This is what tells the shader how much of the reflection
        // lobe the render target can actually account for.
        sharedUniforms.waterMirrorFov.value = camera.fov * Math.PI / 180;
    }

    clearUniforms() {
        sharedUniforms.waterReflection.value = 0.0;
        sharedUniforms.waterNightFactor.value = 0.0;
        sharedUniforms.waterSkyCube.value = null;
        sharedUniforms.waterOcclusion.value = 0.0;
        sharedUniforms.waterOcclusionCube.value = null;
        sharedUniforms.waterMirror.value = 0.0;
        sharedUniforms.waterMirrorMap.value = null;
        sharedUniforms.waterMaxTileSize.value = 0.0;
        // Every gate and every SAMPLER the ocean path installs has to come back
        // off here, not just the scalars. Terrain materials are cloned per view and
        // share these uniform objects BY REFERENCE, so a sampler left bound is a
        // render-target texture owned by the look view's GL context still reachable
        // from mainView's cloned material.
        sharedUniforms.waterOcean.value = 0.0;
        sharedUniforms.waterWaveData.value = null;
        sharedUniforms.waterWaveCount.value = 0.0;
        sharedUniforms.waterDebug.value = 0.0;
        sharedUniforms.waterSunRadiance.value.set(0, 0, 0);
        sharedUniforms.waterMoonRadiance.value.set(0, 0, 0);
        sharedUniforms.waterIrradiance.value = 0.0;
        sharedUniforms.waterWhitecap.value = 0.0;
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

        // Night factor tracks the sky exactly as renderSky does — it stops
        // drawing stars once skyOpacity reaches 1. It no longer gates the
        // effect, only what the water attenuates towards: black at night,
        // deep-water blue by day, with the Sun's reflection either way.
        const sunNode = NodeMan.get("theSun", true);
        const skyOpacity = sunNode ? sunNode.calculateSkyOpacity(view.camera.position) : 0;
        const nightFactor = Math.max(0, 1 - skyOpacity);

        const skyBrightness = sunNode ? sunNode.calculateSkyBrightness(view.camera.position) : 0;
        const skyFactor = Math.max(0, 1 - skyBrightness);

        const oceanMode = this.mode === "ocean";
        if (this.mode === "mirror" || oceanMode) {
            this.planarMirror ??= new CWaterPlanarMirror(this);
            const skyColor = sunNode ? sunNode.calculateSkyColor(view.camera.position) : view.background;
            // Detect the plane first so the tile tests know where the water is;
            // the result is cached, so render() re-using it costs nothing.
            // Both before the capture, so the mirror pass sees the same world.
            const detected = this.planarMirror.detectPlane(view);
            this.applyTileWaterGating(detected);
            this.hideSkirts(detected);
            // OCEAN MODE: take the Sun and Moon OUT of the mirror pass.
            //
            // Their discs are added analytically, so leaving them in the render target
            // counts them twice — and worse, it makes the result depend on the lens.
            // The render target only ever covers the camera's own field of view, so
            // the fraction of the reflection lobe it can account for falls as you zoom
            // in: measured 1.00 at 30 degrees against 0.28 at 8. With the Moon inside
            // the target, zooming in therefore FADED THE MOONGLADE OUT, when zooming
            // should be very close to a crop. Radiance from a patch of sea cannot
            // depend on the focal length used to look at it.
            //
            // With the discs analytic-only, the glade is the same at every zoom, and
            // the render target is left doing what it is good for: the sky gradient,
            // the clouds, the far shore.
            if (oceanMode) this.hideCelestialDiscs(nightSky);
            let texture;
            try {
                texture = this.planarMirror.render(view, skyOpacity, skyColor);
            } finally {
                this.restoreCelestialDiscs();
            }
            // No plane found (nothing flat in view, or the camera is under the
            // water): fall back to drawing no reflection at all rather than to
            // the cube, so it is obvious the mirror is not working. pop() will
            // not run on a false return, so undo the skirts here.
            if (texture === null) {
                this.restoreSkirts();
                this.restoreTileWaterGating();
                return false;
            }
            // The two methods share the mirror capture but consume it differently:
            // the mirror method looks up a point in it along a perturbed ray, the
            // ocean method blurs it by the width of a reflection lobe. Exactly one
            // gate is on.
            sharedUniforms.waterMirror.value = oceanMode ? 0.0 : 1.0;
            sharedUniforms.waterOcean.value = oceanMode ? 1.0 : 0.0;
            sharedUniforms.waterMirrorMap.value = texture;
            sharedUniforms.waterMirrorMatrix.value.copy(this.planarMirror.textureMatrix);
            sharedUniforms.waterMirrorOrigin.value.copy(this.planarMirror.origin);
            sharedUniforms.waterMirrorDistance.value = this.mirrorDistance;
            sharedUniforms.waterMaxTileSize.value = this.mirrorMaxTile;
            sharedUniforms.waterOcclusion.value = 0.0;
            // Report what the detector found, so the manual box is pre-filled
            // with something sensible the moment auto is switched off.
            if (this.mirrorAutoLevel && this.planarMirror.plane) {
                this.mirrorLevel = this.planarMirror.plane.altitude;
            }
            if (oceanMode) {
                // NO SKY CUBE HERE, deliberately. The reflection lobe is tens of
                // degrees wide at grazing incidence, so a large part of it points
                // outside the mirror camera's frustum — but those directions are
                // filled by the two-point sky (waterSkyZenith/waterSkyHorizon,
                // applied by oceanSkyRadiance), not by a captured cube. Capturing
                // one anyway costs six 1024 faces of the night sky scene, and the
                // capture key follows the celestial sphere's orientation, so it
                // would re-render EVERY FRAME while the timeline runs — for a
                // sampler the ocean branch never reads.
                this.applyOceanUniforms(view, skyColor, nightFactor);
            }
        } else {
            sharedUniforms.waterMirror.value = 0.0;
            sharedUniforms.waterOcean.value = 0.0;
            // Cube mode reflects a smooth sky, which hides the blotchy mask
            // entirely — so leave its long-standing behaviour alone.
            sharedUniforms.waterMaxTileSize.value = 0.0;
            if (!this.captureSky(view, skyFactor)) return false;
            sharedUniforms.waterSkyCube.value = this.getCubeTarget(view.renderer).target.texture;

            if (this.occlusion && this.captureOcclusion(view)) {
                sharedUniforms.waterOcclusionCube.value = this.getOcclusionTarget(view.renderer).target.texture;
                sharedUniforms.waterOcclusion.value = 1.0;
            } else {
                sharedUniforms.waterOcclusion.value = 0.0;
            }
        }

        // Re-anchor the wave phase origin only on a big jump — see the constant.
        if (!this.waveOriginSet || this.waveOrigin.distanceTo(view.camera.position) > WAVE_ORIGIN_REANCHOR_M) {
            this.waveOrigin.copy(view.camera.position);
            this.waveOriginSet = true;
        }

        sharedUniforms.waterReflection.value = 1.0;
        sharedUniforms.waterNightFactor.value = nightFactor;
        sharedUniforms.waterDayColor.value.set(this.dayColor[0], this.dayColor[1], this.dayColor[2]);

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

    // Terrain tiles carry a "skirt": geometry extruded straight down from every
    // tile edge by a TENTH of the tile's width, there to cover the cracks
    // between detail levels. Looking down at terrain you never see one. Standing
    // at eye level over water you see little else: a distant tile is kilometres
    // across, so its skirt is a wall hundreds of metres deep, and at grazing
    // incidence that wall stands across the view and hides the water surface
    // behind it. They also share the tile's material, so the water shader runs
    // on them and paints the reflection onto a vertical wall of 1-D smeared
    // texture — a band of vertical streaks across the lake.
    //
    // Nothing in the shader can fix that, because whatever is painted there is
    // occupying screen space where the water surface should be visible. The
    // skirt has to go for the duration of this view's render. Scoped to
    // push()/pop() so it covers BOTH the mirror capture and the main draw, and
    // so mainView keeps its skirts.
    // Can this tile's water be the body we are reflecting? Two ways to say no,
    // both cheap and both decided per TILE rather than per fragment, because
    // the evidence — the tile's elevation range and how much of its texture the
    // OSM composite actually stamped — only exists at tile level.
    //
    //  (a) The tile's lowest point is above the water. Then whatever is blue on
    //      it is a stream, a river or a reservoir somewhere else entirely.
    //  (b) Barely any of it is water. A watercourse threading through a
    //      mountainside is a sliver of a tile; a shore is a substantial part.
    //
    // Unknowns are treated as "allowed": a tile whose bounds are not measured
    // yet, or whose texture came from an ancestor and so carries no match
    // count, keeps working exactly as it did before.
    tileWaterAllowed(tile, waterAlt) {
        const bounds = tile.altitudeBounds;
        if (bounds && bounds.measured && isFinite(bounds.min)
            && bounds.min > waterAlt + WATER_TILE_ALT_MARGIN_M) {
            return false;
        }
        const u = tile.mesh?.material?.uniforms?.map?.value?.userData;
        if (u && u.osmTotal > 0 && u.osmMatched !== undefined
            && u.osmMatched / u.osmTotal < WATER_TILE_MIN_FRACTION) {
            return false;
        }
        return true;
    }

    // Switch off water on tiles that cannot hold the reflected body, and hide
    // the skirts of the ones that can. One pass over the tiles, because both
    // decisions want the same per-tile facts.
    applyTileWaterGating(plane) {
        this.gatedTiles = [];
        this.gatedSkirts = new Set();
        if (plane === null || plane === undefined) return;
        const terrainNode = NodeMan.get("TerrainModel", false);
        const cache = terrainNode?.maps?.[terrainNode.UI?.mapType]?.map?.tileCache;
        if (!cache) return;
        const waterAlt = plane.altitude;
        for (const z in cache) {
            for (const x in cache[z]) {
                for (const y in cache[z][x]) {
                    const tile = cache[z][x][y];
                    const uniforms = tile.mesh?.material?.uniforms;
                    if (!uniforms?.tileWaterAllowed) continue;
                    if (this.tileWaterAllowed(tile, waterAlt)) continue;
                    uniforms.tileWaterAllowed.value = 0.0;
                    this.gatedTiles.push(uniforms.tileWaterAllowed);
                    // A tile with no reflectable water has no reason to lose
                    // its skirt either — that is what was opening seams in the
                    // hills. A Set rather than a flag on the mesh, so there is
                    // nothing left behind to clear.
                    if (tile.skirtMesh) this.gatedSkirts.add(tile.skirtMesh);
                }
            }
        }
    }

    restoreTileWaterGating() {
        if (!this.gatedTiles) return;
        for (const u of this.gatedTiles) u.value = 1.0;
        this.gatedTiles = undefined;
        this.gatedSkirts = undefined;
    }

    hideSkirts(plane) {
        this.hiddenSkirts = [];
        if (!this.mirrorHideSkirts) return;
        const terrainGroup = NodeMan.get("TerrainModel", false)?.getGroup?.();
        if (!terrainGroup) return;

        // Hide only the skirts that can actually reach the water. A skirt is
        // extruded a TENTH of its tile's width downwards, so what matters is
        // not how high the tile sits but how far its skirt hangs: a 16 km tile
        // on a 500 m ridge trails a 1.6 km wall that ends up a kilometre under
        // the sea, and shows up wherever the sightline passes over water that
        // has curved away. A small tile high on a hillside never reaches the
        // water at all, so it keeps covering its own LOD cracks — otherwise the
        // whole terrain loses its crack covers for the sake of the lake, and
        // seams open along ridgelines while the camera is subdividing.
        const waterAlt = plane ? plane.altitude + SKIRT_HIDE_MARGIN_M : null;

        terrainGroup.traverse((o) => {
            if (!o.userData.isTerrainSkirt || !o.visible) return;
            // Its tile has no reflectable water, so it has nothing to get out
            // of the way of — keep it, and keep its LOD cracks covered.
            if (this.gatedSkirts?.has(o)) return;
            if (waterAlt !== null) {
                const tile = o.userData.tile;
                const tileMesh = tile?.mesh;
                const sphere = tileMesh?.geometry?.boundingSphere;
                if (sphere && tile.size !== undefined) {
                    const c = this._skirtScratch ??= new Vector3();
                    c.copy(sphere.center).applyMatrix4(tileMesh.matrixWorld);
                    // buildSkirtGeometry() uses size * 0.1 for the drop.
                    const skirtBottom = altitudeHAE(c) - tile.size * 0.1;
                    if (skirtBottom > waterAlt) return;   // never gets near the water
                }
            }
            o.visible = false;
            this.hiddenSkirts.push(o);
        });
    }

    restoreSkirts() {
        if (!this.hiddenSkirts) return;
        for (const o of this.hiddenSkirts) o.visible = true;
        this.hiddenSkirts = undefined;
    }

    pop() {
        this.restoreSkirts();
        this.restoreTileWaterGating();
        this.clearUniforms();
    }
}
