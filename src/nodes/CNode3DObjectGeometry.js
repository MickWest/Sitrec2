/**
 * Geometry classes, shader strings, and material/type registries shared by
 * CNode3DObject.
 *
 * Kept out of CNode3DObject.js to keep that file focused on the node lifecycle
 * (constructor, rebuild, material overrides, reflection analysis). Nothing here
 * depends on CNode3DObject itself; the class imports from this module.
 */

import {
    Box3,
    BoxGeometry,
    CapsuleGeometry,
    CircleGeometry,
    Color,
    ConeGeometry,
    CurvePath,
    CylinderGeometry,
    DataTexture,
    DodecahedronGeometry,
    IcosahedronGeometry,
    LatheGeometry,
    LinearFilter,
    LineCurve3,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshPhongMaterial,
    MeshPhysicalMaterial,
    NearestFilter,
    OctahedronGeometry,
    QuadraticBezierCurve3,
    RGBAFormat,
    RingGeometry,
    ShaderMaterial,
    Sphere,
    SphereGeometry,
    TetrahedronGeometry,
    TorusGeometry,
    TorusKnotGeometry,
    TubeGeometry,
    UnsignedByteType,
    Vector2,
    Vector3,
} from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import {V3} from "../threeUtils";
import {t} from "../i18n";

export class SuperEggGeometry extends LatheGeometry {
    constructor(radius = 1, length = 1, sharpness = 5.5, widthSegments = 20, heightSegments = 20) {
        // Generate points for the profile curve of the superegg
        const points = [];
        for (let i = 0; i <= heightSegments; i++) {
            const t = (i / heightSegments) * Math.PI - Math.PI / 2; // Range from -π/2 to π/2
            const y = Math.sin(t) * length; // Y-coordinate, scaled by length
            const x = Math.sign(Math.cos(t)) * Math.abs(Math.cos(t)) ** (2 / sharpness) * radius; // X-coordinate scaled by radius
            points.push(new Vector2(x, y));
        }

        // Create LatheGeometry by revolving the profile curve around the y-axis
        super(points, widthSegments);

        this.type = 'SuperEggGeometry';
        this.parameters = {
            radius: radius,
            length: length,
            sharpness: sharpness,
            widthSegments: widthSegments,
            heightSegments: heightSegments
        };
    }
}

// wrapper to use the CapsuleGeometry with a total length instead of cylinder length
export class CapsuleGeometryTL {
    constructor(radius=0.5, totalLength = 5, capSegments = 20, radialSegments = 20) {
        return new CapsuleGeometry(radius, totalLength-radius*2, capSegments, radialSegments);
    }
}

// EllipsoidGeometry
// Creates an ellipsoid by scaling a sphere geometry
export class EllipsoidGeometry extends SphereGeometry {
    constructor(radius = 1, aspect = 1, widthSegments = 32, heightSegments = 16) {
        // Create a sphere with the base radius
        super(radius, widthSegments, heightSegments);
        
        // Scale the Y-axis by the aspect ratio to create an ellipsoid
        this.scale(1, aspect, 1);
        
        this.type = 'EllipsoidGeometry';
        this.parameters = {
            radius: radius,
            aspect: aspect,
            widthSegments: widthSegments,
            heightSegments: heightSegments
        };
    }
}

// Procedural TicTac model from a capsule and two legs
export class TicTacGeometry {
    constructor(radius = 1, totalLength = 1, capSegments = 20, radialSegments = 20, legRadius = 0.1, legLength1 = 0.1, legLength2 = 0.1, legCurveRadius = 0.1, legOffset = 0.1, legSpacing = 0.1) {

        const capsule = new CapsuleGeometry(radius, totalLength-radius*2, capSegments, radialSegments);

        // get the offset of the legs, radius*0.95 so it overlaps the capsule to avoid gaps
        const leg1Start = V3(0, legOffset + legSpacing/2, radius*0.95);
        const leg2Start = V3(0, legOffset - legSpacing/2, radius*0.95);

        // get relative positions of the leg mid and end
        const legMid = V3(0, 0,          legLength1);
        const legEnd = V3(0, legLength2, legLength1);

        // calculate the two sets of mid and end
        const leg1Mid = leg1Start.clone().add(legMid);
        const leg1End = leg1Start.clone().add(legEnd);
        const leg2Mid = leg2Start.clone().add(legMid);
        const leg2End = leg2Start.clone().add(legEnd);

        legCurveRadius = Math.min(legCurveRadius, legLength1);
        legCurveRadius = Math.min(legCurveRadius, Math.abs(legLength2));

        const tube1 = createTube(leg1Start, leg1Mid, leg1End, legRadius, legCurveRadius);
        const tube2 = createTube(leg2Start, leg2Mid, leg2End, legRadius, legCurveRadius);

        const geometries = [capsule,tube1, tube2];
        const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries);

