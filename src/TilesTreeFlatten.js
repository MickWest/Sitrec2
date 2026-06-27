// TilesTreeFlatten.js
//
// "Flatten Trees" for Google Photorealistic 3D Tiles.
//
// Photogrammetric 3D tiles model trees as blobs of polygons sitting above the
// ground (Google explicitly renders tree canopies as floating geometry). This
// module analyses each loaded tile mesh and removes that vegetation while
// preserving ground and buildings:
//
//   1. Fit ONE "ground plane" per tile to the low points of the mesh.
//   2. Classify every vertex as ground / tree / keep using three independent
//      cue families — colour (RGB vegetation indices sampled from the tile
//      texture), local geometry (roughness / scatter / planarity / verticality
//      from the 1-ring neighbourhood), and height above the ground plane — with
//      a hard "building veto" so flat roofs and vertical walls are never touched.
//   3. Cluster the mesh into connected components (position-welded) and cull
//      small or floating islands outright — these are tree fragments and noise.
//   4. Flatten the surviving tree vertices by snapping them down onto the
//      ground plane along the local up vector (or delete the triangles).
//
// All heuristics are exposed as GUI parameters (the "Tree Removal" folder).
// The original geometry of every modified mesh is cloned and stashed so the
// edit can be fully restored and re-run with new parameters.
//
// Coordinate handling: positions are processed in tile-LOCAL space. The local
// "up" is the true geodetic normal — getLocalUpVector() on the mesh's world
// centre (Sitrec world space is earth-centred), transformed back into local
// space. A single plane per tile matches the spec and the ~<100m tile size.

import {Box3, BufferAttribute, Matrix4, Vector3} from "three";
import {getLocalUpVector} from "./SphericalMath";
import {fastComputeVertexNormals} from "./FastComputeVertexNormals";

// Symbols used to stash per-mesh state without colliding with library fields
// (same pattern as TilesDayNightPlugin's ORIGINAL_MATERIAL).
const ORIGINAL_GEOMETRY = Symbol("treeFlatten_originalGeometry");
const PROCESSED_HASH = Symbol("treeFlatten_processedHash");
// How many manual-brush dabs (from the persistent list) have been applied to a
// mesh. The dab list is append-only during a session, so a mesh with
// DAB_COUNT < dabs.length just needs the new tail applied. Reset on restore.
const DAB_COUNT = Symbol("treeFlatten_dabCount");

// Fixed horizontal search radius (metres) for the snap-to-ground floor, decoupled
// from the brush radius — a small brush's footprint usually has no ground vertex
// under it, so the ground must be searched over a wider, fixed neighbourhood.
export const GROUND_SEARCH_RADIUS = 20;
// Reject ground-search vertices seen more than this far (metres) below the hit —
// guards against snapping to a vertex across a cliff / down a hole.
const MAX_COLUMN_DEPTH = 80;

// Scratch for the cross-mesh ground search (per-dab, not per-vertex).
const _gp_inv = new Matrix4();
const _gp_p = new Vector3();
const _gp_bc = new Vector3();
const _gp_lc = new Vector3();
const _gp_upL = new Vector3();

// Reusable scratch vectors for the per-mesh brush apply (no per-call allocation;
// safe because the apply is synchronous and non-reentrant).
const _bm_invWorld = new Matrix4();
const _bm_localCenter = new Vector3();
const _bm_up = new Vector3();
const _bm_center = new Vector3();
const _bm_groundW = new Vector3();

// Aggregate diagnostics (exposed as window._treeFlattenDebug for MCP probing).
export const treeFlattenDebug = {
    tiles: 0, verts: 0, above: 0, ground: 0,
    snapped: 0, deleted: 0, flatCells: 0, totalCells: 0,
    colourTiles: 0, roofCells: 0, greenVerts: 0, samples: [],
    reset() {
        this.tiles = this.verts = this.above = this.ground = 0;
        this.snapped = this.deleted = this.flatCells = this.totalCells = this.colourTiles = 0;
        this.roofCells = this.greenVerts = 0;
        this.samples = [];
    },
};
if (typeof window !== "undefined") window._treeFlattenDebug = treeFlattenDebug;

