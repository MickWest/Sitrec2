// WaterPlanarMirror.js
//
// "Perfect mirror" water reflection: the alternative to CNodeWaterReflection's
// sky cube. Instead of reflecting only the celestial sphere, the entire world —
// terrain, buildings, 3D tiles, tracked objects, and the sky behind them — is
// re-rendered from a camera mirrored through the surface of the lake, and the
// water fragments sample that image.
//
// The three pieces:
//
//  1. THE PLANE. There is no water geometry in Sitrec to take a plane from —
//     water is a color test in the terrain shader. But the ELEVATION MAP
//     already contains a perfectly flat lake (Tahoe reads 1873.8 m HAE over
//     every sample), so the plane can be recovered by firing a grid of rays
//     into the view, histogramming the hit altitudes, and taking the biggest
//     bin. The centroid of the winning hits is used as the tangent point, which
//     puts the (necessarily flat) plane through the middle of the water the
//     user is actually looking at rather than under their feet.
//
//  2. THE MIRROR CAMERA. Standard planar reflection, following three's
//     Reflector: reflect the camera's position, forward and up through the
//     plane, rebuild with lookAt (which keeps the frame right-handed, so
//     triangle winding and face culling stay valid), then bend the near plane
//     onto the water plane with Lengyel's oblique projection so nothing below
//     the water is drawn into the reflection. Terrain east of Tahoe sits ~500 m
//     BELOW lake level, so that clip is doing real work, not guarding a
//     hypothetical.
//
//  3. THE LOOKUP. Because the mirror camera is the reflection of the real one,
//     the ray it casts through a point ON the plane continues along exactly the
//     ray the real camera's view reflects into. So a water fragment only has to
//     ask "where did the mirror camera put this point?" — one matrix multiply,
//     no search. Ripples then displace the lookup by walking along the
//     PERTURBED reflected ray and projecting that instead; see the shader.
//
// Known-wrong by construction: a plane is flat and the lake is not. See
// planeCurvatureErrorDeg() for the size of that.

import {
    HalfFloatType,
    LinearFilter,
    LinearMipmapLinearFilter,
    LinearSRGBColorSpace,
    Matrix4,
    PerspectiveCamera,
    RGBAFormat,
    Vector3,
    Vector4,
    WebGLRenderTarget,
} from "three";
import {GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene} from "./LocalFrame";
import {Globals, NodeMan} from "./Globals";
import {altitudeHAE, getLocalUpVector} from "./SphericalMath";
import {raycastGroundElevationFast} from "./raycastGround";
import {sharedUniforms} from "./js/map33/material/SharedUniforms";

// Ray grid used to find the water. Normalised device coordinates, so these are
// independent of FOV: the columns spread across the frame, the rows are biased
// BELOW centre because that is where water is when you are standing next to it.
const PROBE_COLS = [-0.8, -0.4, 0.0, 0.4, 0.8];
const PROBE_ROWS = [-0.9, -0.65, -0.4, -0.15, 0.1];

// Altitude histogram bin. A lake in the elevation map is flat to well under a
// centimetre, so this only has to be wide enough to absorb the marcher's own
// interpolation error, and narrow enough that a gentle hillside does not pile
// up into one bin. Terrain sloping at 5% crosses 0.25 m in 5 m of ground.
const PLANE_BIN_M = 0.25;

// Below this many probe hits in the winning bin, assume there is no flat
// surface in view and leave the mirror off rather than reflecting in a hillside.
const PLANE_MIN_HITS = 3;

// Re-detect the plane when the camera moves this far. The plane itself is a
// property of the lake, not the camera — but WHICH flat surface is in view is
// not, so this is a "have we probably swung round to a different body of water"
// test, not a precision one.
const PLANE_RECHECK_M = 25;

export class CWaterPlanarMirror {