        return mergedGeometry;
    }

}

// Function to compute a point on a line segment at a given distance from an endpoint
export function computePointAtDistance(p1, p2, distance) {
    const direction = new Vector3().subVectors(p1, p2).normalize();
    return new Vector3().addVectors(p2, direction.multiplyScalar(distance));
}

// Function to create a cap geometry at a given position with a specified radius
export function createCapGeometry(position, radius, direction) {
    const geometry = new CircleGeometry(radius, 32);
    geometry.lookAt(direction);
    geometry.translate(position.x, position.y, position.z);
    return geometry;
}

// Function to create a bent tube geometry with the given parameters
export function createTube(A, B, C, R, K) {

    // Compute points A1 and C1
    const A1 = computePointAtDistance(A, B, K);
    const C1 = computePointAtDistance(C, B, K);

    // Create straight line segments A-A1 and C1-C
    const straightSegment1 = new LineCurve3(A, A1);
    const straightSegment2 = new LineCurve3(C1, C);

    // Create quadratic Bézier curve segment A1-B-C1
    const bezierCurve = new QuadraticBezierCurve3(A1, B, C1);

    // Combine the segments into a single curve
    const curvePath = new CurvePath();
    curvePath.add(straightSegment1);
    curvePath.add(bezierCurve);
    curvePath.add(straightSegment2);

    // Create tube geometry
    const tubeGeometry = new TubeGeometry(curvePath, 64, R, 8, false);

    // Create cap geometries
    const capGeometryStart = createCapGeometry(A, R, A.clone().sub(B));
    const capGeometryEnd = createCapGeometry(C, R, C.clone().sub(B));

    const geometries = [tubeGeometry, capGeometryStart, capGeometryEnd];
    const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries);

    return mergedGeometry;

}

/**
 * Compute the local bounding box for an Object3D by temporarily resetting its transform.
 * This helper detaches the object, resets to identity, computes bounds, then restores.
 * @param {Object3D} object - The Three.js object to compute bounding box for
 * @returns {Box3} A bounding box in local coordinates
 */
export function computeLocalBoundingBox(object) {
    const box = new Box3();
    
    const parent = object.parent;
    if (parent) {
        parent.remove(object);
    }
    
    const originalPosition = object.position.clone();
    const originalQuaternion = object.quaternion.clone();
    const originalScale = object.scale.clone();
    const originalMatrixAutoUpdate = object.matrixAutoUpdate;

    object.matrixAutoUpdate = true;
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    object.updateMatrix();
    object.updateMatrixWorld(true);
    
    box.setFromObject(object);
    
    object.position.copy(originalPosition);
    object.quaternion.copy(originalQuaternion);
    object.scale.copy(originalScale);
    object.matrixAutoUpdate = originalMatrixAutoUpdate;
    object.updateMatrix();
    object.updateMatrixWorld(true);
    
    if (parent) {
        parent.add(object);
    }
    
    return box;
}

/**
 * Compute a bounding sphere for an entire Object3D (including all children)
 * This works for complex hierarchies like loaded GLTF models
 * The bounding sphere is computed in local coordinates (relative to the object's position)
 * @param {Object3D} object - The Three.js object to compute bounding sphere for
 * @returns {Sphere} A bounding sphere in local coordinates
 */
export function computeGroupBoundingSphere(object) {
    const box = computeLocalBoundingBox(object);
    const sphere = new Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
}

/**
 * Compute the height from the center of an object to its lowest point
 * This is useful for ground clamping to ensure objects sit properly on terrain
 * @param {Object3D} object - The Three.js object to compute height for
 * @returns {number} The distance from the object's center to its lowest point
 */
export function computeCenterToLowestPoint(object) {
    const box = computeLocalBoundingBox(object);
    return -box.min.y;
}

