import {CNode3DGroup} from "./CNode3DGroup";
import {
    Color,
    DoubleSide,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Mesh,
    MeshBasicMaterial,
    Plane,
    PlaneGeometry,
    Raycaster,
    ShaderMaterial,
    SphereGeometry,
    TextureLoader,
    Vector3
} from "three";
import * as LAYER from "../LayerMasks";
import {dropFromDistance, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {EUSToLLA, LLAToEUS} from "../LLA-ECEF-ENU";
import {screenToNDC} from "../mouseMoveView";
import {ViewMan} from "../CViewManager";
import {CustomManager, Globals, guiMenus, NodeMan, setRenderOne, Sit, Synth3DManager, UndoManager} from "../Globals";
import {mouseInViewOnly} from "../ViewUtils";
import {f2m, metersPerSecondFromKnots, radians} from "../utils";
import {SITREC_APP} from "../configUtils";
import seedrandom from "seedrandom";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {par} from "../par";

let rng;

function getRandomFloat(min, max) {
    return rng() * (max - min) + min;
}

function buildEdgeRadiusTable(baseRadius, wiggle, frequency, seed) {
    const TABLE_SIZE = 3600;
    const table = new Float32Array(TABLE_SIZE);
    
    if (wiggle <= 0) {
        table.fill(baseRadius);
        return { table, maxRadius: baseRadius };
    }
    
    const rngEdge = seedrandom(seed.toString() + '_edge');
    const phases = new Float32Array(frequency);
    const amps = new Float32Array(frequency);
    
    for (let i = 0; i < frequency; i++) {
        phases[i] = rngEdge() * Math.PI * 2;
        amps[i] = (1 / (i + 1)) * wiggle * baseRadius;
    }
    
    let maxRadius = 0;
    for (let t = 0; t < TABLE_SIZE; t++) {
        const angle = (t / TABLE_SIZE) * Math.PI * 2;
        let offset = 0;
        for (let i = 0; i < frequency; i++) {
            offset += Math.sin(angle * (i + 1) + phases[i]) * amps[i];
        }
        table[t] = baseRadius + offset;
        if (table[t] > maxRadius) maxRadius = table[t];
    }
    
    return { table, maxRadius };
}

function getEdgeRadiusFromTable(table, angle) {
    const TABLE_SIZE = 3600;
    const TWO_PI = Math.PI * 2;
    const normalizedAngle = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
    const indexFloat = (normalizedAngle / TWO_PI) * TABLE_SIZE;
    const index0 = Math.floor(indexFloat) % TABLE_SIZE;
    const index1 = (index0 + 1) % TABLE_SIZE;
    const frac = indexFloat - Math.floor(indexFloat);
    return table[index0] * (1 - frac) + table[index1] * frac;
}

export class CNodeSynthClouds extends CNode3DGroup {
    constructor(v) {
        super(v);
        
        this.cloudsID = v.id;
        this.name = v.name || v.id;
        
        this.centerLat = v.centerLat;
        this.centerLon = v.centerLon;
        this.altitude = v.altitude !== undefined ? v.altitude : f2m(10000);
        this.radius = v.radius !== undefined ? v.radius : 500;
        this.depth = v.depth !== undefined ? v.depth : 0;
        this.edgeWiggle = v.edgeWiggle !== undefined ? v.edgeWiggle : 0;
        this.edgeFrequency = v.edgeFrequency !== undefined ? v.edgeFrequency : 5;
        this.cloudSize = v.cloudSize !== undefined ? v.cloudSize : 200;
        this.density = v.density !== undefined ? v.density : 0.5;
        this.opacity = v.opacity !== undefined ? v.opacity : 0.8;
        this.brightness = v.brightness !== undefined ? v.brightness : 1.0;
        this.seed = v.seed !== undefined ? v.seed : 0;
        this.feather = v.feather !== undefined ? v.feather : 1000;
        
        this.windMode = v.windMode !== undefined ? v.windMode : "No Wind";
        this.windFrom = v.windFrom !== undefined ? v.windFrom : 270;
        this.windKnots = v.windKnots !== undefined ? v.windKnots : 50;
        
        this.basePosition = null;
        
        this.cloudMesh = null;
        this.cloudGeometry = null;
        
        this.cloudTexture = new TextureLoader().load(SITREC_APP + 'data/images/cloud-sprite-flatter.png?v=2');
        
        this.editMode = false;
        this.isDragging = false;
        this.draggingHandle = null;
        this.dragLocalUp = null;
        this.hoveredHandle = null;
        
        this.radiusHandle = null;
        this.altitudeHandle = null;
        this.moveHandle = null;
        
        this.raycaster = new Raycaster();
        this.raycaster.layers.mask = LAYER.MASK_HELPERS;
        
        this.buildCloudMesh();
        this.setupEventListeners();
        this.createGUIFolder();
    }
    
    updateGroupPosition() {
        const centerEUS = LLAToEUS(this.centerLat, this.centerLon, this.altitude);
        this.basePosition = centerEUS.clone();
        this.group.position.copy(centerEUS);
        this.localUp = getLocalUpVector(centerEUS);
    }
    
    buildCloudMesh() {
        if (this.cloudMesh) {
            this.group.remove(this.cloudMesh);
            if (this.cloudGeometry) this.cloudGeometry.dispose();
            if (this.cloudMesh.material) this.cloudMesh.material.dispose();
        }
        
        const centerEUS = LLAToEUS(this.centerLat, this.centerLon, this.altitude);
        this.basePosition = centerEUS.clone();
        this.localUp = getLocalUpVector(centerEUS);
        this.group.position.copy(centerEUS);
        
        const east = new Vector3(1, 0, 0).cross(this.localUp).normalize();
        const north = new Vector3().crossVectors(this.localUp, east).normalize();
        
        rng = seedrandom(this.seed.toString());
        
        const numClouds = Math.floor(this.density * this.radius * this.radius * 0.0001);
        
        this.instanceOffsets = new Float32Array(numClouds * 3);
        this.instanceSizes = new Float32Array(numClouds * 2);
        const offsets = this.instanceOffsets;
        const sizes = this.instanceSizes;
        
        const w = this.cloudSize;
        const h = this.cloudSize * 0.5;
        const hVar = h * 0.3;
        const halfDepth = this.depth / 2;
        
        const ex = east.x, ey = east.y, ez = east.z;
        const nx = north.x, ny = north.y, nz = north.z;
        const ux = this.localUp.x, uy = this.localUp.y, uz = this.localUp.z;
        
        const { table: edgeRadiusTable, maxRadius: sampleRadius } = buildEdgeRadiusTable(this.radius, this.edgeWiggle, this.edgeFrequency, this.seed);
        
        let cloudIndex = 0;
        let attempts = 0;
        const maxAttempts = numClouds * 10;
        
        while (cloudIndex < numClouds && attempts < maxAttempts) {
            attempts++;
            const angle = rng() * Math.PI * 2;
            const dist = Math.sqrt(rng()) * sampleRadius;
            const maxRadius = getEdgeRadiusFromTable(edgeRadiusTable, angle);
            
            if (dist > maxRadius) continue;
            
            if (this.feather > 0) {
                const distFromEdge = maxRadius - dist;
                if (distFromEdge < this.feather) {
                    const probability = distFromEdge / this.feather;
                    if (rng() > probability) continue;
                }
            }
            
            const drop = dropFromDistance(dist);

            const offsetX = Math.cos(angle) * dist;
            const offsetZ = Math.sin(angle) * dist;
            const depthOffset = halfDepth > 0 ? (rng() * this.depth - halfDepth) : 0;
            const heightVariation = (rng() * hVar * 2 - hVar) + depthOffset - drop;
            
            const idx3 = cloudIndex * 3;
            offsets[idx3] = ex * offsetX + nx * offsetZ + ux * heightVariation;
            offsets[idx3 + 1] = ey * offsetX + ny * offsetZ + uy * heightVariation;
            offsets[idx3 + 2] = ez * offsetX + nz * offsetZ + uz * heightVariation;
            
            const idx2 = cloudIndex * 2;
            sizes[idx2] = w;
            sizes[idx2 + 1] = h;
            
            cloudIndex++;
        }
        
        this.cloudCount = cloudIndex;
        this.combGap = cloudIndex;
        this.combIndex = 0;
        
        const baseQuad = new PlaneGeometry(1, 1);
        this.cloudGeometry = new InstancedBufferGeometry();
        this.cloudGeometry.index = baseQuad.index;
        this.cloudGeometry.setAttribute('position', baseQuad.getAttribute('position'));
        this.cloudGeometry.setAttribute('uv', baseQuad.getAttribute('uv'));
        this.cloudGeometry.setAttribute('instanceOffset', new InstancedBufferAttribute(this.instanceOffsets, 3));
        this.cloudGeometry.setAttribute('instanceSize', new InstancedBufferAttribute(this.instanceSizes, 2));
        this.cloudGeometry.instanceCount = this.cloudCount;
        
        const baseColor = Math.min(this.brightness, 1.0);
        const emissiveIntensity = Math.max(0, this.brightness - 1.0);
        
        const cloudMaterial = new ShaderMaterial({
            uniforms: {
                map: { value: this.cloudTexture },
                opacity: { value: this.opacity },
                color: { value: new Color(baseColor, baseColor, baseColor) },
                emissive: { value: new Color(emissiveIntensity, emissiveIntensity, emissiveIntensity) },
                sunDirection: { value: new Vector3(0, 1, 0) },
                earthCenter: { value: new Vector3(0, 0, 0) },
                ...sharedUniforms,
            },
            vertexShader: `
                attribute vec3 instanceOffset;
                attribute vec2 instanceSize;
                varying vec2 vUv;
                varying float vDepth;
                varying vec3 vWorldPosition;
                
                void main() {
                    vUv = uv;
                    
                    vec3 cameraRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
                    vec3 cameraUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
                    
                    vec3 vertexPosition = instanceOffset 
                        + cameraRight * position.x * instanceSize.x 
                        + cameraUp * position.y * instanceSize.y;
                    
                    vec4 worldPos = modelMatrix * vec4(instanceOffset, 1.0);
                    vWorldPosition = worldPos.xyz;
                    
                    vec4 mvPosition = modelViewMatrix * vec4(vertexPosition, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    vDepth = gl_Position.w;
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform float opacity;
                uniform vec3 color;
                uniform vec3 emissive;
                uniform float nearPlane;
                uniform float farPlane;
                uniform vec3 sunDirection;
                uniform vec3 earthCenter;
                uniform float sunAmbientIntensity;
                varying vec2 vUv;
                varying float vDepth;
                varying vec3 vWorldPosition;
                
                void main() {
                    vec4 texColor = texture2D(map, vUv);
                    float alpha = texColor.a * opacity;
                    if (alpha < 0.01) discard;
                    
                    vec3 globalNormal = normalize(vWorldPosition - earthCenter);
                    float globalIntensity = max(dot(globalNormal, sunDirection), -0.1);
                    float dayFactor = smoothstep(-0.1, 0.1, globalIntensity);
                    float lighting = mix(sunAmbientIntensity, 1.0, dayFactor);
                    vec3 litColor = texColor.rgb * color * lighting + emissive;
                    gl_FragColor = vec4(litColor, alpha);
                    
                    float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                    gl_FragDepthEXT = z * 0.5 + 0.5;
                }
            `,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            side: DoubleSide,
        });
        
        this.cloudMesh = new Mesh(this.cloudGeometry, cloudMaterial);
        this.cloudMesh.layers.mask = LAYER.MASK_WORLD;
        this.cloudMesh.frustumCulled = false;
        this.cloudMesh.userData.ignoreContextMenu = true;  // Allow right-clicks to pass through to ground
        this.group.add(this.cloudMesh);
        
        this.binSort();
    }
    
    binSort() {
        const lookCameraNode = NodeMan.get("lookCamera", false);
        if (!lookCameraNode || !this.instanceOffsets || this.cloudCount < 2) return;
        
        const camPos = lookCameraNode.camera.position;
        const groupPos = this.group.position;
        const offsets = this.instanceOffsets;
        const sizes = this.instanceSizes;
        const n = this.cloudCount;
        
        const distances = new Float32Array(n);
        let minDist = Infinity, maxDist = -Infinity;
        
        for (let i = 0; i < n; i++) {
            const i3 = i * 3;
            const dx = groupPos.x + offsets[i3] - camPos.x;
            const dy = groupPos.y + offsets[i3 + 1] - camPos.y;
            const dz = groupPos.z + offsets[i3 + 2] - camPos.z;
            const d = dx * dx + dy * dy + dz * dz;
            distances[i] = d;
            if (d < minDist) minDist = d;
            if (d > maxDist) maxDist = d;
        }
        
        const NUM_BINS = n;
        const range = maxDist - minDist;
        if (range <= 0) return;
        
        const binCounts = new Uint32Array(NUM_BINS);
        const binIndices = new Uint32Array(n);
        
        for (let i = 0; i < n; i++) {
            const bin = Math.min(NUM_BINS - 1, Math.floor((distances[i] - minDist) / range * NUM_BINS));
            binIndices[i] = bin;
            binCounts[bin]++;
        }
        
        let maxBinCount = 0;
        for (let b = 0; b < NUM_BINS; b++) {
            if (binCounts[b] > maxBinCount) maxBinCount = binCounts[b];
        }
        
        const binStarts = new Uint32Array(NUM_BINS);
        let sum = 0;
        for (let b = NUM_BINS - 1; b >= 0; b--) {
            binStarts[b] = sum;
            sum += binCounts[b];
        }
        
        const binCurrent = binStarts.slice();
        
        const newOffsets = new Float32Array(n * 3);
        const newSizes = new Float32Array(n * 2);
        
        for (let i = 0; i < n; i++) {
            const bin = binIndices[i];
            const dest = binCurrent[bin]++;
            const i3 = i * 3;
            const d3 = dest * 3;
            newOffsets[d3] = offsets[i3];
            newOffsets[d3 + 1] = offsets[i3 + 1];
            newOffsets[d3 + 2] = offsets[i3 + 2];
            const i2 = i * 2;
            const d2 = dest * 2;
            newSizes[d2] = sizes[i2];
            newSizes[d2 + 1] = sizes[i2 + 1];
        }
        
        this.instanceOffsets.set(newOffsets);
        this.instanceSizes.set(newSizes);
        
        if (this.cloudGeometry) {
            this.cloudGeometry.getAttribute('instanceOffset').needsUpdate = true;
            this.cloudGeometry.getAttribute('instanceSize').needsUpdate = true;
        }
        
        this.combGap = maxBinCount;
    }
    
    getWindVector() {
        if (this.windMode === "No Wind") {
            return new Vector3(0, 0, 0);
        }
        
        let windFrom, windKnots;
        
        if (this.windMode === "Use Local") {
            const localWind = NodeMan.get("localWind", false);
            if (!localWind) return new Vector3(0, 0, 0);
            windFrom = localWind.from;
            windKnots = localWind.knots;
        } else if (this.windMode === "Use Target") {
            const targetWind = NodeMan.get("targetWind", false);
            if (!targetWind) return new Vector3(0, 0, 0);
            windFrom = targetWind.from;
            windKnots = targetWind.knots;
        } else {
            windFrom = this.windFrom;
            windKnots = this.windKnots;
        }
        
        const position = this.basePosition || this.group.position;
        let wind = getLocalNorthVector(position);
        wind.multiplyScalar(metersPerSecondFromKnots(windKnots));
        const posUp = getLocalUpVector(position);
        wind.applyAxisAngle(posUp, radians(180 - windFrom));
        
        return wind;
    }
    
    preRender(view) {
        if (!this.cloudMesh || !this.cloudMesh.material || !this.cloudMesh.material.uniforms) return;
        
        if (Globals.sunLight) {
            this.cloudMesh.material.uniforms.sunDirection.value.copy(Globals.sunLight.position).normalize();
        }
        
        if (this.basePosition) {
            if (this.windMode === "No Wind") {
                this.group.position.copy(this.basePosition);
            } else {
                const wind = this.getWindVector();
                const frame = par.frame || 0;
                const timeSeconds = frame / (Sit.fps || 30);
                const offset = wind.clone().multiplyScalar(timeSeconds);
                this.group.position.copy(this.basePosition).add(offset);
            }
        }
        
        for (let i = 0; i < 10; i++) {
            if (!this.combSortPass(view)) break;
        }
    }
    
    combSortPass(view) {
        if (!view || !view.camera || !this.instanceOffsets || this.cloudCount < 2) return false;
        if (view.id !== "lookView") return false;
        
        const camPos = view.camera.position;
        
        if (!this.lastSortCamPos) {
            this.lastSortCamPos = camPos.clone();
        } else {
            const dx = camPos.x - this.lastSortCamPos.x;
            const dy = camPos.y - this.lastSortCamPos.y;
            const dz = camPos.z - this.lastSortCamPos.z;
            const distMoved = dx * dx + dy * dy + dz * dz;
            if (distMoved > 10000) {
                this.binSort();
                this.lastSortCamPos.copy(camPos);
            }
        }
        const groupPos = this.group.position;
        const offsets = this.instanceOffsets;
        const sizes = this.instanceSizes;
        const offsetAttr = this.cloudGeometry.getAttribute('instanceOffset');
        const sizeAttr = this.cloudGeometry.getAttribute('instanceSize');
        
        let swapped = false;
        const gap = this.combGap;
        
        for (let i = 0; i + gap < this.cloudCount; i++) {
            const j = i + gap;
            const i3 = i * 3;
            const j3 = j * 3;
            
            const ax = groupPos.x + offsets[i3];
            const ay = groupPos.y + offsets[i3 + 1];
            const az = groupPos.z + offsets[i3 + 2];
            
            const bx = groupPos.x + offsets[j3];
            const by = groupPos.y + offsets[j3 + 1];
            const bz = groupPos.z + offsets[j3 + 2];
            
            const distA = (ax - camPos.x) ** 2 + (ay - camPos.y) ** 2 + (az - camPos.z) ** 2;
            const distB = (bx - camPos.x) ** 2 + (by - camPos.y) ** 2 + (bz - camPos.z) ** 2;
            
            if (distA < distB) {
                const i2 = i * 2;
                const j2 = j * 2;
                
                let tmp = offsets[i3]; offsets[i3] = offsets[j3]; offsets[j3] = tmp;
                tmp = offsets[i3 + 1]; offsets[i3 + 1] = offsets[j3 + 1]; offsets[j3 + 1] = tmp;
                tmp = offsets[i3 + 2]; offsets[i3 + 2] = offsets[j3 + 2]; offsets[j3 + 2] = tmp;
                
                tmp = sizes[i2]; sizes[i2] = sizes[j2]; sizes[j2] = tmp;
                tmp = sizes[i2 + 1]; sizes[i2 + 1] = sizes[j2 + 1]; sizes[j2 + 1] = tmp;
                
                swapped = true;
            }
        }
        
        this.combGap = Math.max(1, Math.floor(this.combGap / 1.3));
        
        if (swapped) {
            offsetAttr.needsUpdate = true;
            sizeAttr.needsUpdate = true;
        }
        return swapped || this.combGap > 1;
    }
    
    setupEventListeners() {
        this.onPointerDownBound = this.onPointerDown.bind(this);
        this.onPointerMoveBound = this.onPointerMove.bind(this);
        this.onPointerUpBound = this.onPointerUp.bind(this);
        
        document.addEventListener('pointerdown', this.onPointerDownBound);
        document.addEventListener('pointermove', this.onPointerMoveBound);
        document.addEventListener('pointerup', this.onPointerUpBound);
    }
    
    onPointerDown(event) {
        if (!this.editMode) return;
        if (event.button !== 0) return; // Only left mouse button
        
        // Check if clicking on a GUI element - menus should have priority
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) {
                return; // Click is on GUI, don't handle it
            }
            target = target.parentElement;
        }
        
        const view = ViewMan.get("mainView");
        if (!view) return;
        if (!mouseInViewOnly(view, event.clientX, event.clientY)) return;
        
        const handle = this.getHandleAtMouse(event.clientX, event.clientY);
        if (handle) {
            this.stateBeforeDrag = this.captureState();
            
            // Store initial values for relative dragging
            this.dragInitialAltitude = this.altitude;
            this.dragInitialRadius = this.radius;
            this.dragInitialLat = this.centerLat;
            this.dragInitialLon = this.centerLon;
            
            const centerEUS = LLAToEUS(this.centerLat, this.centerLon, this.altitude);
            this.dragLocalUp = getLocalUpVector(centerEUS);
            this.dragInitialCenterEUS = centerEUS.clone();
            
            // Calculate initial intersection point on the drag plane
            const mouseRay = screenToNDC(view, event.clientX, event.clientY);
            this.raycaster.setFromCamera(mouseRay, view.camera);
            
            const plane = new Plane();
            if (handle === 'altitude') {
                // Create vertical plane facing camera (allows height adjustment)
                const toCamera = view.camera.position.clone().sub(centerEUS).normalize();
                const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
                const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
                plane.setFromNormalAndCoplanarPoint(planeNormal, centerEUS);
            } else {
                plane.setFromNormalAndCoplanarPoint(this.dragLocalUp, centerEUS);
            }
            
            this.dragInitialIntersection = new Vector3();
            const intersected = this.raycaster.ray.intersectPlane(plane, this.dragInitialIntersection);
            if (!intersected) {
                return; // Can't establish drag plane intersection
            }
            
            this.isDragging = true;
            this.draggingHandle = handle;
            
            // Disable camera controls while dragging
            if (view.controls) {
                view.controls.enabled = false;
            }
            
            event.stopPropagation();
            event.preventDefault();
        }
    }
    
    onPointerMove(event) {
        if (!this.editMode) return;
        
        if (this.isDragging && this.draggingHandle) {
            const view = ViewMan.get("mainView");
            if (!view) return;

            const mouseRay = screenToNDC(view, event.clientX, event.clientY);
            this.raycaster.setFromCamera(mouseRay, view.camera);
            
            // Use INITIAL center position for plane - this is key for relative dragging
            const plane = new Plane();
            if (this.draggingHandle === 'altitude') {
                // Create vertical plane facing camera (allows height adjustment)
                const toCamera = view.camera.position.clone().sub(this.dragInitialCenterEUS).normalize();
                const tangent = new Vector3().crossVectors(this.dragLocalUp, toCamera).normalize();
                const planeNormal = new Vector3().crossVectors(tangent, this.dragLocalUp).normalize();
                plane.setFromNormalAndCoplanarPoint(planeNormal, this.dragInitialCenterEUS);
            } else {
                plane.setFromNormalAndCoplanarPoint(this.dragLocalUp, this.dragInitialCenterEUS);
            }
            
            const currentIntersection = new Vector3();
            if (this.raycaster.ray.intersectPlane(plane, currentIntersection)) {
                // Calculate displacement from initial click point
                const displacement = currentIntersection.clone().sub(this.dragInitialIntersection);
                
                if (this.draggingHandle === 'altitude') {
                    const heightDiff = displacement.dot(this.dragLocalUp);
                    const newAltitude = this.dragInitialAltitude + heightDiff;
                    
                    const limits = this.altitudeController?.getSILimits() ?? { min: 0, max: 20000 };
                    if (newAltitude >= limits.min && newAltitude <= limits.max) {
                        this.altitude = newAltitude;
                        this.updateGroupPosition();
                        this.createControlHandles();
                        this.updateGUIControllers();
                    }
                } else if (this.draggingHandle === 'radius') {
                    const newRadius = currentIntersection.distanceTo(this.dragInitialCenterEUS);
                    const limits = this.radiusController?.getSILimits() ?? { min: 100, max: 100000 };
                    if (newRadius >= limits.min && newRadius <= limits.max) {
                        this.radius = newRadius;
                        this.buildCloudMesh();
                        this.createControlHandles();
                        this.updateGUIControllers();
                    }
                } else if (this.draggingHandle === 'move') {
                    // Move center by displacement
                    const newCenterEUS = this.dragInitialCenterEUS.clone().add(displacement);
                    const lla = EUSToLLA(newCenterEUS);
                    this.centerLat = lla.x;
                    this.centerLon = lla.y;
                    this.updateGroupPosition();
                    this.createControlHandles();
                }
            }
            
            setRenderOne(true);
        } else {
            const handle = this.getHandleAtMouse(event.clientX, event.clientY);
            if (handle !== this.hoveredHandle) {
                this.hoveredHandle = handle;
                this.updateHandleColors();
                setRenderOne(true);
            }
        }
    }
    
    onPointerUp(event) {
        if (this.isDragging) {
            const wasMoveHandle = this.draggingHandle === 'move';
            const handleType = this.draggingHandle;
            
            if (wasMoveHandle) {
                this.buildCloudMesh();
            }
            
            // Create undo action if state changed
            if (this.stateBeforeDrag && UndoManager) {
                const stateAfterDrag = this.captureState();
                const stateBefore = this.stateBeforeDrag;
                const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfterDrag);
                
                if (stateChanged) {
                    const actionDescription = handleType === 'altitude' 
                        ? `Change cloud altitude "${this.name}"`
                        : handleType === 'radius'
                        ? `Change cloud radius "${this.name}"`
                        : `Move cloud layer "${this.name}"`;
                    
                    UndoManager.add({
                        undo: () => {
                            this.restoreState(stateBefore);
                        },
                        redo: () => {
                            this.restoreState(stateAfterDrag);
                        },
                        description: actionDescription
                    });
                }
            }
            
            this.stateBeforeDrag = null;
            this.isDragging = false;
            this.draggingHandle = null;
            
            // Re-enable camera controls
            const view = ViewMan.get("mainView");
            if (view && view.controls) {
                view.controls.enabled = true;
            }
            
            CustomManager.saveGlobalSettings();
        }
    }
    
    getHandleAtMouse(mouseX, mouseY) {
        const view = ViewMan.get("mainView");
        if (!view) return null;

        const mouseRay = screenToNDC(view, mouseX, mouseY);
        this.raycaster.setFromCamera(mouseRay, view.camera);
        
        const handles = [];
        if (this.altitudeHandle) handles.push({mesh: this.altitudeHandle, name: 'altitude'});
        if (this.radiusHandle) handles.push({mesh: this.radiusHandle, name: 'radius'});
        if (this.moveHandle) handles.push({mesh: this.moveHandle, name: 'move'});
        
        let closest = null;
        let closestDist = Infinity;
        
        for (const h of handles) {
            const intersects = this.raycaster.intersectObject(h.mesh, false);
            if (intersects.length > 0 && intersects[0].distance < closestDist) {
                closestDist = intersects[0].distance;
                closest = h.name;
            }
        }
        
        return closest;
    }
    
    updateHandleColors() {
        if (this.altitudeHandle) {
            const color = this.hoveredHandle === 'altitude' ? 0x00ff00 : 0xffff00;
            this.altitudeHandle.material.color.setHex(color);
        }
        if (this.radiusHandle) {
            const color = this.hoveredHandle === 'radius' ? 0x00ff00 : 0x00ffff;
            this.radiusHandle.material.color.setHex(color);
        }
        if (this.moveHandle) {
            const color = this.hoveredHandle === 'move' ? 0x00ff00 : 0xff8800;
            this.moveHandle.material.color.setHex(color);
        }
    }
    
    createControlHandles() {
        this.removeControlHandles();
        
        if (!this.editMode) return;
        
        const centerEUS = LLAToEUS(this.centerLat, this.centerLon, this.altitude);
        const localUp = getLocalUpVector(centerEUS);
        const east = new Vector3(1, 0, 0).cross(localUp).normalize();
        
        // Use fixed 3m radius geometry (same as buildings) - scaled dynamically in updateHandleScales
        const handleGeometry = new SphereGeometry(3, 16, 16);
        
        const altitudeMaterial = new MeshBasicMaterial({color: 0xffff00, depthTest: false, transparent: true, opacity: 0.8});
        this.altitudeHandle = new Mesh(handleGeometry.clone(), altitudeMaterial);
        this.altitudeHandle.position.set(0, 0, 0);
        this.altitudeHandle.layers.mask = LAYER.MASK_HELPERS;
        this.group.add(this.altitudeHandle);
        
        const radiusMaterial = new MeshBasicMaterial({color: 0x00ffff, depthTest: false, transparent: true, opacity: 0.8});
        this.radiusHandle = new Mesh(handleGeometry.clone(), radiusMaterial);
        this.radiusHandle.position.copy(east.clone().multiplyScalar(this.radius));
        this.radiusHandle.layers.mask = LAYER.MASK_HELPERS;
        this.group.add(this.radiusHandle);
        
        const moveMaterial = new MeshBasicMaterial({color: 0xff8800, depthTest: false, transparent: true, opacity: 0.8});
        this.moveHandle = new Mesh(handleGeometry.clone(), moveMaterial);
        this.moveHandle.position.copy(east.clone().multiplyScalar(-this.radius * 0.5));
        this.moveHandle.layers.mask = LAYER.MASK_HELPERS;
        this.group.add(this.moveHandle);
        
        handleGeometry.dispose(); // Dispose the template
    }
    
    /**
     * Update handle scales to maintain constant screen size (20px)
     * Should be called from the render loop
     * @param {CNodeView3D} view - The view to use for screen-space scaling
     */
    updateHandleScales(view) {
        if (!this.editMode || !view || !view.pixelsToMeters) {
            return;
        }
        
        const handlePixelSize = 20; // Target size in screen pixels
        const worldPos = new Vector3();
        
        const handles = [this.altitudeHandle, this.radiusHandle, this.moveHandle];
        handles.forEach(handle => {
            if (handle) {
                handle.getWorldPosition(worldPos);
                const scale = view.pixelsToMeters(worldPos, handlePixelSize);
                handle.scale.set(scale / 3, scale / 3, scale / 3);
            }
        });
    }
    
    removeControlHandles() {
        if (this.altitudeHandle) {
            this.group.remove(this.altitudeHandle);
            this.altitudeHandle.geometry.dispose();
            this.altitudeHandle.material.dispose();
            this.altitudeHandle = null;
        }
        if (this.radiusHandle) {
            this.group.remove(this.radiusHandle);
            this.radiusHandle.geometry.dispose();
            this.radiusHandle.material.dispose();
            this.radiusHandle = null;
        }
        if (this.moveHandle) {
            this.group.remove(this.moveHandle);
            this.moveHandle.geometry.dispose();
            this.moveHandle.material.dispose();
            this.moveHandle = null;
        }
    }
    
    setEditMode(enabled) {
        if (this.editMode === enabled) return;
        
        this.editMode = enabled;
        
        if (enabled) {
            Globals.editingClouds = this;
            this.createControlHandles();
            CustomManager.showCloudsEditingMenu(100, 100);
        } else {
            if (Globals.editingClouds === this) {
                Globals.editingClouds = null;
            }
            this.removeControlHandles();
            
            if (!window._menuBeingDestroyed && CustomManager.cloudsEditMenu) {
                CustomManager.cloudsEditMenu.destroy();
                CustomManager.cloudsEditMenu = null;
            }
        }
        
        if (this.editModeController) {
            this.editModeController.setValue(enabled);
        }
        
        setRenderOne(true);
    }
    
    createGUIFolder() {
        this.guiFolder = guiMenus.objects.addFolder(`Clouds: ${this.name}`);
        
        this.guiFolder.add(this, 'name').name('Name').onChange(() => {
            this.guiFolder.title = `Clouds: ${this.name}`;
        }).onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const editModeData = {editMode: this.editMode};
        this.editModeController = this.guiFolder.add(editModeData, 'editMode').name('Edit Mode').onChange((value) => {
            this.setEditMode(value);
        });
        
        const propsFolder = this.guiFolder.addFolder('Properties').close();
        
        const altitudeProxy = {
            _displayValue: this.altitude,
            get altitude() { return this._displayValue; },
            set altitude(v) { this._displayValue = v; }
        };
        this.altitudeProxy = altitudeProxy;
        this.altitudeController = propsFolder.add(altitudeProxy, 'altitude', 0, 20000, 10)
            .name('Altitude')
            .setUnitType('small')
            .onChange(() => {
                this.altitude = this.altitudeController.getSIValue();
                this.updateGroupPosition();
                if (this.editMode) this.createControlHandles();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const radiusProxy = {
            _displayValue: this.radius,
            get radius() { return this._displayValue; },
            set radius(v) { this._displayValue = v; }
        };
        this.radiusProxy = radiusProxy;
        this.radiusController = propsFolder.add(radiusProxy, 'radius', 100, 100000, 10)
            .name('Radius')
            .setUnitType('small')
            .onChange(() => {
                this.radius = this.radiusController.getSIValue();
                this.buildCloudMesh();
                if (this.editMode) this.createControlHandles();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const cloudSizeProxy = {
            _displayValue: this.cloudSize,
            get cloudSize() { return this._displayValue; },
            set cloudSize(v) { this._displayValue = v; }
        };
        this.cloudSizeProxy = cloudSizeProxy;
        this.cloudSizeController = propsFolder.add(cloudSizeProxy, 'cloudSize', 50, 1000, 10)
            .name('Cloud Size')
            .setUnitType('small')
            .onChange(() => {
                this.cloudSize = this.cloudSizeController.getSIValue();
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'density', 0.1, 2.0, 0.1)
            .name('Density')
            .onChange(() => {
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'opacity', 0.1, 1.0, 0.05)
            .name('Opacity')
            .onChange(() => {
                if (this.cloudMesh && this.cloudMesh.material && this.cloudMesh.material.uniforms) {
                    this.cloudMesh.material.uniforms.opacity.value = this.opacity;
                }
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'brightness', 0, 2, 0.05)
            .name('Brightness')
            .onChange(() => {
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const depthProxy = {
            _displayValue: this.depth,
            get depth() { return this._displayValue; },
            set depth(v) { this._displayValue = v; }
        };
        this.depthProxy = depthProxy;
        this.depthController = propsFolder.add(depthProxy, 'depth', 0, 2000, 10)
            .name('Depth')
            .setUnitType('small')
            .onChange(() => {
                this.depth = this.depthController.getSIValue();
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'edgeWiggle', 0, 0.5, 0.01)
            .name('Edge Wiggle')
            .onChange(() => {
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'edgeFrequency', 1, 20, 1)
            .name('Edge Frequency')
            .onChange(() => {
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        propsFolder.add(this, 'seed', 0, 9999, 1)
            .name('Seed')
            .onChange(() => {
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const featherProxy = {
            _displayValue: this.feather,
            get feather() { return this._displayValue; },
            set feather(v) { this._displayValue = v; }
        };
        this.featherProxy = featherProxy;
        this.featherController = propsFolder.add(featherProxy, 'feather', 0, 50000, 10)
            .name('Feather')
            .setUnitType('small')
            .onChange(() => {
                this.feather = this.featherController.getSIValue();
                this.buildCloudMesh();
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        
        const windFolder = this.guiFolder.addFolder('Wind').close();
        
        const windModes = ["No Wind", "Use Local", "Use Target", "Custom"];
        this.windModeController = windFolder.add(this, 'windMode', windModes)
            .name('Wind Mode')
            .onChange(() => {
                const isCustom = this.windMode === "Custom";
                if (this.windFromController) this.windFromController.show(isCustom);
                if (this.windKnotsController) this.windKnotsController.show(isCustom);
                setRenderOne(true);
                CustomManager.saveGlobalSettings(true);
            });
        
        this.windFromController = windFolder.add(this, 'windFrom', 0, 359, 1)
            .name('Wind From (°)')
            .onChange(() => {
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        this.windFromController.show(this.windMode === "Custom");
        
        this.windKnotsController = windFolder.add(this, 'windKnots', 0, 200, 1)
            .name('Wind (knots)')
            .onChange(() => {
                setRenderOne(true);
            })
            .onFinishChange(() => { CustomManager.saveGlobalSettings(true); });
        this.windKnotsController.show(this.windMode === "Custom");
        
        const actions = {
            delete: () => this.deleteClouds()
        };
        this.guiFolder.add(actions, 'delete').name('Delete Clouds');
    }
    
    updateGUIControllers() {
        if (this.altitudeController) {
            this.altitudeController.setSIValue(this.altitude);
        }
        if (this.radiusController) {
            this.radiusController.setSIValue(this.radius);
        }
        if (this.cloudSizeController) {
            this.cloudSizeController.setSIValue(this.cloudSize);
        }
        if (this.depthController) {
            this.depthController.setSIValue(this.depth);
        }
        if (this.featherController) {
            this.featherController.setSIValue(this.feather);
        }
    }
    
    captureState() {
        return {
            centerLat: this.centerLat,
            centerLon: this.centerLon,
            altitude: this.altitude,
            radius: this.radius,
        };
    }
    
    restoreState(state) {
        this.centerLat = state.centerLat;
        this.centerLon = state.centerLon;
        this.altitude = state.altitude;
        this.radius = state.radius;
        this.updateGroupPosition();
        this.buildCloudMesh();
        this.createControlHandles();
        this.updateGUIControllers();
        setRenderOne(true);
    }

    /**
     * Delete this cloud layer with confirmation and undo support
     */
    deleteClouds() {
        if (confirm(`Delete cloud layer "${this.name}"?`)) {
            if (UndoManager) {
                const cloudsState = this.serialize();
                const cloudsID = this.cloudsID;

                UndoManager.add({
                    undo: () => {
                        Synth3DManager.addClouds(cloudsState);
                    },
                    redo: () => {
                        Synth3DManager.removeClouds(cloudsID);
                    },
                    description: `Delete cloud layer "${this.name}"`
                });
            }

            Synth3DManager.removeClouds(this.cloudsID);
        }
    }

    serialize() {
        return {
            id: this.cloudsID,
            name: this.name,
            centerLat: this.centerLat,
            centerLon: this.centerLon,
            altitude: this.altitude,
            radius: this.radius,
            depth: this.depth,
            edgeWiggle: this.edgeWiggle,
            edgeFrequency: this.edgeFrequency,
            cloudSize: this.cloudSize,
            density: this.density,
            opacity: this.opacity,
            brightness: this.brightness,
            seed: this.seed,
            feather: this.feather,
            windMode: this.windMode,
            windFrom: this.windFrom,
            windKnots: this.windKnots
        };
    }
    
    static deserialize(data) {
        return new CNodeSynthClouds({
            id: data.id,
            name: data.name,
            centerLat: data.centerLat,
            centerLon: data.centerLon,
            altitude: data.altitude,
            radius: data.radius,
            depth: data.depth,
            edgeWiggle: data.edgeWiggle,
            edgeFrequency: data.edgeFrequency,
            cloudSize: data.cloudSize,
            density: data.density,
            opacity: data.opacity,
            brightness: data.brightness,
            seed: data.seed,
            feather: data.feather,
            windMode: data.windMode,
            windFrom: data.windFrom,
            windKnots: data.windKnots
        });
    }
    
    dispose() {
        document.removeEventListener('pointerdown', this.onPointerDownBound);
        document.removeEventListener('pointermove', this.onPointerMoveBound);
        document.removeEventListener('pointerup', this.onPointerUpBound);
        
        this.removeControlHandles();
        
        if (this.cloudMesh) {
            this.group.remove(this.cloudMesh);
            if (this.cloudGeometry) this.cloudGeometry.dispose();
            if (this.cloudMesh.material) this.cloudMesh.material.dispose();
            this.cloudMesh = null;
        }
        
        if (this.cloudTexture) {
            this.cloudTexture.dispose();
        }
        
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
        
        super.dispose();
    }
}