    // node is the owning CNodeWaterReflection, read for the user's settings.
    constructor(node) {
        this.node = node;
        // One render target per renderer: each CNodeView3D owns its own
        // WebGLRenderer and a render target belongs to exactly one GL context.
        this.targets = new Map();
        this.camera = new PerspectiveCamera();
        this.textureMatrix = new Matrix4();
        // Nearby origin the texture matrix is expressed relative to — see
        // setupCamera() for why a float32 shader cannot use raw ECEF here.
        this.origin = new Vector3();

        this.plane = null;          // {point: Vector3, normal: Vector3, altitude}
        this._planeKey = null;

        // Scratch, to keep a per-frame render pass allocation-free.
        this._v = [];
        for (let i = 0; i < 12; i++) this._v.push(new Vector3());
        this._clipPlane = new Vector4();
        this._q = new Vector4();
        this._m = new Matrix4();
    }

    dispose() {
        for (const {target} of this.targets.values()) target.dispose();
        this.targets.clear();
        this.plane = null;
        this._planeKey = null;
    }

    // ---------------------------------------------------------------- plane

    // Fire PROBE_COLS x PROBE_ROWS rays through the view at the elevation map
    // and return the flattest, most-hit altitude. Rays are built from the camera
    // basis rather than by unprojecting NDC: at ECEF magnitudes (~6.4e6 m) the
    // near plane is 0.1 m away, so unproject() would build the direction as the
    // difference of two nearly-equal huge numbers.
    detectPlane(view) {
        const node = this.node;
        const camera = view.camera;
        const camPos = camera.position;

        // Manual override: the user has told us the water level, so the only
        // thing left to choose is where to put the tangent point — straight
        // below the camera, which is the best place when we know nothing else.
        if (!node.mirrorAutoLevel) {
            const up = getLocalUpVector(camPos);
            const drop = altitudeHAE(camPos) - node.mirrorLevel;
            const point = camPos.clone().addScaledVector(up, -drop);
            this.plane = {
                point,
                normal: getLocalUpVector(point),
                altitude: node.mirrorLevel,
                hits: 0,
            };
            return this.plane;
        }

        // Cheap "are we still looking at the same thing" cache. Rotation is
        // included because turning around can bring a different lake into view.
        //
        // And so is the elevation revision, because the probes march the
        // ELEVATION MAP and that map changes underneath us. A sitch that opens
        // looking at the sea detects its plane while a dozen coarse tiles are
        // all that exist, lands metres above sea level — 18.5 m instead of
        // −36.0 m at Santa Monica, measured — and, with the camera stationary,
        // keeps that answer for as long as the user leaves the view alone. The
        // mirror could survive it (a wrong level mostly shifts the reflection);
        // the 3D-tile water cannot, because the plane is what tells it how high
        // the sea is, so a stale plane means no water at all.
        const terrainNode = NodeMan.get("TerrainModel", false);
        const e = camera.matrixWorld.elements;
        const key = [
            Math.round(camPos.x / PLANE_RECHECK_M),
            Math.round(camPos.y / PLANE_RECHECK_M),
            Math.round(camPos.z / PLANE_RECHECK_M),
            e[8].toFixed(3), e[9].toFixed(3), e[10].toFixed(3),
            camera.fov.toFixed(3),
            terrainNode?.elevationRevision ?? 0,
        ].join(",");
        if (key === this._planeKey) return this.plane;
        this._planeKey = key;

        const tanHalf = Math.tan(camera.fov * Math.PI / 360);
        const aspect = camera.aspect || 1;
        const right = this._v[0].set(e[0], e[1], e[2]).normalize();
        const upCam = this._v[1].set(e[4], e[5], e[6]).normalize();
        const fwd = this._v[2].set(-e[8], -e[9], -e[10]).normalize();
        const dir = this._v[3];

        // Bin key -> {count, sum}. A plain object keyed by the rounded altitude
        // is fine for 25 probes.
        const bins = new Map();
        let best = null;

        for (const nx of PROBE_COLS) {
            for (const ny of PROBE_ROWS) {
                dir.copy(fwd)
                    .addScaledVector(right, nx * tanHalf * aspect)
                    .addScaledVector(upCam, ny * tanHalf)
                    .normalize();

                const hit = raycastGroundElevationFast(camPos, dir, 200000);
                if (hit === null) continue;

                const alt = altitudeHAE(hit);
                const bin = Math.round(alt / PLANE_BIN_M);
                let entry = bins.get(bin);
                if (entry === undefined) {
                    entry = {count: 0, sum: new Vector3(), alt: 0};
                    bins.set(bin, entry);
                }
                entry.count++;
                entry.sum.add(hit);
                entry.alt += alt;

                // Most hits wins; on a tie take the LOWER surface, because
                // water sits at the bottom of whatever basin it is in.
                if (best === null || entry.count > best.count
                    || (entry.count === best.count && bin < best.bin)) {
                    best = {bin, count: entry.count, entry};
                }
            }
        }

        if (best === null || best.count < PLANE_MIN_HITS) {
            this.plane = null;
            return null;
        }

        // Tangent point = centroid of the probe hits that agreed. That is the
        // middle of the visible water, which is where a single flat plane
        // approximates a curved lake best.
        const point = best.entry.sum.clone().divideScalar(best.count);
        this.plane = {
            point,
            normal: getLocalUpVector(point),
            altitude: best.entry.alt / best.count,
            hits: best.count,
        };
        return this.plane;
    }