export function getBoundingBoxCorners(box) {
    const min = box.min;
    const max = box.max;

    return [
        V3(min.x, min.y, min.z),
        V3(max.x, min.y, min.z),
        V3(min.x, max.y, min.z),
        V3(max.x, max.y, min.z),
        V3(min.x, min.y, max.z),
        V3(max.x, min.y, max.z),
        V3(min.x, max.y, max.z),
        V3(max.x, max.y, max.z),
    ];
}


// Describe the parameters of each geometry type
// any numeric entry is [default, min, max, step]
// as described here: https://threejs.org/docs/#api/en/geometries/BoxGeometry
export const gTypes = {
    sphere: {
        g: SphereGeometry,
        params: {
            radius: [[0.5, 0.01, 100, 0.01], "Radius of the sphere"],
            widthSegments: [10, 4, 40, 1],
            heightSegments: [10, 3, 40, 1],
        }
    },
    ellipsoid: {
        g: EllipsoidGeometry,
        params: {
            radius: [[0.5, 0.01, 100, 0.01], "Horizontal radius of the ellipsoid"],
            aspect: [[1.0, 0.01, 5.0, 0.001], "Aspect ratio - vertical radius / horizontal radius"],
            widthSegments: [32, 4, 64, 1],
            heightSegments: [16, 3, 32, 1],
        }
    },
    box: {
        g: BoxGeometry,
        params: {
            width: [1, 0.01, 100, 0.01],
            height: [1, 0.01, 100, 0.01],
            depth: [1, 0.01, 100, 0.01],
        }
    },
    capsule: {
        g: CapsuleGeometryTL,
        params: {
            radius: [0.5, 0.01, 20, 0.01],
            totalLength: [5, 0.01, 30, 0.01],
            capSegments: [20, 4, 40, 1],
            radialSegments: [20, 4, 40, 1],
        }
    },

    circle: {
        g: CircleGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            segments: [10, 3, 100, 1],
        }
    },

    cone: {
        g: ConeGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            height: [1, 0, 100, 0.01],
            radialSegments: [10, 4, 40, 1],
            heightSegments: [10, 3, 40, 1],
        }
    },

    cylinder: {
        g: CylinderGeometry,
        params: {
            radiusTop: [0.5, 0.01, 100, 0.01],
            radiusBottom: [0.5, 0.01, 100, 0.01],
            height: [1, 0, 100, 0.01],
            radialSegments: [10, 4, 40, 1],
            heightSegments: [10, 3, 40, 1],
            openEnded: [false, "Whether the ends of the cylinder are open or closed"],
            thetaStart: [0, 0, 2 * Math.PI, 0.01],
            thetaLength: [2 * Math.PI, 0, 2 * Math.PI, 0.1],
        }
    },

    dodecahedron: {
        g: DodecahedronGeometry,
        params: {
            radius: [0.5, 0.1, 100, 0.01],
            detail: [0, 0, 5, 1],
        }
    },

    icosahedron: {
        g: IcosahedronGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            detail: [0, 0, 5, 1],
        }
    },

    octahedron: {
        g: OctahedronGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            detail: [0, 0, 5, 1],
        }
    },

    ring: {
        g: RingGeometry,
        params: {
            innerRadius: [0.25, 0.0, 100, 0.01],
            outerRadius: [0.5, 0.01, 100, 0.01],
            thetaSegments: [10, 3, 100, 1],
            phiSegments: [10, 3, 100, 1],
            thetaStart: [0, 0, 2 * Math.PI, 0.01],
            thetaLength: [2 * Math.PI, 0, 2 * Math.PI, 0.1],

        }

    },

    tetrahedron: {
        g: TetrahedronGeometry,
        params: {
            radius: [0.5, 0.1, 100, 0.01],
            detail: [0, 0, 5, 1],
        }
    },

    torus: {
        g: TorusGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            tube: [0.15, 0.001, 100, 0.001],
            radialSegments: [10, 3, 100, 1],
            tubularSegments: [20, 3, 100, 1],
            arc: [Math.PI * 2, 0, Math.PI * 2, 0.1],
        }
    },

    torusknot: {
        g: TorusKnotGeometry,
        params: {
            radius: [0.5, 0.01, 100, 0.01],
            tube: [0.15, 0.01, 100, 0.01],
            tubularSegments: [64, 3, 100, 1],
            radialSegments: [8, 3, 100, 1],
            p: [2, 1, 10, 1],
            q: [3, 1, 10, 1],
        }
    },

    superegg: {
        g: SuperEggGeometry,
        params: {
            radius: [0.5, 0.01, 30, 0.01],
            length: [4, 0.01, 20, 0.01],
            sharpness: [5.5, 0.1, 10, 0.1],
            widthSegments: [20, 4, 40, 1],
            heightSegments: [20, 3, 40, 1],
        }

    },

    tictac: {
        g: TicTacGeometry,
        params: {
            radius: [2.6, 0.01, 30, 0.01],
            totalLength: [12.2, 0.01, 50, 0.01],
            capSegments: [20, 4, 40, 1],
            radialSegments: [30, 4, 40, 1],
            legRadius: [0.28, 0.001, 5, 0.001],
            legLength1: [1.4, 0.001, 10, 0.001],
            legLength2: [1.4, -5, 5, 0.001],
            legCurveRadius: [0.88, 0.0, 5, 0.001],
            legOffset: [-0.45, -10, 10, 0.001],
            legSpacing: [6.2, 0.0, 20, 0.001],
        }


    }

}

