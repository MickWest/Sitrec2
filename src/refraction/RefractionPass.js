import {Color, DataTexture, DepthTexture, FloatType, LinearFilter, Matrix4, NearestFilter,
    RGBAFormat, ShaderMaterial, UnsignedIntType, Vector2, Vector3, WebGLRenderTarget} from "three";
import {Globals, setRenderOne, Sit} from "../Globals";
import {zenithECEFFromPosition} from "../atmosphere/refraction";
import {gaussianRadius} from "../atmosphere/terrestrialRefraction";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {isFisheyeCamera} from "../FisheyeProjection";
import {clamp} from "./RefractionPhysics";

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
`;

const fragmentShader = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse, tDepth, tRays, tSky;
uniform mat4 projection, inverseProjection;
uniform vec3 zenith, fogColor;
uniform vec2 angles, tableSize, resolution;
uniform float maxDistance, cameraFar, cameraNear, logDepth, observerHeight, earthRadius;
uniform float visibility, night, eyeLevel, horizon;

vec3 directionAt(vec2 uv) {
    // Use the middle of the clip interval. With Sitrec's astronomical far
    // planes, unprojecting z=1 makes homogeneous w round to zero on the GPU.
    vec4 p = inverseProjection * vec4(uv * 2. - 1., 0., 1.);
    return normalize(p.xyz);
}
float horizontalDistanceAt(vec2 uv) {
    float z = texture2D(tDepth, uv).r;
    if (z >= 0.9999999) return 1.e20;
    float viewZ = logDepth > 0.5 ? exp2(z * log2(cameraFar + 1.)) - 1.
        : cameraNear * cameraFar / (cameraFar - z * (cameraFar - cameraNear));
    vec3 p = (inverseProjection * vec4(uv * 2. - 1., 0., 1.)).xyz;
    float vertical = dot(p, zenith);
    return viewZ * sqrt(max(0., dot(p, p) - vertical * vertical)) / max(1.e-8, -p.z);
}
vec4 rayAt(float angle, float distance) {
    vec2 p = vec2(sqrt(clamp(distance / maxDistance, 0., 1.)),
        clamp((angle - angles.x) / (angles.y - angles.x), 0., 1.));
    return texture2D(tRays, (p * (tableSize - 1.) + 0.5) / tableSize);
}
vec2 sourceAt(vec4 base, vec4 up, float offset) {
    vec4 clip = base + up * offset;
    return clip.xy / max(1.e-6, clip.w) * 0.5 + 0.5;
}
bool inside(vec2 p) { return all(greaterThanEqual(p, vec2(0.))) && all(lessThanEqual(p, vec2(1.))); }
void main() {
    vec3 dir = directionAt(vUv);
    float sine = clamp(dot(dir, zenith), -0.999999, 0.999999);
    float angle = asin(sine), cosine = sqrt(1. - sine * sine);
    vec3 horizontal = (dir - zenith * sine) / cosine;
    float tangent = sine / cosine;
    vec4 base = projection * vec4(horizontal + zenith * tangent, 0.);
    vec4 up = projection * vec4(zenith, 0.);
    vec2 source = vUv;
    float sceneDistance = horizontalDistanceAt(source);
    float distance = min(maxDistance, sceneDistance);
    // The third table channel is the distance at which this ray first hits the
    // spherical surface. Never continue a light path through the ground.
    float stopDistance = rayAt(angle, 0.).b;
    distance = min(distance, stopDistance);
    // Solve finite geometry using endpoint displacement only. The outgoing
    // direction is for the sky, not a position along the ray: alternating the
    // two at a depth discontinuity duplicates the skyline.
    bool hit = false;
    bool sawSky = false;
    bool sawOutside = false, missingSurface = false;
    vec2 closestSource = source;
    float closestError = 1.e20, closestDistance = distance;
    for (int i = 0; i < 8; i++) {
        vec4 ray = rayAt(angle, distance);
        source = sourceAt(base, up, ray.r);
        if (!inside(source)) {
            sawOutside = true;
            if (i == 0 && sceneDistance < 1.e19) missingSurface = true;
            // A far endpoint can leave the frame even though this ray hits a
            // visible surface sooner (including a folded mirage image).
            distance *= 0.5;
            continue;
        }
        sceneDistance = horizontalDistanceAt(source);
        float next = min(stopDistance, min(maxDistance, sceneDistance));
        vec2 resolved = sourceAt(base, up, rayAt(angle, next).r);
        float error = length((resolved - source) * resolution);
        sawSky = sawSky || sceneDistance > 1.e19;
        if (sceneDistance < 1.e19 && error < closestError) {
            closestSource = source;
            closestError = error;
            closestDistance = distance;
        }
        // Require a finite surface and a consistent subpixel mapping. An
        // oscillating terrain/sky lookup is not an intersection, regardless
        // of which side the last iteration happened to land on.
        if (sceneDistance < 1.e19 && error < 0.25) {
            hit = true;
            break;
        }
        if (sceneDistance > 1.e19 && next == distance) break;
        distance = next;
    }
    // At an edge between two finite surfaces, the intervening geometry may
    // be occluded in the source depth image. Keep the closest finite mapping
    // rather than punching a sky-coloured hole through opaque terrain.
    if (!hit && !sawSky && !sawOutside && closestError < 1.e19) {
        hit = true;
        source = closestSource;
        distance = closestDistance;
    }
    vec4 color;
    if (hit) {
        color = texture2D(tDiffuse, source);
    } else if (missingSurface) {
        // Missing offscreen geometry is left undistorted, not edge-stretched.
        color = texture2D(tDiffuse, vUv);
    } else {
        distance = min(stopDistance, maxDistance);
        vec4 ray = rayAt(angle, distance);
        source = sourceAt(base, up, stopDistance >= maxDistance ? ray.g : ray.r);
        // This direction can be hidden behind terrain in the straight view.
        // Sample the sky saved before geometry was drawn, never that terrain.
        color = texture2D(tSky, inside(source) ? source : vUv);
    }
    if (visibility > 0.) color.rgb = mix(fogColor, color.rgb, exp(-3.912 * distance / (visibility * 1000.)));
    color.rgb *= mix(1., 0.08, night);
    float pixelAngle = max(1.e-7, fwidth(angle));
    if (eyeLevel > 0.5 && abs(angle) < pixelAngle) color.rgb = vec3(0.1, 0.9, 0.75);
    float dip = earthRadius > 0. ? -acos(earthRadius / (earthRadius + max(0., observerHeight))) : 0.;
    if (horizon > 0.5 && abs(angle - dip) < pixelAngle) color.rgb = vec3(1., 0.6, 0.15);
    gl_FragColor = color;
}
`;