    // How far the true water surface has tilted away from the tangent plane,
    // in degrees, at a given ground distance from the tangent point. The
    // reflected ray is wrong by TWICE this. Diagnostic only — the shader does
    // not correct for it, it just reports honestly in the GUI.
    static planeCurvatureErrorDeg(distanceM) {
        const R = Globals.equatorRadius || 6378137;
        return (distanceM / R) * 180 / Math.PI;
    }

    // --------------------------------------------------------------- target

    getTarget(view) {
        const renderer = view.renderer;
        const key = renderer.domElement;
        const scale = this.node.mirrorScale;
        const w = Math.max(1, Math.floor((view.lastRenderTargetWidth || view.widthPx) * scale));
        const h = Math.max(1, Math.floor((view.lastRenderTargetHeight || view.heightPx) * scale));

        let entry = this.targets.get(key);
        if (entry === undefined) {
            // HalfFloat and linear, matching the view's own render targets: the
            // terrain shader writes linear radiance and the reflection is added
            // to linear radiance, so a byte target would clip the sky and crush
            // the Moon to the same value as a bright star.
            const target = new WebGLRenderTarget(w, h, {
                format: RGBAFormat,
                type: HalfFloatType,
                colorSpace: LinearSRGBColorSpace,
                // Linear filtering, because the ripple lookup lands between
                // texels by design.
                //
                // Mipmaps are generated for the OCEAN method and only for it.
                // The mirror method resamples at roughly 1:1 and minification
                // would smear its shoreline, so it keeps the plain linear filter
                // via the minFilter swap in render(). The ocean method needs the
                // chain because its reflection is not a point lookup at all: it
                // is an integral over a lobe tens of degrees wide, and the mip
                // level is how that lobe's width gets applied.
                minFilter: LinearFilter,
                magFilter: LinearFilter,
                // No MSAA — every edge in here is about to be displaced by a
                // wave and attenuated by Fresnel.
                samples: 0,
            });
            entry = {target, w, h};
            this.targets.set(key, entry);
        } else if (entry.w !== w || entry.h !== h) {
            entry.target.setSize(w, h);
            entry.w = w;
            entry.h = h;
        }

        // Mipmaps only for the ocean method. Three.js regenerates the chain by
        // itself at the end of every render into this target, but only when the
        // minification filter actually asks for mipmaps — so switching the filter
        // is what switches the feature on. Reallocating the texture to change a
        // filter is not cheap, hence the guard: this fires on a method change and
        // never per frame.
        const wantsMipmaps = this.node.mode === "ocean";
        const texture = entry.target.texture;
        if (texture.generateMipmaps !== wantsMipmaps) {
            texture.generateMipmaps = wantsMipmaps;
            texture.minFilter = wantsMipmaps ? LinearMipmapLinearFilter : LinearFilter;
            texture.needsUpdate = true;
        }
        return entry;
    }

    // --------------------------------------------------------------- camera

