// CNode3DObject.js - CNode3DObject
// a 3D object node - a sphere, cube, etc., with generated geometry and material from the input parameters
// encapsulates a THREE.Object3D object, like:
// - THREE.Mesh (default)
// - THREE.LineSegments (if wireframe or edges)

import {CNode3DLight} from "./CNode3DLight";
import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {fastComputeVertexNormals} from "../FastComputeVertexNormals";
import {
    Box3,
    BoxGeometry,
    CapsuleGeometry,
    CircleGeometry,
    Color,
    ConeGeometry,
    CubeCamera,
    CurvePath,
    CylinderGeometry,
    DataTexture,
    DodecahedronGeometry,
    EdgesGeometry,
    HalfFloatType,
    IcosahedronGeometry,
    LatheGeometry,
    LinearFilter,
    LineCurve3,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshPhongMaterial,
    MeshPhysicalMaterial,
    OctahedronGeometry,
    QuadraticBezierCurve3,
    Raycaster,
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
    WebGLCubeRenderTarget,
    WireframeGeometry
} from "three";
import {FileManager, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {assert} from "../assert";
import {DebugArrowAB, disposeScene, propagateLayerMaskObject, removeDebugArrow} from "../threeExt";
import {CNodeViewText} from "./CNodeViewText.js";
import {loadGLTFModel} from "./CNode3DModel";
import {V3} from "../threeUtils";
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {CNodeLabel3D, CNodeMeasureAB} from "./CNodeLabels3D";
import {EUSToLLA} from "../LLA-ECEF-ENU";

import {findRootTrack} from "../FindRootTrack";
import {GlobalScene} from "../LocalFrame";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {par} from "../par";

// Note these files are CASE SENSIVE. Mac OS is case insensitive, so be careful. (e.g. F-15.glb will not work on my deployed server)
export const ModelFiles = {
// TODO: X1-B
    "737 MAX 8 BA":         { file: 'data/models/B737Max8.glb',},
    "A340-600":             { file: 'data/models/A340-600.glb',},
    "A-10":                 { file: 'data/models/A-10.glb',},
    "AC690 Rockwell":       { file: 'data/models/AC690.glb',},
    "Bell 206 Helicopter":  { file: 'data/models/Bell-206.glb',},
    "F/A-18F" :             { file: 'data/models/FA-18F.glb',},
    "F-15":                 { file: 'data/models/f-15.glb',},
    "Lear 75":              { file: 'data/models/Lear-75.glb',},
    "MiG-29":               { file: 'data/models/MiG-29.glb',},
    "MQ-9 (loaded)":        { file: 'data/models/MQ9.glb',},
    "MQ-9 (clean)":         { file: 'data/models/MQ9-clean.glb',},
    "SR-71":                { file: 'data/models/SR-71.glb',},
    "PA-28-181":            { file: 'data/models/PA28.glb',},
 //   "737 MAX 8 (White)":    { file: 'data/models/737_MAX_8_White.glb',},
 //   "777-200ER (Malyasia)": { file: 'data/models/777-200ER-Malaysia.glb',},
//    "DC-10":                { file: 'data/models/DC-10.glb',},
   // "WhiteCube":            { file: 'data/models/white-cube.glb',},
   // "PinkCube":             { file: 'data/models/pink-cube.glb',},
   // "ATFLIR":               { file: 'data/models/ATFLIR.glb',},

    "X-37":                 { file: 'data/models/X-37.glb',},
    "Saucer":               { file: 'data/models/saucer01a.glb',},
    "TR-3B":               { file: 'data/models/tr-3b.glb',},
    "LCS":                 { file: 'data/models/LCS.glb',},

}


// Custom geometries

// SuperEggGeometry
// https://en.wikipedia.org/wiki/Superellipsoid

class SuperEggGeometry extends LatheGeometry {
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
class CapsuleGeometryTL {
    constructor(radius=0.5, totalLength = 5, capSegments = 20, radialSegments = 20) {
        return new CapsuleGeometry(radius, totalLength-radius*2, capSegments, radialSegments);
    }
}

// EllipsoidGeometry
// Creates an ellipsoid by scaling a sphere geometry
class EllipsoidGeometry extends SphereGeometry {
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
class TicTacGeometry {
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
function computePointAtDistance(p1, p2, distance) {
    const direction = new Vector3().subVectors(p1, p2).normalize();
    return new Vector3().addVectors(p2, direction.multiplyScalar(distance));
}

// Function to create a cap geometry at a given position with a specified radius
function createCapGeometry(position, radius, direction) {
    const geometry = new CircleGeometry(radius, 32);
    geometry.lookAt(direction);
    geometry.translate(position.x, position.y, position.z);
    return geometry;
}

// Function to create a bent tube geometry with the given parameters
function createTube(A, B, C, R, K) {

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
function computeLocalBoundingBox(object) {
    const box = new Box3();
    
    const parent = object.parent;
    if (parent) {
        parent.remove(object);
    }
    
    const originalMatrix = object.matrix.clone();
    
    object.matrix.identity();
    object.updateMatrixWorld(true);
    
    box.setFromObject(object);
    
    object.matrix.copy(originalMatrix);
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
function computeGroupBoundingSphere(object) {
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
function computeCenterToLowestPoint(object) {
    const box = computeLocalBoundingBox(object);
    return -box.min.y;
}


// Describe the parameters of each geometry type
// any numeric entry is [default, min, max, step]
// as described here: https://threejs.org/docs/#api/en/geometries/BoxGeometry
const gTypes = {
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
const gradientPalettes = {
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
function createGradientTexture(paletteName) {
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

const gradientVertexShader = `
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;
    varying vec4 vPosition;

    void main() {
        // All gradient modes use world-space positions so the gradient is
        // consistent across model hierarchies with varying internal transforms.
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vPosition = projectionMatrix * mvPosition;
        gl_Position = vPosition;
    }
`;

const gradientFragmentShader = `
    uniform sampler2D gradientMap;
    uniform vec3 gradientCenter;
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

    varying vec3 vWorldPosition;
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
            // Position-based gradient: project onto direction vector
            float d = dot(vWorldPosition - gradientCenter, gradientDir);
            float extent = gradientHalfHeight * (gradientScale / 100.0);
            t = d / (2.0 * extent) + 0.5;
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

// material types for meshes
const materialTypes = {
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
    }

}

const commonMaterialParams = {
    material: [["basic", "lambert", "phong", "physical", "envMap", "gradient"],"Type of Material lighting"],
    wireframe: [false, "Display geometry object as a wireframe"],
    edges: [false, "Display geometry object as edges"],
    depthTest: [true, "Enable depth testing"],
    opacity: [[1,0,1,0.01], "Opacity of the object"],
    transparent: [false,"Enable transparency"],
}

const commonParams = {
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
   // color: "white",
}




export class CNode3DObject extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_LOOKRENDER;
        v.color ??= "white"
        v.size ??= 1;

        // patch DON'T convert the color to a constant node
        const oldColor = v.color;
        super(v);
        v.color = oldColor;

        this.input("size", true); // size input is optional

        this.color = v.color;
        this.layers = v.layers; // usually undefined, as the camera handles layers

        this.menuName = this.props.name ?? this.id;
        /// if more that 20 characters, truncate from the middle
        if (this.menuName.length > 20) {
            this.menuName = this.menuName.substring(0, 10) + "..." + this.menuName.substring(this.menuName.length - 7);
        }

        this.gui = guiMenus.objects.addFolder(this.menuName).close()
        this.common = {}
        this.geometryParams = {};
        this.materialParams = {};
        this.lights = []; // Initialize lights array

        this.common.material = v.material ?? "lambert";
        this.materialFolder = this.gui.addFolder("Material").close();
        this.materialFolder.isCommon = true; //temp patch - not needed?  not a controller???
        this.addParams(commonMaterialParams, this.common, this.materialFolder, true);
        this.rebuildMaterial();

        this.modelOrGeometry = v.modelOrGeometry;
        // if we don't have one, infer it from the presence of either "model" or geometry" in the parameters
        if (this.modelOrGeometry === undefined) {
            if (v.model !== undefined) {
                this.modelOrGeometry = "model";
            } else {
                this.modelOrGeometry = "geometry";
            }
        }

        this.modelOrGeometryMenu = this.gui.add(this, "modelOrGeometry", ["geometry", "model"]).listen().name("Model or Geometry").onChange((v) => {
            this.rebuild();
            setRenderOne(true)
        }).tooltip("Select whether to use a 3D Model or a generated geometry for this object")
            .listen();

        this.modelOrGeometryMenu.isCommon = true;

        this.selectModel = v.model ?? "F/A-18F";
        this.modelMenu = this.gui.add(this, "selectModel", Object.keys(ModelFiles)).name("Model").onChange((v) => {
            this.modelOrGeometry = "model"
            this.rebuild();
            setRenderOne(true)
        })
            .listen()
            .tooltip("Selecte a 3D Model to use for this object");

        this.modelMenu.isCommon = true;

        // add the common parameters to the GUI
        // note we set isCommon to true to flag them as common
        // so they don't get deleted when we rebuild the GUI after object type change
        this.addParams(commonParams, this.common, this.gui, true); // add the common parameters to the GUI

        this.displayBoundingBox = false;

        this.gui.add(this, "displayBoundingBox").name("Display Bounding Box").listen().onChange((v) => {
            this.rebuild();
            setRenderOne(true)
        })
            .tooltip("Display the bounding box of the object with dimensions")
            .isCommon = true;

        this.forceAboveSurface = v.forceAboveSurface ?? true;
        this.addSimpleSerial("forceAboveSurface");

        this.gui.add(this, "forceAboveSurface").name("Force Above Surface").listen().onChange((v) => {
            setRenderOne(true)
        })
            .tooltip("Force the object to be fully above the ground surface")
            .isCommon = true;

        // Add export to KML button
       this.gui.add(this, "exportToKML").name("Export to KML")
            .tooltip("Export this 3D object as a KML file for Google Earth")
            .isCommon = true;

        // Reflection Analysis
        this.reflectionGridSize = 50;
        this.reflectionArrowIds = [];

        this.reflectionFolder = this.gui.addFolder("Reflection Analysis").close();
        this.reflectionFolder.isCommon = true;

        this.reflectionFolder.add(this, "startReflectionAnalysis")
            .name("Start Analysis").isCommon = true;

        this.reflectionFolder.add(this, "reflectionGridSize", 5, 100, 1)
            .name("Grid Size")
            .onFinishChange(() => {
                if (this.reflectionArrowIds.length > 0) this.startReflectionAnalysis();
            }).isCommon = true;

        this.reflectionFolder.add(this, "cleanUpReflectionAnalysis")
            .name("Clean Up").isCommon = true;

        this.rebuild();

        // move the material folder to the end
        this.materialFolder.moveToEnd();

        if (v.label !== undefined) {
            this.addLabel(v.label)
        }
    }


    // We can use objects as data sources for things like labels
    // so we need to be able to get the value of the object
    // Note this just gets the CURRENT position of the object
    getValueFrame(frameFloat) {
        return {position: this.group.position.clone()};
    }

    show(visible) {
        super.show(visible);
        if (this.label !== undefined) {
            this.label.show(visible)
        }
    }


    addLabel( label ) {

        this.label = new CNodeLabel3D({
            id: this.id + "_label",
            text: label,
            position: this,
            offsetY:40, // this is vertical offset in screen pixels.
            color: "white",
            size:12,
            groupNode: "LabelsGroupNode",

        })

    }

    // Export the 3D object as a KML file for Google Earth
    async exportToKML() {
        try {
            // Get the current position of the object in EUS coordinates
            const eusPosition = this.group.position.clone();
            
            // Convert EUS position to LLA (Latitude, Longitude, Altitude)
            const lla = EUSToLLA(eusPosition);
            const latitude = lla.x;   // degrees
            const longitude = lla.y;  // degrees  
            const altitude = lla.z;   // meters above sea level
            
            // Get object properties
            const objectName = this.props.name || this.id;
            const geometryType = this.common.geometry || 'sphere';
            
            // Get sitch name for filename prefix
            const sitchName = Sit.sitchName || Sit.name;
            // Generate COLLADA file content
            const colladaResult = this.generateColladaContent(objectName, geometryType);
            const colladaContent = colladaResult.content;
            const colladaFilename = `${objectName}_${geometryType}.dae`;
            
            // Create KML content that references the COLLADA model in files/ directory
            const kmlContent = this.generateKMLContent(objectName, latitude, longitude, altitude, geometryType, `files/${colladaFilename}`);
            
            // Create a KMZ file containing doc.kml and files/model.dae with sitch name prefix
            const kmzFilename = `${sitchName}_${objectName}_${geometryType}.kmz`;
            
            await this.saveAsKMZ(kmlContent, colladaContent, objectName, geometryType, kmzFilename);
            console.log(`KMZ file exported successfully as: ${kmzFilename}`);
            console.log(`COLLADA contains ${colladaResult.vertexCount} vertices, ${colladaResult.triangleCount} triangles`);
            console.log(`Material: ${colladaResult.materialInfo.color}, opacity: ${colladaResult.materialInfo.opacity}`);
            
            alert(`3D object exported successfully!\n\nFile saved:\n- ${kmzFilename} (KMZ archive with embedded 3D model)\n\nIMPORTANT:\n1. Open the KMZ file directly in Google Earth\n2. The 3D object will appear at the specified location\n3. No extraction needed - everything is packaged together!\n\nNote: KMZ is the standard format for 3D models in Google Earth.`);
            
        } catch (error) {
            console.error('Error exporting to KML:', error);
            alert('Error exporting to KML: ' + error.message);
        }
    }

    // Generate KML content for the 3D object
    generateKMLContent(name, latitude, longitude, altitude, geometryType, colladaFilename) {
        // Get object dimensions based on geometry type
        const dimensions = this.getObjectDimensions(geometryType);
        
        // Get material properties
        const materialInfo = this.getMaterialInfo();
        
        // Create description with object details
        const description = `
            <![CDATA[
            <h3>3D Object: ${name}</h3>
            <p><strong>Type:</strong> ${geometryType}</p>
            <p><strong>Position:</strong></p>
            <ul>
                <li>Latitude: ${latitude.toFixed(6)}°</li>
                <li>Longitude: ${longitude.toFixed(6)}°</li>
                <li>Altitude: ${altitude.toFixed(2)} m</li>
            </ul>
            <p><strong>Dimensions:</strong></p>
            <ul>
                ${dimensions.map(dim => `<li>${dim.name}: ${dim.value.toFixed(3)} ${dim.unit}</li>`).join('')}
            </ul>
            <p><strong>Material:</strong></p>
            <ul>
                <li>Type: ${materialInfo.type}</li>
                <li>Color: ${materialInfo.color}</li>
                <li>Opacity: ${materialInfo.opacity.toFixed(2)}</li>
                ${materialInfo.transparent ? '<li>Transparent: Yes</li>' : ''}
            </ul>
            <p><em>Exported from Sitrec</em></p>
            ]]>
        `;

        // Get object scale for proper sizing in Google Earth
        const scale = this.getObjectScale();

        // Generate KML with 3D model reference
        const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <name>${name} - ${geometryType}</name>
        <description>3D Object exported from Sitrec</description>
        
        <Placemark>
            <name>${name}</name>
            <description>${description}</description>
            <Model>
                <altitudeMode>absolute</altitudeMode>
                <Location>
                    <longitude>${longitude}</longitude>
                    <latitude>${latitude}</latitude>
                    <altitude>${altitude}</altitude>
                </Location>
                <Orientation>
                    <heading>0</heading>
                    <tilt>0</tilt>
                    <roll>0</roll>
                </Orientation>
                <Scale>
                    <x>${scale.x}</x>
                    <y>${scale.y}</y>
                    <z>${scale.z}</z>
                </Scale>
                <Link>
                    <href>${colladaFilename}</href>
                </Link>
            </Model>
        </Placemark>
    </Document>
</kml>`;

        return kml;
    }

    // Get object dimensions based on geometry type
    getObjectDimensions(geometryType) {
        const dimensions = [];
        
        switch (geometryType) {
            case 'sphere':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                break;
                
            case 'ellipsoid':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Horizontal Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.aspect !== undefined && this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Vertical Radius', value: this.geometryParams.radius * this.geometryParams.aspect, unit: 'm' });
                }
                break;
                
            case 'box':
                if (this.geometryParams.width !== undefined) {
                    dimensions.push({ name: 'Width', value: this.geometryParams.width, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                if (this.geometryParams.depth !== undefined) {
                    dimensions.push({ name: 'Depth', value: this.geometryParams.depth, unit: 'm' });
                }
                break;
                
            case 'capsule':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.totalLength !== undefined) {
                    dimensions.push({ name: 'Total Length', value: this.geometryParams.totalLength, unit: 'm' });
                }
                break;
                
            case 'cylinder':
                if (this.geometryParams.radiusTop !== undefined) {
                    dimensions.push({ name: 'Top Radius', value: this.geometryParams.radiusTop, unit: 'm' });
                }
                if (this.geometryParams.radiusBottom !== undefined) {
                    dimensions.push({ name: 'Bottom Radius', value: this.geometryParams.radiusBottom, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                break;
                
            default:
                // For other geometry types, try to get common parameters
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                break;
        }
        
        return dimensions;
    }

    // Save KML file with proper file type configuration
    async saveKMLFile(contents, suggestedName = 'object.kml') {
        try {
            // Use the File System Access API with KML file type
            const fileHandle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'KML Files',
                    accept: {
                        'application/vnd.google-earth.kml+xml': ['.kml'],
                        'text/xml': ['.kml'],
                    }
                }]
            });

            const writable = await fileHandle.createWritable();
            await writable.write(contents);
            await writable.close();

            console.log('KML file saved successfully!');
            return fileHandle.name;

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('File save was cancelled by user');
                throw new Error('File save cancelled');
            } else {
                console.error('Error saving KML file:', error);
                throw error;
            }
        }
    }

    // Get material information for KML description
    getMaterialInfo() {
        const material = this.material || this.object?.material;
        if (!material) {
            return {
                type: 'Unknown',
                color: '#ffffff',
                opacity: 1.0,
                transparent: false
            };
        }

        // Convert Three.js color to hex string
        const colorHex = material.color ? `#${material.color.getHexString()}` : '#ffffff';
        
        return {
            type: this.common.material || 'basic',
            color: colorHex,
            opacity: material.opacity || 1.0,
            transparent: material.transparent || false
        };
    }

    // Get object scale for KML model
    getObjectScale() {
        // Get the geometry bounds to determine appropriate scaling
        const geometry = this.geometry;
        if (geometry && geometry.boundingBox) {
            geometry.computeBoundingBox();
            const box = geometry.boundingBox;
            const size = Math.max(
                box.max.x - box.min.x,
                box.max.y - box.min.y,
                box.max.z - box.min.z
            );
            
            // Scale to ensure the model is visible in Google Earth (target size ~10-100 meters)
            let scale = 1.0;
            if (size < 1) {
                scale = 10.0; // Scale up very small objects
            } else if (size > 100) {
                scale = 50.0 / size; // Scale down very large objects
            }
            
            return { x: scale, y: scale, z: scale };
        }
        
        // Default scale - use 1.0 for normal sized objects
        return { x: 1.0, y: 1.0, z: 1.0 };
    }

    // Generate COLLADA (.dae) file content
    generateColladaContent(name, geometryType) {
        let geometry, material;
        
        // Handle both procedural geometry and loaded models
        if (this.modelOrGeometry === "model" && this.model) {
            // For loaded models, extract geometry from the first mesh
            let firstMesh = null;
            this.model.traverse((child) => {
                if (child.isMesh && !firstMesh) {
                    firstMesh = child;
                }
            });
            
            if (!firstMesh) {
                throw new Error('No mesh found in the loaded model');
            }
            
            geometry = firstMesh.geometry;
            material = firstMesh.material;
            geometryType = 'model';
        } else {
            // For procedural geometry
            geometry = this.geometry;
            material = this.material || this.object?.material;
            
            if (!geometry) {
                throw new Error('No geometry available for COLLADA export');
            }

            // Check if object is in wireframe or edges mode
            if (this.common.wireframe || this.common.edges) {
                throw new Error('Cannot export wireframe or edges geometry to COLLADA. Please disable wireframe/edges mode and try again.');
            }
        }

        // Get geometry data
        const vertices = this.getVerticesFromGeometry(geometry);
        const normals = this.getNormalsFromGeometry(geometry);
        const indices = this.getIndicesFromGeometry(geometry);
        
        // Get material properties
        const materialInfo = this.getMaterialInfo();
        
        // Generate unique IDs
        const geometryId = `${name}-geometry`;
        const materialId = `${name}-material`;
        const effectId = `${name}-effect`;
        
        // Create COLLADA XML content
        const collada = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
    <asset>
        <contributor>
            <authoring_tool>Sitrec</authoring_tool>
        </contributor>
        <created>${new Date().toISOString()}</created>
        <modified>${new Date().toISOString()}</modified>
        <unit name="meter" meter="1"/>
        <up_axis>Y_UP</up_axis>
    </asset>
    
    <library_effects>
        <effect id="${effectId}">
            <profile_COMMON>
                <technique sid="common">
                    <phong>
                        <emission>
                            <color sid="emission">0.0 0.0 0.0 1.0</color>
                        </emission>
                        <ambient>
                            <color sid="ambient">0.2 0.2 0.2 1.0</color>
                        </ambient>
                        <diffuse>
                            <color sid="diffuse">${this.colorToRGBA(materialInfo.color, materialInfo.opacity)}</color>
                        </diffuse>
                        <specular>
                            <color sid="specular">0.5 0.5 0.5 1.0</color>
                        </specular>
                        <shininess>
                            <float sid="shininess">20.0</float>
                        </shininess>
                        ${materialInfo.transparent && materialInfo.opacity < 1.0 ? `
                        <transparent opaque="A_ONE">
                            <color sid="transparent">1.0 1.0 1.0 1.0</color>
                        </transparent>
                        <transparency>
                            <float sid="transparency">${materialInfo.opacity}</float>
                        </transparency>` : ''}
                    </phong>
                </technique>
            </profile_COMMON>
        </effect>
    </library_effects>
    
    <library_materials>
        <material id="${materialId}" name="${name}-material">
            <instance_effect url="#${effectId}"/>
        </material>
    </library_materials>
    
    <library_geometries>
        <geometry id="${geometryId}" name="${name}-geometry">
            <mesh>
                <source id="${geometryId}-positions">
                    <float_array id="${geometryId}-positions-array" count="${vertices.length}">
                        ${vertices.join(' ')}
                    </float_array>
                    <technique_common>
                        <accessor source="#${geometryId}-positions-array" count="${vertices.length / 3}" stride="3">
                            <param name="X" type="float"/>
                            <param name="Y" type="float"/>
                            <param name="Z" type="float"/>
                        </accessor>
                    </technique_common>
                </source>
                
                <source id="${geometryId}-normals">
                    <float_array id="${geometryId}-normals-array" count="${normals.length}">
                        ${normals.join(' ')}
                    </float_array>
                    <technique_common>
                        <accessor source="#${geometryId}-normals-array" count="${normals.length / 3}" stride="3">
                            <param name="X" type="float"/>
                            <param name="Y" type="float"/>
                            <param name="Z" type="float"/>
                        </accessor>
                    </technique_common>
                </source>
                
                <vertices id="${geometryId}-vertices">
                    <input semantic="POSITION" source="#${geometryId}-positions"/>
                </vertices>
                
                <triangles material="material0" count="${indices.length / 3}">
                    <input semantic="VERTEX" source="#${geometryId}-vertices" offset="0"/>
                    <input semantic="NORMAL" source="#${geometryId}-normals" offset="0"/>
                    <p>${indices.join(' ')}</p>
                </triangles>
            </mesh>
        </geometry>
    </library_geometries>
    
    <library_visual_scenes>
        <visual_scene id="Scene" name="Scene">
            <node id="${name}" name="${name}" type="NODE">
                <instance_geometry url="#${geometryId}">
                    <bind_material>
                        <technique_common>
                            <instance_material symbol="material0" target="#${materialId}"/>
                        </technique_common>
                    </bind_material>
                </instance_geometry>
            </node>
        </visual_scene>
    </library_visual_scenes>
    
    <scene>
        <instance_visual_scene url="#Scene"/>
    </scene>
</COLLADA>`;

        return {
            content: collada,
            vertexCount: vertices.length / 3,
            triangleCount: indices.length / 3,
            materialInfo: materialInfo
        };
    }

    // Extract vertices from Three.js geometry
    getVerticesFromGeometry(geometry) {
        const positions = geometry.attributes.position;
        if (!positions) {
            throw new Error('Geometry has no position attribute');
        }
        
        // Convert vertices and ensure they're properly scaled for Google Earth
        const vertices = Array.from(positions.array);
        const transformedVertices = [];
        
        // Transform vertices to ensure proper orientation for Google Earth
        // Google Earth uses Y-up coordinate system
        for (let i = 0; i < vertices.length; i += 3) {
            const x = vertices[i];
            const y = vertices[i + 1];
            const z = vertices[i + 2];
            
            // Keep the same coordinate system but ensure reasonable scale
            transformedVertices.push(x, y, z);
        }
        
        return transformedVertices;
    }

    // Extract normals from Three.js geometry
    getNormalsFromGeometry(geometry) {
        let normals = geometry.attributes.normal;
        if (!normals) {
            // Compute normals if they don't exist - using optimized version
            fastComputeVertexNormals(geometry);
            normals = geometry.attributes.normal;
        }
        return Array.from(normals.array);
    }

    // Extract indices from Three.js geometry
    getIndicesFromGeometry(geometry) {
        const index = geometry.index;
        if (index) {
            return Array.from(index.array);
        } else {
            // Generate indices for non-indexed geometry
            const vertexCount = geometry.attributes.position.count;
            const indices = [];
            for (let i = 0; i < vertexCount; i++) {
                indices.push(i);
            }
            return indices;
        }
    }

    // Convert hex color to RGBA string for COLLADA
    colorToRGBA(hexColor, opacity = 1.0) {
        // Remove # if present
        const hex = hexColor.replace('#', '');
        
        // Parse RGB values
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        
        return `${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)} ${opacity.toFixed(6)}`;
    }

    // Save KML and COLLADA files as a KMZ archive with proper structure
    async saveAsKMZ(kmlContent, colladaContent, objectName, geometryType, suggestedName) {
        try {
            // Import JSZip dynamically
            const JSZip = (await import('jszip')).default;
            
            const kmz = new JSZip();
            
            // Add doc.kml file to root of KMZ (required name for KMZ format)
            kmz.file('doc.kml', kmlContent);
            
            // Create files/ directory and add COLLADA file
            const colladaFilename = `${objectName}_${geometryType}.dae`;
            kmz.file(`files/${colladaFilename}`, colladaContent);
            
            // Generate KMZ blob (which is just a ZIP with .kmz extension)
            const kmzBlob = await kmz.generateAsync({type: 'blob'});
            
            // Use File System Access API to save KMZ
            const fileHandle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'Google Earth KMZ Files',
                    accept: {
                        'application/vnd.google-earth.kmz': ['.kmz'],
                        'application/zip': ['.kmz'],
                    }
                }]
            });

            const writable = await fileHandle.createWritable();
            await writable.write(kmzBlob);
            await writable.close();

            console.log('KMZ file saved successfully!');
            return fileHandle.name;

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('KMZ file save was cancelled by user');
                throw new Error('KMZ file save cancelled');
            } else {
                console.error('Error saving KMZ file:', error);
                throw error;
            }
        }
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            color: this.color,
            modelOrGeometry: this.modelOrGeometry,
            model: this.selectModel,
            common: this.common,
            geometryParams: this.geometryParams,
            materialParams: this.materialParams,
            // might need a modelParams


        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.color = v.color;
        this.modelOrGeometry = v.modelOrGeometry;
        this.selectModel = v.model;



        // copy the values from v.common, v.geometryParams, v.materialParams
        // to this.common, this.geometryParams, this.materialParams
        // we need to copy the values, not just assign the object
        // because the GUI is referencing the values in this.common, etc
        // and so creating a new object would break the GUI
        for (const key in v.common) {
            this.common[key] = v.common[key];
        }

        if (this.modelOrGeometry === "geometry") {
            // we do an initial rebuild of geometry to set up the parameters
            // with this.common.geometry
            // otherwise parameters will get reset to defaults
            this.rebuild();
        }

        for (const key in v.geometryParams) {
            this.geometryParams[key] = v.geometryParams[key];
        }

        // First rebuildMaterial creates the correct param structure and UI
        // for the (possibly new) material type. This resets this.materialParams
        // with defaults and builds fresh GUI controllers.
        this.rebuildMaterial();

        // Now copy deserialized material params into the freshly created object.
        // The GUI controllers are bound to this.materialParams with .listen(),
        // so they'll reflect the restored values.
        if (v.materialParams) {
            for (const key in v.materialParams) {
                if (key in this.materialParams) {
                    this.materialParams[key] = v.materialParams[key];
                }
            }
        }

        // Migrate old 'specularcolor' to correct Three.js property names (Feb 2026)
        if (this.materialParams.specularcolor !== undefined) {
            const materialType = this.common.material;
            if (materialType === 'phong') {
                this.materialParams.specular = this.materialParams.specularcolor;
            } else {
                this.materialParams.specularColor = this.materialParams.specularcolor;
            }
            delete this.materialParams.specularcolor;
        }

        // Rebuild material again with the deserialized values.
        // Since the type hasn't changed, params won't be reset.
        this.rebuildMaterial();
        this.rebuild();



    }

//   // this is the function that adds the parameters to the GUI
    // it takes the geometryParams and materialParams objects
    // and adds them to the GUI
    // it also sets the default values for the parameters
    // and sets the tooltip for the parameters
    // the geometryParams and materialParams objects are passed in as arrays
    // so they can be used as a template for the GUI
    // the first element is the default value, the second element is the tooltip
    // the third element is the min value, the fourth element is the max value
    // the fifth element is the step value
    // the sixth element is the type of parameter (string, number, boolean, array)
    // the seventh element is the name of the parameter
    addParams(geometryParams, toHere, gui, isCommon=false) {
        const v = this.props;
        for (const key in geometryParams) {
            let params = geometryParams[key][0];
            let tip = geometryParams[key][1];


            // if the geometryParams[key] is an array of four numbers, then
            // set paramps to that array, and set tip to the key
            if (geometryParams[key].length === 4) {
                params = geometryParams[key];
                tip = key;
            }

            if (v[key] === undefined) {
                // if no value is given, then use the first value in the array
                // (the default value)
                // or the value itself if it's not an array
                if (Array.isArray(params) && key !== "color") {
                    v[key] = params[0];
                } else {
                    v[key] = params;
                }
            }
            toHere[key] = v[key];

            let controller;

            const colorNames = ["color", "emissive", "specularColor", "sheenColor", "baseColor"]
            if (colorNames.includes(key)) {
                // assume string values are colors
                // (might need to have an array of names of color keys, like "emissive"
              // add color picker
                // its going to be to controlling toHere[key]
                // which will be this.common.color
                // first we need to ensure it's in the correct format for lil-gui
                // which expect a hex string like "#RRGGBB"

                let passedColor = toHere[key];
                let color3;
                if (Array.isArray(passedColor)) {
                    // the only format three.js can't handle is an array
                    color3 = new Color(passedColor[0], passedColor[1], passedColor[2]);
                } else {
                    // otherwise it's a hex string, or a three.js color
                    color3 = new Color(passedColor);
                }
                toHere[key] = "#" + color3.getHexString();
                controller = gui.addColor(toHere, key).name(key).listen()
                    .onChange((v) => {
                        this.rebuild();
                        setRenderOne(true)
                    }).tooltip(tip);

            } else if (Array.isArray(params)) {

                const elastic = ["radius", "length", "height", "width", "depth", "tube", "innerRadius", "outerRadius", "height", "totalLength", "radiusTop", "radiusBottom",];
                const isElastic = elastic.includes(key);


                // is the firsts value in the array a number?
                if (typeof params[0] === "number") {
                    // and make a gui slider for the parameter
                    controller = gui.add(toHere, key, params[1], params[2], params[3]).name(key).listen()
                        .onChange((v) => {
                            this.rebuild();
                            setRenderOne(true)
                        }).tooltip(tip);
                    if (isElastic) {
                        // elastic means the range will expand 2x when you go of the right end
                        // and reset to the minimum when you go off the left end
                        // Upper limit not too important, so we just set it to 1000x the default
                        controller.elastic(params[2]/100, params[2] * 1000)
                    }

                } else {
                    // assume it's a string, so a drop-down
                    // make a drop-down for the parameter
                    controller = gui.add(toHere, key, params).name(key).listen()
                        .onChange((v) => {
                            if (key === "geometry") {
                                this.modelOrGeometry = "geometry"
                            }
                            this.rebuild();
                            setRenderOne(true)
                        }).tooltip(tip);
                }

            } else {
                // if it's not an array, then it's a boolean
                // so make a checkbox
                controller = gui.add(toHere, key).name(key).listen()
                    .onChange((v) => {
                        this.rebuild();
                        setRenderOne(true);
                        // Note: updateControlVisibility() is already called in rebuild(), so no need to call it again
                    }).tooltip(tip);
            }

            controller.isCommon = isCommon;

        }
    }

    updateControlVisibility() {
        // Define controller visibility rules
        // Each entry: [controllerProperty, showInModelMode, customLogic]
        const controllerVisibilityRules = [
            ['applyMaterial', true, null], // Show in model mode, hide in geometry mode
            ['selectModel', true, null], // Show in model mode, hide in geometry mode
            ['geometry', false, null], // Hide in model mode, show in geometry mode
            ['exportToKML', false, null], // Hide in model mode, show in geometry mode
        ];

        // Apply visibility rules for standard controllers
        controllerVisibilityRules.forEach(([controllerProperty, showInModelMode]) => {

            //  find the controller in this.gui.children
            // then show/hide it depending on the rule
            const controller = this.gui.children.find(c => c.property === controllerProperty);

            const isModelMode = this.modelOrGeometry === "model";

            if (controller) {
                if ((isModelMode && showInModelMode) || (!isModelMode && !showInModelMode)) {
                    controller.show();
                } else {
                    controller.hide();
                }
            } else {
                console.error(`Controller property '${controllerProperty}' not found in this.gui in updateControlVisibility`)
            }
        });

        // Handle material folder with custom logic (depends on both mode and applyMaterial setting)
        if (this.materialFolder) {
            if (this.modelOrGeometry === "model" && !this.common.applyMaterial) {
                this.materialFolder.hide();
            } else {
                this.materialFolder.show();
            }

            // Hide common material controls that don't apply to gradient ShaderMaterial
            const isGradient = this.common.material?.toLowerCase() === "gradient";
            const hideForGradient = ['wireframe', 'edges', 'depthTest', 'opacity', 'transparent'];
            for (const c of this.materialFolder.controllers) {
                if (hideForGradient.includes(c.property)) {
                    if (isGradient) {
                        c.hide();
                    } else {
                        c.show();
                    }
                }
            }
        }
    }




    rebuild() {
        let newType = false;
        if (this.modelOrGeometry !== this.lastModelOrGeometry) {
            this.lastModelOrGeometry = this.modelOrGeometry;
            newType = true;
        }

        this.updateControlVisibility();

        // remove the BB measure, in case we don't rebuild them
        NodeMan.disposeRemove(this.measureX, true);
        this.measureX  = undefined;
        NodeMan.disposeRemove(this.measureY, true);
        this.measureY  = undefined;
        NodeMan.disposeRemove(this.measureZ, true);
        this.measureZ  = undefined;


        const v = this.props;

        const common = this.common;

        this.rebuildMaterial();


        if (this.modelOrGeometry === "model") {
            // Remove geometry parameters from UI when switching to model mode
            if (newType) {
                this.destroyNonCommonUI(this.gui);
            }

            // load the model if differ  ent, this will be async
            // here this.selectModel is the NAME of the model (id or drag and drop filename
            // and this.currentModel points to a model def object (which currently just just a file)
            // so this.currentModel.file is the filename of the last loaded file
            const model = ModelFiles[this.selectModel];

            if (model !== this.currentModel || newType) {

                // if the new model and the old model are BOTH dynamic
                // then we need to remove the old model from the file manager and the GUI
                // Otherwise we'll accumulate models that will get loaded but are not used
                // if the new model has not been loaded yet, then we also need to remove the old model
                // we do that test first, as isUnhosted will assert if the file doesn't exist

                if (this.currentModel
                    && FileManager.isUnhosted(this.currentModel.file)
                    && (!FileManager.exists(this.selectModel) || FileManager.isUnhosted(this.selectModel))
                ) {
                    console.log(`Removing unhosted file: ${this.currentModel.file}, replacing with ${model.file}`)
                    FileManager.disposeRemove(this.currentModel.file);
                    // will need to remove from GUI. after we implement adding it ...

                }


                this.currentModel = model;


                //const loader = new GLTFLoader();
                console.log("LOADING NEW GLTF model: ", model.file);

                Globals.pendingActions++;
                loadGLTFModel(model.file, gltf => {
                    // since it's async, we might now be rendering a geometry
                    // If so, then don't add the model to the group
                    if (this.modelOrGeometry === "model") {

                        // destroy the existing object AFTER the new one is loaded
                        // otherwise we might start loading a new object before the last one had finished loading
                        // so the first one will still get added
                        this.destroyObject();
                        this.destroyLights();

                        this.model = gltf.scene;

                        if (Globals.shadowsEnabled) {
                            this.model.castShadow = true;
                            this.model.receiveShadow = true;
                        }

                        this.extractLightsFromModel(this.model);

                        this.group.add(this.model);
                        
                        // Cache the bounding sphere in local coordinates for efficient camera collision detection
                        this.cachedBoundingSphere = computeGroupBoundingSphere(this.model);
                        console.log("Cached bounding sphere for model:", model.file, "radius:", this.cachedBoundingSphere.radius);

                        // Cache half extents of the local bounding box for gradient mapping
                        const modelBox = computeLocalBoundingBox(this.model);
                        this.cachedHalfHeight = (modelBox.max.y - modelBox.min.y) / 2;
                        this.cachedHalfLength = (modelBox.max.z - modelBox.min.z) / 2;

                        // Cache the height from center to lowest point for ground clamping
                        this.cachedCenterToLowestPoint = computeCenterToLowestPoint(this.model);
                        console.log("Cached center to lowest point for model:", model.file, "height:", this.cachedCenterToLowestPoint);
                        
                        this.propagateLayerMask()
                        this.recalculate()
                        this.applyMaterialToModel();
                        this.rebuildBoundingBox();
                        console.log("ADDED TO SCENE : ", model.file);
                        setRenderOne(true);

                    }
                    Globals.pendingActions--;
                }, (error) => {
                    console.error("Failed to load GLTF model:", model.file, error);
                    Globals.pendingActions--;
                });
            }


            if (this.common.applyMaterial) {
                this.applyMaterialToModel();
            } else {
                // restore the original materials
                if (this.model) {
                    this.model.traverse((child) => {
                        if (child.isMesh && child.originalMaterial) {
                            child.material = child.originalMaterial;
                            child.originalMaterial = undefined;
                        }
                    });
                }
            }
            this.rebuildBoundingBox();
            return;
        }


        this.destroyObject();
        this.destroyLights();

        // set up inputs based on the geometry type
        // add the defaults if a parameter is missing
        // and add UI controls for the parameters
        const geometryType = common.geometry.toLowerCase();
        const geometryDef = gTypes[geometryType];
        assert(geometryDef !== undefined, "Unknown geometry type: " + geometryType)
        const geometryParams = geometryDef.params;
        // for all the parameters in the geometry type
        // add them to the geometryParams object
        // (either the passed value, or a default)



        // if the geometry or material type has changed, or if we're switching from model to geometry mode
        // then delete all the geometry-specific parameters and re-create them
        if (this.lastGeometry !== common.geometry || newType) {
            this.destroyNonCommonUI(this.gui);

            // and re-create them
            this.geometryParams = {}
            this.addParams(geometryParams, this.geometryParams, this.gui);

            // move the material folder to the end after adding geometry parameters
            this.materialFolder.moveToEnd();

            this.lastGeometry = common.geometry;
        }


        // // map them to the variables in this.geometryParams
        const params = Object.keys(this.geometryParams)
            .map(key => this.geometryParams[key]);

        this.geometry = new geometryDef.g(...params);

        // Apply special geometry-specific rotation adjustments to the geometry itself
        // These are baked-in rotations that are specific to certain geometry types
        const geometryRotateX = ((common.geometry === "capsule" || common.geometry === "tictac") ? 90 : 0);
        if (geometryRotateX) {
            this.geometry.rotateX(geometryRotateX * Math.PI / 180);
        }

        // Note: User-defined rotations (rotateX, rotateY, rotateZ) are now applied 
        // as transforms in preRender() instead of being baked into the geometry

        if (common.wireframe) {
            this.wireframe = new WireframeGeometry(this.geometry);
            this.object = new LineSegments(this.wireframe);
        } else if (common.edges) {
            this.wireframe = new EdgesGeometry(this.geometry);
            this.object = new LineSegments(this.wireframe);
        } else {
            this.object = new Mesh(this.geometry, this.material);
        }

        // const matColor = new Color(common.color)
        // this.object.material.color = matColor;

        this.object.material.depthTest = common.depthTest ?? true;
        this.object.material.opacity = common.opacity ?? 1;
        this.object.material.transparent = common.transparent ?? (v.opacity < 1.0);

        if (Globals.shadowsEnabled) {
            this.object.castShadow = true;
            this.object.receiveShadow = true;
        }
        this.group.add(this.object);
        
        // Cache the bounding sphere in local coordinates for efficient camera collision detection
        // For geometry objects, compute it from the geometry's bounding sphere
        this.geometry.computeBoundingSphere();
        this.cachedBoundingSphere = this.geometry.boundingSphere.clone();

        // Cache the height from center to lowest point for ground clamping
        // For geometry objects, compute it from the geometry's bounding box
        this.geometry.computeBoundingBox();
        const geomBox = this.geometry.boundingBox;
        const geomCenter = new Vector3();
        geomBox.getCenter(geomCenter);
        this.cachedCenterToLowestPoint = geomCenter.y - geomBox.min.y;

        // Cache half extents of the bounding box for gradient mapping
        this.cachedHalfHeight = (geomBox.max.y - geomBox.min.y) / 2;
        this.cachedHalfLength = (geomBox.max.z - geomBox.min.z) / 2;
        
        this.propagateLayerMask()
        this.recalculate()

        this.rebuildBoundingBox();

    }


    lightNamesToIgnore = [
        "Sky_Dome",
        "Light",  // the default light name in the blender cube scene, so often used, but not needed
        "Moon_Light",
        "Lensflare_Source",
        "Sun_light",


    ]

    // model is a THREE.Scene loaded from a GLTF
    // it will have children which are lights
    // we detect them and turn them off
    extractLightsFromModel(model) {
        this.destroyLights();
        
        // First pass: collect all lights that are not ignored
        const validLights = [];
        model.traverse((child) => {
            if (child.isLight) {
                // turn off the light
                child.visible = false;

                // check if the light name is in the list of names to ignore
                if (this.lightNamesToIgnore.includes(child.name)) {
                    // if it is, then just skip it
                    return;
                }
                
                validLights.push(child);
            }
        });
        
        // If we have valid lights, create the Lights folder
        if (validLights.length > 0) {
            this.lightsFolder = this.gui.addFolder("Lights").close();
            
            // Create individual light folders and CNode3DLight instances
            for (const child of validLights) {
                //check if it's a point light
                if (child.isPointLight) {
                    // if it's a point light, we can use it as a CNode3DLight
                    // so we create a CNode3DLight for it
                    // and add it to the group
                    // this will allow us to control the light from the GUI
                    // and also to turn it on/off
                }

                // Create a folder for this specific light
                const lightFolder = this.lightsFolder.addFolder(child.name).close();

                const light = new CNode3DLight({
                    id: this.id + "_" + child.name,
                    light: child,
                    scene: this.group,
                    gui: lightFolder,
                })

                this.lights.push(light);
            }
        }
    }


    rebuildBoundingBox(force = true)
    {

        // if we are displauing a bonding box, then do it
        if (this.displayBoundingBox) {

            // only recalculate the box if forced
            if (force) {


                if (this.modelOrGeometry === "model") {
                    // the model might not be loaded yet
                    // so just skip it if it's not
                    if (this.model !== undefined) {
                        // detach from the group
                        this.group.remove(this.model);

                        // ensure the matrix is up to date
                        this.model.updateMatrixWorld(true);

                        // store the original matrix
                        const matrix = this.model.matrix.clone();
                        // set the matrix to the identity
                        this.model.matrix.identity();
                        // update the world matrix
                        this.model.updateWorldMatrix(true, true);


                        this.boundingBox = new Box3();
                        this.boundingBox.setFromObject(this.model);

                        // restore the original matrix
                        this.model.matrix.copy(matrix);
                        this.model.updateWorldMatrix(true, true);
                        // re-attach to the group
                        this.group.add(this.model);

                        if (this.layers) {
                            this.group.layers.mask = this.layers;
                            propagateLayerMaskObject(this.group);
                        }
                    }

                } else {
                    this.object.geometry.computeBoundingBox();
                    this.boundingBox = this.object.geometry.boundingBox;
                }
            }

            if (!this.boundingBox) {
                return;
            }


            const min = this.boundingBox.min.clone();
            const max = this.boundingBox.max.clone();

            // transform them by this.group
            min.applyMatrix4(this.group.matrixWorld);
            max.applyMatrix4(this.group.matrixWorld);

            // calculate all the corners of the bounding box
            const corners = [];
            for (let i = 0; i < 8; i++) {
                const x = i & 1 ? max.x : min.x;
                const y = i & 2 ? max.y : min.y;
                const z = i & 4 ? max.z : min.z;
                corners.push(V3(x, y, z));
            }

            // calculate three edges of the bounding box about
            // the corner which is closest to the camera

            const cameraNode = NodeMan.get("mainCamera");
            const camPos = cameraNode.camera.position;
            let closest = 0;
            let closestDist = 1000000;
            for (let i = 0; i < 8; i++) {
                const dist = corners[i].distanceTo(camPos);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = i;
                }
            }

            // only rebuild it if the closest corner has changed
            // or forced (some external change, like size)
            if (force || this.lastClosest !== closest) {

                this.lastClosest = closest;

                // now we have the closest corner, we can calculate the three edges
                const AX = corners[closest];
                const BX = corners[closest ^ 1];
                const AY = corners[closest];
                const BY = corners[closest ^ 2];
                const AZ = corners[closest];
                const BZ = corners[closest ^ 4];

                //
                NodeMan.disposeRemove(this.measureX, true);
                NodeMan.disposeRemove(this.measureY, true);
                NodeMan.disposeRemove(this.measureZ, true);

                this.measureX = new CNodeMeasureAB({
                    id: this.id + "_AX",
                    A: AX,
                    B: BX,
                    color: "#ff8080",
                    text: "X",
                    unitType: "small"
                })
                this.measureY = new CNodeMeasureAB({
                    id: this.id + "_AY",
                    A: AY,
                    B: BY,
                    color: "#80ff80",
                    text: "X",
                    unitType: "small"
                })
                this.measureZ = new CNodeMeasureAB({
                    id: this.id + "_AZ",
                    A: AZ,
                    B: BZ,
                    color: "#8080ff",
                    text: "X",
                    unitType: "small"
                })
            }
        }
    }

    rebuildMaterial()
    {
        const materialType = this.common.material.toLowerCase();
        const materialDef = materialTypes[materialType];
        assert(materialDef !== undefined, "Unknown material type: " + materialType)

        if (this.lastMaterial !== materialType) {

            this.destroyNonCommonUI(this.materialFolder)

            this.lastMaterial = materialType
            const materialParams = materialDef.params;
            this.materialParams = {}
            this.addParams(materialParams, this.materialParams, this.materialFolder);
        }

        if (this.material)  {
            this.material.dispose();
        }

        const params = {...this.materialParams};
        const isEnvMap = materialType === "envmap";
        const isGradient = materialType === "gradient";

        if (isGradient) {
            this.disposeCubeCamera();
            const palette = this.materialParams.gradientPalette ?? "Ironbow";
            const gradientTexture = createGradientTexture(palette);

            this.material = new ShaderMaterial({
                uniforms: {
                    gradientMap: { value: gradientTexture },
                    gradientCenter: { value: new Vector3() },
                    gradientDir: { value: new Vector3(0, -1, 0) },
                    gradientHalfHeight: { value: 1.0 },
                    gradientScale: { value: this.materialParams.scale ?? 100 },
                    gradientShift: { value: 0.0 },
                    useLeadingEdge: { value: 0.0 },
                    reverseGradient: { value: this.materialParams.reverse ? 1.0 : 0.0 },
                    baseColor: { value: new Color(this.materialParams.baseColor ?? "black") },
                    baseMix: { value: this.materialParams.baseMix ?? 0.0 },
                    ...sharedUniforms,
                },
                vertexShader: gradientVertexShader,
                fragmentShader: gradientFragmentShader,
                fog: false,
            });
        } else if (isEnvMap) {
            delete params.envMapResolution;
            this.setupCubeCamera();
            this.material = new materialDef.m(params);
        } else {
            this.disposeCubeCamera();
            this.material = new materialDef.m(params);
        }
    }

    setupCubeCamera() {
        const resolution = this.materialParams.envMapResolution ?? 256;
        if (this._envMapResolution === resolution && this._perViewEnvMaps) return;
        this.disposeCubeCamera();
        this._envMapResolution = resolution;
        this._perViewEnvMaps = new Map();
    }

    getOrCreateEnvMap(renderer) {
        const key = renderer.domElement;
        let entry = this._perViewEnvMaps.get(key);
        if (!entry) {
            const rt = new WebGLCubeRenderTarget(this._envMapResolution, {
                type: HalfFloatType,
            });
            const cam = new CubeCamera(0.1, 100000, rt);
            entry = {renderTarget: rt, cubeCamera: cam};
            this._perViewEnvMaps.set(key, entry);
        }
        return entry;
    }

    disposeCubeCamera() {
        if (this._perViewEnvMaps) {
            for (const entry of this._perViewEnvMaps.values()) {
                entry.renderTarget.dispose();
            }
            this._perViewEnvMaps.clear();
            this._perViewEnvMaps = null;
        }
        this._envMapResolution = null;
    }

    applyMaterialToModel() {
        // iterate over all the meshes in the model
        // and apply this.material to them

        if (this.model === undefined || !this.common.applyMaterial) {
            return;
        }
        const isShader = this.material && this.material.isShaderMaterial;
        this.model.traverse((child) => {
            if (child.isMesh) {
                if (child.originalMaterial === undefined) {
                    // save the original material so we can restore it later
                    child.originalMaterial = child.material;
                }
                // ShaderMaterial is shared (not cloned) to avoid texture/uniform issues
                child.material = isShader ? this.material : this.material.clone();
                // // if the material has a map, then set the colorSpace to NoColorSpace
                // if (child.material.map) {
                //     child.material.map.colorSpace = NoColorSpace;
                // }
                // if (child.material.emissiveMap) {
                //     child.material.emissiveMap.colorSpace = NoColorSpace;
                // }
            }
        });

    }


    destroyNonCommonUI(gui) {
        // delete the non-common children of this.gui
        // iterate backwards so we can delete as we go
        for (let i = gui.controllers.length - 1; i >= 0; i--) {
            let c = gui.controllers[i];
            if (!c.isCommon) {
                c.destroy();
                // Explicitly remove the controller from the array if destroy() didn't do it
                if (gui.controllers[i] === c) {
                    gui.controllers.splice(i, 1);
                }
            }
        }
    }

    destroyObject() {
        if (this.object) {
            this.object.geometry.dispose();
            this.object.material.dispose();
            this.group.remove(this.object);
            this.object = undefined;
        }

        // remove any lights from the model
        this.destroyLights();

        if (this.material) {
            this.material.dispose();
        }

        if (this.model) {
            this.group.remove(this.model);
            disposeScene(this.model)
            this.model = undefined
        }

    }

    destroyLights() {
        if (this.lights !== undefined) {
            // if we have lights, then dispose them
            for (const light of this.lights) {
                NodeMan.disposeRemove(light, true);
            }
        }
        this.lights = [];
        
        // Clean up the lights folder if it exists
        if (this.lightsFolder) {
            this.lightsFolder.destroy();
            this.lightsFolder = null;
        }
    }

    preRender(view) {
        const common = this.common;
        if (!common) return;
        
        const target = this.group;
        if (target && (common.rotateX || common.rotateY || common.rotateZ)) {
            this.needsUndo = true;
            
            this.origPosition = target.position.clone();
            this.origQuaternion = target.quaternion.clone();
            this.origScale = target.scale.clone();
            
            if (common.rotateY) {
                target.rotateY(common.rotateY * Math.PI / 180);
            }

            if (common.rotateX) {
                target.rotateX(common.rotateX * Math.PI / 180);
            }

            if (common.rotateZ) {
                target.rotateZ(common.rotateZ * Math.PI / 180);
            }
            
            target.updateMatrix();
            target.updateMatrixWorld();
        }

        this.updateEnvMap(view);

        // Update gradient material uniforms with direction and extent data.
        // All modes use world-space positions so the gradient is consistent across
        // model hierarchies with varying internal transforms.
        if (this.material && this.material.isShaderMaterial && this.material.uniforms.gradientHalfHeight) {
            if (this.cachedBoundingSphere) {
                const direction = this.materialParams.gradientDirection ?? "Model Down";

                // Center is always in world space
                const center = this.cachedBoundingSphere.center.clone();
                center.applyMatrix4(this.group.matrixWorld);

                const isLeadingEdge = direction === "Leading Edge";
                const usesMotion = direction === "Motion Forward" || isLeadingEdge;

                let dir;
                if (usesMotion) {
                    dir = this.getMotionForwardVector();
                } else if (direction === "World Down") {
                    dir = new Vector3(0, -1, 0);
                } else {
                    // Model Down: extract the object's local -Y axis in world space
                    // from the group's world matrix. This accounts for any internal
                    // model rotations and user-applied rotations.
                    dir = new Vector3(0, -1, 0);
                    dir.transformDirection(this.group.matrixWorld);
                }

                this.material.uniforms.useLeadingEdge.value = isLeadingEdge ? 1.0 : 0.0;

                // Use half-length (Z) for motion-based modes, half-height (Y) for down modes
                const halfExtent = usesMotion
                    ? (this.cachedHalfLength ?? this.cachedBoundingSphere.radius)
                    : (this.cachedHalfHeight ?? this.cachedBoundingSphere.radius);
                const shift = this.materialParams.shift ?? 0;
                if (isLeadingEdge) {
                    // Leading Edge uses dot product space (0-1 unit diameter),
                    // so shift is applied directly in the shader as an offset to d.
                    this.material.uniforms.gradientShift.value = shift / 100;
                } else {
                    // Position-based modes: shift the center along the direction
                    this.material.uniforms.gradientShift.value = 0;
                    if (shift !== 0) {
                        center.addScaledVector(dir, shift / 100 * halfExtent * 2);
                    }
                }

                this.material.uniforms.gradientCenter.value.copy(center);
                this.material.uniforms.gradientDir.value.copy(dir);
                this.material.uniforms.gradientHalfHeight.value = halfExtent;
                this.material.uniforms.gradientScale.value = this.materialParams.scale ?? 100;
            }
        }
    }

    updateEnvMap(view) {
        if (!this._perViewEnvMaps || !view.renderer) return;

        const {renderTarget, cubeCamera} = this.getOrCreateEnvMap(view.renderer);

        this.material.envMap = renderTarget.texture;
        this.applyEnvMapToModel(renderTarget.texture);

        this.group.visible = false;

        cubeCamera.position.setFromMatrixPosition(this.group.matrixWorld);

        for (const child of cubeCamera.children) {
            if (child.isCamera) {
                child.layers.mask = LAYER.MASK_LOOKRENDER;
            }
        }

        const savedBackground = GlobalScene.background;
        if (view.isIR) {
            GlobalScene.background = new Color(0xFFFFFF);
        } else {
            const sunNode = NodeMan.get("theSun", true);
            if (sunNode) {
                GlobalScene.background = sunNode.calculateSkyColor(cubeCamera.position);
            }
        }

        const savedRenderTarget = view.renderer.getRenderTarget();

        cubeCamera.update(view.renderer, GlobalScene);

        view.renderer.setRenderTarget(savedRenderTarget);
        GlobalScene.background = savedBackground;

        this.group.visible = true;
    }

    // Find the source track that drives this object's position via controllers
    getSourceTrack() {
        for (const inputID in this.inputs) {
            const input = this.inputs[inputID];
            if (input.isController && input.in && input.in.sourceTrack) {
                return input.in.sourceTrack;
            }
        }
        return null;
    }

    // Compute the forward direction from the object's motion (velocity vector)
    // Returns a normalized world-space direction vector, or down if unavailable
    getMotionForwardVector() {
        const track = this.getSourceTrack();
        if (track) {
            const f = par.frame;
            const maxF = (track.frames ?? Sit.frames) - 1;
            // Use central difference when possible, forward/backward at edges
            const f0 = Math.max(0, Math.min(f - 1, maxF));
            const f1 = Math.max(0, Math.min(f + 1, maxF));
            if (f0 !== f1) {
                const p0 = track.p(f0);
                const p1 = track.p(f1);
                const dir = p1.sub(p0);
                if (dir.lengthSq() > 0) {
                    return dir.normalize();
                }
            }
        }
        // Fallback: use world down if no track or zero velocity
        return new Vector3(0, -1, 0);
    }

    applyEnvMapToModel(texture) {
        if (!this.model) return;
        this.model.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material.envMap = texture;
                child.material.needsUpdate = true;
            }
        });
    }
    
    postRender(view) {
        // Restore the original transformation state
        if (this.needsUndo && this.group && this.origQuaternion) {
            // Restore the original position, quaternion, and scale
            this.group.position.copy(this.origPosition);
            this.group.quaternion.copy(this.origQuaternion);
            this.group.scale.copy(this.origScale);
            
            // Update matrices after restoring state
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
            this.needsUndo = false;
        }
    }

    startReflectionAnalysis() {
        // Clean up any previous arrows
        this.cleanUpReflectionAnalysis();

        // Apply rotation (same as preRender) so raycasting sees the rotated geometry
        const common = this.common;
        let needsRotationUndo = false;
        let savedQuaternion;
        if (common && this.group && (common.rotateX || common.rotateY || common.rotateZ)) {
            needsRotationUndo = true;
            savedQuaternion = this.group.quaternion.clone();
            if (common.rotateY) this.group.rotateY(common.rotateY * Math.PI / 180);
            if (common.rotateX) this.group.rotateX(common.rotateX * Math.PI / 180);
            if (common.rotateZ) this.group.rotateZ(common.rotateZ * Math.PI / 180);
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
        }

        const lookCameraNode = NodeMan.get("lookCamera", false);
        if (!lookCameraNode) {
            console.warn("Reflection Analysis: no lookCamera found");
            return;
        }
        const camera = lookCameraNode.camera;

        const terrainNode = NodeMan.get("TerrainModel", false);
        if (!terrainNode) {
            console.warn("Reflection Analysis: no TerrainModel found");
            return;
        }

        if (!this.cachedBoundingSphere) {
            console.warn("Reflection Analysis: no bounding sphere cached");
            return;
        }

        // Get object world position and bounding sphere radius in world space
        const objectWorldPos = new Vector3();
        this.group.getWorldPosition(objectWorldPos);
        const worldScale = new Vector3();
        this.group.getWorldScale(worldScale);
        const worldRadius = this.cachedBoundingSphere.radius * Math.max(worldScale.x, worldScale.y, worldScale.z);

        console.log("Reflection Analysis: objectWorldPos", objectWorldPos);
        console.log("Reflection Analysis: worldScale", worldScale, "worldRadius", worldRadius);
        console.log("Reflection Analysis: cachedBoundingSphere radius", this.cachedBoundingSphere.radius, "center", this.cachedBoundingSphere.center);

        // Check if object is in front of the camera
        const toObject = objectWorldPos.clone().sub(camera.position);
        const cameraDir = new Vector3();
        camera.getWorldDirection(cameraDir);
        console.log("Reflection Analysis: camera pos", camera.position, "dir", cameraDir, "dot", toObject.dot(cameraDir));
        if (toObject.dot(cameraDir) < 0) {
            console.warn("Reflection Analysis: object is behind the camera");
            return;
        }

        // Project the bounding sphere center to NDC
        const centerNDC = objectWorldPos.clone().project(camera);
        console.log("Reflection Analysis: centerNDC", centerNDC);

        // Compute NDC extent by offsetting by the world-space radius along camera's right and up
        const camRight = new Vector3();
        const camUp = new Vector3();
        camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

        const edgePointRight = objectWorldPos.clone().add(camRight.clone().multiplyScalar(worldRadius));
        const edgeNDCRight = edgePointRight.project(camera);
        const ndcRadiusX = Math.abs(edgeNDCRight.x - centerNDC.x);

        const edgePointUp = objectWorldPos.clone().add(camUp.clone().multiplyScalar(worldRadius));
        const edgeNDCUp = edgePointUp.project(camera);
        const ndcRadiusY = Math.abs(edgeNDCUp.y - centerNDC.y);

        // Add a small margin
        const margin = 1.1;
        const halfExtentX = ndcRadiusX * margin;
        const halfExtentY = ndcRadiusY * margin;

        console.log("Reflection Analysis: NDC extents X", halfExtentX, "Y", halfExtentY);

        const gridSize = this.reflectionGridSize;
        const raycaster = new Raycaster();

        let objectHitCount = 0;
        let terrainHitCount = 0;
        let noObjectHitCount = 0;
        let noFaceCount = 0;
        let backFaceCount = 0;
        let noTerrainHitCount = 0;
        let skippedClipCount = 0;
        let totalTerrainDist = 0;
        let totalPathLength = 0;
        let minPathLength = Infinity;
        let maxPathLength = -Infinity;

        for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
                // Map grid cell to NDC coordinates centered on the object
                const u = gridSize > 1 ? gx / (gridSize - 1) : 0.5;
                const v = gridSize > 1 ? gy / (gridSize - 1) : 0.5;
                const ndcX = centerNDC.x + (u * 2 - 1) * halfExtentX;
                const ndcY = centerNDC.y + (v * 2 - 1) * halfExtentY;

                const arrowId = `ReflAnalysis_${this.id}_${gx}_${gy}`;

                // Skip points outside clip space
                if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
                    skippedClipCount++;
                    continue;
                }

                const ndcPoint = new Vector2(ndcX, ndcY);
                raycaster.setFromCamera(ndcPoint, camera);
                raycaster.layers.enableAll();

                // Intersect with this object's group
                const intersects = raycaster.intersectObjects([this.group], true);
                if (intersects.length === 0) {
                    noObjectHitCount++;
                    continue;
                }

                const hit = intersects[0];
                objectHitCount++;

                if (!hit.face) {
                    noFaceCount++;
                    continue;
                }

                // Get the world-space normal from the face
                const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();

                // Compute the incident direction (from camera toward hit point)
                const incident = raycaster.ray.direction.clone().normalize();

                // Reflect: r = d - 2(d·n)n
                const dotDN = incident.dot(worldNormal);
                // Only reflect if the ray hits the front face (normal facing toward camera)
                if (dotDN >= 0) {
                    backFaceCount++;
                    continue;
                }
                const reflected = incident.clone().sub(worldNormal.clone().multiplyScalar(2 * dotDN)).normalize();

                // Trace reflected ray against terrain
                const reflectedRaycaster = new Raycaster(hit.point.clone(), reflected);
                reflectedRaycaster.layers.mask |= 0xFFFFFFFF; // match all layers

                const terrainHit = terrainNode.getClosestIntersect(reflectedRaycaster);
                if (!terrainHit) {
                    noTerrainHitCount++;
                    continue;
                }

                // Terrain hit — draw in green
                terrainHitCount++;
                const terrainDist = hit.point.distanceTo(terrainHit.point);
                const cameraToObject = camera.position.distanceTo(hit.point);
                const pathLength = cameraToObject + terrainDist;
                totalTerrainDist += terrainDist;
                totalPathLength += pathLength;
                if (pathLength < minPathLength) minPathLength = pathLength;
                if (pathLength > maxPathLength) maxPathLength = pathLength;

                DebugArrowAB(arrowId, hit.point.clone(), terrainHit.point.clone(), "#00ff00", true, GlobalScene, 5);
                this.reflectionArrowIds.push(arrowId);
            }
        }

        // Compute "behind object" distance: ray from camera through object center to terrain
        let behindObjectDist = 0;
        const behindArrowId = `ReflAnalysis_${this.id}_behind`;
        const behindDir = objectWorldPos.clone().sub(camera.position).normalize();
        const behindRaycaster = new Raycaster(camera.position.clone(), behindDir);
        behindRaycaster.layers.enableAll();
        const behindHit = terrainNode.getClosestIntersect(behindRaycaster);
        if (behindHit) {
            behindObjectDist = camera.position.distanceTo(behindHit.point);
            DebugArrowAB(behindArrowId, objectWorldPos.clone(), behindHit.point.clone(), "#ff00ff", true, GlobalScene, 5);
            this.reflectionArrowIds.push(behindArrowId);
        }

        // Compute stats
        const distToObject = camera.position.distanceTo(objectWorldPos);
        const percentGround = objectHitCount > 0 ? (terrainHitCount / objectHitCount) * 100 : 0;
        const avgTerrainDist = terrainHitCount > 0 ? totalTerrainDist / terrainHitCount : 0;
        const avgPathLength = terrainHitCount > 0 ? totalPathLength / terrainHitCount : 0;
        const pathFraction = (behindObjectDist > 0 && avgPathLength > 0) ? avgPathLength / behindObjectDist : 0;
        if (terrainHitCount === 0) { minPathLength = 0; maxPathLength = 0; }

        console.log(`Reflection Analysis results for ${this.id}:`);
        console.log(`  Grid: ${gridSize}x${gridSize} = ${gridSize * gridSize} rays`);
        console.log(`  Skipped (outside clip): ${skippedClipCount}`);
        console.log(`  No object hit: ${noObjectHitCount}`);
        console.log(`  Object hits: ${objectHitCount}`);
        console.log(`    No face: ${noFaceCount}`);
        console.log(`    Back face: ${backFaceCount}`);
        console.log(`    No terrain hit: ${noTerrainHitCount}`);
        console.log(`    Terrain hits: ${terrainHitCount}`);

        // Restore rotation
        if (needsRotationUndo) {
            this.group.quaternion.copy(savedQuaternion);
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
        }

        // Create or update the results text view
        this.showReflectionResults({
            gridSize, objectHitCount, terrainHitCount,
            noObjectHitCount, noFaceCount, backFaceCount,
            noTerrainHitCount, skippedClipCount,
            distToObject, percentGround, avgTerrainDist, avgPathLength,
            minPathLength, maxPathLength,
            behindObjectDist, pathFraction,
        });

        setRenderOne(true);
    }

    showReflectionResults(stats) {
        const viewId = `ReflAnalysisView_${this.id}`;

        // Create the view if it doesn't exist yet
        if (!this.reflectionView) {
            this.reflectionView = new CNodeViewText({
                id: viewId,
                title: `Reflection: ${this.id}`,
                idPrefix: "refl-view",
                draggable: true,
                resizable: true,
                freeAspect: true,
                left: 0.01, top: 0.05, width: 0.30, height: 0.45,
                visible: true,
                manualScroll: true,
                maxMessages: 0,
            });
        }

        const v = this.reflectionView;
        v.clearOutput();
        v.show(true);

        const nm = (value) => `${(value / 1852).toFixed(2)} NM`;
        const grid = stats.gridSize;

        v.addMessage(`=== Reflection Analysis: ${this.id} ===`);
        v.addMessage(`Grid: ${grid}x${grid} = ${grid * grid} rays`);
        v.addMessage(``);
        v.addMessage(`--- Ray Counts ---`);
        v.addMessage(`Object hits:      ${stats.objectHitCount} / ${grid * grid - stats.skippedClipCount}`);
        v.addMessage(`  No face:        ${stats.noFaceCount}`);
        v.addMessage(`  Back face:      ${stats.backFaceCount}`);
        v.addMessage(`  No terrain hit: ${stats.noTerrainHitCount}`);
        v.addMessage(`  Terrain hits:   ${stats.terrainHitCount}`);
        v.addMessage(`No object hit:    ${stats.noObjectHitCount}`);
        if (stats.skippedClipCount > 0) {
            v.addMessage(`Skipped (clip):   ${stats.skippedClipCount}`);
        }
        v.addMessage(``);
        v.addMessage(`--- Results ---`);
        v.addMessage(`Percent ground:        ${stats.percentGround.toFixed(1)}%`);
        v.addMessage(`Dist to object:        ${nm(stats.distToObject)}`);
        v.addMessage(`Avg terrain dist:      ${nm(stats.avgTerrainDist)}`);
        v.addMessage(`Avg total path length: ${nm(stats.avgPathLength)}`);
        v.addMessage(`Min path:              ${nm(stats.minPathLength)}`);
        v.addMessage(`Max path:              ${nm(stats.maxPathLength)}`);
        v.addMessage(`Dist to far ground:    ${nm(stats.behindObjectDist)}`, "#ff00ff");
        v.addMessage(`Path fraction:         ${(stats.pathFraction * 100).toFixed(1)}%`);
    }

    cleanUpReflectionAnalysis() {
        for (const id of this.reflectionArrowIds) {
            removeDebugArrow(id);
        }
        this.reflectionArrowIds = [];
        if (this.reflectionView) {
            this.reflectionView.hide();
        }
        setRenderOne(true);
    }

    reflectionDistanceToColor(distance) {
        // Map distance to a color gradient: red (close) -> yellow -> green -> cyan -> blue (far)
        // Normalize distance to 0-1 range using reasonable bounds
        const minDist = 100;   // meters
        const maxDist = 50000; // meters
        const t = Math.max(0, Math.min(1, (distance - minDist) / (maxDist - minDist)));

        let r, g, b;
        if (t < 0.25) {
            // red -> yellow
            const s = t / 0.25;
            r = 1; g = s; b = 0;
        } else if (t < 0.5) {
            // yellow -> green
            const s = (t - 0.25) / 0.25;
            r = 1 - s; g = 1; b = 0;
        } else if (t < 0.75) {
            // green -> cyan
            const s = (t - 0.5) / 0.25;
            r = 0; g = 1; b = s;
        } else {
            // cyan -> blue
            const s = (t - 0.75) / 0.25;
            r = 0; g = 1 - s; b = 1;
        }

        const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    dispose() {
        this.cleanUpReflectionAnalysis();
        if (this.reflectionView) {
            this.reflectionView.dispose();
            this.reflectionView = null;
        }
        if (this.label) {
            NodeMan.disposeRemove(this.label, true);
        }
        this.disposeCubeCamera();
        this.gui.destroy();
        this.destroyObject();
        super.dispose();
    }

    recalculate() {
        super.recalculate();
        const scale = this.in.size.v0 * Globals.objectScale;
        this.group.scale.setScalar(scale);

        // update the root track if any input changes (which is what triggers a recalculate)
        // this is using in CustomSupport/preRenderUpdate()
        // to separate objects on the target track from the traverse/target object
        this.rootTrack = findRootTrack(this)


    }

    update(f) {
        super.update(f);

        // if (this.spriteText) {
        //     this.spriteText.position.copy(this._object.position);
        //     this.spriteText.position.y += 0.1;
        // }

       // this.rebuildBoundingBox(false);
    }


}