// Each worker has one job in flight and one replaceable pending request. A
// small interactive table updates during dragging; the full table refines it
// on release without blocking previews behind an expensive earlier job.
export class RefractionPass {
    constructor(tool) {
        this.tool = tool;
        this.worker = this.createWorker();
        this.sequence = 0;
        this.jobs = 0;
        this.previewJobs = 0;
        this.zenith = new Vector3();
        this.position = new Vector3();
        this.inverseWorld = new Matrix4();
        this.direction = new Vector3();
        this.material = new ShaderMaterial({vertexShader, fragmentShader, depthTest: false, depthWrite: false,
            uniforms: {
                tDiffuse: {value: null}, tDepth: {value: null}, tRays: {value: null}, tSky: {value: null},
                projection: {value: new Matrix4()}, inverseProjection: {value: new Matrix4()},
                zenith: {value: new Vector3()}, angles: {value: new Vector2()}, tableSize: {value: new Vector2()},
                resolution: {value: new Vector2()}, maxDistance: {value: 50000},
                cameraFar: {value: 1e9}, cameraNear: {value: 0.1}, logDepth: {value: 1},
                observerHeight: {value: 0}, earthRadius: {value: 6371000},
                fogColor: {value: new Color("#9aafbb")}, visibility: {value: 0}, night: {value: 0},
                eyeLevel: {value: 0}, horizon: {value: 0},
            }});
    }

