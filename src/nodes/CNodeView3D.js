import {par} from "../par";
import {createVideoExporter, DefaultVideoFormat, getBestFormatForResolution, getVideoExtension} from "../VideoExporter";
import {drawVideoWatermark, ExportProgressWidget} from "../utils";
import {earthCenterEUS, XYZ2EA, XYZJ2PR} from "../SphericalMath";
import {raDec2Celestial} from "../CelestialMath";
import {Frame2Az, Frame2El} from "../JetUtils";
import {
    CustomManager,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiTweaks,
    NodeMan,
    setGPUMemoryMonitor,
    setRenderOne,
    Sit,
    Synth3DManager,
    TrackManager
} from "../Globals";
import {isKeyHeld} from "../KeyBoardHandler";
import {GlobalDaySkyScene, GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "../LocalFrame";
import {DRAG, screenToNDC} from "../mouseMoveView";
import {GPUMemoryMonitor} from "../GPUMemoryMonitor";
import {
    Camera,
    Color,
    Group,
    LinearFilter,
    Mesh,
    NearestFilter,
    NormalBlending,
    PerspectiveCamera,
    PlaneGeometry,
    Raycaster,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    Sphere,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    TextureLoader,
    UnsignedByteType,
    Vector3,
    WebGLRenderer,
    WebGLRenderTarget
} from "three";
import {
    DebugArrowAB,
    forceFilterChange,
    scaleArrows,
    scaleBuildingHandles,
    updateTrackPositionIndicator
} from "../threeExt";
import {CNodeViewCanvas} from "./CNodeViewCanvas";
import {CNode} from "./CNode";
import {getCameraNode} from "./CNodeCamera";
import {CNodeEffect} from "./CNodeEffect";
import {assert} from "../assert.js";
import {V3} from "../threeUtils";
import {ACESFilmicToneMappingShader} from "../shaders/ACESFilmicToneMappingShader";
import {ShaderPass} from "three/addons/postprocessing/ShaderPass.js";
import {isLocal, SITREC_APP} from "../configUtils.js"
import {VRButton} from 'three/addons/webxr/VRButton.js';
import {mouseInViewOnly} from "../ViewUtils";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {CameraMapControls} from "../js/CameraControls";
import {ViewMan} from "../CViewManager";
import * as LAYER from "../LayerMasks";
import {globalProfiler} from "../VisualProfiler";
import {FeatureManager} from "../CFeatureManager";
import {fixXRLayerMasks, renderCelestialScene, renderFullscreenQuadStereo} from "../CXRRenderer";


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

        this.northUp = v.northUp ?? false;
        if (this.id === "lookView") {
            guiMenus.view.add(this, "northUp").name("Look View North Up").onChange(value => {
                this.recalculate();
            })
                .tooltip("Set the look view to be north up, instead of world up.\nfor Satellite views and similar, looking straight down.\nDoes not apply in PTZ mode")
            
            // Add XR test button if VR is enabled
            if (Globals.canVR) {
                guiMenus.view.add(this, "startXR").name("Start VR/XR")
                    .tooltip("Start WebXR session for testing (works with Immersive Web Emulator)");
            }
        }
        this.addSimpleSerial("northUp");


        this.isIR = v.isIR ?? false;
        this.fovOverride = v.fovOverride;

        this.syncVideoZoom = v.syncVideoZoom ?? false;  // by default, don't sync the zoom with the video view, as we might not have a zoom controlelr
        this.syncPixelZoomWithVideo = v.syncPixelZoomWithVideo ?? false;
        this.background = v.background ?? new Color(0x000000);

        // check if this.background is an array, and if so, convert to a color
        if (this.background instanceof Array) {
            this.background = new Color(this.background[0], this.background[1], this.background[2])
        }

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
            debugFolder.add(Globals.renderDebugFlags, "dbg_clearBackground").name("Clear Background").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderSky").name("Render Sky").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderDaySky").name("Render Day Sky").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderMainScene").name("Render Main Scene").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_renderEffects").name("Render Effects").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_copyToScreen").name("Copy To Screen").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_updateCameraMatrices").name("Update Camera Matrices").onChange(() => setRenderOne(true));
            debugFolder.add(Globals.renderDebugFlags, "dbg_mainViewUseLookLayers").name("Main Use Look Layers").onChange(() => setRenderOne(true));
            
            debugFolder.add(Globals, "tileDelay", 0, 5, 0.01).name("Tile Load Delay (s)").onChange(() => setRenderOne(true));
            
            // Add renderSky sub-folder
            const skyFolder = debugFolder.addFolder("Sky Steps");
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateStarScales").name("Update Star Scales").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateSatelliteScales").name("Update Satellite Scales").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderNightSky").name("Render Night Sky").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderFullscreenQuad").name("Render Fullscreen Quad").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_renderSunSky").name("Render Sun Sky").onChange(() => setRenderOne(true));
            
            // Mark that we've added the render debug folder to avoid duplicates
            guiMenus.help._renderDebugFolderAdded = true;
        }

        this.addEffects(v.effects)
        this.otherSetup(v);


        this.recalculate(); // to set the effect pass uniforms

        this.initSky();

        if (Globals.canVR && this.id === "lookView") {

            // Setup WebXR - only on lookView
            this.renderer.xr.enabled = true;
            
            // Increase XR framebuffer resolution for better quality
            // Values > 1.0 increase resolution (improves sharpness but costs performance)
            // Default is 1.0, common values are 1.2-1.5 for Quest, up to 2.0 for high-end
            this.renderer.xr.setFramebufferScaleFactor(1.5);
            
            this.xrSession = null;
            this.xrActive = false; // Track whether we're currently in an XR session

            // Bind event handlers
            this.onXRSessionStarted = this.onXRSessionStarted.bind(this);
            this.onXRSessionEnded = this.onXRSessionEnded.bind(this);
            this.renderXR = this.renderXR.bind(this);

            // Add hidden VRButton (needed for XR session management)
            if (!document.getElementById('VRButton')) {
                const xrButton = VRButton.createButton(this.renderer);
                xrButton.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;';
                document.body.appendChild(xrButton);
            }

            // Monitor XR session state
            this.renderer.xr.addEventListener('sessionstart', this.onXRSessionStarted);
            this.renderer.xr.addEventListener('sessionend', this.onXRSessionEnded);
            
            console.log("WebXR enabled for lookView - use 'Start VR/XR' menu item");
        }
    }


    /**
     * Manually start a WebXR session
     * Useful for testing with Immersive Web Emulator
     */
    startXR() {
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
     */
    async exportVideo(requestedFormatId = DefaultVideoFormat, includeAudio = true) {
        const startFrame = Sit.aFrame;
        const endFrame = Sit.bFrame;
        const totalFrames = endFrame - startFrame + 1;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const fps = Sit.fps;
        
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
        
        console.log(`Starting video export (${formatId}): ${totalFrames} frames (${startFrame}-${endFrame}) at ${fps} fps, ${width}x${height}`);
        
        const savedFrame = par.frame;
        const savedPaused = par.paused;
        par.paused = true;
        
        const progress = new ExportProgressWidget('Exporting video...', totalFrames);
        
        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;
        
        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = fps;
        
        if (includeAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler && 
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = totalFrames / fps;
                        console.log(`Found audio: ${audioBuffer.duration.toFixed(2)}s, using ${audioDuration.toFixed(2)}s from ${audioStartTime.toFixed(2)}s`);
                        break;
                    }
                }
            }
        }
        
        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        const compositeCtx = compositeCanvas.getContext('2d');
        
        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps,
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
            
            for (let i = 0; i < totalFrames; i++) {
                if (progress.shouldStop()) break;
                
                const frame = startFrame + i;
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
                for (const entry of Object.values(NodeMan.list)) {
                    const node = entry.data;
                    if (node.preRender !== undefined) {
                        node.preRender(this);
                    }
                }
                
                this.renderCanvas(frame);

                compositeCtx.drawImage(this.canvas, 0, 0);

                // Also render visible child views (overlays and relativeTo children like compass, MQ9UI)
                // Scale from CSS pixels to composite canvas backing pixels
                const scaleX = width / this.widthPx;
                const scaleY = height / this.heightPx;
                ViewMan.computeEffectiveVisibility();
                ViewMan.iterate((id, childView) => {
                    if (childView === this) return;
                    if (!childView._effectivelyVisible) return;
                    const isChild = (childView.overlayView === this) ||
                                    (childView.in.relativeTo === this);
                    if (!isChild) return;

                    childView.renderCanvas(frame);
                    if (childView.canvas) {
                        const dx = (childView.leftPx - this.leftPx) * scaleX;
                        const dy = (childView.topPx - this.topPx) * scaleY;
                        const dw = childView.widthPx * scaleX;
                        const dh = childView.heightPx * scaleY;
                        const alpha = childView.transparency !== undefined ? childView.transparency : 1;
                        if (alpha < 1) compositeCtx.globalAlpha = alpha;
                        compositeCtx.drawImage(childView.canvas, dx, dy, dw, dh);
                        if (alpha < 1) compositeCtx.globalAlpha = 1;
                    }
                });

                drawVideoWatermark(compositeCtx, width);
                
                await exporter.addFrame(compositeCanvas, frame);
                
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
                
                const filename = `lookview_${Sit.name || 'export'}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${extension}`;
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
        for (const entry of Object.values(NodeMan.list)) {
            const node = entry.data;
            if (node.preRender !== undefined) {
                node.preRender(this); // Pass this view to preRender
            }
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
            
            // Update sun-related uniforms (use effective values that respect ambientOnly)
            const effectiveSunIntensity = lightingNode.getEffectiveSunIntensity();
            const effectiveSunScattering = lightingNode.getEffectiveSunScattering();
            sharedUniforms.sunGlobalTotal.value =
                effectiveSunIntensity
                + effectiveSunIntensity * effectiveSunScattering
                + lightingNode.ambientIntensity;
            sharedUniforms.sunAmbientIntensity.value = lightingNode.ambientIntensity;
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
        this.renderer.render(GlobalScene,this.xrCamera);

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
        this.setFromDiv(this.div); // This will set the widthDiv, heightDiv

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

        this.renderer.setPixelRatio(this.in.canvasWidth ? 1 : window.devicePixelRatio);
        this.renderer.setSize(this.widthDiv, this.heightDiv, false);
        this.renderer.colorSpace = SRGBColorSpace;
        
        // Initialize GPU Memory Monitor on the first renderer created (only in local/dev mode)
        if (isLocal) {
            if (!Globals.GPUMemoryMonitor) {
//                console.log("[CNodeView3D] Creating new GPU Memory Monitor");
                try {
                    const monitor = new GPUMemoryMonitor(this.renderer, GlobalScene);
                    setGPUMemoryMonitor(monitor);
                    // console.log("✓ GPU Memory Monitor initialized successfully");
                    
                    // Make it globally accessible for testing
                    window._gpuMonitor = monitor;
                    // console.log("✓ Monitor available as: window._gpuMonitor or window.Globals.GPUMemoryMonitor");
                } catch (e) {
                    console.error("[CNodeView3D] Error initializing GPU Memory Monitor:", e);
                }
            } else {
                // Update scene reference if it changed
                Globals.GPUMemoryMonitor.setScene(GlobalScene);
            }
        }
        if (Globals.shadowsEnabled) {
            this.renderer.shadowMap.enabled = true;
        }
        // Per-view render targets to avoid thrashing GPU memory in split-screen mode
        // Each view maintains its own render targets instead of sharing globals
        this.renderTargetAntiAliased = new WebGLRenderTarget(256, 256, {
            format: RGBAFormat,
            type: UnsignedByteType,
            colorSpace: SRGBColorSpace,
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            samples: 4, // Number of samples for MSAA
        });

        this.renderTargetA = new WebGLRenderTarget(256, 256, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            colorSpace: SRGBColorSpace,
        });

        this.renderTargetB = new WebGLRenderTarget(256, 256, {
            minFilter: NearestFilter,
            magFilter: NearestFilter,
            format: RGBAFormat,
            colorSpace: SRGBColorSpace,
        });

        // Track last dimensions to avoid redundant setSize() calls
        this.lastRenderTargetWidth = 256;
        this.lastRenderTargetHeight = 256;

        // Ensure GlobalScene and this.camera are defined
        if (!GlobalScene || !this.camera) {
            showError("GlobalScene or this.camera is not defined.");
            return;
        }

        // Shader material for copying texture
        this.copyMaterial = new ShaderMaterial({
            uniforms: {
                'tDiffuse': {value: null}
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
            varying vec2 vUv;
            void main() {
                gl_FragColor = texture2D(tDiffuse, vUv);
                
                // Apply gamma correction to match sRGB encoding
                // https://discourse.threejs.org/t/different-color-output-when-rendering-to-webglrendertarget/57494
                // gl_FragColor = sRGBTransferOETF( gl_FragColor );
            }
        `
        });

        // Fullscreen quad for rendering shaders
        const geometry = new PlaneGeometry(2, 2);
        this.fullscreenQuad = new Mesh(geometry, this.copyMaterial);

        this.effectPasses = {};

        this.preRenderFunction = v.preRenderFunction ?? (() => {
        });
        this.postRenderFunction = v.postRenderFunction ?? (() => {
        });


        // 4. Set up the event listeners on your renderer
        this.renderer.domElement.addEventListener('webglcontextlost', event => {
            event.preventDefault();
            console.warn('CNodeView3D WebGL context lost');
        }, false);

        this.renderer.domElement.addEventListener('webglcontextrestored', () => {
            console.log('CNodeView3D WebGL context restored');
            // get the terrain UI node and call doRefresh which will re-create the terrain
            // should be very quick, as all the data is already loaded
            const terrainNode = NodeMan.get("terrainUI", false);
            if (terrainNode) {
                console.log("Calling terrainNode.doRefresh()");
                terrainNode.doRefresh();
            }


        }, false);

    }


    renderTargetAndEffects() {
        {

            if (this.visible) {

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

                    // fovCoverage is the vertical fraction
                    // of the video view windowthat is covered by the video
                    // so we assume the fov
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

                // CRITICAL: Sync renderer size with current dimensions EVERY FRAME
                // This prevents race conditions where resize gestures cause frames to render 
                // before the 100ms deferred resize completes. Deduping avoids redundant WebGL calls.
                if (width !== this._lastSyncedRendererWidth || height !== this._lastSyncedRendererHeight) {
                    this.renderer.setSize(width, height, false);
                    this._lastSyncedRendererWidth = width;
                    this._lastSyncedRendererHeight = height;
                }

                // Resize render targets to match final renderer dimensions
                // Note: renderer.setSize() is deferred 100ms, but widthPx/heightPx are current
                // So render targets use the current dimensions and will match once renderer catches up
                // Deduping prevents redundant GPU memory allocations during resize gestures
                if (width !== this.lastRenderTargetWidth || height !== this.lastRenderTargetHeight) {

                    this.renderTargetAntiAliased.setSize(width, height);
                    if (this.effectsEnabled) {
                        this.renderTargetA.setSize(width, height);
                        this.renderTargetB.setSize(width, height);
                    }
                    this.lastRenderTargetWidth = width;
                    this.lastRenderTargetHeight = height;

                    // CRITICAL: Update canvas dimensions to match render target
                    // Otherwise canvas stays at init size and render target render at wrong resolution
                    if (this.in.canvasWidth !== undefined) {
                        this.canvas.width = width;
                        this.canvas.height = height;
                    }
                }

                currentRenderTarget = this.renderTargetAntiAliased;
                this.renderer.setRenderTarget(currentRenderTarget);
                
                // ALWAYS store render target height for use right before rendering
                // Must be set every frame, not just on resize, or it will have stale values
                this._rtHeightForFocalLength = height;
                
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



                // Use effective values that respect ambientOnly flag
                const effectiveSunIntensity = lightingNode.getEffectiveSunIntensity();
                const effectiveSunScattering = lightingNode.getEffectiveSunScattering();
                sharedUniforms.sunGlobalTotal.value =
                    effectiveSunIntensity
                    + effectiveSunIntensity * effectiveSunScattering
                    + lightingNode.ambientIntensity;

                sharedUniforms.sunAmbientIntensity.value = lightingNode.ambientIntensity;


                // update the sun node, which controls the global scene lighting
                const sunNode = NodeMan.get("theSun", true);
                if (sunNode !== undefined) {
                    sunNode.update();
                }

                const savedQuaternion = this.applyCameraOffset();

                // [DBG] Render sky
                if (Globals.renderDebugFlags.dbg_renderSky) {
                    this.renderSky();
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


                    // if tone mapping the sky, insert the tone mapping shader here

                    // create the pass similar to in CNodeEffect.js
                    // passing in a shader to the ShaderPass
                    const acesFilmicToneMappingPass = new ShaderPass(ACESFilmicToneMappingShader);

// Set the exposure value
                    acesFilmicToneMappingPass.uniforms['exposure'].value = NodeMan.get("theSky").effectController.exposure;

// test patch in the block of code from the effect loop
                    acesFilmicToneMappingPass.uniforms['tDiffuse'].value = currentRenderTarget.texture;
                    // flip the render targets
                    const useRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;

                    this.renderer.setRenderTarget(useRenderTarget);
                    this.fullscreenQuad.material = acesFilmicToneMappingPass.material;  // Set the material to the current effect pass
                    this.renderer.render(this.fullscreenQuadScene, this.fullscreenQuadCamera);
                    this.renderer.clearDepth()

                    currentRenderTarget = currentRenderTarget === this.renderTargetA ? this.renderTargetB : this.renderTargetA;
                }
                if (globalProfiler) globalProfiler.pop();

                // Profile: Main scene rendering
                if (globalProfiler) globalProfiler.push('#fb8072', 'sceneRender');
                // viewport setting for fov, layer mask, override camera settings
                // but we want to preserve the camera settings

// fovOverride WAS (incorrectly) being applied here

                const oldLayers = this.camera.layers.mask;

                // this.layers can be used to override the camera layers for this view
                // for example lookView2 in the custom flir1 setup
                // if (this.layers !== undefined) {
                //     assert(0,"DEPRECATED CNodeView3D renderTargetAndEffects: setting camera layers from this.layers")
                //     this.camera.layers.mask = this.layers;
                // }

                if (Globals.renderDebugFlags.dbg_mainViewUseLookLayers && this.id === "mainView") {
                    const lookView = ViewMan.get("lookView", false);
                    if (lookView) {
                        this.camera.layers.mask = lookView.camera.layers.mask;
                    }
                }

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

                this.removeCameraOffset(savedQuaternion);


                this.camera.layers.mask = oldLayers;


                if (this.fovOverride !== undefined) {
                    this.camera.fov = oldFOV;
                    this.camera.updateProjectionMatrix();
                }

                if (this.isIR && this.effectsEnabled) {
                    NodeMan.get("lighting").setIR(false);
                }
                if (globalProfiler) globalProfiler.pop();

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
                    this.copyMaterial.uniforms['tDiffuse'].value = currentRenderTarget.texture;
                    this.fullscreenQuad.material = this.copyMaterial;  // Set the material to the copy material
                    this.renderer.setRenderTarget(null);
                    this.renderer.render(this.fullscreenQuad, this.fullscreenQuadCamera);
                }
                if (globalProfiler) globalProfiler.pop();


            }
        }
    }


    initSky() {
        this.skyBrightnessMaterial = new ShaderMaterial({
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
                gl_FragColor = vec4(color, opacity);
            }
        `,
            transparent: true,
            blending: NormalBlending,
            depthTest: false,
            depthWrite: false
        });


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

    updateSkyUniforms(skyColor, skyOpacity) {
        //     console.log("updateSkyUniforms: skyColor = "+skyColor+" skyOpacity = "+skyOpacity)
        this.skyBrightnessMaterial.uniforms.color.value = skyColor;
        this.skyBrightnessMaterial.uniforms.opacity.value = skyOpacity;
    }

    renderSky() {
        // Render the celestial sphere
        if (this.canDisplayNightSky && GlobalNightSkyScene !== undefined) {

            // we need to call this twice (once again in the super's render)
            // so the camera is correct for the celestial sphere
            // which is rendered before the main scene
            // but uses the same camera
            this.preRenderCameraUpdate()

            // // scale the sprites one for each viewport
            const nightSkyNode = NodeMan.get("NightSkyNode")
            
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

                // Restore sky material — the effects pipeline (renderCanvas) swaps
                // this.fullscreenQuad.material to effect/copy materials each frame.
                this.fullscreenQuad.material = this.skyBrightnessMaterial;

                this.updateSkyUniforms(skyColor, skyOpacity);

                
                if (Globals.renderDebugFlags.dbg_renderFullscreenQuad) {
                    this.renderer.autoClear = false;
                    this.renderer.render(this.fullscreenQuadScene, this.fullscreenQuadCamera);
                    //this.renderer.autoClear = true;
                    this.renderer.clearDepth();
                }
                
                // Render the day sky scene (which contains the sun) on top of the sky brightness overlay
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
            map: new TextureLoader().load(SITREC_APP + 'data/images/crosshairs.png'),
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

            this.effectsEnabled = true;
            guiTweaks.add(this, "effectsEnabled").name("Effects").onChange(() => {
                setRenderOne(true)
            }).tooltip("Enable/Disable All Effects")

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


    modSerialize() {
        return {
            ...super.modSerialize(),
            focusTrackName: this.focusTrackName,
            lockTrackName: this.lockTrackName,
            effectsEnabled: this.effectsEnabled,
        }

    }

    modDeserialize(v) {
        super.modDeserialize(v)
        if (v.focusTrackName !== undefined) this.focusTrackName = v.focusTrackName
        if (v.lockTrackName !== undefined) this.lockTrackName = v.lockTrackName
        if (v.effectsEnabled !== undefined) this.effectsEnabled = v.effectsEnabled
    }

    dispose() {
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
        
        // Dispose render targets
        if (this.renderTargetAntiAliased) this.renderTargetAntiAliased.dispose();
        if (this.renderTargetA) this.renderTargetA.dispose();
        if (this.renderTargetB) this.renderTargetB.dispose();

        // Dispose shader materials and geometry
        if (this.copyMaterial) this.copyMaterial.dispose();
        if (this.skyBrightnessMaterial) this.skyBrightnessMaterial.dispose();
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
        }).name("Focus Track").listen()
            .tooltip("Select a track to make the camera look at it and rotate around it")
        guiMenus.view.add(this, "lockTrackName", focusTracks).onChange(lockTrackName => {
            //
            console.log(this.lockTrackName)
        }).name("Lock Track").listen()
            .tooltip("Select a track to lock the camera to it, so it moves with the track")
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
    }


    onMouseUp() {
        if (!this.mouseEnabled) return;
        this.dragMode = DRAG.NONE;
        this.mouseDown = false;
//        console.log("Mouse Down = "+this.mouseDown+ " Drag mode = "+this.dragMode)
    }

    onMouseDown(event, mouseX, mouseY) {
        if (!this.mouseEnabled) return;

        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);

        // this.cursorSprite.position

        if (event.button === 1 && this.camera) {
            console.log("Center Click")

            if (NodeMan.exists("groundSplineEditor")) {
                const groundSpline = NodeMan.get("groundSplineEditor")
                if (groundSpline.enable) {
                    groundSpline.insertPoint(par.frame, this.cursorSprite.position)
                }
            }

            if (NodeMan.exists("ufoSplineEditor")) {
                this.raycaster.setFromCamera(mouseRay, this.camera);
                const ufoSpline = NodeMan.get("ufoSplineEditor")
                console.log(ufoSpline.enable)
                if (ufoSpline.enable) {
                    // it's both a track, and an editor
                    // so we first use it to pick a close point
                    var closest = ufoSpline.closestPointToRay(this.raycaster.ray).position

                    ufoSpline.insertPoint(par.frame, closest)
                }
            }
        }


        this.mouseDown = true;
//        console.log(this.id+"Mouse Down = "+this.mouseDown+ " Drag mode = "+this.dragMode)

        // TODO, here I've hard-coded a check for mainView
        // but we might want similar controls in other views
        if (this.id === "mainView" && this.camera && mouseInViewOnly(this, mouseX, mouseY)) {
            this.raycaster.setFromCamera(mouseRay, this.camera);
            var intersects = this.raycaster.intersectObjects(this.scene.children, true);

            // debugText = ""

        }
        if (this.dragMode === 0 && this.controls && mouseInViewOnly(this, mouseX, mouseY)) {
//            console.log ("Click re-Enabled "+this.id)
            // debugger
            // console.log(mouseInViewOnly(this, mouseX, mouseY))
            //          this.controls.enabled = true;
        }
    }

    onMouseMove(event, mouseX, mouseY) {
        if (!this.mouseEnabled) return;

//        console.log(this.id+" Mouse Move = "+this.mouseDown+ " Drag mode = "+this.dragMode)

        //     return;

        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);

        // For testing mouse position, just set dragMode to 1
        //  this.dragMode = DRAG.MOVEHANDLE;


// LOADS OF EXTERNAL STUFF


        if (this.mouseDown) {

            if (this.dragMode > 0) {
                // Dragging green or white (GIMBAL SPECIFIC, NOT USED
                this.raycaster.setFromCamera(mouseRay, this.camera);
                var intersects = this.raycaster.intersectObjects(this.scene.children, true);

                console.log(`Mouse Move Dragging (${mouseX},${mouseY})`)

                //  debugText = ""
                var closestPoint = V3()
                var distance = 10000000000;
                var found = false;
                var spherePointWorldPosition = V3();
                if (this.dragMode == 1)
                    glareSphere.getWorldPosition(spherePointWorldPosition)
                else
                    targetSphere.getWorldPosition(spherePointWorldPosition)

                for (var i = 0; i < intersects.length; i++) {
                    if (intersects[i].object.name == "dragMesh") {
                        var sphereDistance = spherePointWorldPosition.distanceTo(intersects[i].point)
                        if (sphereDistance < distance) {
                            distance = sphereDistance;
                            closestPoint.copy(intersects[i].point);
                            found = true;
                        }
                    }
                }
                if (found) {
                    const closestPointLocal = LocalFrame.worldToLocal(closestPoint.clone())
                    if (this.dragMode == 1) {
                        // dragging green
                        var pitch, roll;
                        [pitch, roll] = XYZJ2PR(closestPointLocal, jetPitchFromFrame())
                        par.podPitchPhysical = pitch;
                        par.globalRoll = roll
                        par.podRollPhysical = par.globalRoll - NodeMan.get("bank").v(par.frame)
                        ChangedPR()
                    } else if (this.dragMode == 2) {
                        // dragging white
                        var el, az;
                        [el, az] = XYZ2EA(closestPointLocal)
                        // we want to keep it on the track, so are only changing Az, not El
                        // this is then converted to a frame number
                        par.az = az;
                        UIChangedAz();
                    }
                }
            }
        } else if (this.visible && this.camera && mouseInViewOnly(this, mouseX, mouseY)) {

            // moving mouse around ANY view with a camera

            this.raycaster.setFromCamera(mouseRay, this.camera);

            var closestPoint = V3()
            var found = false;
            if (NodeMan.exists("TerrainModel")) {
                let terrainNode = NodeMan.get("TerrainModel")
                const firstIntersect = terrainNode.getClosestIntersect(this.raycaster)
                if (firstIntersect) {
                    closestPoint.copy(firstIntersect.point)
                    found = true;
                }
            }

            let target;
            let targetIsTerrain = false;

            if (found) {
                targetIsTerrain = true;
                target = closestPoint.clone();
            } else {
                var possibleTarget = V3()
                this.raycaster.setFromCamera(mouseRay, this.camera);
                const dragSphere = new Sphere(earthCenterEUS(), Globals.equatorRadius /* + f2m(this.defaultTargetHeight) */)
                if (this.raycaster.ray.intersectSphere(dragSphere, possibleTarget)) {
                    target = possibleTarget.clone()
                }
            }

            // regardless of what we find above, if there's a focusTrackName, then snap to the closest point on that track
            if (this.focusTrackName !== "default" && NodeMan.exists(this.focusTrackName)) {
                var focusTrackNode = NodeMan.get(this.focusTrackName)

                var closestFrame = focusTrackNode.closestFrameToRay(this.raycaster.ray)

                target = focusTrackNode.p(closestFrame)
                this.camera.lookAt(target);

                // holding down command/Window let's you scrub along the track
                if (isKeyHeld('meta')) {
                    par.frame = closestFrame
                    setRenderOne(true);
                }


            }


            if (target !== undefined) {
                this.cursorSprite.position.copy(target)

                if (this.controls) {
                    this.controls.target = target
                    this.controls.targetIsTerrain = targetIsTerrain;
                }

                if (this.showLOSArrow) {
                    DebugArrowAB("LOS from Mouse", this.camera.position, target, 0xffff00, true, GlobalScene, 0)
                }
                setRenderOne(true);
            }

            // here we are just mouseing over the globe viewport
            // but the mouse it up
            // we want to allow rotation so it gets the first click.
            //           console.log("ENABLED controls "+this.id)
            //       this.controls.enabled = true;
        } else {
            //              console.log("DISABLED controls not just in "+this.id)
            //       if (this.controls) this.controls.enabled = false;
        }

    }

    /**
     * Helper function to check distance from mouse to line segments of a track
     * @param {Object} trackNode - The track node with position data
     * @param {number} dataPointCount - Number of data points in the track
     * @param {Function} getPositionFunc - Function to get position at index i
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @returns {number} Minimum distance from mouse to any segment (or Infinity if no valid segments)
     */
    checkTrackSegments(trackNode, dataPointCount, getPositionFunc, mouseX, mouseY) {
        let minDistance = Infinity;
        
        // Check distance to line segments between consecutive points
        for (let dataIndex = 0; dataIndex < dataPointCount - 1; dataIndex++) {
            // For nodes with validPoint method, check if data exists before accessing
            if (trackNode.validPoint) {
                if (!trackNode.validPoint(dataIndex) || !trackNode.validPoint(dataIndex + 1)) {
                    continue;
                }
            }
            
            const pos3D_A = getPositionFunc(dataIndex);
            const pos3D_B = getPositionFunc(dataIndex + 1);
            if (!pos3D_A || !pos3D_B) continue;
            
            // Project both endpoints to screen space
            const screenPos_A = new Vector3(pos3D_A.x, pos3D_A.y, pos3D_A.z);
            screenPos_A.project(this.camera);
            
            const screenPos_B = new Vector3(pos3D_B.x, pos3D_B.y, pos3D_B.z);
            screenPos_B.project(this.camera);
            
            // Skip if both points are behind camera
            if (screenPos_A.z > 1 && screenPos_B.z > 1) continue;
            
            // Convert from normalized device coordinates (-1 to 1) to screen pixels
            // Note: leftPx/topPx are container-relative, add screenOffsetX for absolute screen position
            const containerOffsetX = ViewMan.screenOffsetX || 0;
            const screenX_A = (screenPos_A.x * 0.5 + 0.5) * this.widthPx + this.leftPx + containerOffsetX;
            const screenY_A = (1 - (screenPos_A.y * 0.5 + 0.5)) * this.heightPx + this.topPx;

            const screenX_B = (screenPos_B.x * 0.5 + 0.5) * this.widthPx + this.leftPx + containerOffsetX;
            const screenY_B = (1 - (screenPos_B.y * 0.5 + 0.5)) * this.heightPx + this.topPx;
            
            // Calculate distance from mouse to line segment
            // Using point-to-line-segment distance formula
            const dx = screenX_B - screenX_A;
            const dy = screenY_B - screenY_A;
            const lengthSquared = dx * dx + dy * dy;
            
            let distance;
            if (lengthSquared === 0) {
                // Degenerate case: A and B are the same point
                const px = mouseX - screenX_A;
                const py = mouseY - screenY_A;
                distance = Math.sqrt(px * px + py * py);
            } else {
                // Calculate the parameter t for the closest point on the line segment
                // t = 0 means closest to A, t = 1 means closest to B
                let t = ((mouseX - screenX_A) * dx + (mouseY - screenY_A) * dy) / lengthSquared;
                t = Math.max(0, Math.min(1, t)); // Clamp to [0, 1] to stay on segment
                
                // Calculate the closest point on the segment
                const closestX = screenX_A + t * dx;
                const closestY = screenY_A + t * dy;
                
                // Calculate distance from mouse to closest point
                const px = mouseX - closestX;
                const py = mouseY - closestY;
                distance = Math.sqrt(px * px + py * py);
            }
            
            minDistance = Math.min(minDistance, distance);
        }
        
        return minDistance;
    }

    /**
     * Find the closest track to the mouse position in screen space
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @param {number} threshold - Maximum distance in pixels to consider (default: 10)
     * @returns {Object|null} Object with {trackID, nodeId, guiFolder} or null if no track is close enough
     */
    findClosestTrack(mouseX, mouseY, threshold = 10) {
        if (!this.camera) return null;
        
        let closestTrack = null;
        let closestDistance = threshold;
        
        // First, check tracks from TrackManager (user-loaded tracks from KML/CSV/etc)
        TrackManager.iterate((trackID, trackOb) => {
            const trackNode = trackOb.trackNode;
            const trackDataNode = trackOb.trackDataNode;
            
            // Check the display node's visibility (trackDisplayNode for loaded tracks, displayTrack for synthetic)
            const displayNode = trackOb.trackDisplayNode || trackOb.displayTrack;
            if (!trackNode || (displayNode && !displayNode.visible)) return;
            
            // Check ONLY the track data node if it exists (raw data points)
            // This represents the actual track data (e.g., from KML/CSV) and is the complete track
            if (trackDataNode && trackDataNode.getPosition && trackDataNode.misb) {
                const dataPointCount = trackDataNode.misb.length;
                const distance = this.checkTrackSegments(
                    trackDataNode, 
                    dataPointCount, 
                    (i) => trackDataNode.getPosition(i),
                    mouseX, 
                    mouseY
                );
                
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestTrack = {
                        trackID: trackID,
                        nodeId: trackDataNode.id,
                        guiFolder: trackOb.guiFolder,
                        trackOb: trackOb
                    };
                }
            }
        });
        
        // Second, check display tracks (cameraDisplayTrack, satelliteDisplayTrack, traverseDisplayTrack, etc)
        // These are algorithmic tracks that aren't in TrackManager
        NodeMan.iterate((nodeId, node) => {
            // Check if this is a CNodeDisplayTrack with a visible track
            if (node.constructor.name === 'CNodeDisplayTrack' && node.visible && node.guiFolder) {
                const trackNode = node.in.track;
                if (!trackNode || !trackNode.p || !trackNode.validPoint) return;
                
                // For display tracks, we check the track node's position data
                // Use trackNode.frames to get the number of frames
                const frameCount = trackNode.frames;
                if (!frameCount || frameCount < 2) return;
                
                // Check if the track has valid data at the first frame
                // Some tracks (like satellites) might not have data loaded yet
                if (!trackNode.validPoint(0)) return;
                
                const distance = this.checkTrackSegments(
                    trackNode,
                    frameCount,
                    (i) => trackNode.p(i),
                    mouseX,
                    mouseY
                );
                
                if (distance < closestDistance) {

                    // for now we can only pick tracks in the track manager
                    // so we will ignore the traverse track, camera track, and satellite tracks
                    const trackOb = TrackManager.get(trackNode.id, false);
                    if (trackOb) {
                        closestDistance = distance;
                        // Try to find the trackOb from TrackManager
                        // For synthetic tracks, the trackID matches the track node ID
                        closestTrack = {
                            trackID: nodeId,
                            nodeId: nodeId,
                            guiFolder: node.guiFolder,
                            trackOb: trackOb
                        };
                    }
                }
            }
        });
        
        return closestTrack;
    }

    // Display a context menu for a celestial object
    showCelestialObjectMenu(celestialObject, clientX, clientY) {
        console.log(`Found celestial object: ${celestialObject.type} - ${celestialObject.name}`);
        
        // Create an info menu for the celestial object
        let menuTitle = '';
        if (celestialObject.type === 'planet') {
            menuTitle = `Planet: ${celestialObject.name}`;
        } else if (celestialObject.type === 'satellite') {
            menuTitle = `Satellite: ${celestialObject.name}`;
        } else if (celestialObject.type === 'star') {
            menuTitle = `Star: ${celestialObject.name}`;
        }
        
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, clientX, clientY, true);
        
        // If menu creation was blocked (persistent menu is open), return early
        if (!standaloneMenu) {
            return;
        }
        
        // Add information about the celestial object
        if (celestialObject.type === 'planet') {
            const data = celestialObject.data;
            if (data.ra !== undefined) {
                standaloneMenu.add({raHours: (data.ra * 12 / Math.PI).toFixed(3)}, 'raHours').name('RA (hours)').listen().disable();
            }
            if (data.dec !== undefined) {
                standaloneMenu.add({decDegrees: (data.dec * 180 / Math.PI).toFixed(3)}, 'decDegrees').name('Dec (degrees)').listen().disable();
            }
            if (data.mag !== undefined) {
                standaloneMenu.add({magnitude: data.mag.toFixed(2)}, 'magnitude').name('Magnitude').listen().disable();
            }
        } else if (celestialObject.type === 'satellite') {
            standaloneMenu.add({noradNum: String(celestialObject.number)}, 'noradNum').name('NORAD Number').listen().disable();
            standaloneMenu.add({name: celestialObject.name}, 'name').name('Name').listen().disable();
        } else if (celestialObject.type === 'star') {
            if (celestialObject.ra !== undefined) {
                standaloneMenu.add({raHours: (celestialObject.ra * 12 / Math.PI).toFixed(3)}, 'raHours').name('RA (hours)').listen().disable();
            }
            if (celestialObject.dec !== undefined) {
                standaloneMenu.add({decDegrees: (celestialObject.dec * 180 / Math.PI).toFixed(3)}, 'decDegrees').name('Dec (degrees)').listen().disable();
            }
            if (celestialObject.magnitude !== undefined && celestialObject.magnitude !== 'Unknown') {
                standaloneMenu.add({magnitude: celestialObject.magnitude.toFixed(2)}, 'magnitude').name('Magnitude').listen().disable();
            }
        }
        
        // Add distance information (how close to the click)
        if (celestialObject.type === 'star') {
            standaloneMenu.add({distance: celestialObject.pixelDistance.toFixed(1)}, 'distance').name('Distance (pixels)').listen().disable();
        } else {
            standaloneMenu.add({angle: celestialObject.angle.toFixed(3)}, 'angle').name('Angle (degrees)').listen().disable();
        }
        
        // Open the menu
        standaloneMenu.open();
    }

    // Find the closest celestial object (star, planet, or satellite) to a ray
    findClosestCelestialObject(mouseRay, mouseX, mouseY, maxAngleDegrees = 5) {
        const nightSkyNode = NodeMan.get("NightSkyNode", false);
        if (!nightSkyNode) {
            console.log("NightSkyNode not found");
            return null;
        }

        let closestObject = null;
        let closestAngle = maxAngleDegrees;

        // Convert mouse ray to a direction vector using the raycaster
        // mouseRay is in NDC coordinates (-1 to +1)
        
        // IMPORTANT: The night sky is rendered with the camera temporarily at the origin (0,0,0)
        // So we need to get the ray direction as if the camera were at the origin
        // Save the camera's actual position and temporarily move it to origin
        const savedCameraPos = this.camera.position.clone();
        this.camera.position.set(0, 0, 0);
        this.camera.updateMatrixWorld();
        
        this.raycaster.setFromCamera(mouseRay, this.camera);
        const rayDirection = this.raycaster.ray.direction.clone();
        
        console.log(`Checking celestial objects:`);
        console.log(`  Ray direction (from origin): (${rayDirection.x.toFixed(4)}, ${rayDirection.y.toFixed(4)}, ${rayDirection.z.toFixed(4)})`);

        // Check planets (using pixel-based distance from edge)
        const maxEdgeDistance = 20;
        let closestEdgeDistance = maxEdgeDistance;
        
        if (nightSkyNode.planets.planetSprites) {
            console.log(`Checking ${Object.keys(nightSkyNode.planets.planetSprites).length} planets (edge threshold: ${maxEdgeDistance}px)`);
            for (const [planetName, planetData] of Object.entries(nightSkyNode.planets.planetSprites)) {
                if (!planetData.sprite || !planetData.sprite.visible) continue;

                // Get planet position and project to screen coordinates
                const planetWorldPos = new Vector3();
                planetData.sprite.getWorldPosition(planetWorldPos);
                
                // Project center to NDC
                const pos = planetWorldPos.clone().project(this.camera);
                
                // Check if in front of camera and within view
                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    // Convert NDC to screen coordinates, accounting for sidebar offset
                    const containerOffsetX = ViewMan.screenOffsetX || 0;
                    const screenX = (pos.x + 1) * this.widthPx / 2 + this.leftPx + containerOffsetX;
                    const screenY = (-pos.y + 1) * this.heightPx / 2 + this.topPx;
                    
                    // Calculate screen radius by projecting an edge point
                    const spriteScale = planetData.sprite.scale.x;
                    const edgeWorldPos = planetWorldPos.clone();
                    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
                    edgeWorldPos.addScaledVector(right, spriteScale);
                    const edgePos = edgeWorldPos.project(this.camera);
                    const edgeScreenX = (edgePos.x + 1) * this.widthPx / 2 + this.leftPx + containerOffsetX;
                    const edgeScreenY = (-edgePos.y + 1) * this.heightPx / 2 + this.topPx;
                    const screenRadius = Math.sqrt((edgeScreenX - screenX) ** 2 + (edgeScreenY - screenY) ** 2);
                    
                    const dx = screenX - mouseX;
                    const dy = screenY - mouseY;
                    const pixelDistanceFromCenter = Math.sqrt(dx * dx + dy * dy);
                    const edgeDistance = pixelDistanceFromCenter - screenRadius;
                    
                    console.log(`  Planet ${planetName}: center=${pixelDistanceFromCenter.toFixed(1)}px, radius=${screenRadius.toFixed(1)}px, edge=${edgeDistance.toFixed(1)}px`);

                    if (edgeDistance < closestEdgeDistance) {
                        closestEdgeDistance = edgeDistance;
                        closestObject = {
                            type: 'planet',
                            name: planetName,
                            data: planetData,
                            pixelDistance: edgeDistance,
                            angle: edgeDistance
                        };
                        console.log(`    -> New closest object: ${planetName} at ${edgeDistance.toFixed(1)}px from edge`);
                    }
                }
            }
        }

        // Check satellites
        // IMPORTANT: Unlike stars/planets which are in GlobalNightSkyScene (rendered with camera at origin),
        // satellites are in GlobalScene (rendered with camera at its actual position).
        // So we must use the actual camera position for satellite direction calculation.
        if (nightSkyNode.TLEData && nightSkyNode.TLEData.satData) {
            // Restore camera position temporarily for satellite picking
            this.camera.position.copy(savedCameraPos);
            this.camera.updateMatrixWorld();
            
            // Recompute ray direction with actual camera position
            this.raycaster.setFromCamera(mouseRay, this.camera);
            const satRayDirection = this.raycaster.ray.direction.clone();
            
            for (const satData of nightSkyNode.TLEData.satData) {
                if (!satData.visible || !satData.eus) continue;

                // Get satellite direction from actual camera position
                const satPos = satData.eus.clone();
                const satDir = satPos.clone().sub(this.camera.position).normalize();

                // Calculate angle between ray and satellite direction
                const dot = satRayDirection.dot(satDir);
                const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;

                if (angle < closestAngle) {
                    closestAngle = angle;
                    closestObject = {
                        type: 'satellite',
                        name: satData.name,
                        number: satData.number,
                        data: satData,
                        angle: angle
                    };
                }
            }
            
            // Move camera back to origin for remaining celestial object checks (stars)
            this.camera.position.set(0, 0, 0);
            this.camera.updateMatrixWorld();
        }

        // Check stars (using pixel-based distance)
        if (nightSkyNode.starField && nightSkyNode.starField.commonNames) {
            const date = GlobalDateTimeNode.dateNow;
            const maxPixelDistance = 15;
            let closestStarDistance = maxPixelDistance;
            
            console.log(`Checking ${Object.keys(nightSkyNode.starField.commonNames).length} named stars (pixel threshold: ${maxPixelDistance}px)`);
            
            for (const HR in nightSkyNode.starField.commonNames) {
                const n = HR - 1;
                const starName = nightSkyNode.starField.commonNames[HR];
                
                const ra = nightSkyNode.starField.getStarRA(n);
                const dec = nightSkyNode.starField.getStarDEC(n);
                const mag = nightSkyNode.starField.getStarMagnitude(n);
                
                const pos = raDec2Celestial(ra, dec, 100);
                pos.applyMatrix4(nightSkyNode.celestialSphere.matrix);
                pos.project(this.camera);
                
                if (pos.z > -1 && pos.z < 1 && pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1) {
                    // Convert NDC to screen coordinates, accounting for sidebar offset
                    const containerOffsetX = ViewMan.screenOffsetX || 0;
                    const screenX = (pos.x + 1) * this.widthPx / 2 + this.leftPx + containerOffsetX;
                    const screenY = (-pos.y + 1) * this.heightPx / 2 + this.topPx;
                    
                    const dx = screenX - mouseX;
                    const dy = screenY - mouseY;
                    const pixelDistance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (pixelDistance < closestStarDistance) {
                        closestStarDistance = pixelDistance;
                        closestObject = {
                            type: 'star',
                            name: starName,
                            ra: ra,
                            dec: dec,
                            magnitude: mag,
                            pixelDistance: pixelDistance,
                            angle: pixelDistance
                        };
                        console.log(`    -> New closest star: ${starName} at ${pixelDistance.toFixed(1)}px (mag ${mag.toFixed(2)})`);
                    }
                }
            }
        }
        
        // Restore the camera's actual position
        this.camera.position.copy(savedCameraPos);
        this.camera.updateMatrixWorld();

        if (closestObject) {
            if (closestObject.type === 'star' || closestObject.type === 'planet') {
                console.log(`Found closest celestial object: ${closestObject.type} - ${closestObject.name} at ${closestObject.pixelDistance.toFixed(1)}px`);
            } else {
                console.log(`Found closest celestial object: ${closestObject.type} - ${closestObject.name} at ${closestObject.angle.toFixed(2)}°`);
            }
        } else {
            console.log(`No celestial objects found within thresholds`);
        }

        return closestObject;
    }

    // Helper method to show track menu (extracted to avoid duplication)
    showTrackMenu(closestTrack, event) {
        console.log(`Found track near mouse: ${closestTrack.trackID}`);

        // Mirror the track's GUI folder from the Contents menu
        if (closestTrack.guiFolder) {
            // Refresh smoothing parameter visibility before creating the menu
            const trackOb = closestTrack.trackOb;
            const smoothedNode = trackOb?.smoothedTrackNode || trackOb?.trackNode;
            if (smoothedNode?.isDynamicSmoothing) {
                smoothedNode._updateParameterVisibility();
            }

            const menuTitle = `Track: ${closestTrack.trackOb?.menuText || closestTrack.trackID}`;

            // Create a standalone menu and mirror the track's GUI folder
            // Use dismissOnOutsideClick=false so dragging control points doesn't close the menu
            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, false);

            // If menu creation was blocked (persistent menu is open), return early
            if (!standaloneMenu) {
                return;
            }

            // Set up dynamic mirroring for the track's GUI folder
            CustomManager.setupDynamicMirroring(closestTrack.guiFolder, standaloneMenu);

            // Add a method to manually refresh the mirror
            standaloneMenu.refreshMirror = () => {
                CustomManager.updateMirror(standaloneMenu);
            };

            // Open the menu by default
            standaloneMenu.open();
            console.log(`Created standalone menu for track: ${closestTrack.trackID}`);
        }
    }

    onContextMenu(event, mouseX, mouseY) {
        // Prevent the default browser context menu
        event.preventDefault();
        event.stopPropagation();
        
        if (!this.mouseEnabled) return;
        
        // First check for feature markers using screen-space detection (more reliable for screen-invariant markers)
        if (FeatureManager.handleContextMenu(mouseX, mouseY, this)) {
            return; // Feature menu shown, we're done
        }
        
        // mouseX, mouseY are screen coordinates (event.clientX, event.clientY)
        // Convert screen coordinates to NDC for raycasting
        const mouseRay = screenToNDC(this, mouseX, mouseY);
        
        if (this.camera && mouseInViewOnly(this, mouseX, mouseY)) {
            // First, check for 3D objects using raycasting (they have priority over tracks)
            this.raycaster.setFromCamera(mouseRay, this.camera);
            const allIntersects = this.raycaster.intersectObjects(this.scene.children, true);

            // Helper to check if object or any parent has ignoreContextMenu
            const shouldIgnoreContextMenu = (obj) => {
                let current = obj;
                while (current) {
                    if (current.userData?.ignoreContextMenu) return true;
                    current = current.parent;
                }
                return false;
            };

            // Filter out objects marked to ignore context menu (overlays, clouds, sprites)
            const intersects = allIntersects.filter(intersect =>
                !shouldIgnoreContextMenu(intersect.object)
            );

            if (intersects.length > 0) {
                // Track if we found a valid object with nodeId
                let foundObject = false;
                
                // Find the closest intersected object that belongs to a CNode3DObject
                for (const intersect of intersects) {

                    // make a debug sphere at the intersection point
                    // DebugSphere("DEBUGPick" + intersect.point.x +","+intersect.point.y, intersect.point, 1, 0xFF00FF);


                    const object = intersect.object;
                    const objectID = this.findObjectID(object);
                    
                    if (objectID) {
                        console.log(`Found object: ${objectID}`);
                        foundObject = true;

                        // get coordinates of the intersection point
                        const groundPoint = intersect.point;

//                        DebugSphere("DEBUGPIck"+par.frame, groundPoint, 2, 0xFFFF00)

                        // Check if this is a synthetic 3D building - if so, enter edit mode
                        if (objectID.startsWith('synthBuilding_')) {
                            const building = Synth3DManager.getBuilding(objectID);
                            if (building) {
                                console.log(`Right-clicked on synthetic building: ${objectID}, entering edit mode`);
                                
                                // First, exit edit mode on the currently edited building (if any)
                                if (Globals.editingBuilding && Globals.editingBuilding !== building) {
                                    console.log(`  Exiting edit mode on previous building: ${Globals.editingBuilding.buildingID}`);
                                    Globals.editingBuilding.setEditMode(false);
                                }
                                
                                // Enter edit mode (this will create handles and set up state)
                                building.setEditMode(true);
                                
                                // Show the building edit menu at the mouse position (better UX than default position)
                                // This will close the default-positioned menu created by setEditMode and show it at the cursor
                                CustomManager.showBuildingEditingMenu(event.clientX, event.clientY, groundPoint);
                                
                                return; // Edit mode entered, we're done
                            }
                        }
                        
                        // Check if this is a synthetic cloud layer - if so, enter edit mode
                        if (objectID.startsWith('synthClouds_')) {
                            const clouds = Synth3DManager.getClouds(objectID);
                            if (clouds) {
                                console.log(`Right-clicked on synthetic clouds: ${objectID}, entering edit mode`);
                                
                                // First, exit edit mode on the currently edited clouds (if any)
                                if (Globals.editingClouds && Globals.editingClouds !== clouds) {
                                    console.log(`  Exiting edit mode on previous clouds: ${Globals.editingClouds.cloudsID}`);
                                    Globals.editingClouds.setEditMode(false);
                                }
                                
                                // Enter edit mode (this will create handles and set up state)
                                clouds.setEditMode(true);
                                
                                // Show the clouds edit menu at the mouse position
                                CustomManager.showCloudsEditingMenu(event.clientX, event.clientY, groundPoint);
                                
                                return; // Edit mode entered, we're done
                            }
                        }

                        // Get the node from NodeManager
                        const node = NodeMan.get(objectID);
                        if (node && node.gui) {
                            // Create a draggable window with the node's GUI controls
                            const menuTitle = node.menuName;



                            // Create a standalone menu and mirror the object's GUI folder
                            // Use dismissOnOutsideClick=false so interacting with the scene doesn't close the menu
                            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, false);
                            
                            // If menu creation was blocked (persistent menu is open), return early
                            if (!standaloneMenu) {
                                return;
                            }
                            
                            // Set up dynamic mirroring for the object's GUI folder
                            CustomManager.setupDynamicMirroring(node.gui, standaloneMenu);
                            
                            // Add a method to manually refresh the mirror
                            standaloneMenu.refreshMirror = () => {
                                CustomManager.updateMirror(standaloneMenu);
                            };
                            
                            // Open the menu by default
                            standaloneMenu.open();
                            // console.log(`Created standalone menu for object: ${objectID}`);
                        } else {
                            console.log(`Node ${objectID} not found or has no GUI folder`);
                        }
                        return; // Found an object, don't check tracks or ground
                    } else {
                        // Debug: log what we're hitting
                       // console.log(`Hit object without valid name: ${object.type}, name: "${object.name}", userData:`, object.userData);
                    }
                }
                
                // If we didn't find an object with nodeId, but we hit something (like terrain/ground)
                // Ground/sphere collision takes priority over celestial objects
                if (!foundObject) {
                    // Check if we're close to any track in screen space
                    // Tracks are too thin to pick with raycasting, so we check screen space distance
                    const closestTrack = this.findClosestTrack(mouseX, mouseY, 10);
                    
                    if (closestTrack) {
                        this.showTrackMenu(closestTrack, event);
                        return; // Found a track, don't show ground menu
                    }
                    
                    // We hit something (ground/terrain), show ground context menu if in custom sitch
                    // Ground/sphere takes priority over celestial objects
                    if (Sit.isCustom) {
                        // Get the first intersection point (closest to camera)
                        const groundPoint = intersects[0].point;
                        console.log(`Ground clicked at:`, groundPoint);
                        
                        // Show the ground context menu
                        CustomManager.showGroundContextMenu(mouseX, mouseY, groundPoint);
                        return; // Ground menu shown, don't check celestial objects
                    }
                }
            }
            
            // No intersections with 3D objects or ground, check for tracks
            const closestTrack = this.findClosestTrack(mouseX, mouseY, 10);
            
            if (closestTrack) {
                this.showTrackMenu(closestTrack, event);
                return; // Found a track, don't check celestial objects
            }
            
            // No tracks found, check for celestial objects (stars, planets, satellites)
            const celestialObject = this.findClosestCelestialObject(mouseRay, mouseX, mouseY);
            
            if (celestialObject) {
                this.showCelestialObjectMenu(celestialObject, event.clientX, event.clientY);
            }
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


