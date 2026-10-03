import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";

const directions = {perspective:[-1.6,.7,1],front:[0,0,1],rear:[0,0,-1],side:[-1,0,0],top:[0,1,.0001]};

export function fitVehicleCamera(camera, controls, bounds, {view="perspective",direction=directions[view],paddingX=1.12,paddingY=1.18} = {}) {
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const look = new THREE.Vector3(...direction).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up,look).normalize();
    const up = new THREE.Vector3().crossVectors(look,right).normalize();
    let distance = sphere.radius;
    for (const x of [bounds.min.x,bounds.max.x])
        for (const y of [bounds.min.y,bounds.max.y])
            for (const z of [bounds.min.z,bounds.max.z]) {
                const corner = new THREE.Vector3(x,y,z).sub(sphere.center), depth = corner.dot(look);
                distance = Math.max(distance,depth+Math.abs(corner.dot(right))/Math.tan(hfov/2)*paddingX,
                    depth+Math.abs(corner.dot(up))/Math.tan(vfov/2)*paddingY);
            }
    // Flush damping before changing views, so a drag cannot carry a stale delta.
    const damping = controls.enableDamping; controls.enableDamping = false; controls.update(); controls.enableDamping = damping;
    controls.target.copy(sphere.center); camera.position.copy(sphere.center).addScaledVector(look,distance);
    camera.near = Math.max(.001,sphere.radius/1000); camera.far = Math.max(3000,distance*30);
    camera.updateProjectionMatrix(); controls.update();
}

export function captureVehicleThumbnail(canvas) {
    const thumbnail = document.createElement("canvas"); thumbnail.width = 300; thumbnail.height = 200;
    thumbnail.getContext("2d").drawImage(canvas,0,0,300,200);
    return thumbnail.toDataURL("image/jpeg",.8);
}

// Presentation options differ between the editor and picker; the renderer,
// studio lighting, camera fitting and resource lifetime have one implementation.
export function createVehicleStudio(mount, {background="#dfe9f0",fov=36,damping=false,onChange=()=>{}} = {}) {
    const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,2));
    renderer.setClearColor(background); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    mount.append(renderer.domElement); renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label","3D vehicle. Drag to orbit, scroll to zoom, right-drag to pan.");
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(fov,1,.01,3000);
    const ambient = new THREE.HemisphereLight("#ffffff","#718da6",1.6);
    const key = new THREE.DirectionalLight("#fff8ed",2.3); key.position.set(20,35,25);
    const fill = new THREE.DirectionalLight("#cde8ff",.85); fill.position.set(-25,10,-15);
    scene.add(ambient,key,fill);
    const controls = new OrbitControls(camera,renderer.domElement);
    controls.enableDamping = damping; controls.dampingFactor = .1; controls.autoRotateSpeed = .65;
    controls.addEventListener("change",onChange);
    let thermal, thermalLoad, disposed = false, mode = "visible", model, frame = 0;
    const studio = {renderer,scene,camera,controls,
        get mode() {return mode;},
        get thermal() {return thermal;},
        setModel(value) {model = value;},
        async loadThermal(options) {
            if (thermal) return thermal;
            if (!thermalLoad) thermalLoad = import(/* webpackChunkName: "vehicle-thermal" */ "./thermalPreview.js")
                .then(({createVehicleThermalPreview}) => {
                    if (disposed) return null;
                    thermal = createVehicleThermalPreview({renderer, ...options}); return thermal;
                }).finally(() => {thermalLoad = null;});
            return thermalLoad;
        },
        setMode(value) {
            if (!["visible", "ir"].includes(value) || (value === "ir" && !thermal)) throw new Error("Preview mode is not ready");
            mode = value; controls.enabled = mode === "visible"; studio.resize();
        },
        // Only the editor camera is fitted; sensor range and aspect have separate ownership.
        fit(bounds,options) {fitVehicleCamera(camera,controls,bounds,options);},
        render({mode: drawMode = mode, frame: nextFrame = frame} = {}) {
            if (disposed) return;
            frame = nextFrame;
            if (drawMode === "ir") {
                if (!thermal || !model) throw new Error("IR preview is not ready");
                thermal.render(scene,model,frame);
            } else renderer.render(scene,camera);
        },
        resize() {
            let width = mount.clientWidth, height = mount.clientHeight;
            if (!width || !height) return false;
            if (mode === "ir") {
                const aspect = thermal.settings.detectorWidth / thermal.settings.detectorHeight;
                if (width / height > aspect) width = height * aspect; else height = width / aspect;
            }
            Object.assign(renderer.domElement.style, {width: `${width}px`, height: `${height}px`,
                left: `${(mount.clientWidth - width) / 2}px`, top: `${(mount.clientHeight - height) / 2}px`});
            renderer.setSize(width,height,false); camera.aspect = width/height; camera.updateProjectionMatrix(); return true;
        },
        setNight(night) {
            renderer.setClearColor(night ? "#081421" : background);
            ambient.intensity = night ? .15 : 1.6; key.intensity = night ? .10 : 2.3; fill.intensity = night ? .08 : .85;
        },
        thumbnail() {
            const savedMode = mode;
            try {mode = "visible"; studio.resize(); studio.render({mode:"visible"}); return captureVehicleThumbnail(renderer.domElement);}
            finally {mode = savedMode; studio.resize(); if (mode === "ir") studio.render();}
        },
        dispose() {disposed = true; thermal?.dispose(); controls.dispose(); renderer.dispose(); renderer.domElement.remove();},
    };
    return studio;
}
