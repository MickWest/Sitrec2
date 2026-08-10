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
import {Color, DoubleSide, ShaderMaterial} from "three";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";
import {CustomManager, guiMenus, setRenderOne, Units} from "../Globals";
import {LLAToECEF} from "../LLA-ECEF-ENU";
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
                ...sharedUniforms,
            },
            vertexShader: `
                varying vec2 vUv;
                varying float vDepth;
                void main() {
                    vUv = uv;
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
                varying vec2 vUv;
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
                    float x = vUv.x * gridWidth;
                    float y = vUv.y * gridHeight;
                    float pxX = max(fwidth(x), 1e-6);
                    float pxY = max(fwidth(y), 1e-6);

                    if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) {
                        discard;
                    }

                    float halfMinor = 0.5 * minorLineWidth;
                    float halfMajor = 0.5 * majorLineWidth;

                    float aMinor = 0.0;
                    if (minorStep > 0.0) {
                        aMinor = minorBrightness * max(gridLine(x, minorStep, halfMinor, pxX),
                                                       gridLine(y, minorStep, halfMinor, pxY));
                    }

                    float aMajor = 0.0;
                    if (majorStep > 0.0) {
                        aMajor = max(gridLine(x, majorStep, halfMajor, pxX),
                                     gridLine(y, majorStep, halfMajor, pxY));
                    }

                    // Always draw the outline so an empty grid is still visible/draggable
                    float borderPx = min(min(x, gridWidth - x) / pxX,
                                         min(y, gridHeight - y) / pxY);
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
        setRenderOne(true);
    }

    updateMesh() {
        // Bounds may have changed (drag/resize/undo) — keep the shader's
        // world-size uniforms in sync so line spacing stays in real meters.
        this.updateGridUniforms();
        super.updateMesh();
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

        const minorController = this.guiFolder.add(this.gridParams, 'minorStep', 0, 1000, 1).allowInputExpandMax(true).onChange(() => {
            this.minorStep = this.gridParams.minorStep * Units.small2M;
            this.updateGridUniforms();
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

        this.guiFolder.add(this, 'rotation', -180, 180, 0.1).name(t("groundGrid.rotation.label")).onChange(() => {
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
            opacity: this.opacity,
        };
    }

    static deserialize(data) {
        return new CNodeGroundGrid(data);
    }
}