    // Build the mirrored camera and bend its near plane onto the water.
    // Returns false if the camera is under the water, where a reflection is
    // meaningless.
    setupCamera(view, plane) {
        const src = view.camera;
        const cam = this.camera;
        const n = plane.normal;
        const p0 = plane.point;

        // Sitrec fakes an orthographic projection by patching the projection
        // matrix of a camera that still reports isPerspectiveCamera. The
        // oblique-clip derivation below is perspective-specific, and an ortho
        // camera has no eye point to mirror in the first place.
        if (src.__sitrecOrthoMatrixActive) return false;

        const height = this._v[4].copy(src.position).sub(p0).dot(n);
        if (height <= 0.01) return false;

        const e = src.matrixWorld.elements;

        // Mirror the eye point, a point one metre ahead of it, and the up
        // vector. Rebuilding with lookAt from the mirrored forward/up (rather
        // than multiplying the camera matrix by the reflection matrix) keeps
        // the basis right-handed: a reflection matrix has determinant -1, which
        // would reverse every triangle's winding and make three cull front
        // faces instead of back ones. The cost is that the resulting image is
        // handed differently from the real view — which is exactly why the
        // lookup uses the texture matrix below rather than screen coordinates.
        const mirrorPoint = (out, p) => {
            const d = this._v[5].copy(p).sub(p0).dot(n);
            return out.copy(p).addScaledVector(n, -2 * d);
        };
        const mirrorVector = (out, v) => out.copy(v).addScaledVector(n, -2 * v.dot(n));

        const target = this._v[6].set(-e[8], -e[9], -e[10]).normalize().add(src.position);

        mirrorPoint(cam.position, src.position);
        mirrorVector(cam.up, this._v[7].set(e[4], e[5], e[6]).normalize());
        cam.lookAt(mirrorPoint(this._v[8], target));

        // Same near/far as the real camera on purpose. The terrain shader's
        // logarithmic depth comes from the SHARED nearPlane/farPlane uniforms
        // while three's built-in materials derive theirs from camera.far — the
        // two mappings only agree, and terrain only sorts correctly against
        // buildings, while the camera matches those uniforms.
        cam.near = src.near;
        cam.far = src.far;
        cam.layers.mask = src.layers.mask;
        // fov/aspect are carried as PROPERTIES because the sky gradient reads
        // them directly; they are already the effective values, since
        // matchVideoAspect assigns them on the camera itself.
        cam.fov = src.fov;
        cam.aspect = src.aspect;

        // COPY the projection rather than rebuilding it from fov/aspect.
        // By the time push() runs, renderTargetAndEffects has patched the look
        // camera's projection matrix with whatever combination of FOV override,
        // matchVideoAspect, video pan (an off-centre frustum, elements[8]/[9])
        // and Y-compress (elements[5] divided by yCompress) is active.
        // updateProjectionMatrix() would rebuild a plain symmetric frustum and
        // throw all of that away, and the reflection would be registered
        // against a different projection from the view it sits in — visibly
        // offset from the shoreline. Copying also resets last frame's oblique
        // clip, which is why nothing has to undo it.
        cam.projectionMatrix.copy(src.projectionMatrix);
        cam.projectionMatrixInverse.copy(src.projectionMatrixInverse);
        cam.updateMatrixWorld(true);

        // Texture matrix: NDC -> [0,1], from the UNMODIFIED projection. Built
        // before the oblique hack below because that hack rewrites the z row,
        // and although the shader only uses xy/w, there is no reason to carry a
        // meaningless z through it.
        //
        // The trailing translation is what makes this usable from a float32
        // shader. Without it the matrix carries an ECEF-sized translation
        // (~6.4e6 m) that has to cancel against an ECEF-sized vWorldPosition;
        // float32 holds ~7 digits, so both terms are quantised to ~0.4 m and
        // the cancellation leaves metres of error on a lookup that has to be
        // pixel-accurate. Folding a nearby origin in here — on the CPU, in
        // doubles — means the shader multiplies only small, camera-relative
        // offsets, and the residual error is just the 0.4 m already inherent
        // in vWorldPosition itself. The origin is the tangent point, which is
        // in the middle of the water being looked at.
        this.origin.copy(plane.point);
        this.textureMatrix.set(
            0.5, 0.0, 0.0, 0.5,
            0.0, 0.5, 0.0, 0.5,
            0.0, 0.0, 0.5, 0.5,
            0.0, 0.0, 0.0, 1.0,
        );
        this.textureMatrix.multiply(cam.projectionMatrix);
        this.textureMatrix.multiply(cam.matrixWorldInverse);
        this.textureMatrix.multiply(
            this._m.makeTranslation(this.origin.x, this.origin.y, this.origin.z));

        // NOTE: the oblique clip is deliberately NOT applied here. It is
        // derived from the plane's position in VIEW space, and the sky passes
        // render this same camera from the origin — 6.4 million metres away —
        // where that clip plane means nothing and would slice the sky in half.
        // render() applies it after the sky, and the projection copy above
        // restores a clean matrix each frame.

        return true;
    }