// ---------------------------------------------------------------------------
// Parameter definitions — single source of truth shared by the algorithm and
// the GUI builder in CNodeTerrainUI. Each entry drives one lil-gui control.
// `folder` groups controls into sub-folders of "Tree Removal".
// ---------------------------------------------------------------------------
export const TREE_FLATTEN_DEFS = [
    // --- manual brush edit (top level of "Edit Geometry"; `top`). The `manual`
    //     ones are excluded from the auto heuristic hash. ---
    {key: "manualEdit", type: "bool", default: false, folder: null, top: true, manual: true,
        label: "Manual Remove", tooltip: "Paint the Edit Action onto the tiles. While on, left-click-dragging over the Google tiles edits the geometry under the brush; hovering shows a wireframe preview. Strokes are undoable (Ctrl/Cmd+Z). Hold Option/Alt while painting to RESTORE geometry back to its original height (e.g. to recover a building a snap flattened)"},
    {key: "brushRadius", type: "num", default: 8, min: 1, max: 20, step: 1, folder: null, top: true, manual: true,
        label: "Brush Radius (m)", tooltip: "World-space radius of the manual-edit brush"},
    {key: "action", type: "enum", default: "snap", folder: null, top: true,
        options: {"Snap to ground": "snap", "Delete triangles": "delete"},
        label: "Edit Action", tooltip: "Snap the geometry down to the ground plane, or delete the triangles under the brush. Used by both the brush and the automatic pass"},
    {key: "applyEdits", type: "bool", default: true, folder: null, top: true, manual: true,
        label: "Apply Edits", tooltip: "Re-apply the saved manual edits to tiles as they load (persists with Manual Remove off). Turn off to temporarily see the original geometry without discarding the edits"},

    // --- automatic tree removal (the "Automatic Tree Removal" sub-menu) ---
    {key: "flattenTrees", type: "bool", default: false, folder: null,
        label: "Flatten Trees", tooltip: "Analyse Google Photorealistic tiles and remove/flatten trees"},
    {key: "cullDistance", type: "num", default: 100, min: 10, max: 2000, step: 10, folder: null,
        label: "Cull Distance (m)", tooltip: "Only auto-process tiles within this distance of the camera. Raise it for elevated or distant cameras (the camera may be hundreds of metres from the terrain)"},
    {key: "minTileVertices", type: "num", default: 500, min: 50, max: 20000, step: 50, folder: null,
        label: "Min Tile Verts", tooltip: "Skip coarse/low-resolution tiles below this vertex count"},

    // --- Ground Plane ---
    {key: "groundCellSize", type: "num", default: 8, min: 1, max: 50, step: 1, folder: "Ground Plane",
        label: "Ground Cell (m)", tooltip: "Grid cell for lowest-point ground sampling; must exceed tree/building footprints"},
    {key: "useRansac", type: "bool", default: true, folder: "Ground Plane",
        label: "Use RANSAC", tooltip: "Robustly fit the ground plane with seeded RANSAC (off = plain least squares)"},
    {key: "ransacIterations", type: "num", default: 80, min: 10, max: 500, step: 10, folder: "Ground Plane",
        label: "RANSAC Iters", tooltip: "Number of RANSAC plane hypotheses (seeded, deterministic)"},
    {key: "inlierThreshold", type: "num", default: 0.6, min: 0.05, max: 3, step: 0.05, folder: "Ground Plane",
        label: "Inlier Band (m)", tooltip: "Vertical tolerance for a low point to count as ground-plane inlier"},
    {key: "groundHeightGate", type: "num", default: 0.6, min: 0.1, max: 3, step: 0.1, folder: "Ground Plane",
        label: "Ground Gate (m)", tooltip: "Vertices below this height above the plane are always ground (never tree)"},

    // --- Tree Detection (colour) ---
    {key: "exgrThreshold", type: "num", default: 0.0, min: -0.2, max: 0.3, step: 0.01, folder: "Tree Detection",
        label: "ExGR Cutoff", tooltip: "Excess-Green-minus-Excess-Red vegetation cutoff (Meyer-Neto, ~0). A vertex is green foliage above this"},
    {key: "exgThreshold", type: "num", default: 0.10, min: 0.0, max: 0.4, step: 0.01, folder: "Tree Detection",
        label: "ExG Cutoff", tooltip: "Excess-Green vegetation cutoff — the other green test (a vertex is green if it passes either ExGR or ExG)"},
    {key: "treeGreenMin", type: "num", default: 0.25, min: 0.05, max: 0.9, step: 0.05, folder: "Tree Detection",
        label: "Green Fraction", tooltip: "Used when growing the building envelope: a cell with at least this fraction of green vertices is foliage and is never absorbed into a building"},

    // --- Building Detection (protect these — flatten everything else above ground) ---
    {key: "roofNormalConsist", type: "num", default: 0.5, min: 0.1, max: 0.95, step: 0.05, folder: "Building Detection",
        label: "Roof Coherence", tooltip: "Min mean per-vertex normal coherence for a roof/wall cell. Buildings are coherent man-made surfaces; tree canopy is incoherent (~0.3). Lower protects bumpier roofs (better buildings); too low protects canopy"},
    {key: "maxRoofHeight", type: "num", default: 10, min: 3, max: 60, step: 1, folder: "Building Detection",
        label: "Max Bldg Height (m)", tooltip: "Coherent columns taller than this are tree masses, not buildings, and are flattened. Default 10 suits houses; lower if tall trees survive, raise to protect multi-storey buildings"},
    {key: "buildingGreenMax", type: "num", default: 0.25, min: 0.0, max: 1, step: 0.05, folder: "Building Detection",
        label: "Roof GreenMax", tooltip: "A roof cell must have less than this fraction of green vertices (green flat things are not roofs)"},
    {key: "minRoofCells", type: "num", default: 4, min: 1, max: 30, step: 1, folder: "Building Detection",
        label: "Min Roof Cells", tooltip: "A building must be a contiguous cluster of at least this many coherent cells. Lower protects smaller buildings (better buildings); too low protects isolated coherent canopy cells"},
    {key: "buildingDilate", type: "num", default: 2, min: 0, max: 4, step: 1, folder: "Building Detection",
        label: "Envelope Grow", tooltip: "Grow the protected building footprint outward by this many cells to cover walls/eaves that aren't flat roof. Higher = safer buildings (but may protect a ring of vegetation against them)"},
    {key: "minCellVerts", type: "num", default: 6, min: 3, max: 40, step: 1, folder: "Building Detection",
        label: "Min Cell Verts", tooltip: "A cell needs at least this many above-ground vertices to be tested for roof flatness"},

    // --- Clustering / fragment culling ---
    {key: "flattenCellSize", type: "num", default: 3, min: 0.5, max: 15, step: 0.5, folder: "Clustering",
        label: "Flatten Cell (m)", tooltip: "Above-ground geometry is flattened a whole grid column at a time at this resolution (avoids spiky partial collapse)"},
    {key: "weldEpsilon", type: "num", default: 0.05, min: 0.005, max: 0.5, step: 0.005, folder: "Clustering",
        label: "Weld Eps (m)", tooltip: "Position tolerance for welding split vertices before connectivity analysis"},
    {key: "smallComponentFaces", type: "num", default: 80, min: 5, max: 2000, step: 5, folder: "Clustering",
        label: "Min Island Faces", tooltip: "Connected components smaller than this are culled (noise / tree bits)"},
    {key: "floatingHeight", type: "num", default: 2.0, min: 0.3, max: 20, step: 0.1, folder: "Clustering",
        label: "Floating (m)", tooltip: "A disconnected island whose base is this far above ground is a floating tree — culled"},
];

// Build a plain params object with all defaults.
export function makeDefaultTreeFlattenParams() {
    const p = {};
    for (const d of TREE_FLATTEN_DEFS) p[d.key] = d.default;
    // Persistent manual-brush edit list. Each dab is {lla:[lat,lon,alt], r, a}
    // (a = "snap"|"delete"). Serialized with the sitch; not a `def` so it isn't
    // part of the heuristic hash.
    p.dabs = [];
    return p;
}