// Gradient palette definitions for thermal imaging visualization
// Each palette is an array of [position, r, g, b] color stops
export const gradientPalettes = {
    "Ironbow": [
        [0, 0, 0, 0],
        [0.25, 42, 0, 102],
        [0.5, 204, 51, 0],
        [0.75, 255, 153, 0],
        [1, 255, 255, 255],
    ],
    "Black Hot": [
        [0, 255, 255, 255],
        [1, 0, 0, 0],
    ],
    "White Hot": [
        [0, 0, 0, 0],
        [1, 255, 255, 255],
    ],
    "Rainbow": [
        [0, 0, 0, 255],
        [0.25, 0, 255, 255],
        [0.5, 0, 255, 0],
        [0.75, 255, 255, 0],
        [1, 255, 0, 0],
    ],
    "Lava": [
        [0, 0, 0, 0],
        [0.33, 204, 0, 0],
        [0.66, 255, 153, 0],
        [1, 255, 255, 255],
    ],
    "Arctic": [
        [0, 0, 0, 51],
        [0.5, 0, 204, 204],
        [1, 255, 255, 255],
    ],
    "Plasma": [
        [0, 13, 8, 135],
        [0.25, 126, 3, 168],
        [0.5, 204, 71, 120],
        [0.75, 248, 149, 64],
        [1, 240, 249, 33],
    ],
};