    // Lengyel's oblique near-plane clipping (terathon.com/code/oblique.html),
    // as used by three's Reflector. Replaces the third row of the projection
    // matrix so the near plane lies ON the water plane, which culls everything
    // below the water at the clip stage — cheaper and more complete than a
    // fragment discard, and it needs no shader changes.
    //
    // Safe here despite the unusual depth setup: it rewrites only the z row,
    // and BOTH depth paths in Sitrec (three's logarithmicDepthBuffer and the
    // terrain shader's own gl_FragDepthEXT) compute depth from clip-space w,
    // which the z row does not touch. So this is purely a geometric cull and
    // cannot disturb depth ordering.
    // Returns false if the geometry is degenerate and the projection was left
    // alone — see the guard at the end.
    applyObliqueClip(cam, plane) {
        const bias = this.node.mirrorClipBias;
        // Push the plane up by the bias so the lake surface itself — which is
        // exactly coplanar — falls on the clipped side instead of z-fighting
        // its own reflection.
        const n = plane.normal;
        const p = this._v[9].copy(plane.point).addScaledVector(n, bias);

        // Plane in VIEW space: transform the normal by the inverse-transpose
        // (== the rotation part of the view matrix for a rigid transform) and
        // re-derive the constant from a transformed point.
        const view = cam.matrixWorldInverse;
        const nv = this._v[10].copy(n).transformDirection(view);
        const pv = this._v[11].copy(p).applyMatrix4(view);
        const clipPlane = this._clipPlane.set(nv.x, nv.y, nv.z, -nv.dot(pv));

        const P = cam.projectionMatrix;
        const q = this._q;
        q.x = (Math.sign(clipPlane.x) + P.elements[8]) / P.elements[0];
        q.y = (Math.sign(clipPlane.y) + P.elements[9]) / P.elements[5];
        q.z = -1.0;
        q.w = (1.0 + P.elements[10]) / P.elements[14];

        // The scale factor blows up as the plane approaches the corner
        // direction q — a nearly edge-on water plane at a grazing view. Leave
        // the projection untouched rather than write infinities into it: an
        // unclipped reflection for one frame is a visual glitch, a NaN
        // projection matrix silently blanks the whole view.
        const denom = clipPlane.dot(q);
        if (!isFinite(denom) || Math.abs(denom) < 1e-9) return false;

        clipPlane.multiplyScalar(2.0 / denom);
        if (!isFinite(clipPlane.x) || !isFinite(clipPlane.y)
            || !isFinite(clipPlane.z) || !isFinite(clipPlane.w)) return false;

        P.elements[2] = clipPlane.x;
        P.elements[6] = clipPlane.y;
        P.elements[10] = clipPlane.z + 1.0;
        P.elements[14] = clipPlane.w;
        // three caches the inverse for unproject/raycasting; keep them in step.
        cam.projectionMatrixInverse.copy(P).invert();
        return true;
    }

    // ---------------------------------------------------------------- render