// Stable hash of the heuristic parameter values. A mesh stamped with the
// current hash is skipped — re-processing only happens when params change.
export function treeFlattenParamHash(params) {
    let h = 2166136261;
    for (const d of TREE_FLATTEN_DEFS) {
        if (d.manual) continue; // manual-brush controls don't drive re-processing
        const v = params[d.key];
        const s = (typeof v === "number") ? v.toFixed(4) : String(v);
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
    }
    return h >>> 0;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

// Deterministic PRNG so RANSAC is reproducible (important for the regression
// harness — no Math.random, no frame-dependent state).
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Disjoint-set union-find over canonical vertices.
function makeDSU(n) {
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    function union(x, y) {
        const rx = find(x), ry = find(y);
        if (rx !== ry) parent[rx] = ry;
    }
    return {find, union};
}

// ---------------------------------------------------------------------------
// Texture colour sampler — Google tiles are textured (not vertex-coloured), so
// colour cues require sampling the tile texture at each vertex UV. We rasterise
// the texture image to a canvas once and cache the sampler (keyed by image).
// Returns a function (u,v) -> [r,g,b] in 0..1, or null if unavailable/tainted.
// ---------------------------------------------------------------------------
const _samplerCache = new WeakMap();

function getTextureSampler(material) {
    const map = material && (Array.isArray(material) ? material[0]?.map : material.map);
    const image = map && map.image;
    if (!image || !image.width || !image.height) return null;
    if (_samplerCache.has(image)) return _samplerCache.get(image);

    let sampler = null;
    try {
        const w = image.width, h = image.height;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", {willReadFrequently: true});
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data; // throws if cross-origin tainted
        sampler = (u, v) => {
            // Wrap UVs into 0..1, V-flipped (texture origin bottom-left).
            let uu = u - Math.floor(u);
            let vv = 1 - (v - Math.floor(v));
            const px = Math.min(w - 1, Math.max(0, (uu * (w - 1)) | 0));
            const py = Math.min(h - 1, Math.max(0, (vv * (h - 1)) | 0));
            const i = (py * w + px) * 4;
            return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
        };
    } catch (e) {
        // Tainted canvas (cross-origin texture without CORS) — colour cues
        // disabled for this texture; geometry + connectivity carry on.
        sampler = null;
    }
    _samplerCache.set(image, sampler);
    return sampler;
}

// ---------------------------------------------------------------------------
// Geometry rebuild helpers (for the "delete triangles" path)
// ---------------------------------------------------------------------------

// Build a geometry containing only the triangles whose index is set in
// `keepTri` (Uint8Array, one per triangle). Works for indexed and non-indexed
// geometry and preserves every attribute (position, uv, normal, barycentric…).
function filterTriangles(geometry, keepTri, triCount, index) {
    let kept = 0;
    for (let t = 0; t < triCount; t++) if (keepTri[t]) kept++;

    if (index) {
        // Indexed: just build a new, shorter index. Vertex buffers untouched.
        const src = index.array;
        const out = new (src.constructor)(kept * 3);
        let o = 0;
        for (let t = 0; t < triCount; t++) {
            if (!keepTri[t]) continue;
            out[o++] = src[t * 3];
            out[o++] = src[t * 3 + 1];
            out[o++] = src[t * 3 + 2];
        }
        const newGeom = geometry.clone();
        newGeom.setIndex(new BufferAttribute(out, 1));
        // Stale draw-range groups would reference the old (longer) index. Google
        // tiles are single-material, so clearing groups draws the whole mesh.
        newGeom.clearGroups();
        newGeom.computeBoundingBox();
        newGeom.computeBoundingSphere();
        return newGeom;
    }

    // Non-indexed: rebuild every attribute, copying the 3 corners of kept tris.
    const newGeom = geometry.clone();
    for (const name in geometry.attributes) {
        const attr = geometry.attributes[name];
        const itemSize = attr.itemSize;
        const src = attr.array;
        const out = new src.constructor(kept * 3 * itemSize);
        let o = 0;
        for (let t = 0; t < triCount; t++) {
            if (!keepTri[t]) continue;
            for (let c = 0; c < 3; c++) {
                const base = (t * 3 + c) * itemSize;
                for (let k = 0; k < itemSize; k++) out[o++] = src[base + k];
            }
        }
        newGeom.setAttribute(name, new BufferAttribute(out, itemSize));
    }
    newGeom.clearGroups();
    newGeom.computeBoundingBox();
    newGeom.computeBoundingSphere();
    return newGeom;
}

// ---------------------------------------------------------------------------
// Core per-mesh pipeline
// ---------------------------------------------------------------------------

// Process one tile mesh in place. Returns one of:
//   'skip'  — below resolution / no geometry / no ground (not stamped retryable)
//   'noop'  — analysed, nothing to remove (stamped, no backup)
//   'edit'  — geometry modified (backup stashed, stamped)
// `hash` is the current param hash used to stamp the mesh.
function processMesh(mesh, params, hash) {
    const geometry = mesh.geometry;
    const posAttr = geometry && geometry.attributes.position;
    if (!posAttr) return "skip";

    const Nv = posAttr.count;
    if (Nv < params.minTileVertices) return "skip";

    const pos = posAttr.array;
    const uvAttr = geometry.attributes.uv;
    const uv = uvAttr ? uvAttr.array : null;
    const index = geometry.index;
    const idx = index ? index.array : null;
    const triCount = idx ? (idx.length / 3) | 0 : (Nv / 3) | 0;
    if (triCount < 4) return "skip";

    // --- local up (true geodetic normal at the tile centre, in local space) ---
    mesh.updateWorldMatrix(true, false);
    const box = new Box3().setFromBufferAttribute(posAttr);
    const localCenter = new Vector3();
    box.getCenter(localCenter);
    const worldCenter = localCenter.clone().applyMatrix4(mesh.matrixWorld);
    const worldUp = getLocalUpVector(worldCenter);
    const invWorld = new Matrix4().copy(mesh.matrixWorld).invert();
    const up = worldUp.clone().transformDirection(invWorld).normalize();

    // Orthonormal basis in the ground plane (perpendicular to up).
    const basisU = new Vector3(1, 0, 0);
    if (Math.abs(up.x) > 0.9) basisU.set(0, 1, 0);
    basisU.crossVectors(up, basisU).normalize();
    const basisV = new Vector3().crossVectors(up, basisU).normalize();

    // --- position-weld into canonical vertices (connectivity ignores UV/normal
    //     seams that split the photogrammetric mesh) ---
    const q = 1 / Math.max(params.weldEpsilon, 1e-3);
    const keyToCanon = new Map();
    const canonOf = new Int32Array(Nv);
    const cx = [], cy = [], cz = [];
    for (let v = 0; v < Nv; v++) {
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
        let c = keyToCanon.get(key);
        if (c === undefined) {
            c = cx.length;
            keyToCanon.set(key, c);
            cx.push(x); cy.push(y); cz.push(z);
        }
        canonOf[v] = c;
    }
    const Nc = cx.length;

    // Canonical projected coords: u,v in plane, h along up.
    const cu = new Float32Array(Nc), cv = new Float32Array(Nc), ch = new Float32Array(Nc);
    for (let c = 0; c < Nc; c++) {
        const x = cx[c], y = cy[c], z = cz[c];
        cu[c] = x * basisU.x + y * basisU.y + z * basisU.z;
        cv[c] = x * basisV.x + y * basisV.y + z * basisV.z;
        ch[c] = x * up.x + y * up.y + z * up.z;
    }

    // --- ground plane: lowest canonical vertex per grid cell, then robust fit ---
    const cs = Math.max(1, params.groundCellSize);
    const lowMap = new Map(); // cellKey -> canon index with min h
    for (let c = 0; c < Nc; c++) {
        const ck = `${Math.floor(cu[c] / cs)},${Math.floor(cv[c] / cs)}`;
        const prev = lowMap.get(ck);
        if (prev === undefined || ch[c] < ch[prev]) lowMap.set(ck, c);
    }
    const low = [...lowMap.values()];
    if (low.length < 3) return "skip"; // can't define a ground plane

    const plane = fitGroundPlane(low, cu, cv, ch, params);
    if (!plane) return "skip";
    const {a, b, c0} = plane; // h_ground = a*u + b*v + c0

    // Height of each canonical vertex above the ground plane.
    const hAbove = new Float32Array(Nc);
    for (let c = 0; c < Nc; c++) hAbove[c] = ch[c] - (a * cu[c] + b * cv[c] + c0);

    // --- triangle connectivity + per-vertex summed face normals (local) ---
    // DSU groups position-welded triangles into components (floating-island
    // cull); the per-canon summed face normals feed cell normal-consistency.
    const dsu = makeDSU(Nc);
    const sumNx = new Float32Array(Nc), sumNy = new Float32Array(Nc), sumNz = new Float32Array(Nc);
    const faceCountCanon = new Int32Array(Nc);

    const triA = new Int32Array(triCount), triB = new Int32Array(triCount), triC = new Int32Array(triCount);
    const ab = new Vector3(), ac = new Vector3(), fn = new Vector3();
    for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx[t * 3] : t * 3;
        const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
        const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
        const a0 = canonOf[i0], b0 = canonOf[i1], c0v = canonOf[i2];
        triA[t] = a0; triB[t] = b0; triC[t] = c0v;
        dsu.union(a0, b0); dsu.union(b0, c0v);
        // face normal
        ab.set(pos[i1 * 3] - pos[i0 * 3], pos[i1 * 3 + 1] - pos[i0 * 3 + 1], pos[i1 * 3 + 2] - pos[i0 * 3 + 2]);
        ac.set(pos[i2 * 3] - pos[i0 * 3], pos[i2 * 3 + 1] - pos[i0 * 3 + 1], pos[i2 * 3 + 2] - pos[i0 * 3 + 2]);
        fn.crossVectors(ab, ac);
        if (fn.lengthSq() > 1e-20) fn.normalize();
        for (const cc of [a0, b0, c0v]) {
            sumNx[cc] += fn.x; sumNy[cc] += fn.y; sumNz[cc] += fn.z;
            faceCountCanon[cc]++;
        }
    }

    // --- colour sampler + averaged UV per canonical vertex ---
    const sampler = uv ? getTextureSampler(mesh.material) : null;
    let canonU = null, canonV = null, canonUVCount = null;
    if (sampler && uv) {
        canonU = new Float32Array(Nc); canonV = new Float32Array(Nc); canonUVCount = new Int32Array(Nc);
        for (let v = 0; v < Nv; v++) {
            const c = canonOf[v];
            canonU[c] += uv[v * 2];
            canonV[c] += uv[v * 2 + 1];
            canonUVCount[c]++;
        }
    }

    // --- per-vertex vegetation colour ---
    // Colour is the only per-vertex cue the cell decision needs; all geometry
    // is aggregated at cell scale below. Trees are green; roofs, walls and
    // roads are not. Sample the tile texture at each above-ground vertex's UV
    // and flag it green via RGB vegetation indices (ExGR / ExG).
    const green = new Uint8Array(Nc);
    if (sampler) {
        for (let c = 0; c < Nc; c++) {
            if (hAbove[c] < params.groundHeightGate || canonUVCount[c] === 0) continue;
            const [r, g, bl] = sampler(canonU[c] / canonUVCount[c], canonV[c] / canonUVCount[c]);
            const sum = r + g + bl + 1e-6;
            const rn = r / sum, gn = g / sum, bn = bl / sum;
            const exg = 2 * gn - rn - bn;
            const exgr = exg - (1.4 * rn - gn);
            if (exgr > params.exgrThreshold || exg > params.exgThreshold) green[c] = 1;
        }
    }

    // --- connected components: cull small + floating islands ---
    const compFaces = new Map(), compMinH = new Map(), compGround = new Map();
    for (let t = 0; t < triCount; t++) {
        const root = dsu.find(triA[t]);
        compFaces.set(root, (compFaces.get(root) || 0) + 1);
    }
    for (let c = 0; c < Nc; c++) {
        const root = dsu.find(c);
        const cur = compMinH.get(root);
        if (cur === undefined || hAbove[c] < cur) compMinH.set(root, hAbove[c]);
        if (hAbove[c] < params.groundHeightGate) compGround.set(root, true);
    }
    const cullComp = new Set();
    for (const [root, faces] of compFaces) {
        const small = faces < params.smallComponentFaces;
        const floating = (compMinH.get(root) ?? 0) > params.floatingHeight && !compGround.get(root);
        if (small || floating) cullComp.add(root);
    }

    // --- column-based flatten decision ---
    // Snapping individual tree vertices down leaves spiky vertical curtains (a
    // partially-collapsed canopy). Instead we bin the tile into a coarse (u,v)
    // grid and flatten a WHOLE column at once when it is not part of a detected
    // building. The entire tree footprint collapses to a flat ground patch —
    // clean from any view angle. Buildings are found by roof detection below.
    const fcs = Math.max(0.5, params.flattenCellSize);
    const cellOfCanon = new Int32Array(Nc);
    const cellKeyToId = new Map();
    const cellAbove = [], cellGreen = [], cellCX = [], cellCY = [];
    // Per-cell sum of PER-VERTEX normal coherence + max height.
    const cohSum = [], cMaxH = [];
    for (let c = 0; c < Nc; c++) {
        const gx = Math.floor(cu[c] / fcs), gy = Math.floor(cv[c] / fcs);
        const ck = gx + "," + gy;
        let id = cellKeyToId.get(ck);
        if (id === undefined) {
            id = cellAbove.length;
            cellKeyToId.set(ck, id);
            cellAbove.push(0); cellGreen.push(0); cellCX.push(gx); cellCY.push(gy);
            cohSum.push(0); cMaxH.push(0);
        }
        cellOfCanon[c] = id;
        if (hAbove[c] >= params.groundHeightGate) {
            cellAbove[id]++;
            if (green[c]) cellGreen[id]++;
            if (hAbove[c] > cMaxH[id]) cMaxH[id] = hAbove[c];
            // Per-vertex normal coherence |Σ adjacent face normals| / count: ≈1
            // on any single coherent surface (roof OR wall), low (~0.3) in
            // canopy. Aggregating the PER-VERTEX value (not the cell's summed
            // normals) keeps roofs and walls high even though a building column
            // mixes their two normal directions — that mix would cancel a
            // cell-level vector sum, but each vertex's own neighbourhood stays
            // coherent.
            const fc = faceCountCanon[c] || 1;
            const coh = Math.sqrt(sumNx[c] * sumNx[c] + sumNy[c] * sumNy[c] + sumNz[c] * sumNz[c]) / fc;
            cohSum[id] += Math.min(1, coh);
        }
    }
    const nCells = cellAbove.length;

    // ROOF/WALL DETECTION + DILATION. A building is a coherent man-made surface:
    // its vertices sit on smooth roof and wall planes, so their per-vertex
    // normal coherence is high (~1). Tree canopy is incoherent (~0.3). We mark
    // building cells as non-green with high MEAN per-vertex coherence, keep only
    // contiguous clusters (a real building, not a lone flat-ish canopy cell),
    // dilate to cover the full envelope, and flatten everything else above
    // ground — green and shadowed-grey canopy alike, with no spikes.
    const roofRaw = new Uint8Array(nCells);
    for (let i = 0; i < nCells; i++) {
        if (cellAbove[i] < params.minCellVerts) continue;
        const greenFrac = cellGreen[i] / cellAbove[i];
        const meanCoh = cohSum[i] / cellAbove[i];
        // Height gate: a building is short; a tall coherent column (≥ maxRoofHeight)
        // is a tree mass, not a roof. This is the orthogonal cue that separates
        // them when coherence alone overlaps (dense canopy can be moderately
        // coherent, photogrammetric roofs only moderately so).
        if (greenFrac < params.buildingGreenMax
            && meanCoh > params.roofNormalConsist
            && cMaxH[i] < params.maxRoofHeight) {
            roofRaw[i] = 1;
        }
    }
    // Keep only coherent cells that form a CONTIGUOUS cluster — a real building
    // is many adjacent coherent cells, whereas shadowed/grey canopy throws up
    // only isolated flat-ish cells. 4-connected components on the cell grid;
    // clusters smaller than `minRoofCells` are discarded (and will flatten).
    const dsuR = makeDSU(nCells);
    for (let i = 0; i < nCells; i++) {
        if (!roofRaw[i]) continue;
        const r = cellKeyToId.get((cellCX[i] + 1) + "," + cellCY[i]);
        if (r !== undefined && roofRaw[r]) dsuR.union(i, r);
        const u = cellKeyToId.get(cellCX[i] + "," + (cellCY[i] + 1));
        if (u !== undefined && roofRaw[u]) dsuR.union(i, u);
    }
    const roofCompSize = new Map();
    for (let i = 0; i < nCells; i++) {
        if (!roofRaw[i]) continue;
        const root = dsuR.find(i);
        roofCompSize.set(root, (roofCompSize.get(root) || 0) + 1);
    }
    const cellRoof = new Uint8Array(nCells);
    for (let i = 0; i < nCells; i++) {
        if (roofRaw[i] && roofCompSize.get(dsuR.find(i)) >= params.minRoofCells) cellRoof[i] = 1;
    }
    // Dilate the protected set outward by `buildingDilate` cells. A cell joins
    // the protected envelope if it neighbours a protected cell AND is not itself
    // clearly foliage (green) — so protection spreads across walls/eaves but
    // stops at the surrounding canopy.
    const cellProtect = cellRoof.slice();
    for (let pass = 0; pass < params.buildingDilate; pass++) {
        const add = [];
        for (let i = 0; i < nCells; i++) {
            if (cellProtect[i] || cellAbove[i] === 0) continue;
            if (cellGreen[i] / cellAbove[i] >= params.treeGreenMin) continue; // green → foliage, don't protect
            let touches = false;
            for (let dx = -1; dx <= 1 && !touches; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nb = cellKeyToId.get((cellCX[i] + dx) + "," + (cellCY[i] + dy));
                    if (nb !== undefined && cellProtect[nb]) { touches = true; break; }
                }
            }
            if (touches) add.push(i);
        }
        if (add.length === 0) break;
        for (const i of add) cellProtect[i] = 1;
    }
    // Flatten every above-ground column outside the protected building envelope.
    const cellFlatten = new Uint8Array(nCells);
    for (let i = 0; i < nCells; i++) {
        cellFlatten[i] = (!cellProtect[i] && cellAbove[i] > 0) ? 1 : 0;
    }
    // Per-canon flatten flag: in a flatten column and above the ground gate.
    const snapCanon = new Uint8Array(Nc);
    let snapCount = 0;
    for (let c = 0; c < Nc; c++) {
        if (cellFlatten[cellOfCanon[c]] && hAbove[c] >= params.groundHeightGate) {
            snapCanon[c] = 1; snapCount++;
        }
    }

    // --- decide per-triangle: delete (culled islands / delete-mode trees) vs keep ---
    const keepTri = new Uint8Array(triCount);
    let deleted = 0;
    for (let t = 0; t < triCount; t++) {
        const root = dsu.find(triA[t]);
        if (cullComp.has(root)) { deleted++; continue; } // delete culled island
        const flat = snapCanon[triA[t]] + snapCanon[triB[t]] + snapCanon[triC[t]];
        if (flat >= 2 && params.action === "delete") { deleted++; continue; }
        keepTri[t] = 1;
    }
    if (params.action !== "snap") snapCount = 0; // only snap in snap mode

    // --- diagnostics ---
    {
        let above = 0, groundN = 0, greenVerts = 0, minH = Infinity, maxH = -Infinity;
        let flatCells = 0, roofCells = 0;
        for (let c = 0; c < Nc; c++) {
            if (hAbove[c] < minH) minH = hAbove[c];
            if (hAbove[c] > maxH) maxH = hAbove[c];
            if (green[c]) greenVerts++;
            if (hAbove[c] < params.groundHeightGate) groundN++;
            else above++;
        }
        for (let i = 0; i < cellFlatten.length; i++) { if (cellFlatten[i]) flatCells++; if (cellProtect[i]) roofCells++; }
        const d = treeFlattenDebug;
        d.tiles++; d.verts += Nc; d.above += above;
        d.ground += groundN; d.snapped += snapCount; d.deleted += deleted;
        d.flatCells += flatCells; d.totalCells += cellFlatten.length;
        d.roofCells += roofCells; d.greenVerts += greenVerts;
        if (sampler) d.colourTiles++;
        if (d.samples.length < 6) {
            d.samples.push({
                Nc, above, groundN, flatCells, roofCells, cells: cellFlatten.length,
                minH: +minH.toFixed(2), maxH: +maxH.toFixed(2),
                plane: {a: +a.toFixed(3), b: +b.toFixed(3), c0: +c0.toFixed(1)},
                hasColour: !!sampler, lowPts: low.length,
            });
        }
    }

    if (deleted === 0 && snapCount === 0) {
        mesh[PROCESSED_HASH] = hash;
        return "noop";
    }

    // --- apply: stash backup, snap vertices, rebuild on delete ---
    mesh[ORIGINAL_GEOMETRY] = geometry.clone();

    if (snapCount > 0) {
        for (let v = 0; v < Nv; v++) {
            if (!snapCanon[canonOf[v]]) continue;
            const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
            const h = x * up.x + y * up.y + z * up.z;
            const u = x * basisU.x + y * basisU.y + z * basisU.z;
            const w = x * basisV.x + y * basisV.y + z * basisV.z;
            const drop = h - (a * u + b * w + c0);
            if (drop <= 0) continue; // already at/below ground — never lift
            pos[v * 3] = x - drop * up.x;
            pos[v * 3 + 1] = y - drop * up.y;
            pos[v * 3 + 2] = z - drop * up.z;
        }
        posAttr.needsUpdate = true;
    }

    if (deleted > 0) {
        // filterTriangles clones from `geometry`, which already carries any
        // snapped positions (snap + floating-island delete can both happen).
        const newGeom = filterTriangles(geometry, keepTri, triCount, index);
        fastComputeVertexNormals(newGeom);
        geometry.dispose();
        mesh.geometry = newGeom;
    } else if (snapCount > 0) {
        fastComputeVertexNormals(geometry);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
    }

    mesh[PROCESSED_HASH] = hash;
    return "edit";
}

