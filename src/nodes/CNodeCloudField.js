// Renders a cloud field: soft emitting spheres fixed in a local frame that drifts
// with one wind. The data model and file format are in cloudField/CloudFieldFormat.js;
// this node does not care whether the field came from a file, a generator or an editor.
//
// Each sphere is one instance of a small icosahedron that encloses it. Only back
// faces are drawn, so each pixel is shaded once, from outside or inside the sphere.
// The fragment shader finds the exact distance b between the eye ray and the sphere
// centre and emits emission * (1 - b^2/R^2)^2, the line integral of the density
// (1 - r^2/R^2)^(3/2). Overlapping spheres add (or subtract, for a dark-on-light
// display). The math is done in view space: ECEF world coordinates in Float32 are
// only good to about half a metre, which is a pixel at a narrow field of view.

import {
    AdditiveBlending,
    BackSide,
    Color,
    CustomBlending,
    IcosahedronGeometry,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Matrix4,
    Mesh,
    OneFactor,
    ReverseSubtractEquation,
    ShaderMaterial,
    Vector3,
} from "three";
import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {LLAToECEF} from "../LLA-ECEF-ENU";
import {guiMenus, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {t} from "../i18n";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";
import {localAxesEN, localENU, windVelocityEN} from "../cloudField/CloudFieldFormat";

// An icosahedron with circumradius 1 has inradius 0.7947; scale it so its faces
// clear the unit sphere everywhere.
const HULL_SCALE = 1 / 0.7946544722917661;

export const CLOUD_FIELD_BLEND_MODES = ["Add", "Subtract"];

export class CNodeCloudField extends CNode3DGroup {
    constructor(v) {
        super({...v, layers: v.layers ?? LAYER.MASK_WORLD});
        this.field = v.field;
        this.isThermalCloud = "unresolvedThermal";
        this.name = v.name ?? this.field.name;
        this.gain = v.gain ?? this.field.display?.gain ?? 1;
        this.minEmission = v.minEmission ?? this.field.display?.minEmission ?? 0;
        this.refraction = v.refraction ?? this.field.display?.refraction ?? true;
        this.color = new Color(v.color ?? "#ffffff");
        this.blendMode = v.blendMode ?? "Add";
        this.windFrom = v.windFrom ?? this.field.wind.fromDeg;
        this.windKnots = v.windKnots ?? this.field.wind.knots;
        this.epochFrame = this.field.wind.epochFrame;

        this.placeFrame();
        this.buildMesh();
        this.createGUIFolder();
    }

    // Local frame -> ECEF: origin in double precision, axes as the group rotation,
    // so sphere centres stay small local Float32 values.
    placeFrame() {
        const {lat, lon, alt} = this.field.origin;
        this.originECEF = LLAToECEF(lat, lon, alt);
        // From the angles, so the frame is defined even at a pole.
        const enu = localENU(lat, lon);
        this.east = new Vector3(...enu.east);
        this.north = new Vector3(...enu.north);
        this.up = new Vector3(...enu.up);
        const axes = localAxesEN(this.field.headingDeg);
        const xAxis = this.east.clone().multiplyScalar(axes.x.east).addScaledVector(this.north, axes.x.north);
        const yAxis = this.east.clone().multiplyScalar(axes.y.east).addScaledVector(this.north, axes.y.north);
        this.group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, this.up));
        this.group.position.copy(this.originECEF);
        this.updateWindVelocity();
    }

    updateWindVelocity() {
        const wind = windVelocityEN(this.windFrom, this.windKnots);
        this.windVelocity = this.east.clone().multiplyScalar(wind.east).addScaledVector(this.north, wind.north);
    }

    buildMesh() {
        this.disposeMesh();
        const hull = new IcosahedronGeometry(1, 0);
        const geometry = new InstancedBufferGeometry();
        geometry.index = hull.index;
        geometry.setAttribute("position", hull.getAttribute("position"));
        geometry.setAttribute("sphereCenter", new InstancedBufferAttribute(this.field.centers, 3));
        geometry.setAttribute("sphereRadius", new InstancedBufferAttribute(this.field.radii, 1));
        geometry.setAttribute("sphereEmission", new InstancedBufferAttribute(this.field.emissions, 1));
        geometry.instanceCount = this.field.count;

        const material = new ShaderMaterial({
            uniforms: {
                hullScale: {value: HULL_SCALE},
                gain: {value: this.gain},
                minEmission: {value: this.minEmission},
                refraction: {value: this.refraction ? 1 : 0},
                tint: {value: this.color},
            },
            vertexShader: /* glsl */`
                attribute vec3 sphereCenter;
                attribute float sphereRadius;
                attribute float sphereEmission;
                uniform float hullScale;
                uniform float refraction;
                varying vec3 vViewPosition;
                varying vec3 vViewCenter;
                varying float vRadius;
                varying float vEmission;
                #include <common>
                #include <logdepthbuf_pars_vertex>
                void main() {
                    vec4 mvCenter = modelViewMatrix * vec4(sphereCenter, 1.0);
                    vec4 mvPosition = modelViewMatrix * vec4(sphereCenter + position * sphereRadius * hullScale, 1.0);
                    // Refraction moves the whole sphere by its centre's shift, so its
                    // shape (and the ray math below) stays exact. A field fitted to video
                    // already holds apparent (refracted) positions, so it turns this off.
                    vec3 lift = refraction * (applyTerrestrialRefraction_chunk(mvCenter.xyz) - mvCenter.xyz);
                    mvCenter.xyz += lift;
                    mvPosition.xyz += lift;
                    vViewPosition = mvPosition.xyz;
                    vViewCenter = mvCenter.xyz;
                    vRadius = sphereRadius;
                    vEmission = sphereEmission;
                    gl_Position = projectionMatrix * mvPosition;
                    #include <logdepthbuf_vertex>
                }
            `,
            fragmentShader: /* glsl */`
                uniform float gain;
                uniform float minEmission;
                uniform vec3 tint;
                varying vec3 vViewPosition;
                varying vec3 vViewCenter;
                varying float vRadius;
                varying float vEmission;
                #include <common>
                #include <logdepthbuf_pars_fragment>
                void main() {
                    #include <logdepthbuf_fragment>
                    if (vEmission < minEmission) discard;
                    // Eye ray in view space: from the origin for a perspective camera,
                    // along -z through this fragment for an orthographic one.
                    vec3 direction = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(vViewPosition);
                    vec3 toCenter = vViewCenter - (isOrthographic ? vViewPosition : vec3(0.0));
                    if (!isOrthographic && dot(toCenter, direction) < -vRadius) discard;   // wholly behind the eye
                    vec3 miss = toCenter - direction * dot(toCenter, direction);
                    float q = dot(miss, miss) / (vRadius * vRadius);
                    if (q >= 1.0) discard;
                    float value = gain * vEmission * (1.0 - q) * (1.0 - q);
                    gl_FragColor = vec4(tint * value, 1.0);
                }
            `,
            side: BackSide,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            toneMapped: false,
        });
        this.applyBlendMode(material);
        installTerrestrialRefractionOnShaderMaterial(material);

        this.mesh = new Mesh(geometry, material);
        this.mesh.frustumCulled = false;
        this.mesh.layers.mask = this.group.layers.mask;
        this.mesh.userData.ignoreContextMenu = true;
        this.group.add(this.mesh);
        hull.dispose();
    }

    applyBlendMode(material) {
        if (this.blendMode === "Subtract") {
            // destination - source: clouds darken the scene, as on a black-hot display.
            material.blending = CustomBlending;
            material.blendEquation = ReverseSubtractEquation;
            material.blendSrc = OneFactor;
            material.blendDst = OneFactor;
        } else {
            material.blending = AdditiveBlending;
        }
        material.needsUpdate = true;
    }

    // Position the drifting frame for the frame being rendered.
    preRender(view) {
        const frame = par.frame ?? 0;
        const seconds = (frame - this.epochFrame) / (Sit.fps || 30);
        this.group.position.copy(this.originECEF).addScaledVector(this.windVelocity, seconds);
    }

    createGUIFolder() {
        this.guiFolder = guiMenus.objects.addFolder(t("cloudField.folder.label", {name: this.name}));
        this.guiFolder.add(this, "visible").name(t("cloudField.visible.label")).onChange(value => {
            this.show(value);
            setRenderOne(true);
        });
        this.guiFolder.add(this, "gain", 0, 10, 0.01).name(t("cloudField.gain.label"))
            .tooltip(t("cloudField.gain.tooltip")).onChange(value => {
                this.mesh.material.uniforms.gain.value = value;
                setRenderOne(true);
            });
        this.guiFolder.add(this, "minEmission", 0, 1, 0.001).name(t("cloudField.minEmission.label"))
            .tooltip(t("cloudField.minEmission.tooltip")).onChange(value => {
                this.mesh.material.uniforms.minEmission.value = value;
                setRenderOne(true);
            });
        this.guiFolder.add(this, "refraction").name(t("cloudField.refraction.label"))
            .tooltip(t("cloudField.refraction.tooltip")).onChange(value => {
                this.mesh.material.uniforms.refraction.value = value ? 1 : 0;
                setRenderOne(true);
            });
        this.guiFolder.addColor(this, "color").name(t("cloudField.color.label")).onChange(() => setRenderOne(true));
        this.guiFolder.add(this, "blendMode", CLOUD_FIELD_BLEND_MODES).name(t("cloudField.blendMode.label"))
            .tooltip(t("cloudField.blendMode.tooltip")).onChange(() => {
                this.applyBlendMode(this.mesh.material);
                setRenderOne(true);
            });
        this.guiFolder.add(this, "windFrom", 0, 359, 1).name(t("cloudField.windFrom.label"))
            .tooltip(t("cloudField.windFrom.tooltip")).onChange(() => {
                this.updateWindVelocity();
                setRenderOne(true);
            });
        this.guiFolder.add(this, "windKnots", 0, 200, 0.1).name(t("cloudField.windKnots.label"))
            .tooltip(t("cloudField.windKnots.tooltip")).onChange(() => {
                this.updateWindVelocity();
                setRenderOne(true);
            });
        this.guiFolder.close();
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            visible: this.visible,
            gain: this.gain,
            minEmission: this.minEmission,
            refraction: this.refraction,
            color: "#" + this.color.getHexString(),
            blendMode: this.blendMode,
            windFrom: this.windFrom,
            windKnots: this.windKnots,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.gain !== undefined) this.gain = v.gain;
        if (v.minEmission !== undefined) this.minEmission = v.minEmission;
        if (v.refraction !== undefined) this.refraction = !!v.refraction;
        if (v.color !== undefined) this.color.set(v.color);
        if (CLOUD_FIELD_BLEND_MODES.includes(v.blendMode)) this.blendMode = v.blendMode;
        if (v.windFrom !== undefined) this.windFrom = v.windFrom;
        if (v.windKnots !== undefined) this.windKnots = v.windKnots;
        if (v.visible !== undefined) this.show(v.visible);
        this.updateWindVelocity();
        if (this.mesh) {
            this.mesh.material.uniforms.gain.value = this.gain;
            this.mesh.material.uniforms.minEmission.value = this.minEmission;
            this.mesh.material.uniforms.refraction.value = this.refraction ? 1 : 0;
            this.applyBlendMode(this.mesh.material);
        }
        this.guiFolder?.controllersRecursive().forEach(c => c.updateDisplay());
    }

    disposeMesh() {
        if (!this.mesh) return;
        this.group.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.mesh = null;
    }

    dispose() {
        this.disposeMesh();
        this.guiFolder?.destroy();
        this.guiFolder = null;
        super.dispose();
    }
}