    // Render the mirrored world into the target. Returns the texture, or null.
    // Called from CNodeWaterReflection.push(), i.e. INSIDE the look view's
    // render, with the view's own render target already bound — so everything
    // touched here is saved and restored.
    render(view, skyOpacity, skyColor) {
        const plane = this.detectPlane(view);
        if (plane === null) return null;
        if (!this.setupCamera(view, plane)) return null;

        const renderer = view.renderer;
        const {target} = this.getTarget(view);
        const cam = this.camera;

        const savedTarget = renderer.getRenderTarget();
        const savedAutoClear = renderer.autoClear;
        const savedShadowAuto = renderer.shadowMap.autoUpdate;
        const savedQuadMaterial = view.fullscreenQuad.material;

        // The water shader is about to read waterMirrorMap; if it were live
        // during this pass the lake would sample the previous frame's mirror
        // and feed itself. Both gates off means the water renders as plain map
        // color inside the reflection, which is what you want to see anyway.
        const savedMirrorGate = sharedUniforms.waterMirror.value;
        const savedOceanGate = sharedUniforms.waterOcean.value;
        const savedReflectionGate = sharedUniforms.waterReflection.value;
        sharedUniforms.waterMirror.value = 0.0;
        sharedUniforms.waterOcean.value = 0.0;
        sharedUniforms.waterReflection.value = 0.0;

        // Reuse the shadow maps the main pass already built. Letting three
        // rebuild them from the mirrored camera would both cost a full extra
        // shadow pass and leave the main render using maps fitted to the wrong
        // frustum.
        renderer.shadowMap.autoUpdate = false;

        try {
            renderer.setRenderTarget(target);
            renderer.autoClear = false;
            renderer.setClearColor(0x000000, 1);
            renderer.clear(true, true, true);

            // --- sky, mirroring CNodeView3D.renderSky()'s order exactly ---
            if (view.canDisplayNightSky && GlobalNightSkyScene !== undefined) {

                // The celestial sphere is drawn from the origin in every view,
                // so only the mirrored ORIENTATION matters here.
                const camPos = this._v[0].copy(cam.position);
                const renderAtOrigin = (scene) => {
                    cam.position.set(0, 0, 0);
                    cam.updateMatrixWorld(true);
                    renderer.render(scene, cam);
                    renderer.clearDepth();
                    cam.position.copy(camPos);
                    cam.updateMatrixWorld(true);
                };

                if (skyOpacity < 1) {
                    renderAtOrigin(GlobalNightSkyScene);
                }

                if (skyOpacity > 0) {
                    // Ask the view for the sky AS THIS CAMERA SEES IT. The
                    // gradient is a screen-space quad built from the camera
                    // basis, so it has to be told which camera; view.camera is
                    // a getter onto the camera node and cannot be swapped.
                    const useGradient = view.effectiveSkyGradient;
                    const skyMat = useGradient ? view._ensureSkyGradientMaterial() : view.skyFlatMaterial;
                    if (useGradient) {
                        view.populateAtmosphereRayUniforms(skyMat.uniforms, {camera: cam});
                        skyMat.uniforms.opacity.value = skyOpacity;
                    } else {
                        view.updateSkyUniforms(skyColor, skyOpacity);
                    }

                    view.fullscreenQuad.material = skyMat;
                    renderer.render(view.fullscreenQuadScene, view.fullscreenQuadCamera);
                    renderer.clearDepth();
                }

                if (GlobalSunSkyScene !== undefined) {
                    renderAtOrigin(GlobalSunSkyScene);
                }
            }

            // --- the world ---
            // Now that the sky is drawn, bend the near plane onto the water so
            // nothing underneath it reaches the reflection.
            if (this.node.mirrorClip) this.applyObliqueClip(cam, plane);
            renderer.render(GlobalScene, cam);
        } finally {
            view.fullscreenQuad.material = savedQuadMaterial;
            renderer.shadowMap.autoUpdate = savedShadowAuto;
            renderer.autoClear = savedAutoClear;
            renderer.setRenderTarget(savedTarget);
            sharedUniforms.waterMirror.value = savedMirrorGate;
            sharedUniforms.waterOcean.value = savedOceanGate;
            sharedUniforms.waterReflection.value = savedReflectionGate;
        }

        return target.texture;
    }
}
