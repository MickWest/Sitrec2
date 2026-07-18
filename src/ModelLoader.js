import {FileManager} from "./Globals";
import {getFileExtension, m2f, stripURLSuffixPreservingHashParameters} from "./utils";
import {sharedUniforms} from "./js/map33/material/SharedUniforms";
import {DRACOLoader} from "three/addons/loaders/DRACOLoader.js";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {PLYLoader} from "three/addons/loaders/PLYLoader.js";
import {
    AddEquation,
    Box3,
    BufferAttribute,
    Color,
    CustomBlending,
    DoubleSide,
    Group,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Matrix3,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    NormalBlending,
    OneFactor,
    OneMinusSrcAlphaFactor,
    PlaneGeometry,
    Points,
    PointsMaterial,
    Quaternion,
    ShaderMaterial,
    Sphere,
    Vector3,
} from "three";

const SUPPORTED_MODEL_EXTENSIONS = Object.freeze(["glb", "ply"]);
const supportedModelExtensions = new Set(SUPPORTED_MODEL_EXTENSIONS);
const SH_C0 = 0.28209479177387814;

function coerceArrayBuffer(data, filename) {
    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    throw new Error(`Unsupported model data for "${filename}"`);
}

function getDisplayModelName(filename) {
    const cleanFilename = stripURLSuffixPreservingHashParameters(filename);
    return cleanFilename.replace(/\\/g, "/").split("/").pop() || cleanFilename;
}

const filenameParameterHandlers = Object.freeze({
    L: (parameters, value, units) => {
        const modelLengthFeet = parseFilenameModelLengthToFeet(value, units);
        if (modelLengthFeet !== null) {
            parameters.modelLength = modelLengthFeet;
        }
    },
});

function parseFilenameModelLengthToFeet(value, units) {
    const normalizedUnits = units?.toLowerCase() ?? "";

    switch (normalizedUnits) {
        case "":
        case "f":
        case "ft":
        case "feet":
            return value;

        case "m":
        case "meter":
        case "meters":
            return m2f(value);

        default:
            return null;
    }
}