// Robust ground-plane fit: least squares over low points, optionally wrapped in
// seeded RANSAC. Returns {a,b,c0} for h = a*u + b*v + c0, or null.
function fitGroundPlane(lowIdx, cu, cv, ch, params) {
    const lsq = (subset) => {
        // Solve [Suu Suv Su; Suv Svv Sv; Su Sv n] [a b c]^T = [Suh Svh Sh]^T
        let Suu = 0, Suv = 0, Svv = 0, Su = 0, Sv = 0, Suh = 0, Svh = 0, Sh = 0, n = 0;
        for (const c of subset) {
            const u = cu[c], v = cv[c], h = ch[c];
            Suu += u * u; Suv += u * v; Svv += v * v; Su += u; Sv += v;
            Suh += u * h; Svh += v * h; Sh += h; n++;
        }
        // 3x3 solve via Cramer's rule
        const m = [[Suu, Suv, Su], [Suv, Svv, Sv], [Su, Sv, n]];
        const rhs = [Suh, Svh, Sh];
        const det = det3(m);
        if (Math.abs(det) < 1e-9) return null;
        const a = det3(replaceCol(m, 0, rhs)) / det;
        const b = det3(replaceCol(m, 1, rhs)) / det;
        const c0 = det3(replaceCol(m, 2, rhs)) / det;
        return {a, b, c0};
    };

    // Drive the plane down onto the true ground via iterative one-sided
    // descent. This is the key to not fitting the dense canopy layer: in heavy
    // foliage most per-cell minima are still canopy (the ground only shows
    // through scattered gaps), so a raw fit floats up. Each pass discards
    // points that sit above the current plane and refits to what remains,
    // sliding the plane down through the canopy until it rests on the lowest
    // surface (street/lawn gaps), keeping the slope.
    const descend = (base) => {
        if (!base) return null;
        let fit = base;
        const band = params.inlierThreshold;
        for (let k = 0; k < 5; k++) {
            const kept = [];
            for (const c of lowIdx) {
                if (ch[c] - (fit.a * cu[c] + fit.b * cv[c] + fit.c0) < band) kept.push(c);
            }
            if (kept.length < 4 || kept.length === lowIdx.length) break;
            const nf = lsq(kept);
            if (!nf) break;
            fit = nf;
        }
        return fit;
    };

    let base;
    if (!params.useRansac || lowIdx.length < 8) {
        base = lsq(lowIdx);
    } else {
        // seeded RANSAC over 3-point hypotheses (slope estimation)
        const seed = (lowIdx.length * 2654435761 + Math.round((ch[lowIdx[0]] || 0) * 1000)) >>> 0;
        const rng = mulberry32(seed || 1);
        let bestInliers = null, bestCount = -1;
        const band = params.inlierThreshold;
        for (let it = 0; it < params.ransacIterations; it++) {
            const p0 = lowIdx[(rng() * lowIdx.length) | 0];
            const p1 = lowIdx[(rng() * lowIdx.length) | 0];
            const p2 = lowIdx[(rng() * lowIdx.length) | 0];
            if (p0 === p1 || p1 === p2 || p0 === p2) continue;
            const hyp = lsq([p0, p1, p2]);
            if (!hyp) continue;
            let count = 0;
            const inliers = [];
            for (const c of lowIdx) {
                const pred = hyp.a * cu[c] + hyp.b * cv[c] + hyp.c0;
                if (Math.abs(ch[c] - pred) < band) { count++; inliers.push(c); }
            }
            if (count > bestCount) { bestCount = count; bestInliers = inliers; }
        }
        base = (bestInliers && bestInliers.length >= 3) ? (lsq(bestInliers) || lsq(lowIdx)) : lsq(lowIdx);
    }
    return descend(base) || base;
}

