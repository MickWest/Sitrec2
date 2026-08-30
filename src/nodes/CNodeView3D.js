import {par} from "../par";
import {showError} from "../showError";
import {
    createVideoExporter,
    createVideoExportFramePlan,
    DefaultVideoFormat,
    getBestFormatForResolution,
    getVideoExportSpeedInfo,
    getVideoExportSpeedSuffix,
    getVideoExtension,
    findFirstVideoData,
    getCanvasDisplayRect,
    scanDuplicateVideoFrames
} from "../VideoExporter";
import {drawVideoWatermark, ExportProgressWidget} from "../utils";
import {drawAttributionOnCanvas} from "../AttributionOverlay";
import {ECEFToLLAVD_radii, wgs84} from "../LLA-ECEF-ENU";
import {Frame2Az, Frame2El} from "../JetUtils";
import {
    CustomManager,
    getEffectiveMSAASamples,
    getEffectiveRenderScale,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiTweaks,
    NodeMan,
    setGPUMemoryMonitor,
    setRenderOne,
    Sit
} from "../Globals";
import {GlobalDaySkyScene, GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "../LocalFrame";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";
import {renderFisheyeMask} from "../FisheyeProjection";
import {DRAG} from "../mouseMoveView";
import {GPUMemoryMonitor} from "../GPUMemoryMonitor";
import {
    Camera,
    Color,
    DirectionalLight,
    FogExp2,
    Group,
    HalfFloatType,
    LinearFilter,
    LinearSRGBColorSpace,
    Mesh,
    NearestFilter,
    NormalBlending,
    PCFShadowMap,
    PerspectiveCamera,
    PlaneGeometry,
    Raycaster,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    TextureLoader,
    UnsignedByteType,
    Vector3,
    WebGLRenderer,
    WebGLRenderTarget
} from "three";
import {forceFilterChange, scaleArrows, scaleBuildingHandles, updateTrackPositionIndicator} from "../threeExt";
import {updateObjectMoveWidget} from "../CObjectMoveWidget";
import {CNodeViewCanvas} from "./CNodeViewCanvas";
import {CNode} from "./CNode";
import {getCameraNode} from "./CNodeCamera";
import {CNodeEffect} from "./CNodeEffect";
import {assert} from "../assert";
import {V3} from "../threeUtils";
import {ACESFilmicToneMappingShader} from "../shaders/ACESFilmicToneMappingShader";
import {ShaderPass} from "three/addons/postprocessing/ShaderPass.js";
import {isLocal, SITREC_APP} from "../configUtils"
import {VRButton} from 'three/addons/webxr/VRButton.js';
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {CameraMapControls} from "../js/CameraControls";
import {ViewMan} from "../CViewManager";
import * as LAYER from "../LayerMasks";
import {globalProfiler} from "../VisualProfiler";
import {fixXRLayerMasks, renderCelestialScene, renderFullscreenQuadStereo} from "../CXRRenderer";
import {waitForExportFrameSettled} from "../ExportFrameSettler";
import {t} from "../i18n";
import {mouseMethods} from "./CNodeView3DMouse";
import {cloneTerrainDayNightMaterialForView} from "../js/map33/material/TerrainDayNightMaterial";
import {installStableShadowReceivers, setStableShadowReceiverLight} from "../StableShadowReceiver";
import {getLocalUpVector} from "../SphericalMath";
import {viewMenuKey} from "../ViewUIBarMenus";


function linearToSrgb(color) {
    function toSrgbComponent(c) {
        return (c <= 0.0031308) ? 12.92 * c : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
    }
    return new Color(
        toSrgbComponent(color.r),
        toSrgbComponent(color.g),
        toSrgbComponent(color.b)
    );
}

export class CNodeView3D extends CNodeViewCanvas {
    constructor(v) {

        assert(v.camera !== undefined, "Missing Camera creating CNodeView 3D, id=" + v.id)

        // strip out the camera, as we don't want it in the super
        // as there's conflict with the getter
        const v_camera = v.camera
        delete v.camera;

        super(v);

        if (this.id === "mainView" && Sit.guiMenus && Globals.menuBar) {
            Globals.menuBar.modDeserialize(Sit.guiMenus);
        }

        this.tileLayers = 0;
        if (this.id === "mainView") {
            this.tileLayers |= LAYER.MASK_MAIN;
        } else {
            this.tileLayers |= LAYER.MASK_LOOK;
        }

        const atmosphereDef = v.atmosphere ?? {};
        this.atmosphereEnabled = atmosphereDef.enabled ?? false;
        this.atmosphereVisibilityKm = atmosphereDef.visibilityKm ?? 250;
        this.atmosphereHDR = atmosphereDef.hdr ?? true;
        this.atmosphereExposure = atmosphereDef.exposure ?? 1.0;
        this.atmosphereHaze = v.atmosphereHaze ?? atmosphereDef.haze ?? false;
        this.skyGradient = v.skyGradient ?? atmosphereDef.skyGradient ?? false;
        this.allowMobileSkyGradient = v.allowMobileSkyGradient ?? atmosphereDef.allowMobileSkyGradient ?? false;
        this.requestLookViewHDR = this.id === "lookView";

        // V5 shadows: per-view toggle. On by default; serialised. Gated
        // by the lighting node's master shadows flag (lighting.shadowsEnabled)
        // — see areShadowsEffective() — so enabling this alone does nothing
        // until the master toggle is also on.
        // The viewSun is lazy-allocated on first transition to effective-on.
        this.shadowsEnabled = v.shadowsEnabled ?? true;
        this.allowMobileShadows = v.allowMobileShadows ?? false;
        this.addSimpleSerial("shadowsEnabled");
        this.addSimpleSerial("allowMobileShadows");
        this.viewSun = null;
        this._didEverEnableShadows = false;

        if (this.id === "mainView" || this.id === "lookView") {
            const viewLabel = this.id === "mainView"
                ? t("view3d.shadowsEnabled.mainLabel")
                : t("view3d.shadowsEnabled.lookLabel");
            // Prefer the Shadow tweaks subfolder on the lighting node so the
            // per-view toggle sits next to the terrain toggle and tunables;
            // fall back to the bare Lighting menu if the lighting node or
            // folder isn't available (sitches without a lighting node).
            const lightingNode = NodeMan.get("lighting", false);
            const targetMenu = lightingNode?.shadowTweaksFolder ?? guiMenus.lighting;
            targetMenu.add(this, "shadowsEnabled")
                .name(viewLabel)
                .tooltip(t("view3d.shadowsEnabled.tooltip"))
                .listen()
                .onChange(() => {
                    const lighting = NodeMan.get("lighting", false);
                    if (lighting) lighting.applyShadowConfig({reason: "viewToggle"});
                    else this.applyShadowRendererConfig({transitioned: true});
                });
            if (Globals.isMobile) {
                const mobileLabel = this.id === "mainView"
                    ? t("view3d.allowMobileShadows.mainLabel")
                    : t("view3d.allowMobileShadows.lookLabel");
                guiMenus.lighting.add(this, "allowMobileShadows")
                    .name(mobileLabel)
                    .tooltip(t("view3d.allowMobileShadows.tooltip"))
                    .listen()
                    .onChange(() => {
                        const lighting = NodeMan.get("lighting", false);
                        if (lighting) lighting.applyShadowConfig({reason: "mobileToggle"});
                    });
            }
        }

        this.northUp = v.northUp ?? false;
        if (this.id === "lookView") {
            // .listen() because northUp is serialized (addSimpleSerial below): loading a sitch
            // writes the flag straight onto the view, so without polling the checkbox — and
            // every mirror of it — keeps showing the value from before the load.
            guiMenus.view.add(this, "northUp").name(t("view3d.northUp.label")).listen().onChange(value => {
                this.recalculate();
            })
                .tooltip(t("view3d.northUp.tooltip"))
                .shareAs(viewMenuKey("lookView", "northUp"))

            // Atmosphere flag + tweaks now live under Lighting (peer to the
            // Shadows / Shadow tweaks pair) instead of Effects. The master
            // checkbox sits at lighting-level; the three tunables go in a
            // collapsed "Atmosphere Tweaks" subfolder beneath it.
            guiMenus.lighting.add(this, "atmosphereEnabled").name(t("view3d.atmosphere.label")).listen().onChange(() => {
                setRenderOne(true);
            }).tooltip(t("view3d.atmosphere.tooltip"));

            const atmoFolder = guiMenus.lighting.addFolder("Atmosphere Tweaks").close();
            atmoFolder.add(this, "atmosphereVisibilityKm", 1, 500, 0.1).name(t("view3d.atmoVisibility.label")).listen().onChange(() => {
                setRenderOne(true);
            }).tooltip(t("view3d.atmoVisibility.tooltip"));

            atmoFolder.add(this, "atmosphereHDR").name(t("view3d.atmoHDR.label")).listen().onChange(() => {
                setRenderOne(true);
            }).tooltip(t("view3d.atmoHDR.tooltip"));

            atmoFolder.add(this, "atmosphereExposure", 0.1, 5.0, 0.01).name(t("view3d.atmoExposure.label")).listen().onChange(() => {
                setRenderOne(true);
            }).tooltip(t("view3d.atmoExposure.tooltip"));

            // Snapshot the sitch's initial atmosphere state into the lighting
            // node's "Default" preset so picking Default restores it.
            const lightingNode = NodeMan.get("lighting", false);
            if (lightingNode && typeof lightingNode.captureDefaultAtmosphere === "function") {
                lightingNode.captureDefaultAtmosphere(this.atmosphereEnabled);
            }

            guiTweaks.add(this, "skyGradient")
                .name(t("view3d.skyGradient.label", {defaultValue: "Sky Gradient"}))
                .listen()
                .onChange(() => setRenderOne(true))
                .tooltip(t("view3d.skyGradient.tooltip", {defaultValue: "Sky fades from zenith blue to horizon haze"}));

            if (Globals.isMobile) {
                guiTweaks.add(this, "allowMobileSkyGradient")
                    .name(t("view3d.allowMobileSkyGradient.label", {defaultValue: "Allow Sky Gradient on mobile"}))
                    .listen()
                    .onChange(() => setRenderOne(true))
                    .tooltip(t("view3d.allowMobileSkyGradient.tooltip", {defaultValue: "Override mobile auto-disable for the sky gradient"}));
            }
            
            // Add XR test button if VR is enabled
            if (Globals.canVR) {
                guiMenus.view.add(this, "startXR").name(t("view3d.startXR.label"))
                    .tooltip(t("view3d.startXR.tooltip"));
            }
        }
        this.addSimpleSerial("northUp");

        // Y-compress: anamorphic vertical squash. 1 = no-op. Values >1 widen the
        // vertical view frustum by that factor while keeping the same output height,
        // packing more in vertically (the image looks vertically squashed).
        // This is a per-3D-view setting: the data lives on each CNodeView3D and the
        // render/culling path reads this.yCompress directly. The main view's control
        // ("Main Y-comp") lives in the View menu; the look view's ("Look Y-comp")
        // lives in Camera ▸ Camera Tweaks (it tweaks the look camera). Other views
        // keep the default 1 (no control).
        this.yCompress = v.yCompress ?? 1.0;
        const yCompressControl = {
            mainView: {label: "Main Y-comp", menu: "view"},
            lookView: {label: "Look Y-comp", menu: "cameraTweaks"},
        }[this.id];
        if (yCompressControl !== undefined) {
            this._hasYCompressControl = true;
            const menu = guiMenus[yCompressControl.menu] ?? guiMenus.view;
            menu.add(this, "yCompress", 1, 20, 0.01)
                .name(yCompressControl.label)
                .listen()
                .onChange(() => {
                    this.updateYCompressIndicator();
                    setRenderOne(true);
                })
                .tooltip("Vertically expand this view's frustum to pack more into the same height (distorts the view). 1 = off.")
                .shareAs(viewMenuKey(this.id, "yCompress"));
            this.addSimpleSerial("yCompress");
            this.updateYCompressIndicator();
        }


        this.isIR = v.isIR ?? false;
        this.fovOverride = v.fovOverride;

        this.syncVideoZoom = v.syncVideoZoom ?? false;  // by default, don't sync the zoom with the video view, as we might not have a zoom controlelr
        this.syncPixelZoomWithVideo = v.syncPixelZoomWithVideo ?? false;
        this.background = v.background ?? new Color(0x000000);

        // Ensure background is always a Color object (may be string, array, hex, or Color)
        if (Array.isArray(this.background)) {
            this.background = new Color(this.background[0], this.background[1], this.background[2])
        } else if (!this.background.isColor) {
            this.background = new Color(this.background);
        }

        this._lookViewFog = new FogExp2(new Color(this.background), 0);
        this._atmosphereSkyColor = new Color(this.background);
        this._atmosphereZenithColor = new Color(this.background);
        this._atmosphereBlueZenith = new Color(0.28, 0.62, 1.0);
        this._atmosphereBlueZenithScaled = new Color(0.28, 0.62, 1.0);
        this._atmosphereHazeColorSRGB = new Color(this.background);
        this._atmosphereHazeColorLinear = new Color(this.background);
        this._aerialPerspectiveSkyColor = new Color(this.background);
        this._sunDirScratch = new Vector3();
        this._scratchVec = new Vector3();

        this.scene = GlobalScene;

        // Cameras were passing in as a node, but now we just pass in the camera node
        // which could be a node, or a node ID.

        this.cameraNode = getCameraNode(v_camera)

        assert(this.cameraNode !== undefined, "CNodeView3D needs a camera Node")
        assert(this.camera !== undefined, "CNodeView3D needs a camera")

        this.canDisplayNightSky = true;
        this.mouseEnabled = true; // by defualt

        this.setupRenderPipeline(v);

        // Setup debug GUI once (shared across all views)
        // Only add debug GUI if this is the first mainView and help menu exists
        if (isLocal && this.id === "mainView" && guiMenus && guiMenus.help && !guiMenus.help._renderDebugFolderAdded) {
            const debugFolder = guiMenus.debug.addFolder("Render Debug");

            // Add controls for global render debug flags (affects ALL views)
            debugFolder.add(Globals.renderDebugFlags, "dbg_clearBackground").name(t("view3d.debug.clearBackground")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderSky").name(t("view3d.debug.renderSky")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderDaySky").name(t("view3d.debug.renderDaySky")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderMainScene").name(t("view3d.debug.renderMainScene")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderEffects").name(t("view3d.debug.renderEffects")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_copyToScreen").name(t("view3d.debug.copyToScreen")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_updateCameraMatrices").name(t("view3d.debug.updateCameraMatrices")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_mainViewUseLookLayers").name(t("view3d.debug.mainUseLookLayers")).onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_sRGBOutputEncoding").name(t("view3d.debug.sRGBOutputEncoding")).onChange(() => setRenderOne(true));

            debugFolder.add(Globals, "tileDelay", 0, 5, 0.01).name(t("view3d.debug.tileLoadDelay")).onChange(() => setRenderOne(true));

            // Add renderSky sub-folder
            const skyFolder = debugFolder.addFolder("Sky Steps");
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateStarScales").name(t("view3d.debug.updateStarScales")).onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateSatelliteScales").name(t("view3d.debug.updateSatelliteScales")).onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderNightSky").name(t("view3d.debug.renderNightSky")).onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderFullscreenQuad").name(t("view3d.debug.renderFullscreenQuad")).onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderSunSky").name(t("view3d.debug.renderSunSky")).onChange(() => setRenderOne(true));

            // Mark folder + all children permanent so they survive
            // disposeEverything()'s menuBar.destroy(false) on every sitch
            // reload. Without this the controls vanish after File → Load
            // (URL-loads happen pre-disposal so the issue doesn't show).
            const permAll = (node) => {
                if (typeof node.perm === "function") node.perm();
                if (node.children) node.children.forEach(permAll);
            };
            permAll(debugFolder);

            // Mark that we've added the render debug folder to avoid duplicates
            guiMenus.help._renderDebugFolderAdded = true;
        }

        this.addEffects(v.effects)
        this.otherSetup(v);


        this.recalculate(); // to set the effect pass uniforms

        this.initSky();

        if (Globals.canVR && this.id === "lookView") {

            // WebXR plumbing for lookView. We DON'T set xr.enabled=true here:
            // when IWER (Immersive Web Emulation Runtime) is installed for
            // local-host VR testing, it provides a mock XRDevice and paints
            // its emulator UI (concentric circles + status text) onto the
            // canvas as soon as renderer.xr is enabled. The user sees that
            // overlay in the video view's canvas region during sitch reload
            // even though no XR session is active. Defer xr.enabled until
            // startXR() actually wants a session.
            this.renderer.xr.setFramebufferScaleFactor(1.5);

            this.xrSession = null;
            this.xrActive = false;

            // Bind event handlers
            this.onXRSessionStarted = this.onXRSessionStarted.bind(this);
            this.onXRSessionEnded = this.onXRSessionEnded.bind(this);
            this.renderXR = this.renderXR.bind(this);

            // Add hidden VRButton (needed for XR session management).
            if (!document.getElementById('VRButton')) {
                const xrButton = VRButton.createButton(this.renderer);
                xrButton.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;';
                document.body.appendChild(xrButton);
            }

            // Monitor XR session state — listeners attach without xr.enabled.
            this.renderer.xr.addEventListener('sessionstart', this.onXRSessionStarted);
            this.renderer.xr.addEventListener('sessionend', this.onXRSessionEnded);

            console.log("WebXR plumbing ready for lookView (xr.enabled deferred until 'Start VR/XR')");
        }
    }


    /**
     * Manually start a WebXR session
     * Useful for testing with Immersive Web Emulator
     */
    startXR() {
        // Enable xr now that the user actually wants a session. We defer
        // this from constructor time so IWER (or any future XR runtime) can't
        // paint its emulator UI onto our canvas before a session is requested.
        if (this.renderer && !this.renderer.xr.enabled) {
            this.renderer.xr.enabled = true;
        }
        const vrButton = document.getElementById('VRButton');
        if (vrButton) {
            vrButton.click();
        } else {
            console.error("VR button not found");
        }
    }

    /**
     * Export the lookView as a video file
     * @param {string} formatId - Video format ID (e.g., 'mp4-h264', 'webm-vp8')
     * @param {boolean} includeAudio - Whether to include audio track if available
     * @param {boolean} waitForBackgroundLoading - When true, wait for background loading between captured frames
     * @param {object} options - options.plan supplies a pre-built frame plan (Render Fade) instead of the A-B one
     */
    async exportVideo(requestedFormatId = DefaultVideoFormat, includeAudio = true, waitForBackgroundLoading = false, options = {}) {
        const startFrame = Sit.aFrame;
        const endFrame = Sit.bFrame;
        const width = this.canvas.width;
        const height = this.canvas.height;
        let plan = options.plan;
        if (!plan) {
            let duplicateFrameSet = null;
            if (options.uniqueFramesOnly) {
                const scanProgress = new ExportProgressWidget("Scanning duplicate video frames...", endFrame - startFrame + 1);
                try {
                    duplicateFrameSet = await scanDuplicateVideoFrames(findFirstVideoData(NodeMan), startFrame, endFrame, scanProgress, {
                        meanAbsDiffThreshold: options.uniqueFrameMeanAbsDiffThreshold,
                    });
                    if (scanProgress.shouldStop()) {
                        console.log("Duplicate frame scan cancelled; exporting all frames");
                        duplicateFrameSet = null;
                    } else {
                        console.log(`Unique frames only: found ${duplicateFrameSet.size} duplicate frame(s) in ${startFrame}-${endFrame}`);
                    }
                } finally {
                    scanProgress.remove();
                }
            }
            plan = createVideoExportFramePlan({
                startFrame,
                endFrame,
                sourceFps: Sit.fps,
                playbackSpeed: par.playbackSpeed ?? 1,
                pingPong: options.pingPong ?? par.pingPong,
                loops: options.loops ?? 1,
                duplicateFrameSet,
            });
        }
        if (plan.totalFrames === 0) {
            alert("Video export failed: no unique frames found in the A-B range.");
            return;
        }
        
        const bestFormat = await getBestFormatForResolution(requestedFormatId, width, height);
        if (!bestFormat.formatId) {
            alert(`Video export failed: ${bestFormat.reason}`);
            return;
        }
        if (bestFormat.fallback) {
            console.log(`${bestFormat.reason}, falling back to ${bestFormat.formatId}`);
        }
        
        const formatId = bestFormat.formatId;
        const extension = getVideoExtension(formatId);
        
        const speedInfo = getVideoExportSpeedInfo(plan);
        console.log(`Starting video export (${formatId}): ${plan.totalFrames} output frames from ${plan.totalSourceFrames} source (${startFrame}-${endFrame}) at ${plan.fps} fps${speedInfo}, ${width}x${height}`);
        
        const savedFrame = par.frame;
        const savedPaused = par.paused;
        par.paused = true;
        
        const progress = new ExportProgressWidget('Exporting video...', plan.totalFrames);
        
        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;
        
        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = plan.fps;
        
        const canIncludeAudio = includeAudio && plan.playbackSpeed === 1 && !plan.pingPong && plan.loops === 1 && plan.skippedDuplicateFrames === 0;
        if (canIncludeAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler && 
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || plan.fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = plan.totalFrames / plan.fps;
                        console.log(`Found audio: ${audioBuffer.duration.toFixed(2)}s, using ${audioDuration.toFixed(2)}s from ${audioStartTime.toFixed(2)}s`);
                        break;
                    }
                }
            }
        } else if (includeAudio) {
            console.log("Audio export skipped: playback speed, A-B pingpong, loops, or unique-frame export would desync from video");
        }
        
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        const compositeCtx = compositeCanvas.getContext('2d');

        // Render Fade drives the video overlay's opacity per output frame instead of, or as well
        // as, the frame number. The compositing pass below reads childView.transparency, so
        // setting it is all that is needed here; forcing the overlay visible and restoring it
        // afterwards is owned by VideoExportManager.exportFadeVideo, which both paths go through.
        // canvas.style.opacity is kept in step purely so the on-screen view fades along too.
        const fadeOverlay = plan.alphaAt ? (options.fadeOverlay ?? null) : null;
        const setOverlayAlpha = (alpha) => {
            fadeOverlay.transparency = alpha;
            if (fadeOverlay.canvas) fadeOverlay.canvas.style.opacity = alpha;
        };

        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps: plan.fps,
                bitrate: 5_000_000,
                keyFrameInterval: 30,
                videoStartDate,
                audioBuffer,
                audioStartTime,
                audioDuration,
                originalFps,
                hardwareAcceleration: bestFormat.hardwareAcceleration,
            });
            
            await exporter.initialize();
            
            let UpdatePRFromEA = null;
            if (Sit.azSlider) {
                const jetStuff = await import("../JetStuff");
                UpdatePRFromEA = jetStuff.UpdatePRFromEA;
            }
            
            for (let i = 0; i < plan.totalFrames; i++) {
                if (progress.shouldStop()) break;
                
                const frame = plan.frameAt(i);
                const renderSingleViewFrame = async () => {
                    if (fadeOverlay) setOverlayAlpha(plan.alphaAt(i));
                    par.frame = frame;
                    GlobalDateTimeNode.update(frame);
                    
                    if (Sit.azSlider) {
                        par.az = Frame2Az(par.frame);
                        par.el = Frame2El(par.frame);
                        UpdatePRFromEA();
                    }
                    
                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.isController && !node.allowUpdate) {
                            assert(node.update === CNode.prototype.update,
                                `Controller ${node.id} has overridden update() - move logic to apply()`);
                            continue;
                        }
                        if (node.update !== undefined) {
                            node.update(frame);
                        }
                        if (node.videoData && node.videoData.waitForFrame) {
                            await node.videoData.waitForFrame(frame);
                        }
                    }
                    
                    this.camera.updateMatrix();
                    this.camera.updateMatrixWorld();
                    for (const node of NodeMan.getPreRenderNodes()) {
                        node.preRender(this);
                    }

                    this.renderCanvas(frame);

                    compositeCtx.drawImage(this.canvas, 0, 0);

                    // Also render visible child views (overlays and relativeTo children like compass, MQ9UI)
                    // Scale from CSS pixels to composite canvas backing pixels.
                    //
                    // The composite IS this view's canvas, so the mapping basis is the rect that
                    // canvas occupies on screen, not the whole div. With matchVideoAspect the two
                    // differ: the canvas is letterboxed inside the div, so a child mapped against
                    // the div lands stretched across the full frame while the 3D behind it is the
                    // letterboxed crop. Child coordinates are in div space, hence the -rect.x/y.
                    const rect = getCanvasDisplayRect(this);
                    const scaleX = width / rect.width;
                    const scaleY = height / rect.height;
                    ViewMan.computeEffectiveVisibility();
                    ViewMan.iterate((id, childView) => {
                        if (childView === this) return;
                        if (!childView._effectivelyVisible) return;
                        const isOverlayChild = (childView.overlayView === this);
                        const isChild = isOverlayChild ||
                                        (childView.in.relativeTo === this);
                        if (!isChild) return;
                        if (isOverlayChild && childView.canvas &&
                            (childView.canvas.style.display === "none" || childView.canvas.style.visibility === "hidden")) {
                            // Hidden overlay canvases can retain stale pixels if they were previously shown.
                            // Skip drawing them to match on-screen presentation.
                            return;
                        }

                        childView.renderCanvas(frame);
                        if (childView.canvas) {
                            const dx = (childView.leftPx - this.leftPx - rect.x) * scaleX;
                            const dy = (childView.topPx - this.topPx - rect.y) * scaleY;
                            const dw = childView.widthPx * scaleX;
                            const dh = childView.heightPx * scaleY;
                            const alpha = childView.transparency !== undefined ? childView.transparency : 1;
                            if (alpha < 1) compositeCtx.globalAlpha = alpha;
                            compositeCtx.drawImage(childView.canvas, dx, dy, dw, dh);
                            if (alpha < 1) compositeCtx.globalAlpha = 1;
                        }
                    });

                    drawVideoWatermark(compositeCtx, width);
                    drawAttributionOnCanvas(compositeCtx, width, height);
                };

                await renderSingleViewFrame();
                if (waitForBackgroundLoading) {
                    // Gate frame capture on global async settling + 3D tile transition quiescence.
                    await waitForExportFrameSettled({
                        frame,
                        viewIds: [this.id],
                        renderFrame: renderSingleViewFrame,
                        logPrefix: `${this.id} video export`,
                    });
                }
                
                await exporter.addFrame(compositeCanvas, i);
                
                if (i % 10 === 0) {
                    progress.update(i + 1);
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            
            if (progress.shouldSave()) {
                const blob = await exporter.finalize(
                    (current, total) => progress.setFinalizeProgress(current, total),
                    (status) => progress.setStatus(status)
                );
                
                const filename = `lookview_${Sit.name || 'export'}${getVideoExportSpeedSuffix(plan)}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${extension}`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                
                console.log(`Video export complete: ${filename}`);
            } else {
                console.log('Video export aborted by user');
            }
            
        } catch (e) {
            console.error('Export failed:', e);
            alert('Video export failed: ' + e.message);
        } finally {
            progress.remove();
            par.frame = savedFrame;
            par.paused = savedPaused;
            setRenderOne(true);
        }
    }

    /**
     * Called when a WebXR session starts
     * Sets up the XR animation loop and enables lookCamera synchronization
     */
    onXRSessionStarted() {
        console.log("WebXR session started");
        
        // Safety check: ensure renderer still exists (might have been disposed)
        if (!this.renderer) {
            console.warn("XR: Cannot start session - renderer has been disposed");
            return;
        }
        
        this.xrActive = true;
        
        // Get lookCamera position to set up camera rig
        const lookCameraNode = NodeMan.get("lookCamera");
        if (lookCameraNode) {
            const lookCamera = lookCameraNode.camera;
            lookCamera.updateMatrixWorld(true);

            // CRITICAL: Create a new camera for XR that's independent from lookCamera
            // lookView normally shares lookCamera's camera object, which causes position conflicts
            // Store the original camera reference so we can restore it later
            this.originalCamera = this.camera;

            // Create a new PerspectiveCamera for XR use
            this.xrCamera = new PerspectiveCamera(
                lookCamera.fov,
                this.camera.aspect
            );
            this.xrCamera.near = lookCamera.near;
            this.xrCamera.far = lookCamera.far;

            // Copy layer mask from lookCamera so XR sees the same layers
            this.xrCamera.layers.mask = lookCamera.layers.mask;


            console.log("XR: Copied lookCamera layers.mask to xrCamera:", this.xrCamera.layers.mask.toString(2), "(" + this.xrCamera.layers.mask + ")");
            this.xrCamera.updateProjectionMatrix();

            console.log("XR: Created independent XR camera");

            // Create camera rig positioned at lookCamera's world location
            this.xrCameraRig = new Group();
            this.xrCameraRig.name = "XRCameraRig";
            this.xrCameraRig.position.copy(lookCamera.position);
            console.log("XR: Camera rig positioned at:", this.xrCameraRig.position.x.toFixed(1), this.xrCameraRig.position.y.toFixed(1), this.xrCameraRig.position.z.toFixed(1));

            // Add rig to scene
            GlobalScene.add(this.xrCameraRig);

            // Add XR camera to rig
            this.xrCameraRig.add(this.xrCamera);

            // Reset camera local position - XR will control this for head tracking
            this.xrCamera.position.set(0, 0, 0);
            this.xrCamera.rotation.set(0, 0, 0);

            let redSphere = null;
            // // Add debug spheres to the camera rig for testing
            // const sphereGeometry = new SphereGeometry(5, 16, 16);
            //
            // const greenMaterial = new MeshBasicMaterial({color: 0x00ff00});
            // const greenSphere = new Mesh(sphereGeometry, greenMaterial);
            // greenSphere.position.set(-20, 0, -100);
            // greenSphere.layers.enableAll();
            // this.xrCameraRig.add(greenSphere);
            //
            // // Create a simple red texture for the red sphere
            // const canvas = document.createElement('canvas');
            // canvas.width = 1;
            // canvas.height = 1;
            // const ctx = canvas.getContext('2d');
            // ctx.fillStyle = '#ff0000';
            // ctx.fillRect(0, 0, 1, 1);
            // const redTexture = new CanvasTexture(canvas);
            //
            // const redMaterial = createTerrainDayNightMaterial(redTexture, 0.3, false);
            // redSphere = new Mesh(sphereGeometry, redMaterial);
            // redSphere.position.set(20, 0, -100);
            // redSphere.layers.enableAll();
            // this.xrCameraRig.add(redSphere);

            // Try to get the material from tile 0,0,0 directly
            const terrainNode = NodeMan.get("TerrainModel", true);
            if (terrainNode && terrainNode.UI) {
                const mapType = terrainNode.UI.mapType;
                const map = terrainNode.maps?.[mapType]?.map;
                if (map) {
                    const tile000 = map.getTile(0, 0, 0);
                    if (redSphere && tile000?.mesh?.material) {
                        console.log("XR: Setting red sphere material from tile 0,0,0");
                        redSphere.material = tile000.mesh.material;
                    }
                }
            }

            console.log("XR: Camera parented to rig with debug spheres at session start");
        }
        
        // Set the XR animation loop - Three.js will handle stereo rendering automatically
        // This replaces the normal requestAnimationFrame loop
        this.renderer.setAnimationLoop(this.renderXR);
    }

    /**
     * Called when a WebXR session ends
     * Restores the normal rendering loop
     */
    onXRSessionEnded() {
        console.log("WebXR session ended");
        this.xrActive = false;
        
        // Clear the animation loop - return to normal requestAnimationFrame rendering
        this.renderer.setAnimationLoop(null);
        
        // Clean up XR camera and rig
        if (this.xrCameraRig) {
            GlobalScene.remove(this.xrCameraRig);
            this.xrCameraRig = null;
        }
        
        // Clean up XR camera
        if (this.xrCamera) {
            this.xrCamera = null;
        }
        
        // Restore original camera reference if it was saved
        if (this.originalCamera) {
            this.camera = this.originalCamera;
            this.originalCamera = null;
        }
        
        // Clean up red sphere reference
        if (this.xrRedSphere) {
            this.xrRedSphere = null;
        }
        
        console.log("XR: Session ended, XR resources cleaned up");
    }

    /**
     * XR rendering loop - called by Three.js for each XR frame
     * Synchronizes the view camera with lookCamera and renders the scene
     * Three.js automatically handles stereo rendering for VR headsets
     */
    renderXR(time, frame) {
        // console.log("XR: === START of renderXR === time:", time.toFixed(3), "view:", this.id);

        // Get lookCamera for settings like near/far planes
        const lookCameraNode = NodeMan.get("lookCamera", false);
        if (!lookCameraNode) {
            console.warn("lookCamera not found, cannot render XR frame");
            return;
        }
        const lookCamera = lookCameraNode.camera;


        // Check XR is ready
        if (!this.renderer.xr.getCamera()) {
            console.error("XR camera not initialized");
            return;
        }

        this.xrCamera.layers.mask = lookCamera.layers.mask;

        // Synchronize xrCameraRig position with lookCamera world position
        this.xrCameraRig.position.copy(lookCamera.position);
        // and orientation
        this.xrCameraRig.quaternion.copy(lookCamera.quaternion);


        // Copy near/far planes from lookCamera (critical for logarithmic depth buffer)
        this.xrCamera.near = lookCamera.near;
        this.xrCamera.far = lookCamera.far;
        
        // Update camera projection
        this.xrCamera.updateProjectionMatrix();
        
        // Update world matrix
        this.xrCamera.updateMatrixWorld(true);

        // Call preRender on all nodes (important for terrain LOD and visibility)
        for (const node of NodeMan.getPreRenderNodes()) {
            node.preRender(this);
        }
        
        // Update terrain for XR (needed for tile visibility/LOD) ?????
        const terrainUI = NodeMan.get("terrainUI", true);
        if (terrainUI) {
            terrainUI.update();
        }

        // Update shared uniforms for shaders (near/far planes)
        // sharedUniforms.nearPlane.value = xrCamera.near;
        // sharedUniforms.farPlane.value = xrCamera.far;
        //
        // Calculate and set focal length uniform
//        const fov = xrCamera.fov * Math.PI / 180;


        // NOTE: focal length is now set in renderTargetAndEffects() after render targets are sized
        // Do NOT set it here as it would use heightPx instead of actual render target height
        // const fov = lookCamera.fov * Math.PI / 180;
        // const focalLength = this.heightPx / (2 * Math.tan(fov / 2));
        // sharedUniforms.cameraFocalLength.value = focalLength;

        // Update lighting before rendering (essential for proper scene appearance)
        const lightingNode = NodeMan.get("lighting", true);
        if (lightingNode) {
            lightingNode.recalculate(false); // false = not main view for lighting purposes
            
            // Update sun-related uniforms. The ambient bucket includes both
            // fixed ambient and daylight sun scattering, so shadow floors match
            // the actual light that reaches building backs and shaded terrain.
            sharedUniforms.sunGlobalTotal.value = lightingNode.getEffectiveSunTotal();
            sharedUniforms.sunAmbientIntensity.value = lightingNode.getEffectiveAmbientIntensity();
            sharedUniforms.sunNightAmbientIntensity.value = lightingNode.getNightAmbientIntensity();
            sharedUniforms.useDayNight.value = !lightingNode.noMainLighting;
        }
        
        // Update sun position if sun node exists
        const sunNode = NodeMan.get("theSun", true);
        if (sunNode) {
            sunNode.update();
        }
        
        // Configure renderer for manual clearing (needed for proper depth buffer handling)
        this.renderer.autoClear = false;
        
        // Setup internal XR cameras BEFORE rendering sky
        // This is critical for stereo rendering of the celestial sphere
        this.renderer.xr.cameraAutoUpdate = false;
        this.renderer.xr.updateCamera(this.xrCamera);
        
        // Fix layer masks on internal XR cameras (left/right eye)
        // The XR system clears high bits, so we OR them back in
        fixXRLayerMasks(this.renderer, lookCamera.layers.mask);
        
        // Render sky - matches renderSky() logic from renderTargetAndEffects
        if (this.canDisplayNightSky && GlobalNightSkyScene !== undefined) {

            // Update star and satellite scales for this view
            const nightSkyNode = NodeMan.get("NightSkyNode");
            if (nightSkyNode) {
                // The sky scenes are shared across views, so resync the Sun/Moon
                // meshes to the camera that is actually being rendered right now.
                // Without this, the main view can inherit the look-camera observer.
                // BEFORE the planet sprites: the Moon's shader reads what the
                // lunar-eclipse node publishes, and updateMoonMesh runs inside
                // syncPlanetSpritesToObserver.
                NodeMan.get("theLunarEclipse", true)?.syncToObserver(lookCamera.position);
                nightSkyNode.syncPlanetSpritesToObserver(lookCamera.position, undefined, {storeState: false});
                NodeMan.get("theHalos", true)?.syncToObserver(lookCamera.position);
                NodeMan.get("theEclipse", true)?.syncToObserver(lookCamera.position);
                nightSkyNode.starField.updateStarScales(this);
                nightSkyNode.updateSatelliteScales(this);
            }
            
            // Set initial clear color
            this.renderer.setClearColor(this.background);
            
            // Calculate sky brightness and color
            let skyOpacity = 1;
            let skyColor = this.background;
            const sunNode = NodeMan.get("theSun", true);
            if (sunNode !== undefined) {
                this.renderer.setClearColor("black");
                skyColor = sunNode.calculateSkyColor(lookCamera.position);
                skyOpacity = sunNode.calculateSkyOpacity(lookCamera.position);
                if (nightSkyNode) {
                    const skyBrightness = sunNode.calculateSkyBrightness(lookCamera.position);
                    nightSkyNode.planets.updateMoonSkyUniforms(skyColor, skyBrightness);
                    nightSkyNode.planets.updateDaySkyVisibility(skyOpacity);
                }
            }

            // Render night sky if visible (opacity < 1 means stars are visible)
            if (skyOpacity < 1) {
                this.renderer.clear(true, true, true);
                renderCelestialScene(
                    this.renderer,
                    this.xrCameraRig,
                    this.xrCamera,
                    lookCamera.layers.mask,
                    GlobalNightSkyScene
                );
            }
            
            // Render sky brightness overlay and sun sky only during daytime
            if (skyOpacity > 0) {
                // Restore sky material (effects pipeline swaps it each frame)
                this.fullscreenQuad.material = this.skyBrightnessMaterial;
                
                this.updateSkyUniforms(skyColor, skyOpacity);
                
                renderFullscreenQuadStereo(this.renderer, this.fullscreenQuadScene, this.fullscreenQuadCamera);
                
                this.renderer.clearDepth();
                
                // Render sun/day sky
                if (GlobalSunSkyScene) {
                    renderCelestialScene(
                        this.renderer,
                        this.xrCameraRig,
                        this.xrCamera,
                        lookCamera.layers.mask,
                        GlobalSunSkyScene
                    );
                }
            }
        } else {
            // No night sky - clear with background color
            console.warn("XR: No night sky, clearing with background");
            this.renderer.setClearColor(this.background);
            this.renderer.clear(true, true, true);
        }

        // Fix layer masks one final time before rendering main scene
        fixXRLayerMasks(this.renderer, lookCamera.layers.mask);
        
        // Render the scene - Three.js XR system handles stereo rendering automatically
        // This will render twice (once per eye) with proper camera offsets for VR
        // Note: We skip post-processing effects in XR mode for performance
        const atmosphereFogState = this.pushLookViewAtmosphereFog();
        let _restoreShadowScopeXR = null;
        if (Globals.shadowsEnabled) {
            _restoreShadowScopeXR = this._enterShadowRenderScope();
        }
        try {
            this.renderer.render(GlobalScene, this.xrCamera);
        } finally {
            if (_restoreShadowScopeXR) _restoreShadowScopeXR();
            this.popLookViewAtmosphereFog(atmosphereFogState);
        }

    }


    // return the viewport's hfov in radians
    // assumes the camera's fov is the viewport's vfov
    getHFOV() {
        const vfov = this.camera.fov * Math.PI / 180;
        const aspect = this.widthPx / this.heightPx;
        // given the vfov, and the aspect ratio, we can calculate the hfov
        return 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    }

    applyCameraOffset() {
        let ptzController = null;
        for (const inputID in this.cameraNode.inputs) {
            const input = this.cameraNode.in[inputID];
            if (input && input.xOffset !== undefined) {
                ptzController = input;
                break;
            }
        }
        if (!ptzController) return null;
        const xOffset = ptzController.xOffset || 0;
        const yOffset = ptzController.yOffset || 0;
        if (xOffset === 0 && yOffset === 0) return null;
        
        const savedQuaternion = this.camera.quaternion.clone();
        const xOffsetRad = xOffset * Math.PI / 180;
        const yOffsetRad = yOffset * Math.PI / 180;
        
        const up = V3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        this.camera.rotateOnWorldAxis(up, -xOffsetRad);
        
        const right = V3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        this.camera.rotateOnWorldAxis(right, -yOffsetRad);
        
        return savedQuaternion;
    }

    removeCameraOffset(savedQuaternion) {
        if (savedQuaternion) {
            this.camera.quaternion.copy(savedQuaternion);
        }
    }

    // Display-only orientation override: aim this view's camera at the point
    // supplied by displayLookAtProvider (a plain function property, NOT a node —
    // no graph edges, so nothing can cascade from it). Scoped strictly between
    // apply and remove around render/LOD/pick windows; the LOS never sees it
    // because CNodeLOSFromCamera replays controllers on its private dummy camera
    // and every other reader runs outside these synchronous windows.
    applyDisplayLookAt(frame = par.frame) {
        if (!this.displayLookAtProvider || this._displayLookAtActive) return null;
        const target = this.displayLookAtProvider(frame);
        if (!target || !Number.isFinite(target.x)) return null;
        if (target.distanceToSquared(this.camera.position) < 1e-6) return null;
        const saved = {q: this.camera.quaternion.clone(), up: this.camera.up.clone()};
        this._displayLookAtActive = true;
        this.camera.up.copy(getLocalUpVector(this.camera.position));
        this.camera.lookAt(target);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld();
        return saved;
    }

    removeDisplayLookAt(saved) {
        if (!saved) return;
        this.camera.quaternion.copy(saved.q);
        this.camera.up.copy(saved.up);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld();
        this._displayLookAtActive = false;
    }

    // Prepare the camera with the effective zoom + pan shift for tile LOD evaluation.
    // Called by the terrain system before subdivideTilesViewSpecific() so tiles
    // are loaded at the resolution matching the actual rendered view.
    prepareCameraForLOD() {
        this._lodSavedZoom = this.camera.zoom;
        this._lodSavedFov = this.camera.fov;
        this._lodSavedAspect = this.camera.aspect;

        // Same reasoning as the camera-tweaks offset below: if the display-only
        // lookAt (traverse tracking) reorients the rendered view, tile LOD must
        // evaluate that frustum, not the LOS frustum, or the tracked view shows
        // tile gaps. Applied first so the tweaks offset composes on top of it,
        // matching the render-time order.
        this._lodSavedDisplayLookAt = this.applyDisplayLookAt(par.frame);

        // Camera Tweaks xOffset/yOffset rotate the camera at render time
        // (applyCameraOffset in renderTargetAndEffects), so terrain tile
        // subdivision must evaluate the same rotated frustum or it selects
        // tiles for a view direction the render never shows (gaps on screen).
        this._lodSavedQuaternion = this.applyCameraOffset();
        if (this._lodSavedQuaternion) this.camera.updateMatrixWorld();

        // Always use the FULL videoZoom for LOD, not the pixel-match-capped value.
        // The tile system must see the final effective FOV (after all zoom) so it
        // loads tiles at the correct resolution regardless of whether rendering
        // uses FOV zoom, pixel shader, or a split of both.
        if (NodeMan.exists("videoZoom") && (this.syncVideoZoom || this.syncPixelZoomWithVideo)) {
            this.camera.zoom = NodeMan.get("videoZoom").v0 / 100;
        }
        this.camera.aspect = this.widthPx / this.heightPx;

        // Apply fovOverride if we have a video view with fovCoverage.
        //
        // SCOPED TO THE LOOK VIEW, because the render is: renderTargetAndEffects() computes
        // fovOverride inside `if (this.id === "lookView")`. Without the same guard this widened
        // the field of view of EVERY view using a letterbox coverage belonging to the look view's
        // video — measured at a 0.918 coverage, the main view's 30 deg came out of here as
        // 32.54 deg, 8.47% wide, a widening its render never applies.
        //
        // That mattered in two different ways, and the second is why the guard is here:
        //
        //   Tile LOD — benign either way. Screen-space error goes as 1/tan(fov/2), so the wider
        //   field computed ~8% LESS error and picked slightly COARSER main-view tiles. Culling
        //   was never at risk: a wider frustum is a superset, so nothing on screen was culled.
        //
        //   Screen projection and picking — broken. Callers place and pick screen-space handles
        //   through this (FitPointHandles3D, TreeManualBrush), and an inflated field of view puts
        //   the handle somewhere the thing it represents is not: measured 20-29 px out near the
        //   edges of a 709x603 main view and zero at the exact centre, so a fixed ground point
        //   appeared to SLIDE as the camera turned and its screen radius changed — 41 px of error
        //   at one heading becoming 69 px a tenth of a radian later.
        //
        // The one behaviour change to watch for: main-view terrain tiles are now selected against
        // the field of view actually rendered, so in any sitch with a letterboxed video they come
        // out ~8% finer than before. That is the correct answer rather than a new one, but it is
        // more tile loading and memory in a view that previously got away with less.
        //
        // Two smaller divergences from the render remain, both currently harmless. The pan block
        // below gates on `syncVideoZoom || syncPixelZoomWithVideo` while the render gates on
        // `syncVideoZoom` alone — equivalent while every video-synced view sets both. And the
        // matchVideoAspect block is already effectively self-scoping, keying on a per-camera
        // `<cameraNode>_Frustum` node that the main camera does not have.
        if (this.id === "lookView") {
            let videoView = null;
            if (NodeMan.exists("mirrorVideo")) videoView = NodeMan.get("mirrorVideo");
            else if (NodeMan.exists("video")) videoView = NodeMan.get("video");
            if (videoView !== null && videoView.fovCoverage !== undefined) {
                this.camera.fov = 180 / Math.PI * 2 * Math.atan(
                    Math.tan(this.camera.fov * Math.PI / 360) / videoView.fovCoverage
                );
            }
        }

        // Apply matchVideoAspect: adjust FOV and aspect to match video,
        // same as renderTargetAndEffects() does for actual rendering.
        const frustum = NodeMan.get(this.cameraNode.id + "_Frustum", false);
        if (frustum && frustum.matchVideoAspect && frustum.videoAspect) {
            const videoAspect = frustum.videoAspect;
            const viewAspect = this.camera.aspect;
            if (videoAspect > viewAspect) {
                // Letterbox: preserve hFOV, narrow vFOV
                const hFOVTanHalf = Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect;
                this.camera.fov = 2 * Math.atan(hFOVTanHalf / videoAspect) * 180 / Math.PI;
            }
            // For pillarbox: vFOV stays unchanged
            this.camera.aspect = videoAspect;
        }

        this.camera.updateProjectionMatrix();

        // Apply pan shift to the projection matrix for correct frustum culling
        if (this.syncVideoZoom || this.syncPixelZoomWithVideo) {
            const panSyncView = NodeMan.exists("video") ? NodeMan.get("video") : null;
            if (panSyncView) {
                const panX = panSyncView.panOffsetX ?? 0;
                const panY = panSyncView.panOffsetY ?? 0;
                if (panX !== 0 || panY !== 0) {
                    const oldFOV = this._lodSavedFov;
                    const baseFovHalfTan = Math.tan(oldFOV * Math.PI / 360);
                    const vidAspect = panSyncView.videoWidth / panSyncView.videoHeight;
                    const currFovHalfTan = Math.tan(this.camera.fov * Math.PI / 360);
                    const hScale = vidAspect * baseFovHalfTan / (this.camera.aspect * currFovHalfTan);
                    const vScale = baseFovHalfTan / currFovHalfTan;
                    const zoom = this.camera.zoom;
                    this.camera.projectionMatrix.elements[8] += 2 * panX * hScale * zoom;
                    this.camera.projectionMatrix.elements[9] -= 2 * panY * vScale * zoom;
                    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
                }
            }
        }

        // Apply the Y-compress vertical frustum expansion for LOD/culling too, so
        // terrain tile selection sees the same widened vertical frustum that the
        // render pass uses. Without this, tiles outside the un-squashed frustum
        // never load and the squashed view shows black gaps.
        // restoreCameraAfterLOD() rebuilds the matrix from fov/aspect/zoom, undoing this.
        if (this.yCompress !== undefined && this.yCompress > 1.0001) {
            this.camera.projectionMatrix.elements[5] /= this.yCompress;
            this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
        }
    }

    restoreCameraAfterLOD() {
        if (this._lodSavedZoom !== undefined) {
            this.camera.zoom = this._lodSavedZoom;
            this.camera.fov = this._lodSavedFov;
            this.camera.aspect = this._lodSavedAspect;
            this.camera.updateProjectionMatrix();
            this._lodSavedZoom = undefined;
            this._lodSavedFov = undefined;
            this._lodSavedAspect = undefined;
            if (this._lodSavedQuaternion) {
                this.removeCameraOffset(this._lodSavedQuaternion);
                this.camera.updateMatrixWorld();
                this._lodSavedQuaternion = undefined;
            }
            if (this._lodSavedDisplayLookAt) {
                this.removeDisplayLookAt(this._lodSavedDisplayLookAt);
                this._lodSavedDisplayLookAt = undefined;
            }
        }
    }

    getAtmosphereDensity() {
        const visibilityMeters = Math.max(1000, this.atmosphereVisibilityKm * 1000);
        return Math.sqrt(Math.log(2)) / visibilityMeters;
    }

    getAtmosphereSkyColor() {
        this._atmosphereSkyColor.copy(this.background);

        const sunNode = NodeMan.get("theSun", false);
        if (sunNode) {
            const skyColor = sunNode.calculateSkyColor(this.camera.position);
            if (skyColor) {
                this._atmosphereSkyColor.copy(skyColor);
            }
        }

        return this._atmosphereSkyColor;
    }

    getAtmosphereHazeColorSRGB(target = this._atmosphereHazeColorSRGB) {
        const sunNode = NodeMan.get("theSun", false);
        if (!sunNode?.calculateHazeColors) {
            return target.copy(this.background);
        }

        const haze = sunNode.calculateHazeColors(this.camera.position, undefined, {
            visibilityKm: this.atmosphereVisibilityKm,
            sunAngle: Globals.sunAngle,
        });
        return target.copy(haze.cool);
    }

    getAtmosphereHazeColorLinear(target = this._atmosphereHazeColorLinear) {
        target.copy(this.getAtmosphereHazeColorSRGB(this._atmosphereHazeColorSRGB));
        return target.convertSRGBToLinear();
    }

    isXRPresenting() {
        return this.renderer?.xr?.isPresenting ?? (this.renderer?.xr?.getSession?.() != null);
    }

    get effectiveAtmosphereHaze() {
        return this.atmosphereEnabled;
    }

    get effectiveSkyGradient() {
        if (!this.skyGradient && !this.effectiveAtmosphereHaze) return false;
        if (!this.atmosphereEnabled) return false;
        if (Globals.isMobile && !this.effectiveAtmosphereHaze && !this.allowMobileSkyGradient) return false;
        if (this.id !== "lookView") return false;
        if (this.isIR) return false;
        if (this.isXRPresenting()) return false;
        if (GlobalDaySkyScene !== undefined) return false;
        return true;
    }

    get effectiveAerialPerspective() {
        if (!this.effectiveAtmosphereHaze && !this.skyGradient) return false;
        if (!this.atmosphereEnabled) return false;
        if (this.id !== "lookView") return false;
        if (this.isIR) return false;
        if (this.isXRPresenting()) return false;
        if (GlobalDaySkyScene !== undefined) return false;
        return true;
    }

    // `camera` defaults to the view's own, but can be overridden to ask for the
    // sky as some OTHER camera sees it — the water planar mirror renders the
    // sky gradient from a camera reflected through the lake, and this view's
    // camera is a getter onto the camera node, so it cannot simply be swapped.
    populateAtmosphereRayUniforms(uniforms, {linear = false, camera = this.camera} = {}) {
        const sunNode = NodeMan.get("theSun", false);
        const visT = Math.max(0, Math.min(1, (50 - this.atmosphereVisibilityKm) / 45));
        const blueBoost = 0.35 + 0.25 * visT;
        let skyColor = this.getAtmosphereSkyColor();
        // The blue-boost target is a fixed daylight zenith blue; during a
        // solar eclipse it must darken with the sky or the gradient path
        // stays bright through totality. Factor is exactly 1 otherwise.
        const eclipseSky = sunNode?.calculateEclipseSkyFactor
            ? sunNode.calculateEclipseSkyFactor(camera.position) : 1;
        this._atmosphereBlueZenithScaled.copy(this._atmosphereBlueZenith).multiplyScalar(eclipseSky);
        this._atmosphereZenithColor.copy(skyColor).lerp(this._atmosphereBlueZenithScaled, blueBoost);

        const assignColor = (uniform, color) => {
            uniform.value.copy(color);
            if (linear) uniform.value.convertSRGBToLinear();
        };
        assignColor(uniforms.zenithColor, this._atmosphereZenithColor);

        const haze = sunNode?.calculateHazeColors
            ? sunNode.calculateHazeColors(camera.position, undefined, {
                visibilityKm: this.atmosphereVisibilityKm,
                sunAngle: Globals.sunAngle,
            })
            : null;
        if (haze) {
            assignColor(uniforms.coolHorizon, haze.cool);
            assignColor(uniforms.warmHorizon, haze.warm);
            uniforms.warmStrength.value = haze.warmStrength;
        } else {
            this._aerialPerspectiveSkyColor.copy(this.getAtmosphereHazeColorSRGB());
            assignColor(uniforms.coolHorizon, this._aerialPerspectiveSkyColor);
            assignColor(uniforms.warmHorizon, this._aerialPerspectiveSkyColor);
            uniforms.warmStrength.value = 0;
        }

        const e = camera.matrixWorld.elements;
        uniforms.cameraWorldX.value.set(e[0], e[1], e[2]).normalize();
        uniforms.cameraWorldY.value.set(e[4], e[5], e[6]).normalize();
        uniforms.cameraWorldZ.value.set(e[8], e[9], e[10]).normalize();

        const cameraWorldPosition = this._scratchVec.setFromMatrixPosition(camera.matrixWorld);
        const upWorld = getLocalUpVector(cameraWorldPosition).normalize();
        uniforms.upWorld.value.copy(upWorld);
        uniforms.upCamera.value.set(
            upWorld.dot(uniforms.cameraWorldX.value),
            upWorld.dot(uniforms.cameraWorldY.value),
            upWorld.dot(uniforms.cameraWorldZ.value),
        ).normalize();

        uniforms.cameraTanHalfFov.value = Math.tan(camera.fov * Math.PI / 360);
        uniforms.cameraAspect.value = camera.aspect;
        const cameraLLA = ECEFToLLAVD_radii(cameraWorldPosition);
        const cameraAltM = Math.max(cameraLLA.z, 0);
        uniforms.horizonDip.value = Math.min(Math.sqrt(2 * cameraAltM / wgs84.RADIUS), 0.08);
        uniforms.horizonHazeBand.value = 0.015 + 0.04 * visT;
        if (uniforms.cameraAltitudeM) {
            uniforms.cameraAltitudeM.value = cameraAltM;
        }

        const sunPos = Globals.sunLight?.position;
        if (sunPos) {
            const sunDirWorld = this._sunDirScratch.copy(sunPos).sub(cameraWorldPosition).normalize();
            this._scratchVec.copy(upWorld).multiplyScalar(sunDirWorld.dot(upWorld));
            const horiz = uniforms.sunDirHoriz.value.copy(sunDirWorld).sub(this._scratchVec);
            if (horiz.lengthSq() > 1e-8) {
                horiz.normalize();
            } else {
                horiz.set(1, 0, 0);
            }
        } else {
            uniforms.sunDirHoriz.value.set(1, 0, 0);
        }
    }

    // V5 shadows: effective gate. Requires BOTH the lighting master and
    // this view's per-view flag. Mobile gets auto-disabled unless
    // allowMobileShadows is also set.
    areShadowsEffective() {
        const lighting = NodeMan.get("lighting", false);
        if (lighting && !lighting.shadowsEnabled) return false;
        if (!this.shadowsEnabled) return false;
        if (Globals.isMobile && !this.allowMobileShadows) return false;
        if (this.id !== "mainView" && this.id !== "lookView") return false;
        return true;
    }

    // V5 shadows: lazy viewSun + per-view renderer.shadowMap.enabled flip.
    // Called from CNodeLighting.applyShadowConfig on transition or knob change.
    // §0 short-circuit: when this view is off, has never been on, and the
    // renderer's shadowMap is off, returns immediately with zero side effects.
    applyShadowRendererConfig({transitioned = false} = {}) {
        if (!this.renderer) return;

        const effective = this.areShadowsEffective();
        if (!effective
            && !this.renderer.shadowMap.enabled
            && !transitioned
            && !this._didEverEnableShadows) {
            return;
        }

        // Lazy-create viewSun on first effective-on.
        if (effective && !this.viewSun) {
            this._lazyCreateViewSun();
        }

        // Push tunable updates to existing viewSun (size, bias, frustum).
        if (this.viewSun) {
            this._applyShadowTunablesToViewSun();
        }

        const want = effective;
        if (this.renderer.shadowMap.enabled !== want) {
            this.renderer.shadowMap.enabled = want;
            this._pendingMaterialRefresh = true;
        }
        if (want && this.renderer.shadowMap.type !== PCFShadowMap) {
            this.renderer.shadowMap.type = PCFShadowMap;
        }

        // Reset throttle on OFF→ON so the next frame fires immediately.
        if (transitioned && want) {
            this._lastShadowSunDir = null;
            this._lastShadowUpdateMs = 0;
        }
    }

    // Push lighting-node tunables into the viewSun. Allocates a shadow map of
    // the configured size; safe to call repeatedly (Three.js disposes the old
    // texture lazily when mapSize changes by re-creating the render target on
    // next render).
    _applyShadowTunablesToViewSun() {
        const lighting = NodeMan.get("lighting", false);
        if (!lighting || !this.viewSun) return;
        const size = lighting.shadowMapSize ?? 1024;
        if (this.viewSun.shadow.mapSize.x !== size) {
            this.viewSun.shadow.mapSize.set(size, size);
            // Dispose old render target so the next render reallocates at the
            // new size (Three.js doesn't auto-resize an existing one).
            if (this.viewSun.shadow.map) {
                this.viewSun.shadow.map.dispose();
                this.viewSun.shadow.map = null;
                Globals.shadowDiagCounters.shadowMapAllocations++;
            }
            // Force a shadow-pass render next frame. Without this, autoUpdate
            // is false AND the _lastShadowStateKey gate in _enterShadowRenderScope
            // doesn't notice the size change (it keys off camera/sun position,
            // not map resolution), so the freshly-nulled shadow.map never gets
            // repopulated until the user moves the camera — leaving receivers
            // sampling from a missing texture and the scene appearing blank.
            this.viewSun.shadow.needsUpdate = true;
        }
        this.viewSun.shadow.bias = lighting.shadowBias ?? -0.0005;
        this.viewSun.shadow.normalBias = lighting.shadowNormalBias ?? 5;
        // Seed the frustum at the user's shadowRadius so first-render produces
        // a valid projection matrix even before _enterShadowRenderScope runs.
        this._applyShadowFrustum(lighting.shadowRadius ?? 1000);
    }

    // Compute (anchor, extent) for the shadow frustum:
    //   anchor: ground point the camera is looking at (ray-sphere intersection
    //           of the camera forward with the WGS84 earth sphere). Falls
    //           back to camera.position when the forward ray misses ground
    //           (e.g. looking at the sky).
    //   extent: ortho half-width sized to cover the camera's visible footprint
    //           at the anchor distance (tan(fov/2) × dist × safety), floored
    //           at the user's shadowRadius setting so close-up scenes still
    //           get a usable patch of shadow, and capped to prevent absurd
    //           values when looking nearly parallel to the ground.
    // This works at every scale: a street-level camera focuses a tight patch
    // on the building in front, a 6000-ft helicopter view focuses on the
    // skyscrapers it's actually looking at, and an ISS-altitude 0.1°-FOV
    // shot focuses on the few-hundred-metre patch the narrow cone hits.
    _computeShadowAnchorAndExtent() {
        const lighting = NodeMan.get("lighting", false);
        const userMinR = lighting?.shadowRadius ?? 1000;
        if (!this._shadowAnchorScratch) this._shadowAnchorScratch = new Vector3();
        if (!this._shadowRayDir) this._shadowRayDir = new Vector3();

        const anchor = this._shadowAnchorScratch;
        const camPos = this.camera.position;
        const dir = this._shadowRayDir;
        this.camera.getWorldDirection(dir);

        // Anchor: where the view center hits the ground. We can't use a
        // fixed-radius equatorial sphere here (Globals.equatorRadius is the
        // WGS84 equatorial radius; at mid-latitudes the actual geocentric
        // surface is several km below it, so a camera flying a couple of
        // km above the real ground sits MATHEMATICALLY INSIDE that sphere
        // and any ray-sphere intersection is meaningless).
        //
        // Instead, compute the geocentric ellipsoid radius at the camera's
        // own latitude and intersect with a sphere of that radius. This
        // tracks the real ellipsoid surface within the sub-degree of
        // latitude variation covered by a single view.
        const camLen = camPos.length();
        let groundRadius;
        if (camLen > 1) {
            const sinLat = camPos.z / camLen;
            const cosLatSq = 1 - sinLat * sinLat;
            const a = wgs84.RADIUS;
            const b = wgs84.POLAR_RADIUS;
            groundRadius = 1 / Math.sqrt(cosLatSq / (a * a) + (sinLat * sinLat) / (b * b));
        } else {
            groundRadius = wgs84.RADIUS;
        }

        // Solve |camPos + t * dir|^2 = groundRadius^2 for the near
        // intersection root t0 = -B - sqrt(disc). Only t0 is ever useful —
        // it's the entry point ahead of the camera along the forward ray.
        // The far root t1 = -B + sqrt(disc) is the exit point on the
        // OPPOSITE SIDE of the planet, ~12,700 km away, which is nonsense as
        // a shadow anchor. We must never fall through to t1, even when t0
        // is negative.
        const B = camPos.dot(dir);                          // dir is unit
        const C = camLen * camLen - groundRadius * groundRadius;
        const disc = B * B - C;
        let dist;
        if (disc >= 0) {
            const t0 = -B - Math.sqrt(disc);
            if (t0 > 1e-3) dist = t0;
        }
        if (dist !== undefined) {
            anchor.set(camPos.x + dir.x * dist, camPos.y + dir.y * dist, camPos.z + dir.z * dist);
        } else {
            // No usable forward ground hit. Two cases land here:
            //   1. Camera looking up at the sky (disc < 0).
            //   2. Camera sitting AT or BELOW the WGS84 ellipsoid surface
            //      (t0 ≤ 0). Geoid undulation can put real-world street
            //      level a few metres below the ellipsoid, so a walking-
            //      around camera at MSL ground level commonly has HAE ≈ -1
            //      to -50 m.
            // Anchor at the camera position; the extent floor (userMinR)
            // then gives a sensible local frustum that covers nearby
            // buildings and street.
            anchor.copy(camPos);
            dist = userMinR;
        }

        // Size the ortho frustum from the visible footprint at the anchor.
        // Multiply by a safety factor to cover:
        //   - oblique viewing (tilted cameras see an elongated ground patch
        //     larger than the FOV cone at the anchor)
        //   - casters/receivers just outside the strict viewport whose
        //     shadows should still fall into the visible area
        const fovRad = this.camera.fov * Math.PI / 180;
        const zoom = this.camera.zoom || 1;
        const aspect = this.camera.aspect || 1;
        const halfHeight = (Math.tan(fovRad / 2) * dist) / zoom;
        const halfWidth = halfHeight * aspect;
        const SAFETY = 2.5;
        let extent = Math.max(halfWidth, halfHeight) * SAFETY;
        // Floor at userMinR so close-up scenes still get a usable patch.
        extent = Math.max(extent, userMinR);
        // Upper cap so wide-FOV near-horizontal views don't blow up the
        // shadow camera's working depths (extent feeds dist=extent*10 below).
        // 100 km is wider than any realistic visible ground patch.
        extent = Math.min(extent, 100000);
        return {anchor, extent};
    }

    // Apply ortho frustum bounds + depth range to viewSun's shadow camera
    // using the dynamically-computed extent. Stores the active extent on the
    // view so callers can mirror it when offsetting the shadow camera along
    // the sun ray.
    _applyShadowFrustum(extent) {
        if (!this.viewSun) return;
        const cam = this.viewSun.shadow.camera;
        cam.left = -extent;
        cam.right = extent;
        cam.top = extent;
        cam.bottom = -extent;
        // The shadow camera sits 10×extent away along the sun ray; pad ±3×extent
        // for caster/receiver depth (a typical building is much smaller than
        // extent, so this is generous).
        const dist = extent * 10;
        cam.near = Math.max(1, dist - extent * 3);
        cam.far = dist + extent * 3;
        cam.updateProjectionMatrix();
        this._activeShadowExtent = extent;
    }

    // V5 shadows: render-scoped sun swap. Called from renderTargetAndEffects()
    // when Globals.shadowsEnabled. Returns a restore function; even if the
    // render throws, the finally block reverses all state.
    _enterShadowRenderScope() {
        const prevSunVisible = Globals.sunLight.visible;
        const otherSuns = [];

        // Hide every viewSun first.
        NodeMan.iterate((id, node) => {
            if (node.constructor.name !== "CNodeView3D") return;
            if (node.viewSun) {
                otherSuns.push({node, wasVisible: node.viewSun.visible});
                node.viewSun.visible = false;
            }
        });

        // ALWAYS use this view's viewSun (lazy-creating if it doesn't exist
        // yet) and ALWAYS keep its castShadow flag true while Globals.shadowsEnabled.
        // The per-view shadowsEnabled toggle is expressed via shadow.intensity:
        //   effective → intensity = 1 (full shadow contribution)
        //   not effective → intensity = 0 (light still in shadow array, but
        //   the shader's shadow term multiplies by 0 → no visible shadow)
        // This keeps WebGLLights' state.directional / state.directionalShadow
        // counts STABLE across toggle transitions, so compiled shaders never
        // mismatch the runtime uniforms upload. Without this stability we'd
        // hit "Cannot read properties of undefined (reading 'shadowIntensity')"
        // when a material compiled with NUM_DIR_LIGHT_SHADOWS=1 was rendered
        // with state.directionalShadow.length=0 (or vice-versa).
        if (!this.viewSun) {
            this._lazyCreateViewSun();
        }
        const effective = this.areShadowsEffective();
        Globals.sunLight.visible = false;
        this.viewSun.visible = true;
        this.viewSun.castShadow = true;
        this.viewSun.shadow.intensity = effective ? 1 : 0;
        this.viewSun.intensity = Globals.sunLight.intensity;
        this.viewSun.color.copy(Globals.sunLight.color);
        const sunDir = Globals.sunLight.position;
        const sunLen = sunDir.length() || 60000;
        // Compute the anchor (ground point the camera is looking at) and the
        // extent (size of the ortho frustum needed to cover the visible
        // footprint). Apply the frustum BEFORE positioning the light so we
        // can use the computed extent to scale the sun-ray offset.
        const {anchor, extent} = this._computeShadowAnchorAndExtent();
        this._applyShadowFrustum(extent);
        const k = (extent * 10) / sunLen;
        const newSunX = anchor.x + sunDir.x * k;
        const newSunY = anchor.y + sunDir.y * k;
        const newSunZ = anchor.z + sunDir.z * k;
        // Compose an "invalidation state" key: any change to the shadow
        // camera's effective configuration must trigger a fresh depth-pass
        // render. Without this, zooming/FOV-changing/aspect-changing the view
        // would leave a stale depth map sampled by the new screen footprint
        // — exactly the "zoom out → shadows in wrong place / vanish" bug.
        const stateKey = newSunX + "|" + newSunY + "|" + newSunZ
            + "|" + extent
            + "|" + this.camera.fov
            + "|" + (this.camera.aspect || 1)
            + "|" + (this.camera.zoom || 1)
            + "|" + (Globals.shadowCastersDirtyVersion || 0);
        if (this._lastShadowStateKey !== stateKey) {
            this.viewSun.shadow.needsUpdate = true;
            this._lastShadowStateKey = stateKey;
        }
        this.viewSun.position.set(newSunX, newSunY, newSunZ);
        this.viewSun.target.position.copy(anchor);
        this.viewSun.target.updateMatrixWorld();
        if (this._exportForceFrustumRefit) {
            this.viewSun.shadow.needsUpdate = true;
            this._exportForceFrustumRefit = false;
        }
        const previousStableShadowLight = setStableShadowReceiverLight(this.viewSun);

        // Per-view terrain material swap. Three.js's ShaderMaterial does NOT
        // clone uniforms into materialProperties — it points materialProperties.
        // uniforms AT material.uniforms directly. When both renderers use the
        // same terrain material, each renderer's setupLights writes its own
        // lights state into material.uniforms.directionalLightShadows.value
        // (and directionalShadowMatrix.value). Last-writer-wins corruption.
        //
        // Fix: swap each terrain mesh.material to a per-view clone of the
        // canonical material. The clone has fresh, independent lights
        // uniforms but SHARES every non-lights uniform by reference so live
        // values (Globals.sunLight.position, sharedUniforms.*, the tile
        // texture) still update everywhere.
        //
        // This must happen BEFORE renderer.render() — onBeforeRender is too
        // late, because Three pulls renderItem.material from the render list
        // before object.onBeforeRender fires.
        const swapList = this._terrainMaterialSwapList ??= [];
        swapList.length = 0;
        const viewId = this.id;
        NodeMan.iterate((id, node) => {
            if (node.constructor.name !== "CNodeTerrain" || !node.group) return;
            node.group.traverse(mesh => {
                if (!mesh.isMesh || !mesh.material) return;
                if (!mesh.material.userData?.isTerrainDayNight) return;
                if (mesh.material.userData?.isPerViewClone) return; // already a clone
                let perView = mesh._terrainPerViewMaterials;
                if (!perView) {
                    perView = mesh._terrainPerViewMaterials = new Map();
                }
                let clone = perView.get(viewId);
                if (!clone) {
                    clone = cloneTerrainDayNightMaterialForView(mesh.material);
                    perView.set(viewId, clone);
                }
                swapList.push({mesh, orig: mesh.material});
                mesh.material = clone;
            });
        });
        installStableShadowReceivers(GlobalScene);

        return () => {
            // Restore canonical terrain materials FIRST so that the next
            // view's swap sees the canonical material (and can install its
            // own clone). If we restored after viewSun toggling, a transient
            // window with cloned-but-stale material could leak.
            for (const {mesh, orig} of swapList) {
                mesh.material = orig;
            }
            swapList.length = 0;
            if (this.viewSun) this.viewSun.visible = false;
            for (const {node, wasVisible} of otherSuns) {
                if (node.viewSun) node.viewSun.visible = wasVisible;
            }
            Globals.sunLight.visible = prevSunVisible;
            setStableShadowReceiverLight(previousStableShadowLight);
        };
    }

    // Extracted from applyShadowRendererConfig so the swap path can lazily
    // create a viewSun for views that never had shadows toggled on but are
    // now being rendered inside Globals.shadowsEnabled scope (because another
    // view does have shadows on).
    _lazyCreateViewSun() {
        if (this.viewSun) return;
        this.viewSun = new DirectionalLight(0xFFFFFF, 0);
        this.viewSun.visible = false;
        this.viewSun.castShadow = true;
        this.viewSun.shadow.autoUpdate = false;
        this.viewSun.shadow.intensity = 1;
        this.viewSun.layers.mask = LAYER.MASK_LIGHTING;
        // Restrict THIS view's shadow camera to casters on THIS view's layer
        // so we don't pick up the OTHER view's separate-LOD copies of the same
        // buildings — those are different meshes at near-identical world
        // positions, and rendering both into the same depth map produces
        // z-fighting / fattened shadow silhouettes. Without this restriction
        // mainView's shadow map was contaminated by lookView's building tiles
        // (and vice-versa).
        const myLayer = (this.id === "lookView") ? LAYER.MASK_LOOK : LAYER.MASK_MAIN;
        this.viewSun.shadow.camera.layers.mask = myLayer;
        this._applyShadowTunablesToViewSun();
        GlobalScene.add(this.viewSun);
        this.viewSun.target.position.set(0, 0, 0);
        GlobalScene.add(this.viewSun.target);
        Globals.shadowDiagCounters.viewSunCreations++;
        this._didEverEnableShadows = true;
    }

    pushLookViewAtmosphereFog() {
        if (this.id !== "lookView" || !this.atmosphereEnabled || !this.scene) {
            return null;
        }

        if (this.effectiveAerialPerspective) {
            return null;
        }

        if (this.effectiveAtmosphereHaze || this.skyGradient) {
            this._lookViewFog.color.copy(this.getAtmosphereHazeColorLinear());
        } else {
            // Preserve the legacy color-space behavior for existing sitches.
            this._lookViewFog.color.copy(this.getAtmosphereSkyColor());
        }
        this._lookViewFog.density = this.getAtmosphereDensity();

        const previousFog = this.scene.fog;
        this.scene.fog = this._lookViewFog;
        return {previousFog};
    }

    popLookViewAtmosphereFog(state) {
        if (!state || !this.scene) return;
        this.scene.fog = state.previousFog;
    }

    getCameraOffset() {
        let ptzController = null;
        for (const inputID in this.cameraNode.inputs) {
            const input = this.cameraNode.in[inputID];
            if (input && input.xOffset !== undefined) {
                ptzController = input;
                break;
            }
        }
        if (!ptzController) return { xOffset: 0, yOffset: 0 };
        return { 
            xOffset: ptzController.xOffset || 0, 
            yOffset: ptzController.yOffset || 0 
        };
    }

    setupRenderPipeline(v) {
        // Use dimensions already computed by CNodeView constructor's updateWH().
        // Do NOT read from DOM via setFromDiv here — the browser may not have
        // completed layout yet, which causes intermittent zero dimensions and
        // NaN propagation into WebGL (renderbuffer/framebuffer errors).
        // The per-frame render loop calls setFromDiv to pick up later changes.
        this.widthDiv = this.widthPx;
        this.heightDiv = this.heightPx;

        // Determine canvas dimensions
        if (this.in.canvasWidth !== undefined) {
            this.widthPx = this.in.canvasWidth.v0;
            this.heightPx = this.in.canvasHeight.v0;
        } else {
            this.widthPx = this.widthDiv * window.devicePixelRatio;
            this.heightPx = this.heightDiv * window.devicePixelRatio;
        }

        // Apply resolution scaling for side-by-side rendering on integrated GPU
        // Reduces internal rendering resolution by ~70% when both views are visible
        // This dramatically improves performance on Windows integrated graphics
        // while maintaining visual quality (CSS scaling blurs imperceptibly)
        if (ViewMan.isSideBySideMode()) {
            const sideBySideResolutionScale = 0.7; // ~50% pixel reduction (0.7^2 ≈ 0.49)
            this.widthPx = Math.floor(this.widthPx * sideBySideResolutionScale);
            this.heightPx = Math.floor(this.heightPx * sideBySideResolutionScale);
        }

        this.canvas.width = this.widthPx;
        this.canvas.height = this.heightPx;

        // Create the renderer

        try {
            this.renderer = new WebGLRenderer({
                antialias: true,
                canvas: this.canvas,
                logarithmicDepthBuffer: true,
            });
        } catch (e) {
            showError("Incompatible Browser or Graphics Acceleration Disabled\n Error creating WebGLRenderer: " + e)
            // show an alert
            alert("Incompatible Browser or Graphics Acceleration Disabled\n Error creating WebGLRenderer:\n " + e)


            return;
        }

        if (!isLocal) {
            console.warn("Disabling shader error checking for production performance");
            this.renderer.debug.checkShaderErrors = false;
        }

        // Pin WebGL programs so they're never released. Three.js's
        // releaseProgram disposes a program when its usedTimes drops to 0,
        // which causes thrash for any code path that recreates materials
        // per-frame or per-tile (notably TilesDayNightPlugin, which makes a
        // fresh DayNightStandardMaterial for every 3D-tiles mesh that
        // arrives during panning). The tile lifecycle outpaces program
        // re-use, so programs were being compiled, used briefly, disposed,
        // and recompiled — costing ~14% CPU in getProgramInfoLog /
        // getProgramParameter sync waits during active panning.
        // The fix: clamp usedTimes to a getter that always reads >= 2 so
        // the `if (--usedTimes === 0)` check inside releaseProgram never
        // fires. Programs accumulate, but in practice the working set is
        // bounded by unique material configurations (~30–50), trading a
        // bounded ~1–2 MB of GPU memory for elimination of per-tile shader
        // recompiles. Wrapping render() catches any program created during
        // the most-recent draw call.
        const origRender = this.renderer.render.bind(this.renderer);
        const renderer = this.renderer;
        this.renderer.render = function (...args) {
            origRender(...args);
            const programs = renderer.info.programs;
            if (!programs) return;
            for (const p of programs) {
                if (p.__pinned) continue;
                let v = p.usedTimes;
                Object.defineProperty(p, 'usedTimes', {
                    configurable: true,
                    get() { return Math.max(2, v); },
                    set(x) { v = x; },
                });
                p.__pinned = true;
            }
        };

        const basePixelRatio = this.in.canvasWidth ? 1 : window.devicePixelRatio;
        this.renderer.setPixelRatio(basePixelRatio * getEffectiveRenderScale());
        this.renderer.setSize(this.widthDiv, this.heightDiv, false);
        this.renderer.outputColorSpace = SRGBColorSpace;

        // WebGL context-loss handlers are installed below (after render-target
        // setup) so the restore path can re-create everything in one place.

        // Bind GPU Memory Monitor to mainView's renderer (canonical reference).
        // Sitches like gimbal create multiple CNodeView3Ds (podBack, podsEye,
        // …); without picking a specific view, "last one wins" leaves the
        // monitor bound to whichever view happened to construct last.
        // Re-attach on every sitch reload — disposeEverything() calls
        // forceContextLoss() on the previous renderer.
        if (isLocal && this.id === "mainView") {
            if (!Globals.GPUMemoryMonitor) {
                try {
                    const monitor = new GPUMemoryMonitor(this.renderer, GlobalScene);
                    setGPUMemoryMonitor(monitor);
                    window._gpuMonitor = monitor;
                } catch (e) {
                    console.error("[CNodeView3D] Error initializing GPU Memory Monitor:", e);
                }
            } else {
                Globals.GPUMemoryMonitor.setRenderer(this.renderer);
                Globals.GPUMemoryMonitor.setScene(GlobalScene);
            }
        }
        if (Globals.shadowsEnabled) {
            this.renderer.shadowMap.enabled = true;
        }

        this.useLookViewHDR = false;
        if (this.requestLookViewHDR) {
            const hasFloatColorBuffer = this.renderer.extensions.has('EXT_color_buffer_float');
            this.useLookViewHDR = this.renderer.capabilities.isWebGL2 && hasFloatColorBuffer;
            if (!this.useLookViewHDR) {
                console.warn("lookView HDR atmosphere disabled: floating-point color buffers are not supported on this GPU/browser");
            }
        }

        this.createRenderTargets();

        // Ensure GlobalScene and this.camera are defined
        if (!GlobalScene || !this.camera) {
            showError("GlobalScene or this.camera is not defined.");
            return;
        }

        // Shader material for copying render target to screen.
        // Render targets store linear data; the sRGBOutput uniform enables
        // linear→sRGB encoding for correct display (debug toggle in Render Debug menu).
        // https://discourse.threejs.org/t/different-color-output-when-rendering-to-webglrendertarget/57494
        this.copyMaterial = new ShaderMaterial({
            uniforms: {
                'tDiffuse': {value: null},
                'sRGBOutput': {value: false},
            },
            vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `,
            fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse;
            uniform bool sRGBOutput;
            varying vec2 vUv;
            void main() {
                gl_FragColor = texture2D(tDiffuse, vUv);
                if (sRGBOutput) {
                    gl_FragColor = linearToOutputTexel( gl_FragColor );
                }
            }
        `
        });

        // Fullscreen quad for rendering shaders
        const geometry = new PlaneGeometry(2, 2);
        this.fullscreenQuad = new Mesh(geometry, this.copyMaterial);

        this.hdrToneMappingPass = this.useLookViewHDR ? new ShaderPass(ACESFilmicToneMappingShader) : null;

        this.effectPasses = {};

        this.preRenderFunction = v.preRenderFunction ?? (() => {
        });
        this.postRenderFunction = v.postRenderFunction ?? (() => {
        });


        // WebGL context-loss recovery.
        //
        // Without preventDefault on `webglcontextlost`, the browser will not
        // fire `webglcontextrestored` and the only way out is a page reload.
        // With preventDefault + the restore handler below, we can survive an
        // organic GPU-process death (typically VRAM pressure on long sessions)
        // and re-establish renderer state without losing the loaded sitch.
        //
        // What goes wrong if recovery is incomplete:
        // - render targets hold dead GL textures/framebuffers; the next render
        //   binds them and produces undefined behaviour or a blank screen
        // - the renderer's pixel ratio and canvas size get reset to defaults,
        //   surfacing as the "video at half size" symptom we saw on Cheyenne
        // - pinned-program metadata (the __pinned hack on usedTimes) leaks
        //   onto programs whose GL-side counterparts are gone
        // Stored as bound references (not anonymous listeners) so dispose() can
        // removeEventListener them. dispose() deliberately calls forceContextLoss()
        // to free the GPU context; if these handlers stayed registered, that forced
        // (asynchronously-dispatched) webglcontextlost event would fire on an
        // already-disposed view whose this.renderer has been nulled. Owning the
        // listener lifecycle — added here, removed in dispose() — is the fix.
        this._onContextLost = (e) => {
            e.preventDefault();
            this.contextLost = true;
            console.warn(`[WebGL] Context LOST on view "${this.id}"`);
            // Drop JS-side render-target handles; their GL backing is gone.
            // The restore handler will recreate them. Until then, renderCanvas
            // short-circuits on this.contextLost so no GL calls are issued.
            this.disposeRenderTargets();
            // Clear program-pin metadata: Three.js's program list is wiped on
            // context loss, so __pinned would otherwise dangle.
            if (this.renderer.info?.programs) {
                for (const p of this.renderer.info.programs) p.__pinned = false;
            }
        };

        this._onContextRestored = () => {
            console.warn(`[WebGL] Context restored on view "${this.id}"`);
            this.contextLost = false;
            // Re-establish per-view renderer state: setPixelRatio + recreate
            // render targets. applyPerformanceSettings already does both.
            this.applyPerformanceSettings();
            // Invalidate the per-frame size-sync dedupe cache so the next
            // render's size-sync block re-applies setSize unconditionally.
            this._lastSyncedRendererWidth = undefined;
            this._lastSyncedRendererHeight = undefined;

            // Force every 2D-canvas view to re-establish its DPR scale
            // transform. The GPU process crash silently wipes the 2D
            // context's transform state but leaves canvas.width/height in
            // place, so adjustSize/ensureContextScaled's "only re-scale
            // when dimensions change" gate never trips. Without this,
            // overlay views (compass, time, tile-stats, video) draw
            // unscaled into a DPR-sized backing store and CSS displays
            // them at half size on a 2× DPR display — exactly the symptom
            // the user reports persists across context loss until a
            // window resize fixes it. forceContextRescale invalidates the
            // canvas state so the next render picks up a fresh scale.
            ViewMan.iterate((id, view) => {
                if (typeof view.forceContextRescale === "function") {
                    view.forceContextRescale();
                }
            });

            // Trigger the SAME global resize path that a real window-resize
            // event takes. updateSize(true) calls updateWH on every view,
            // updateMatLineResolution (LineMaterial pixel-width uniform),
            // ViewMan.updateSize, infoDiv font size, chart sizes, and
            // setRenderOne. Note: the 2D-canvas half-size recovery is
            // handled by forceContextRescale above, not by this call —
            // updateSize alone doesn't trigger it because widthPx hasn't
            // changed (the window is the same size; only the GL context
            // died). Dynamic import avoids a static circular dependency
            // between JetStuff.js and CNodeView3D.js.
            import('../JetStuff').then(m => m.updateSize(true)).catch(err => {
                console.error('[WebGL] updateSize after restore failed:', err);
            });
            // Refresh terrain so its tile textures are re-uploaded; data is
            // already in CPU memory so this is fast.
            const terrainNode = NodeMan.get("terrainUI", false);
            if (terrainNode) terrainNode.doRefresh();
        };

        this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
        this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
    }


    renderTargetAndEffects() {
        {

            if (this.visible) {

                // Guard: skip rendering if dimensions are zero (race condition during initialization
                // where the browser hasn't completed layout before the first render frame).
                // The resize path will pick up valid dimensions on the next frame.
                if (this.widthPx <= 0 || this.heightPx <= 0) {
                    return;
                }

                if (globalProfiler) globalProfiler.push('#ffa500', 'rtSetup');
                // if the lookView, then check for the video view
                if (this.id === "lookView") {

                    let videoView = null;
                    // we default the the mirrorVideo, but if that doesn't exist, then we use the video view
                    if (NodeMan.exists("mirrorVideo")) {
                        videoView = NodeMan.get("mirrorVideo");
                    }
                    else if (NodeMan.exists("video")) {
                        videoView = NodeMan.get("video");
                    }

                    // Check if we should match the video's aspect ratio
                    const frustum = NodeMan.get(this.cameraNode.id + "_Frustum", false);
                    this._matchVideoAspect = frustum && frustum.matchVideoAspect;

                    // fovCoverage is the vertical fraction
                    // of the video view window that is covered by the video
                    // Always compute fovOverride (matchVideoAspect preserves hFOV from it)
                    if (videoView !== null && videoView.fovCoverage !== undefined) {
                        this.fovOverride = 180 / Math.PI * 2 * Math.atan(Math.tan(this.camera.fov * Math.PI / 360) / videoView.fovCoverage);
                    }
                }

                // fovOverride is used to override the camera FOV
                // to maintaim a consisten vertical FOV for the portion of the viewport
                // that matches the vertical extent of the caerma
                const oldFOV = this.camera.fov;
                if (this.fovOverride !== undefined) {
                    this.camera.fov = this.fovOverride;
                    this.camera.updateProjectionMatrix();
                }

                // Store the rendered FOV for use in rendering celestial labels
                this.camera.renderedFOV = this.camera.fov;

                // popogate the view-specific camera setting to the current camera
                // (currently this does not change, but it might in the future)
                this.cameraNode.northUp = this.northUp;


                let currentRenderTarget = null; // if no effects, we render directly to the canvas

                //if (this.effectsEnabled) {
                let width, height;
                if (this.in.canvasWidth !== undefined) {

                    const long = this.in.canvasWidth.v0;
                    if (this.widthPx > this.heightPx) {
                        width = long;
                        height = Math.floor(long * this.heightPx / this.widthPx);
                    } else {
                        height = long;
                        width = Math.floor(long * this.widthPx / this.heightPx);
                    }

                    // Apply side-by-side resolution scaling to render targets as well
                    if (ViewMan.isSideBySideMode()) {
                        const sideBySideResolutionScale = 0.7;
                        width = Math.floor(width * sideBySideResolutionScale);
                        height = Math.floor(height * sideBySideResolutionScale);
                    }

                } else {
                    width = this.widthPx;
                    height = this.heightPx;
                }

                // Height of the render target BEFORE Match Video Aspect narrows it, so the
                // fraction it ends up keeping can be published below for adjustPointScale.
                const heightBeforeMatch = height;

                // When matchVideoAspect is on, adjust the camera to show exactly
                // the video's aspect ratio. Two cases:
                // - Letterbox (video wider): preserve hFOV, narrow vFOV, reduce height
                // - Pillarbox (video taller): preserve vFOV, narrow hFOV, reduce width
                if (this._matchVideoAspect) {
                    const frustum = NodeMan.get(this.cameraNode.id + "_Frustum", false);
                    const videoAspect = frustum && frustum.videoAspect;
                    if (videoAspect) {
                        const viewAspect = width / height;

                        if (videoAspect > viewAspect) {
                            // Letterbox: video is wider → reduce height, preserve hFOV
                            const currentVFOVRad = this.camera.fov * Math.PI / 180;
                            const hFOVTanHalf = Math.tan(currentVFOVRad / 2) * this.camera.aspect;
                            const newVFOVRad = 2 * Math.atan(hFOVTanHalf / videoAspect);
                            this.camera.fov = newVFOVRad * 180 / Math.PI;
                            height = Math.floor(width / videoAspect);
                        } else {
                            // Pillarbox: video is taller → reduce width, preserve vFOV
                            // camera.fov (vFOV) stays unchanged
                            width = Math.floor(height * videoAspect);
                        }

                        this.camera.aspect = videoAspect;
                        this.camera.updateProjectionMatrix();
                        this.camera.renderedFOV = this.camera.fov;

                        // Store for re-application after renderSky() resets them
                        this._matchVideoAspectFOV = this.camera.fov;
                        this._matchVideoAspectAspect = videoAspect;
                    }
                }
                if (!this._matchVideoAspect) {
                    this._matchVideoAspectFOV = undefined;
                    this._matchVideoAspectAspect = undefined;
                }

                // The vertical fraction of the render target Match Video Aspect actually
                // draws into, published for adjustPointScale — camera.fov has narrowed to
                // match, so the pixel count it is paired with has to narrow with it or the
                // point sprites change size when the box is ticked.
                //
                // Taken from the render target rather than the canvas CSS box on purpose.
                // The two are NOT interchangeable: scripted-video rendering overrides
                // widthPx/heightPx to the output size and leaves the div at the live pane
                // size (ScriptRenderer.js renderViewAt), so a CSS-derived fraction would
                // describe a letterbox the exported frame never had. This form is a ratio of
                // two numbers from the same code path, so it is correct for the live pane,
                // canvasWidth targets and scripted output alike, and is exactly 1 when Match
                // Video Aspect is off.
                this.letterboxScaleY = heightBeforeMatch > 0 ? height / heightBeforeMatch : 1;

                // Letterbox CSS: center the canvas within its div when aspect doesn't match
                if (this._matchVideoAspect && !this._wasMatchingVideoAspect) {
                    this.div.style.backgroundColor = '#000';
                    this._wasMatchingVideoAspect = true;
                } else if (!this._matchVideoAspect && this._wasMatchingVideoAspect) {
                    this.canvas.style.width = '100%';
                    this.canvas.style.height = '100%';
                    this.canvas.style.left = '0px';
                    this.canvas.style.top = '0px';
                    this.div.style.backgroundColor = '';
                    this._wasMatchingVideoAspect = false;
                }
                if (this._matchVideoAspect) {
                    // Compute CSS dimensions from div size and video aspect
                    const divW = this.div.clientWidth;
                    const divH = this.div.clientHeight;
                    const videoAspect = width / height;  // already adjusted to ground aspect
                    const divAspect = divW / divH;
                    let cssW, cssH;
                    if (videoAspect > divAspect) {
                        cssW = divW;
                        cssH = Math.floor(divW / videoAspect);
                    } else {
                        cssH = divH;
                        cssW = Math.floor(divH * videoAspect);
                    }
                    this.canvas.style.width = cssW + 'px';
                    this.canvas.style.height = cssH + 'px';
                    this.canvas.style.left = ((divW - cssW) / 2) + 'px';
                    this.canvas.style.top = ((divH - cssH) / 2) + 'px';
                }

                // Skip rendering if computed dimensions are invalid (zero or NaN)
                if (!width || !height || width <= 0 || height <= 0) {
                    return;
                }

                // CRITICAL: Sync renderer size with current dimensions EVERY FRAME
                // This prevents race conditions where resize gestures cause frames to render
                // before the 100ms deferred resize completes. Deduping avoids redundant WebGL calls.
                if (width !== this._lastSyncedRendererWidth || height !== this._lastSyncedRendererHeight) {
                    this.renderer.setSize(width, height, false);
                    this._lastSyncedRendererWidth = width;
                    this._lastSyncedRendererHeight = height;
                }

                // Apply user-controlled performance render scale to the offscreen
                // render targets only. The renderer's canvas backing store is
                // shrunk separately via setPixelRatio() in setupRenderer; we must
                // NOT pass scaled dims to renderer.setSize() here because three.js
                // multiplies by pixelRatio internally — that would double-scale
                // and leave the look view's GL viewport mismatched with its
                // canvas.style dimensions.
                let rtWidth = width;
                let rtHeight = height;
                {
                    const rs = getEffectiveRenderScale();
                    if (rs !== 1) {
                        rtWidth = Math.max(1, Math.floor(width * rs));
                        rtHeight = Math.max(1, Math.floor(height * rs));
                    }
                }

                // Resize render targets to match final renderer dimensions
                // Note: renderer.setSize() is deferred 100ms, but widthPx/heightPx are current
                // So render targets use the current dimensions and will match once renderer catches up
                // Deduping prevents redundant GPU memory allocations during resize gestures
                if (rtWidth !== this.lastRenderTargetWidth || rtHeight !== this.lastRenderTargetHeight) {

                    this.renderTargetAntiAliased.setSize(rtWidth, rtHeight);
                    if (this.effectsEnabled || this.useLookViewHDR || this.effectiveAerialPerspective) {
                        this.renderTargetA.setSize(rtWidth, rtHeight);
                        this.renderTargetB.setSize(rtWidth, rtHeight);
                    }
                    this.lastRenderTargetWidth = rtWidth;
                    this.lastRenderTargetHeight = rtHeight;

                    // CRITICAL: Update canvas dimensions to match render target
                    // Otherwise canvas stays at init size and render target render at wrong resolution
                    if (this.in.canvasWidth !== undefined) {
                        this.canvas.width = rtWidth;
                        this.canvas.height = rtHeight;
                    }
                }

                currentRenderTarget = this.effectiveAerialPerspective ? this.renderTargetA : this.renderTargetAntiAliased;
                this.renderer.setRenderTarget(currentRenderTarget);
                const useAtmosphereHDR = this.useLookViewHDR && this.atmosphereEnabled && this.atmosphereHDR && this.hdrToneMappingPass !== null;
                if (!this.effectiveAerialPerspective && this._aerialPerspectiveWasActive) {
                    this.disposeAerialPerspectiveResources();
                }
                this._aerialPerspectiveWasActive = this.effectiveAerialPerspective;

                // ALWAYS store render target height for use right before rendering
                // Must be set every frame, not just on resize, or it will have stale values
                this._rtHeightForFocalLength = rtHeight;
                
                // [DBG] Clear background
                if (Globals.renderDebugFlags.dbg_clearBackground) {
                    this.renderer.clear(true, true, true);
                }
                if (globalProfiler) globalProfiler.pop();
                //}

                /*
                 maybe:
                 - Render day sky to renderTargetA
                 - Render night sky to renderTargetA (should have a black background)
                 - Combine them both to renderTargetAntiAliased instead of clearing it
                 - they will only need combining at dusk/dawn, using total light in the sky
                 - then render the scene to renderTargetAntiAliased, and apply effects with A/B as before

                 */


                // if (keyHeld["y"]) {
                //     return;
                // }

                // Profile: Lighting setup
                if (globalProfiler) globalProfiler.push('#b3de69', 'lightingSetup');
                // update lighting before rendering the sky
                const lightingNode = NodeMan.get("lighting", true);
                // if this is an IR viewport, then we need to render the IR ambient light
                // instead of the normal ambient light.

                if (this.isIR && this.effectsEnabled) {
                    lightingNode.setIR(true);
                }
                const isMainView = (this.id === "mainView");
                lightingNode.recalculate(isMainView);
                // Only disable day/night lighting if noMainLighting is enabled AND this is the main view
                sharedUniforms.useDayNight.value = !(lightingNode.noMainLighting && isMainView);



                // Use effective values that respect ambientOnly. The ambient
                // bucket includes daylight sun scattering so shader shadow
                // floors use the same ambient seen by shaded geometry.
                sharedUniforms.sunGlobalTotal.value = lightingNode.getEffectiveSunTotal();
                sharedUniforms.sunAmbientIntensity.value = lightingNode.getEffectiveAmbientIntensity();
                sharedUniforms.sunNightAmbientIntensity.value = lightingNode.getNightAmbientIntensity();


                // update the sun node, which controls the global scene lighting
                const sunNode = NodeMan.get("theSun", true);
                if (sunNode !== undefined) {
                    sunNode.update();
                }

                const savedQuaternion = this.applyCameraOffset();

                // Apply asymmetric frustum shift for video pan offset.
                // This shifts which portion of the rendered view is visible without
                // changing camera position or direction (LOS stays invariant).
                // We patch updateProjectionMatrix so the shift survives any
                // re-computation (e.g. matchVideoAspect re-apply after renderSky).
                let _panPatchedCamera = null;
                let _panOrigUpdatePM = null;
                if (this.syncVideoZoom) {
                    const panSyncView = NodeMan.exists("video") ? NodeMan.get("video") : null;
                    if (panSyncView !== null) {
                        const panX = panSyncView.panOffsetX ?? 0;
                        const panY = panSyncView.panOffsetY ?? 0;
                        if (panX !== 0 || panY !== 0) {
                            // panOffset is fraction of VIDEO dimensions, but projection
                            // matrix elements[8]/[9] are in VIEW NDC space. Scale by the
                            // ratio of video extent to view extent in each axis.
                            // oldFOV = base camera FOV (before fovOverride).
                            // Use camera.zoom because elements[8]/[9] are relative to
                            // the projection built with camera.zoom. When pixel-match
                            // caps camera.zoom, the render target reduction + browser
                            // magnification handles the excess zoom — the NDC shift
                            // must match the projection's own zoom level.
                            const zoom = this.camera.zoom;
                            const baseFovHalfTan = Math.tan(oldFOV * Math.PI / 360);
                            const videoAspect = panSyncView.videoWidth / panSyncView.videoHeight;

                            // Patch updateProjectionMatrix to append the pan shift.
                            // Computed dynamically because camera.fov and camera.aspect
                            // may change during the render cycle (fovOverride, matchVideoAspect).
                            _panPatchedCamera = this.camera;
                            _panOrigUpdatePM = this.camera.updateProjectionMatrix;
                            const cam = this.camera;
                            const origFn = _panOrigUpdatePM;
                            cam.updateProjectionMatrix = function () {
                                origFn.call(cam);
                                const currFovHalfTan = Math.tan(cam.fov * Math.PI / 360);
                                // Video extent in NDC: how much of the view the video spans
                                const hScale = videoAspect * baseFovHalfTan / (cam.aspect * currFovHalfTan);
                                const vScale = baseFovHalfTan / currFovHalfTan;
                                cam.projectionMatrix.elements[8] += 2 * panX * hScale * zoom;
                                cam.projectionMatrix.elements[9] -= 2 * panY * vScale * zoom;
                                cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
                            };
                            // Apply immediately
                            cam.updateProjectionMatrix();
                        }
                    }
                }

                // Apply Y-compress (anamorphic vertical squash). Patched on top of
                // any pan patch so it survives re-computation (matchVideoAspect
                // re-apply after renderSky). elements[5] is the vertical NDC scale
                // (1/tan(fovV/2)); dividing it by yCompress widens the vertical
                // frustum by that factor, compressing the content into the same height.
                let _yCompressPatchedCamera = null;
                let _yCompressOrigUpdatePM = null;
                if (this.yCompress !== undefined && this.yCompress > 1.0001) {
                    _yCompressPatchedCamera = this.camera;
                    _yCompressOrigUpdatePM = this.camera.updateProjectionMatrix;
                    const cam = this.camera;
                    const origFn = _yCompressOrigUpdatePM;
                    const yc = this.yCompress;
                    cam.updateProjectionMatrix = function () {
                        origFn.call(cam);
                        cam.projectionMatrix.elements[5] /= yc;
                        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
                    };
                    cam.updateProjectionMatrix();
                }

                // Hoist declarations needed by the finally block below
                let oldLayers = this.camera.layers.mask;
                let nightSkyForRestore = null;
                let restoreTerrainMasks = null;
                try {

                // [DBG] Render sky
                if (Globals.renderDebugFlags.dbg_renderSky) {
                    this.renderSky();
                }
                // renderSky() calls preRenderCameraUpdate() internally for the
                // celestial sphere, which resets camera.aspect to the viewport aspect.
                // Re-apply the matchVideoAspect overrides if active.
                if (this._matchVideoAspectFOV !== undefined) {
                    this.camera.fov = this._matchVideoAspectFOV;
                    this.camera.aspect = this._matchVideoAspectAspect;
                    this.camera.updateProjectionMatrix();
                }
                if (globalProfiler) globalProfiler.pop();

                // Profile: Sky rendering
                if (globalProfiler) globalProfiler.push('#80b1d3', 'skyRender');
                // render the day sky
                if (GlobalDaySkyScene !== undefined) {

                    // [DBG] Render day sky
                    if (Globals.renderDebugFlags.dbg_renderDaySky) {
                        var tempPos = this.camera.position.clone();
                        this.camera.position.set(0, 0, 0)
                        this.camera.updateMatrix();
                        this.camera.updateMatrixWorld();
                        const oldTME = this.renderer.toneMappingExposure;
                        const oldTM = this.renderer.toneMapping;

                        // this.renderer.toneMapping = ACESFilmicToneMapping;
                        // this.renderer.toneMappingExposure = NodeMan.get("theSky").effectController.exposure;
                        this.renderer.render(GlobalDaySkyScene, this.camera);
                        // this.renderer.toneMappingExposure = oldTME;
                        // this.renderer.toneMapping = oldTM;

                        this.renderer.clearDepth()
                        this.camera.position.copy(tempPos)
                        if (Globals.renderDebugFlags.dbg_updateCameraMatrices) {
                            this.camera.updateMatrix();
                            this.camera.updateMatrixWorld();
                        }
                    }


                    // For non-HDR pipelines, tone-map sky now.
                    // HDR lookView with atmosphere tone-maps once at the end.
                    if (!useAtmosphereHDR) {
                        const acesFilmicToneMappingPass = new ShaderPass(ACESFilmicToneMappingShader);
                        const lightingNodeSky = NodeMan.get("lighting", true);
                        const sceneExposureSky = lightingNodeSky?.sceneExposure ?? 1.0;
                        acesFilmicToneMappingPass.uniforms['exposure'].value = NodeMan.get("theSky").effectController.exposure * sceneExposureSky;
                        acesFilmicToneMappingPass.uniforms['tDiffuse'].value = currentRenderTarget.texture;

                        // flip the render targets
                        const useRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                        this.renderer.setRenderTarget(useRenderTarget);
                        this.fullscreenQuad.material = acesFilmicToneMappingPass.material;
                        this.renderer.render(this.fullscreenQuadScene, this.fullscreenQuadCamera);
                        this.renderer.clearDepth();

                        currentRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                    }
                }
                if (globalProfiler) globalProfiler.pop();

                // Profile: Main scene rendering
                if (globalProfiler) globalProfiler.push('#fb8072', 'sceneRender');
                // viewport setting for fov, layer mask, override camera settings
                // but we want to preserve the camera settings

// fovOverride WAS (incorrectly) being applied here

                oldLayers = this.camera.layers.mask;

                // this.layers can be used to override the camera layers for this view
                // for example lookView2 in the custom flir1 setup
                // if (this.layers !== undefined) {
                //     assert(0,"DEPRECATED CNodeView3D renderTargetAndEffects: setting camera layers from this.layers")
                //     this.camera.layers.mask = this.layers;
                // }

                // "Main Use Look Layers" debug toggle: apply lookView's
                // culling to TERRAIN and 3D BUILDINGS (Google Photorealistic /
                // Cesium OSM 3D Tiles) for this render, leaving the camera
                // mask at mainView's normal value so non-terrain helpers
                // (camera frustum, debug arrows, tracks, etc.) still render
                // in mainView.
                //
                // Tile/mesh masks carry separate MASK_MAIN and MASK_LOOK
                // bits (terrain typical: 0b00011000 = both set; the
                // buildings node maintains a separate PerViewTiles subtree
                // per view, masked MASK_MAIN or MASK_LOOK respectively).
                // Simply ANDing the mesh mask with lookView's camera mask
                // strips MASK_MAIN, which then fails mainView's camera-mask
                // test entirely — so we'd see nothing. Instead: ask
                // "would lookView render this mesh?" (origMask & lookMask)
                // and if yes, force the mesh mask to mainView's mask so it
                // passes mainView's filter; if no, hide it. The original
                // masks are saved and restored in the finally block so
                // lookView's own render later this frame sees the
                // unmodified state. Tile-edges are baked into the terrain
                // shader so they follow automatically.
                if (Globals.renderDebugFlags.dbg_mainViewUseLookLayers && this.id === "mainView") {
                    const lookView = ViewMan.get("lookView", false);
                    const terrainNode = NodeMan.get("TerrainModel", false);
                    if (lookView && terrainNode) {
                        const lookMask = lookView.camera.layers.mask;
                        const mainMask = this.camera.layers.mask;
                        const savedMasks = [];
                        const rewriteGroup = (group) => {
                            if (!group) return;
                            group.traverse(obj => {
                                if (obj.isMesh) {
                                    const orig = obj.layers.mask;
                                    savedMasks.push({obj, mask: orig});
                                    obj.layers.mask = (orig & lookMask) ? mainMask : 0;
                                }
                            });
                        };
                        rewriteGroup(terrainNode.getGroup());
                        // 3D Buildings group hangs off the TerrainUI node and
                        // is itself a CNode-managed group on GlobalScene. The
                        // node holds two PerViewTiles subtrees (one for each
                        // view, masked respectively), so the same predicate
                        // picks out lookView's subset.
                        rewriteGroup(terrainNode.UI?.buildingsNode?.group);
                        restoreTerrainMasks = () => {
                            for (const {obj, mask} of savedMasks) obj.layers.mask = mask;
                        };
                    }
                }

                // Hide co-located satellite dots in the look view before rendering
                if (this.id === "lookView") {
                    const nsNode = NodeMan.get("NightSkyNode", false);
                    if (nsNode) {
                        nsNode.hideCameraColocatedSatellites();
                        nightSkyForRestore = nsNode;
                    }
                }

                const atmosphereFogState = this.pushLookViewAtmosphereFog();

                const waterReflectionNode = NodeMan.get("waterReflection", false);
                let waterReflectionPushed = false;
                let _restoreShadowScope = null;
                try {
                    if (Globals.shadowsEnabled) {
                        _restoreShadowScope = this._enterShadowRenderScope();
                    }

                    // Water Reflection. Scoped around the actual GlobalScene draw
                    // rather than done in a preRender hook: the terrain uniforms are
                    // SHARED BY REFERENCE with mainView's material clones, and some
                    // render paths (ExportImageSet, CFileManager) call renderCanvas
                    // directly without ever running preRender. Push/pop here is the
                    // only place that is guaranteed to bracket exactly the draw the
                    // reflection is meant for. This also runs AFTER renderSky(),
                    // which has already synced the Sun/Moon to this view's observer.
                    //
                    // INSIDE the shadow scope, not before it: push() in planar
                    // mirror mode renders the whole world a second time, and the
                    // only sun that is visible while shadows are on is the
                    // view-scoped one that _enterShadowRenderScope() switches to
                    // (Globals.sunLight is hidden). Capturing before that point
                    // gave a reflection lit by ambient alone.
                    waterReflectionPushed = waterReflectionNode ? waterReflectionNode.push(this) : false;

                    // [DBG] Render main scene
                    if (Globals.renderDebugFlags.dbg_renderMainScene) {
                        // Set focal length immediately before rendering (not earlier, to avoid being overwritten by other views)
                        if (this._rtHeightForFocalLength !== undefined) {
                            const fov = this.camera.fov * Math.PI / 180;
                            const rtHeight = this._rtHeightForFocalLength;
                            const focalLength = rtHeight / (2 * Math.tan(fov / 2));
                            sharedUniforms.cameraFocalLength.value = focalLength;
                        }

                        this.renderer.render(GlobalScene, this.camera);
                    }
                } finally {
                    // Reverse order of acquisition.
                    if (waterReflectionPushed) waterReflectionNode.pop();
                    if (_restoreShadowScope) _restoreShadowScope();
                    this.popLookViewAtmosphereFog(atmosphereFogState);
                }

                if (globalProfiler) globalProfiler.pop();

                } finally {
                    // Restore satellite brightness after look view render
                    if (nightSkyForRestore) {
                        nightSkyForRestore.restoreSatelliteScales();
                    }

                    this.removeCameraOffset(savedQuaternion);

                    // Restore the Y-compress patch first (it was applied on top of
                    // any pan patch), then the pan patch below.
                    if (_yCompressPatchedCamera && _yCompressOrigUpdatePM) {
                        _yCompressPatchedCamera.updateProjectionMatrix = _yCompressOrigUpdatePM;
                    }

                    // Restore original updateProjectionMatrix before FOV restore
                    if (_panPatchedCamera && _panOrigUpdatePM) {
                        _panPatchedCamera.updateProjectionMatrix = _panOrigUpdatePM;
                    }

                    this.camera.layers.mask = oldLayers;
                    if (restoreTerrainMasks) restoreTerrainMasks();

                    if (this.fovOverride !== undefined) {
                        this.camera.fov = oldFOV;
                        this.camera.updateProjectionMatrix();
                    }

                    if (this.isIR && this.effectsEnabled) {
                        NodeMan.get("lighting").setIR(false);
                    }
                }

                if (this.effectiveAerialPerspective) {
                    if (globalProfiler) globalProfiler.push('#8dd3c7', 'aerialPerspective');

                    const betaExtinction = 3.912 / Math.max(1, this.atmosphereVisibilityKm * 1000);
                    const distanceScale = 1000000;
                    const depthTarget = this.renderAerialPerspectiveDepth(rtWidth, rtHeight, distanceScale);
                    const aerialPass = this._ensureAerialPerspectiveMaterial();
                    const u = aerialPass.uniforms;
                    this.populateAtmosphereRayUniforms(u, {linear: true});
                    u.tDiffuse.value = currentRenderTarget.texture;
                    u.tDistance.value = depthTarget.texture;
                    u.distanceScale.value = distanceScale;
                    u.visibilityKm.value = this.atmosphereVisibilityKm;
                    u.betaExtinction.value = betaExtinction;

                    const aerialTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                    this.renderer.setRenderTarget(aerialTarget);
                    this.fullscreenQuad.material = aerialPass;
                    this.renderer.render(this.fullscreenQuad, this.fullscreenQuadCamera);
                    currentRenderTarget = aerialTarget;

                    if (globalProfiler) globalProfiler.pop();
                }

                if (this.effectsEnabled) {

                    // Profile: Effects passes
                    if (globalProfiler) globalProfiler.push('#bebada', 'effectsPasses');
                    // [DBG] Render effects
                    if (Globals.renderDebugFlags.dbg_renderEffects) {
                        //   this.renderer.setRenderTarget(null);

                        // Apply each effect pass sequentially
                        for (let effectName in this.effectPasses) {
                            const effectNode = this.effectPasses[effectName];
                            if (!effectNode.enabled) continue;
                            let effectPass = effectNode.pass;

                            // the efferctNode has an optional filter type for the source texture
                            // which will be from the PREVIOUS effect pass's render target
                            switch (effectNode.filter.toLowerCase()) {
                                case "linear":
                                    forceFilterChange(currentRenderTarget.texture, LinearFilter, this.renderer);
                                    break;
                                case "nearest":
                                default:
                                    forceFilterChange(currentRenderTarget.texture, NearestFilter, this.renderer);
                                    break;
                            }

                            // Ensure the texture parameters are applied
                            // currentRenderTarget.texture.needsUpdate = true;

                            effectPass.uniforms['tDiffuse'].value = currentRenderTarget.texture;
                            // flip the render targets
                            const useRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;

                            this.renderer.setRenderTarget(useRenderTarget);
                            //this.renderer.clear(true, true, true);
                            this.fullscreenQuad.material = effectPass.material;  // Set the material to the current effect pass
                            this.renderer.render(this.fullscreenQuad, this.fullscreenQuadCamera);
                            currentRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                        }
                    }
                    if (globalProfiler) globalProfiler.pop();
                }

                // Profile: Copy to screen
                if (globalProfiler) globalProfiler.push('#fdb462', 'copyToScreen');
                // [DBG] Render the final texture to the screen, id we were using a render target.
                if (Globals.renderDebugFlags.dbg_copyToScreen && currentRenderTarget !== null) {
                    if (useAtmosphereHDR) {
                        const skyExposure = NodeMan.get("theSky", false)?.effectController?.exposure ?? 1.0;
                        const lightingNodeHDR = NodeMan.get("lighting", true);
                        const sceneExposureHDR = lightingNodeHDR?.sceneExposure ?? 1.0;
                        this.hdrToneMappingPass.uniforms['exposure'].value = skyExposure * this.atmosphereExposure * sceneExposureHDR;
                        this.hdrToneMappingPass.uniforms['tDiffuse'].value = currentRenderTarget.texture;

                        const toneMappedTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                        this.renderer.setRenderTarget(toneMappedTarget);
                        this.fullscreenQuad.material = this.hdrToneMappingPass.material;
                        this.renderer.render(this.fullscreenQuad, this.fullscreenQuadCamera);
                        currentRenderTarget = toneMappedTarget;
                    }

                    this.copyMaterial.uniforms['tDiffuse'].value = currentRenderTarget.texture;
                    this.copyMaterial.uniforms['sRGBOutput'].value = Globals.renderDebugFlags.dbg_sRGBOutputEncoding;
                    this.fullscreenQuad.material = this.copyMaterial;  // Set the material to the copy material
                    this.renderer.setRenderTarget(null);
                    this.renderer.render(this.fullscreenQuad, this.fullscreenQuadCamera);
                }

                // Fisheye image-circle mask: black out the area outside the lens's
                // image circle, like the unexposed border of a real allsky frame.
                // Drawn onto the finished canvas so it also covers the effects chain.
                if (Globals.renderDebugFlags.dbg_copyToScreen) {
                    renderFisheyeMask(this);
                }
                if (globalProfiler) globalProfiler.pop();


            }
        }
    }


    initSky() {
        this.skyFlatMaterial = new ShaderMaterial({
            uniforms: {
                color: {value: new Color(0, 1, 0)},
                opacity: {value: 0.5},
            },
            vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `,
            fragmentShader: /* glsl */`
            uniform vec3 color;
            uniform float opacity;
            varying vec2 vUv;
            void main() {
                // Sky color uniform is in sRGB space; convert to linear
                // for consistent linear render target output.
                gl_FragColor = sRGBTransferEOTF(vec4(color, opacity));
            }
        `,
            transparent: true,
            blending: NormalBlending,
            depthTest: false,
            depthWrite: false
        });
        this.skyBrightnessMaterial = this.skyFlatMaterial;
        this.skyGradientMaterial = null;


        this.fullscreenQuadGeometry = new PlaneGeometry(2, 2);

        // Reuse camera for fullscreen quads instead of creating new ones every frame
        // This prevents GC pressure from allocating 6-9 Camera objects per frame in split-screen
        this.fullscreenQuadCamera = new Camera();
        this.fullscreenQuadCamera.position.z = 1;
        this.fullscreenQuadCamera.parent = null;  // Ensure parent is set to avoid undefined access
        this.fullscreenQuadCamera.updateMatrix();
        this.fullscreenQuadCamera.updateMatrixWorld();

        this.fullscreenQuad = new Mesh(this.fullscreenQuadGeometry, this.skyBrightnessMaterial);
        this.fullscreenQuadScene = new Scene();
        this.fullscreenQuadScene.add(this.fullscreenQuad);

    }

    _ensureSkyGradientMaterial() {
        if (this.skyGradientMaterial !== null) return this.skyGradientMaterial;

        this.skyGradientMaterial = new ShaderMaterial({
            uniforms: {
                zenithColor: {value: new Color(0, 0, 0)},
                coolHorizon: {value: new Color(0, 0, 0)},
                warmHorizon: {value: new Color(0, 0, 0)},
                warmStrength: {value: 0.0},
                opacity: {value: 1.0},
                cameraWorldPosition: {value: new Vector3()},
                cameraWorldX: {value: new Vector3(1, 0, 0)},
                cameraWorldY: {value: new Vector3(0, 1, 0)},
                cameraWorldZ: {value: new Vector3(0, 0, 1)},
                upCamera: {value: new Vector3(0, 1, 0)},
                upWorld: {value: new Vector3(0, 1, 0)},
                sunDirHoriz: {value: new Vector3(1, 0, 0)},
                cameraTanHalfFov: {value: 1.0},
                cameraAspect: {value: 1.0},
                horizonDip: {value: 0.0},
                horizonHazeBand: {value: 0.03},
                horizonElevationScale: {value: 12.0},
                horizonExponent: {value: 0.4},
                ditherStrength: {value: 1.0 / 255.0},
            },
            vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `,
            fragmentShader: /* glsl */`
            uniform vec3 zenithColor;
            uniform vec3 coolHorizon;
            uniform vec3 warmHorizon;
            uniform float warmStrength;
            uniform float opacity;
            uniform vec3 cameraWorldPosition;
            uniform vec3 cameraWorldX;
            uniform vec3 cameraWorldY;
            uniform vec3 cameraWorldZ;
            uniform vec3 upCamera;
            uniform vec3 upWorld;
            uniform vec3 sunDirHoriz;
            uniform float cameraTanHalfFov;
            uniform float cameraAspect;
            uniform float horizonDip;
            uniform float horizonHazeBand;
            uniform float horizonElevationScale;
            uniform float horizonExponent;
            uniform float ditherStrength;
            varying vec2 vUv;

            float hashDither(vec2 p) {
                float h = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
                return h - 0.5;
            }

            void main() {
                vec2 ndc = vUv * 2.0 - 1.0;
                vec3 dirCamera = normalize(vec3(
                    ndc.x * cameraAspect * cameraTanHalfFov,
                    ndc.y * cameraTanHalfFov,
                    -1.0
                ));
                vec3 dir = normalize(
                    cameraWorldX * dirCamera.x +
                    cameraWorldY * dirCamera.y +
                    cameraWorldZ * dirCamera.z
                );

                float upDot = dot(dirCamera, upCamera);
                float horizonDistance = upDot + horizonDip;
                float h = clamp((horizonDistance - horizonHazeBand) * horizonElevationScale, 0.0, 1.0);
                float t = smoothstep(0.0, 1.0, h);

                vec3 horizProj = dir - upWorld * upDot;
                float horizLen = length(horizProj);
                vec3 horizonColor;
                if (horizLen > 1e-4) {
                    vec3 dirHoriz = horizProj / horizLen;
                    float sunAlignment = clamp(dot(dirHoriz, sunDirHoriz), 0.0, 1.0);
                    horizonColor = mix(coolHorizon, warmHorizon, sunAlignment * warmStrength);
                } else {
                    horizonColor = coolHorizon;
                }

                vec3 c = mix(horizonColor, zenithColor, t);
                c += vec3(hashDither(gl_FragCoord.xy) * ditherStrength);
                c = clamp(c, vec3(0.0), vec3(1.0));
                gl_FragColor = sRGBTransferEOTF(vec4(c, opacity));
            }
        `,
            transparent: true,
            blending: NormalBlending,
            depthTest: false,
            depthWrite: false
        });

        return this.skyGradientMaterial;
    }

    _ensureAerialPerspectiveMaterial() {
        if (this.aerialPerspectiveMaterial !== undefined && this.aerialPerspectiveMaterial !== null) {
            return this.aerialPerspectiveMaterial;
        }

        this.aerialPerspectiveMaterial = new ShaderMaterial({
            uniforms: {
                tDiffuse: {value: null},
                tDistance: {value: null},
                zenithColor: {value: new Color(0, 0, 0)},
                coolHorizon: {value: new Color(0, 0, 0)},
                warmHorizon: {value: new Color(0, 0, 0)},
                warmStrength: {value: 0.0},
                cameraWorldX: {value: new Vector3(1, 0, 0)},
                cameraWorldY: {value: new Vector3(0, 1, 0)},
                cameraWorldZ: {value: new Vector3(0, 0, 1)},
                upCamera: {value: new Vector3(0, 1, 0)},
                upWorld: {value: new Vector3(0, 1, 0)},
                sunDirHoriz: {value: new Vector3(1, 0, 0)},
                cameraAltitudeM: {value: 0.0},
                distanceScale: {value: 200000.0},
                cameraTanHalfFov: {value: 1.0},
                cameraAspect: {value: 1.0},
                horizonDip: {value: 0.0},
                horizonHazeBand: {value: 0.03},
                horizonElevationScale: {value: 12.0},
                betaExtinction: {value: 0.00005},
                rayleighScaleHeightM: {value: 8000.0},
                aerosolScaleHeightM: {value: 1500.0},
                atmosphereTopM: {value: 100000.0},
                visibilityKm: {value: 50.0},
                maxOpticalDepth: {value: 12.0},
                ditherStrength: {value: 1.0 / 255.0},
            },
            vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `,
            fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse;
            uniform sampler2D tDistance;
            uniform vec3 zenithColor;
            uniform vec3 coolHorizon;
            uniform vec3 warmHorizon;
            uniform float warmStrength;
            uniform vec3 cameraWorldX;
            uniform vec3 cameraWorldY;
            uniform vec3 cameraWorldZ;
            uniform vec3 upCamera;
            uniform vec3 upWorld;
            uniform vec3 sunDirHoriz;
            uniform float cameraAltitudeM;
            uniform float distanceScale;
            uniform float cameraTanHalfFov;
            uniform float cameraAspect;
            uniform float horizonDip;
            uniform float horizonHazeBand;
            uniform float horizonElevationScale;
            uniform float betaExtinction;
            uniform float rayleighScaleHeightM;
            uniform float aerosolScaleHeightM;
            uniform float atmosphereTopM;
            uniform float visibilityKm;
            uniform float maxOpticalDepth;
            uniform float ditherStrength;
            varying vec2 vUv;

            float hashDither(vec2 p) {
                float h = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
                return h - 0.5;
            }

            vec3 viewDirection(out vec3 dirCamera) {
                vec2 ndc = vUv * 2.0 - 1.0;
                dirCamera = normalize(vec3(
                    ndc.x * cameraAspect * cameraTanHalfFov,
                    ndc.y * cameraTanHalfFov,
                    -1.0
                ));
                return normalize(
                    cameraWorldX * dirCamera.x +
                    cameraWorldY * dirCamera.y +
                    cameraWorldZ * dirCamera.z
                );
            }

            vec3 atmosphereSkyRadiance(vec3 dir, vec3 dirCamera) {
                float upDot = dot(dirCamera, upCamera);
                float horizonDistance = upDot + horizonDip;
                float h = clamp((horizonDistance - horizonHazeBand) * horizonElevationScale, 0.0, 1.0);
                float t = smoothstep(0.0, 1.0, h);

                vec3 horizProj = dir - upWorld * dot(dir, upWorld);
                float horizLen = length(horizProj);
                vec3 horizonColor;
                if (horizLen > 1e-4) {
                    vec3 dirHoriz = horizProj / horizLen;
                    float sunAlignment = clamp(dot(dirHoriz, sunDirHoriz), 0.0, 1.0);
                    horizonColor = mix(coolHorizon, warmHorizon, sunAlignment * warmStrength);
                } else {
                    horizonColor = coolHorizon;
                }

                return mix(horizonColor, zenithColor, t);
            }

            float earthSurfaceRayDistance(vec3 dir) {
                float upDot = dot(dir, upWorld);
                float radius = 6378137.0;
                float observerRadius = radius + max(cameraAltitudeM, 0.0);
                float b = observerRadius * upDot;
                float c = observerRadius * observerRadius - radius * radius;
                float disc = b * b - c;

                if (disc >= 0.0) {
                    float t = -b - sqrt(disc);
                    if (t > 0.0) return t;
                }

                float horizonDistance = sqrt(max(observerRadius * observerRadius - radius * radius, 0.0));
                return horizonDistance;
            }

            float atmosphereBoundaryRayDistance(vec3 dir) {
                float upDot = dot(dir, upWorld);
                float radius = 6378137.0;
                float topRadius = radius + atmosphereTopM;
                float observerRadius = radius + max(cameraAltitudeM, 0.0);
                float b = observerRadius * upDot;
                float c = observerRadius * observerRadius - topRadius * topRadius;
                float disc = b * b - c;

                if (disc >= 0.0) {
                    float root = sqrt(disc);
                    float tFar = -b + root;
                    if (tFar > 0.0) return tFar;
                    float tNear = -b - root;
                    if (tNear > 0.0) return tNear;
                }

                return 0.0;
            }

            float rayHeightAtDistance(vec3 dir, float distanceMeters) {
                float radius = 6378137.0;
                float observerRadius = radius + max(cameraAltitudeM, 0.0);
                float upDot = dot(dir, upWorld);
                float r = sqrt(max(
                    observerRadius * observerRadius +
                    distanceMeters * distanceMeters +
                    2.0 * observerRadius * distanceMeters * upDot,
                    radius * radius
                ));
                return max(r - radius, 0.0);
            }

            float atmospherePathMeters(vec3 dir, float rayMeters) {
                float maxDistance = min(rayMeters, 4000000.0);
                float opticalMeters = 0.0;

                // Bias samples toward the far end of the ray. Long oblique
                // Earth views can spend hundreds of km in thin air and then
                // cross the dense lower atmosphere close to the terrain. Uniform
                // samples miss that layer, leaving high-contrast dark texels as
                // speckles on distant buildings.
                for (int i = 0; i < 16; ++i) {
                    float q0 = float(i) / 16.0;
                    float q1 = float(i + 1) / 16.0;
                    float s0 = maxDistance * (1.0 - (1.0 - q0) * (1.0 - q0));
                    float s1 = maxDistance * (1.0 - (1.0 - q1) * (1.0 - q1));
                    float s = 0.5 * (s0 + s1);
                    float segment = s1 - s0;
                    float h = rayHeightAtDistance(dir, s);
                    float rayleighDensity = exp(-h / rayleighScaleHeightM);
                    float aerosolDensity = exp(-h / aerosolScaleHeightM);
                    float density = mix(rayleighDensity, aerosolDensity, 0.45);
                    density *= smoothstep(atmosphereTopM, atmosphereTopM * 0.75, h);
                    opticalMeters += density * segment;
                }

                return opticalMeters;
            }

            vec3 aerialInscatterColor(vec3 sky, vec3 dir, float surfaceT) {
                float altitudeT = smoothstep(12000.0, 120000.0, cameraAltitudeM);
                float downT = smoothstep(0.0, 0.5, -dot(dir, upWorld));
                float limbT = altitudeT * (1.0 - smoothstep(0.02, 0.20, abs(dot(dir, upWorld)))) * (1.0 - surfaceT);
                vec3 brightHaze = max(coolHorizon, vec3(0.70, 0.76, 0.78));
                vec3 limbHaze = max(coolHorizon, vec3(0.18, 0.42, 0.95));
                float terrainAirlightT = surfaceT * altitudeT * max(downT, 0.65);
                return mix(mix(sky, brightHaze, terrainAirlightT), limbHaze, limbT);
            }

            void main() {
                vec3 dirCamera;
                vec3 dir = viewDirection(dirCamera);
                vec3 sky = atmosphereSkyRadiance(dir, dirCamera);
                vec4 scene = texture2D(tDiffuse, vUv);

                float distanceNorm = texture2D(tDistance, vUv).r;
                bool hasSceneDistance = distanceNorm < 1.0 - 1e-4;
                float rayMeters = distanceNorm * distanceScale;
                float analyticGroundMeters = earthSurfaceRayDistance(dir);
                float sceneSkyDelta = length(scene.rgb - sky);
                float downViewT = smoothstep(0.25, 0.75, -dot(dir, upWorld));
                float slantViewT = 1.0 - downViewT;
                float slantCorrectionT = smoothstep(0.15, 0.85, slantViewT);

                // Some photogrammetry/3D-tile fragments can survive in the
                // color pass while the lightweight override-distance pass gives
                // them a zero-ish/under-reported distance at high camera
                // altitudes. Blend toward the analytic Earth distance only for
                // shallow slant views. A continuous angle weight avoids visible
                // popping as the camera tilt changes.
                if (hasSceneDistance && cameraAltitudeM > 10000.0 && sceneSkyDelta > 0.03) {
                    rayMeters = mix(rayMeters, max(rayMeters, analyticGroundMeters), slantCorrectionT);
                }

                // Terrain/3D tile override materials can under-report distance
                // when their production shaders apply custom positioning. Near
                // the horizon, use the line-of-sight air mass to the Earth
                // surface/horizon as a conservative lower bound for terrain haze.
                float horizonWeight = 1.0 - smoothstep(0.03, 0.25, abs(dot(dir, upWorld)));
                if (hasSceneDistance) {
                    rayMeters = mix(rayMeters, max(rayMeters, analyticGroundMeters), horizonWeight);
                } else {
                    if (sceneSkyDelta < 0.005 && dot(dir, upWorld) > -0.02) {
                        float skyRayMeters = atmosphereBoundaryRayDistance(dir);
                        float skyOpticalMeters = atmospherePathMeters(dir, skyRayMeters);
                        float skyTau = min(betaExtinction * skyOpticalMeters, maxOpticalDepth);
                        float skyAirT = 1.0 - exp(-skyTau);
                        vec3 skyAirlight = aerialInscatterColor(sky, dir, 0.0);
                        vec3 skyColor = mix(scene.rgb, skyAirlight, skyAirT);
                        skyColor += vec3(hashDither(gl_FragCoord.xy) * ditherStrength);
                        skyColor = clamp(skyColor, vec3(0.0), vec3(1.0));
                        gl_FragColor = vec4(skyColor, scene.a);
                        return;
                    }
                    rayMeters = analyticGroundMeters;
                }

                float opticalMeters = atmospherePathMeters(dir, rayMeters);
                float tau = min(betaExtinction * opticalMeters, maxOpticalDepth);
                float transmittance = exp(-tau);
                float altitudeT = smoothstep(12000.0, 120000.0, cameraAltitudeM);
                float longRangeT = altitudeT * slantViewT * smoothstep(100000.0, 600000.0, analyticGroundMeters);
                transmittance = min(transmittance, 1.0 - 0.45 * longRangeT);

                float sourceLuma = dot(scene.rgb, vec3(0.2126, 0.7152, 0.0722));
                float surfaceT = smoothstep(0.005, 0.08, sceneSkyDelta);
                surfaceT = max(surfaceT, (1.0 - smoothstep(0.02, 0.18, sourceLuma)) * longRangeT);
                vec3 airlight = aerialInscatterColor(sky, dir, surfaceT);
                float distantSurfaceT = longRangeT * surfaceT;
                float hazeAmount = 1.0 - transmittance;

                // Aerial perspective must never expand terrain contrast. For
                // medium/high altitude nadir views, first reduce distant tile
                // texture contrast in proportion to the accumulated airlight,
                // then apply the physical extinction/inscatter mix below.
                vec3 neutralSurface = vec3(sourceLuma);
                float contrastCompressionT = distantSurfaceT * smoothstep(0.04, 0.45, hazeAmount);
                vec3 surfaceColor = mix(scene.rgb, neutralSurface, contrastCompressionT * 0.45);

                // Some 3D tile fragments have unreliable or missing depth and
                // arrive as near-black pixels. When the air column says the
                // surface should already be veiled, fade those out rather than
                // preserving them as speckles.
                float sourceDarkT = (1.0 - smoothstep(0.02, 0.20, sourceLuma)) * distantSurfaceT * smoothstep(0.08, 0.35, hazeAmount);
                surfaceColor = mix(surfaceColor, airlight, sourceDarkT);
                vec3 color = surfaceColor * transmittance + airlight * (1.0 - transmittance);
                color += vec3(hashDither(gl_FragCoord.xy) * ditherStrength);
                color = clamp(color, vec3(0.0), vec3(1.0));
                gl_FragColor = vec4(color, 1.0);
            }
        `,
            depthTest: false,
            depthWrite: false
        });

        return this.aerialPerspectiveMaterial;
    }

    _ensureAerialPerspectiveDepthResources(width, height) {
        if (!this.aerialPerspectiveDepthTarget) {
            this.aerialPerspectiveDepthTarget = new WebGLRenderTarget(width, height, {
                minFilter: NearestFilter,
                magFilter: NearestFilter,
                format: RGBAFormat,
                type: this.useLookViewHDR ? HalfFloatType : UnsignedByteType,
                depthBuffer: true,
                colorSpace: LinearSRGBColorSpace,
            });
        } else if (
            this.aerialPerspectiveDepthTarget.width !== width ||
            this.aerialPerspectiveDepthTarget.height !== height
        ) {
            this.aerialPerspectiveDepthTarget.setSize(width, height);
        }

        if (!this.aerialPerspectiveDepthMaterial) {
            this.aerialPerspectiveDepthMaterial = new ShaderMaterial({
                uniforms: {
                    distanceScale: {value: 200000.0},
                },
                vertexShader: /* glsl */`
                    uniform float distanceScale;
                    varying float vDistanceNorm;

                    void main() {
                        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                        // Distance stays physical — haze depends on how far the
                        // light actually travelled — but the silhouette has to
                        // land where the colour pass draws it.
                        vDistanceNorm = clamp(length(mvPosition.xyz) / distanceScale, 0.0, 1.0);
                        gl_Position = applyTerrestrialRefraction_clip(mvPosition);
                    }
                `,
                fragmentShader: /* glsl */`
                    varying float vDistanceNorm;

                    void main() {
                        gl_FragColor = vec4(vDistanceNorm, 0.0, 0.0, 1.0);
                    }
                `,
            });
            installTerrestrialRefractionOnShaderMaterial(this.aerialPerspectiveDepthMaterial);
        }

        return this.aerialPerspectiveDepthTarget;
    }

    renderAerialPerspectiveDepth(width, height, distanceScale) {
        const depthTarget = this._ensureAerialPerspectiveDepthResources(width, height);
        const previousOverride = GlobalScene.overrideMaterial;
        const previousAutoClear = this.renderer.autoClear;
        const previousClearColor = this._aerialPerspectiveSkyColor.copy(this.renderer.getClearColor(this._aerialPerspectiveSkyColor));
        const previousClearAlpha = this.renderer.getClearAlpha();

        this.aerialPerspectiveDepthMaterial.uniforms.distanceScale.value = distanceScale;
        GlobalScene.overrideMaterial = this.aerialPerspectiveDepthMaterial;
        this.renderer.autoClear = true;
        this.renderer.setRenderTarget(depthTarget);
        this.renderer.setClearColor(0xffffff, 1);
        this.renderer.clear(true, true, true);
        try {
            this.renderer.render(GlobalScene, this.camera);
        } finally {
            GlobalScene.overrideMaterial = previousOverride;
            this.renderer.autoClear = previousAutoClear;
            this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        }

        return depthTarget;
    }

    disposeAerialPerspectiveResources() {
        if (this.aerialPerspectiveMaterial) {
            this.aerialPerspectiveMaterial.dispose();
            this.aerialPerspectiveMaterial = null;
        }
        if (this.aerialPerspectiveDepthMaterial) {
            this.aerialPerspectiveDepthMaterial.dispose();
            this.aerialPerspectiveDepthMaterial = null;
        }
        if (this.aerialPerspectiveDepthTarget) {
            this.aerialPerspectiveDepthTarget.dispose();
            this.aerialPerspectiveDepthTarget = null;
        }
    }

    updateSkyUniforms(skyColor, skyOpacity) {
        //     console.log("updateSkyUniforms: skyColor = "+skyColor+" skyOpacity = "+skyOpacity)
        this.skyFlatMaterial.uniforms.color.value = skyColor;
        this.skyFlatMaterial.uniforms.opacity.value = skyOpacity;
    }

    renderSky() {
        // Render the celestial sphere
        if (this.canDisplayNightSky && GlobalNightSkyScene !== undefined) {

            // we need to call this twice (once again in the super's render)
            // so the camera is correct for the celestial sphere
            // which is rendered before the main scene
            // but uses the same camera
            this.preRenderCameraUpdate()

            // preRenderCameraUpdate() resets camera.aspect to the full viewport
            // aspect ratio. If matchVideoAspect is active, restore the corrected
            // FOV and aspect so the celestial sphere renders with the same
            // projection as the main scene.
            if (this._matchVideoAspectFOV !== undefined) {
                this.camera.fov = this._matchVideoAspectFOV;
                this.camera.aspect = this._matchVideoAspectAspect;
                this.camera.updateProjectionMatrix();
            }

            // // scale the sprites one for each viewport
            const nightSkyNode = NodeMan.get("NightSkyNode")
            if (nightSkyNode?.syncPlanetSpritesToObserver) {
                // Same shared-scene issue as above: render the Sun/Moon from this
                // view's observer, but keep global arrow/debug ephemeris state
                // owned by the NightSkyNode update step.
                // BEFORE the planet sprites: the Moon's shader reads what the
                // lunar-eclipse node publishes, and updateMoonMesh runs inside
                // syncPlanetSpritesToObserver.
                NodeMan.get("theLunarEclipse", true)?.syncToObserver(this.camera.position);
                nightSkyNode.syncPlanetSpritesToObserver(this.camera.position, undefined, {storeState: false});
                NodeMan.get("theHalos", true)?.syncToObserver(this.camera.position);
                NodeMan.get("theEclipse", true)?.syncToObserver(this.camera.position);
            }
            
            if (Globals.renderDebugFlags.dbg_updateStarScales) {
                nightSkyNode.starField.updateStarScales(this)
            }
            
            if (Globals.renderDebugFlags.dbg_updateSatelliteScales) {
                nightSkyNode.updateSatelliteScales(this)
            }

            this.renderer.setClearColor(this.background);
            // if (nightSkyNode.useDayNight && nightSkyNode.skyColor !== undefined) {
            //     this.renderer.setClearColor(nightSkyNode.skyColor);
            // }

            let skyBrightness = 0;
            let skyColor = this.background;
            let skyOpacity = 1;


            const sunNode = NodeMan.get("theSun", true);
            if (sunNode !== undefined) {
                this.renderer.setClearColor("black")

                if (this.isIR) {
                    this.renderer.setClearColor("white");
                    this.renderer.clear(true, true, true);
                    return;
                }

                skyColor = sunNode.calculateSkyColor(this.camera.position);
                skyBrightness = sunNode.calculateSkyBrightness(this.camera.position);
                skyOpacity = sunNode.calculateSkyOpacity(this.camera.position);
                
                nightSkyNode.planets.updateMoonSkyUniforms(skyColor, skyBrightness);
                nightSkyNode.planets.updateDaySkyVisibility(skyOpacity);
            }


            // only draw the night sky if it will be visible
            if (skyOpacity < 1 && Globals.renderDebugFlags.dbg_renderNightSky) {

                this.renderer.clear(true, true, true);

                var tempPos = this.camera.position.clone();
                // this is the celestial sphere, so we want the camera at the origin

                this.camera.position.set(0, 0, 0)
                this.camera.updateMatrix();
                this.camera.updateMatrixWorld();
                this.renderer.render(GlobalNightSkyScene, this.camera);
                this.renderer.clearDepth()
                this.camera.position.copy(tempPos)
                this.camera.updateMatrix();
                this.camera.updateMatrixWorld();
            }


            // Only render the quad if skyOpacity is greater than zero
            if (skyOpacity > 0) {

                const useGradient = this.effectiveSkyGradient;
                const skyMat = useGradient ? this._ensureSkyGradientMaterial() : this.skyFlatMaterial;

                if (useGradient) {
                    const u = skyMat.uniforms;
                    this.populateAtmosphereRayUniforms(u);
                    u.opacity.value = skyOpacity;
                } else {
                    this.updateSkyUniforms(skyColor, skyOpacity);
                }

                // Restore sky material — the effects pipeline (renderCanvas) swaps
                // this.fullscreenQuad.material to effect/copy materials each frame.
                this.fullscreenQuad.material = skyMat;

                
                if (Globals.renderDebugFlags.dbg_renderFullscreenQuad) {
                    this.renderer.autoClear = false;
                    this.renderer.render(this.fullscreenQuadScene, this.fullscreenQuadCamera);
                    //this.renderer.autoClear = true;
                    this.renderer.clearDepth();
                }
                
            }

            // Render the visible Sun/Moon pass after the sky background so both bodies share one depth buffer.
            if (GlobalSunSkyScene && Globals.renderDebugFlags.dbg_renderSunSky) {

                var tempPos = this.camera.position.clone();
                this.camera.position.set(0, 0, 0);
                this.camera.updateMatrix();
                this.camera.updateMatrixWorld();

                this.renderer.render(GlobalSunSkyScene, this.camera);
                this.renderer.clearDepth();
                this.camera.position.copy(tempPos);
                this.camera.updateMatrix();
                this.camera.updateMatrixWorld();
            }


        } else {
            // clear the render target (or canvas) with the background color
            this.renderer.setClearColor(this.background);
            this.renderer.clear(true, true, true);
        }

    }


    otherSetup(v) {
        this.raycaster = new Raycaster();
        this.raycaster.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK | LAYER.MASK_TARGET;
        assert(this.scene, "CNodeView3D needs global GlobalScene")

        const spriteCrosshairMaterial = new SpriteMaterial({
            map: (() => { const t = new TextureLoader().load(SITREC_APP + 'data/images/crosshairs.png'); t.colorSpace = SRGBColorSpace; return t; })(),
            color: 0xffffff, sizeAttenuation: false,
            depthTest: false, // no depth buffer, so it's always on top
            depthWrite: false,
        });

        this.showCursor = v.showCursor;
        this.cursorSprite = new Sprite(spriteCrosshairMaterial)
        this.cursorSprite.position.set(0, 25000, -50)
        this.cursorSprite.scale.setScalar(0.02)
        this.cursorSprite.visible = false;
        GlobalScene.add(this.cursorSprite)

        this.mouseDown = false;
        this.dragMode = DRAG.NONE;

        this.showLOSArrow = v.showLOSArrow;


        this.defaultTargetHeight = v.defaultTargetHeight ?? 0

        this.focusTrackName = "default"
        this.lockTrackName = "default"
        if (v.focusTracks) {
            this.addFocusTracks(v.focusTracks);
        }
    }


    addEffects(effects) {
        if (effects) {

            // Off by default IN THE CUSTOM SITCH ONLY. There an effects chain is an
            // interpretation laid over the scene — blur, focus — and a sitch the user is
            // building from scratch should start by showing what is actually there.
            //
            // Built-in sitches keep it on, because in several of them the effects chain IS
            // the picture rather than a look laid over it: Aguadilla, Chilean, Jellyfish,
            // SWR and Model Inspector all run a FLIRShader pass, and for the isIR ones the
            // render path gates BOTH that pass and the IR ambient-light swap
            // (lightingNode.setIR) on this flag — so defaulting it off would load them as
            // ordinary visible-light views. Of the eight sitches that define effects at
            // all, SitCustom is the only one that is isCustom, so the other seven are
            // untouched. (Gimbal, GimbalCustom and Starlink are isCustom but define no
            // effects, so addEffects never runs for them.)
            //
            // A DEFAULT, not an assignment: CNodeView's constructor has already run
            // applyEarlyMods() by the time we get here, so on a saved sitch effectsEnabled
            // may already hold the value the user stored, and overwriting it here would
            // change what their save renders. (That is a pre-existing hazard, not a new
            // one — the unconditional `= true` this replaces clobbered a saved `false` the
            // same way; a later deserialize pass happened to restore it for custom saves,
            // which is exactly the kind of order-dependence not worth relying on.)
            //
            // Sit can be undefined for a view built before any sitch loads, which falls
            // through to `true` — the long-standing behaviour.
            if (this.effectsEnabled === undefined) {
                this.effectsEnabled = !(Sit?.isCustom ?? false);
            }
            guiTweaks.add(this, "effectsEnabled").name(t("view3d.effects.label")).onChange(() => {
                setRenderOne(true)
            }).tooltip(t("view3d.effects.tooltip"))

            this.effects = effects;

            // we are createing an array of CNodeEffect objects
            this.effectPasses = [];

            // as defined by the "effects" object in the sitch
            for (var effectKey in this.effects) {
                let def = this.effects[effectKey];
                let effectID = effectKey;
                let effectKind = effectKey;
                // if there's a "kind" in the def then we use that as the effect kind
                // and the effect `effect` is the name of the shader
                if (def.kind !== undefined) {
                    effectKind = def.kind;
                }

                // if there's an "id" in the def then we use that as the effect id
                // otherwise we generate one from the node id and the effect id
                effectID = def.id ?? (this.id + "_" + effectID);

//                console.log("Adding effect kind" + effectKind+" id="+effectID+"  to "+this.id)

                // create the node, which will wrap a .pass member which is the ShaderPass
                this.effectPasses.push(new CNodeEffect({
                    id: effectID,
                    effectName: effectKind,
                    ...def,
                }))
            }
        }
    }


    addEffectPass(effectName, effect) {
        this.effectPasses[effectName] = effect;
        return effect;
    }

    updateWH() {
        super.updateWH();
        this.recalculate()
    }

    recalculate() {
        super.recalculate();
        this.needUpdate = true;
    }


    updateEffects(f) {
        // Go through the effect passes and update their uniforms and anything else needed
        for (let effectName in this.effectPasses) {
            let effectNode = this.effectPasses[effectName];
            effectNode.updateUniforms(f, this)
        }
    }


    // Top-left "Y-compress=N.Nx" overlay, shown only when compression is active.
    // A DOM child of the view div (not a WebGL draw), so it's independent of the
    // composite render path. Dirty-checked so it's effectively free to call per-frame.
    updateYCompressIndicator() {
        if (!this._hasYCompressControl) return;
        const yc = this.yCompress ?? 1.0;
        if (yc === this._yCompressShown && this._yCompressIndicator !== undefined) return;
        this._yCompressShown = yc;

        if (this._yCompressIndicator === undefined) {
            const el = document.createElement('div');
            Object.assign(el.style, {
                position: 'absolute', top: '4px', left: '6px', zIndex: 20,
                pointerEvents: 'none', font: '13px monospace', color: '#ffe000',
                textShadow: '0 0 3px #000, 1px 1px 2px #000', whiteSpace: 'nowrap',
            });
            this.div.appendChild(el);
            this._yCompressIndicator = el;
        }

        if (yc > 1.0001) {
            // Two decimals: values like 1.01 are exactly the ones worth surfacing (a 1%
            // anamorphic squash is invisible to the eye but breaks any video-overlay
            // comparison), and one decimal displayed them as a reassuring "1.0x".
            this._yCompressIndicator.textContent = `Y-compress=${yc.toFixed(2)}x`;
            this._yCompressIndicator.style.display = 'block';
        } else {
            this._yCompressIndicator.style.display = 'none';
        }
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            focusTrackName: this.focusTrackName,
            lockTrackName: this.lockTrackName,
            effectsEnabled: this.effectsEnabled,
            atmosphereEnabled: this.atmosphereEnabled,
            atmosphereVisibilityKm: this.atmosphereVisibilityKm,
            atmosphereHDR: this.atmosphereHDR,
            atmosphereExposure: this.atmosphereExposure,
            atmosphereHaze: this.effectiveAtmosphereHaze,
            skyGradient: this.skyGradient,
            allowMobileSkyGradient: this.allowMobileSkyGradient,
        }

    }

    modDeserialize(v) {
        super.modDeserialize(v)
        if (v.focusTrackName !== undefined) this.focusTrackName = v.focusTrackName
        if (v.lockTrackName !== undefined) this.lockTrackName = v.lockTrackName
        if (v.effectsEnabled !== undefined) this.effectsEnabled = v.effectsEnabled
        if (v.atmosphereEnabled !== undefined) this.atmosphereEnabled = v.atmosphereEnabled
        if (v.atmosphereVisibilityKm !== undefined) this.atmosphereVisibilityKm = v.atmosphereVisibilityKm
        if (v.atmosphereHDR !== undefined) this.atmosphereHDR = v.atmosphereHDR
        if (v.atmosphereExposure !== undefined) this.atmosphereExposure = v.atmosphereExposure
        if (v.atmosphereHaze !== undefined) this.atmosphereHaze = v.atmosphereHaze
        if (v.skyGradient !== undefined) this.skyGradient = v.skyGradient
        if (v.allowMobileSkyGradient !== undefined) this.allowMobileSkyGradient = v.allowMobileSkyGradient
        // V5 shadows: shadowsEnabled is restored via addSimpleSerial. If the
        // user saved a sitch with shadows on, we need to re-trigger
        // applyShadowConfig so the lighting node's deferred-first-apply gate
        // can flip Globals.shadowsEnabled and lazy-create the viewSun.
        const lighting = NodeMan.get("lighting", false);
        if (lighting) {
            lighting._pendingFirstShadowConfig = true;
        }
        // yCompress is restored via addSimpleSerial (no onChange fires on load),
        // so sync the top-left indicator to the restored value.
        this.updateYCompressIndicator();
    }

    dispose() {
        // Remove our WebGL context-loss listeners FIRST, while this.canvas still
        // exists. super.dispose() (CNodeViewCanvas.dispose) nulls this.canvas, and
        // the later renderer.forceContextLoss() asynchronously dispatches a
        // webglcontextlost event. If the listener is still attached, it fires after
        // this.renderer is nulled below — the root cause of the "reading 'info' of
        // null" crash on sitch swaps. A disposed view owns no context to recover.
        if (this.canvas) {
            this.canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
            this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored, false);
        }

        // Clean up XR session if active
        if (Globals.canVR && this.id === "lookView") {
            // Remove XR event listeners
            if (this.renderer && this.renderer.xr) {
                this.renderer.xr.removeEventListener('sessionstart', this.onXRSessionStarted);
                this.renderer.xr.removeEventListener('sessionend', this.onXRSessionEnded);
                
                // End any active XR session
                const xrSession = this.renderer.xr.getSession();
                if (xrSession) {
                    console.log("XR: Ending active session during dispose");
                    xrSession.end().catch(err => {
                        console.warn("XR: Error ending session during dispose:", err);
                    });
                }
                
                // Clear animation loop
                this.renderer.setAnimationLoop(null);
            }
            
            // Clean up XR camera rig
            if (this.xrCameraRig) {
                GlobalScene.remove(this.xrCameraRig);
                this.xrCameraRig = null;
            }
            
            // Clean up XR camera
            if (this.xrCamera) {
                this.xrCamera = null;
            }
            
            // Clean up original camera reference
            if (this.originalCamera) {
                this.originalCamera = null;
            }
            
            // Remove VR button
            const vrButton = document.getElementById('VRButton');
            if (vrButton) {
                vrButton.remove();
            }
            
            this.xrActive = false;
        }
        
        this.disposeRenderTargets();

        // Dispose shader materials and geometry
        if (this.copyMaterial) this.copyMaterial.dispose();
        if (this.skyFlatMaterial) this.skyFlatMaterial.dispose();
        if (this.skyGradientMaterial && this.skyGradientMaterial !== this.skyFlatMaterial) {
            this.skyGradientMaterial.dispose();
        }
        this.skyBrightnessMaterial = null;
        this.skyFlatMaterial = null;
        this.skyGradientMaterial = null;
        if (this.hdrToneMappingPass?.material) this.hdrToneMappingPass.material.dispose();
        this.hdrToneMappingPass = null;
        if (this.fullscreenQuadGeometry) this.fullscreenQuadGeometry.dispose();

        super.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.renderer.context = null;
        this.renderer.domElement = null;

        this.renderer = null;
        if (this.composer !== undefined) this.composer.dispose();
        this.composer = null;

    }

    createRenderTargets() {
        const renderTargetType = this.useLookViewHDR ? HalfFloatType : UnsignedByteType;
        const aaSamples = this.useLookViewHDR ? 0 : getEffectiveMSAASamples();

        // Per-view render targets to avoid thrashing GPU memory in split-screen mode
        // Each view maintains its own render targets instead of sharing globals
        this.renderTargetAntiAliased = new WebGLRenderTarget(256, 256, {
            format: RGBAFormat,
            type: renderTargetType,
            colorSpace: LinearSRGBColorSpace,
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            samples: aaSamples,
        });

        this.renderTargetA = new WebGLRenderTarget(256, 256, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            type: renderTargetType,
            colorSpace: LinearSRGBColorSpace,
        });

        this.renderTargetB = new WebGLRenderTarget(256, 256, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            type: renderTargetType,
            colorSpace: LinearSRGBColorSpace,
        });

        // Reset cached dims so the next frame's size-sync re-applies setSize()
        // (otherwise the new 256x256 targets stay tiny until the canvas resizes).
        this.lastRenderTargetWidth = 256;
        this.lastRenderTargetHeight = 256;
    }

    disposeRenderTargets() {
        if (this.renderTargetAntiAliased) this.renderTargetAntiAliased.dispose();
        if (this.renderTargetA) this.renderTargetA.dispose();
        if (this.renderTargetB) this.renderTargetB.dispose();
        this.renderTargetAntiAliased = null;
        this.renderTargetA = null;
        this.renderTargetB = null;
        this.disposeAerialPerspectiveResources();
    }

    // Apply user performance settings (renderScale + msaaSamples) live without
    // tearing down the WebGL context. renderScale is picked up automatically by
    // setPixelRatio + the per-frame render-target sizing path; msaaSamples
    // requires fresh render targets because samples is fixed at construction.
    applyPerformanceSettings() {
        if (!this.renderer) return;
        const basePixelRatio = this.in.canvasWidth ? 1 : window.devicePixelRatio;
        this.renderer.setPixelRatio(basePixelRatio * getEffectiveRenderScale());
        // Recreate offscreen render targets so MSAA changes take effect; sizes
        // will be reapplied on the next render frame's size-sync block.
        this.disposeRenderTargets();
        this.createRenderTargets();
        setRenderOne(true);
    }

    // todo - change to nodes, so we can add and remove them
    // for the custom sitch
    addFocusTracks(focusTracks) {
        let select = "default"
        if (focusTracks.select !== undefined) {
            select = focusTracks.select
            delete focusTracks.select
        }

        this.focusTrackName = select
        this.lockTrackName = select
        guiMenus.view.add(this, "focusTrackName", focusTracks).onChange(focusTrackName => {
            //
        }).name(t("view3d.focusTrack.label")).listen()
            .tooltip(t("view3d.focusTrack.tooltip"))
        guiMenus.view.add(this, "lockTrackName", focusTracks).onChange(lockTrackName => {
            //
            console.log(this.lockTrackName)
        }).name(t("view3d.lockTrack.label")).listen()
            .tooltip(t("view3d.lockTrack.tooltip"))
    }

    get camera() {
        return this.cameraNode.camera;
    }

    updateIsIR() {
        this.isIR = false;
        for (const key in this.effectPasses) {
            const ep = this.effectPasses[key];
            if (ep.effectName === "FLIRShader" && ep.enabled) {
                this.isIR = true;
                break;
            }
        }
    }

    renderCanvas(frame) {
        // Skip the entire render path while the WebGL context is lost.
        // The webglcontextrestored handler will recreate render targets,
        // reset the renderer size/pixel ratio, refresh terrain, and call
        // setRenderOne(true) to kick rendering back on. Render targets are
        // disposed during loss, so attempting to render here would bind nulls.
        if (this.contextLost) return;
        if (this.renderer && this.renderer.getContext().isContextLost()) {
            // Defensive: catches forced loss (forceContextLoss in tests) where
            // the event may not have fired yet on this view.
            this.contextLost = true;
            return;
        }

        this.updateIsIR();

        super.renderCanvas(frame)

        // Profile: Update Effects
        if (globalProfiler) globalProfiler.push('#ff7f0e', 'updateEffects');
        if (this.needUpdate) {
            this.updateEffects(frame);
            this.needUpdate = false;
        }
        if (globalProfiler) globalProfiler.pop();

        // Profile: Camera Setup
        if (globalProfiler) globalProfiler.push('#1f77b4', 'cameraSetup');
        sharedUniforms.nearPlane.value = this.camera.near;
        sharedUniforms.farPlane.value = this.camera.far;
        if (globalProfiler) globalProfiler.pop();

        // Profile: Camera Controls
        if (globalProfiler) globalProfiler.push('#2ca02c', 'cameraControls');
        if (this.controls) {
            this.controls.update(1);

            // if we have a focus track, then focus on it after camera controls have updated
            if (this.focusTrackName !== "default" && NodeMan.exists(this.focusTrackName)) {
                this.controls.justRotate = true;
                var focusTrackNode = NodeMan.get(this.focusTrackName)
                const target = focusTrackNode.p(par.frame);

                // set the target position as the point to rotate about in CameraControls
                this.controls.target = target;
                this.camera.lookAt(target);
            } else {
                this.controls.justRotate = false;
            }
        }
        if (globalProfiler) globalProfiler.pop();

        // Display-only camera aim (e.g. "Render Camera Use Traverse Track"):
        // applied for the duration of the render only, restored bit-exactly in
        // the finally below so no code outside this window (node updates,
        // cascades, serialization, PTZ sync) can observe the display orientation.
        const _dlSaved = this.applyDisplayLookAt(frame);
        try {

        // Profile: Pre-render Camera Update
        if (globalProfiler) globalProfiler.push('#d62728', 'preRenderCameraUpdate');
        this.preRenderCameraUpdate()
        if (globalProfiler) globalProfiler.pop();

        // Profile: Background Color Setup
        if (globalProfiler) globalProfiler.push('#9467bd', 'bgColorSetup');
        // Reuse color objects to avoid GC pressure in the render loop
        if (!this._bgColor) this._bgColor = new Color(this.background);
        else this._bgColor.set(this.background);
        
        if (!this._srgbColor) this._srgbColor = linearToSrgb(this._bgColor);
        else this._srgbColor.copy(linearToSrgb(this._bgColor));

        // Clear manually, otherwise the second render will clear the background.
        // note: old code used pixelratio to handle retina displays, no longer needed.
        this.renderer.autoClear = false;
        if (globalProfiler) globalProfiler.pop();

        // Profile: Pre-render Callbacks
        if (globalProfiler) globalProfiler.push('#8c564b', 'preRenderCallbacks');
        this.preRenderFunction();
        CustomManager.preRenderUpdate(this)
        if (globalProfiler) globalProfiler.pop();

        // Profile: Arrow Scaling
        if (globalProfiler) globalProfiler.push('#e377c2', 'arrowScaling');
        // patch in arrow head scaling, probably a better place for this
        // but we want to down AFTER the camera is updated
        // mainly though it's because the camera control call updateMeasureArrow(), which was before
        scaleArrows(this);
        if (globalProfiler) globalProfiler.pop();

        // Profile: Track Position Indicator
        if (globalProfiler) globalProfiler.push('#17becf', 'trackIndicator');
        // Update the position indicator cone for the currently editing track
        updateTrackPositionIndicator(this);
        // Reveal/scale the move widget on the object currently in edit mode
        updateObjectMoveWidget(this);
        if (globalProfiler) globalProfiler.pop();

        // Profile: Building Handle Scaling (only for mainView)
        if (this.id === "mainView" && globalProfiler) globalProfiler.push('#9467bd', 'buildingHandles');
        // Update building handles to maintain constant screen size (size-invariant at 40px)
        if (this.id === "mainView") {
            scaleBuildingHandles(this);
        }
        if (this.id === "mainView" && globalProfiler) globalProfiler.pop();

        // Profile: Render Target and Effects (typically the most expensive)
        if (globalProfiler) globalProfiler.push('#ff0000', 'renderTargetEffects');
        this.renderTargetAndEffects()
        if (globalProfiler) globalProfiler.pop();

        // Profile: Post-render Callbacks
        if (globalProfiler) globalProfiler.push('#7f7f7f', 'postRenderCallbacks');
        CustomManager.postRenderUpdate(this)
        this.postRenderFunction();
        if (globalProfiler) globalProfiler.pop();

        } finally {
            this.removeDisplayLookAt(_dlSaved);
        }
    }


    
    // Helper method to find the CNode3DGroup object and its ID by traversing up the hierarchy
    findObjectID(object) {
        let current = object;
        let depth = 0;
        
        // Traverse up the object hierarchy to find a CNode3DGroup or named object
        while (current) {
            const indent = "  ".repeat(depth);

            // Check if this object has userData with nodeId (this indicates it's a CNode3DGroup)
            if (current.userData && current.userData.nodeId) {

                // Try to get the node using the nodeId
                const node = NodeMan.get(current.userData.nodeId);
                if (node && node.id) {
                    return node.id;
                }
                // Fallback to just using nodeId directly
                return current.userData.nodeId;
            }

            current = current.parent;
            depth++;
            
            // Safety check to prevent infinite loops
            if (depth > 20) {
                break;
            }
        }

        // If no nodeId found, return null to indicate no valid CNode3DGroup object
        return null;
    }

    // given a 3D position in the scene and a length in pixele
    // we known the verical field of view of the camera
    // and we know the height of the canvas in pixels
    // we can calculate the distance from the camera to the object
    // So convert pixels into meters
    pixelsToMeters(position, pixels) {
        // get the vertical field of view in radians
        const vfov = this.camera.fov * Math.PI / 180;
        // get the height of the canvas in pixels
        const heightPx = this.heightPx;
        // calculate the distance from the camera to the object
        const meters = pixels * position.distanceTo(this.camera.position) / (heightPx / (2 * Math.tan(vfov / 2)));

        return meters;
    }

    // this is just the inverse of the above function
    metersToPixels(position, meters) {
        // get the vertical field of view in radians
        const vfov = this.camera.fov * Math.PI / 180;
        // get the height of the canvas in pixels
        const heightPx = this.heightPx;
        // calculate the distance from the camera to the object
        const pixels = meters * (heightPx / (2 * Math.tan(vfov / 2))) / position.distanceTo(this.camera.position);

        return pixels;
    }

    // given a 3D position in the scene, and an offset in pixels
    // then return the new 3D position that will result in it being rendered by that offset
    offsetScreenPixels(position, pixelsX, pixelsY) {
        const offsetPosition = position.clone();
        if (pixelsX === 0 && pixelsY === 0) return offsetPosition;
        offsetPosition.project(this.camera);
        offsetPosition.x += pixelsX / this.widthPx;
        offsetPosition.y += pixelsY / this.heightPx;
        offsetPosition.unproject(this.camera);
        return offsetPosition;
    }

    addOrbitControls() {
        this.controls = new CameraMapControls( this.camera, this.div, this) ; // Mick's custom controls
        this.controls.zoomSpeed = 5.0 // default 1.0 is a bit slow
        this.controls.useGlobe = Sit.useGlobe
        this.controls.update();
    }

}

// Install mouse / pick / context-menu prototype methods.
Object.assign(CNodeView3D.prototype, mouseMethods);

// V5 shadows: force a shadow re-render at the next render of `view`, bypassing
// the §3.8 throttle. Used by Image Set / video exporters where each shot needs
// a fresh shadow regardless of how small the camera/sun delta was.
export function forceShadowRefreshForExport(view) {
    if (!view) return;
    if (view.viewSun && view.viewSun.shadow) {
        view.viewSun.shadow.needsUpdate = true;
        view._exportForceFrustumRefit = true;
    }
}
