/**
 * Module: ground grid node.
 *
 * A rectangular measurement grid draped over the terrain. Shares all the
 * ground-overlay machinery (terrain tile draping, drag/rotate/resize editing,
 * serialization, undo) by subclassing CNodeGroundOverlay, but renders
 * procedural anti-aliased major/minor grid lines in the fragment shader
 * instead of an image texture.
 *
 * Width/height and the major/minor line steps are edited in the current
 * "small" units (meters or feet) and stored internally in meters, so the
 * grid keeps its real-world size when the unit system changes.
 */
import {CNodeGroundOverlay} from "./CNodeGroundOverlay";
import {Color, DoubleSide, Float32BufferAttribute, ShaderMaterial, Vector2, Vector3} from "three";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";
import {CustomManager, guiMenus, setRenderOne, Units} from "../Globals";
import {ViewMan} from "../CViewManager";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {scaleF2M} from "../utils";
import {t} from "../i18n";

export class CNodeGroundGrid extends CNodeGroundOverlay {
    constructor(v) {
        // The base overlay needs north/south/east/west; allow creation from
        // center + width/height (meters) instead. noGUI suppresses the base
        // image-overlay GUI; the grid builds its own folder below.
        super({...CNodeGroundGrid.resolveBounds(v), noGUI: true});

        this.kindName = "grid";
        this.majorStep = v.majorStep ?? 100;   // meters, 0 = no major lines
        this.minorStep = v.minorStep ?? 10;    // meters, 0 = no minor lines
        this.majorLineWidth = v.majorLineWidth ?? 1.5;   // screen pixels
        this.minorLineWidth = v.minorLineWidth ?? 1;     // screen pixels
        this.minorBrightness = v.minorBrightness ?? 0.4; // minor line alpha multiplier
        this.color = v.color ?? "#ffff00";
        this.minorColor = v.minorColor ?? this.color;
        this.lockColors = v.lockColors ?? true;          // minor color follows major

        // Lat/Lon graticule mode: lines at power-of-10 degree multiples,
        // auto-promoted/demoted per view so minor spacing stays within
        // [minPixelSpacing, maxPixelSpacing] on screen.
        this.latLonGrid = v.latLonGrid ?? false;
        this.minPixelSpacing = v.minPixelSpacing ?? 10;
        this.maxPixelSpacing = v.maxPixelSpacing ?? 200;
        if (this.latLonGrid) this.rotation = 0;

        // Per-view step selection runs in onBeforeRender (each view renders
        // with its own camera, so a single per-frame update can't serve both).
        // Plain function so `this` is the mesh being rendered — its per-tile
        // lat/lon reference feeds the precision-preserving offset uniforms.
        const grid = this;
        this._latLonBeforeRender = function(renderer, scene, camera) {
            grid.updateLatLonUniforms(renderer, camera, this);
        };
        this.attachLatLonHooks();

        this.updateGridUniforms();

        if (!v.noGUI) {
            this.createGridGUI();
        }
    }

    /**
     * If given centerLat/centerLon plus width/height (meters) instead of
     * bounds, compute north/south/east/west. Static so it can run before super().
     */
    static resolveBounds(v) {
        if (v.north !== undefined || v.centerLat === undefined) return v;
        const mPerDeg = CNodeGroundGrid.metersPerDegreeAt(v.centerLat, v.centerLon);
        const halfLat = (v.height ?? 1000) / 2 / mPerDeg.lat;
        const halfLon = (v.width ?? 1000) / 2 / mPerDeg.lon;
        return {
            ...v,
            north: v.centerLat + halfLat,
            south: v.centerLat - halfLat,
            east: v.centerLon + halfLon,
            west: v.centerLon - halfLon,
        };
    }

    static metersPerDegreeAt(lat, lon) {
        return {
            lat: LLAToECEF(lat + 0.5, lon, 0).distanceTo(LLAToECEF(lat - 0.5, lon, 0)),
            lon: LLAToECEF(lat, lon + 0.5, 0).distanceTo(LLAToECEF(lat, lon - 0.5, 0)),
        };
    }

