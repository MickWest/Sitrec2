// TimelapsePreview.js
//
// Video > Long Exposure/Stacking > Preview Timelapse. While it is on, the trails
// that the long-exposure render would record — stars, planets and satellites,
// with satellite flares — are drawn as 3D lines in the scene, so the camera can
// be framed before the (slow) render is started.
//
// Positions are the render's: the same sample times, catalog, aberration,
// refraction and satellite apparent positions. Stars and planets are directions,
// drawn on the night-sky sphere (behind everything, so terrain hides them).
// Satellites are drawn at their apparent positions in the world scene, relative
// to the camera, so terrain in front of them hides them by the depth test and
// the main view shows their real paths.
//
// Brightness is the render's too. Each vertex carries the linear value the
// render's point spread would leave at the middle of the trail: source flux,
// extinction and tint, times the fraction of the energy that one pixel along the
// trail receives (a slow source keeps nearly all of it, a fast streak about
// 1/length). The line shader applies the same point spread ACROSS the trail, so
// a faint trail is a thin, dim line and a flare saturates into a wider one, and
// it blends by maximum, like a brightest-pixel stack. The value then goes
// through the look view's own tone curve, as the render's result window does.
//
// Each trail is drawn with a configurable number of straight segments (default
// 20). A satellite's segments cover only the part of its pass that is visible:
// from where it fades in, through the peak, to where it fades out.
//
// The lines are recalculated when the view has settled: the look camera, its
// lens and the exposure settings unchanged for SETTLE_MS. While the camera moves
// the old lines stay, since they are fixed in the world. The calculation runs in
// a pool of workers (TimelapsePreviewKernels.js, workers/TimelapsePreviewWorker.js),
// so it never blocks the camera, and only for what is in or near the view.
//
// Assumes the camera holds still for the exposure (the render's Lock Camera
// Heading, on by default): the camera position and heading are the current ones.