function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function replaceCol(m, col, rhs) {
    const r = [m[0].slice(), m[1].slice(), m[2].slice()];
    r[0][col] = rhs[0]; r[1][col] = rhs[1]; r[2][col] = rhs[2];
    return r;
}

// ---------------------------------------------------------------------------
// TreeFlattener — owns processing + backup/restore for ONE TilesRenderer.
// One instance per PerViewTiles renderer; all share the same params object.
// ---------------------------------------------------------------------------
export class TreeFlattener {
    /**
     * @param {Object} params shared Tree Removal params object
     * @param {Object} renderer the TilesRenderer to walk (forEachLoadedModel)
     */
    constructor(params, renderer) {
        this.params = params;
        this.renderer = renderer;
        this.modified = new Set(); // meshes with a stashed ORIGINAL_GEOMETRY
        // Transient manual-brush HOVER preview state: mesh -> {geometry, tris}.
        // `tris` is a flat [triIndex, i0, i1, i2, ...] log of index entries we
        // collapsed to degenerate (to hide them) so they can be restored. Kept
        // entirely separate from the committed ORIGINAL_GEOMETRY backup.
        this._preview = new Map();

        // Free backup clones when a tile is evicted, so they don't leak as the
        // camera moves through Google's constant LOD re-tiling.
        this._onDisposeModel = ({scene}) => {
            scene.traverse(child => {
                if (!child.isMesh) return;
                this._preview.delete(child); // ghost geometry is going away anyway
                if (child[ORIGINAL_GEOMETRY]) {
                    child[ORIGINAL_GEOMETRY].dispose();
                    child[ORIGINAL_GEOMETRY] = undefined;
                    child[PROCESSED_HASH] = undefined;
                    this.modified.delete(child);
                }
            });
        };
        renderer.addEventListener("dispose-model", this._onDisposeModel);
    }