// Create a 256x1 DataTexture from a named gradient palette
export function createGradientTexture(paletteName) {
    const stops = gradientPalettes[paletteName] || gradientPalettes["Ironbow"];
    const width = 256;
    const data = new Uint8Array(width * 4); // RGBA

    for (let i = 0; i < width; i++) {
        const t = i / (width - 1);

        // Find surrounding stops
        let lower = stops[0];
        let upper = stops[stops.length - 1];
        for (let s = 0; s < stops.length - 1; s++) {
            if (t >= stops[s][0] && t <= stops[s + 1][0]) {
                lower = stops[s];
                upper = stops[s + 1];
                break;
            }
        }

        // Interpolate between stops
        const range = upper[0] - lower[0];
        const frac = range > 0 ? (t - lower[0]) / range : 0;

        const idx = i * 4;
        data[idx]     = Math.round(lower[1] + (upper[1] - lower[1]) * frac);
        data[idx + 1] = Math.round(lower[2] + (upper[2] - lower[2]) * frac);
        data[idx + 2] = Math.round(lower[3] + (upper[3] - lower[3]) * frac);
        data[idx + 3] = 255;
    }

    const texture = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

export const gradientVertexShader = `
    uniform vec3 gradientCenter;
    uniform vec3 gradientDir;

    varying float vGradientD;
    varying vec3 vWorldNormal;
    varying vec4 vPosition;

    void main() {
        // Compute world-space position so the gradient is consistent across
        // model hierarchies with varying internal transforms.
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);

        // Compute the position-based gradient dot product per-vertex to avoid
        // precision loss from interpolating large ECEF coordinates as varyings.
        // The subtraction of two large ECEF values still happens in 32-bit, but
        // the small result interpolates cleanly across the triangle.
        vGradientD = dot(worldPos.xyz - gradientCenter, gradientDir);

        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vPosition = projectionMatrix * mvPosition;
        gl_Position = vPosition;
    }
`;

export const gradientFragmentShader = `
    uniform sampler2D gradientMap;
    uniform vec3 gradientDir;
    uniform float gradientHalfHeight;
    uniform float gradientScale;
    uniform float gradientShift;
    uniform float useLeadingEdge;
    uniform float reverseGradient;
    uniform vec3 baseColor;
    uniform float baseMix;
    uniform float nearPlane;
    uniform float farPlane;

    varying float vGradientD;
    varying vec3 vWorldNormal;
    varying vec4 vPosition;

    void main() {
        float t;

        if (useLeadingEdge > 0.5) {
            // Leading Edge: color based on angle between surface normal and motion direction.
            // Surfaces facing into the motion (nose, wing leading edges) are "hot" (t=1),
            // surfaces perpendicular or facing away are "cold" (t=0).
            // The dot product gives 0-1, treated as a unit-diameter space so
            // scale and shift apply the same way as position-based modes.
            float d = dot(normalize(vWorldNormal), gradientDir) - gradientShift;
            float extent = 0.5 * (gradientScale / 100.0);
            t = d / (2.0 * extent) + 0.5;
        } else {
            // Position-based gradient: use per-vertex dot product from vertex shader
            // to avoid precision loss from interpolating large ECEF positions.
            float extent = gradientHalfHeight * (gradientScale / 100.0);
            t = vGradientD / (2.0 * extent) + 0.5;
        }

        if (reverseGradient > 0.5) {
            t = 1.0 - t;
        }
        t = clamp(t, 0.0, 1.0);

        vec4 gradientColor = texture2D(gradientMap, vec2(t, 0.5));
        gl_FragColor = vec4(mix(gradientColor.rgb, baseColor, baseMix), 1.0);

        // Logarithmic depth (matching other shaders in the codebase)
        float w = vPosition.w;
        float z = (log2(max(nearPlane, 1.0 + w)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
        gl_FragDepthEXT = z * 0.5 + 0.5;
    }
`;

// Create an 8x8 checkerboard DataTexture
export function createCheckerboardTexture(color1, color2) {
    const size = 8;
    const data = new Uint8Array(size * size * 4);
    const c1 = new Color(color1);
    const c2 = new Color(color2);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const c = (x + y) % 2 === 0 ? c1 : c2;
            const idx = (y * size + x) * 4;
            data[idx]     = Math.round(c.r * 255);
            data[idx + 1] = Math.round(c.g * 255);
            data[idx + 2] = Math.round(c.b * 255);
            data[idx + 3] = 255;
        }
    }
    const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
}