import {CustomBlending, MaxEquation, Vector3, Vector4} from "three";
import {LineSegments2} from "three/addons/lines/LineSegments2.js";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {LineMaterial} from "three/addons/lines/LineMaterial.js";
import * as Astronomy from "astronomy-engine";
import * as satellite from "satellite.js";
import {GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {CNode} from "./nodes/CNode";
import {GlobalNightSkyScene, GlobalScene} from "./LocalFrame";
import {bestSat, satRecToDate} from "./TLEUtils";
import {
    getAberrationVOverC, getEQJToECEFMatrix, getGeocentricBodyPositionECEF, raDec2Celestial,
} from "./CelestialMath";
import {REFRACTION_DEFAULTS, zenithECEFFromLatLon} from "./atmosphere/refraction";
import {excludeFromTerrestrialRefraction} from "./atmosphere/terrestrialRefraction";
import {
    fisheye, fisheyeUniforms, fisheyeViewToNDC, installFisheyeOnMaterial, isFisheyeCamera,
} from "./FisheyeProjection";
import {isPanoramicCamera, panoramic} from "./PanoramicCamera";
import {nudgeParams, nudgeQuaternion} from "./nodes/CNodeControllerCameraNudge";
import {altitudeHAE, getLocalUpVector} from "./SphericalMath";
import {withDisplayedCamera} from "./ViewUtils";
import {radians} from "./mathUtils";
import * as LAYER from "./LayerMasks";
import {
    exposureSampleOffsets, magnitudeFlux, observerExtinction, psfCentreFraction, psfRadiusPx, psfSigmaPx,
    starTintRGB,
} from "./ExposurePhotometry";
import {
    celestialTrail, computeSatelliteTrails, computeStarTrails, makeProjector, makeSink, packSink, prepareJob,
    skyDirection,
} from "./TimelapsePreviewKernels";

const NODE_ID = "timelapsePreview";
// Recalculate when the view has not changed for this long: camera moves are
// never slowed by a calculation.
const SETTLE_MS = 500;
// Satellites are propagated (SGP4) every COARSE_SECONDS of sitch time and
// interpolated between with a cubic through four points: well under a metre for
// a low orbit, against one call per render sample.
const COARSE_SECONDS = 20;
// At most this many samples per satellite pass. The render's own samples are
// used (Frame Step), thinned to this count for a very long or finely stepped
// exposure.
const MAX_SAT_SAMPLES = 1500;
// A trail is drawn where it reaches this linear value in its brightest pixel
// (about a 1-in-1000 signal, under one 8-bit code before gamma).
const VISIBLE_LINEAR = 1 / 1024;
// Star and planet trails get no segment shorter than this many pixels, up to
// Segments Per Trail. A star that moves 5 px needs no 20 segments.
const MIN_SKY_SEGMENT_PX = 4;
// Sources are calculated inside the view and this much around it, so a small
// pan shows trails at once. The view is recalculated when it settles.
const VIEW_MARGIN_RAD = radians(5);
const VIEW_MARGIN_FRACTION = 0.25;

export const timelapsePreview = {
    enabled: false,
    segments: 20,
    ev: 3,          // most night trails need about +3 EV to show
    stars: true,
    planets: true,
    satellites: true,
    hideLiveSky: true,
    status: "Off",
};
const P = timelapsePreview;

// ---------------------------------------------------------------------------
// Menu

export function setupTimelapsePreviewMenu(parent, manager) {
    const folder = parent.addFolder("Preview Timelapse").close().perm();
    const recalc = () => previewNode()?.requestUpdate();

    folder.add(P, "enabled").name("Preview Timelapse").perm().listen()
        .onChange((on) => setPreviewEnabled(on, manager))
        .tooltip("Draw the star, planet and satellite trails that Render Long Exposure/Stacking\n" +
            "will record, as lines in the 3D scene. Uses the settings above (Duration,\n" +
            "Capture Mode, Frame Step, Saturation Magnitude, ...). Move the look camera\n" +
            "freely: the trails are recalculated when the view settles.")
        .asFolderToggle();
    folder.add(P, "segments", 1, 200, 1).name("Segments Per Trail").perm().listen().onChange(recalc)
        .tooltip("Number of straight segments in each trail. A satellite's segments cover only\n" +
            "the visible part of its pass, from where it fades in to where it fades out,\n" +
            "spaced to follow the rise and fall of a flare.");
    folder.add(P, "ev", -6, 10, 0.1).name("Preview Exposure (EV)").perm().listen()
        .onChange(() => { setRenderOne(true); recalc(); })
        .tooltip("Exposure of the look view while the preview is on, in stops: the trails and\n" +
            "the scene, like the EV slider of the render's result window (which opens at +3).\n" +
            "Use the same value in both to compare them.");
    folder.add(P, "stars").name("Stars").perm().listen().onChange(recalc);
    folder.add(P, "planets").name("Planets").perm().listen().onChange(recalc);
    folder.add(P, "satellites").name("Satellites").perm().listen().onChange(recalc);
    folder.add(P, "hideLiveSky").name("Hide Live Sky").perm().listen().onChange(() => setRenderOne(true))
        .tooltip("In the look view, hide what the render hides: the star, planet and satellite\n" +
            "sprites and the sky chart lines (constellations, grid, flare region).");
    folder.add({recalc}, "recalc").name("Recalculate Now").perm()
        .tooltip("Recalculate the trails now, for a change the preview does not watch\n" +
            "(for example a new satellite filter).");
    folder.add(P, "status").name("Status").perm().listen().disable();
}

function previewNode() {
    return NodeMan.exists(NODE_ID) ? NodeMan.get(NODE_ID) : null;
}

function setPreviewEnabled(on, manager) {
    const node = previewNode();
    if (on && !node) {
        if (!NodeMan.exists("lookView") || !NodeMan.exists("NightSkyNode")) {
            P.enabled = false;
            P.status = "Needs a look view and a night sky";
            return;
        }
        new CNodeTimelapsePreview({id: NODE_ID, manager});
    } else if (!on && node) {
        NodeMan.disposeRemove(NODE_ID);
    }
    setRenderOne(true);
}

// ---------------------------------------------------------------------------
// Trail material: Three's fat line, with the render's point spread across it

const TRAIL_FRAGMENT_FUNCTIONS = /* glsl */`
uniform float uTrailHalfWidth;
uniform float uTrailInvSigma;
uniform float uTrailGain;
uniform float uTrailLinearOut;
uniform float uTrailExposure;

float trailErf(float x) {
    float s = sign(x);
    x = abs(x);
    float t = 1.0 / (1.0 + 0.3275911 * x);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) * t * exp(-x * x);
    return s * y;
}

// LongExposure.js softClip: linear to 0.7, then a Reinhard-style shoulder.
float trailSoftClip(float x) {
    if (x <= 0.7) return x;
    float t = (x - 0.7) / 0.3;
    return 0.7 + 0.3 * (t / (1.0 + t));
}

void main() {`;

const TRAIL_FRAGMENT_OUTPUT = /* glsl */`
    // Distance of this pixel's centre from the trail's centre line, in pixels
    // (vUv.x is -1..1 across the line; beyond |vUv.y| = 1 is the round end cap).
    float trailCap = abs( vUv.y ) > 1.0 ? abs( vUv.y ) - 1.0 : 0.0;
    float trailD = length( vec2( vUv.x, trailCap ) ) * uTrailHalfWidth;
    if ( trailD > uTrailHalfWidth ) discard;
    // The fraction of the source's energy this pixel receives across the trail:
    // the Gaussian point spread integrated over the pixel, as the render's splat.
    float trailProfile = 0.5 * ( trailErf( ( trailD + 0.5 ) * uTrailInvSigma )
        - trailErf( ( trailD - 0.5 ) * uTrailInvSigma ) );
    vec3 trailLinear = max( diffuseColor.rgb, vec3( 0.0 ) ) * trailProfile * uTrailGain;
    // Tone-mapped view: write scene-linear light and let the view's tone mapping
    // finish it. Otherwise apply the render's highlight shoulder here, divided by
    // the exposure the view will multiply in.
    vec3 trailOut = uTrailLinearOut > 0.5 ? trailLinear
        : vec3( trailSoftClip( trailLinear.r ), trailSoftClip( trailLinear.g ), trailSoftClip( trailLinear.b ) )
            / uTrailExposure;
    gl_FragColor = vec4( trailOut, clamp( max( max( trailOut.r, trailOut.g ), trailOut.b ), 0.0, 1.0 ) );`;

class TrailLineMaterial extends LineMaterial {
    constructor({depthTest}) {
        super({vertexColors: true, transparent: true, depthWrite: false, depthTest, toneMapped: false});
        this.isTrailLineMaterial = true;
        // Maximum, not sum: a brightest-pixel stack keeps the brightest value of
        // each pixel, and the segments' overlapping round ends must not add up.
        this.blending = CustomBlending;
        this.blendEquation = MaxEquation;
        this.blendEquationAlpha = MaxEquation;
        // No aerial-perspective haze (MaterialAtmosphere.js): the render adds its
        // splats after the haze, and their extinction is already in the vertex
        // values. With haze, a distant satellite's segment is replaced by the
        // airlight colour over its whole width.
        this.userData.atmosphere = false;
        Object.assign(this.uniforms, {
            uTrailHalfWidth: {value: 2.5},
            uTrailInvSigma: {value: 1},
            uTrailGain: {value: 1},
            uTrailLinearOut: {value: 0},
            uTrailExposure: {value: 1},
        });
        const output = "gl_FragColor = vec4( diffuseColor.rgb, alpha );";
        if (!this.fragmentShader.includes(output) || !this.fragmentShader.includes("void main() {")) {
            throw new Error("TimelapsePreview: LineMaterial fragment shader has changed");
        }
        this.fragmentShader = this.fragmentShader
            .replace("void main() {", TRAIL_FRAGMENT_FUNCTIONS)
            .replace(output, TRAIL_FRAGMENT_OUTPUT);
    }

    // The kernel and the point spread follow the render's Point Spread setting.
    setSpread(psfSigma) {
        const half = psfRadiusPx(psfSigma) + 0.5;
        this.uniforms.uTrailHalfWidth.value = half;
        this.uniforms.uTrailInvSigma.value = 1 / (Math.SQRT2 * psfSigmaPx(psfSigma));
        this.linewidth = 2 * half;
    }
}

// ---------------------------------------------------------------------------
// The preview node

const _viewport = new Vector4();

class CNodeTimelapsePreview extends CNode {
    constructor(v) {
        super(v);
        this.manager = v.manager;
        this.skipModSerialize = true;     // a viewing aid, created from the menu
        this.lookView = NodeMan.get("lookView");

        this.skyMaterial = new TrailLineMaterial({depthTest: false});
        this.worldMaterial = new TrailLineMaterial({depthTest: true});
        this.skyLines = this.makeLines(this.skyMaterial);
        this.satLines = this.makeLines(this.worldMaterial);
        this.skyCount = 0;
        this.satCount = 0;
        GlobalNightSkyScene?.add(this.skyLines);
        GlobalScene.add(this.satLines);
        // Satellite positions are already the refracted, apparent ones.
        excludeFromTerrestrialRefraction(this.satLines);

        this.hidden = [];
        this.signature = null;        // of the state the lines were built from
        this.pendingSignature = null; // of the state being waited on
        this.forceUpdate = false;
        this.timer = null;
        this.generation = 0;
        this.requestUpdate();
    }

    makeLines(material) {
        installFisheyeOnMaterial(material);
        const lines = new LineSegments2(new LineSegmentsGeometry(), material);
        lines.frustumCulled = false;
        lines.layers.mask = LAYER.MASK_WORLD;
        lines.visible = false;
        lines.onBeforeRender = (renderer, scene, camera) => this.beforeLinesRender(renderer, camera, material);
        return lines;
    }

    // Per view: the line width is in the pixels of the target being drawn, and the
    // tone curve is the view's.
    // In the look view the Preview Exposure is already in the view's exposure
    // (see preRender), which a tone-mapped view applies to the trails too.
    beforeLinesRender(renderer, camera, material) {
        renderer.getCurrentViewport(_viewport);
        material.resolution.set(_viewport.z, _viewport.w);
        const policy = camera === this.lookView?.camera ? this.lookView.getColorPolicy() : null;
        const u = material.uniforms;
        u.uTrailLinearOut.value = policy?.toneMapping ? 1 : 0;
        u.uTrailExposure.value = policy?.active ? Math.max(1e-6, policy.exposure) : 1;
        u.uTrailGain.value = policy?.toneMapping ? 1 : Math.pow(2, P.ev);
        material.uniformsNeedUpdate = true;
    }

    rendering() {
        return !!Globals.scriptedVideoRendering || !!this.manager?.rendering;
    }

    preRender(view) {
        // Never in the render's own frames or its occlusion mask.
        const show = !this.rendering();
        this.skyLines.visible = show && this.skyCount > 0;
        this.satLines.visible = show && this.satCount > 0;
        if (!show || view !== this.lookView) return;
        this.checkForChange();
        if (P.hideLiveSky) this.hideLiveSky();
        // The render's result window applies its EV to the whole picture, the
        // landscape and the sky glow too: do the same to the look view, for this
        // render only.
        this.restoreViewExposure();   // in case a render failed before postRender
        if (P.ev !== 0 && Number.isFinite(view.viewExposure)) {
            this.exposureBase = view.viewExposure;
            view.viewExposure = this.exposureBase * Math.pow(2, P.ev);
        }
    }

    postRender() {
        this.restoreLiveSky();
        this.restoreViewExposure();
    }

    restoreViewExposure() {
        if (this.exposureBase === undefined) return;
        this.lookView.viewExposure = this.exposureBase;
        this.exposureBase = undefined;
    }

    // Hide, for one look-view render, what the long-exposure render hides.
    hideLiveSky() {
        const sky = NodeMan.get("NightSkyNode", false);
        if (!sky) return;
        const objects = [];
        for (const cloud of [sky.starField?.lightCloud, sky.satellites?.lightCloud]) {
            if (cloud) objects.push(cloud.points, cloud.mainViewPoints);
        }
        for (const [name, ps] of Object.entries(sky.planets?.planetSprites ?? {})) {
            if (name !== "Moon" && name !== "Sun") objects.push(ps.sprite, ps.daySkySprite);
        }
        objects.push(sky.constellationsGroup, sky.equatorialSphereGroup, sky.sunArrowGroup,
            sky.flareRegionGroup, sky.flareBandGroup, sky.satelliteTrackGroup,
            sky.satelliteFlareTracksGroup, sky.satelliteGroundGroup);
        for (const object of objects) {
            if (object?.visible) {
                object.visible = false;
                this.hidden.push(object);
            }
        }
    }

    restoreLiveSky() {
        for (const object of this.hidden) object.visible = true;
        this.hidden.length = 0;
    }

    // ---- settle, then recalculate ----

    requestUpdate() {
        this.forceUpdate = true;
        this.pendingSignature = null;
        this.scheduleSettle();
    }

    checkForChange() {
        const signature = this.computeSignature();
        if (signature === this.pendingSignature) return;
        this.pendingSignature = signature;
        if (signature === this.signature && !this.forceUpdate) {
            // back where the lines were built: nothing to do
            clearTimeout(this.timer);
            this.timer = null;
            P.status = this.builtStatus ?? P.status;
            return;
        }
        this.scheduleSettle();
    }

    scheduleSettle() {
        clearTimeout(this.timer);
        P.status = "Waiting for the view to settle…";
        this.timer = setTimeout(() => this.onSettled(), SETTLE_MS);
    }

    onSettled() {
        this.timer = null;
        if (this.rendering()) {
            this.scheduleSettle();
            return;
        }
        const signature = this.computeSignature();
        if (signature !== this.pendingSignature) {
            // still moving
            this.pendingSignature = signature;
            this.scheduleSettle();
            return;
        }
        this.forceUpdate = false;
        this.recompute(signature).catch((e) => {
            console.error("Preview Timelapse failed:", e);
            P.status = "Failed: " + (e.message || e);
        });
    }

    // Everything the trails depend on. The camera is taken without the live
    // Camera Nudge offset, so playing the sitch with a nudge does not count as a move.
    computeSignature() {
        const camera = this.lookView.camera;
        const LP = this.manager.params;
        const ctx = this.drawnCamera();
        const r = (x, d) => Number.isFinite(x) ? x.toFixed(d) : String(x);
        const sky = NodeMan.get("NightSkyNode", false);
        const sats = sky?.satellites;
        const fish = fisheyeUniforms;
        // The PTZ angles change at once on a mouse move, before the camera takes them
        // up in its next update; so a move during a busy frame still counts.
        const ptz = NodeMan.get("ptzAngles", false);
        return [
            ptz?.az, ptz?.el, ptz?.fov, ptz?.roll,
            r(camera.position.x, 2), r(camera.position.y, 2), r(camera.position.z, 2),
            r(ctx.qBase.x, 7), r(ctx.qBase.y, 7), r(ctx.qBase.z, 7), r(ctx.qBase.w, 7),
            r(ctx.proj[0], 7), r(ctx.proj[5], 7), r(ctx.proj[8], 7), r(ctx.proj[9], 7),
            this.lookView.canvas.width, this.lookView.canvas.height, ctx.lensMode,
            fish.uFishType.value, r(fish.uFishK.value, 5), r(fish.uFishRhoEdge.value, 6),
            r(fish.uFishScaleY.value, 6), r(fish.uFishAspect.value, 6), r(fish.uFishRoll.value, 6),
            r(fish.uFishCenter.value.x, 6), r(fish.uFishCenter.value.y, 6),
            panoramic.hfov, panoramic.vfov,
            LP.durationMin, LP.captureMode, LP.stackExposureSeconds, LP.step, LP.satMag, LP.extinctionK,
            LP.reddening, LP.starTint, LP.psfSigma, JSON.stringify(nudgeParams),
            P.segments, P.ev, P.stars, P.planets, P.satellites,
            Sit.refractionEnabled, Sit.refractionPressure, Sit.refractionTemp, Sit.fps, Sit.simSpeed,
            GlobalDateTimeNode?.getStartTimeValue(),
            sats?.TLEData?.satData?.length, sats?.showSatellites, sats?.brightnessModel, sats?.flareAngle,
            sats?.starlinkProfile, sats?.illuminationModel, sats?.flareModel, sats?.penumbraDepth,
            Globals.equatorRadius, Globals.polarRadius,
        ].join("|");
    }

    // The camera as the look view draws it (video pan, coverage widening and the
    // other display-only terms included, as LongExposure's sample loop), and the
    // heading with the live nudge taken off.
    drawnCamera() {
        const lookView = this.lookView, camera = lookView.camera;
        const lensMode = isPanoramicCamera(camera) ? "panorama" : isFisheyeCamera(camera) ? "fisheye" : "pinhole";
        const drawn = lensMode === "panorama"
            ? {q: camera.quaternion.clone(), proj: camera.projectionMatrix.elements.slice()}
            : withDisplayedCamera(lookView, cam => ({
                q: cam.quaternion.clone(), proj: cam.projectionMatrix.elements.slice()}));
        const fps = Sit.fps || 30;
        const nqNow = nudgeQuaternion((par.frame ?? 0) / fps);
        const qBase = nqNow ? drawn.q.clone().multiply(nqNow.clone().invert()) : drawn.q.clone();
        return {lensMode, q: drawn.q, proj: drawn.proj, qBase};
    }

    // ---- the calculation ----

    // One calculation at a time. A settle during one runs again when it ends.
    async recompute(signature) {
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = true;
        try {
            await this.runJob(signature);
            while (this.rerun && !this.disposed) {
                this.rerun = false;
                await this.runJob(this.computeSignature());
            }
        } finally {
            this.running = false;
        }
    }

    async runJob(signature) {
        const generation = ++this.generation;
        const started = performance.now();
        P.status = "Calculating…";
        const ctx = this.buildContext();
        const counts = {stars: 0, planets: 0, satellites: 0};
        const skyParts = [], worldParts = [];
        let satStats = null;
        if (!ctx.daylight) {
            const job = this.buildJob(ctx);
            const local = prepareJob({...job});
            if (P.planets) {
                const sink = makeSink();
                counts.planets = this.addPlanets(ctx, local, sink);
                skyParts.push(packSink(sink));
            }
            const satellites = P.satellites ? this.selectSatellites(ctx) : [];
            const catalog = P.stars ? this.starCatalog(ctx) : null;
            const mainMs = performance.now() - started;
            const results = await this.runKernels(job, local, catalog, satellites);
            if (generation !== this.generation || this.disposed) return;
            // The camera moved while the workers ran: these trails are for the old
            // view. Keep showing the old lines; the next pause recalculates.
            if (this.computeSignature() !== signature) {
                this.discarded = (this.discarded ?? 0) + 1;
                return;
            }
            // for tuning: main-thread preparation, and the slowest worker
            this.lastTiming = {mainMs: Math.round(mainMs), workers: results.length,
                slowestWorkerMs: Math.round(Math.max(...results.map(r => r.ms ?? 0))),
                slowestStarsMs: Math.round(Math.max(...results.map(r => r.starsMs ?? 0)))};
            for (const r of results) {
                counts.stars += r.starsDrawn;
                skyParts.push(r.sky);
                worldParts.push(r.world);
                if (r.satStats) {
                    satStats ??= {candidates: 0, near: 0, active: 0, fineSamples: 0, drawn: 0};
                    for (const k of Object.keys(satStats)) satStats[k] += r.satStats[k];
                }
            }
            counts.satellites = satStats?.drawn ?? 0;
        }
        this.lastSatStats = satStats;
        this.skyMaterial.setSpread(ctx.LP.psfSigma);
        this.worldMaterial.setSpread(ctx.LP.psfSigma);
        this.skyCount = setLineSegments(this.skyLines, skyParts);
        this.satLines.position.copy(ctx.camPos);
        this.satLines.updateMatrixWorld(true);
        this.satCount = setLineSegments(this.satLines, worldParts);
        this.signature = signature;
        const ms = Math.round(performance.now() - started);
        this.builtStatus = ctx.daylight ? "Daylight: the render records no sky sources"
            : `${counts.stars} stars, ${counts.planets} planets, ${counts.satellites} satellites (${ms} ms)`;
        if (!this.timer) P.status = this.builtStatus;
        setRenderOne(true);
    }

    // The stars and satellites, split over the workers, or here without them.
    async runKernels(job, local, catalog, satellites) {
        const pool = getPool();
        if (!pool) {
            const sky = makeSink(), world = makeSink();
            const starsDrawn = catalog ? computeStarTrails(local, catalog, 0, 1, sky) : 0;
            const satStats = satellites.length ? computeSatelliteTrails(local, satellites, world) : null;
            return [{sky: packSink(sky), world: packSink(world), starsDrawn, satStats}];
        }
        return pool.run(job, catalog, satellites);
    }

    buildContext() {
        const lookView = this.lookView, camera = lookView.camera;
        const LP = this.manager.params;
        const fps = Sit.fps || 30;
        const simSpeed = Sit.simSpeed > 0 && Number.isFinite(Sit.simSpeed) ? Sit.simSpeed : 1;
        const durationSeconds = Math.max(0.001, (LP.durationMin ?? 5) * 60);
        const numFrames = durationSeconds * fps / simSpeed;
        const stackMode = LP.captureMode === "Brightest-pixel stack";
        const stackSeconds = Number.isFinite(LP.stackExposureSeconds) && LP.stackExposureSeconds > 0
            ? LP.stackExposureSeconds : 10;
        const step = Math.max(1, Math.round(LP.step || 1));
        const sampleOffsets = exposureSampleOffsets({numFrames, step, stackMode,
            stackFrames: stackSeconds * fps / simSpeed});

        const drawn = this.drawnCamera();
        const W = lookView.canvas.width, H = lookView.canvas.height;
        const aspect = camera.aspect > 0 ? camera.aspect : W / H;
        const camPos = camera.position.clone();
        const nightSky = NodeMan.get("NightSkyNode");
        const observer = nightSky.getObserverFromCameraPos(camPos);
        const camAltM = Math.max(0, altitudeHAE(camPos));
        const {kAltScale, horizonSin} = observerExtinction(camAltM);

        // pixels per radian at the image centre, for directions the lens does not
        // image, and the largest angle from the view axis that the image shows
        let pxPerRad, halfField, fisheyeState = null;
        if (drawn.lensMode === "fisheye") {
            fisheyeViewToNDC(new Vector3(0, 0, -1), aspect);   // brings the uniforms up to date
            const u = fisheyeUniforms;
            pxPerRad = u.uFishScaleY.value * H / (2 * u.uFishRhoEdge.value);
            halfField = u.uFishCullTheta.value;
            fisheyeState = {
                lensType: fisheye.lensType, curveK: fisheye.curveK, rhoEdge: u.uFishRhoEdge.value,
                circleScale: fisheye.circlePct / 100, centerX: fisheye.centerX / 100, centerY: fisheye.centerY / 100,
                roll: radians(fisheye.roll), maxTheta: u.uFishMaxTheta.value, cullTheta: u.uFishCullTheta.value,
                showCircle: !!fisheye.showCircle,
            };
        } else if (drawn.lensMode === "panorama") {
            pxPerRad = H / radians(panoramic.vfov);
            const hx = radians(panoramic.hfov) / 2, hy = radians(panoramic.vfov) / 2;
            halfField = Math.max(Math.acos(Math.cos(hx) * Math.cos(hy)), hx);
        } else {
            const e = drawn.proj;
            pxPerRad = e[5] * H / 2;
            // a video pan moves the image centre off the axis (elements 8 and 9)
            halfField = Math.atan(Math.hypot((1 + Math.abs(e[8])) / e[0], (1 + Math.abs(e[9])) / e[5]));
        }

        return {
            LP, fps, simSpeed, durationSeconds, numFrames, sampleOffsets,
            camera, camPos, observer, nightSky, drawn, W, H, aspect, pxPerRad, fisheyeState,
            coneAngle: Math.min(Math.PI, halfField + Math.max(VIEW_MARGIN_RAD, VIEW_MARGIN_FRACTION * halfField)),
            axis: new Vector3(0, 0, -1).applyQuaternion(drawn.q),
            up: getLocalUpVector(camPos),
            kAltScale, horizonSin,
            daylight: (NodeMan.get("theSun", false)?.skyOpacity ?? 0) >= 1,
        };
    }

    // With the Camera Nudge on, the render's camera turns during the exposure.
    // This rotation carries a world vector seen at frame f to where the current
    // camera would show that image point. Null when the nudge is off.
    nudgeRotation(ctx, f) {
        if (!nudgeParams.enabled) return null;
        const nq = nudgeQuaternion(f / ctx.fps);
        const qAt = nq ? ctx.drawn.qBase.clone().multiply(nq) : ctx.drawn.qBase.clone();
        return ctx.drawn.q.clone().multiply(qAt.invert());
    }

    // Everything the kernels need, as plain data a worker can receive.
    buildJob(ctx) {
        const LP = ctx.LP;
        const refractOn = Sit.refractionEnabled !== undefined ? !!Sit.refractionEnabled : REFRACTION_DEFAULTS.enabled;
        const pressureHPa = Sit.refractionPressure ?? REFRACTION_DEFAULTS.pressureHPa;
        const tempC = Sit.refractionTemp ?? REFRACTION_DEFAULTS.tempC;
        const segments = Math.max(1, Math.round(P.segments));
        const sats = ctx.nightSky.satellites;

        // Camera Nudge rotations at the sky vertices of every segment count
        let skyRotations = null;
        if (nudgeParams.enabled) {
            skyRotations = {};
            for (let n = 1; n <= segments; n++) {
                const table = new Array((n + 1) * 4);
                for (let k = 0; k <= n; k++) this.nudgeRotation(ctx, ctx.numFrames * k / n).toArray(table, k * 4);
                skyRotations[n] = table;
            }
        }

        // satellite samples: the render's own, thinned for a very long exposure
        const offsets = ctx.sampleOffsets;
        const stride = Math.max(1, Math.ceil(offsets.length / MAX_SAT_SAMPLES));
        const fineFrames = [];
        for (let s = 0; s < offsets.length; s += stride) fineFrames.push(offsets[s]);
        if (fineFrames.at(-1) !== offsets.at(-1)) fineFrames.push(offsets.at(-1));
        const sunAt = (date, out, i) => getGeocentricBodyPositionECEF(Astronomy.Body.Sun, date, true).normalize().toArray(out, i * 3);
        const fineTimes = fineFrames.map(f => f / ctx.fps * ctx.simSpeed);
        const fineMS = fineFrames.map(f => GlobalDateTimeNode.frameToMS(f));
        const fineSun = new Array(fineFrames.length * 3);
        fineMS.forEach((ms, m) => sunAt(new Date(ms), fineSun, m));
        let satRotations = null;
        if (nudgeParams.enabled) {
            satRotations = new Array(fineFrames.length * 4);
            fineFrames.forEach((f, m) => this.nudgeRotation(ctx, f).toArray(satRotations, m * 4));
        }
        // coarse SGP4 grid, one point either side of the exposure for the cubic
        const coarseFrames = COARSE_SECONDS * ctx.fps / ctx.simSpeed;
        const nCoarse = Math.max(1, Math.ceil(ctx.durationSeconds / COARSE_SECONDS)) + 4;
        const coarseMS = [], coarseSun = new Array(nCoarse * 3);
        for (let j = 0; j < nCoarse; j++) {
            const date = GlobalDateTimeNode.frameToDate((j - 1) * coarseFrames);
            coarseMS.push(date.getTime());
            sunAt(date, coarseSun, j);
        }

        return {
            durationSeconds: ctx.durationSeconds, segments, minSkySegmentPx: MIN_SKY_SEGMENT_PX,
            skyRadius: ctx.nightSky.starField?.sphereRadius ?? 100,
            m0: Array.from(getEQJToECEFMatrix(GlobalDateTimeNode.frameToDate(0)).elements),
            earthRate: EARTH_SIDEREAL_RATE,
            skyRotations,
            camPos: ctx.camPos.toArray(), up: ctx.up.toArray(), axis: ctx.axis.toArray(),
            coneAngle: ctx.coneAngle, horizonSin: ctx.horizonSin,
            projection: {
                lensMode: ctx.drawn.lensMode, e: ctx.drawn.proj, qInv: ctx.drawn.q.clone().invert().toArray(),
                W: ctx.W, H: ctx.H, aspect: ctx.aspect, pxPerRad: ctx.pxPerRad, fisheye: ctx.fisheyeState,
                panorama: {hfov: panoramic.hfov, vfov: panoramic.vfov},
            },
            satMag: LP.satMag, extinctionK: LP.extinctionK, kAltScale: ctx.kAltScale, reddening: !!LP.reddening,
            tint: starTintRGB(LP.starTint), psfSigma: LP.psfSigma,
            // a moving source's energy is spread over the path it covers in one exposure window
            windowSeconds: LP.captureMode === "Brightest-pixel stack"
                ? Math.min(LP.stackExposureSeconds > 0 ? LP.stackExposureSeconds : 10, ctx.durationSeconds)
                : ctx.durationSeconds,
            centre: psfCentreFraction(LP.psfSigma), gain: Math.pow(2, P.ev),
            visibleBright: Math.sqrt(VISIBLE_LINEAR / (1 + VISIBLE_LINEAR)),
            zenith: zenithECEFFromLatLon(radians(ctx.observer.latitude), radians(ctx.observer.longitude), new Vector3()).toArray(),
            skyRefraction: {enabled: refractOn, pressureHPa, tempC,
                observerHeight: ctx.observer.height, earthRadius: ctx.camPos.length() - ctx.observer.height},
            // Aberration at the render's start instant, as the render does.
            aberration: getAberrationVOverC(GlobalDateTimeNode.dateNow).toArray(),
            satRefraction: {enabled: refractOn, pressureHPa, tempC,
                equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius},
            satSettings: sats?.brightnessSettings?.() ?? null,
            coarseSeconds: COARSE_SECONDS, coarseMS, coarseSun, fineTimes, fineMS, fineSun, satRotations,
            filterTimesMS: sats?.tleFilterFrameData?.sampleTimesMS ?? null,
        };
    }

    // Planets, here: a handful of trails. A planet moves slowly against the
    // stars: its direction at the start and end of the exposure, interpolated.
    addPlanets(ctx, job, sink) {
        const sprites = ctx.nightSky.planets?.planetSprites;
        if (!sprites) return 0;
        const project = makeProjector(job.projection);
        const startDate = GlobalDateTimeNode.frameToDate(0);
        const endDate = GlobalDateTimeNode.frameToDate(ctx.numFrames);
        const a = new Vector3(), b = new Vector3(), eq = new Vector3();
        const eqAt = (name, date, out) => {
            const e = Astronomy.Equator(name, date, ctx.observer, false, true);
            return out.copy(raDec2Celestial(e.ra / 24 * 2 * Math.PI, radians(e.dec), 1));
        };
        let drawn = 0;
        for (const [name, ps] of Object.entries(sprites)) {
            if (name === "Moon" || name === "Sun" || ps.mag === undefined) continue;
            // White: the display sprites are color-coded, but photometrically
            // planets are near-white point sources.
            const flux = magnitudeFlux(ps.mag, ctx.LP.satMag);
            if (flux < 1e-5) continue;
            eqAt(name, startDate, a);
            eqAt(name, endDate, b);
            const dirAt = (seconds, out) =>
                skyDirection(job, eq.lerpVectors(a, b, seconds / job.durationSeconds).normalize(), seconds, out);
            if (celestialTrail(job, project, dirAt, flux, [1, 1, 1], sink)) drawn++;
        }
        return drawn;
    }

    // The star catalog, as the arrays the kernels read.
    starCatalog(ctx) {
        const starField = ctx.nightSky.starField;
        const count = starField?.BSC_NumStars || 0;
        if (!count) return null;
        if (this.catalogSource !== starField.BSC_RA || this.catalog?.count !== count) {
            this.catalogSource = starField.BSC_RA;
            this.catalog = {
                count,
                ra: Float64Array.from(starField.BSC_RA.slice(0, count)),
                dec: Float64Array.from(starField.BSC_DEC.slice(0, count)),
                mag: Float64Array.from(starField.BSC_MAG.slice(0, count)),
            };
        }
        return this.catalog;
    }

    // The satellites that can be up during the exposure, with the orbit record
    // for its middle. Cheap tests only: the distance from the current position,
    // the record's age, and the orbit plane. The workers do the rest.
    selectSatellites(ctx) {
        const sats = ctx.nightSky.satellites;
        const satData = sats?.TLEData?.satData;
        if (!satData || sats.showSatellites === false) return [];
        const startDate = GlobalDateTimeNode.frameToDate(0);
        const midDate = GlobalDateTimeNode.frameToDate(ctx.numFrames / 2);
        const endDate = GlobalDateTimeNode.frameToDate(ctx.numFrames);
        // Distance cull from the current positions: no farther than the horizon
        // range plus the distance an orbit covers between now and the exposure.
        const nowMS = GlobalDateTimeNode.dateNow?.getTime?.() ?? startDate.getTime();
        const reachSeconds = Math.max(Math.abs(startDate.getTime() - nowMS), Math.abs(endDate.getTime() - nowMS)) / 1000;
        const earthR = 6371000;
        const camHorizon = Math.sqrt(2 * earthR * Math.max(0, altitudeHAE(ctx.camPos)));
        // The observer's direction from the Earth's centre in the orbit elements'
        // TEME frame, at the start, middle and end. It turns with the Earth, by at
        // most a quarter of the exposure's turn from the nearest of the three.
        const planeDates = [startDate, midDate, endDate];
        const observerTEME = planeDates.map(d => {
            const g = satellite.gstime(d), o = ctx.camPos.clone().normalize();
            return new Vector3(o.x * Math.cos(g) - o.y * Math.sin(g), o.x * Math.sin(g) + o.y * Math.cos(g), o.z);
        });
        // plus the observer's own horizon reach (an aircraft or a spacecraft sees farther)
        const planeAllowance = EARTH_SIDEREAL_RATE * ctx.durationSeconds / 4 + radians(5)
            + Math.acos(Math.min(1, SGP4_EARTH_RADIUS_M / ctx.camPos.length()));
        const perSat = sats.tleFilterFrameData?.perSat;

        const list = [];
        for (let i = 0; i < satData.length; i++) {
            const sd = satData[i];
            if (!sd || !sd.visible || sd.hiddenInLookView || !sd.satrecs?.length) continue;
            const filter = perSat?.[i];
            if (filter === "off") continue;
            if (sd.ecef && !sd.invalidPosition) {
                const r = sd.ecef.length();
                const range = Math.sqrt(Math.max(0, r * r - earthR * earthR)) + camHorizon + 300000;
                if (sd.ecef.distanceTo(ctx.camPos) > range + 8000 * reachSeconds) continue;
            }
            const satrec = bestSat(sd.satrecs, midDate);
            const epochMS = satRecToDate(satrec).getTime();
            if (Math.abs(midDate.getTime() - epochMS) > 90 * 86400000) continue;
            if (farFromOrbitPlane(satrec, epochMS, planeDates, observerTEME, planeAllowance)) continue;
            list.push({index: i, key: `${i}:${sd.satrecs.indexOf(satrec)}`, satrec, name: sd.name, number: sd.number,
                filter: Array.isArray(filter) ? filter : undefined});
        }
        return list;
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.timer);
        this.timer = null;
        this.generation++;
        this.restoreLiveSky();
        this.restoreViewExposure();
        for (const lines of [this.skyLines, this.satLines]) {
            lines.parent?.remove(lines);
            lines.geometry.dispose();
        }
        this.skyMaterial.dispose();
        this.worldMaterial.dispose();
        terminatePool();
        P.enabled = false;
        P.status = "Off";
        super.dispose();
    }
}