export function extractModelFilenameParameters(filename) {
    const parameters = {};
    const displayName = getDisplayModelName(filename);

    for (const block of displayName.matchAll(/[~#]([^~#]+)[~#]/g)) {
        const blockText = block[1];
        for (const match of blockText.matchAll(/([A-Za-z])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([A-Za-z]+)?/g)) {
            const key = match[1].toUpperCase();
            const value = Number.parseFloat(match[2]);
            const units = match[3];
            if (!Number.isFinite(value)) {
                continue;
            }

            const handler = filenameParameterHandlers[key];
            if (handler) {
                handler(parameters, value, units);
            }
        }
    }

    return parameters;
}

function attachFilenameParameters(modelAsset, filename) {
    const filenameParameters = extractModelFilenameParameters(filename);
    modelAsset.filenameParameters = filenameParameters;
    modelAsset.scene.userData ??= {};
    modelAsset.scene.userData.sitrecFilenameParameters = filenameParameters;
    return modelAsset;
}

function createDRACOLoader() {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("./libs/draco/");
    return dracoLoader;
}

function createGLTFLoader() {
    const loader = new GLTFLoader();
    const dracoLoader = createDRACOLoader();
    loader.setDRACOLoader(dracoLoader);
    return loader;
}

function checkModelHierarchy(gltf, filename) {
    const issues = [];
    const meshesWithArmature = [];

    gltf.scene.traverse((node) => {
        if (!node.isMesh) {
            return;
        }

        let current = node;
        let hasArmature = false;
        const path = [];

        while (current.parent && current.parent !== gltf.scene) {
            current = current.parent;
            const nodeName = current.name || "unnamed";
            path.unshift(nodeName);

            if (nodeName.toLowerCase().includes("armature")) {
                hasArmature = true;
            }
        }

        if (hasArmature) {
            meshesWithArmature.push({
                name: node.name || "unnamed mesh",
                path,
            });
        }
    });

    if (meshesWithArmature.length > 0) {
        issues.push("Meshes parented to Armature detected. This can cause vertex distortion when positioned far from origin. Consider flattening the hierarchy in Blender by unparenting meshes from the Armature (Select mesh -> Option+P -> Clear Parent, then delete the Armature node).");
    }

    if (issues.length > 0) {
        const message = `⚠️ Model Hierarchy Warning: ${filename}\n\n${issues.join("\n\n")}\n\nThe model will still load, but may exhibit visual artifacts at large distances from origin.`;
        console.warn(message);
        alert(message);
    }
}

function isDroppedModelFile(file) {
    return !String(file).startsWith("data/models/");
}

function shouldNormalizeDroppedModelMaterial(file, material) {
    if (!isDroppedModelFile(file)) {
        return false;
    }

    if (!(material?.isMeshStandardMaterial || material?.isMeshPhysicalMaterial)) {
        return false;
    }

    if (material.userData?.gltfExtensions?.KHR_materials_unlit) {
        return false;
    }

    if (!material.map || material.envMap || material.metalnessMap) {
        return false;
    }

    return (material.metalness ?? 0) >= 0.95;
}

function normalizeDroppedModelMaterials(scene, file) {
    scene.traverse((child) => {
        if (!child.isMesh) {
            return;
        }

        const materialList = Array.isArray(child.material) ? child.material : [child.material];
        const normalizedMaterials = materialList.map((material) => {
            if (!shouldNormalizeDroppedModelMaterial(file, material)) {
                return material;
            }

            material.metalness = 0;
            material.needsUpdate = true;
            material.userData ??= {};
            material.userData.sitrecDroppedModelMaterialFix = "demetalized-for-ambient";
            return material;
        });

        child.material = Array.isArray(child.material) ? normalizedMaterials : normalizedMaterials[0];
    });
}

function ensureGLTFMeshNormals(scene) {
    scene.traverse((child) => {
        if (!child.isMesh) {
            return;
        }

        const geometry = child.geometry;
        if (!geometry?.getAttribute("position") || geometry.getAttribute("normal")) {
            return;
        }

        geometry.computeVertexNormals();
        geometry.normalizeNormals();
    });
}

function headerTextForPLY(data) {
    const buffer = coerceArrayBuffer(data, "PLY");
    const scanBytes = Math.min(buffer.byteLength, 65536);
    const headerProbe = new TextDecoder("utf-8").decode(buffer.slice(0, scanBytes));
    const headerMatch = headerProbe.match(/^([\s\S]*?end_header(?:\r\n|\r|\n))/i);
    return headerMatch ? headerMatch[1] : headerProbe;
}

function plyHasFaces(data) {
    const headerText = headerTextForPLY(data);
    const faceMatch = headerText.match(/element\s+face\s+(\d+)/i);
    return faceMatch ? Number(faceMatch[1]) > 0 : false;
}

function setPLYCustomPropertyMappings(loader) {
    loader.setCustomPropertyNameMapping({
        splatColorDc: ["f_dc_0", "f_dc_1", "f_dc_2"],
        splatScale: ["scale_0", "scale_1", "scale_2"],
        splatRotation: ["rot_0", "rot_1", "rot_2", "rot_3"],
        splatOpacity: ["opacity"],
    });
}

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function ensurePLYPointColors(geometry) {
    // Always prefer SH DC coefficients (splatColorDc) over PLYLoader's built-in
    // vertex colors. PLYLoader converts uint8 sRGB colors to linear via
    // Color.setRGB(..., SRGBColorSpace), producing quantized linear values.
    // SH DC coefficients are full-precision and match the trained gaussian splat.
    const splatColorDc = geometry.getAttribute("splatColorDc");
    if (splatColorDc) {
        const colors = new Float32Array(splatColorDc.count * 3);
        for (let i = 0; i < splatColorDc.count; i++) {
            const base = i * 3;
            colors[base] = clamp01(0.5 + SH_C0 * splatColorDc.array[base]);
            colors[base + 1] = clamp01(0.5 + SH_C0 * splatColorDc.array[base + 1]);
            colors[base + 2] = clamp01(0.5 + SH_C0 * splatColorDc.array[base + 2]);
        }

        const colorAttribute = new BufferAttribute(colors, 3);
        geometry.setAttribute("color", colorAttribute);
        return colorAttribute;
    }

    if (geometry.getAttribute("color")) {
        return geometry.getAttribute("color");
    }

    return null;
}

function ensurePLYPointOpacity(geometry) {
    const existing = geometry.getAttribute("splatOpacity");
    if (existing) {
        const normalized = new Float32Array(existing.count);
        for (let i = 0; i < existing.count; i++) {
            normalized[i] = clamp01(sigmoid(existing.array[i]));
        }
        const opacityAttribute = new BufferAttribute(normalized, 1);
        geometry.setAttribute("splatOpacity", opacityAttribute);
        return opacityAttribute;
    }

    const opacity = new Float32Array(geometry.getAttribute("position").count);
    opacity.fill(1);
    const opacityAttribute = new BufferAttribute(opacity, 1);
    geometry.setAttribute("splatOpacity", opacityAttribute);
    return opacityAttribute;
}

function ensurePLYPointSize(geometry) {
    const existing = geometry.getAttribute("splatSize");
    if (existing) {
        return existing;
    }

    const splatScale = geometry.getAttribute("splatScale");
    const sizes = new Float32Array(geometry.getAttribute("position").count);

    if (splatScale) {
        for (let i = 0; i < splatScale.count; i++) {
            const base = i * 3;
            const sx = Math.exp(splatScale.array[base]);
            const sy = Math.exp(splatScale.array[base + 1]);
            const sz = Math.exp(splatScale.array[base + 2]);
            sizes[i] = Math.max(sx, sy, sz) * 2.0;
        }
    } else {
        sizes.fill(1);
    }

    const sizeAttribute = new BufferAttribute(sizes, 1);
    geometry.setAttribute("splatSize", sizeAttribute);
    return sizeAttribute;
}

function createPLYPointCloudMaterial(geometry, filename) {
    const usesSplatAttributes = geometry.getAttribute("splatColorDc") !== undefined
        || geometry.getAttribute("splatScale") !== undefined
        || geometry.getAttribute("splatOpacity") !== undefined;
    const colorAttribute = ensurePLYPointColors(geometry);
    const opacityAttribute = ensurePLYPointOpacity(geometry);
    const sizeAttribute = ensurePLYPointSize(geometry);

    if (!usesSplatAttributes && !colorAttribute) {
        return new PointsMaterial({
            color: 0xbfbfbf,
            size: 2,
            sizeAttenuation: true,
        });
    }

    const fallbackColor = new Color(0xbfbfbf);
    const opaqueCutout = usesSplatAttributes;
    const vertexShader = `
        attribute float splatOpacity;
        attribute float splatSize;
        ${colorAttribute ? "attribute vec3 color;" : ""}

        uniform float viewportHeight;
        uniform float minPointSize;
        uniform float maxPointSize;
        uniform float sizeMultiplier;
        uniform vec3 fallbackColor;

        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;

        void main() {
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

            float modelScaleX = length(modelMatrix[0].xyz);
            float modelScaleY = length(modelMatrix[1].xyz);
            float modelScaleZ = length(modelMatrix[2].xyz);
            float modelScale = max(modelScaleX, max(modelScaleY, modelScaleZ));
            float worldSize = max(0.0001, splatSize * modelScale * sizeMultiplier);
            float projectedSize = worldSize * viewportHeight * projectionMatrix[1][1] / max(-mvPosition.z, 0.0001);

            gl_PointSize = clamp(projectedSize, minPointSize, maxPointSize);
            gl_Position = projectionMatrix * mvPosition;
            vDepth = gl_Position.w;

            vOpacity = splatOpacity;
            ${colorAttribute ? "vColor = color;" : "vColor = fallbackColor;"}
        }
    `;

    const fragmentShader = `
        uniform float nearPlane;
        uniform float farPlane;

        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;

        void main() {
            vec2 centered = gl_PointCoord * 2.0 - 1.0;
            float radiusSquared = dot(centered, centered);
            if (radiusSquared > 1.0) {
                discard;
            }

            // PLY vertex colors are in sRGB space; convert to linear for
            // consistent linear render target output.
            vec3 linearColor = sRGBTransferEOTF(vec4(vColor, 1.0)).rgb;
            ${opaqueCutout ? `
            if (vOpacity < 0.02) {
                discard;
            }
            gl_FragColor = vec4(linearColor, 1.0);
            ` : `
            float alpha = exp(-radiusSquared * 4.0) * vOpacity;
            if (alpha < 0.08) {
                discard;
            }
            gl_FragColor = vec4(linearColor, alpha);
            `}

            // Orthographic projection makes clip-space w (vDepth) a constant 1.0,
            // collapsing the log-depth formula to one value per fragment → z-fighting.
            // Use linear rasteriser depth there (three.js's non-perspective path).
            if (vDepth == 1.0) {
                gl_FragDepthEXT = gl_FragCoord.z;
            } else {
                float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                gl_FragDepthEXT = z * 0.5 + 0.5;
            }
        }
    `;

    const material = new ShaderMaterial({
        name: `${getDisplayModelName(filename)} PLY Point Cloud`,
        vertexShader,
        fragmentShader,
        uniforms: {
            viewportHeight: {value: 1080},
            minPointSize: {value: 2.0},
            maxPointSize: {value: usesSplatAttributes ? 96.0 : 24.0},
            sizeMultiplier: {value: usesSplatAttributes ? 1.5 : 1.0},
            fallbackColor: {value: fallbackColor},
            ...sharedUniforms,
        },
        transparent: !opaqueCutout,
        depthTest: true,
        depthWrite: true,
        blending: NormalBlending,
    });

    material.userData ??= {};
    material.userData.sitrecPLYPointCloud = true;
    material.userData.sitrecUsesSplatAttributes = usesSplatAttributes;
    material.userData.sitrecPointCount = opacityAttribute.count;
    sizeAttribute.needsUpdate = true;

    return material;
}

function isGaussianSplatPLY(geometry) {
    return geometry.getAttribute("splatScale") !== undefined
        && geometry.getAttribute("splatRotation") !== undefined;
}

function setGaussianSplatBounds(instancedGeometry, centers, scales, rotations, opacities) {
    const bounds = new Box3();
    const rotation = new Quaternion();
    const rotationMatrix = new Matrix4();
    const minPoint = new Vector3();
    const maxPoint = new Vector3();
    let hasVisibleSplats = false;

    // Box3.expandByObject() cannot derive per-instance bounds from our custom
    // InstancedBufferGeometry, so explicitly aggregate the oriented 3-sigma
    // ellipsoids here. Without this, the object falls back to the base quad's
    // 2x2x0 plane bounds and the displayed box/length are wildly wrong.
    for (let i = 0; i < opacities.length; i++) {
        if (opacities[i] <= 1 / 255) {
            continue;
        }

        const i3 = i * 3;
        const i4 = i * 4;
        const radiusX = scales[i3] * 3;
        const radiusY = scales[i3 + 1] * 3;
        const radiusZ = scales[i3 + 2] * 3;

        rotation.set(
            rotations[i4 + 1],
            rotations[i4 + 2],
            rotations[i4 + 3],
            rotations[i4],
        ).normalize();
        rotationMatrix.makeRotationFromQuaternion(rotation);
        const e = rotationMatrix.elements;

        const extentX = Math.hypot(e[0] * radiusX, e[4] * radiusY, e[8] * radiusZ);
        const extentY = Math.hypot(e[1] * radiusX, e[5] * radiusY, e[9] * radiusZ);
        const extentZ = Math.hypot(e[2] * radiusX, e[6] * radiusY, e[10] * radiusZ);

        minPoint.set(
            centers[i3] - extentX,
            centers[i3 + 1] - extentY,
            centers[i3 + 2] - extentZ,
        );
        maxPoint.set(
            centers[i3] + extentX,
            centers[i3 + 1] + extentY,
            centers[i3 + 2] + extentZ,
        );
        bounds.expandByPoint(minPoint);
        bounds.expandByPoint(maxPoint);
        hasVisibleSplats = true;
    }

    if (!hasVisibleSplats) {
        bounds.setFromArray(centers);
    }

    instancedGeometry.boundingBox = bounds;
    instancedGeometry.boundingSphere = bounds.getBoundingSphere(new Sphere());
}

function createGaussianSplatGeometry(geometry) {
    const posAttr = geometry.getAttribute("position");
    const splatCount = posAttr.count;

    const colorAttr = ensurePLYPointColors(geometry);
    const opacityAttr = ensurePLYPointOpacity(geometry);
    const scaleAttr = geometry.getAttribute("splatScale");
    const rotAttr = geometry.getAttribute("splatRotation");

    // Build per-instance typed arrays
    const centers = new Float32Array(posAttr.array);
    const colors = colorAttr
        ? new Float32Array(colorAttr.array)
        : new Float32Array(splatCount * 3).fill(0.75);
    const opacities = new Float32Array(opacityAttr.array);

    // Apply exp() to log-space scale values
    const scales = new Float32Array(splatCount * 3);
    for (let i = 0; i < splatCount; i++) {
        const b = i * 3;
        scales[b] = Math.exp(scaleAttr.array[b]);
        scales[b + 1] = Math.exp(scaleAttr.array[b + 1]);
        scales[b + 2] = Math.exp(scaleAttr.array[b + 2]);
    }

    const rotations = new Float32Array(rotAttr.array);

    // Base quad: 2×2 plane with vertices at (±1, ±1, 0)
    const baseQuad = new PlaneGeometry(2, 2);
    const instancedGeometry = new InstancedBufferGeometry();
    instancedGeometry.index = baseQuad.index;
    instancedGeometry.setAttribute("position", baseQuad.getAttribute("position"));

    instancedGeometry.setAttribute("splatCenter", new InstancedBufferAttribute(centers, 3));
    instancedGeometry.setAttribute("splatColor", new InstancedBufferAttribute(colors, 3));
    instancedGeometry.setAttribute("splatOpacity", new InstancedBufferAttribute(opacities, 1));
    instancedGeometry.setAttribute("splatScale", new InstancedBufferAttribute(scales, 3));
    instancedGeometry.setAttribute("splatRotation", new InstancedBufferAttribute(rotations, 4));
    instancedGeometry.instanceCount = splatCount;
    setGaussianSplatBounds(instancedGeometry, centers, scales, rotations, opacities);

    return instancedGeometry;
}

function createGaussianSplatMaterial(filename) {
    const vertexShader = /* glsl */ `
        attribute vec3 splatCenter;
        attribute vec3 splatColor;
        attribute float splatOpacity;
        attribute vec3 splatScale;
        attribute vec4 splatRotation;

        uniform float viewportWidth;
        uniform float viewportHeight;
        uniform vec3 viewOrigin;
        uniform mat3 modelViewLinear;

        varying vec2 vPosition;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;

        mat3 quatToMat3(vec4 q) {
            vec4 nq = normalize(q);
            float qw = nq.x, qx = nq.y, qy = nq.z, qz = nq.w;
            float x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
            float xx = qx * x2, xy = qx * y2, xz = qx * z2;
            float yy = qy * y2, yz = qy * z2, zz = qz * z2;
            float wx = qw * x2, wy = qw * y2, wz = qw * z2;
            return mat3(
                1.0 - (yy + zz), xy + wz, xz - wy,
                xy - wz, 1.0 - (xx + zz), yz + wx,
                xz + wy, yz - wx, 1.0 - (xx + yy)
            );
        }

        void main() {
            // Keep the splat center camera-relative in shader code so we avoid
            // losing precision when models are positioned in ECEF-scale coordinates.
            vec4 viewCenter = vec4(viewOrigin + modelViewLinear * splatCenter, 1.0);

            if (viewCenter.z > 0.0) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                vOpacity = 0.0;
                return;
            }

            mat3 R = quatToMat3(splatRotation);
            mat3 S = mat3(
                splatScale.x, 0.0, 0.0,
                0.0, splatScale.y, 0.0,
                0.0, 0.0, splatScale.z
            );
            mat3 M_view = modelViewLinear * R * S;

            float tx = viewCenter.x;
            float ty = viewCenter.y;
            float tz = viewCenter.z;
            float tz2 = tz * tz;
            float focalX = projectionMatrix[0][0] * viewportWidth * 0.5;
            float focalY = projectionMatrix[1][1] * viewportHeight * 0.5;

            float j00 = focalX / tz;
            float j02 = -focalX * tx / tz2;
            float j11 = focalY / tz;
            float j12 = -focalY * ty / tz2;

            vec3 T0 = vec3(
                j00 * M_view[0][0] + j02 * M_view[0][2],
                j00 * M_view[1][0] + j02 * M_view[1][2],
                j00 * M_view[2][0] + j02 * M_view[2][2]
            );
            vec3 T1 = vec3(
                j11 * M_view[0][1] + j12 * M_view[0][2],
                j11 * M_view[1][1] + j12 * M_view[1][2],
                j11 * M_view[2][1] + j12 * M_view[2][2]
            );

            float cov2d_00 = dot(T0, T0) + 0.3;
            float cov2d_01 = dot(T0, T1);
            float cov2d_11 = dot(T1, T1) + 0.3;

            float tr = cov2d_00 + cov2d_11;
            float det = cov2d_00 * cov2d_11 - cov2d_01 * cov2d_01;
            float disc = sqrt(max(0.25 * tr * tr - det, 0.0));
            float lambda1 = max(0.5 * tr + disc, 0.1);
            float lambda2 = max(0.5 * tr - disc, 0.1);

            vec2 v1;
            if (abs(cov2d_01) > 0.0001) {
                v1 = normalize(vec2(cov2d_01, lambda1 - cov2d_00));
            } else {
                v1 = (cov2d_00 >= cov2d_11) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            }
            vec2 v2 = vec2(-v1.y, v1.x);

            float radius1 = 3.0 * sqrt(lambda1);
            float radius2 = 3.0 * sqrt(lambda2);

            float maxRadius = max(radius1, radius2);
            if (maxRadius > 2048.0) {
                float s = 2048.0 / maxRadius;
                radius1 *= s;
                radius2 *= s;
            }

            vec2 screenOffset = v1 * position.x * radius1 + v2 * position.y * radius2;

            vec4 clipCenter = projectionMatrix * viewCenter;
            gl_Position = clipCenter + vec4(
                screenOffset.x * 2.0 / viewportWidth * clipCenter.w,
                screenOffset.y * 2.0 / viewportHeight * clipCenter.w,
                0.0, 0.0
            );

            vPosition = position.xy;
            vColor = splatColor;
            vOpacity = splatOpacity;
            vDepth = clipCenter.w;
        }
    `;

    const fragmentShader = /* glsl */ `
        uniform float nearPlane;
        uniform float farPlane;

        varying vec2 vPosition;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;

        void main() {
            float A = dot(vPosition, vPosition);
            if (A > 1.0) discard;

            // position.xy spans the 3-sigma ellipse, so use the matching -4.5 falloff
            // to keep surfaces filled without growing the silhouette past the cutoff.
            float alpha = min(0.99, vOpacity * exp(-4.5 * A));
            if (alpha < 1.0 / 255.0) discard;

            // Premultiplied alpha output for front-to-back under-operator compositing.
            // Splat colors are in sRGB space (from SH DC coefficients); convert to
            // linear so the render target is consistently linear and the copy shader's
            // sRGB encoding produces the correct final result.
            vec3 linearColor = sRGBTransferEOTF(vec4(vColor, 1.0)).rgb;
            gl_FragColor = vec4(linearColor * alpha, alpha);

            // Orthographic projection makes clip-space w (vDepth) a constant 1.0,
            // collapsing the log-depth formula to one value per fragment → z-fighting.
            // Use linear rasteriser depth there (three.js's non-perspective path).
            if (vDepth == 1.0) {
                gl_FragDepthEXT = gl_FragCoord.z;
            } else {
                float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                gl_FragDepthEXT = z * 0.5 + 0.5;
            }
        }
    `;

    const material = new ShaderMaterial({
        name: `${getDisplayModelName(filename)} Gaussian Splat`,
        vertexShader,
        fragmentShader,
        uniforms: {
            viewportWidth: {value: 1920},
            viewportHeight: {value: 1080},
            viewOrigin: {value: new Vector3()},
            modelViewLinear: {value: new Matrix3()},
            ...sharedUniforms,
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        // Premultiplied alpha back-to-front compositing.
        // Sharp edges come from the steep -4.5 gaussian (1.1% opacity at 3σ edge).
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneMinusSrcAlphaFactor,
        side: DoubleSide,
    });

    material.userData ??= {};
    material.userData.sitrecGaussianSplat = true;

    return material;
}

function createSplatSortState(splatCount, instancedGeometry) {
    const centers = instancedGeometry.getAttribute("splatCenter").array;
    const colors = instancedGeometry.getAttribute("splatColor").array;
    const opacities = instancedGeometry.getAttribute("splatOpacity").array;
    const scales = instancedGeometry.getAttribute("splatScale").array;
    const rotations = instancedGeometry.getAttribute("splatRotation").array;

    // Pre-allocate reorder buffers
    const order = new Uint32Array(splatCount);
    const depths = new Float32Array(splatCount);
    const newCenters = new Float32Array(splatCount * 3);
    const newColors = new Float32Array(splatCount * 3);
    const newOpacities = new Float32Array(splatCount);
    const newScales = new Float32Array(splatCount * 3);
    const newRotations = new Float32Array(splatCount * 4);
    const modelViewMatrix = new Matrix4();

    function markAttributesForUpload() {
        instancedGeometry.getAttribute("splatCenter").needsUpdate = true;
        instancedGeometry.getAttribute("splatColor").needsUpdate = true;
        instancedGeometry.getAttribute("splatOpacity").needsUpdate = true;
        instancedGeometry.getAttribute("splatScale").needsUpdate = true;
        instancedGeometry.getAttribute("splatRotation").needsUpdate = true;
    }

    return {
        sort(camera, objectMatrixWorld) {
            if (splatCount < 2) return;

            // Exact back-to-front gaussian splat compositing needs true camera-space Z,
            // not bucketed camera distance. Use the fresh model-view matrix row directly.
            modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, objectMatrixWorld);
            const e = modelViewMatrix.elements;
            // View-space Z = row 2 of the modelView matrix dotted with (x, y, z, 1)
            const m8 = e[2], m9 = e[6], m10 = e[10], m11 = e[14];

            // Compute view-space depth for each splat center
            for (let i = 0; i < splatCount; i++) {
                const i3 = i * 3;
                depths[i] = m8 * centers[i3] + m9 * centers[i3 + 1] + m10 * centers[i3 + 2] + m11;
                order[i] = i;
            }

            // Sort back-to-front: in view space, more negative Z is farther away.
            // We want farthest (most negative) first, so sort ascending by depth.
            exactDepthSort(order, depths);

            // Reorder all attribute arrays by the sorted order
            for (let dest = 0; dest < splatCount; dest++) {
                const src = order[dest];
                const s3 = src * 3, d3 = dest * 3;
                newCenters[d3] = centers[s3]; newCenters[d3 + 1] = centers[s3 + 1]; newCenters[d3 + 2] = centers[s3 + 2];
                newColors[d3] = colors[s3]; newColors[d3 + 1] = colors[s3 + 1]; newColors[d3 + 2] = colors[s3 + 2];
                newOpacities[dest] = opacities[src];
                newScales[d3] = scales[s3]; newScales[d3 + 1] = scales[s3 + 1]; newScales[d3 + 2] = scales[s3 + 2];
                const s4 = src * 4, d4 = dest * 4;
                newRotations[d4] = rotations[s4]; newRotations[d4 + 1] = rotations[s4 + 1];
                newRotations[d4 + 2] = rotations[s4 + 2]; newRotations[d4 + 3] = rotations[s4 + 3];
            }

            centers.set(newCenters);
            colors.set(newColors);
            opacities.set(newOpacities);
            scales.set(newScales);
            rotations.set(newRotations);
            markAttributesForUpload();
        },
    };
}

function exactDepthSort(order, depths) {
    // Tie-break on the original index so the sort is deterministic for nearly
    // identical depths and doesn't shimmer as typed-array order changes.
    order.sort((a, b) => {
        const delta = depths[a] - depths[b];
        return delta !== 0 ? delta : a - b;
    });
}

function createPLYModel(geometry, filename, sourceData) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    const hasFaces = plyHasFaces(sourceData);
    const usesVertexColors = geometry.getAttribute("color") !== undefined;

    const root = new Group();
    root.name = getDisplayModelName(filename);
    root.userData.sitrecModelFormat = "ply";
    root.userData.sitrecPlyHasFaces = hasFaces;

    if (hasFaces && geometry.getAttribute("normal") === undefined) {
        geometry.computeVertexNormals();
    }

    if (hasFaces) {
        const material = new MeshStandardMaterial({
            color: usesVertexColors ? 0xffffff : 0xbfbfbf,
            vertexColors: usesVertexColors,
        });
        const mesh = new Mesh(geometry, material);
        mesh.name = root.name;
        // PLY exports commonly preserve Blender/Z-up coordinates.
        // Convert to Sitrec's Y-up convention while keeping the wrapper group unrotated.
        mesh.rotateX(-Math.PI / 2);
        mesh.updateMatrix();
        root.add(mesh);
    } else if (isGaussianSplatPLY(geometry)) {
        console.log(`[GaussianSplat] Detected gaussian splat PLY: ${filename}`);
        console.log(`[GaussianSplat] Splat count: ${geometry.getAttribute("position").count}`);
        const scaleAttr = geometry.getAttribute("splatScale");
        if (scaleAttr) {
            let minS = Infinity, maxS = -Infinity;
            for (let i = 0; i < scaleAttr.array.length; i++) {
                const v = Math.exp(scaleAttr.array[i]);
                if (v < minS) minS = v;
                if (v > maxS) maxS = v;
            }
            console.log(`[GaussianSplat] Scale range (linear): ${minS.toExponential(3)} to ${maxS.toExponential(3)}`);
        }
        const instancedGeometry = createGaussianSplatGeometry(geometry);
        const material = createGaussianSplatMaterial(filename);
        const splatMesh = new Mesh(instancedGeometry, material);
        splatMesh.name = root.name;
        splatMesh.rotateX(-Math.PI / 2);
        splatMesh.updateMatrix();
        splatMesh.frustumCulled = false;
        splatMesh.renderOrder = 999;
        splatMesh.userData.sitrecGaussianSplat = true;
        splatMesh.userData.splatSortState = createSplatSortState(
            instancedGeometry.instanceCount, instancedGeometry,
        );
        root.add(splatMesh);
    } else {
        const material = createPLYPointCloudMaterial(geometry, filename);
        const points = new Points(geometry, material);
        points.name = root.name;
        points.rotateX(-Math.PI / 2);
        points.updateMatrix();
        points.userData.sitrecPLYPointCloud = material.userData?.sitrecPLYPointCloud === true;
        root.add(points);
    }

    return {
        scene: root,
        format: "ply",
        source: geometry,
    };
}

function parseGLBModel(data, filename) {
    return new Promise((resolve, reject) => {
        const loader = createGLTFLoader();
        loader.parse(coerceArrayBuffer(data, filename), "", (gltf) => {
            checkModelHierarchy(gltf, filename);
            ensureGLTFMeshNormals(gltf.scene);
            normalizeDroppedModelMaterials(gltf.scene, filename);
            gltf.scene.userData ??= {};
            gltf.scene.userData.sitrecModelFormat = "glb";

            resolve({
                scene: gltf.scene,
                format: "glb",
                source: gltf,
            });
        }, (error) => {
            reject(error);
        });
    });
}

function parsePLYModel(data, filename) {
    const loader = new PLYLoader();
    setPLYCustomPropertyMappings(loader);
    const geometry = loader.parse(coerceArrayBuffer(data, filename));
    return Promise.resolve(createPLYModel(geometry, filename, data));
}

const modelParsers = {
    glb: parseGLBModel,
    ply: parsePLYModel,
};

function attachCallbacks(promise, onLoad, onError) {
    if (onLoad || onError) {
        promise.then((result) => {
            if (onLoad) {
                onLoad(result);
            }
        }).catch((error) => {
            if (onError) {
                onError(error);
            }
        });
    }

    return promise;
}

export function getModelFileExtension(filename) {
    return getFileExtension(filename).toLowerCase();
}

export function isSupportedModelFile(filename) {
    return supportedModelExtensions.has(getModelFileExtension(filename));
}

export function getSupportedModelExtensions() {
    return [...SUPPORTED_MODEL_EXTENSIONS];
}

export function parseModelData(filename, data, onLoad, onError) {
    const extension = getModelFileExtension(filename);
    const parser = modelParsers[extension];

    const promise = parser
        ? parser(data, filename).then((modelAsset) => attachFilenameParameters(modelAsset, filename))
        : Promise.reject(new Error(`Unsupported model format "${extension}" for "${filename}"`));

    return attachCallbacks(promise, onLoad, onError);
}

export function loadModelAsset(filename, onLoad, onError) {
    const promise = FileManager.loadAsset(filename, filename).then((asset) => {
        if (!asset) {
            throw new Error(`No asset data returned for "${filename}"`);
        }
        // Use the actual filename stored in FileManager (with extension) if available,
        // since the key (e.g. "TargetObjectFile") may not have an extension.
        const actualFilename = FileManager.list[filename]?.filename ?? filename;
        return parseModelData(actualFilename, asset.parsed);
    });

    return attachCallbacks(promise, onLoad, onError);
}