// material types for meshes
export const materialTypes = {
    basic: {
        m: MeshBasicMaterial,
        params: {
            color: ["white", "Base Color"],
            fog: [true, "Enable Fog"],
        }
    },

    // lambert, with no maps, essentially just combines the color and emissive
    lambert: {
        m: MeshLambertMaterial,
        params: {
            color: ["white", "Base Color"],
            emissive: ["black", "Emissive color - i.e. the self illuminated color"],
            emissiveIntensity: [[1,0,1,0.01],"Intensity of self-illuiminated color"],
            flatShading: [false, "Enable flat shading - i.e. no smooth shading"],
            fog: [true, "Enable Fog"],

        }
    },

    phong: {
        m: MeshPhongMaterial,
        params: {
            color: ["white", "Base Color"],
            emissive: ["black", "Emissive color - i.e. the self illuminated color"],
            emissiveIntensity: [[1,0,1,0.01],"Intensity of self-illuminated color"],
            specular: ["white", "Specular Color"],
            shininess: [[30,0,100,0.1], "Shininess of the specular highlight"],
            flatShading: [false, "Enable flat shading - i.e. no smooth shading"],
            fog: [true, "Enable Fog"],
        }
    },

    physical: {
        m: MeshPhysicalMaterial,
        params: {
            color: ["white", "Base Color"],
            clearcoat: [[1, 0, 1, 0.01], "Clearcoat intensity"],
            clearcoatRoughness: [[0, 0, 1, 0.01], "Clearcoat roughness"],
            emissive: ["black", "Emissive color - i.e. the self illuminated color"],
            emissiveIntensity: [[1, 0, 1, 0.01], "Intensity of self-illuminated color"],
            specularColor: ["white", "Specular Color"],
            specularIntensity: [[1,0,1,0.01], "Intensity of the specular highlight"],
            sheen: [[0, 0, 1, 0.01], "Sheen intensity"],
            sheenRoughness: [[0.5, 0, 1, 0.01], "Sheen roughness"],
            sheenColor: ["black", "Sheen color"],
            flatShading: [false, "Enable flat shading - i.e. no smooth shading"],
            fog: [true, "Enable Fog"],
            reflectivity: [[1, 0, 1, 0.01], "Reflectivity"],
            transmission: [[0, 0, 1, 0.01], "Transmission"],
            ior: [[1.5, 1, 2.33, 0.01], "Index of Refraction"],
            roughness: [[0.5, 0, 1, 0.01], "Roughness"],
            metalness: [[0.5, 0, 1, 0.01], "Metalness"],
        }
    },

    envmap: {
        m: MeshPhysicalMaterial,
        params: {
            color: ["white", "Base Color"],
            roughness: [[0, 0, 1, 0.01], "Roughness - 0 is a perfect mirror"],
            metalness: [[1, 0, 1, 0.01], "Metalness - 1 is fully metallic/reflective"],
            envMapResolution: [[256, 64, 1024, 64], "Cube map resolution per face (higher = sharper reflections, slower)"],
            flatShading: [false, "Enable flat shading - i.e. no smooth shading"],
            fog: [true, "Enable Fog"],
        }
    },

    gradient: {
        m: null, // custom ShaderMaterial, not a standard Three.js material
        params: {
            gradientPalette: [["Ironbow", "Black Hot", "White Hot", "Rainbow", "Lava", "Arctic", "Plasma"], "Color palette for the gradient (thermal imaging presets)"],
            gradientDirection: [["Model Down", "World Down", "Motion Forward", "Leading Edge"], "Axis along which the gradient is mapped: Model/World Down use Y axis, Motion Forward along velocity, Leading Edge colors by angle between surface normal and velocity"],
            reverse: [false, "Flip the gradient so the start color appears at the opposite end"],
            baseColor: ["black", "Base color to blend with the gradient"],
            baseMix: [[0, 0, 1, 0.01], "Blend between gradient and base color (0 = pure gradient, 1 = pure base color)"],
            scale: [[100, 1, 1000, 1], "Scale the gradient extent as a percentage of the object height (100% = full height)"],
            shift: [[0, -100, 100, 1], "Offset the gradient center along its direction (% of bounding diameter)"],
        }
    },

    checkerboard: {
        m: MeshLambertMaterial,
        params: {
            color1: ["white", "First checker color"],
            color2: ["#808080", "Second checker color"],
            emissive: ["black", "Emissive color"],
            emissiveIntensity: [[1, 0, 1, 0.01], "Intensity of self-illuminated color"],
            flatShading: [false, "Enable flat shading"],
            fog: [true, "Enable Fog"],
        }
    },


}

export const commonMaterialParams = {
    material: [["basic", "lambert", "phong", "physical", "envMap", "gradient", "checkerboard"],"Type of Material lighting"],
    wireframe: [false, "Display geometry object as a wireframe"],
    edges: [false, "Display geometry object as edges"],
    depthTest: [true, "Enable depth testing"],
    opacity: [[1,0,1,0.01], "Opacity of the object"],
    transparent: [false,"Enable transparency"],
}

export const commonParams = {
    geometry: [["sphere", 
        "ellipsoid",
        "box", 
        "capsule", 
        "circle", 
        "cone", 
        "cylinder", 
        "dodecahedron", 
        "icosahedron", 
        "octahedron", 
        "ring", 
        "tictac", 
        "tetrahedron", 
        "torus", 
        "torusknot", 
        "superegg"], "Type of Generated Geometry"],
    rotateX: [[0, -180, 180, 1], "Rotation about the X-axis"],
    rotateY: [[0, -180, 180, 1], "Rotation about the Y-axis"],
    rotateZ: [[0, -180, 180, 1], "Rotation about the Z-axis"],
    applyMaterial: [false, "Apply Material to the 3D model, overriding the loaded materials"],
    modelDisplayMode: [["normal", "rawTexture", "rawTextureMipped", "lightingOnly", "lambert"], "Choose whether the model uses normal lit shading, exact texel raw texture, filtered+mipped raw texture, lighting-only grayscale, or lambert with source textures"],
   // color: "white",
}




