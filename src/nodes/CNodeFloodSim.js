// CNodeFloodSim.js - Flood simulator using Position Based Fluids (PBF)
//
// Based on Macklin & Müller 2013 "Position Based Fluids".
// Particles satisfy a density constraint through iterative position correction,
// producing stable, incompressible fluid behavior on terrain.
//
// Air/Ground states:
//   AIR:    freefall under gravity, no slope forces
//   GROUND: slope acceleration + terrain clamping (PBF handles fluid pressure)

import {CNode3DGroup} from "./CNode3DGroup";
import {BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, InstancedMesh, LineBasicMaterial, LineLoop, Matrix4, Mesh, MeshBasicMaterial, MeshPhongMaterial, Raycaster, SphereGeometry} from "three";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {guiPhysics, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {EventManager} from "../CEventManager";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import * as LAYER from "../LayerMasks";
import {screenToNDC} from "../mouseMoveView";
import {ViewMan} from "../CViewManager";
import {mouseInViewOnly} from "../ViewUtils";
import {t} from "../i18n";

const GRAVITY = 9.81;
const DEFAULT_MAX_PARTICLES = 50000;

// ── PBF Kernel functions (precomputed coefficients set per-step) ─────────
// Poly6: used for density estimation (takes r², avoids sqrt)
// W(r,h) = 315/(64πh⁹) · (h²-r²)³  for r < h
// Spiky gradient: used for constraint gradient (nonzero at r=0)
// ∇W(r,h) = -45/(πh⁶) · (h-r)² · r̂

export class CNodeFloodSim extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_WORLD;
        super(v);

        this.input("track", true);

        // Scenario-provided GUI folder (Physics → Scenarios → Flood Sim).
        // When set, setupGUI fills it instead of making a standalone folder,
        // and dispose() must empty rather than destroy it (permanent shell).
        this._guiFolderProvided = v.guiFolder;

        // GUI-controlled parameters
        this.floodEnabled = false;
        this.floodRate = v.floodRate ?? 50;
        this.sphereSize = v.sphereSize ?? 1.0;
        this.dropRadius = v.dropRadius ?? 10;
        this.waterColor = v.waterColor ?? "#1a3a5c";
        this.maxParticles = v.maxParticles ?? DEFAULT_MAX_PARTICLES;
        this.method = v.method ?? "HeightMap"; // "HeightMap" (grid-based), "Fast" (ad-hoc pressure), or "PBF" (Position Based Fluids)
        this.waterSource = v.waterSource ?? "Rain"; // "Rain" or "DamBurst"
        this.floodSpeed = v.floodSpeed ?? 1; // sim steps per frame (1-20)
        this.manningN = v.manningN ?? 0.03; // Manning's roughness coefficient (0.03 = clean natural channel)
        this.edgeCondition = v.edgeCondition ?? "Draining"; // "Blocking" or "Draining"
        this.addSimpleSerials(["floodEnabled", "floodRate", "sphereSize", "dropRadius", "waterColor", "maxParticles", "method", "waterSource", "floodSpeed", "manningN", "edgeCondition",
            "hmEastMin", "hmEastMax", "hmNorthMin", "hmNorthMax"]);

        // Particle buffers
        this.count = 0;
        this.aliveCount = 0;
        this.freeStack = [];
        this.allocateBuffers(this.maxParticles);

        // Local coordinate origin
        this.originSet = false;
        this.originLat = 0;
        this.originLon = 0;
        this.originAlt = 0;
        this.originECEF = null;
        this.eastVec = null;
        this.northVec = null;
        this.upVec = null;
        this.metersPerDegLat = 111320;
        this.metersPerDegLon = 111320;

        // Elevation grid
        this.elevGridRes = 500;
        this.elevGridSpacing = 2;
        this.elevGridHalf = 500 * 2 / 2;
        this.elevGrid = null;
        this.gradX = null;
        this.gradY = null;
        this._sr = { elev: 0, gx: 0, gy: 0 };

        // Spatial hash buffers
        this._pCell = null;
        this._cellCount = null;
        this._cellStart = null;
        this._sortedIdx = null;

        // HeightMap water simulation — bounds-based grid
        this.hmSpacing = 10;                          // meters per cell
        this.hmEastMin = v.hmEastMin ?? -2500;        // grid bounds in local ENU (meters)
        this.hmEastMax = v.hmEastMax ?? 2500;
        this.hmNorthMin = v.hmNorthMin ?? -2500;
        this.hmNorthMax = v.hmNorthMax ?? 2500;
        this.hmResX = Math.round((this.hmEastMax - this.hmEastMin) / this.hmSpacing);
        this.hmResY = Math.round((this.hmNorthMax - this.hmNorthMin) / this.hmSpacing);
        this.hmGround = null;
        this.waterDepth = null;
        this.flowX = null;
        this.flowY = null;
        this.velX = null;       // cell-centered x velocity (for advection)
        this.velY = null;       // cell-centered y velocity (for advection)
        this._tmpVelX = null;   // advection scratch buffer
        this._tmpVelY = null;
        this.waterMesh = null;
        this._hmPositions = null;
        this._hmNormals = null;
        this._hmIndices = null;
        this._hmHasWater = false;
        // Boundary visuals and drag handles
        this.boundaryLine = null;
        this.cornerHandles = [];
        this.isDragging = false;
        this.draggingCorner = -1;
        this.raycaster = new Raycaster();

        this._mat4 = new Matrix4();

        // Tile reload
        this._rebuildTimer = null;
        EventManager.addEventListener("tileChanged", () => {
            if (!this.originSet) return;
            if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
            this._rebuildTimer = setTimeout(() => {
                this.buildElevationGrid();
                if (this.hmGround) this.rebuildHMGround();
                this._rebuildTimer = null;
            }, 500);
        });

        // Self-drive physics when paused (ignores pause state)
        this._lastUpdateTime = 0;
        this._renderInterval = setInterval(() => {
            if (!this.floodEnabled && this.aliveCount === 0 && !this._hmHasWater) return;
            // Only self-drive if the render loop hasn't called update recently
            const now = performance.now();
            if (now - this._lastUpdateTime > 50) {
                this.runFloodStep(par.frame);
                // Only request a render when a physics step actually ran. Calling
                // setRenderOne(true) unconditionally every 16ms forced a full
                // 60fps scene re-render (and its GC) even on the throttled ticks
                // where nothing changed — the dominant cost once the render loop
                // itself was fixed. A step runs ~20/s, so the water still animates.
                setRenderOne(true);
            }
        }, 16);

        this.setupMesh();
        this.setupGUI();
        this.setupDragListeners();
    }

    // ── Buffer allocation ────────────────────────────────────────────────

    allocateBuffers(n) {
        this.px = new Float32Array(n);
        this.py = new Float32Array(n);
        this.pz = new Float32Array(n);
        this.vx = new Float32Array(n);
        this.vy = new Float32Array(n);
        this.vz = new Float32Array(n);
        this.alive = new Uint8Array(n);
        this.onGround = new Uint8Array(n);
        // PBF predicted positions
        this.predX = new Float32Array(n);
        this.predY = new Float32Array(n);
        this.predZ = new Float32Array(n);
        // PBF per-particle values
        this.density = new Float32Array(n);
        this.lambda = new Float32Array(n);
        // Accumulator (reused for gradient sum, then delta position)
        this.accX = new Float32Array(n);
        this.accY = new Float32Array(n);
        this.accZ = new Float32Array(n);
        this.accW = new Float32Array(n); // scalar accumulator (sqGradSum)
    }

    resizeBuffers(newMax) {
        if (newMax === this.maxParticles) return;
        const copy = Math.min(this.count, newMax);
        const fields = ['px','py','pz','vx','vy','vz','predX','predY','predZ','density','lambda','accX','accY','accZ','accW'];
        const byteFields = ['alive','onGround'];
        const newBufs = {};
        for (const f of fields) {
            newBufs[f] = new Float32Array(newMax);
            newBufs[f].set(this[f].subarray(0, copy));
        }
        for (const f of byteFields) {
            newBufs[f] = new Uint8Array(newMax);
            newBufs[f].set(this[f].subarray(0, copy));
        }
        for (const f of [...fields, ...byteFields]) this[f] = newBufs[f];

        this.maxParticles = newMax;
        if (this.count > newMax) this.count = newMax;
        this.freeStack = this.freeStack.filter(i => i < newMax);

        if (this.instancedMesh) {
            this.group.remove(this.instancedMesh);
            this.instancedMesh.geometry.dispose();
            this.instancedMesh.material.dispose();
        }
        this.setupMesh();
    }

    // ── Rendering ────────────────────────────────────────────────────────

    setupMesh() {
        const geo = new SphereGeometry(0.5, 6, 4);
        const mat = new MeshPhongMaterial({
            color: new Color(this.waterColor),
            transparent: true,
            opacity: 0.8,
        });
        this.instancedMesh = new InstancedMesh(geo, mat, this.maxParticles);
        this.instancedMesh.instanceMatrix.setUsage(DynamicDrawUsage);
        this.instancedMesh.count = 0;
        this.instancedMesh.frustumCulled = false;
        this.group.add(this.instancedMesh);
    }

    // ── GUI ──────────────────────────────────────────────────────────────

    setupGUI() {
        this.guiFolder = this._guiFolderProvided
            ?? (guiPhysics ? guiPhysics.addFolder("Flood Sim").close() : null);
        if (!this.guiFolder) return;
        this.guiFolder.add(this, "floodEnabled").name(t("floodSim.flood.label")).tooltip(t("floodSim.flood.tooltip")).listen()
            .onChange(() => setRenderOne());
        this.guiFolder.add(this, "floodRate", 1, 500, 1).name(t("floodSim.floodRate.label")).tooltip(t("floodSim.floodRate.tooltip"));
        this.guiFolder.add(this, "sphereSize", 0.05, 100.0, 0.05).name(t("floodSim.sphereSize.label")).tooltip(t("floodSim.sphereSize.tooltip"));
        this.guiFolder.add(this, "dropRadius", 1, 10000, 1).name(t("floodSim.dropRadius.label")).tooltip(t("floodSim.dropRadius.tooltip"));
        this.guiFolder.add(this, "maxParticles", 1000, 200000, 1000).name(t("floodSim.maxParticles.label")).tooltip(t("floodSim.maxParticles.tooltip"))
            .onChange(v => this.resizeBuffers(v));
        this.guiFolder.add(this, "method", ["HeightMap", "Fast", "PBF"]).name(t("floodSim.method.label")).tooltip(t("floodSim.method.tooltip"))
            .onChange(() => this.updateMethodVisibility());
        this.guiFolder.add(this, "waterSource", ["Rain", "DamBurst"]).name(t("floodSim.waterSource.label")).tooltip(t("floodSim.waterSource.tooltip"));
        this.guiFolder.add(this, "floodSpeed", 1, 20, 1).name(t("floodSim.speed.label")).tooltip(t("floodSim.speed.tooltip"));
        this.guiFolder.add(this, "manningN", 0.01, 0.15, 0.005).name(t("floodSim.manningN.label")).tooltip(t("floodSim.manningN.tooltip"));
        this.guiFolder.add(this, "edgeCondition", ["Blocking", "Draining"]).name(t("floodSim.edge.label")).tooltip(t("floodSim.edge.tooltip"));
        this.guiFolder.addColor(this, "waterColor").name(t("floodSim.waterColor.label")).tooltip(t("floodSim.waterColor.tooltip"))
            .onChange(() => {
                this.instancedMesh.material.color.set(this.waterColor);
                if (this.waterMesh) this.waterMesh.material.color.set(this.waterColor);
                setRenderOne();
            });
        this.guiFolder.add(this, "resetFlood").name(t("floodSim.reset.label")).tooltip(t("floodSim.reset.tooltip"));
    }

    resetFlood() {
        this.count = 0;
        this.aliveCount = 0;
        this.alive.fill(0);
        this.onGround.fill(0);
        this.freeStack.length = 0;
        this.instancedMesh.count = 0;
        // HeightMap state
        if (this.waterDepth) this.waterDepth.fill(0);
        if (this.flowX) this.flowX.fill(0);
        if (this.flowY) this.flowY.fill(0);
        if (this.velX) this.velX.fill(0);
        if (this.velY) this.velY.fill(0);
        this._hmHasWater = false;
        if (this.waterMesh) this.waterMesh.geometry.setDrawRange(0, 0);
        this.removeBoundaryVisuals();
        this.originSet = false;
        this.elevGrid = null;
        setRenderOne();
    }

    // ── Target / spawn ───────────────────────────────────────────────────

    getTargetECEF(f) {
        if (this.in.track) return this.in.track.p(f);
        for (const name of ["fixedTargetPositionWind", "fixedTargetPosition", "targetTrack"]) {
            if (NodeMan.exists(name)) return NodeMan.get(name).p(f);
        }
        return LLAToECEF(Sit.lat, Sit.lon, 0);
    }

    // ── Origin ───────────────────────────────────────────────────────────

    setupOrigin(ecef) {
        this.originECEF = ecef.clone();
        const lla = ECEFToLLAVD_radii(ecef);
        this.originLat = lla.x;
        this.originLon = lla.y;
        this.originAlt = lla.z;
        this.eastVec  = getLocalEastVector(ecef).clone();
        this.northVec = getLocalNorthVector(ecef).clone();
        this.upVec    = getLocalUpVector(ecef).clone();
        this.metersPerDegLat = 111320;
        this.metersPerDegLon = 111320 * Math.cos(this.originLat * Math.PI / 180);
        this.group.position.copy(ecef);
        this._seaLevel = meanSeaLevelOffset(this.originLat, this.originLon);
        this.buildElevationGrid();
        this.originSet = true;
        this.initHeightMapGrids();
        this.updateMethodVisibility();
    }

    // ── Elevation grid (unchanged) ───────────────────────────────────────

    localToLL(e, n) {
        return [
            this.originLat + n / this.metersPerDegLat,
            this.originLon + e / this.metersPerDegLon,
        ];
    }

    getElevationDirect(e, n) {
        const [lat, lon] = this.localToLL(e, n);
        if (NodeMan.exists("TerrainModel")) {
            const terrain = NodeMan.get("TerrainModel");
            if (terrain.elevationMap) {
                const elev = terrain.elevationMap.getElevationInterpolated(lat, lon);
                if (isFinite(elev)) return elev;
            }
        }
        return this.originAlt;
    }

    buildElevationGrid() {
        const res = this.elevGridRes, sp = this.elevGridSpacing, half = res / 2;
        this.elevGrid = new Float32Array(res * res);
        this.gradX = new Float32Array(res * res);
        this.gradY = new Float32Array(res * res);
        for (let j = 0; j < res; j++) {
            const n = (j - half) * sp;
            for (let i = 0; i < res; i++) {
                this.elevGrid[j * res + i] = this.getElevationDirect((i - half) * sp, n);
            }
        }
        const inv2sp = 1 / (2 * sp);
        for (let j = 1; j < res - 1; j++) for (let i = 1; i < res - 1; i++) {
            const idx = j * res + i;
            this.gradX[idx] = (this.elevGrid[idx + 1] - this.elevGrid[idx - 1]) * inv2sp;
            this.gradY[idx] = (this.elevGrid[(j+1)*res+i] - this.elevGrid[(j-1)*res+i]) * inv2sp;
        }
        for (let i = 0; i < res; i++) { this.gradY[i] = this.gradY[res+i]; this.gradY[(res-1)*res+i] = this.gradY[(res-2)*res+i]; }
        for (let j = 0; j < res; j++) { this.gradX[j*res] = this.gradX[j*res+1]; this.gradX[j*res+res-1] = this.gradX[j*res+res-2]; }
    }

    sampleGrid(e, n) {
        const res = this.elevGridRes, sp = this.elevGridSpacing, half = res / 2, r = this._sr;
        const gx = e / sp + half, gy = n / sp + half;
        if (gx < 1 || gx > res - 2 || gy < 1 || gy > res - 2) {
            const h = 2;
            r.elev = this.getElevationDirect(e, n);
            r.gx = (this.getElevationDirect(e+h, n) - this.getElevationDirect(e-h, n)) / (2*h);
            r.gy = (this.getElevationDirect(e, n+h) - this.getElevationDirect(e, n-h)) / (2*h);
            return r;
        }
        const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy;
        const i00 = iy * res + ix, i10 = i00 + 1, i01 = i00 + res, i11 = i01 + 1;
        const w00 = (1-fx)*(1-fy), w10 = fx*(1-fy), w01 = (1-fx)*fy, w11 = fx*fy;
        const eg = this.elevGrid, gxA = this.gradX, gyA = this.gradY;
        r.elev = eg[i00]*w00 + eg[i10]*w10 + eg[i01]*w01 + eg[i11]*w11;
        r.gx = gxA[i00]*w00 + gxA[i10]*w10 + gxA[i01]*w01 + gxA[i11]*w11;
        r.gy = gyA[i00]*w00 + gyA[i10]*w10 + gyA[i01]*w01 + gyA[i11]*w11;
        return r;
    }

    // ── Particle allocation ──────────────────────────────────────────────

    allocParticle() {
        if (this.freeStack.length > 0) return this.freeStack.pop();
        if (this.count < this.maxParticles) return this.count++;
        return -1;
    }

    spawnParticle(spawnE, spawnN, spawnAlt) {
        const idx = this.allocParticle();
        if (idx < 0) return;
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * this.dropRadius;
        this.px[idx] = spawnE + Math.cos(angle) * dist;
        this.py[idx] = spawnN + Math.sin(angle) * dist;
        this.pz[idx] = spawnAlt;
        this.vx[idx] = 0; this.vy[idx] = 0; this.vz[idx] = 0;
        this.alive[idx] = 1;
        // Check if spawn altitude is near ground → start grounded
        const gndElev = this.sampleGrid(this.px[idx], this.py[idx]).elev;
        this.onGround[idx] = (spawnAlt <= gndElev + this.sphereSize * 2) ? 1 : 0;
        this.aliveCount++;
    }

    // ── Per-frame update ─────────────────────────────────────────────────

    update(f) {
        super.update(f);
        if (!this.floodEnabled && this.aliveCount === 0 && !this._hmHasWater) return;
        this.runFloodStep(f);
    }

    /** Core flood logic — called by update() or self-drive interval */
    runFloodStep(f) {
        const targetECEF = this.getTargetECEF(f);
        if (!this.originSet) {
            if (!this.floodEnabled) return;
            this.setupOrigin(targetECEF);
        }

        const dt = (Sit.simSpeed || 1) / (Sit.fps || 30);

        if (this.method === "HeightMap") {
            // Add water to grid cells within drop radius
            if (this.floodEnabled) {
                const diff = targetECEF.clone().sub(this.originECEF);
                const spawnE = diff.dot(this.eastVec);
                const spawnN = diff.dot(this.northVec);
                if (this.waterSource === "DamBurst") {
                    const targetAlt = this.originAlt + diff.dot(this.upVec);
                    this.heightMapDamBurst(spawnE, spawnN, targetAlt);
                } else {
                    this.heightMapAddWater(spawnE, spawnN, dt);
                }
            }
            if (this._hmHasWater || this.floodEnabled) {
                const steps = Math.max(1, Math.min(Math.round(this.floodSpeed), 20));
                for (let r = 0; r < steps; r++) this.heightMapStep(dt);
                this.updateWaterMesh();
            }
        } else {
            // Spawn new particles
            if (this.floodEnabled) {
                const diff = targetECEF.clone().sub(this.originECEF);
                const spawnE = diff.dot(this.eastVec);
                const spawnN = diff.dot(this.northVec);
                const groundElev = this.sampleGrid(spawnE, spawnN).elev;
                const spawnAlt = groundElev + this.sphereSize;
                const room = this.maxParticles - this.count + this.freeStack.length;
                const toSpawn = Math.min(this.floodRate, room);
                for (let i = 0; i < toSpawn; i++) this.spawnParticle(spawnE, spawnN, spawnAlt);
            }
            if (this.method === "PBF") {
                this.pbfStep(dt);
            } else {
                const substeps = 4;
                const subDt = dt / substeps;
                for (let s = 0; s < substeps; s++) {
                    this.fastPhysicsStep(subDt);
                    this.fastResolveCollisions();
                }
            }
            this.updateInstances();
        }

        this._lastUpdateTime = performance.now();
        setRenderOne();
    }

    // ── Fast Solver (ad-hoc pressure impulse) ───────────────────────────

    fastPhysicsStep(dt) {
        const _px = this.px, _py = this.py, _pz = this.pz;
        const _vx = this.vx, _vy = this.vy, _vz = this.vz;
        const _alive = this.alive, _ground = this.onGround;
        const n = this.count;
        const radius = this.sphereSize * 0.5;
        const airDrag = Math.pow(0.998, dt * 30);
        const groundFric = Math.pow(0.9995, dt * 30);
        const gdt = GRAVITY * dt;
        const seaKill = this._seaLevel + 2;

        for (let i = 0; i < n; i++) {
            if (!_alive[i]) continue;
            const { elev, gx, gy } = this.sampleGrid(_px[i], _py[i]);
            const groundLevel = elev + radius;

            if (_ground[i] && _pz[i] > groundLevel + 0.01) {
                _ground[i] = 0;
                if (_vz[i] <= 0) _vz[i] = 0;
            }

            if (_ground[i]) {
                const denom = 1 + gx * gx + gy * gy;
                _vx[i] = (_vx[i] + (-GRAVITY * gx / denom) * dt) * groundFric;
                _vy[i] = (_vy[i] + (-GRAVITY * gy / denom) * dt) * groundFric;
                _vz[i] = 0;
                _px[i] += _vx[i] * dt;
                _py[i] += _vy[i] * dt;
                const newElev = this.sampleGrid(_px[i], _py[i]).elev;
                _pz[i] = newElev + radius;
            } else {
                _vx[i] *= airDrag;
                _vy[i] *= airDrag;
                _vz[i] -= gdt;
                _px[i] += _vx[i] * dt;
                _py[i] += _vy[i] * dt;
                _pz[i] += _vz[i] * dt;
                if (_pz[i] <= groundLevel) {
                    _pz[i] = groundLevel;
                    _vz[i] = 0;
                    _ground[i] = 1;
                }
            }

            if (elev <= seaKill) {
                _alive[i] = 0;
                this.aliveCount--;
                this.freeStack.push(i);
            }
        }
    }

    fastResolveCollisions() {
        const px = this.px, py = this.py, pz = this.pz;
        const vx = this.vx, vy = this.vy, vz = this.vz;
        const alive = this.alive;
        const n = this.count;
        const diam = this.sphereSize;
        const diamSq = diam * diam;
        const cs = diam;
        const invCS = 1 / cs;
        const pressK = 2.0;
        const viscosity = 0.02;
        const maxSpeed = 50;
        const maxSpeedSq = maxSpeed * maxSpeed;

        let aliveN = 0;
        let minCX = 1e9, maxCX = -1e9, minCY = 1e9, maxCY = -1e9;
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            aliveN++;
            const cx = Math.floor(px[i] * invCS);
            const cy = Math.floor(py[i] * invCS);
            if (cx < minCX) minCX = cx;
            if (cx > maxCX) maxCX = cx;
            if (cy < minCY) minCY = cy;
            if (cy > maxCY) maxCY = cy;
        }
        if (aliveN < 2) return;

        const gridW = maxCX - minCX + 3;
        const gridSize = gridW * (maxCY - minCY + 3);
        if (gridSize > 500000) return;

        if (!this._pCell || this._pCell.length < n) this._pCell = new Uint32Array(Math.max(n, 1024));
        if (!this._cellCount || this._cellCount.length < gridSize) this._cellCount = new Uint32Array(Math.max(gridSize, 1024));
        if (!this._cellStart || this._cellStart.length < gridSize + 1) this._cellStart = new Uint32Array(Math.max(gridSize + 1, 1025));
        if (!this._sortedIdx || this._sortedIdx.length < aliveN) this._sortedIdx = new Uint32Array(Math.max(aliveN * 2, 1024));

        const pCell = this._pCell, cellCount = this._cellCount;
        const cellStart = this._cellStart, sortedIdx = this._sortedIdx;
        cellCount.fill(0, 0, gridSize);
        const offCX = -minCX + 1, offCY = -minCY + 1;

        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            const ci = (Math.floor(py[i] * invCS) + offCY) * gridW + (Math.floor(px[i] * invCS) + offCX);
            pCell[i] = ci;
            cellCount[ci]++;
        }
        cellStart[0] = 0;
        for (let c = 0; c < gridSize; c++) cellStart[c + 1] = cellStart[c] + cellCount[c];
        for (let c = 0; c < gridSize; c++) cellCount[c] = cellStart[c];
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            sortedIdx[cellCount[pCell[i]]++] = i;
        }
        for (let c = 0; c < gridSize; c++) cellCount[c] = cellStart[c + 1] - cellStart[c];

        const nbr0 = 1, nbr1 = gridW - 1, nbr2 = gridW, nbr3 = gridW + 1;

        for (let c = 0; c < gridSize; c++) {
            const cnt = cellCount[c];
            if (cnt === 0) continue;
            const cS = cellStart[c], cE = cS + cnt;

            // Within-cell pairs
            for (let a = cS; a < cE; a++) {
                const i = sortedIdx[a];
                for (let b = a + 1; b < cE; b++) {
                    const j = sortedIdx[b];
                    const ddx = px[j] - px[i], ddy = py[j] - py[i], ddz = pz[j] - pz[i];
                    const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
                    if (dSq >= diamSq || dSq < 1e-10) continue;
                    const d = Math.sqrt(dSq), inv = 1 / d;
                    const overlap = diam - d;
                    const nx = ddx * inv, ny = ddy * inv, nz = ddz * inv;
                    const pp = overlap * 0.5;
                    px[i] -= nx * pp; py[i] -= ny * pp; pz[i] -= nz * pp;
                    px[j] += nx * pp; py[j] += ny * pp; pz[j] += nz * pp;
                    const pv = overlap * pressK;
                    vx[i] -= nx * pv; vy[i] -= ny * pv; vz[i] -= nz * pv;
                    vx[j] += nx * pv; vy[j] += ny * pv; vz[j] += nz * pv;
                    const dvx = (vx[j] - vx[i]) * viscosity, dvy = (vy[j] - vy[i]) * viscosity, dvz = (vz[j] - vz[i]) * viscosity;
                    vx[i] += dvx; vy[i] += dvy; vz[i] += dvz;
                    vx[j] -= dvx; vy[j] -= dvy; vz[j] -= dvz;
                }
            }

            // 4 forward-neighbor cells
            const neighbors = [c + nbr0, c + nbr1, c + nbr2, c + nbr3];
            for (let ni = 0; ni < 4; ni++) {
                const nc = neighbors[ni];
                if (nc >= gridSize || cellCount[nc] === 0) continue;
                const ns = cellStart[nc], ne = ns + cellCount[nc];
                for (let a = cS; a < cE; a++) {
                    const i = sortedIdx[a];
                    for (let b = ns; b < ne; b++) {
                        const j = sortedIdx[b];
                        const ddx = px[j] - px[i], ddy = py[j] - py[i], ddz = pz[j] - pz[i];
                        const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (dSq >= diamSq || dSq < 1e-10) continue;
                        const d = Math.sqrt(dSq), inv = 1 / d;
                        const overlap = diam - d;
                        const nx = ddx * inv, ny = ddy * inv, nz = ddz * inv;
                        const pp = overlap * 0.5;
                        px[i] -= nx * pp; py[i] -= ny * pp; pz[i] -= nz * pp;
                        px[j] += nx * pp; py[j] += ny * pp; pz[j] += nz * pp;
                        const pv = overlap * pressK;
                        vx[i] -= nx * pv; vy[i] -= ny * pv; vz[i] -= nz * pv;
                        vx[j] += nx * pv; vy[j] += ny * pv; vz[j] += nz * pv;
                        const dvx = (vx[j] - vx[i]) * viscosity, dvy = (vy[j] - vy[i]) * viscosity, dvz = (vz[j] - vz[i]) * viscosity;
                        vx[i] += dvx; vy[i] += dvy; vz[i] += dvz;
                        vx[j] -= dvx; vy[j] -= dvy; vz[j] -= dvz;
                    }
                }
            }
        }

        // Clamp velocities
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            const sSq = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
            if (sSq > maxSpeedSq) {
                const s = maxSpeed / Math.sqrt(sSq);
                vx[i] *= s; vy[i] *= s; vz[i] *= s;
            }
        }
    }

    // ── PBF Solver ───────────────────────────────────────────────────────

    pbfStep(dt) {
        const px = this.px, py = this.py, pz = this.pz;
        const vx = this.vx, vy = this.vy, vz = this.vz;
        const predX = this.predX, predY = this.predY, predZ = this.predZ;
        const _density = this.density, _lambda = this.lambda;
        const accX = this.accX, accY = this.accY, accZ = this.accZ, accW = this.accW;
        const alive = this.alive, _ground = this.onGround;
        const n = this.count;
        const radius = this.sphereSize * 0.5;
        const seaKill = this._seaLevel + 2;

        // PBF parameters
        const diam = this.sphereSize;        // sphere diameter
        const h = diam * 2.0;               // smoothing radius = 2× particle diameter
        const hSq = h * h;
        const h3 = h * h * h;
        const h6 = h3 * h3;
        const h9 = h6 * h3;
        const poly6K = 315.0 / (64.0 * Math.PI * h9);
        const spikyK = -45.0 / (Math.PI * h6);
        const poly6_0 = poly6K * hSq * hSq * hSq; // W(0, h) — self density
        const epsilon = 400;                 // constraint regularization
        const solverIter = 2;                // PBF solver iterations
        // Viscosity applied as simple velocity damping (avoids extra neighbor traversal)
        const viscDamp = Math.pow(0.99, dt * 30);

        // Compute rest density from expected packing
        // Self + ~7 neighbors at distance sphereSize
        const spacingSq = this.sphereSize * this.sphereSize;
        const wAtSpacing = poly6K * (hSq - spacingSq) * (hSq - spacingSq) * (hSq - spacingSq);
        const restDensity = poly6_0 + 4 * wAtSpacing; // triggers for hexagonal monolayer (~6 neighbors exceeds this)
        const invRestDensity = 1 / restDensity;

        // ── Step 1: Apply external forces ──
        const gdt = GRAVITY * dt;
        const groundFric = Math.pow(0.9995, dt * 30);
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;

            if (_ground[i]) {
                // Slope-driven acceleration for grounded particles
                const { gx, gy } = this.sampleGrid(px[i], py[i]);
                const denom = 1 + gx * gx + gy * gy;
                vx[i] += (-GRAVITY * gx / denom) * dt;
                vy[i] += (-GRAVITY * gy / denom) * dt;
                vx[i] *= groundFric;
                vy[i] *= groundFric;
            } else {
                // Freefall for airborne
                vz[i] -= gdt;
            }
        }

        // ── Step 2: Predict positions ──
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            predX[i] = px[i] + vx[i] * dt;
            predY[i] = py[i] + vy[i] * dt;
            predZ[i] = pz[i] + vz[i] * dt;
        }

        // ── Step 3: Build spatial hash on predicted positions ──
        const cs = h; // cell size = smoothing radius
        const invCS = 1 / cs;

        let aliveN = 0;
        let minCX = 1e9, maxCX = -1e9, minCY = 1e9, maxCY = -1e9;
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            aliveN++;
            const cx = Math.floor(predX[i] * invCS);
            const cy = Math.floor(predY[i] * invCS);
            if (cx < minCX) minCX = cx;
            if (cx > maxCX) maxCX = cx;
            if (cy < minCY) minCY = cy;
            if (cy > maxCY) maxCY = cy;
        }
        if (aliveN < 2) return;

        const gridW = maxCX - minCX + 3;
        const gridSize = gridW * (maxCY - minCY + 3);
        if (gridSize > 1000000) return;

        // Grow hash buffers
        if (!this._pCell || this._pCell.length < n) this._pCell = new Uint32Array(Math.max(n, 1024));
        if (!this._cellCount || this._cellCount.length < gridSize) this._cellCount = new Uint32Array(Math.max(gridSize, 1024));
        if (!this._cellStart || this._cellStart.length < gridSize + 1) this._cellStart = new Uint32Array(Math.max(gridSize + 1, 1025));
        if (!this._sortedIdx || this._sortedIdx.length < aliveN) this._sortedIdx = new Uint32Array(Math.max(aliveN * 2, 1024));

        const pCell = this._pCell, cellCount = this._cellCount;
        const cellStart = this._cellStart, sortedIdx = this._sortedIdx;

        cellCount.fill(0, 0, gridSize);
        const offCX = -minCX + 1, offCY = -minCY + 1;

        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            const ci = (Math.floor(predY[i] * invCS) + offCY) * gridW + (Math.floor(predX[i] * invCS) + offCX);
            pCell[i] = ci;
            cellCount[ci]++;
        }
        cellStart[0] = 0;
        for (let c = 0; c < gridSize; c++) cellStart[c + 1] = cellStart[c] + cellCount[c];
        for (let c = 0; c < gridSize; c++) cellCount[c] = cellStart[c];
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            sortedIdx[cellCount[pCell[i]]++] = i;
        }
        for (let c = 0; c < gridSize; c++) cellCount[c] = cellStart[c + 1] - cellStart[c];

        const nbr0 = 1, nbr1 = gridW - 1, nbr2 = gridW, nbr3 = gridW + 1;

        // ── Step 4: Solver iterations ──
        for (let iter = 0; iter < solverIter; iter++) {

            // ── Pass A: Compute density + lambda ──
            // Initialize density with self-contribution
            for (let i = 0; i < n; i++) {
                _density[i] = alive[i] ? poly6_0 : 0;
                accX[i] = 0; accY[i] = 0; accZ[i] = 0; accW[i] = 0;
            }

            // Iterate all neighbor pairs
            for (let c = 0; c < gridSize; c++) {
                const cnt = cellCount[c];
                if (cnt === 0) continue;
                const cS = cellStart[c], cE = cS + cnt;

                // Within cell
                for (let a = cS; a < cE; a++) {
                    const i = sortedIdx[a];
                    for (let b = a + 1; b < cE; b++) {
                        const j = sortedIdx[b];
                        const dx = predX[j] - predX[i], dy = predY[j] - predY[i], dz = predZ[j] - predZ[i];
                        const rSq = dx*dx + dy*dy + dz*dz;
                        if (rSq >= hSq) continue;
                        // Poly6 density
                        const diff = hSq - rSq;
                        const w = poly6K * diff * diff * diff;
                        _density[i] += w;
                        _density[j] += w;
                        // Spiky gradient for lambda denominator
                        const r = Math.sqrt(rSq);
                        if (r < 1e-6) {
                            // Coincident particles: push apart in random direction
                            const push = diam * 0.5;
                            const a2 = Math.random() * Math.PI * 2;
                            accX[i] -= Math.cos(a2) * push; accY[i] -= Math.sin(a2) * push;
                            accX[j] += Math.cos(a2) * push; accY[j] += Math.sin(a2) * push;
                            continue;
                        }
                        const grad = spikyK * (h - r) * (h - r) / r; // gradient coefficient
                        const gx = grad * dx, gy = grad * dy, gz = grad * dz;
                        // Accumulate ∇_i C_i (= -Σ ∇W) and Σ|∇W|²
                        accX[i] += gx; accY[i] += gy; accZ[i] += gz;
                        accX[j] -= gx; accY[j] -= gy; accZ[j] -= gz;
                        const g2 = gx*gx + gy*gy + gz*gz;
                        accW[i] += g2;
                        accW[j] += g2;
                    }
                }

                // Neighbor cells
                const nbrOffsets = [c + nbr0, c + nbr1, c + nbr2, c + nbr3];
                for (let ni = 0; ni < 4; ni++) {
                    const nc = nbrOffsets[ni];
                    if (nc >= gridSize || cellCount[nc] === 0) continue;
                    const nS = cellStart[nc], nE = nS + cellCount[nc];
                    for (let a = cS; a < cE; a++) {
                        const i = sortedIdx[a];
                        for (let b = nS; b < nE; b++) {
                            const j = sortedIdx[b];
                            const dx = predX[j] - predX[i], dy = predY[j] - predY[i], dz = predZ[j] - predZ[i];
                            const rSq = dx*dx + dy*dy + dz*dz;
                            if (rSq >= hSq) continue;
                            const diff = hSq - rSq;
                            const w = poly6K * diff * diff * diff;
                            _density[i] += w;
                            _density[j] += w;
                            const r = Math.sqrt(rSq);
                            if (r < 1e-6) {
                            // Coincident particles: push apart in random direction
                            const push = diam * 0.5;
                            const a2 = Math.random() * Math.PI * 2;
                            accX[i] -= Math.cos(a2) * push; accY[i] -= Math.sin(a2) * push;
                            accX[j] += Math.cos(a2) * push; accY[j] += Math.sin(a2) * push;
                            continue;
                        }
                            const grad = spikyK * (h - r) * (h - r) / r;
                            const gx = grad * dx, gy = grad * dy, gz = grad * dz;
                            accX[i] += gx; accY[i] += gy; accZ[i] += gz;
                            accX[j] -= gx; accY[j] -= gy; accZ[j] -= gz;
                            const g2 = gx*gx + gy*gy + gz*gz;
                            accW[i] += g2;
                            accW[j] += g2;
                        }
                    }
                }
            }

            // Compute lambda for each particle
            const invRho0Sq = invRestDensity * invRestDensity;
            for (let i = 0; i < n; i++) {
                if (!alive[i]) continue;
                const C = _density[i] * invRestDensity - 1;
                // Denominator: Σ|∇_k C_i|² = (1/ρ₀²)(Σ|∇W_ij|² + |Σ∇W_ij|²)
                const selfGrad2 = accX[i]*accX[i] + accY[i]*accY[i] + accZ[i]*accZ[i];
                const denom = invRho0Sq * (accW[i] + selfGrad2) + epsilon;
                _lambda[i] = Math.min(-C / denom, 0); // one-sided: repulsion only (no attraction at free surface)
            }

            // ── Pass B: Compute + apply position correction ──
            // Reuse accX/Y/Z as delta position accumulators
            for (let i = 0; i < n; i++) { accX[i] = 0; accY[i] = 0; accZ[i] = 0; }

            for (let c = 0; c < gridSize; c++) {
                const cnt = cellCount[c];
                if (cnt === 0) continue;
                const cS = cellStart[c], cE = cS + cnt;

                // Within cell
                for (let a = cS; a < cE; a++) {
                    const i = sortedIdx[a];
                    for (let b = a + 1; b < cE; b++) {
                        const j = sortedIdx[b];
                        const dx = predX[j] - predX[i], dy = predY[j] - predY[i], dz = predZ[j] - predZ[i];
                        const rSq = dx*dx + dy*dy + dz*dz;
                        if (rSq >= hSq) continue;
                        const r = Math.sqrt(rSq);
                        if (r < 1e-6) {
                            // Coincident particles: push apart in random direction
                            const push = diam * 0.5;
                            const a2 = Math.random() * Math.PI * 2;
                            accX[i] -= Math.cos(a2) * push; accY[i] -= Math.sin(a2) * push;
                            accX[j] += Math.cos(a2) * push; accY[j] += Math.sin(a2) * push;
                            continue;
                        }
                        const nx = dx / r, ny = dy / r, nz = dz / r;
                        // PBF density constraint correction
                        const grad = spikyK * (h - r) * (h - r) / r;
                        const factor = (_lambda[i] + _lambda[j]) * invRestDensity;
                        const cx = grad * dx * factor, cy = grad * dy * factor, cz = grad * dz * factor;
                        accX[i] += cx; accY[i] += cy; accZ[i] += cz;
                        accX[j] -= cx; accY[j] -= cy; accZ[j] -= cz;
                        // Hard-sphere overlap prevention (catches sparse pairs PBF misses)
                        if (r < diam) {
                            const push = (diam - r) * 0.5;
                            accX[i] -= nx * push; accY[i] -= ny * push; accZ[i] -= nz * push;
                            accX[j] += nx * push; accY[j] += ny * push; accZ[j] += nz * push;
                        }
                    }
                }

                // Neighbor cells
                const nbrOffsets = [c + nbr0, c + nbr1, c + nbr2, c + nbr3];
                for (let ni = 0; ni < 4; ni++) {
                    const nc = nbrOffsets[ni];
                    if (nc >= gridSize || cellCount[nc] === 0) continue;
                    const nS = cellStart[nc], nE = nS + cellCount[nc];
                    for (let a = cS; a < cE; a++) {
                        const i = sortedIdx[a];
                        for (let b = nS; b < nE; b++) {
                            const j = sortedIdx[b];
                            const dx = predX[j] - predX[i], dy = predY[j] - predY[i], dz = predZ[j] - predZ[i];
                            const rSq = dx*dx + dy*dy + dz*dz;
                            if (rSq >= hSq) continue;
                            const r = Math.sqrt(rSq);
                            if (r < 1e-6) {
                            // Coincident particles: push apart in random direction
                            const push = diam * 0.5;
                            const a2 = Math.random() * Math.PI * 2;
                            accX[i] -= Math.cos(a2) * push; accY[i] -= Math.sin(a2) * push;
                            accX[j] += Math.cos(a2) * push; accY[j] += Math.sin(a2) * push;
                            continue;
                        }
                            const grad = spikyK * (h - r) * (h - r) / r;
                            const factor = (_lambda[i] + _lambda[j]) * invRestDensity;
                            const cx = grad * dx * factor, cy = grad * dy * factor, cz = grad * dz * factor;
                            accX[i] += cx; accY[i] += cy; accZ[i] += cz;
                            accX[j] -= cx; accY[j] -= cy; accZ[j] -= cz;
                        }
                    }
                }
            }

            // Apply position corrections + terrain clamp
            for (let i = 0; i < n; i++) {
                if (!alive[i]) continue;
                predX[i] += accX[i];
                predY[i] += accY[i];
                // Grounded particles: only horizontal PBF correction (no upward launch)
                // Airborne particles: full 3D correction
                if (!_ground[i]) {
                    predZ[i] += accZ[i];
                }
                // Clamp to terrain
                const elev = this.sampleGrid(predX[i], predY[i]).elev;
                if (predZ[i] < elev + radius) {
                    predZ[i] = elev + radius;
                }
            }
        } // end solver iterations

        // ── Step 5: Update velocity from position change ──
        const invDt = 1 / dt;
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            vx[i] = (predX[i] - px[i]) * invDt;
            vy[i] = (predY[i] - py[i]) * invDt;
            vz[i] = (predZ[i] - pz[i]) * invDt;
        }

        // ── Step 5.5: Post-PBF slope boost for grounded particles ──
        // Applied AFTER PBF so it can't be undone by constraint corrections.
        // This drives downhill flow — PBF handles spacing, slope drives momentum.
        const slopeBoost = 3.0;
        for (let i = 0; i < n; i++) {
            if (!alive[i] || !_ground[i]) continue;
            const { gx: sgx, gy: sgy } = this.sampleGrid(predX[i], predY[i]);
            const sd = 1 + sgx * sgx + sgy * sgy;
            vx[i] += (-GRAVITY * sgx / sd) * dt * slopeBoost;
            vy[i] += (-GRAVITY * sgy / sd) * dt * slopeBoost;
        }

        // ── Step 6: Apply viscosity damping (simple O(n), no neighbor traversal) ──
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            vx[i] *= viscDamp;
            vy[i] *= viscDamp;
            vz[i] *= viscDamp;
        }

        // ── Step 7: Finalize positions + ground state + kill ──
        for (let i = 0; i < n; i++) {
            if (!alive[i]) continue;
            px[i] = predX[i];
            py[i] = predY[i];
            pz[i] = predZ[i];

            const elev = this.sampleGrid(px[i], py[i]).elev;
            _ground[i] = (pz[i] <= elev + radius + 0.05) ? 1 : 0;

            if (elev <= seaKill) {
                alive[i] = 0;
                this.aliveCount--;
                this.freeStack.push(i);
            }
        }
    }

    // ── HeightMap Methods ─────────────────────────────────────────────────

    initHeightMapGrids() {
        this.hmResX = Math.round((this.hmEastMax - this.hmEastMin) / this.hmSpacing);
        this.hmResY = Math.round((this.hmNorthMax - this.hmNorthMin) / this.hmSpacing);
        const resX = this.hmResX, resY = this.hmResY;
        const cellCount = resX * resY;
        this.hmGround = new Float32Array(cellCount);
        this.waterDepth = new Float32Array(cellCount);
        this.flowX = new Float32Array((resX + 1) * resY);
        this.flowY = new Float32Array(resX * (resY + 1));
        this.velX = new Float32Array(cellCount);
        this.velY = new Float32Array(cellCount);
        this._tmpVelX = new Float32Array(cellCount);
        this._tmpVelY = new Float32Array(cellCount);
        this._hmHasWater = false;
        this.rebuildHMGround();
        this.setupWaterMesh();
        this.createBoundaryVisuals();
    }

    rebuildHMGround() {
        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const eMin = this.hmEastMin, nMin = this.hmNorthMin;
        for (let j = 0; j < resY; j++) {
            const n = nMin + j * sp;
            for (let i = 0; i < resX; i++) {
                this.hmGround[j * resX + i] = this.sampleGrid(eMin + i * sp, n).elev;
            }
        }
    }

    heightMapAddWater(spawnE, spawnN, dt) {
        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const eMin = this.hmEastMin, nMin = this.hmNorthMin;
        const radius = this.dropRadius, radiusSq = radius * radius;
        const gi = (spawnE - eMin) / sp, gj = (spawnN - nMin) / sp;
        const cellRadius = Math.ceil(radius / sp);
        const iMin = Math.max(0, Math.floor(gi - cellRadius));
        const iMax = Math.min(resX - 1, Math.ceil(gi + cellRadius));
        const jMin = Math.max(0, Math.floor(gj - cellRadius));
        const jMax = Math.min(resY - 1, Math.ceil(gj + cellRadius));

        let cellCount = 0;
        for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
            const dx = (i - gi) * sp, dy = (j - gj) * sp;
            if (dx * dx + dy * dy <= radiusSq) cellCount++;
        }
        if (cellCount === 0) return;

        const waterPerCell = this.floodRate * 0.0002 * dt;
        for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
            const dx = (i - gi) * sp, dy = (j - gj) * sp;
            if (dx * dx + dy * dy <= radiusSq) this.waterDepth[j * resX + i] += waterPerCell;
        }
        this._hmHasWater = true;
    }

    heightMapDamBurst(spawnE, spawnN, targetAlt) {
        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const eMin = this.hmEastMin, nMin = this.hmNorthMin;
        const radius = this.dropRadius, radiusSq = radius * radius;
        const gi = (spawnE - eMin) / sp, gj = (spawnN - nMin) / sp;
        const cellRadius = Math.ceil(radius / sp);
        const iMin = Math.max(0, Math.floor(gi - cellRadius));
        const iMax = Math.min(resX - 1, Math.ceil(gi + cellRadius));
        const jMin = Math.max(0, Math.floor(gj - cellRadius));
        const jMax = Math.min(resY - 1, Math.ceil(gj + cellRadius));
        const g = this.hmGround, w = this.waterDepth;

        for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
            const dx = (i - gi) * sp, dy = (j - gj) * sp;
            if (dx * dx + dy * dy > radiusSq) continue;
            const ci = j * resX + i;
            const depth = targetAlt - g[ci];
            if (depth > 0) w[ci] = depth;
        }
        this._hmHasWater = true;
    }

    /** Bilinear sample from a cell-centered array */
    _bilinear(arr, fi, fj, resX, resY) {
        fi = Math.max(0, Math.min(fi, resX - 1.001));
        fj = Math.max(0, Math.min(fj, resY - 1.001));
        const i0 = fi | 0, j0 = fj | 0;
        const i1 = Math.min(i0 + 1, resX - 1), j1 = Math.min(j0 + 1, resY - 1);
        const fx = fi - i0, fy = fj - j0;
        return arr[j0*resX+i0]*(1-fx)*(1-fy) + arr[j0*resX+i1]*fx*(1-fy)
             + arr[j1*resX+i0]*(1-fx)*fy     + arr[j1*resX+i1]*fx*fy;
    }

    /** Semi-Lagrangian self-advection of the velocity field.
     *
     * Handles the nonlinear advection terms in the SWE momentum equation:
     *   u·du/dx + v·du/dy  (x-momentum advection)
     *   u·dv/dx + v·dv/dy  (y-momentum advection)
     *
     * Without this step, the solver would only have pressure-driven flow
     * (no inertia). With it, water carries momentum past obstacles, forms
     * jets, and exhibits realistic dam-break velocity profiles.
     *
     * Method: for each cell, trace backward through the velocity field by
     * -v·dt, then bilinearly interpolate the velocity at the departure point.
     * This is the Stam "Stable Fluids" approach — unconditionally stable
     * but introduces numerical diffusion that smooths sharp features.
     *
     * Edge flows store discharge F = h·u (m²/s), so we convert to velocity
     * u = F/h for advection, then convert back to discharge F = h·u afterward.
     */
    advectFlows(dt) {
        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const fx = this.flowX, fy = this.flowY;
        const w = this.waterDepth;
        const fxW = resX + 1, fyW = resX;
        const vx = this.velX, vy = this.velY;
        const tvx = this._tmpVelX, tvy = this._tmpVelY;
        const minH = 0.01;

        // Compute cell-centered velocities: u = discharge / depth
        // Clamp to physical maximum (Ritter dam-break: 2√(gh))
        let maxDepth = 0;
        for (let k = 0, len = w.length; k < len; k++) if (w[k] > maxDepth) maxDepth = w[k];
        const maxPhysVel = maxDepth > 0.1 ? 2 * Math.sqrt(GRAVITY * maxDepth) : 10;

        for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
            const ci = j * resX + i;
            const h = w[ci];
            if (h > minH) {
                let ux = (fx[j*fxW+i] + fx[j*fxW+(i+1)]) * 0.5 / h;
                let uy = (fy[j*fyW+i] + fy[(j+1)*fyW+i]) * 0.5 / h;
                const spd = Math.sqrt(ux * ux + uy * uy);
                if (spd > maxPhysVel) { const s = maxPhysVel / spd; ux *= s; uy *= s; }
                vx[ci] = ux; vy[ci] = uy;
            } else {
                vx[ci] = 0; vy[ci] = 0;
            }
        }

        // Numerical diffusion: smooth velocity to damp oscillations
        const visc = 0.05;
        for (let j = 1; j < resY - 1; j++) for (let i = 1; i < resX - 1; i++) {
            const ci = j * resX + i;
            tvx[ci] = vx[ci] + visc * (vx[ci-1]+vx[ci+1]+vx[ci-resX]+vx[ci+resX] - 4*vx[ci]);
            tvy[ci] = vy[ci] + visc * (vy[ci-1]+vy[ci+1]+vy[ci-resX]+vy[ci+resX] - 4*vy[ci]);
        }
        // Copy smoothed interior back (boundaries stay as-is)
        for (let j = 1; j < resY - 1; j++) for (let i = 1; i < resX - 1; i++) {
            const ci = j * resX + i;
            vx[ci] = tvx[ci]; vy[ci] = tvy[ci];
        }

        // Semi-Lagrangian self-advection: trace backward, sample at source
        const invSp = 1 / sp;
        for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
            const ci = j * resX + i;
            const srcI = i - vx[ci] * dt * invSp;
            const srcJ = j - vy[ci] * dt * invSp;
            tvx[ci] = this._bilinear(vx, srcI, srcJ, resX, resY);
            tvy[ci] = this._bilinear(vy, srcI, srcJ, resX, resY);
        }

        // Write advected velocities back to edge discharges: F = h_edge · u_edge
        // Blend between original flow and advected flow to prevent advection
        // from overpowering the pressure gradient (which corrects uphill flow).
        // Full replacement (blend=1) can push water uphill; partial blend lets
        // the pressure step remain dominant while advection adds inertia.
        const advBlend = 0.5;
        const oneMinusBlend = 1 - advBlend;
        for (let j = 0; j < resY; j++) for (let i = 1; i < resX; i++) {
            const edge = j * fxW + i;
            const hEdge = (w[j*resX+(i-1)] + w[j*resX+i]) * 0.5;
            const advF = hEdge * (tvx[j*resX+(i-1)] + tvx[j*resX+i]) * 0.5;
            fx[edge] = fx[edge] * oneMinusBlend + advF * advBlend;
        }
        for (let j = 1; j < resY; j++) for (let i = 0; i < resX; i++) {
            const edge = j * fyW + i;
            const hEdge = (w[(j-1)*resX+i] + w[j*resX+i]) * 0.5;
            const advF = hEdge * (tvy[(j-1)*resX+i] + tvy[j*resX+i]) * 0.5;
            fy[edge] = fy[edge] * oneMinusBlend + advF * advBlend;
        }
    }

    // ── Shallow Water Equation Solver ──────────────────────────────────
    //
    // Solves the 2D shallow water equations (SWE) using operator splitting:
    //
    //   Continuity:  dh/dt + d(hu)/dx + d(hv)/dy = 0
    //   X-momentum:  d(hu)/dt + d(hu²+gh²/2)/dx + d(huv)/dy = -gh·dB/dx - friction
    //   Y-momentum:  d(hv)/dt + d(huv)/dx + d(hv²+gh²/2)/dy = -gh·dB/dy - friction
    //
    // Split into three operators per timestep:
    //   1. Advection: semi-Lagrangian self-advection of velocity field
    //      Handles the nonlinear terms u·du/dx, v·du/dy (momentum transport/inertia)
    //   2. Pressure: virtual pipes model — accelerates edge flows by water surface
    //      gradient, equivalent to -g·d(h+B)/dx (hydrostatic pressure + gravity)
    //   3. Friction: Manning's equation — bed shear stress τ = ρg·n²·|V|·V / h^(1/3)
    //      Applied implicitly: F /= (1 + g·n²·|u|·dt / h^(4/3)) for stability
    //
    // The pressure step uses CFL-limited substeps for numerical stability:
    //   dt ≤ dx / (|u_max| + √(g·h_max)) × 0.5
    // This accounts for BOTH flow velocity and gravity wave celerity c=√(gh).
    //
    // Outflow scaling prevents negative water depths (positivity preservation):
    // if total outflow from a cell exceeds available water, all outgoing flows
    // are scaled proportionally. This conserves mass exactly.

    heightMapStep(dt) {
        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const g = this.hmGround, w = this.waterDepth;
        const fx = this.flowX, fy = this.flowY;
        if (!g || !w) return;

        // ── Step 1: Semi-Lagrangian velocity advection (operator-split) ──
        // Transports the velocity field by itself, giving water inertia.
        // Without this, the solver only has pressure-driven flow (no jets, wakes,
        // or momentum carrying past obstacles). Uses cell-centered velocities
        // reconstructed from staggered edge flows.
        this.advectFlows(dt);

        const gravity = GRAVITY;
        const manningN = this.manningN;
        const fxW = resX + 1, fyW = resX;

        // ── CFL condition: dt ≤ dx / (|u_max| + √(g·h_max)) × safety ──
        // Must account for both flow velocity and wave celerity.
        // Wave celerity c = √(g·h) is the speed of gravity waves in shallow water.
        // The dam-break front advances at up to 2·√(g·h₀) (Ritter's solution).
        let maxD = 0, maxV = 0;
        for (let k = 0, len = w.length; k < len; k++) if (w[k] > maxD) maxD = w[k];
        // Use cell-centered velocities (computed in advectFlows) for max velocity
        const _vx = this.velX, _vy = this.velY;
        if (_vx) for (let k = 0, len = _vx.length; k < len; k++) { const v = Math.abs(_vx[k]); if (v > maxV) maxV = v; }
        if (_vy) for (let k = 0, len = _vy.length; k < len; k++) { const v = Math.abs(_vy[k]); if (v > maxV) maxV = v; }
        const maxSpeed = maxV + (maxD > 0.01 ? Math.sqrt(gravity * maxD) : 0);
        const maxSubDt = maxSpeed > 0.01 ? (sp / maxSpeed) * 0.25 : dt;
        const substeps = Math.max(1, Math.min(Math.ceil(dt / maxSubDt), 50));
        const subDt = dt / substeps;

        for (let s = 0; s < substeps; s++) {
            // ── Step 2: Pressure gradient (depth-weighted virtual pipes) ──
            // dF/dt = g · h_edge · (surface_left − surface_right) / dx
            // The full SWE momentum equation: d(hu)/dt = -g·h·d(h+B)/dx
            // The h_edge factor is critical: it makes wave speed √(g·h) instead
            // of the incorrect √(g). Deep water pushes proportionally harder,
            // giving correct dam-break front speeds of ~2·√(g·h₀).
            // Edge flows F store discharge (h·u) in m²/s on a staggered grid.
            for (let j = 0; j < resY; j++) for (let i = 1; i < resX; i++) {
                const left = j * resX + (i - 1), right = j * resX + i;
                const hEdge = (w[left] + w[right]) * 0.5;
                fx[j * fxW + i] += subDt * gravity * hEdge * (g[left] + w[left] - g[right] - w[right]) / sp;
            }
            for (let j = 1; j < resY; j++) for (let i = 0; i < resX; i++) {
                const below = (j - 1) * resX + i, above = j * resX + i;
                const hEdge = (w[below] + w[above]) * 0.5;
                fy[j * fyW + i] += subDt * gravity * hEdge * (g[below] + w[below] - g[above] - w[above]) / sp;
            }

            // ── Step 2b: Clamp discharge to physical limits ──
            // Discharge F = h·u cannot exceed h · maxPhysicalVelocity.
            // This prevents numerical overshoot from creating unphysical spikes.
            {
                let mxD = 0;
                for (let k = 0, len = w.length; k < len; k++) if (w[k] > mxD) mxD = w[k];
                const maxVel = mxD > 0.1 ? 2 * Math.sqrt(gravity * mxD) : 10;
                for (let j = 0; j < resY; j++) for (let i = 1; i < resX; i++) {
                    const hE = (w[j*resX+(i-1)] + w[j*resX+i]) * 0.5;
                    const maxF = hE * maxVel;
                    const edge = j * fxW + i;
                    if (fx[edge] > maxF) fx[edge] = maxF;
                    else if (fx[edge] < -maxF) fx[edge] = -maxF;
                }
                for (let j = 1; j < resY; j++) for (let i = 0; i < resX; i++) {
                    const hE = (w[(j-1)*resX+i] + w[j*resX+i]) * 0.5;
                    const maxF = hE * maxVel;
                    const edge = j * fyW + i;
                    if (fy[edge] > maxF) fy[edge] = maxF;
                    else if (fy[edge] < -maxF) fy[edge] = -maxF;
                }
            }

            // ── Step 3: Outflow scaling (positivity preservation) ──
            // Prevents cells from going negative by scaling outgoing flows
            // so total outflow ≤ available water volume. Conserves mass exactly.
            for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
                const idx = j * resX + i;
                if (w[idx] <= 0) {
                    if (fx[j * fxW + i] < 0) fx[j * fxW + i] = 0;
                    if (fx[j * fxW + (i + 1)] > 0) fx[j * fxW + (i + 1)] = 0;
                    if (fy[j * fyW + i] < 0) fy[j * fyW + i] = 0;
                    if (fy[(j + 1) * fyW + i] > 0) fy[(j + 1) * fyW + i] = 0;
                    continue;
                }
                let totalOut = 0;
                if (fx[j * fxW + (i + 1)] > 0) totalOut += fx[j * fxW + (i + 1)];
                if (fx[j * fxW + i] < 0) totalOut -= fx[j * fxW + i];
                if (fy[(j + 1) * fyW + i] > 0) totalOut += fy[(j + 1) * fyW + i];
                if (fy[j * fyW + i] < 0) totalOut -= fy[j * fyW + i];
                totalOut *= subDt;
                const vol = w[idx] * sp;
                if (totalOut > vol && totalOut > 0) {
                    const scale = vol / totalOut;
                    if (fx[j * fxW + (i + 1)] > 0) fx[j * fxW + (i + 1)] *= scale;
                    if (fx[j * fxW + i] < 0) fx[j * fxW + i] *= scale;
                    if (fy[(j + 1) * fyW + i] > 0) fy[(j + 1) * fyW + i] *= scale;
                    if (fy[j * fyW + i] < 0) fy[j * fyW + i] *= scale;
                }
            }

            // ── Step 4: Continuity — update depths from flow divergence ──
            // dh/dt = -(dF_x/dx + dF_y/dy)  (mass conservation)
            for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
                const idx = j * resX + i;
                const netFlow = fx[j * fxW + i] - fx[j * fxW + (i + 1)]
                              + fy[j * fyW + i] - fy[(j + 1) * fyW + i];
                w[idx] += subDt * netFlow / sp;
                if (w[idx] < 0) w[idx] = 0;
            }

            // ── Step 5: Manning friction (implicit) ──
            // Bed shear stress: τ = ρ·g·n²·|u|·u / h^(1/3)
            // Deceleration:     du/dt = -g·n²·|u|·u / h^(4/3)
            // Implicit:         F_new = F / (1 + g·n²·|F|·dt / h^(4/3))
            // This replaces artificial damping with physically-based friction.
            // Manning's n values: 0.01=smooth, 0.03=natural channel, 0.05=rough,
            // 0.1=dense vegetation. Implicit treatment prevents overshoot when
            // h is small (friction → ∞ as h → 0, correctly stopping thin films).
            if (manningN > 0) {
                const n2 = manningN * manningN;
                for (let j = 0; j < resY; j++) for (let i = 1; i < resX; i++) {
                    const edge = j * fxW + i;
                    const hAvg = (w[j * resX + (i - 1)] + w[j * resX + i]) * 0.5;
                    if (hAvg > 0.01) {
                        const fric = gravity * n2 * Math.abs(fx[edge]) / Math.pow(hAvg, 4 / 3);
                        fx[edge] /= (1 + fric * subDt);
                    }
                }
                for (let j = 1; j < resY; j++) for (let i = 0; i < resX; i++) {
                    const edge = j * fyW + i;
                    const hAvg = (w[(j - 1) * resX + i] + w[j * resX + i]) * 0.5;
                    if (hAvg > 0.01) {
                        const fric = gravity * n2 * Math.abs(fy[edge]) / Math.pow(hAvg, 4 / 3);
                        fy[edge] /= (1 + fric * subDt);
                    }
                }
            }

            // ── Step 6: Boundary conditions ──
            if (this.edgeCondition === "Draining") {
                // Outflow: allow water to leave the domain freely.
                // Boundary flows are driven by interior water surface slope,
                // and the depth update subtracts the outgoing flux normally,
                // effectively removing water that exits the grid.
                for (let j = 0; j < resY; j++) {
                    // Left edge: allow outflow (negative fx), block inflow
                    if (fx[j * fxW] > 0) fx[j * fxW] = 0;
                    // Right edge: allow outflow (positive fx), block inflow
                    if (fx[j * fxW + resX] < 0) fx[j * fxW + resX] = 0;
                }
                for (let i = 0; i < resX; i++) {
                    if (fy[i] > 0) fy[i] = 0;
                    if (fy[resY * fyW + i] < 0) fy[resY * fyW + i] = 0;
                }
            } else {
                // Blocking (reflective): zero all boundary flows
                for (let j = 0; j < resY; j++) { fx[j * fxW] = 0; fx[j * fxW + resX] = 0; }
                for (let i = 0; i < resX; i++) { fy[i] = 0; fy[resY * fyW + i] = 0; }
            }
        }

        let hasWater = false;
        for (let k = 0, len = w.length; k < len; k++) {
            if (w[k] > 0.001) { hasWater = true; break; }
        }
        this._hmHasWater = hasWater;
    }

    setupWaterMesh() {
        if (this.waterMesh) {
            this.group.remove(this.waterMesh);
            this.waterMesh.geometry.dispose();
            this.waterMesh.material.dispose();
        }
        const resX = this.hmResX, resY = this.hmResY;
        const numVerts = resX * resY;
        const maxIndices = (resX - 1) * (resY - 1) * 6;

        this._hmPositions = new Float32Array(numVerts * 3);
        this._hmNormals = new Float32Array(numVerts * 3);
        this._hmIndices = new Uint32Array(maxIndices);

        const geo = new BufferGeometry();
        const posAttr = new BufferAttribute(this._hmPositions, 3);
        posAttr.setUsage(DynamicDrawUsage);
        geo.setAttribute('position', posAttr);
        const nrmAttr = new BufferAttribute(this._hmNormals, 3);
        nrmAttr.setUsage(DynamicDrawUsage);
        geo.setAttribute('normal', nrmAttr);
        const idxAttr = new BufferAttribute(this._hmIndices, 1);
        idxAttr.setUsage(DynamicDrawUsage);
        geo.setIndex(idxAttr);
        geo.setDrawRange(0, 0);

        const mat = new MeshPhongMaterial({
            color: new Color(this.waterColor),
            transparent: true, opacity: 0.85, side: DoubleSide,
            shininess: 150, specular: new Color(0x888888),
        });
        this.waterMesh = new Mesh(geo, mat);
        this.waterMesh.frustumCulled = false;
        this.waterMesh.visible = (this.method === "HeightMap");
        this.group.add(this.waterMesh);
    }

    updateWaterMesh() {
        if (!this.waterMesh || !this.waterDepth || !this.hmGround) return;

        const resX = this.hmResX, resY = this.hmResY, sp = this.hmSpacing;
        const eMin = this.hmEastMin, nMin = this.hmNorthMin;
        const g = this.hmGround, w = this.waterDepth;
        const pos = this._hmPositions, nrm = this._hmNormals, idx = this._hmIndices;
        const originAlt = this.originAlt;
        const ex = this.eastVec.x, ey = this.eastVec.y, ez = this.eastVec.z;
        const nx = this.northVec.x, ny = this.northVec.y, nz = this.northVec.z;
        const ux = this.upVec.x, uy = this.upVec.y, uz = this.upVec.z;
        const threshold = 0.01;

        for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
            const ci = j * resX + i, vi = ci * 3;
            const e = eMin + i * sp, n = nMin + j * sp;
            const u = (g[ci] + w[ci]) - originAlt;
            pos[vi] = e*ex + n*nx + u*ux;
            pos[vi+1] = e*ey + n*ny + u*uy;
            pos[vi+2] = e*ez + n*nz + u*uz;
        }

        // Normals with turbulent perturbation for realistic water surface
        const t = performance.now() * 0.001;
        const turb = 0.2; // turbulence strength
        for (let j = 0; j < resY; j++) for (let i = 0; i < resX; i++) {
            const ci = j * resX + i, vi = ci * 3;
            if (w[ci] < threshold) { nrm[vi] = ux; nrm[vi+1] = uy; nrm[vi+2] = uz; continue; }
            const hL = g[i > 0 ? ci-1 : ci] + w[i > 0 ? ci-1 : ci];
            const hR = g[i < resX-1 ? ci+1 : ci] + w[i < resX-1 ? ci+1 : ci];
            const hD = g[j > 0 ? ci-resX : ci] + w[j > 0 ? ci-resX : ci];
            const hU = g[j < resY-1 ? ci+resX : ci] + w[j < resY-1 ? ci+resX : ci];
            // Base normal from height differences
            let lnE = -(hR-hL), lnN = -(hU-hD), lnU = 2*sp;
            // Turbulent perturbation — multi-frequency sine waves
            const e = eMin + i * sp, n = nMin + j * sp;
            lnE += (Math.sin(e*0.3 + t*2.7) * Math.cos(n*0.5 + t*1.3)
                  + Math.sin(e*0.8 + n*0.4 + t*4.1) * 0.5) * turb;
            lnN += (Math.cos(e*0.4 + t*1.9) * Math.sin(n*0.6 + t*2.3)
                  + Math.cos(e*0.3 + n*0.9 + t*3.7) * 0.5) * turb;
            const len = Math.sqrt(lnE*lnE + lnN*lnN + lnU*lnU);
            const inv = 1/len;
            const ne = lnE*inv, nn = lnN*inv, nu = lnU*inv;
            nrm[vi]   = ne*ex + nn*nx + nu*ux;
            nrm[vi+1] = ne*ey + nn*ny + nu*uy;
            nrm[vi+2] = ne*ez + nn*nz + nu*uz;
        }

        let idxCount = 0;
        for (let j = 0; j < resY-1; j++) for (let i = 0; i < resX-1; i++) {
            const tl = j*resX+i, tr = tl+1, bl = tl+resX, br = bl+1;
            if (w[tl] > threshold || w[tr] > threshold || w[bl] > threshold || w[br] > threshold) {
                idx[idxCount++] = tl; idx[idxCount++] = tr; idx[idxCount++] = bl;
                idx[idxCount++] = tr; idx[idxCount++] = br; idx[idxCount++] = bl;
            }
        }

        const geo = this.waterMesh.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.normal.needsUpdate = true;
        geo.index.needsUpdate = true;
        geo.setDrawRange(0, idxCount);
    }

    updateMethodVisibility() {
        if (this.instancedMesh) this.instancedMesh.visible = (this.method !== "HeightMap");
        if (this.waterMesh) this.waterMesh.visible = (this.method === "HeightMap");
        if (this.boundaryLine) this.boundaryLine.visible = (this.method === "HeightMap");
        for (const h of this.cornerHandles) h.visible = (this.method === "HeightMap");
        setRenderOne();
    }

    // ── Boundary visuals & drag handles ──────────────────────────────────

    enuToECEFOffset(e, n, u) {
        return {
            x: e*this.eastVec.x + n*this.northVec.x + u*this.upVec.x,
            y: e*this.eastVec.y + n*this.northVec.y + u*this.upVec.y,
            z: e*this.eastVec.z + n*this.northVec.z + u*this.upVec.z,
        };
    }

    createBoundaryVisuals() {
        this.removeBoundaryVisuals();
        if (!this.originSet) return;

        const lineGeo = new BufferGeometry();
        lineGeo.setAttribute('position', new BufferAttribute(new Float32Array(4 * 3), 3));
        this.boundaryLine = new LineLoop(lineGeo, new LineBasicMaterial({color: 0xffff00}));
        this.boundaryLine.frustumCulled = false;
        this.group.add(this.boundaryLine);

        const handleGeo = new SphereGeometry(1, 8, 8);
        const handleMat = new MeshBasicMaterial({color: 0xffff00, transparent: true, opacity: 0.8});
        this.cornerHandles = [];
        for (let c = 0; c < 4; c++) {
            const handle = new Mesh(handleGeo, handleMat);
            handle.frustumCulled = false;
            this.cornerHandles.push(handle);
            this.group.add(handle);
        }
        this.updateBoundaryVisuals();
    }

    updateBoundaryVisuals() {
        if (!this.boundaryLine || !this.originSet) return;
        const corners = [
            [this.hmEastMin, this.hmNorthMin],
            [this.hmEastMax, this.hmNorthMin],
            [this.hmEastMax, this.hmNorthMax],
            [this.hmEastMin, this.hmNorthMax],
        ];
        const posArr = this.boundaryLine.geometry.attributes.position.array;
        for (let c = 0; c < 4; c++) {
            const [e, n] = corners[c];
            const elev = this.sampleGrid(e, n).elev;
            const u = elev - this.originAlt + 5;
            const p = this.enuToECEFOffset(e, n, u);
            posArr[c*3] = p.x; posArr[c*3+1] = p.y; posArr[c*3+2] = p.z;
            if (this.cornerHandles[c]) {
                this.cornerHandles[c].position.set(p.x, p.y, p.z);
                this.cornerHandles[c].scale.setScalar(30);
            }
        }
        this.boundaryLine.geometry.attributes.position.needsUpdate = true;
    }

    removeBoundaryVisuals() {
        if (this.boundaryLine) {
            this.group.remove(this.boundaryLine);
            this.boundaryLine.geometry.dispose();
            this.boundaryLine.material.dispose();
            this.boundaryLine = null;
        }
        for (const h of this.cornerHandles) {
            this.group.remove(h);
        }
        this.cornerHandles = [];
    }

    setupDragListeners() {
        this._onPointerDown = this.onPointerDown.bind(this);
        this._onPointerMove = this.onPointerMove.bind(this);
        this._onPointerUp = this.onPointerUp.bind(this);
        document.addEventListener('pointerdown', this._onPointerDown);
        document.addEventListener('pointermove', this._onPointerMove);
        document.addEventListener('pointerup', this._onPointerUp);
    }

    removeDragListeners() {
        if (this._onPointerDown) {
            document.removeEventListener('pointerdown', this._onPointerDown);
            document.removeEventListener('pointermove', this._onPointerMove);
            document.removeEventListener('pointerup', this._onPointerUp);
        }
    }

    getHandleAtMouse(mouseX, mouseY) {
        const view = ViewMan.get("mainView");
        if (!view) return -1;
        const mouseRay = screenToNDC(view, mouseX, mouseY);
        this.raycaster.setFromCamera(mouseRay, view.camera);
        let closest = -1, closestDist = Infinity;
        for (let c = 0; c < this.cornerHandles.length; c++) {
            const intersects = this.raycaster.intersectObject(this.cornerHandles[c], false);
            if (intersects.length > 0 && intersects[0].distance < closestDist) {
                closestDist = intersects[0].distance;
                closest = c;
            }
        }
        return closest;
    }

    onPointerDown(event) {
        if (event.button !== 0 || !this.originSet || this.cornerHandles.length === 0) return;
        if (this.method !== "HeightMap") return;
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) return;
            target = target.parentElement;
        }
        const view = ViewMan.get("mainView");
        if (!view || !mouseInViewOnly(view, event.clientX, event.clientY)) return;
        const cornerIdx = this.getHandleAtMouse(event.clientX, event.clientY);
        if (cornerIdx >= 0) {
            this.isDragging = true;
            this.draggingCorner = cornerIdx;
            if (view.controls) view.controls.enabled = false;
            event.stopPropagation();
            event.preventDefault();
        }
    }

    onPointerMove(event) {
        if (!this.isDragging || this.draggingCorner < 0) return;
        const view = ViewMan.get("mainView");
        if (!view) return;
        const mouseRay = screenToNDC(view, event.clientX, event.clientY);
        this.raycaster.setFromCamera(mouseRay, view.camera);
        if (!NodeMan.exists("TerrainModel")) return;
        const terrainNode = NodeMan.get("TerrainModel");
        const savedMask = this.raycaster.layers.mask;
        this.raycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        const intersect = terrainNode.getClosestIntersect(this.raycaster);
        this.raycaster.layers.mask = savedMask;
        if (!intersect) return;

        const diff = intersect.point.clone().sub(this.originECEF);
        const e = diff.dot(this.eastVec), n = diff.dot(this.northVec);
        const sp = this.hmSpacing;
        const snappedE = Math.round(e / sp) * sp;
        const snappedN = Math.round(n / sp) * sp;

        // Corner order: 0=SW, 1=SE, 2=NE, 3=NW
        const c = this.draggingCorner;
        let eMin = this.hmEastMin, eMax = this.hmEastMax;
        let nMin = this.hmNorthMin, nMax = this.hmNorthMax;
        if (c === 0 || c === 3) eMin = Math.min(snappedE, eMax - sp);
        if (c === 1 || c === 2) eMax = Math.max(snappedE, eMin + sp);
        if (c === 0 || c === 1) nMin = Math.min(snappedN, nMax - sp);
        if (c === 2 || c === 3) nMax = Math.max(snappedN, nMin + sp);

        this.resizeGrid(eMin, eMax, nMin, nMax);
        this.updateBoundaryVisuals();
        setRenderOne();
        event.stopPropagation();
        event.preventDefault();
    }

    onPointerUp() {
        if (this.isDragging) {
            const view = ViewMan.get("mainView");
            if (view && view.controls) view.controls.enabled = true;
            this.isDragging = false;
            this.draggingCorner = -1;
        }
    }

    resizeGrid(newEMin, newEMax, newNMin, newNMax) {
        const sp = this.hmSpacing;
        const newResX = Math.round((newEMax - newEMin) / sp);
        const newResY = Math.round((newNMax - newNMin) / sp);
        if (newResX < 2 || newResY < 2 || newResX > 2000 || newResY > 2000) return;
        if (newResX === this.hmResX && newResY === this.hmResY &&
            newEMin === this.hmEastMin && newNMin === this.hmNorthMin) return;

        const oldResX = this.hmResX, oldEMin = this.hmEastMin, oldNMin = this.hmNorthMin;
        const oldWater = this.waterDepth;

        const newWater = new Float32Array(newResX * newResY);
        if (oldWater) {
            for (let j = 0; j < newResY; j++) {
                const oldJ = Math.round((newNMin + j * sp - oldNMin) / sp);
                if (oldJ < 0 || oldJ >= this.hmResY) continue;
                for (let i = 0; i < newResX; i++) {
                    const oldI = Math.round((newEMin + i * sp - oldEMin) / sp);
                    if (oldI < 0 || oldI >= oldResX) continue;
                    newWater[j * newResX + i] = oldWater[oldJ * oldResX + oldI];
                }
            }
        }

        this.hmEastMin = newEMin; this.hmEastMax = newEMax;
        this.hmNorthMin = newNMin; this.hmNorthMax = newNMax;
        this.hmResX = newResX; this.hmResY = newResY;
        const newCells = newResX * newResY;
        this.hmGround = new Float32Array(newCells);
        this.waterDepth = newWater;
        this.flowX = new Float32Array((newResX + 1) * newResY);
        this.flowY = new Float32Array(newResX * (newResY + 1));
        this.velX = new Float32Array(newCells);
        this.velY = new Float32Array(newCells);
        this._tmpVelX = new Float32Array(newCells);
        this._tmpVelY = new Float32Array(newCells);

        this.rebuildHMGround();
        this.setupWaterMesh();
    }

    // ── Instance matrix update ───────────────────────────────────────────

    updateInstances() {
        const ex = this.eastVec.x, ey = this.eastVec.y, ez = this.eastVec.z;
        const nx = this.northVec.x, ny = this.northVec.y, nz = this.northVec.z;
        const ux = this.upVec.x, uy = this.upVec.y, uz = this.upVec.z;
        const size = this.sphereSize;
        const originAlt = this.originAlt;
        const mat = this._mat4, elems = mat.elements;
        const _px = this.px, _py = this.py, _pz = this.pz, _alive = this.alive;

        let visCount = 0;
        for (let i = 0; i < this.count; i++) {
            if (!_alive[i]) continue;
            const e = _px[i], n = _py[i], u = _pz[i] - originAlt;
            const ox = e*ex + n*nx + u*ux;
            const oy = e*ey + n*ny + u*uy;
            const oz = e*ez + n*nz + u*uz;
            elems[0]=size; elems[1]=0; elems[2]=0; elems[3]=0;
            elems[4]=0; elems[5]=size; elems[6]=0; elems[7]=0;
            elems[8]=0; elems[9]=0; elems[10]=size; elems[11]=0;
            elems[12]=ox; elems[13]=oy; elems[14]=oz; elems[15]=1;
            this.instancedMesh.setMatrixAt(visCount, mat);
            visCount++;
        }
        this.instancedMesh.count = visCount;
        if (visCount > 0) this.instancedMesh.instanceMatrix.needsUpdate = true;
    }

    // ── Cleanup ──────────────────────────────────────────────────────────

    dispose() {
        if (this._renderInterval) clearInterval(this._renderInterval);
        if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
        this.removeDragListeners();
        this.removeBoundaryVisuals();
        if (this.instancedMesh) {
            this.instancedMesh.geometry.dispose();
            this.instancedMesh.material.dispose();
        }
        if (this.waterMesh) {
            this.waterMesh.geometry.dispose();
            this.waterMesh.material.dispose();
        }
        if (this.guiFolder) {
            // A scenario-provided folder is a permanent menu shell — empty it
            // (destroy(false) keeps permanent GUIs, drops their children) so
            // re-activation can rebuild into it. A legacy standalone folder is
            // fully destroyed as before.
            this.guiFolder.destroy(!this._guiFolderProvided);
        }
        super.dispose();
    }
}