    // The grid is fully procedural — no texture to load, and the base
    // implementation would touch a "map" uniform this material doesn't have.
    async loadTexture() { }

    createMaterial() {
        // Called from the base constructor, before the subclass fields exist —
        // uniforms start as placeholders and updateGridUniforms() sets the real
        // values immediately after super() returns.
        const depthBias = -0.00001;

        this.overlayMaterial = new ShaderMaterial({
            uniforms: {
                opacity: { value: this.opacity },
                depthBias: { value: depthBias },
                gridColor: { value: new Color("#ffff00") },
                minorColor: { value: new Color("#ffff00") },
                minorBrightness: { value: 0.4 },
                gridWidth: { value: 1 },     // meters, U axis
                gridHeight: { value: 1 },    // meters, V axis
                majorStep: { value: 0 },     // meters, 0 = off
                minorStep: { value: 0 },     // meters, 0 = off
                majorLineWidth: { value: 1.5 },  // screen pixels
                minorLineWidth: { value: 1 },    // screen pixels
                // Lat/Lon graticule mode. Absolute degrees in float32 can't
                // resolve fine steps at real latitudes, so each vertex carries
                // its lat/lon RELATIVE to a per-tile reference (aLatLon, baked
                // in JS doubles), and these per-mesh offsets re-base that
                // reference onto an origin snapped to a multiple of the current
                // major step near the camera. Set per mesh in onBeforeRender.
                latLonMode: { value: 0 },
                latMinorDeg: { value: 0.001 },
                lonMinorDeg: { value: 0.001 },
                tileLatOff: { value: 0 },        // tile lat reference minus lat origin
                tileLonOff: { value: 0 },        // tile lon reference minus lon origin
                ...sharedUniforms,
            },
            vertexShader: `
                attribute vec2 aLatLon;
                varying vec2 vUv;
                varying vec2 vLatLon;
                varying float vDepth;
                void main() {
                    vUv = uv;
                    vLatLon = aLatLon;
                    gl_Position = applyTerrestrialRefraction_clip(modelViewMatrix * vec4(position, 1.0));
                    vDepth = gl_Position.w;
                }
            `,
            fragmentShader: `
                uniform float opacity;
                uniform float depthBias;
                uniform float nearPlane;
                uniform float farPlane;
                uniform vec3 gridColor;
                uniform vec3 minorColor;
                uniform float minorBrightness;
                uniform float gridWidth;
                uniform float gridHeight;
                uniform float majorStep;
                uniform float minorStep;
                uniform float majorLineWidth;
                uniform float minorLineWidth;
                uniform float latLonMode;
                uniform float latMinorDeg;
                uniform float lonMinorDeg;
                uniform float tileLatOff;
                uniform float tileLonOff;
                varying vec2 vUv;
                varying vec2 vLatLon;
                varying float vDepth;

                // Anti-aliased line coverage: distance (meters) to the nearest
                // multiple of stepM, converted to pixels via mPerPx. Lines fade
                // out when the step spacing drops under a few pixels so a
                // zoomed-out grid doesn't collapse into aliased mush.
                float gridLine(float coord, float stepM, float halfPx, float mPerPx) {
                    float d = abs(coord - stepM * floor(coord / stepM + 0.5));
                    float px = d / mPerPx;
                    float line = 1.0 - smoothstep(halfPx - 0.5, halfPx + 0.5, px);
                    float fade = smoothstep(2.0, 5.0, stepM / mPerPx);
                    return line * fade;
                }

                void main() {
                    // Derivatives before the discard: fwidth needs uniform control flow.
                    // Line coordinates: meters in normal mode, origin-relative
                    // degrees in lat/lon mode (each axis with its own step).
                    float cx, cy, minStepX, majStepX, minStepY, majStepY;
                    if (latLonMode > 0.5) {
                        cx = tileLonOff + vLatLon.y;
                        cy = tileLatOff + vLatLon.x;
                        minStepX = lonMinorDeg; majStepX = lonMinorDeg * 10.0;
                        minStepY = latMinorDeg; majStepY = latMinorDeg * 10.0;
                    } else {
                        cx = vUv.x * gridWidth;
                        cy = vUv.y * gridHeight;
                        minStepX = minorStep; majStepX = majorStep;
                        minStepY = minorStep; majStepY = majorStep;
                    }
                    float pxX = max(fwidth(cx), 1e-12);
                    float pxY = max(fwidth(cy), 1e-12);

                    // Border always measures in meters, independent of mode
                    float bx = vUv.x * gridWidth;
                    float by = vUv.y * gridHeight;
                    float bpxX = max(fwidth(bx), 1e-9);
                    float bpxY = max(fwidth(by), 1e-9);

                    if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) {
                        discard;
                    }

                    float halfMinor = 0.5 * minorLineWidth;
                    float halfMajor = 0.5 * majorLineWidth;

                    float aMinor = 0.0;
                    if (minStepX > 0.0) {
                        aMinor = gridLine(cx, minStepX, halfMinor, pxX);
                    }
                    if (minStepY > 0.0) {
                        aMinor = max(aMinor, gridLine(cy, minStepY, halfMinor, pxY));
                    }
                    aMinor *= minorBrightness;

                    float aMajor = 0.0;
                    if (majStepX > 0.0) {
                        aMajor = gridLine(cx, majStepX, halfMajor, pxX);
                    }
                    if (majStepY > 0.0) {
                        aMajor = max(aMajor, gridLine(cy, majStepY, halfMajor, pxY));
                    }

                    // Always draw the outline so an empty grid is still visible/draggable
                    float borderPx = min(min(bx, gridWidth - bx) / bpxX,
                                         min(by, gridHeight - by) / bpxY);
                    aMajor = max(aMajor, 1.0 - smoothstep(halfMajor - 0.5, halfMajor + 0.5, borderPx));

                    // Composite major lines over minor lines so each keeps its color
                    float alpha = aMajor + aMinor * (1.0 - aMajor);
                    if (alpha < 0.004) {
                        discard;
                    }
                    vec3 col = (gridColor * aMajor + minorColor * aMinor * (1.0 - aMajor)) / alpha;
                    gl_FragColor = vec4(col, alpha * opacity);

                    // Orthographic projection makes vDepth a constant 1.0, collapsing
                    // the log formula to one value per fragment → z-fighting; use the
                    // linear rasteriser depth there (biased identically).
                    if (vDepth == 1.0) {
                        gl_FragDepthEXT = gl_FragCoord.z + depthBias;
                    } else {
                        float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                        gl_FragDepthEXT = z * 0.5 + 0.5 + depthBias;
                    }
                }
            `,
            side: DoubleSide,
            transparent: true,
            depthTest: true,
            depthWrite: false,
        });
        installTerrestrialRefractionOnShaderMaterial(this.overlayMaterial);
    }