    createWorker(preview = false) {
        const worker = new Worker(new URL("./RefractionWorker.js", import.meta.url));
        worker.onmessage = ({data}) => this.receive(data, preview);
        worker.onerror = event => this.fail(event.message || "Worker failed");
        worker.onmessageerror = () => this.fail("Could not read the ray table");
        return worker;
    }

    begin() {
        const camera = this.tool.view?.camera;
        if (!camera?.isPerspectiveCamera || isFisheyeCamera(camera)) return () => {};
        const sky = Sit.refractionEnabled, terrain = Sit.terrestrialRefraction;
        Sit.refractionEnabled = false;
        Sit.terrestrialRefraction = false;
        return () => { Sit.refractionEnabled = sky; Sit.terrestrialRefraction = terrain; };
    }

    attachDepth(target) {
        if (this.target === target && target.depthTexture === this.depth) return;
        this.detachDepth();
        this.target = target;
        this.previousDepth = target.depthTexture;
        target.dispose(); // Reallocate the framebuffer with a sampleable depth attachment.
        this.depth = new DepthTexture(target.width, target.height, UnsignedIntType);
        target.depthTexture = this.depth;
    }

    detachDepth() {
        if (!this.target) return;
        if (this.target.depthTexture === this.depth) {
            this.target.dispose();
            this.target.depthTexture = this.previousDepth;
        }
        this.depth?.dispose();
        this.target = null;
        this.depth = null;
    }

    capture(view) {
        const camera = view.camera, s = this.tool.settings;
        if (!camera.isPerspectiveCamera || isFisheyeCamera(camera)) {
            this.usable = false;
            this.tool.status("Select a perspective camera to render refraction.");
            return;
        }
        camera.updateMatrixWorld();
        const preview = !!this.tool.editing;
        const signature = [this.tool.opticalRevision, preview, this.target.width, this.target.height,
            Globals.equatorRadius, Globals.polarRadius, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
        if (this.cameraSignature?.every((value, i) => value === signature[i])) {
            this.usable = this.canUseTable();
            return;
        }
        this.cameraSignature = signature;
        this.validCamera = false;
        this.position.setFromMatrixPosition(camera.matrixWorld);
        this.inverseWorld.copy(camera.matrixWorld).invert();
        const a = Globals.equatorRadius, b = Globals.polarRadius;
        zenithECEFFromPosition(this.position, this.zenith, a, b);
        const lla = ECEFToLLAVD_radii(this.position);
        const height = lla.z - meanSeaLevelOffset(lla.x, lla.y);
        const radius = gaussianRadius(this.zenith.z, a, b);
        const u = this.material.uniforms;
        u.zenith.value.copy(this.zenith).transformDirection(this.inverseWorld);
        u.projection.value.copy(camera.projectionMatrix);
        u.inverseProjection.value.copy(camera.projectionMatrixInverse);
        u.cameraFar.value = camera.far;
        u.cameraNear.value = camera.near;
        u.logDepth.value = view.renderer.capabilities.logarithmicDepthBuffer ? 1 : 0;
        u.resolution.value.set(this.target.width, this.target.height);
        u.observerHeight.value = height;
        u.earthRadius.value = s.flat ? 0 : radius;
        let min = Infinity, max = -Infinity;
        for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
            this.direction.set(x, y, 0).applyMatrix4(camera.projectionMatrixInverse).normalize();
            const angle = Math.asin(clamp(this.direction.dot(u.zenith.value), -1, 1));
            min = Math.min(min, angle); max = Math.max(max, angle);
        }
        const span = Math.max(1e-5, max - min);
        this.visibleMin = min; this.visibleMax = max;
        // Pad and quantize the angular range so tiny camera jitter does not rebuild
        // an otherwise reusable table. Per-pixel projection still follows exactly.
        const quantum = 2 ** Math.floor(Math.log2(span / 8));
        min = Math.max(-1.45, Math.floor(min / quantum) * quantum - quantum);
        max = Math.min(1.45, Math.ceil(max / quantum) * quantum + quantum);
        if (max <= min || height < 0 || height > 120000) {
            this.usable = false;
            this.tool.status("Camera must be above the surface, below 120 km, and face the horizon.");
            return;
        }
        const rows = clamp(Math.ceil(this.target.height * s.resolution * (max - min) / span / 64) * 64,
            64, Math.min(4096, view.renderer.capabilities.maxTextureSize ?? 4096));
        const request = {settings: preview ? {...s, distanceSamples: Math.min(s.distanceSamples, 128)} : s,
            height: Math.round(height * 100) / 100, radius: Math.round(radius),
            minAngle: min, maxAngle: max, rows: preview ? Math.min(rows, 128) : rows};
        this.validCamera = true;
        this.geometryKey = JSON.stringify([request.height, request.radius, s.flat]);
        const key = JSON.stringify([this.tool.opticalRevision, request.height, request.radius, min, max, rows, preview]);
        this.wantedKey = key;
        if (key !== this.requestedKey) {
            this.requestedKey = key;
            this[preview ? "previewQueued" : "queued"] = {key,
                geometryKey: this.geometryKey, revision: this.tool.opticalRevision, request: structuredClone(request)};
            this[preview ? "queued" : "previewQueued"] = null;
            this.sendNext(preview);
        }
        this.usable = this.canUseTable();
        this.tool.updateObserver(this.position, this.zenith, camera, height);
    }