// The Earth's turn against the stars: the rate of Greenwich apparent sidereal
// time, radians per second.
const EARTH_SIDEREAL_RATE = 7.2921158553e-5;
const SGP4_EARTH_RADIUS_M = 6378135;   // the unit of satrec.a

// A satellite is only above an observer's horizon when the observer is within
// arccos(R / r) of the point under it, so the observer must come that close to the
// orbit's plane. A cheap test, made before any SGP4 call, from the plane's tilt
// and node (with its drift) and the orbit's highest radius. True when the
// observer stays farther than that, plus `allowance`, all through the exposure.
// Never true for elements it cannot read.
function farFromOrbitPlane(satrec, epochMS, dates, observers, allowance) {
    const {inclo, nodeo, nodedot, a, ecco} = satrec;
    if (![inclo, nodeo, nodedot, a, ecco].every(Number.isFinite) || !(a > 0)) return false;
    const apogee = a * (1 + ecco);
    if (apogee <= 1) return false;
    const reach = Math.acos(1 / apogee) + allowance;
    if (reach >= Math.PI / 2) return false;
    const si = Math.sin(inclo), ci = Math.cos(inclo);
    for (let k = 0; k < dates.length; k++) {
        const node = nodeo + nodedot * (dates[k].getTime() - epochMS) / 60000;
        const o = observers[k];
        const offPlane = Math.asin(Math.min(1, Math.abs(si * Math.sin(node) * o.x - si * Math.cos(node) * o.y + ci * o.z)));
        if (offPlane < reach) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// The worker pool. One worker per core but one, up to MAX_WORKERS. Each keeps the star
// catalog and the orbit records of its satellites (assigned by index), so a
// recalculation sends only the job. Kept while the preview is on.

let pool = null;
const MAX_WORKERS = 12;

function getPool() {
    if (pool) return pool;
    if (typeof Worker === "undefined") return null;
    try {
        pool = new CPreviewPool();
    } catch (e) {
        console.warn("Preview Timelapse: no workers, calculating on the main thread", e);
        pool = null;
    }
    return pool;
}

function terminatePool() {
    pool?.terminate();
    pool = null;
}

class CPreviewPool {
    constructor() {
        const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
        this.slots = [];
        for (let i = 0, n = Math.max(1, Math.min(MAX_WORKERS, cores - 1)); i < n; i++) this.slots.push(this.makeSlot());
        this.catalog = null;
        this.satrecVersion = 0;
        this.tleData = null;
        this.gen = 0;
    }

    makeSlot() {
        const slot = {w: new Worker(new URL("./workers/TimelapsePreviewWorker.js", import.meta.url)),
            known: new Set(), resolve: null, reject: null};
        slot.w.onmessage = (e) => {
            const done = slot.resolve, fail = slot.reject;
            if (e.data?.gen !== this.gen) return;   // a superseded job
            slot.resolve = slot.reject = null;
            if (e.data.type === "error") fail?.(new Error(`timelapse preview worker: ${e.data.message}`));
            else done?.(e.data);
        };
        slot.w.onerror = (err) => {
            const fail = slot.reject;
            slot.resolve = slot.reject = null;
            fail?.(err instanceof Error ? err : new Error(String(err?.message || err)));
        };
        return slot;
    }

    async run(job, catalog, satellites) {
        const gen = ++this.gen;
        const n = this.slots.length;
        if (catalog && this.catalog !== catalog) {
            this.catalog = catalog;
            for (const slot of this.slots) slot.w.postMessage({type: "catalog", catalog});
        }
        const tleData = NodeMan.get("NightSkyNode", false)?.satellites?.TLEData ?? null;
        if (tleData !== this.tleData) {
            this.tleData = tleData;
            this.satrecVersion++;
            for (const slot of this.slots) slot.known.clear();
        }
        // each satellite to the worker that owns its index
        const shares = this.slots.map(() => ({sats: [], entries: []}));
        for (const sat of satellites) {
            const k = sat.index % n, slot = this.slots[k];
            shares[k].sats.push({key: sat.key, filter: sat.filter});
            if (!slot.known.has(sat.key)) {
                slot.known.add(sat.key);
                shares[k].entries.push({key: sat.key, satrec: sat.satrec, name: sat.name, number: sat.number});
            }
        }
        return Promise.all(this.slots.map((slot, k) => new Promise((resolve, reject) => {
            if (shares[k].entries.length) {
                slot.w.postMessage({type: "satrecs", version: this.satrecVersion, entries: shares[k].entries});
            }
            slot.resolve = resolve;
            slot.reject = reject;
            slot.w.postMessage({type: "job", gen, job, stars: catalog ? {offset: k, stride: n} : null, sats: shares[k].sats});
        })));
    }

    terminate() {
        for (const slot of this.slots) {
            slot.w.onmessage = slot.w.onerror = null;
            slot.w.terminate();
            slot.reject?.(new Error("timelapse preview worker terminated"));
        }
        this.slots = [];
    }
}

// Replace a LineSegments2's geometry with the given parts ({pos, col} arrays of
// 6 floats per segment); returns the segment count.
function setLineSegments(lines, parts) {
    let total = 0;
    for (const part of parts) total += part.pos.length;
    const pos = new Float32Array(total), col = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
        pos.set(part.pos, offset);
        col.set(part.col, offset);
        offset += part.pos.length;
    }
    const geometry = new LineSegmentsGeometry();
    const count = total / 6;
    if (count > 0) {
        geometry.setPositions(pos);
        geometry.setColors(col);
    }
    lines.geometry.dispose();
    lines.geometry = geometry;
    lines.visible = count > 0;
    return count;
}

if (typeof window !== "undefined") window.TimelapsePreview = timelapsePreview;   // console/MCP access