    // Walk loaded tiles within cull distance of `camera` and process any not
    // already stamped with the current param hash. Bounded by `budget` edits
    // per call so a camera jump can't stall a frame. Returns the number of
    // meshes actually modified/analysed this call.
    processVisible(camera) {
        if (!this.params.flattenTrees || !camera) return 0;
        const hash = treeFlattenParamHash(this.params);
        const cullSq = this.params.cullDistance * this.params.cullDistance;
        const camPos = camera.position;
        const center = new Vector3();
        let did = 0;
        let budget = 6; // analyse at most a few tiles per call
        this.renderer.forEachLoadedModel((scene) => {
            if (budget <= 0) return;
            scene.traverse((mesh) => {
                if (budget <= 0 || !mesh.isMesh || !mesh.geometry) return;
                if (mesh[PROCESSED_HASH] === hash) return; // up to date
                mesh.updateWorldMatrix(true, false);
                mesh.geometry.boundingBox || mesh.geometry.computeBoundingBox();
                mesh.geometry.boundingBox.getCenter(center).applyMatrix4(mesh.matrixWorld);
                if (camPos.distanceToSquared(center) > cullSq) return; // out of range
                // Stale stamp from a previous param set → restore before re-edit.
                if (mesh[ORIGINAL_GEOMETRY]) this._restoreMesh(mesh);
                const r = processMesh(mesh, this.params, hash);
                if (r === "edit") { this.modified.add(mesh); did++; budget--; }
                else if (r === "noop") { budget--; }
            });
        });
        return did;
    }

    _restoreMesh(mesh) {
        const orig = mesh[ORIGINAL_GEOMETRY];
        if (!orig) return;
        if (mesh.geometry !== orig) mesh.geometry.dispose();
        mesh.geometry = orig;
        mesh[ORIGINAL_GEOMETRY] = undefined;
        mesh[PROCESSED_HASH] = undefined;
        mesh[DAB_COUNT] = undefined; // so manual dabs re-apply onto the restored mesh
        this.modified.delete(mesh);
    }

    // Restore every modified mesh in this renderer to its original geometry and
    // clear all processed/dab stamps (so a re-enable reprocesses from scratch).
    restoreAll() {
        for (const mesh of [...this.modified]) this._restoreMesh(mesh);
        // Also clear stamps on noop'd tiles so toggling off/on re-analyses.
        this.renderer.forEachLoadedModel((scene) => {
            scene.traverse((mesh) => {
                if (mesh.isMesh) { mesh[PROCESSED_HASH] = undefined; mesh[DAB_COUNT] = undefined; }
            });
        });
    }