    getWidthMeters() {
        const centerLat = (this.north + this.south) / 2;
        const centerLon = (this.east + this.west) / 2;
        return (this.east - this.west) * CNodeGroundGrid.metersPerDegreeAt(centerLat, centerLon).lon;
    }

    getHeightMeters() {
        const centerLat = (this.north + this.south) / 2;
        const centerLon = (this.east + this.west) / 2;
        return (this.north - this.south) * CNodeGroundGrid.metersPerDegreeAt(centerLat, centerLon).lat;
    }

    setWidthMeters(w) {
        const centerLat = (this.north + this.south) / 2;
        const centerLon = (this.east + this.west) / 2;
        const halfDeg = w / 2 / CNodeGroundGrid.metersPerDegreeAt(centerLat, centerLon).lon;
        this.west = centerLon - halfDeg;
        this.east = centerLon + halfDeg;
    }

    setHeightMeters(h) {
        const centerLat = (this.north + this.south) / 2;
        const centerLon = (this.east + this.west) / 2;
        const halfDeg = h / 2 / CNodeGroundGrid.metersPerDegreeAt(centerLat, centerLon).lat;
        this.south = centerLat - halfDeg;
        this.north = centerLat + halfDeg;
    }

    updateGridUniforms() {
        const u = this.overlayMaterial.uniforms;
        u.gridWidth.value = this.getWidthMeters();
        u.gridHeight.value = this.getHeightMeters();
        u.majorStep.value = this.majorStep;
        u.minorStep.value = this.minorStep;
        u.majorLineWidth.value = this.majorLineWidth;
        u.minorLineWidth.value = this.minorLineWidth;
        u.minorBrightness.value = this.minorBrightness;
        u.gridColor.value.set(this.color);
        u.minorColor.value.set(this.lockColors ? this.color : this.minorColor);
        u.opacity.value = this.opacity;
        u.latLonMode.value = this.latLonGrid ? 1 : 0;
        setRenderOne(true);
    }