    canUseTable() {
        if (!this.validCamera || !this.texture) return false;
        if (this.tableKey === this.wantedKey) return true;
        // Keep the last optical result visible while its replacement is traced.
        // Reverting to straight rays on every profile edit causes a visible jerk.
        // Observer geometry and angular coverage must still match.
        const angles = this.material.uniforms.angles.value;
        return this.tableGeometryKey === this.geometryKey && this.visibleMin >= angles.x && this.visibleMax <= angles.y;
    }

    captureBackground(view, input) {
        if (!this.usable) return;
        // Only the enabled, ready pass pays for this copy. Keep the same scene
        // colour format; exposure and tone mapping still happen after refraction.
        if (!this.skyTarget || this.skyTarget.texture.type !== input.texture.type) {
            this.skyTarget?.dispose();
            this.skyTarget = new WebGLRenderTarget(input.width, input.height, {
                type: input.texture.type, format: input.texture.format,
                colorSpace: input.texture.colorSpace, depthBuffer: false,
                minFilter: LinearFilter, magFilter: LinearFilter,
            });
        }
        this.skyTarget.setSize(input.width, input.height);
        this.backgroundMaterial ??= new ShaderMaterial({vertexShader, depthTest: false, depthWrite: false,
            uniforms: {tDiffuse: {value: null}}, fragmentShader: /* glsl */`
                varying vec2 vUv;
                uniform sampler2D tDiffuse;
                void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
            `});
        this.backgroundMaterial.uniforms.tDiffuse.value = input.texture;
        const target = view.renderer.getRenderTarget(), material = view.fullscreenQuad.material;
        try {
            view.renderer.setRenderTarget(this.skyTarget);
            view.fullscreenQuad.material = this.backgroundMaterial;
            view.renderer.render(view.fullscreenQuad, view.fullscreenQuadCamera);
            this.material.uniforms.tSky.value = this.skyTarget.texture;
        } finally {
            view.fullscreenQuad.material = material;
            view.renderer.setRenderTarget(target);
        }
    }