    // Manual brush edit. Apply the tree `action` to every loaded mesh whose
    // geometry falls within `radius` (metres, world space) of `worldCenter`.
    //   snap   — squash affected vertices down to the lowest affected point
    //            (collapses a painted tree column onto the geometry at its base)
    //   delete — remove triangles mostly inside the brush
    // Reuses the same per-mesh backup/stamp machinery as the automatic pass, so
    // Restore Originals, tile eviction, and stale-stamp handling all undo manual
    // edits exactly as they do automatic ones. Returns the number of meshes
    // modified this call.
    // Lowest ORIGINAL-geometry WORLD point within the horizontal cylinder (radius
    // metres, about `up` through `worldCenter`), across ALL loaded meshes in this
    // renderer. The canopy and the street are usually SEPARATE tile meshes, so the
    // snap floor must be found across meshes — a within-mesh search only finds the
    // tree's own trunk base (≈ half way). Returns the lowest world Vector3 (by
    // height along `up`) or null; verts > MAX_COLUMN_DEPTH below the hit are ignored.
    lowestGroundPoint(worldCenter, up, radius) {
        const minH = worldCenter.dot(up) - MAX_COLUMN_DEPTH;
        let best = null, bestH = Infinity;
        this.renderer.forEachLoadedModel((scene) => {
            scene.traverse((mesh) => {
                if (!mesh.isMesh || !mesh.geometry) return;
                const posAttr = mesh.geometry.attributes.position;
                if (!posAttr) return;
                const Nv = posAttr.count;
                const orig = mesh[ORIGINAL_GEOMETRY];
                const arr = (orig && orig.attributes.position.count === Nv) ? orig.attributes.position.array : posAttr.array;
                mesh.updateWorldMatrix(true, false);
                const mw = mesh.matrixWorld;
                const me = mw.elements;
                const ms = Math.hypot(me[0], me[1], me[2]) || 1;
                // World bounding-sphere reject against the cylinder.
                mesh.geometry.boundingSphere || mesh.geometry.computeBoundingSphere();
                const bs = mesh.geometry.boundingSphere;
                _gp_bc.copy(bs.center).applyMatrix4(mw);
                const bx = _gp_bc.x - worldCenter.x, by = _gp_bc.y - worldCenter.y, bz = _gp_bc.z - worldCenter.z;
                const bal = bx * up.x + by * up.y + bz * up.z;
                const bhx = bx - bal * up.x, bhy = by - bal * up.y, bhz = bz - bal * up.z;
                if (Math.sqrt(bhx * bhx + bhy * bhy + bhz * bhz) > bs.radius * ms + radius) return;
                // Cylinder test in LOCAL space (cheap); world-transform only the verts
                // that pass, to get their height for comparison across meshes.
                _gp_inv.copy(mw).invert();
                const lc = _gp_lc.copy(worldCenter).applyMatrix4(_gp_inv);
                const upL = _gp_upL.copy(up).transformDirection(_gp_inv).normalize();
                const lr = radius / ms, lr2 = lr * lr;
                for (let i = 0; i < Nv; i++) {
                    const rx = arr[i * 3] - lc.x, ry = arr[i * 3 + 1] - lc.y, rz = arr[i * 3 + 2] - lc.z;
                    const al = rx * upL.x + ry * upL.y + rz * upL.z;
                    const hx = rx - al * upL.x, hy = ry - al * upL.y, hz = rz - al * upL.z;
                    if (hx * hx + hy * hy + hz * hz > lr2) continue;
                    _gp_p.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).applyMatrix4(mw);
                    const h = _gp_p.dot(up);
                    if (h < minH || h >= bestH) continue;
                    bestH = h;
                    best = (best || new Vector3()).copy(_gp_p);
                }
            });
        });
        return best;
    }

    // Apply one brush dab to ONE mesh. Returns true if the mesh geometry was
    // modified. Stashes the pristine geometry on first edit so the shared restore/
    // eviction paths can undo it. `floorWorldH` (optional) is the cross-mesh ground
    // height (world units, along the geodetic up at worldCenter) for snap — when
    // given, snap drops verts to that level instead of the within-mesh minimum.
    _brushMesh(mesh, worldCenter, radius, action, floorWorldH) {
        const geometry = mesh.geometry;
        const posAttr = geometry && geometry.attributes.position;
        if (!posAttr) return false;

        mesh.updateWorldMatrix(true, false);
        const invWorld = _bm_invWorld.copy(mesh.matrixWorld).invert();
        const localCenter = _bm_localCenter.copy(worldCenter).applyMatrix4(invWorld);

        // World→local radius scale (derive from the matrix rather than assume 1).
        const e = mesh.matrixWorld.elements;
        const s = Math.hypot(e[0], e[1], e[2]) || 1;
        const localRadius = radius / s;
        const r2 = localRadius * localRadius;

        // Quick reject against the geometry bounding sphere.
        geometry.boundingSphere || geometry.computeBoundingSphere();
        const bs = geometry.boundingSphere;
        if (bs && localCenter.distanceTo(bs.center) > bs.radius + localRadius) return false;

        const Nv = posAttr.count;
        const pos = posAttr.array;

        // Local geodetic up at the hit point (the snap direction).
        const up = _bm_up.copy(getLocalUpVector(worldCenter)).transformDirection(invWorld).normalize();

        // Affected vertices. SNAP uses a vertical CYLINDER about the brush axis so
        // "snap to ground" pulls the whole column down (and reaches a street deeper
        // than the brush radius). DELETE and RESTORE use a 3D SPHERE (surgical).
        const isSnap = action === "snap";
        const affected = new Uint8Array(Nv);
        let count = 0;
        for (let v = 0; v < Nv; v++) {
            const rx = pos[v * 3] - localCenter.x, ry = pos[v * 3 + 1] - localCenter.y, rz = pos[v * 3 + 2] - localCenter.z;
            let d2;
            if (isSnap) {
                const along = rx * up.x + ry * up.y + rz * up.z;
                const hx = rx - along * up.x, hy = ry - along * up.y, hz = rz - along * up.z;
                d2 = hx * hx + hy * hy + hz * hz; // horizontal distance² from the axis
            } else {
                d2 = rx * rx + ry * ry + rz * rz;
            }
            if (d2 > r2) continue;
            affected[v] = 1;
            count++;
        }
        if (count === 0) return false;

        if (!mesh[ORIGINAL_GEOMETRY]) {
            mesh[ORIGINAL_GEOMETRY] = geometry.clone();
            this.modified.add(mesh);
        }

        if (action === "delete") {
            const index = geometry.index;
            const idx = index ? index.array : null;
            const triCount = idx ? (idx.length / 3) | 0 : (Nv / 3) | 0;
            const keepTri = new Uint8Array(triCount);
            let removed = 0;
            for (let t = 0; t < triCount; t++) {
                const i0 = idx ? idx[t * 3] : t * 3;
                const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
                const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
                // Delete a triangle if ANY vertex is inside the brush. This is
                // aggressive enough to remove the long, sparse "pillar" wall
                // triangles (which only have one vertex near the click) — a
                // stricter >=2 test would leave them behind.
                if (affected[i0] || affected[i1] || affected[i2]) { removed++; continue; }
                keepTri[t] = 1;
            }
            if (removed === 0) return false;
            const newGeom = filterTriangles(geometry, keepTri, triCount, index);
            fastComputeVertexNormals(newGeom);
            geometry.dispose();
            mesh.geometry = newGeom;
        } else if (action === "restore") {
            // RESTORE. Put the affected (sphere) vertices back to their pristine
            // positions — undoing a snap that flattened, say, a building. Needs the
            // original backup with a matching vertex layout (snap preserves it; a
            // delete that rebuilt the geometry does not, so we bail there).
            const orig = mesh[ORIGINAL_GEOMETRY];
            if (!orig || orig.attributes.position.count !== Nv) return false;
            const oArr = orig.attributes.position.array;
            let moved = 0;
            for (let v = 0; v < Nv; v++) {
                if (!affected[v]) continue;
                if (pos[v * 3] === oArr[v * 3] && pos[v * 3 + 1] === oArr[v * 3 + 1] && pos[v * 3 + 2] === oArr[v * 3 + 2]) continue;
                pos[v * 3] = oArr[v * 3];
                pos[v * 3 + 1] = oArr[v * 3 + 1];
                pos[v * 3 + 2] = oArr[v * 3 + 2];
                moved++;
            }
            if (moved === 0) return false;
            posAttr.needsUpdate = true;
            fastComputeVertexNormals(geometry);
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
        } else {
            // SNAP TO GROUND. Drop every affected (cylinder) vertex down to the local
            // ground. The ground is the CROSS-MESH lowest vertex in a 20 m cylinder,
            // computed once at paint time and passed in as `floorWorldH` (a world
            // height along the geodetic up) — because the canopy and street are often
            // SEPARATE tile meshes, a within-mesh search would only find the tree's own
            // trunk base (≈ half way). If no cross-mesh floor was supplied (legacy
            // dabs / no ground found), fall back to the within-mesh fixed-radius search.
            const orig = mesh[ORIGINAL_GEOMETRY];
            const oArr = (orig && orig.attributes.position.count === Nv) ? orig.attributes.position.array : pos;
            let floor;
            if (floorWorldH !== undefined && Number.isFinite(floorWorldH)) {
                // Convert the world-space ground height into THIS mesh's local frame.
                const worldUp = getLocalUpVector(worldCenter);
                const hitWorldH = worldCenter.dot(worldUp);
                _bm_groundW.copy(worldCenter).addScaledVector(worldUp, floorWorldH - hitWorldH).applyMatrix4(invWorld);
                floor = _bm_groundW.x * up.x + _bm_groundW.y * up.y + _bm_groundW.z * up.z;
            } else {
                const groundR = Math.max(radius, GROUND_SEARCH_RADIUS) / s;
                const gr2 = groundR * groundR;
                floor = Infinity;
                for (let v = 0; v < Nv; v++) {
                    const rx = oArr[v * 3] - localCenter.x, ry = oArr[v * 3 + 1] - localCenter.y, rz = oArr[v * 3 + 2] - localCenter.z;
                    const along = rx * up.x + ry * up.y + rz * up.z;
                    const hx = rx - along * up.x, hy = ry - along * up.y, hz = rz - along * up.z;
                    if (hx * hx + hy * hy + hz * hz > gr2) continue;
                    const oh = oArr[v * 3] * up.x + oArr[v * 3 + 1] * up.y + oArr[v * 3 + 2] * up.z;
                    if (oh < floor) floor = oh;
                }
            }
            if (floor === Infinity) return false; // no ground found in range
            let moved = 0;
            for (let v = 0; v < Nv; v++) {
                if (!affected[v]) continue;
                const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                const drop = (x * up.x + y * up.y + z * up.z) - floor;
                if (drop <= 0) continue; // already at/below the ground
                pos[v * 3] = x - drop * up.x;
                pos[v * 3 + 1] = y - drop * up.y;
                pos[v * 3 + 2] = z - drop * up.z;
                moved++;
            }
            if (moved === 0) return false;
            posAttr.needsUpdate = true;
            fastComputeVertexNormals(geometry);
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
        }
        return true;
    }

    // Re-apply the persistent manual-brush dab list to loaded tiles. Each mesh is
    // stamped with how many dabs it has had applied (DAB_COUNT); since the list is
    // append-only, a mesh only needs the tail [DAB_COUNT .. dabs.length) applied.
    // This is what makes manual edits persist as tiles stream in/out and across
    // sessions. `dabsWorld` is [{center:Vector3, r, a}, ...] in world space.
    // Bounded by `budget` meshes brought up to date per call. Returns the number
    // of meshes edited.
    reapplyDabs(dabsWorld, budget = 8) {
        const n = dabsWorld.length;
        if (n === 0) return 0;
        let edited = 0;
        const center = _bm_center;
        this.renderer.forEachLoadedModel((scene) => {
            if (budget <= 0) return;
            scene.traverse((mesh) => {
                if (budget <= 0 || !mesh.isMesh || !mesh.geometry) return;
                const applied = mesh[DAB_COUNT] || 0;
                if (applied >= n) return;

                // World bounding sphere for the per-dab reject.
                mesh.updateWorldMatrix(true, false);
                const geo = mesh.geometry;
                geo.boundingSphere || geo.computeBoundingSphere();
                const me = mesh.matrixWorld.elements;
                const ms = Math.hypot(me[0], me[1], me[2]) || 1;
                center.copy(geo.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
                const meshR = geo.boundingSphere.radius * ms;

                for (let i = applied; i < n; i++) {
                    const dab = dabsWorld[i];
                    if (center.distanceTo(dab.center) > meshR + dab.r) continue;
                    if (this._brushMesh(mesh, dab.center, dab.r, dab.a, dab.floorH)) edited++;
                }
                mesh[DAB_COUNT] = n;
                budget--;
            });
        });
        return edited;
    }

    // Manual-brush HOVER preview (non-destructive). For every loaded mesh near
    // the brush, temporarily HIDE the triangles the brush covers (any vertex in
    // it — the same set the edit would touch) by collapsing them to a degenerate
    // (zero-area) triangle, and append their edges (world space, original
    // positions) to `posOut` for a wireframe "ghost". The affected region matches
    // the edit: a 3D SPHERE for delete, a vertical CYLINDER for snap.
    //
    // Cheap and fully reversible via _restorePreview(), never touching the
    // committed backup. Handles both layouts (Google tiles are NON-indexed):
    //   • indexed     → collapse the 3 index entries to one vertex (save them).
    //   • non-indexed → collapse the triangle's two trailing vertex positions
    //                   onto the first (save the originals). Safe because
    //                   non-indexed vertices aren't shared between triangles.
    // Caller must _restorePreview() before the next pick/commit.
    previewBrush(worldCenter, radius, action, posOut) {
        const isSnap = action === "snap";
        const invWorld = new Matrix4();
        const localCenter = new Vector3();
        const up = new Vector3();
        const wa = new Vector3(), wb = new Vector3(), wc = new Vector3();
        this.renderer.forEachLoadedModel((scene) => {
            scene.traverse((mesh) => {
                if (!mesh.isMesh || !mesh.geometry) return;
                const geometry = mesh.geometry;
                const posAttr = geometry.attributes.position;
                if (!posAttr) return;
                const index = geometry.index;
                const idx = index ? index.array : null;

                mesh.updateWorldMatrix(true, false);
                invWorld.copy(mesh.matrixWorld).invert();
                localCenter.copy(worldCenter).applyMatrix4(invWorld);
                up.copy(getLocalUpVector(worldCenter)).transformDirection(invWorld).normalize();
                const e = mesh.matrixWorld.elements;
                const s = Math.hypot(e[0], e[1], e[2]) || 1;
                const localRadius = radius / s;
                const r2 = localRadius * localRadius;

                geometry.boundingSphere || geometry.computeBoundingSphere();
                const bs = geometry.boundingSphere;
                if (bs && localCenter.distanceTo(bs.center) > bs.radius + localRadius) return;

                const pos = posAttr.array;
                const triCount = idx ? (idx.length / 3) | 0 : (posAttr.count / 3) | 0;
                const within = (vi) => {
                    const x = pos[vi * 3] - localCenter.x;
                    const y = pos[vi * 3 + 1] - localCenter.y;
                    const z = pos[vi * 3 + 2] - localCenter.z;
                    if (isSnap) {
                        const along = x * up.x + y * up.y + z * up.z;
                        const hx = x - along * up.x, hy = y - along * up.y, hz = z - along * up.z;
                        return hx * hx + hy * hy + hz * hz <= r2;
                    }
                    return x * x + y * y + z * z <= r2;
                };

                let entries = null;
                for (let t = 0; t < triCount; t++) {
                    const a = idx ? idx[t * 3] : t * 3;
                    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
                    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
                    // Any vertex in the brush — matches the aggressive delete and
                    // catches the sparse "pillar" wall triangles in the ghost too.
                    if (!within(a) && !within(b) && !within(c)) continue;
                    if (!entries) entries = [];

                    // Wireframe edges from the ORIGINAL positions (before collapse).
                    wa.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]).applyMatrix4(mesh.matrixWorld);
                    wb.set(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]).applyMatrix4(mesh.matrixWorld);
                    wc.set(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]).applyMatrix4(mesh.matrixWorld);
                    posOut.push(
                        wa.x, wa.y, wa.z, wb.x, wb.y, wb.z,
                        wb.x, wb.y, wb.z, wc.x, wc.y, wc.z,
                        wc.x, wc.y, wc.z, wa.x, wa.y, wa.z,
                    );

                    if (idx) {
                        entries.push(t, a, b, c);
                        idx[t * 3] = a; idx[t * 3 + 1] = a; idx[t * 3 + 2] = a;
                    } else {
                        // Save b & c originals (vertexIndex + xyz), collapse onto a.
                        entries.push(
                            b, pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2],
                            c, pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2],
                        );
                        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
                        pos[b * 3] = ax; pos[b * 3 + 1] = ay; pos[b * 3 + 2] = az;
                        pos[c * 3] = ax; pos[c * 3 + 1] = ay; pos[c * 3 + 2] = az;
                    }
                }
                if (entries) {
                    this._preview.set(mesh, {geometry, indexed: !!idx, entries});
                    if (idx) index.needsUpdate = true;
                    else posAttr.needsUpdate = true;
                }
            });
        });
    }

    // Undo previewBrush(): write the saved index/position entries back. Returns
    // true if anything was restored.
    _restorePreview() {
        let restored = false;
        for (const [mesh, rec] of this._preview) {
            const geom = rec.geometry;
            if (mesh.geometry !== geom) continue; // geometry swapped / evicted
            const ent = rec.entries;
            if (rec.indexed) {
                if (!geom.index) continue;
                const idx = geom.index.array;
                for (let k = 0; k < ent.length; k += 4) {
                    const t = ent[k];
                    idx[t * 3] = ent[k + 1];
                    idx[t * 3 + 1] = ent[k + 2];
                    idx[t * 3 + 2] = ent[k + 3];
                }
                geom.index.needsUpdate = true;
            } else {
                const pos = geom.attributes.position.array;
                for (let k = 0; k < ent.length; k += 4) {
                    const vi = ent[k];
                    pos[vi * 3] = ent[k + 1];
                    pos[vi * 3 + 1] = ent[k + 2];
                    pos[vi * 3 + 2] = ent[k + 3];
                }
                geom.attributes.position.needsUpdate = true;
            }
            restored = true;
        }
        this._preview.clear();
        return restored;
    }

    dispose() {
        if (this.renderer && this._onDisposeModel) {
            this.renderer.removeEventListener("dispose-model", this._onDisposeModel);
        }
        this._restorePreview();
        // Restore originals so disposing the renderer frees the right geometries.
        for (const mesh of [...this.modified]) this._restoreMesh(mesh);
        this.modified.clear();
        this.renderer = null;
        this._onDisposeModel = null;
    }
}