    updateMesh() {
        // Lat/lon lines only make sense axis-aligned; the rotation handle and
        // any stale saved value are neutralized here (called on every edit).
        if (this.latLonGrid) this.rotation = 0;
        this._mPerDegCache = null;
        // Bounds may have changed (drag/resize/undo) — keep the shader's
        // world-size uniforms in sync so line spacing stays in real meters.
        this.updateGridUniforms();
        super.updateMesh();
        this.attachLatLonHooks();
    }

    // Mesh rebuilds go through the base class; re-attach the per-view hook to
    // whatever meshes currently exist (idempotent property assignment).
    attachLatLonHooks() {
        this.overlayTileMeshes.forEach(entry => {
            if (entry.mesh) entry.mesh.onBeforeRender = this._latLonBeforeRender;
            // Skirts share the material, so they too must push their own
            // tile offsets before drawing or they render with another tile's.
            if (entry.skirtMesh) entry.skirtMesh.onBeforeRender = this._latLonBeforeRender;
        });
        if (this.flatMesh) this.flatMesh.onBeforeRender = this._latLonBeforeRender;
    }

    /**
     * Bake per-vertex lat/lon relative to a per-mesh reference (the first
     * vertex), computed in JS doubles. Small relative values survive float32,
     * so graticule lines stay pinned at any grid size and zoom; the reference
     * itself is re-based against the view's origin in onBeforeRender.
     */
    bakeLatLonAttribute(mesh, ref) {
        const geom = mesh?.geometry;
        const pos = geom?.attributes?.position;
        if (!pos) return ref;
        const gp = this.group.position;
        this._scratchWorld = this._scratchWorld || new Vector3();
        const arr = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
            this._scratchWorld.set(pos.getX(i) + gp.x, pos.getY(i) + gp.y, pos.getZ(i) + gp.z);
            const lla = ECEFToLLAVD_radii(this._scratchWorld);
            if (!ref) ref = {lat: lla.x, lon: lla.y};
            arr[i * 2] = lla.x - ref.lat;
            arr[i * 2 + 1] = lla.y - ref.lon;
        }
        geom.setAttribute('aLatLon', new Float32BufferAttribute(arr, 2));
        mesh.userData.latLonRef = ref;
        return ref;
    }

    createOverlayTileFromTerrainTile(tile, mapProjection, layerMask) {
        super.createOverlayTileFromTerrainTile(tile, mapProjection, layerMask);
        const entry = this.overlayTileMeshes.get(tile.key());
        if (!entry) return;
        const ref = this.bakeLatLonAttribute(entry.mesh, null);
        this.bakeLatLonAttribute(entry.skirtMesh, ref);
        if (this._latLonBeforeRender) {
            if (entry.mesh) entry.mesh.onBeforeRender = this._latLonBeforeRender;
            if (entry.skirtMesh) entry.skirtMesh.onBeforeRender = this._latLonBeforeRender;
        }
    }

    buildFlatMesh() {
        super.buildFlatMesh();
        if (!this.flatMesh) return;
        this.bakeLatLonAttribute(this.flatMesh, null);
        if (this._latLonBeforeRender) {
            this.flatMesh.onBeforeRender = this._latLonBeforeRender;
        }
    }

    getMetersPerDegreeCached() {
        if (!this._mPerDegCache) {
            const centerLat = (this.north + this.south) / 2;
            const centerLon = (this.east + this.west) / 2;
            this._mPerDegCache = CNodeGroundGrid.metersPerDegreeAt(centerLat, centerLon);
        }
        return this._mPerDegCache;
    }

    /**
     * Pick the power-of-10 degree step whose on-screen minor spacing lies
     * within [minPixelSpacing, maxPixelSpacing]: the smallest power of 10
     * at least minPixelSpacing wide, demoted once if it overshoots the max
     * (max wins when the two bounds conflict).
     */
    pickPow10(degPerPx) {
        const minPx = Math.max(1, this.minPixelSpacing);
        const maxPx = Math.max(1, this.maxPixelSpacing);
        // Smallest power of 10 at least minPx wide...
        let n = Math.ceil(Math.log10(minPx * degPerPx));
        if (Math.pow(10, n) / degPerPx > maxPx) {
            // ...unless that exceeds the max: then max wins — the largest
            // power of 10 not wider than maxPx (also covers min > max).
            n = Math.floor(Math.log10(maxPx * degPerPx));
        }
        n = Math.max(-7, Math.min(1, n));
        return Math.pow(10, n);
    }

    /**
     * Per-mesh, per-view (onBeforeRender) selection of the lat/lon steps.
     * Estimates meters-per-pixel at the grid center for THIS camera, converts
     * to degrees-per-pixel per axis, picks the power-of-10 steps, and re-bases
     * the mesh's baked lat/lon reference onto an origin snapped to the major
     * step near the camera — keeping every number small enough for float32.
     */
    updateLatLonUniforms(renderer, camera, mesh) {
        const u = this.overlayMaterial.uniforms;
        if (!this.latLonGrid) {
            u.latLonMode.value = 0;
            this.hideLatLonLegend(camera);
            return;
        }
        u.latLonMode.value = 1;

        this._scratchSize = this._scratchSize || new Vector2();
        const heightPx = Math.max(1, renderer.getDrawingBufferSize(this._scratchSize).y);

        this._scratchCam = this._scratchCam || new Vector3();
        const camPos = camera.getWorldPosition(this._scratchCam);

        let mPerPx;
        if (camera.isOrthographicCamera) {
            mPerPx = (camera.top - camera.bottom) / (camera.zoom * heightPx);
        } else {
            const dist = camPos.distanceTo(this.group.position);
            const focalPx = 0.5 * heightPx / Math.tan(0.5 * camera.fov * Math.PI / 180);
            mPerPx = dist / focalPx;
        }

        const mPerDeg = this.getMetersPerDegreeCached();
        const latMinor = this.pickPow10(mPerPx / mPerDeg.lat);
        const lonMinor = this.pickPow10(mPerPx / mPerDeg.lon);

        // Anchor the origin under the camera (clamped to the grid) so the
        // offsets are near zero exactly where fine lines are on screen.
        const camLLA = ECEFToLLAVD_radii(camPos);
        const anchorLat = Math.min(Math.max(camLLA.x, this.south), this.north);
        const anchorLon = Math.min(Math.max(camLLA.y, this.west), this.east);
        const latOrigin = Math.round(anchorLat / (latMinor * 10)) * (latMinor * 10);
        const lonOrigin = Math.round(anchorLon / (lonMinor * 10)) * (lonMinor * 10);

        const ref = mesh?.userData?.latLonRef;
        u.latMinorDeg.value = latMinor;
        u.lonMinorDeg.value = lonMinor;
        u.tileLatOff.value = ref ? ref.lat - latOrigin : 0;
        u.tileLonOff.value = ref ? ref.lon - lonOrigin : 0;
        // Required when changing a shared material's uniforms from
        // onBeforeRender: without it the draw can reuse the uniform values
        // uploaded for the previous mesh or view's camera.
        this.overlayMaterial.uniformsNeedUpdate = true;

        this.updateLatLonLegend(camera, latMinor, lonMinor);
    }

    findViewForCamera(camera) {
        let found = null;
        ViewMan.iterate((id, view) => {
            if (!found && view.camera === camera && view.div) found = view;
        });
        return found;
    }

    /**
     * Per-view legend ("Major: 0.001°, Minor: 0.0001°") along the bottom of
     * each 3D view showing that view's current graticule spacing; lat and lon
     * are listed separately when they resolve to different powers of 10.
     */
    updateLatLonLegend(camera, latMinor, lonMinor) {
        this._legendEls = this._legendEls || new Map();
        let entry = this._legendEls.get(camera);
        if (!entry) {
            const view = this.findViewForCamera(camera);
            if (!view || !view.div) return;
            const el = document.createElement('div');
            el.style.cssText = "position:absolute;bottom:2px;left:50%;transform:translateX(-50%);" +
                "pointer-events:none;z-index:50;font:11px monospace;padding:1px 6px;" +
                "border-radius:3px;background:rgba(0,0,0,0.45);white-space:nowrap;";
            view.div.appendChild(el);
            entry = {el, text: ""};
            this._legendEls.set(camera, entry);
        }
        const fmt = v => {
            const n = Math.round(Math.log10(v));
            return (n >= 0 ? v.toFixed(0) : v.toFixed(-n)) + "°";
        };
        const text = (latMinor === lonMinor)
            ? `Major: ${fmt(latMinor * 10)}, Minor: ${fmt(latMinor)}`
            : `Lat Major: ${fmt(latMinor * 10)}, Minor: ${fmt(latMinor)} | Lon Major: ${fmt(lonMinor * 10)}, Minor: ${fmt(lonMinor)}`;
        if (entry.text !== text) {
            entry.text = text;
            entry.el.textContent = text;
        }
        entry.el.style.color = this.color;
        entry.el.style.display = "";
    }

    hideLatLonLegend(camera) {
        const entry = this._legendEls?.get(camera);
        if (entry) entry.el.style.display = "none";
    }

    hideAllLatLonLegends() {
        this._legendEls?.forEach(entry => { entry.el.style.display = "none"; });
    }

    removeLatLonLegends() {
        this._legendEls?.forEach(entry => entry.el.remove());
        this._legendEls = null;
    }

    show(visible = true) {
        super.show(visible);
        if (!visible) this.hideAllLatLonLegends();
    }

    dispose() {
        this.removeLatLonLegends();
        super.dispose();
    }

    updateGUIControllers() {
        this.syncGridParamsFromState();
        super.updateGUIControllers();
    }

    // Grids don't use the overlay's photo-matching lock points; let the
    // right-click fall through to the normal context menu handling.
    onContextMenu() { }

    createGridGUI() {
        this.guiFolder = guiMenus.objects.addFolder(`Grid: ${this.name}`);

        this.guiFolder.add(this, 'name').name(t("groundGrid.name.label")).onChange(() => {
            this.guiFolder.title = `Grid: ${this.name}`;
        });

        this.guiFolder.add(this, 'visible').name(t("groundGrid.visible.label")).onChange((value) => {
            this.show(value);
            setRenderOne(true);
        }).onFinishChange(() => { CustomManager.saveGlobalSettings(true); });

        const editModeData = {editMode: this.editMode};
        this.editModeController = this.guiFolder.add(editModeData, 'editMode').name(t("groundGrid.editMode.label")).onChange((value) => {
            this.setEditMode(value);
        });

        // GUI proxy values in the current small units; internal state is meters
        // (altitude is feet, matching the base overlay's buildFlatMesh contract)
        this.gridParams = {width: 0, height: 0, majorStep: 0, minorStep: 0, altitude: 0};
        this.syncGridParamsFromState();

        const widthController = this.guiFolder.add(this.gridParams, 'width', 1, 10000, 1).allowInputExpandMax(true).onChange(() => {
            this.setWidthMeters(this.gridParams.width * Units.small2M);
            this.updateMesh();
        });

        const heightController = this.guiFolder.add(this.gridParams, 'height', 1, 10000, 1).allowInputExpandMax(true).onChange(() => {
            this.setHeightMeters(this.gridParams.height * Units.small2M);
            this.updateMesh();
        });

        const majorController = this.guiFolder.add(this.gridParams, 'majorStep', 0, 1000, 1).allowInputExpandMax(true).onChange(() => {
            this.majorStep = this.gridParams.majorStep * Units.small2M;
            this.updateGridUniforms();
        });
        this.majorStepController = majorController;

        const minorController = this.guiFolder.add(this.gridParams, 'minorStep', 0, 1000, 1).allowInputExpandMax(true).onChange(() => {
            this.minorStep = this.gridParams.minorStep * Units.small2M;
            this.updateGridUniforms();
        });
        this.minorStepController = minorController;

        this.guiFolder.add(this, 'latLonGrid').name(t("groundGrid.latLonGrid.label")).onChange(() => {
            this.applyLatLonMode();
        });

        this.minPxController = this.guiFolder.add(this, 'minPixelSpacing', 2, 100, 1).name(t("groundGrid.minPixelSpacing.label")).onChange(() => {
            setRenderOne(true);
        });

        this.maxPxController = this.guiFolder.add(this, 'maxPixelSpacing', 20, 1000, 5).name(t("groundGrid.maxPixelSpacing.label")).onChange(() => {
            setRenderOne(true);
        });

        // Line widths are screen pixels, so no small-unit conversion or relabeling
        this.guiFolder.add(this, 'majorLineWidth', 0.5, 8, 0.1).name(t("groundGrid.majorLineWidth.label")).onChange(() => {
            this.updateGridUniforms();
        });

        this.guiFolder.add(this, 'minorLineWidth', 0.5, 8, 0.1).name(t("groundGrid.minorLineWidth.label")).onChange(() => {
            this.updateGridUniforms();
        });

        this.guiFolder.add(this, 'minorBrightness', 0, 1, 0.01).name(t("groundGrid.minorBrightness.label")).onChange(() => {
            this.updateGridUniforms();
        });

        this.rotationController = this.guiFolder.add(this, 'rotation', -180, 180, 0.1).name(t("groundGrid.rotation.label")).onChange(() => {
            this.updateMesh();
        });

        const altitudeController = this.guiFolder.add(this.gridParams, 'altitude', 0, 10000, 1).allowInputExpandMax(true).onChange(() => {
            this.altitude = this.gridParams.altitude * Units.small2M / scaleF2M;
            this.updateMesh();
        });

        this.guiFolder.addColor(this, 'color').name(t("groundGrid.color.label")).onChange(() => {
            if (this.lockColors) {
                this.minorColor = this.color;
                this.minorColorController.updateDisplay();
            }
            this.updateGridUniforms();
        });

        this.minorColorController = this.guiFolder.addColor(this, 'minorColor').name(t("groundGrid.minorColor.label")).onChange(() => {
            this.updateGridUniforms();
        });

        this.guiFolder.add(this, 'lockColors').name(t("groundGrid.lockColors.label")).onChange(() => {
            this.applyColorLock();
        });
        this.applyColorLock();
        this.applyLatLonMode();

        this.guiFolder.add(this, 'opacity', 0, 1, 0.01).name(t("groundGrid.opacity.label")).onChange(() => {
            this.updateGridUniforms();
        });

        this.unitControllers = [
            [widthController, "groundGrid.width.label"],
            [heightController, "groundGrid.height.label"],
            [majorController, "groundGrid.majorStep.label"],
            [minorController, "groundGrid.minorStep.label"],
            [altitudeController, "groundGrid.altitude.label"],
        ];
        this.updateUnitLabels();

        this.guiFolder.add({goto: () => this.gotoOverlay()}, 'goto').name(t("groundGrid.gotoGrid.label"));
        this.guiFolder.add({remove: () => this.deleteOverlay()}, 'remove').name(t("groundGrid.deleteGrid.label"));

        this.guiFolder.domElement.addEventListener('mouseenter', () => {
            this.showHighlightBorder();
        });
        this.guiFolder.domElement.addEventListener('mouseleave', () => {
            this.hideHighlightBorder();
        });

        this.guiFolder.close();
    }

    /**
     * Apply the Lat/Lon Grid state: step and rotation fields don't apply to a
     * graticule (steps are auto power-of-10, rotation forced 0), and the pixel
     * spacing bounds only apply to a graticule. Enable/disable accordingly,
     * in the source folder and any mirrored edit menus.
     */
    applyLatLonMode() {
        const on = this.latLonGrid;
        const setEnabled = (ctrl, enabled) => {
            if (!ctrl) return;
            if (enabled) {
                ctrl.enable();
                ctrl._mirrorControllers?.forEach(m => m.enable());
            } else {
                ctrl.disable();
                ctrl._mirrorControllers?.forEach(m => m.disable());
            }
        };
        setEnabled(this.majorStepController, !on);
        setEnabled(this.minorStepController, !on);
        setEnabled(this.rotationController, !on);
        setEnabled(this.minPxController, on);
        setEnabled(this.maxPxController, on);
        if (on) {
            this.rotation = 0;
            this.rotationController?.updateDisplay();
        } else {
            this.hideAllLatLonLegends();
        }
        this.updateMesh();
    }

    /**
     * Apply the Lock Colors state: when locked, the minor color mirrors the
     * major color and its picker is greyed out (in the source folder and any
     * mirrored edit menus).
     */
    applyColorLock() {
        if (this.lockColors) {
            this.minorColor = this.color;
            this.minorColorController.updateDisplay();
            this.minorColorController.disable();
            this.minorColorController._mirrorControllers?.forEach(m => m.disable());
        } else {
            this.minorColorController.enable();
            this.minorColorController._mirrorControllers?.forEach(m => m.enable());
        }
        this.updateGridUniforms();
    }

    syncGridParamsFromState() {
        if (!this.gridParams) return;
        const r2 = x => Math.round(x * 100) / 100;
        const m2s = Units.m2Small;
        this.gridParams.width = r2(this.getWidthMeters() * m2s);
        this.gridParams.height = r2(this.getHeightMeters() * m2s);
        this.gridParams.majorStep = r2(this.majorStep * m2s);
        this.gridParams.minorStep = r2(this.minorStep * m2s);
        this.gridParams.altitude = r2(this.altitude * scaleF2M * m2s);
    }

    updateUnitLabels() {
        if (!this.unitControllers) return;
        const abbrev = Units.smallUnitsAbbrev;
        for (const [controller, key] of this.unitControllers) {
            const label = `${t(key)} (${abbrev})`;
            controller.name(label);
            // The floating edit menu holds mirrored copies of these controllers;
            // rename them too or they keep showing the old unit suffix.
            controller._mirrorControllers?.forEach(m => m.name(label));
        }
    }

    // Units system hooks: changeUnits fires on a live unit switch,
    // updateDesc when units are set during deserialization.
    changeUnits() { this.refreshUnitsUI(); }
    updateDesc() { this.refreshUnitsUI(); }

    refreshUnitsUI() {
        if (!this.gridParams) return;
        this.updateUnitLabels();
        this.updateGUIControllers();
    }

    serialize() {
        return {
            type: "grid",
            id: this.overlayID,
            name: this.name,
            visible: this.visible,
            north: this.north,
            south: this.south,
            east: this.east,
            west: this.west,
            rotation: this.rotation,
            altitude: this.altitude,
            majorStep: this.majorStep,
            minorStep: this.minorStep,
            majorLineWidth: this.majorLineWidth,
            minorLineWidth: this.minorLineWidth,
            minorBrightness: this.minorBrightness,
            color: this.color,
            minorColor: this.minorColor,
            lockColors: this.lockColors,
            latLonGrid: this.latLonGrid,
            minPixelSpacing: this.minPixelSpacing,
            maxPixelSpacing: this.maxPixelSpacing,
            opacity: this.opacity,
        };
    }

    static deserialize(data) {
        return new CNodeGroundGrid(data);
    }
}