    sendNext(preview = false) {
        const busy = preview ? "previewBusy" : "busy", queued = preview ? "previewQueued" : "queued";
        if (this[busy] || !this[queued] || this.disposed) return;
        const next = this[queued];
        this[queued] = null;
        this[busy] = {...next, id: ++this.sequence};
        let worker = this.worker;
        if (preview) {
            worker = this.previewWorker ??= this.createWorker(true);
            this.previewJobs++;
        } else this.jobs++;
        this.tool.status(preview ? "Live preview…" : "Tracing atmosphere…");
        worker.postMessage({id: this.sequence, request: next.request});
    }

    receive({id, result, error}, preview = false) {
        const busy = preview ? "previewBusy" : "busy", job = this[busy];
        if (this.disposed || id !== job?.id) return;
        this[busy] = null;
        if (error) { this.fail(error); return; }
        // A completed preview may be a move behind the pointer. Display it as
        // progress instead of starving the screen until the user stops moving.
        // Sequence ordering prevents a late reply from rolling the image back.
        const progressing = preview && (this.tool.editing || job.revision === this.tool.opticalRevision)
            && job.geometryKey === this.geometryKey
            && this.visibleMin >= result.minAngle && this.visibleMax <= result.maxAngle;
        if (id > (this.appliedSequence ?? 0) && (job.key === this.wantedKey || progressing)) {
            if (this.texture?.image.width !== result.width || this.texture?.image.height !== result.rows) {
                this.texture?.dispose();
                this.texture = new DataTexture(result.data, result.width, result.rows, RGBAFormat, FloatType);
            } else this.texture.image.data = result.data;
            const filter = this.tool.view.renderer.extensions.has("OES_texture_float_linear") ? LinearFilter : NearestFilter;
            this.texture.minFilter = this.texture.magFilter = filter;
            this.texture.needsUpdate = true;
            const u = this.material.uniforms;
            u.tRays.value = this.texture;
            u.angles.value.set(result.minAngle, result.maxAngle);
            u.tableSize.value.set(result.width, result.rows);
            u.maxDistance.value = result.distances[result.width - 1];
            this.appliedSequence = id;
            this.tableKey = job.key;
            this.tableGeometryKey = job.geometryKey;
            this.usable = this.canUseTable();
            this.tool.setResult(result);
            this.tool.status(`${preview ? "Live preview" : "Cached"} · ${result.rows} rays × ${result.width} distances · ${Math.round(result.milliseconds)} ms`);
            setRenderOne(true);
        }
        this.sendNext(preview);
    }

    render(view, input) {
        if (!this.usable || !this.texture) return input;
        const s = this.tool.settings, u = this.material.uniforms;
        u.tDiffuse.value = input.texture;
        u.tDepth.value = this.depth;
        u.visibility.value = s.visibilityEnabled ? s.visibility : 0;
        u.night.value = s.night ? 1 : 0;
        u.eyeLevel.value = s.showEyeLevel ? 1 : 0;
        u.horizon.value = s.showHorizon ? 1 : 0;
        const output = input === view.renderTargetA ? view.renderTargetB : view.renderTargetA;
        view.renderer.setRenderTarget(output);
        view.fullscreenQuad.material = this.material;
        view.renderer.render(view.fullscreenQuad, view.fullscreenQuadCamera);
        return output;
    }

    fail(message) {
        this.tool.settings.enabled = false;
        this.tool.status(`Refraction stopped: ${message}. Toggle Enable to retry.`);
        this.tool.sync();
    }

    dispose() {
        this.disposed = true;
        this.worker.terminate();
        this.previewWorker?.terminate();
        this.queued = this.busy = null;
        this.previewQueued = this.previewBusy = null;
        this.detachDepth();
        this.texture?.dispose();
        this.skyTarget?.dispose();
        this.backgroundMaterial?.dispose();
        this.material.dispose();
    }
}
