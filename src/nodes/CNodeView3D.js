import {par} from "../par";
import {normalizeLayerType} from "../utils";
import {XYZ2EA, XYZJ2PR} from "../SphericalMath";
import {
    CustomManager,
    Globals,
    guiMenus,
    guiTweaks,
    keyHeld,
    NodeMan,
    setGPUMemoryMonitor,
    setRenderOne,
    Synth3DManager
} from "../Globals";
import {GlobalDaySkyScene, GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "../LocalFrame";
import {DRAG, makeMouseRay} from "../mouseMoveView";
import {TrackManager} from "../TrackManager";
import {GPUMemoryMonitor} from "../GPUMemoryMonitor";
import {
    Camera,
    Color,
    LinearFilter,
    Mesh,
    NearestFilter,
    NormalBlending,
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
import {wgs84} from "../LLA-ECEF-ENU";
import {getCameraNode} from "./CNodeCamera";
import {CNodeEffect} from "./CNodeEffect";
import {assert} from "../assert.js";
import {V3} from "../threeUtils";
import {ACESFilmicToneMappingShader} from "../shaders/ACESFilmicToneMappingShader";
import {ShaderPass} from "three/addons/postprocessing/ShaderPass.js";
import {isLocal, SITREC_APP} from "../configUtils.js"
import {VRButton} from 'three/addons/webxr/VRButton.js';
import {mouseInViewOnly, mouseToView} from "../ViewUtils";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {CameraMapControls} from "../js/CameraControls";
import {ViewMan} from "../CViewManager";
import * as LAYER from "../LayerMasks";
import {globalProfiler} from "../VisualProfiler";
import {FeatureManager} from "../CFeatureManager";


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
        }
        this.addSimpleSerial("northUp");


        this.isIR = v.isIR ?? false;
        this.fovOverride = v.fovOverride;
        this.layers = normalizeLayerType(v.layers) ?? undefined; // leaving it undefined will use the camera layers


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

        // When using a logorithmic depth buffer (or any really)
        // need to ensure the near/far clip distances are propogated to custom shaders

//        console.log(" devicePixelRatio = "+window.devicePixelRatio+" canvas.width = "+this.canvas.width+" canvas.height = "+this.canvas.height)
        //       console.log("Window inner width = "+window.innerWidth+" height = "+window.innerHeight)

        // this.renderer = new WebGLRenderer({antialias: true, canvas: this.canvas, logarithmicDepthBuffer: true})
        //
        // if (this.in.canvasWidth) {
        //     // if a fixed pixel size canvas, then we ignore the devicePixelRatio
        //     this.renderer.setPixelRatio(1);
        // } else {
        //     this.renderer.setPixelRatio(window.devicePixelRatio);
        // }

        // this.renderer.setSize(this.widthPx, this.heightPx, false); // false means don't update the style
        // this.composer = new EffectComposer(this.renderer)
        // const renderPass = new RenderPass( GlobalScene, this.camera );
        // this.composer.addPass( renderPass );

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
            
            // Add renderSky sub-folder
            const skyFolder = debugFolder.addFolder("Sky Steps");
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateStarScales").name("Update Star Scales").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateSatelliteScales").name("Update Satellite Scales").onChange(() => setRenderOne(true));
            skyFolder.add(Globals.renderDebugFlags, "dbg_updateSatelliteText").name("Update Satellite Text").onChange(() => setRenderOne(true));
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

        if (Globals.canVR) {

            // Setup WebXR
            this.renderer.xr.enabled = true;
            this.xrSession = null;

            // Bind event handlers
            this.onXRSessionStarted = this.onXRSessionStarted.bind(this);
            this.onXRSessionEnded = this.onXRSessionEnded.bind(this);

            // Add WebXR button
            // const xrButton = document.createElement('button');
            // xrButton.textContent = 'Enter VR';
            // xrButton.addEventListener('click', this.startXRSession.bind(this));
            // // give it a high z-index so it's on top of everything
            // xrButton.style.zIndex = 10003;
            // // center it in the middle of the screen
            // xrButton.style.position = 'absolute';
            // xrButton.style.left = '50%';
            // xrButton.style.top = '50%';
            // xrButton.style.transform = 'translate(-50%, -50%)';
            // document.body.appendChild(xrButton);

            const xrButton = VRButton.createButton(this.renderer);
            xrButton.style.zIndex = 10003;
            document.body.appendChild(xrButton);
        }
    }


    startXRSession() {
        if (navigator.xr) {
            navigator.xr.requestSession('immersive-vr').then(this.onXRSessionStarted);
        } else {
            showError('WebXR not supported on this device');
        }
    }

    onXRSessionStarted(session) {
        this.xrSession = session;
        this.renderer.xr.setSession(session);

        session.addEventListener('end', this.onXRSessionEnded);
    }

    onXRSessionEnded() {
        this.xrSession = null;
        this.renderer.xr.setSession(null);
    }


    // return the viewport's hfov in radians
    // assumes the camera's fov is the viewport's vfov
    getHFOV() {
        const vfov = this.camera.fov * Math.PI / 180;
        const aspect = this.widthPx / this.heightPx;
        // given the vfov, and the aspect ratio, we can calculate the hfov
        return 2 * Math.atan(Math.tan(vfov / 2) * aspect);
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
                console.log("[CNodeView3D] Creating new GPU Memory Monitor");
                try {
                    const monitor = new GPUMemoryMonitor(this.renderer, GlobalScene);
                    setGPUMemoryMonitor(monitor);
                    console.log("✓ GPU Memory Monitor initialized successfully");
                    
                    // Make it globally accessible for testing
                    window._gpuMonitor = monitor;
                    console.log("✓ Monitor available as: window._gpuMonitor or window.Globals.GPUMemoryMonitor");
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

                // Only resize render targets if dimensions actually changed
                // This avoids thrashing GPU memory in split-screen mode
                if (width !== this.lastRenderTargetWidth || height !== this.lastRenderTargetHeight) {
                    this.renderTargetAntiAliased.setSize(width, height);
                    if (this.effectsEnabled) {
                        this.renderTargetA.setSize(width, height);
                        this.renderTargetB.setSize(width, height);
                    }
                    this.lastRenderTargetWidth = width;
                    this.lastRenderTargetHeight = height;
                }

                currentRenderTarget = this.renderTargetAntiAliased;
                this.renderer.setRenderTarget(currentRenderTarget);
                
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



                //
                sharedUniforms.sunGlobalTotal.value =
                    lightingNode.sunIntensity
                    + lightingNode.sunIntensity * lightingNode.sunScattering
                    + lightingNode.ambientIntensity;

                sharedUniforms.sunAmbientIntensity.value = lightingNode.ambientIntensity;


                // update the sun node, which controls the global scene lighting
                const sunNode = NodeMan.get("theSun", true);
                if (sunNode !== undefined) {
                    sunNode.update();
                }

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
                if (this.layers !== undefined) {
                    this.camera.layers.mask = this.layers;
                }


                // [DBG] Render main scene
                if (Globals.renderDebugFlags.dbg_renderMainScene) {
                    // Render the scene to the off-screen canvas or render target
                    this.renderer.render(GlobalScene, this.camera);
                }

                if (this.layers !== undefined) {
                    this.camera.layers.mask = oldLayers;
                }


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

            if (Globals.renderDebugFlags.dbg_updateSatelliteText && (
                this.id === "lookView" && nightSkyNode.showSatelliteNames
                || this.id === "mainView" && nightSkyNode.showSatelliteNamesMain)) {
                // updating the satellite text is just applying the offset per viewport
                nightSkyNode.updateSatelliteText(this)
            }

            this.renderer.setClearColor(this.background);
            // if (nightSkyNode.useDayNight && nightSkyNode.skyColor !== undefined) {
            //     this.renderer.setClearColor(nightSkyNode.skyColor);
            // }

            let skyBrightness = 0;
            let skyColor = this.background;
            let skyOpacity = 1;


            //           why is main view dark when look view camera is in darkness
            //           is it not useing the main view camera here?

            const sunNode = NodeMan.get("theSun", true);
            if (sunNode !== undefined) {
//                    this.renderer.setClearColor(sunNode.calculateSkyColor(this.camera.position))
                this.renderer.setClearColor("black")
                skyColor = sunNode.calculateSkyColor(this.camera.position);
                skyBrightness = sunNode.calculateSkyBrightness(this.camera.position);
                skyOpacity = sunNode.calculateSkyOpacity(this.camera.position);
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

                // Add the fullscreen quad to a scene dedicated to it
                // PROBLEM - WHY DO WE NEED TO KEEP RECREATING THIS?????
                // if we move the new Mesh to the initSky() function, then it
                // will render was a plain white polygon. Why?
                // Not a serious issue, but seems like a bug
                // or possible some asyc issue with the renerer.clear call

                // // cleanup the old quad and scene
                if (this.fullscreenQuadScene !== undefined) {
                    // cleanly remove the scene
                    this.fullscreenQuadScene.remove(this.fullscreenQuad);

                }
                this.fullscreenQuad = new Mesh(this.fullscreenQuadGeometry, this.skyBrightnessMaterial);
                this.fullscreenQuadScene.add(this.fullscreenQuad);

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

    renderCanvas(frame) {
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

        // calculate the focal length in pixels
        // to pass in a a uniform (cameraFocalLength) to the shader
        const fov = this.camera.fov * Math.PI / 180;
        const focalLength = this.heightPx / (2 * Math.tan(fov / 2));
        sharedUniforms.cameraFocalLength.value = focalLength;

        this.camera.aspect = this.canvas.width / this.canvas.height;
        this.camera.updateProjectionMatrix();
        if (globalProfiler) globalProfiler.pop();

        // Profile: Camera Controls
        if (globalProfiler) globalProfiler.push('#2ca02c', 'cameraControls');
        if (this.controls) {
            this.controls.update(1);

            // if we have a focus track, then focus on it after camera controls have updated
            if (this.focusTrackName !== "default") {
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

        // convert to coordinates relative to lower left of view
        var mouseYUp = this.heightPx - (mouseY - this.topPx)
        var mouseRay = makeMouseRay(this, mouseX, mouseYUp);

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

            /*

            // TODO: dragging spheres

            // we don't check the glare (green) sphere if it's locked to the white (target sphere)
            if (targetSphere.position.y !== glareSphere.position.y) {
                if (intersects.find(hit => hit.object == glareSphere) != undefined) {
                    // CLICKED ON THE green SPHERE
                    this.dragMode = DRAG.MOVEHANDLE;
                    // must pause, as we are controlling the pod now
                    par.paused = true;
                }
            }
            if (intersects.find(hit => hit.object == targetSphere) != undefined) {

                if (this.dragMode === 1) {
                    var glareSphereWorldPosition = glareSphere.getWorldPosition(new Vector3())
                    var targetSphereWorldPosition = targetSphere.getWorldPosition(new Vector3())
                    var distGlare = this.raycaster.ray.distanceSqToPoint(glareSphereWorldPosition)
                    var distTarget = this.raycaster.ray.distanceSqToPoint(targetSphereWorldPosition)
                    //console.log("glare = " + distGlare + " target = " + distTarget)
                    // already in mode 1 (glare)
                    // so only switch if targetGlare is closer to the ray
                    if (distTarget < distGlare)
                        this.dragMode = 2;
                } else {
                    this.dragMode = 2;
                }
                // must pause, as we are controlling the pod now
                par.paused = true;
            }
*/
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


        var mouseYUp = this.heightPx - (mouseY - this.topPx)
        var mouseRay = makeMouseRay(this, mouseX, mouseYUp);

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
                const dragSphere = new Sphere(new Vector3(0, -wgs84.RADIUS, 0), wgs84.RADIUS /* + f2m(this.defaultTargetHeight) */)
                if (this.raycaster.ray.intersectSphere(dragSphere, possibleTarget)) {
                    target = possibleTarget.clone()
                }
            }

            // regardless of what we find above, if there's a focusTrackName, then snap to the closest point on that track
            if (this.focusTrackName !== "default") {
                var focusTrackNode = NodeMan.get(this.focusTrackName)

                var closestFrame = focusTrackNode.closestFrameToRay(this.raycaster.ray)

                target = focusTrackNode.p(closestFrame)
                this.camera.lookAt(target);

                // holding down command/Window let's you scrub along the track
                if (keyHeld['meta']) {
                    par.frame = closestFrame
                    setRenderOne(true);
                }


            }


            if (target != undefined) {
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
            const screenX_A = (screenPos_A.x * 0.5 + 0.5) * this.widthPx + this.leftPx;
            const screenY_A = (1 - (screenPos_A.y * 0.5 + 0.5)) * this.heightPx + this.topPx;
            
            const screenX_B = (screenPos_B.x * 0.5 + 0.5) * this.widthPx + this.leftPx;
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
            
            if (!trackNode || !trackNode.visible) return;
            
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
                standaloneMenu.add({raHours: data.ra * 12 / Math.PI}, 'raHours').name('RA (hours)').listen().disable();
            }
            if (data.dec !== undefined) {
                standaloneMenu.add({decDegrees: data.dec * 180 / Math.PI}, 'decDegrees').name('Dec (degrees)').listen().disable();
            }
            if (data.mag !== undefined) {
                standaloneMenu.add({magnitude: data.mag}, 'magnitude').name('Magnitude').listen().disable();
            }
        } else if (celestialObject.type === 'satellite') {
            standaloneMenu.add({number: celestialObject.number}, 'number').name('NORAD Number').listen().disable();
            standaloneMenu.add({name: celestialObject.name}, 'name').name('Name').listen().disable();
        } else if (celestialObject.type === 'star') {
            if (celestialObject.ra !== undefined) {
                standaloneMenu.add({raHours: celestialObject.ra * 12 / Math.PI}, 'raHours').name('RA (hours)').listen().disable();
            }
            if (celestialObject.dec !== undefined) {
                standaloneMenu.add({decDegrees: celestialObject.dec * 180 / Math.PI}, 'decDegrees').name('Dec (degrees)').listen().disable();
            }
            if (celestialObject.magnitude !== undefined && celestialObject.magnitude !== 'Unknown') {
                standaloneMenu.add({magnitude: celestialObject.magnitude}, 'magnitude').name('Magnitude').listen().disable();
            }
        }
        
        // Add angle information (how close to the click)
        standaloneMenu.add({angle: celestialObject.angle.toFixed(3)}, 'angle').name('Angle (degrees)').listen().disable();
        
        // Open the menu
        standaloneMenu.open();
    }

    // Find the closest celestial object (star, planet, or satellite) to a ray
    findClosestCelestialObject(mouseRay, maxAngleDegrees = 5) {
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
        
        // Restore the camera's actual position
        this.camera.position.copy(savedCameraPos);
        this.camera.updateMatrixWorld();
        
        console.log(`Checking celestial objects:`);
        console.log(`  Ray direction (from origin): (${rayDirection.x.toFixed(4)}, ${rayDirection.y.toFixed(4)}, ${rayDirection.z.toFixed(4)})`);

        // Check planets
        if (nightSkyNode.planets.planetSprites) {
            console.log(`Checking ${Object.keys(nightSkyNode.planets.planetSprites).length} planets`);
            for (const [planetName, planetData] of Object.entries(nightSkyNode.planets.planetSprites)) {
                if (!planetData.sprite || !planetData.sprite.visible) continue;

                // Get planet position in world space
                // Planets are on a celestial sphere, so we only care about direction, not distance
                // The sprite position is in the celestial sphere's local space, so we need world position
                const planetLocalPos = planetData.sprite.position.clone();
                const planetWorldPos = new Vector3();
                planetData.sprite.getWorldPosition(planetWorldPos);
                const planetDir = planetWorldPos.clone().normalize(); // Direction from world origin

                // Calculate angle between ray and planet direction
                const dot = rayDirection.dot(planetDir);
                const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
                
                console.log(`  Planet ${planetName}: angle = ${angle.toFixed(2)}°, visible = ${planetData.sprite.visible}`);
                if (planetName === "Sun") {
                    // Calculate RA/Dec from local position to compare with stars
                    const sunRA = Math.atan2(planetLocalPos.y, planetLocalPos.x);
                    const sunDec = Math.asin(planetLocalPos.z / planetLocalPos.length());
                    console.log(`    Sun RA=${sunRA.toFixed(4)} (${(sunRA*180/Math.PI).toFixed(2)}°), Dec=${sunDec.toFixed(4)} (${(sunDec*180/Math.PI).toFixed(2)}°)`);
                    console.log(`    Sun local pos: (${planetLocalPos.x.toFixed(4)}, ${planetLocalPos.y.toFixed(4)}, ${planetLocalPos.z.toFixed(4)})`);
                    console.log(`    Sun world pos: (${planetWorldPos.x.toFixed(4)}, ${planetWorldPos.y.toFixed(4)}, ${planetWorldPos.z.toFixed(4)})`);
                    console.log(`    Sun world dir: (${planetDir.x.toFixed(4)}, ${planetDir.y.toFixed(4)}, ${planetDir.z.toFixed(4)})`);
                }

                if (angle < closestAngle) {
                    closestAngle = angle;
                    closestObject = {
                        type: 'planet',
                        name: planetName,
                        data: planetData,
                        angle: angle
                    };
                    console.log(`    -> New closest object: ${planetName} at ${angle.toFixed(2)}°`);
                }
            }
        }

        // Check satellites
        if (nightSkyNode.TLEData && nightSkyNode.TLEData.satData) {
            for (const satData of nightSkyNode.TLEData.satData) {
                if (!satData.visible || !satData.eus) continue;

                // Get satellite position
                const satPos = satData.eus.clone();
                const satDir = satPos.clone().sub(this.camera.position).normalize();

                // Calculate angle between ray and satellite direction
                const dot = rayDirection.dot(satDir);
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
        }

        if (closestObject) {
            console.log(`Found closest celestial object: ${closestObject.type} - ${closestObject.name} at ${closestObject.angle.toFixed(2)}°`);
        } else {
            console.log(`No celestial objects found within ${maxAngleDegrees}°`);
        }

        return closestObject;
    }

    // Helper method to show track menu (extracted to avoid duplication)
    showTrackMenu(closestTrack, event) {
        console.log(`Found track near mouse: ${closestTrack.trackID}`);
        
        // Mirror the track's GUI folder from the Contents menu
        if (closestTrack.guiFolder) {
            const menuTitle = `Track: ${closestTrack.trackOb?.menuText || closestTrack.trackID}`;
            
            // Create a standalone menu and mirror the track's GUI folder
            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, true);
            
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
        // Convert to view-relative coordinates
        const [viewX, viewY] = mouseToView(this, mouseX, mouseY);
        
        // Convert to coordinates relative to lower left of view (same as onMouseDown)
        const mouseYUp = this.heightPx - viewY;
        const mouseRay = makeMouseRay(this, viewX, mouseYUp);
        
        if (this.camera && mouseInViewOnly(this, mouseX, mouseY)) {
            // First, check for 3D objects using raycasting (they have priority over tracks)
            this.raycaster.setFromCamera(mouseRay, this.camera);
            const intersects = this.raycaster.intersectObjects(this.scene.children, true);
            
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

                        // Get the node from NodeManager
                        const node = NodeMan.get(objectID);
                        if (node && node.gui) {
                            // Create a draggable window with the node's GUI controls
                            const menuTitle = `3D Ob: ${objectID}`;
                            
                            // Create a standalone menu and mirror the object's GUI folder
                            // Use the same approach as tracks for consistency
                            const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, event.clientX, event.clientY, true);
                            
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
            const celestialObject = this.findClosestCelestialObject(mouseRay);
            
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


