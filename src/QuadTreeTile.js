import {assert} from "./assert";
import {
    GLOBAL_UNMEASURED_MAX_ALT_M,
    GLOBAL_UNMEASURED_MIN_ALT_M,
    inheritBoundsFromParent,
} from "./QuadTreeCullingBounds";
import {boxMark, DebugArrowAB, removeDebugArrow} from "./threeExt";
import {LLAToECEF, LLAToECEFInto, wgs84} from "./LLA-ECEF-ENU";
import {GlobalScene} from "./LocalFrame";
import {Globals, markShadowCastersDirty} from "./Globals";
import {EventManager} from "./CEventManager";
import {getLocalDownVector, getLocalNorthVector, getLocalUpVector, pointOnSphereBelow} from "./SphericalMath";
import {loadTextureWithRetries} from "./js/map33/material/QuadTextureMaterial";
import {convertTIFFToElevationArray} from "./TIFFUtils";
import {fromArrayBuffer} from 'geotiff';
import {getPixels} from "./js/get-pixels-mick";
import {
    BufferGeometry,
    CanvasTexture,
    Float32BufferAttribute,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshStandardMaterial,
    NearestFilter,
    PlaneGeometry,
    Sphere,
    Vector3
} from "three";

// Module-level scratch Vector3 reused by per-vertex tile-builder loops to avoid
// allocating one Vector3 per vertex per tile (a major source of GC pressure
// during camera motion / subdivision).
const _vertexScratch = new Vector3();
import {globalMipmapGenerator} from "./MipmapGenerator";
import {fastComputeVertexNormals} from "./FastComputeVertexNormals";
import {fastComputeVertexNormalsAsync} from "./FastComputeVertexNormalsAsync";
import {ServiceAvailability} from "./ServiceAvailability";
import {processTextureColors} from "./TextureColorProcessor";
import {createTerrainDayNightMaterial} from "./js/map33/material/TerrainDayNightMaterial";
import {fileSystemFetch} from "./fileSystemFetch";
import {geoidCorrectionForTile, interpolateGeoidOffset, meanSeaLevelOffset} from "./EGM96Geoid";
import {
    clearMaterialCacheImpl,
    getMaterialCacheStatsImpl,
    logCacheStatsImpl,
    materialMethods,
    removeMaterialByCacheKeyImpl,
    removeMaterialFromCacheImpl,
} from "./QuadTreeTileMaterial";


// Concurrency-limited fetch for GeoTIFF elevation tiles with IndexedDB caching.
// Dynamic rendering endpoints (e.g., USGS exportImage) generate tiles on the fly
// and can't handle many simultaneous requests. Plain fetch() avoids quickFetch's
// Range-header chunking which multiplies connections per tile.
import {indexedDBManager} from "./IndexedDBManager";

const GEOTIFF_MAX_CONCURRENT = 6;
const GEOTIFF_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
let geoTiffActiveCount = 0;
const geoTiffQueue = [];

async function geoTiffFetchWithLimit(url) {
    // Check cache first (no concurrency slot needed)
    try {
        const cached = await indexedDBManager.getCachedData(`geotiff:${url}`);
        if (cached) {
            return new Response(cached, {
                status: 200,
                headers: new Headers({'Content-Type': 'image/tiff'}),
            });
        }
    } catch (e) { /* cache miss or error, proceed to fetch */ }

    // Acquire a concurrency slot
    return new Promise((resolve, reject) => {
        const run = () => {
            geoTiffActiveCount++;
            fetch(url)
                .then(async (response) => {
                    if (response.ok) {
                        // Clone before consuming body, cache the arrayBuffer
                        const clone = response.clone();
                        clone.arrayBuffer().then(buf => {
                            indexedDBManager.cacheData(`geotiff:${url}`, buf, GEOTIFF_CACHE_TTL).catch(() => {});
                        });
                    }
                    resolve(response);
                })
                .catch(reject)
                .finally(() => {
                    geoTiffActiveCount--;
                    if (geoTiffQueue.length > 0) {
                        geoTiffQueue.shift()();
                    }
                });
        };
        if (geoTiffActiveCount < GEOTIFF_MAX_CONCURRENT) {
            run();
        } else {
            geoTiffQueue.push(run);
        }
    });
}

// Shared caches live in QuadTreeTileCache so QuadTreeTileMaterial can reuse them
// without forming an import cycle with this file.

// invisible material used when we don't want to see anything but still need a mesh
// If you see holes in the terrain, it may be because they are being added with this invisible material
//  We probably do not need this at all anymore????
const tileMaterial = new MeshStandardMaterial({
    wireframe: true,
    color: '#ff00ff',
    transparent: true,
    opacity: 1.0
});

export class QuadTreeTile {
    constructor(map, z, x, y, size) {
        // check values are within range
        assert(z >= 0 && z <= 20, 'z is out of range, z=' + z)
        //   assert(x >= 0 && x < Math.pow(2, z), 'x is out of range, x='+x)
        assert(y >= 0 && y < Math.pow(2, z), 'y is out of range, y=' + y)

        this.map = map
        this.z = z
        this.x = x
        this.y = y
        this.size = size || this.map.options.tileSize
        //   this.elevationURLString = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
        this.shape = null
        this.elevation = null
        this.seamX = false
        this.seamY = false
        this.loaded = false // Track if this tile has finished loading
        this.isLoading = false // Track if this tile is currently loading textures
        this.isLoadingElevation = false // Track if this tile is currently loading elevation data
        this.isCancelling = false // Track if this tile is currently being cancelled
        this.highestAltitude = 0;
        // V5 Phase 1.0: input/output bounds tracking. Pure data — no
        // current visibility path reads these; ensureCullingState() (added
        // below) lazily builds the sphere/OBB on demand. Future phases
        // (1.1 measurement, 2/3 sphere/OBB rendering) consume these.
        this.altitudeBounds = {
            min: GLOBAL_UNMEASURED_MIN_ALT_M,
            max: GLOBAL_UNMEASURED_MAX_ALT_M,
            source: "global",
            measured: false,
            generation: 0,
        };
        this.cullingState = {
            sphere: null,
            obb: null,
            localFrame: null,
            generation: -1,
            visibilityCache: null,
        };
        this.usingParentData = false; // Track if this tile is using resampled parent texture/elevation
        this.needsHighResLoad = false; // Track if this tile needs to load high-res data when visible

        // AbortController for cancelling texture loading
        this.textureAbortController = null;

        // AbortController for cancelling elevation computation
        this.elevationAbortController = null;

        // Private property to store tileLayers value
        this._tileLayers = undefined;

        // Tree structure: parent and children references
        this.parent = null; // Reference to parent tile (null if root)
        this.children = null; // Array of four child tiles [child1, child2, child3, child4] or null if no children
    }

    /**
     * V5: attach to a parent tile and inherit its altitude bounds (with slack).
     * Call this from tile-creation sites instead of setting `tile.parent` directly,
     * so the child's `altitudeBounds` starts from the parent's measured/inherited
     * range rather than the much-wider global default. Without this seeding the
     * V5 sphere/OBB for the child would be conservatively fat and cause the
     * ocean-mosaic z-fighting symptom this commit chain fixed.
     */
    linkToParent(parent) {
        this.parent = parent;
        if (!parent) return;
        const inherited = inheritBoundsFromParent(parent.altitudeBounds);
        if (inherited.source !== "global" && !this.altitudeBounds.measured) {
            inherited.generation = this.altitudeBounds.generation + 1;
            this.altitudeBounds = inherited;
            this.cullingState.generation = -1;
            this.cullingState.visibilityCache = null;
        }
    }

    // Getter and setter for tileLayers to track changes
    // get tileLayers() {
    //     return this._tileLayers;
    // }
    //
    // set tileLayers(value) {
    //     const oldValue = this._tileLayers;
    //     this._tileLayers = value;
    //
    //     // Log the change with stack trace for debugging
    //     console.log(`TILE LAYERS CHANGED: ${this.key()} - oldValue=${oldValue ? oldValue.toString(2) : 'undefined'} (${oldValue}) -> newValue=${value ? value.toString(2) : 'undefined'} (${value})`);
    //     console.trace('Stack trace for tileLayers change:');
    //
    // }


    getWorldSphere() {

        if (this.worldSphere !== undefined) {
            return this.worldSphere;
        }

        const xTile = this.x;
        const yTile = this.y;
        const zoomTile = this.z;

        const latSW = this.map.options.mapProjection.getNorthLatitude(yTile, zoomTile);
        const lonSW = this.map.options.mapProjection.getLeftLongitude(xTile, zoomTile);
        const latNW = this.map.options.mapProjection.getNorthLatitude(yTile + 1, zoomTile);
        const lonNW = this.map.options.mapProjection.getLeftLongitude(xTile, zoomTile);
        const latSE = this.map.options.mapProjection.getNorthLatitude(yTile, zoomTile);
        const lonSE = this.map.options.mapProjection.getLeftLongitude(xTile + 1, zoomTile);
        const latNE = this.map.options.mapProjection.getNorthLatitude(yTile + 1, zoomTile);
        const lonNE = this.map.options.mapProjection.getLeftLongitude(xTile + 1, zoomTile);

        // convert to ECEF
        const alt = 0;
        const vertexSW = LLAToECEF(latSW, lonSW, alt)
        const vertexNW = LLAToECEF(latNW, lonNW, alt)
        const vertexSE = LLAToECEF(latSE, lonSE, alt)
        const vertexNE = LLAToECEF(latNE, lonNE, alt)

        // find the center of the tile
        const center = vertexSW.clone().add(vertexNW).add(vertexSE).add(vertexNE).multiplyScalar(0.25);

        // find the largest distance from the center to any corner
        const radius = Math.max(
            center.distanceTo(vertexSW),
            center.distanceTo(vertexNW),
            center.distanceTo(vertexSE),
            center.distanceTo(vertexNE)
        )

        // create a bounding sphere centered at the center of the tile with the radius
        this.worldSphere = new Sphere(center, radius);

        // Cache center latitude in radians for screen-space-error math.
        // (Only the latitude is needed — meters-per-texel scales by cos(lat).)
        this._centerLatRad = ((latSW + latNW) * 0.5) * Math.PI / 180;

        return this.worldSphere;

        // if (!tile.mesh.geometry.boundingSphere) {
        //     tile.mesh.geometry.computeBoundingSphere();
        // }
        // const worldSphere = tile.mesh.geometry.boundingSphere.clone();
        // worldSphere.applyMatrix4(tile.mesh.matrixWorld);
        // return worldSphere;
    }

    /**
     * V5 Phase 1.1/1.2: begin a transactional measurement of the rendered
     * geometry's min/max altitude. Called at the top of each recalc path;
     * subsequent vertex iterations call _addRenderedVertex. The skirt
     * geometry (updateSkirtGeometry) calls _markSkirtCommitted with the
     * per-tile skirtDepth so the committed min covers the skirt extent.
     * Commit lands at the end of the recalc path IF main vertex count
     * matches expectedMain AND skirt has committed.
     *
     * Crucially: commit does NOT do a recursive forward refresh of
     * descendant inherited bounds. An earlier implementation walked the
     * entire active subtree on every commit; on the Zoomm detail test
     * sitch that walk caused millions of object allocations per cascade
     * and capped maxZ at 12 (regression confirmed by bisect). Inherited
     * bounds remain conservative without refresh because they clamp to
     * GLOBAL_UNMEASURED_MAX_ALT_M until the descendant measures itself.
     */
    beginRenderedBoundsMeasurement(expectedMainVertices) {
        this._measurement = {
            min: Infinity,
            max: -Infinity,
            mainCount: 0,
            expectedMain: expectedMainVertices,
            skirtCommitted: false,
            aborted: false,
        };
    }

    _addRenderedVertex(elevation) {
        const m = this._measurement;
        if (!m || m.aborted) return;
        if (elevation < m.min) m.min = elevation;
        if (elevation > m.max) m.max = elevation;
        m.mainCount++;
    }

    _markSkirtCommitted(skirtDepth = 0) {
        if (this._measurement && !this._measurement.aborted) {
            this._measurement.skirtCommitted = true;
            // V5 NOTE: skirtDepth intentionally NOT subtracted from min.
            // The skirt extends downward from the main mesh's outer edge by
            // `tile.size * 0.1` — for a z=0 tile that's ~26 km, which would
            // explode the bounding sphere's vertical extent and cause
            // catastrophic over-subdivision in sphere/obb modes. The skirt
            // sits below the visible mesh surface and is never directly
            // exposed to the camera (it's covered by the parent surface at
            // its edge), so leaving it out of culling bounds is safe.
            //
            // skirtDepth is accepted for API symmetry with the V5 plan but
            // currently has no effect. If a future case proves a camera
            // can see skirt-below-horizon, reintroduce subtraction with a
            // per-tile (not skirt-depth-driven) inflation.
            void skirtDepth;
        }
    }

    _abortRenderedBounds() {
        if (this._measurement) this._measurement.aborted = true;
        this._measurement = null;
    }

    _commitRenderedBounds() {
        const m = this._measurement;
        if (!m || m.aborted) { this._measurement = null; return false; }
        if (m.mainCount !== m.expectedMain || !m.skirtCommitted) {
            this._measurement = null;
            return false;
        }
        if (!isFinite(m.min) || !isFinite(m.max) || m.min > m.max) {
            this._measurement = null;
            return false;
        }
        this.altitudeBounds = {
            min: m.min,
            max: m.max,
            source: "renderedGeometry",
            measured: true,
            generation: this.altitudeBounds.generation + 1,
        };
        this.cullingState.generation = -1;
        this.cullingState.visibilityCache = null;
        this._measurement = null;
        // V5 Phase 1.1: NO recursive forward refresh of inherited
        // descendants — see method-level comment above for why.
        return true;
    }

    /**
     * V5 Phase 1.0: lazily build the measured-bounds sphere + OBB from the
     * current altitudeBounds. Cheap to call repeatedly because the
     * generation tag ensures the underlying build functions only run when
     * altitudeBounds actually changes.
     *
     * Not yet consulted by calculateTileVisibility (default mode is
     * "legacy"). Phase 2 (sphere mode) and Phase 3 (obb mode) call this.
     */
    ensureCullingState() {
        const state = this.cullingState;
        if (state.generation === this.altitudeBounds.generation && state.sphere && (state.obb || this.z < 3)) {
            return state;
        }
        const {
            buildCullingOBB,
            buildCullingSphere,
            buildFallbackPointSet,
            buildLocalFrame,
            maxPointsFor,
        } = require("./QuadTreeCullingBounds");

        const tileBounds = {
            z: this.z, x: this.x, y: this.y,
            mapProjection: this.map.options.mapProjection,
        };
        const pointPoolSize = Math.max(1, maxPointsFor(this.z));
        if (!QuadTreeTile._scratchPoints || QuadTreeTile._scratchPoints.length < pointPoolSize) {
            QuadTreeTile._scratchPoints = [];
            const {Vector3: _V3} = require("three");
            for (let i = 0; i < pointPoolSize; i++) QuadTreeTile._scratchPoints.push(new _V3());
        }
        const points = QuadTreeTile._scratchPoints;
        const count = buildFallbackPointSet(tileBounds, this.altitudeBounds, {points});

        if (count > 0) {
            state.sphere = buildCullingSphere(points, count);

            const latC = 0.5 * (
                this.map.options.mapProjection.getNorthLatitude(this.y, this.z) +
                this.map.options.mapProjection.getNorthLatitude(this.y + 1, this.z)
            );
            const lonC = 0.5 * (
                this.map.options.mapProjection.getLeftLongitude(this.x, this.z) +
                this.map.options.mapProjection.getLeftLongitude(this.x + 1, this.z)
            );
            const midAlt = 0.5 * (this.altitudeBounds.min + this.altitudeBounds.max);
            const {Vector3: _V3} = require("three");
            const origin = new _V3();
            require("./LLA-ECEF-ENU").LLAToECEFInto(latC, lonC, midAlt, origin);
            const latRad = latC * Math.PI / 180;
            const lonRad = lonC * Math.PI / 180;
            state.localFrame = buildLocalFrame(origin, latRad, lonRad);
            state.obb = (this.z < 3) ? null : buildCullingOBB(points, count, state.localFrame, origin);
            state._obbOriginECEF = origin;
        } else {
            state.sphere = this.getWorldSphere().clone();
            state.obb = null;
            state.localFrame = null;
        }
        state.generation = this.altitudeBounds.generation;
        state.visibilityCache = null;
        return state;
    }

    /**
     * V5 debug overlay: render this tile's OBB as 12 line segments, colored by
     * the source of its altitudeBounds. Green = self-measured, yellow =
     * inherited from ancestor, red = global default. Toggled via
     * `Globals.showTileOBB` from CustomSupport's Performance Tweaks folder.
     * No-op when the flag is off, when z<3 (no OBB built), or when the tile
     * has no current cullingState.obb yet.
     */
    _updateOBBDebug() {
        const wantDebug = Globals.showTileOBB && this.z >= 3 && this.cullingState?.obb;
        if (!wantDebug) {
            this._disposeOBBDebug();
            return;
        }
        const obb = this.cullingState.obb;
        const m = obb.box.min, M = obb.box.max;
        // 8 local-space corners ordered so the edge list below indexes the
        // standard box-edge topology.
        const localCorners = [
            [m.x, m.y, m.z], [M.x, m.y, m.z], [m.x, M.y, m.z], [M.x, M.y, m.z],
            [m.x, m.y, M.z], [M.x, m.y, M.z], [m.x, M.y, M.z], [M.x, M.y, M.z],
        ];
        const _v = QuadTreeTile._obbDebugScratch ||= new Vector3();
        const worldCorners = localCorners.map(c => {
            _v.set(c[0], c[1], c[2]).applyMatrix4(obb.transform);
            return [_v.x, _v.y, _v.z];
        });
        // 4 bottom edges, 4 top edges, 4 vertical edges = 12 edges = 24 vertices.
        const edges = [
            [0,1],[1,3],[3,2],[2,0],
            [4,5],[5,7],[7,6],[6,4],
            [0,4],[1,5],[2,6],[3,7],
        ];
        const positions = new Float32Array(edges.length * 2 * 3);
        let i = 0;
        for (const [a, b] of edges) {
            positions[i++] = worldCorners[a][0];
            positions[i++] = worldCorners[a][1];
            positions[i++] = worldCorners[a][2];
            positions[i++] = worldCorners[b][0];
            positions[i++] = worldCorners[b][1];
            positions[i++] = worldCorners[b][2];
        }
        const src = this.altitudeBounds?.source;
        const colorHex = src === "renderedGeometry" ? 0x00ff00
            : src === "elevationData" ? 0x00ff88
            : src === "inherited" ? 0xffff00
            : 0xff0000;
        if (!this._obbDebugLines) {
            const geom = new BufferGeometry();
            geom.setAttribute("position", new Float32BufferAttribute(positions, 3));
            const mat = new LineBasicMaterial({color: colorHex, depthTest: true, depthWrite: false});
            this._obbDebugLines = new LineSegments(geom, mat);
            // Helpers layer (bit 0); both mainView (0x69) and lookView (0x51)
            // include this bit so the overlay shows in both viewports.
            this._obbDebugLines.layers.mask = 0x1;
            this._obbDebugLines.frustumCulled = false;
            this._obbDebugLines.renderOrder = 999;
            GlobalScene.add(this._obbDebugLines);
        } else {
            const attr = this._obbDebugLines.geometry.getAttribute("position");
            attr.array.set(positions);
            attr.needsUpdate = true;
            this._obbDebugLines.material.color.setHex(colorHex);
        }
    }

    /**
     * Remove and free this tile's OBB debug overlay (if any). Called when the
     * flag is toggled off and from tile-disposal paths.
     */
    _disposeOBBDebug() {
        if (!this._obbDebugLines) return;
        GlobalScene.remove(this._obbDebugLines);
        this._obbDebugLines.geometry?.dispose();
        this._obbDebugLines.material?.dispose();
        this._obbDebugLines = null;
    }


    // The "key" is portion of the URL that identifies the tile
    // in the form of "z/x/y"
    // where z is the zoom level, and x and y are the horizontal
    // (E->W) and vertical (N->S) tile positions
    // it's used here as a key to the tileCache
    key() {
        return `${this.z}/${this.x}/${this.y}`
    }

    // Neighbouring tiles are used to resolve seams between tiles
    keyNeighX() {
        return `${this.z}/${this.x + 1}/${this.y}`
    }

    keyNeighY() {
        return `${this.z}/${this.x}/${this.y + 1}`
    }

    elevationURL() {
        return this.map.terrainNode.elevationURLDirect(this.z, this.x, this.y)

    }

    textureUrl() {
        return this.map.terrainNode.textureURLDirect(this.z, this.x, this.y)
    }


    buildGeometry() {
        // Use Globals.settings.tileSegments directly
        const segments = Globals.settings.tileSegments ?? 64;
        const geometry = new PlaneGeometry(
            this.size,
            this.size,
            segments,
            segments
        )

        this.geometry = geometry
    }

    // Create skirt geometry that extends downward around the tile edges
    buildSkirtGeometry() {
        // Use Globals.settings.tileSegments directly
        const segments = Globals.settings.tileSegments ?? 64;
        const halfSize = this.size / 2;
        const skirtDepth = this.size * 0.1; // 1/10 the width of the tile

        // Calculate the center position of the tile in world coordinates
        const lat1 = this.map.options.mapProjection.getNorthLatitude(this.y, this.z);
        const lon1 = this.map.options.mapProjection.getLeftLongitude(this.x, this.z);
        const lat2 = this.map.options.mapProjection.getNorthLatitude(this.y + 1, this.z);
        const lon2 = this.map.options.mapProjection.getLeftLongitude(this.x + 1, this.z);
        const centerLat = (lat1 + lat2) / 2;
        const centerLon = (lon1 + lon2) / 2;
        const centerPosition = LLAToECEF(centerLat, centerLon, 0);

        // Get the local down vector for this tile's center position
        const downVector = getLocalDownVector(centerPosition);

        const vertices = [];
        const indices = [];
        const uvs = [];
        const normals = [];

        // Get the edge vertices from the main tile geometry
        const mainPositions = this.geometry.attributes.position.array;
        const mainUvs = this.geometry.attributes.uv.array;

        // Ensure main geometry has normals computed
        if (!this.geometry.attributes.normal) {
            fastComputeVertexNormals(this.geometry);
        }
        const mainNormals = this.geometry.attributes.normal.array;

        // Helper function to get vertex index in the main geometry
        const getVertexIndex = (x, y) => (y * (segments + 1) + x);

        // Helper function to add a vertex to our skirt arrays
        const addVertex = (x, y, z, u, v, nx, ny, nz) => {
            vertices.push(x, y, z);
            uvs.push(u, v);
            normals.push(nx, ny, nz);
            return (vertices.length / 3) - 1;
        };

        let vertexIndex = 0;

        // Create skirt for each edge
        const edges = [
            // Bottom edge (y = 0) - left to right
            {start: [0, 0], end: [segments, 0], direction: [1, 0]},
            // Right edge (x = segments) - bottom to top
            {start: [segments, 0], end: [segments, segments], direction: [0, 1]},
            // Top edge (y = segments) - right to left
            {start: [segments, segments], end: [0, segments], direction: [-1, 0]},
            // Left edge (x = 0) - top to bottom
            {start: [0, segments], end: [0, 0], direction: [0, -1]}
        ];

        // Create vertices and triangles for each edge
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
            const edge = edges[edgeIndex];
            const [startX, startY] = edge.start;
            const [endX, endY] = edge.end;
            const [dirX, dirY] = edge.direction;

            const edgeLength = Math.abs(endX - startX) + Math.abs(endY - startY);

            // Create vertices for this edge
            for (let i = 0; i <= edgeLength; i++) {
                const x = startX + dirX * i;
                const y = startY + dirY * i;

                const mainVertexIndex = getVertexIndex(x, y);
                const mainX = mainPositions[mainVertexIndex * 3];
                const mainY = mainPositions[mainVertexIndex * 3 + 1];
                const mainZ = mainPositions[mainVertexIndex * 3 + 2];
                const mainU = mainUvs[mainVertexIndex * 2];
                const mainV = mainUvs[mainVertexIndex * 2 + 1];

                // Get the normal from the main tile surface for consistent lighting
                const mainNx = mainNormals[mainVertexIndex * 3];
                const mainNy = mainNormals[mainVertexIndex * 3 + 1];
                const mainNz = mainNormals[mainVertexIndex * 3 + 2];

                // Add top vertex (at tile edge level) with main tile normal
                addVertex(mainX, mainY, mainZ, mainU, mainV, mainNx, mainNy, mainNz);

                // Add bottom vertex (extended downward) with same normal for consistent lighting
                const bottomX = mainX + downVector.x * skirtDepth;
                const bottomY = mainY + downVector.y * skirtDepth;
                const bottomZ = mainZ + downVector.z * skirtDepth;
                addVertex(bottomX, bottomY, bottomZ, mainU, mainV, mainNx, mainNy, mainNz);
            }

            // Create triangles for this edge
            const edgeStartVertexIndex = vertexIndex;
            for (let i = 0; i < edgeLength; i++) {
                const currentVertexIndex = edgeStartVertexIndex + i * 2;
                const nextVertexIndex = currentVertexIndex + 2;

                // Triangle 1: [top-current, top-next, bottom-current]
                indices.push(currentVertexIndex, nextVertexIndex, currentVertexIndex + 1);
                // Triangle 2: [bottom-current, top-next, bottom-next]
                indices.push(currentVertexIndex + 1, nextVertexIndex, nextVertexIndex + 1);
            }

            vertexIndex += (edgeLength + 1) * 2;
        }

        // Create the skirt geometry
        const skirtGeometry = new BufferGeometry();
        skirtGeometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
        skirtGeometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
        skirtGeometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
        skirtGeometry.setIndex(indices);
        // Don't compute vertex normals - use our fake normals for consistent lighting

        this.skirtGeometry = skirtGeometry;
    }

    // Update skirt geometry to match the current main tile geometry after elevation changes
    updateSkirtGeometry() {
        if (!this.geometry || !this.skirtGeometry) return;

        const segments = this.map.options.tileSegments;
        const skirtDepth = this.size * 0.1; // 1/10 the width of the tile

        // Calculate the center position of the tile in world coordinates
        const lat1 = this.map.options.mapProjection.getNorthLatitude(this.y, this.z);
        const lon1 = this.map.options.mapProjection.getLeftLongitude(this.x, this.z);
        const lat2 = this.map.options.mapProjection.getNorthLatitude(this.y + 1, this.z);
        const lon2 = this.map.options.mapProjection.getLeftLongitude(this.x + 1, this.z);
        const centerLat = (lat1 + lat2) / 2;
        const centerLon = (lon1 + lon2) / 2;
        const centerPosition = LLAToECEF(centerLat, centerLon, 0);

        // Get the local down vector for this tile's center position
        const downVector = getLocalDownVector(centerPosition);

        // Get the updated edge vertices from the main tile geometry
        const mainPositions = this.geometry.attributes.position.array;
        const skirtPositions = this.skirtGeometry.attributes.position.array;

        // Ensure main geometry has normals computed
        if (!this.geometry.attributes.normal) {
            fastComputeVertexNormals(this.geometry);
        }
        const mainNormals = this.geometry.attributes.normal.array;
        const skirtNormals = this.skirtGeometry.attributes.normal.array;

        // Helper function to get vertex index in the main geometry
        const getVertexIndex = (x, y) => (y * (segments + 1) + x);

        let skirtVertexIndex = 0;

        // Update skirt vertices for each edge
        const edges = [
            // Bottom edge (y = 0)
            {start: [0, 0], end: [segments, 0], direction: [1, 0]},
            // Right edge (x = segments)
            {start: [segments, 0], end: [segments, segments], direction: [0, 1]},
            // Top edge (y = segments)
            {start: [segments, segments], end: [0, segments], direction: [-1, 0]},
            // Left edge (x = 0)
            {start: [0, segments], end: [0, 0], direction: [0, -1]}
        ];

        // Update vertices for each edge (matching the creation logic)
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
            const edge = edges[edgeIndex];
            const [startX, startY] = edge.start;
            const [endX, endY] = edge.end;
            const [dirX, dirY] = edge.direction;

            const edgeLength = Math.abs(endX - startX) + Math.abs(endY - startY);

            // Update vertices for this edge
            for (let i = 0; i <= edgeLength; i++) {
                const x = startX + dirX * i;
                const y = startY + dirY * i;

                const mainVertexIndex = getVertexIndex(x, y);
                const mainX = mainPositions[mainVertexIndex * 3];
                const mainY = mainPositions[mainVertexIndex * 3 + 1];
                const mainZ = mainPositions[mainVertexIndex * 3 + 2];

                // Get the normal from the main tile surface for fake lighting
                const mainNx = mainNormals[mainVertexIndex * 3];
                const mainNy = mainNormals[mainVertexIndex * 3 + 1];
                const mainNz = mainNormals[mainVertexIndex * 3 + 2];

                // Update top vertex (at tile edge level)
                skirtPositions[skirtVertexIndex * 3] = mainX;
                skirtPositions[skirtVertexIndex * 3 + 1] = mainY;
                skirtPositions[skirtVertexIndex * 3 + 2] = mainZ;

                // Update top vertex normal (fake normal from main tile)
                skirtNormals[skirtVertexIndex * 3] = mainNx;
                skirtNormals[skirtVertexIndex * 3 + 1] = mainNy;
                skirtNormals[skirtVertexIndex * 3 + 2] = mainNz;

                // Update bottom vertex (extended downward using local down vector)
                skirtPositions[(skirtVertexIndex + 1) * 3] = mainX + downVector.x * skirtDepth;
                skirtPositions[(skirtVertexIndex + 1) * 3 + 1] = mainY + downVector.y * skirtDepth;
                skirtPositions[(skirtVertexIndex + 1) * 3 + 2] = mainZ + downVector.z * skirtDepth;

                // Update bottom vertex normal (same fake normal for consistent lighting)
                skirtNormals[(skirtVertexIndex + 1) * 3] = mainNx;
                skirtNormals[(skirtVertexIndex + 1) * 3 + 1] = mainNy;
                skirtNormals[(skirtVertexIndex + 1) * 3 + 2] = mainNz;

                skirtVertexIndex += 2;
            }
        }

        // Mark the attributes as needing update
        this.skirtGeometry.attributes.position.needsUpdate = true;
        this.skirtGeometry.attributes.normal.needsUpdate = true;
        // Don't compute vertex normals - use our fake normals for consistent lighting
        this.skirtGeometry.computeBoundingBox();
        this.skirtGeometry.computeBoundingSphere();

        // V5 Phase 1.2: tell the bounds measurement (if any) about the
        // skirt extent. Safe to call when no measurement is in progress.
        this._markSkirtCommitted(skirtDepth);
    }

    // Apply Web Mercator elevation data to geometry vertices asynchronously
    async applyWebMercatorElevation(geometry, nPosition, elevationTile, elevationSize,
                                     tileBaseX, tileBaseY, numTiles, lonScale, lonOffset, latScale,
                                     elevationZoom, tileZ, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY,
                                     tileCenter, abortSignal) {
        // Sample the EGM96 geoid at the 4 tile corners once; per-vertex sea-level
        // values are bilinearly interpolated from these. The geoid varies smoothly
        // (sub-metre across a tile), so this is visually identical to per-vertex
        // lookup but ~64x cheaper for a 256-vertex tile.
        const lonW = (tileBaseX * lonScale) + lonOffset;
        const lonE = ((tileBaseX + 1) * lonScale) + lonOffset;
        const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileBaseY / numTiles))) * 180 / Math.PI;
        const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileBaseY + 1) / numTiles))) * 180 / Math.PI;
        const geoidCorners = {
            nw: meanSeaLevelOffset(latN, lonW),
            ne: meanSeaLevelOffset(latN, lonE),
            sw: meanSeaLevelOffset(latS, lonW),
            se: meanSeaLevelOffset(latS, lonE),
        };

        // Apply elevation data directly to vertices
        for (let i = 0; i < geometry.attributes.position.count; i++) {
            // Check if this operation was aborted (tile switched or cancelled)
            if (abortSignal?.aborted) {
                return;
            }
            const xIndex = i % nPosition;
            const yIndex = Math.floor(i / nPosition);

            // Calculate the fraction of the tile that the vertex is in
            let yTileFraction = yIndex / (nPosition - 1);
            let xTileFraction = xIndex / (nPosition - 1);

            // Clamp fractions to tile bounds
            if (xTileFraction >= 1) xTileFraction = 1 - 1e-6;
            if (yTileFraction >= 1) yTileFraction = 1 - 1e-6;

            // Get world tile coordinates
            const xWorld = tileBaseX + xTileFraction;
            const yWorld = tileBaseY + yTileFraction;

            // Direct Web Mercator calculation - optimized version
            // Longitude calculation (linear)
            const lon = (xWorld * lonScale) + lonOffset;

            // Latitude calculation (Web Mercator inverse)
            const latNorthRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * yWorld / numTiles)));
            const lat = latNorthRad * 180 / Math.PI;

            // Get elevation with bilinear interpolation from the elevation tile data
            // Map vertex position to elevation data coordinates, accounting for tile fraction and offset
            let elevationLocalX, elevationLocalY;

            if (elevationZoom === tileZ) {
                // Same zoom level - direct mapping
                elevationLocalX = xTileFraction * (elevationSize - 1);
                elevationLocalY = yTileFraction * (elevationSize - 1);
            } else {
                // Lower zoom level (parent tile) - map to the specific portion of the parent
                // Calculate the offset within the parent tile and add the texture tile fraction
                const parentOffsetX = (tileOffsetX + xTileFraction) * tileFractionX;
                const parentOffsetY = (tileOffsetY + yTileFraction) * tileFractionY;
                elevationLocalX = parentOffsetX * (elevationSize - 1);
                elevationLocalY = parentOffsetY * (elevationSize - 1);
            }

            // Get the four surrounding elevation data points for interpolation
            const x0 = Math.floor(elevationLocalX);
            const x1 = Math.min(elevationSize - 1, x0 + 1);
            const y0 = Math.floor(elevationLocalY);
            const y1 = Math.min(elevationSize - 1, y0 + 1);

            // Get the fractional parts for interpolation
            const fx = elevationLocalX - x0;
            const fy = elevationLocalY - y0;

            // Sample the four corner elevation values
            const e00 = elevationTile.elevation[y0 * elevationSize + x0];
            const e01 = elevationTile.elevation[y0 * elevationSize + x1];
            const e10 = elevationTile.elevation[y1 * elevationSize + x0];
            const e11 = elevationTile.elevation[y1 * elevationSize + x1];

            // Bilinear interpolation
            const e0 = e00 + (e01 - e00) * fx;
            const e1 = e10 + (e11 - e10) * fx;
            let elevation = e0 + (e1 - e0) * fy;

            // Apply z-scale if available
            if (this.map.elevationMap.options.zScale) {
                elevation *= this.map.elevationMap.options.zScale;
            }

            // Clamp to geoid sea level to avoid z-fighting with ocean tiles
            const seaLevel = interpolateGeoidOffset(geoidCorners, xTileFraction, yTileFraction);
            if (elevation < seaLevel) elevation = seaLevel;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }
            // V5 Phase 1.2: feed the transactional measurement when active.
            this._addRenderedVertex(elevation);

            // Convert to ECEF coordinates and translate to tile-local space.
            // In-place into _vertexScratch to avoid per-vertex Vector3 allocation.
            LLAToECEFInto(lat, lon, elevation, _vertexScratch).sub(tileCenter);

            assert(!isNaN(_vertexScratch.x), 'vertex.x is NaN in QuadTreeTile.js i=' + i);
            assert(!isNaN(_vertexScratch.y), 'vertex.y is NaN in QuadTreeTile.js');
            assert(!isNaN(_vertexScratch.z), 'vertex.z is NaN in QuadTreeTile.js');

            // Set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, _vertexScratch.x, _vertexScratch.y, _vertexScratch.z);
        }
    }

    removeDebugGeometry() {
        if (this.debugArrows !== undefined) {
            this.debugArrows.forEach(arrow => {
                removeDebugArrow(arrow)
            })
        }
        this.debugArrows = []

        // Remove loading indicators if they exist
        if (this.loadingIndicator !== undefined) {
            GlobalScene.remove(this.loadingIndicator);
            this.loadingIndicator.geometry.dispose();
            this.loadingIndicator.material.dispose();
            this.loadingIndicator = undefined;
        }

        if (this.elevationLoadingIndicator !== undefined) {
            GlobalScene.remove(this.elevationLoadingIndicator);
            this.elevationLoadingIndicator.geometry.dispose();
            this.elevationLoadingIndicator.material.dispose();
            this.elevationLoadingIndicator = undefined;
        }

        // Remove layer mask indicators if they exist
        if (this.mainLayerIndicator !== undefined) {
            GlobalScene.remove(this.mainLayerIndicator);
            this.mainLayerIndicator.geometry.dispose();
            this.mainLayerIndicator.material.dispose();
            this.mainLayerIndicator = undefined;
        }

        if (this.lookLayerIndicator !== undefined) {
            GlobalScene.remove(this.lookLayerIndicator);
            this.lookLayerIndicator.geometry.dispose();
            this.lookLayerIndicator.material.dispose();
            this.lookLayerIndicator = undefined;
        }

        if (this.worldLayerIndicator !== undefined) {
            GlobalScene.remove(this.worldLayerIndicator);
            this.worldLayerIndicator.geometry.dispose();
            this.worldLayerIndicator.material.dispose();
            this.worldLayerIndicator = undefined;
        }

        if (this.activeIndicator !== undefined) {
            GlobalScene.remove(this.activeIndicator);
            this.activeIndicator.geometry.dispose();
            this.activeIndicator.material.dispose();
            this.activeIndicator = undefined;
        }

        // V5 OBB debug overlay
        this._disposeOBBDebug();
    }

    // Dispose of this tile's resources, including its materialCache entry.
    // Symmetric with the prune path in QuadTreeMap.subdivideTilesGeneral —
    // both paths must drop the cache entry alongside disposing the material,
    // otherwise materialCache accumulates disposed-but-cached handles that
    // a future tile requesting the same URL would unwittingly receive.
    dispose() {
        // Remove debug geometry first
        this.removeDebugGeometry();

        // Remove mesh from scene if it exists
        if (this.mesh) {
            if (this.mesh.parent) {
                this.mesh.parent.remove(this.mesh);
            }

            // Dispose geometry
            if (this.mesh.geometry) {
                this.mesh.geometry.dispose();
            }

            // Free material + texture AND evict the cache entry. Static
            // cache keys are session-shared across tiles, so leave those
            // for the bulk clearMaterialCache() teardown.
            if (this.materialCacheKey && !this.materialCacheKey.startsWith('static_')) {
                QuadTreeTile.removeMaterialByCacheKey(this.materialCacheKey);
            } else if (this.mesh.material) {
                this.mesh.getMap()?.dispose();
                this.mesh.material.dispose();
            }

            this.mesh = undefined;
        }

        // Remove skirt mesh from scene if it exists
        if (this.skirtMesh) {
            if (this.skirtMesh.parent) {
                this.skirtMesh.parent.remove(this.skirtMesh);
            }

            // Dispose skirt geometry
            if (this.skirtMesh.geometry) {
                this.skirtMesh.geometry.dispose();
            }

            // Dispose skirt material if it's a cloned material (not the shared tileMaterial)
            if (this.skirtMesh.material && this.skirtMesh.material !== tileMaterial) {
                this.skirtMesh.material.dispose();
            }

            this.skirtMesh = undefined;
        }

        // Clear other references
        this.geometry = undefined;
        this.skirtGeometry = undefined;
        this.elevation = undefined;
        this.worldSphere = undefined;
        this.loaded = false;
        this.isLoading = false;
        this.isLoadingElevation = false;
    }

    // Update debug geometry when loading state changes
    updateDebugGeometry() {
        if (this.map && this.map.terrainNode && this.map.terrainNode.UI && this.map.terrainNode.UI.debugElevationGrid) {
            // Get the current debug color from the map
            const debugColor = this.map.debugColor || "#FF00FF";
            const debugAltitude = this.map.debugAltitude || 0;
            this.buildDebugGeometry(debugColor, debugAltitude);
        }
    }


    buildDebugGeometry(color = "#FF00FF", altitude = 0) {
        // patch in a debug rectangle around the tile using arrows
        // this is useful for debugging the tile positions - especially elevation vs map
        // arrows are good as they are more visible than lines

        if (this.active === false) {
            color = "#808080" // grey if not active
        }

        this.removeDebugGeometry()

        if (!this.map.terrainNode.UI.debugElevationGrid) return;


        const xTile = this.x;
        const yTile = this.y;
        const zoomTile = this.z;


//    console.log ("Building Debug Geometry for tile "+xTile+","+yTile+" at zoom "+zoomTile)
//    console.log ("Constructor of this.map.options.mapProjection = "+this.map.options.mapProjection.constructor.name)
//    console.log ("Constructor of this.map.options.mapProjection = "+this.map.options.mapProjection.constructor.name)


        // get LLA of the tile corners
        const latSW = this.map.options.mapProjection.getNorthLatitude(yTile, zoomTile);
        const lonSW = this.map.options.mapProjection.getLeftLongitude(xTile, zoomTile);
        const latNW = this.map.options.mapProjection.getNorthLatitude(yTile + 1, zoomTile);
        const lonNW = this.map.options.mapProjection.getLeftLongitude(xTile, zoomTile);
        const latSE = this.map.options.mapProjection.getNorthLatitude(yTile, zoomTile);
        const lonSE = this.map.options.mapProjection.getLeftLongitude(xTile + 1, zoomTile);
        const latNE = this.map.options.mapProjection.getNorthLatitude(yTile + 1, zoomTile);
        const lonNE = this.map.options.mapProjection.getLeftLongitude(xTile + 1, zoomTile);

        // convert to ECEF
        const alt = 10000 + altitude;
        const vertexSW = LLAToECEF(latSW, lonSW, alt)
        const vertexNW = LLAToECEF(latNW, lonNW, alt)
        const vertexSE = LLAToECEF(latSE, lonSE, alt)
        const vertexNE = LLAToECEF(latNE, lonNE, alt)

        // use these four points to draw debug lines at 10000m above the tile
        //DebugArrowAB("UFO Ground V", jetPosition, groundVelocityEnd, "#00ff00", displayWindArrows, GlobalScene) // green = ground speed


        const id1 = "DebugTile" + color + (xTile * 1000 + yTile) + "_1"
        const id2 = "DebugTile" + color + (xTile * 1000 + yTile) + "_2"
        const id3 = "DebugTile" + color + (xTile * 1000 + yTile) + "_3"
        const id4 = "DebugTile" + color + (xTile * 1000 + yTile) + "_4"
        this.debugArrows.push(id1)
        this.debugArrows.push(id2)
        this.debugArrows.push(id3)
        this.debugArrows.push(id4)


        DebugArrowAB(id1, vertexSW, vertexNW, color, true, GlobalScene)
        DebugArrowAB(id2, vertexSW, vertexSE, color, true, GlobalScene)
        DebugArrowAB(id3, vertexNW, vertexNE, color, true, GlobalScene)
        DebugArrowAB(id4, vertexSE, vertexNE, color, true, GlobalScene)

        // and down arrows at the corners
        const vertexSWD = pointOnSphereBelow(vertexSW)
        const vertexNWD = pointOnSphereBelow(vertexNW)
        const vertexSED = pointOnSphereBelow(vertexSE)
        const vertexNED = pointOnSphereBelow(vertexNE)

        const id5 = "DebugTile" + color + (xTile * 1000 + yTile) + "_5"
        const id6 = "DebugTile" + color + (xTile * 1000 + yTile) + "_6"
        const id7 = "DebugTile" + color + (xTile * 1000 + yTile) + "_7"
        const id8 = "DebugTile" + color + (xTile * 1000 + yTile) + "_8"

        this.debugArrows.push(id5)
        this.debugArrows.push(id6)
        this.debugArrows.push(id7)
        this.debugArrows.push(id8)

        // all down arrows in yellow
        DebugArrowAB(id5, vertexSW, vertexSWD, color, true, GlobalScene)
        DebugArrowAB(id6, vertexNW, vertexNWD, color, true, GlobalScene)
        DebugArrowAB(id7, vertexSE, vertexSED, color, true, GlobalScene)
        DebugArrowAB(id8, vertexNE, vertexNED, color, true, GlobalScene)

        // Add loading indicators in top-left corner
        const offsetFactor = 0.1; // 10% inward from corner
        const indicatorSize = Math.abs(vertexNE.x - vertexNW.x) * 0.08; // 8% of tile width

        // Red square for texture loading
        if (this.isLoading) {
            const loadingX = vertexNW.x + (vertexNE.x - vertexNW.x) * offsetFactor;
            const loadingY = vertexNW.y + (vertexSW.y - vertexNW.y) * offsetFactor;
            const loadingZ = vertexNW.z;

            this.loadingIndicator = boxMark(
                {x: loadingX, y: loadingY, z: loadingZ},
                indicatorSize, indicatorSize, indicatorSize,
                "#FF0000", // Red color for texture loading
                GlobalScene
            );
            this.loadingIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
        }

        // Blue square for elevation loading (positioned next to red square)
        if (this.isLoadingElevation) {
            const elevationX = vertexNW.x + (vertexNE.x - vertexNW.x) * (offsetFactor + 0.12); // Offset to the right
            const elevationY = vertexNW.y + (vertexSW.y - vertexNW.y) * offsetFactor;
            const elevationZ = vertexNW.z;

            this.elevationLoadingIndicator = boxMark(
                {x: elevationX, y: elevationY, z: elevationZ},
                indicatorSize, indicatorSize, indicatorSize,
                "#0000FF", // Blue color for elevation loading
                GlobalScene
            );
            this.elevationLoadingIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
        }

        // Layer mask indicators (positioned 25% down from the top of the tile)
        if (this.tileLayers !== undefined && this.tileLayers > 0) {
            const layerIndicatorY = vertexNW.y + (vertexSW.y - vertexNW.y) * 0.25; // 25% down from top

            // Magenta square for MASK_MAIN (8)
            if (this.tileLayers & 8) { // MASK_MAIN = 8
                const mainX = vertexNW.x + (vertexNE.x - vertexNW.x) * offsetFactor;
                const mainZ = vertexNW.z;

                this.mainLayerIndicator = boxMark(
                    {x: mainX, y: layerIndicatorY, z: mainZ},
                    indicatorSize, indicatorSize, indicatorSize,
                    "#FF00FF", // Magenta color for MASK_MAIN
                    GlobalScene
                );
                this.mainLayerIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
            }

            // Yellow square for MASK_LOOK (16)
            if (this.tileLayers & 16) { // MASK_LOOK = 16
                const lookX = vertexNW.x + (vertexNE.x - vertexNW.x) * (offsetFactor + 0.12); // Offset to the right
                const lookZ = vertexNW.z;

                this.lookLayerIndicator = boxMark(
                    {x: lookX, y: layerIndicatorY, z: lookZ},
                    indicatorSize, indicatorSize, indicatorSize,
                    "#FFFF00", // Yellow color for MASK_LOOK
                    GlobalScene
                );
                this.lookLayerIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
            }

            // Green square for MASK_WORLD (1)
            if (this.tileLayers & 1) { // MASK_WORLD = 1
                const worldX = vertexNW.x + (vertexNE.x - vertexNW.x) * (offsetFactor + 0.24); // Further to the right
                const worldZ = vertexNW.z;

                this.worldLayerIndicator = boxMark(
                    {x: worldX, y: layerIndicatorY, z: worldZ},
                    indicatorSize, indicatorSize, indicatorSize,
                    "#00FF00", // Green color for MASK_WORLD
                    GlobalScene
                );
                this.worldLayerIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
            }
        }

        // Brown square for active flag (positioned next to layer mask indicators)
        if (this.active !== undefined) {
            const activeIndicatorY = vertexNW.y + (vertexSW.y - vertexNW.y) * 0.25; // Same Y as layer indicators
            const activeX = vertexNW.x + (vertexNE.x - vertexNW.x) * (offsetFactor + 0.36); // Further to the right
            const activeZ = vertexNW.z;

            this.activeIndicator = boxMark(
                {x: activeX, y: activeIndicatorY, z: activeZ},
                indicatorSize, indicatorSize, indicatorSize,
                this.active ? "#8B4513" : "#404040", // Brown if active, dark gray if inactive
                GlobalScene
            );
            this.activeIndicator.layers.mask = 0x1; // Make it visible on the helpers layer
        }

    }


    // recalculate the X,Y, Z values for all the verticles of a tile
    // at this point we are Z-up
    // OLD VERSION - inefficient for tiles of different sizes
    async recalculateCurveOld(radius) {
        let geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
            //    console.log("Recalculating Mesh Geometry"+geometry)
        } else {
            //    console.log("Recalculating First Geometry"+geometry)
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeMap.js')

        // we will be calculating the tile vertex positions in ECEF
        // but they will be relative to the tileCenter
        //
        const tileCenter = this.mesh.position;

        // for a tileSegments x tileSegments mesh, that's tileSegments squares on a side
        // but an extra row and column of vertices
        // so (tileSegments+1) x (tileSegments+1) points
        //

        const nPosition = Math.sqrt(geometry.attributes.position.count) // size of side of mesh in points

        const xTile = this.x;
        const yTile = this.y;
        const zoomTile = this.z;

        // Sample the geoid at tile corners once; bilinearly interpolated per vertex.
        // Identical visual result to per-vertex lookup, ~64x cheaper.
        const geoidCorners = geoidCorrectionForTile(this.map.options.mapProjection, zoomTile, xTile, yTile);

        // V5 Phase 1.2: begin transactional bounds measurement.
        this.beginRenderedBoundsMeasurement(geometry.attributes.position.count);

        for (let i = 0; i < geometry.attributes.position.count; i++) {

            const xIndex = i % nPosition
            const yIndex = Math.floor(i / nPosition)

            // calculate the fraction of the tile that the vertex is in
            let yTileFraction = yIndex / (nPosition - 1)
            let xTileFraction = xIndex / (nPosition - 1)

            //    assert(xTileFraction >= 0 && xTileFraction < 1, 'xTileFraction out of range in QuadTreeMap.js')

            // clamp the fractions to keep it in the tile bounds
            // this is to avoid using adjacent tiles when we have perfect match
            // HOWEVER, not going to fully help with dynamic subdivision seams
            if (xTileFraction >= 1) xTileFraction = 1 - 1e-6;
            if (yTileFraction >= 1) yTileFraction = 1 - 1e-6;


            // get that in world tile coordinates
            const xWorld = xTile + xTileFraction;
            const yWorld = yTile + yTileFraction;

            // convert that to lat/lon
            const lat = this.map.options.mapProjection.getNorthLatitude(yWorld, zoomTile);
            const lon = this.map.options.mapProjection.getLeftLongitude(xWorld, zoomTile);

            // get the elevation, independent of the display map coordinate system
            let elevation = this.map.getElevationInterpolated(lat, lon, zoomTile);

            // clamp to geoid sea level to avoid z-fighting with ocean tiles
            const seaLevel = interpolateGeoidOffset(geoidCorners, xTileFraction, yTileFraction);
            if (elevation < seaLevel) elevation = seaLevel;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }
            // V5 Phase 1.2: feed measurement.
            this._addRenderedVertex(elevation);

            // elevation = Math.random()*100000

            // Convert to ECEF and translate to tile-local space; in-place to avoid GC.
            LLAToECEFInto(lat, lon, elevation, _vertexScratch).sub(tileCenter);

            assert(!isNaN(_vertexScratch.x), 'vertex.x is NaN in QuadTreeMap.js i=' + i)
            assert(!isNaN(_vertexScratch.y), 'vertex.y is NaN in QuadTreeMap.js')
            assert(!isNaN(_vertexScratch.z), 'vertex.z is NaN in QuadTreeMap.js')

            // set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, _vertexScratch.x, _vertexScratch.y, _vertexScratch.z);
        }

        // Generate elevation color texture if needed (using interpolated elevation data)
        this.generateElevationColorTextureInterpolated().catch(error => {
            console.warn(`Failed to generate interpolated elevation color texture for tile ${this.key()}:`, error);
        });

        // Also check if we can now use actual elevation tile data instead of interpolated
        this.checkAndApplyElevationColorTexture();

        // Update geometry using async worker for normal computation
        await fastComputeVertexNormalsAsync(geometry)

        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        geometry.attributes.position.needsUpdate = true;

        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        } else if (this._measurement) {
            this._markSkirtCommitted();
        }
        // V5 Phase 1.2: commit transactional measurement.
        this._commitRenderedBounds();
    }


    // recalculat the X,Y, Z values for all the verticles of a tile
    // based on the X/Y/Z of the tile
    // handles cases where the map are both projection is Web Mercator as a special optimazed case
    // if projections are different, falls back to old method
    // if they are the same but not Web Mercator, uses optimized method with direct tile elevation lookup
    async recalculateCurve(radius = wgs84.RADIUS) {

        this.isRecalculatingCurve = true;
        this.highestAltitude = 0;

        try {
            if (this.map.options.elevationMap.options.elevationType === "Flat") {
                return await this.recalculateCurveFlat()
            }

            // Use optimized Web Mercator version if we're using GoogleMapsCompatible projection
            if (this.map.options.mapProjection && this.map.options.mapProjection.name === "GoogleMapsCompatible") {
                return await this.recalculateCurveWebMercator(radius);
            }

            // if the map projection is different to the elevation map projection, fall back to old method
            if (this.map.options.mapProjection.name !== this.map.elevationMap.options.mapProjection.name)
                return await this.recalculateCurveOld(radius);

            // Use optimized version with direct tile elevation lookup
            // This works when both projections are the same and tiles are aligned
            return await this.recalculateCurveOptimized(radius);
        } finally {
            this.isRecalculatingCurve = false;
        }
    }

    // NEW OPTIMIZED VERSION - works with elevation tiles at same or lower zoom levels
    // Tries exact coordinate match first, then searches parent tiles (lower zoom) and uses tile fractions
    // Applies elevation data directly from elevation tiles with bilinear interpolation
    async recalculateCurveOptimized(radius = wgs84.RADIUS) {
        this.highestAltitude = 0;

        let geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeTile.js')

        const tileCenter = this.mesh.position;

        let elevationTile = null;
        let elevationZoom = this.z;
        let tileOffsetX = 0;
        let tileOffsetY = 0;
        let tileFractionX = 1.0;
        let tileFractionY = 1.0;

        elevationTile = this.map.elevationMap?.getTile(this.x, this.y, this.z);

        if (!elevationTile || !elevationTile.elevation) {
            let searchX = this.x;
            let searchY = this.y;
            let searchZoom = this.z - 1;

            while (searchZoom >= 0) {
                searchX = Math.floor(searchX / 2);
                searchY = Math.floor(searchY / 2);
                const candidateTile = this.map.elevationMap?.getTile(searchX, searchY, searchZoom);

                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    const zoomDiff = this.z - searchZoom;
                    const tilesPerParent = Math.pow(2, zoomDiff);
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
                    break;
                }

                searchZoom--;
            }
        }

        if (!elevationTile || !elevationTile.elevation) {
            // Fallback to legacy path runs its own measurement; we
            // haven't started one yet, so nothing to abort.
            return this.recalculateCurveOld(radius);
        }

        const nPosition = Math.sqrt(geometry.attributes.position.count);
        const elevationSize = Math.sqrt(elevationTile.elevation.length);

        // V5 Phase 1.2: begin measurement now that we know we'll complete
        // the vertex loop.
        this.beginRenderedBoundsMeasurement(geometry.attributes.position.count);

        const xTile = this.x;
        const yTile = this.y;
        const zoomTile = this.z;

        // Sample the geoid at tile corners once; bilinearly interpolated per vertex.
        const geoidCorners = geoidCorrectionForTile(this.map.options.mapProjection, zoomTile, xTile, yTile);

        for (let i = 0; i < geometry.attributes.position.count; i++) {
            const xIndex = i % nPosition;
            const yIndex = Math.floor(i / nPosition);

            let yTileFraction = yIndex / (nPosition - 1);
            let xTileFraction = xIndex / (nPosition - 1);

            if (xTileFraction >= 1) xTileFraction = 1 - 1e-6;
            if (yTileFraction >= 1) yTileFraction = 1 - 1e-6;

            const xWorld = xTile + xTileFraction;
            const yWorld = yTile + yTileFraction;

            const lat = this.map.options.mapProjection.getNorthLatitude(yWorld, zoomTile);
            const lon = this.map.options.mapProjection.getLeftLongitude(xWorld, zoomTile);

            let elevationLocalX, elevationLocalY;

            if (elevationZoom === zoomTile) {
                elevationLocalX = xTileFraction * (elevationSize - 1);
                elevationLocalY = yTileFraction * (elevationSize - 1);
            } else {
                const parentOffsetX = (tileOffsetX + xTileFraction) * tileFractionX;
                const parentOffsetY = (tileOffsetY + yTileFraction) * tileFractionY;
                elevationLocalX = parentOffsetX * (elevationSize - 1);
                elevationLocalY = parentOffsetY * (elevationSize - 1);
            }

            const x0 = Math.floor(elevationLocalX);
            const x1 = Math.min(elevationSize - 1, x0 + 1);
            const y0 = Math.floor(elevationLocalY);
            const y1 = Math.min(elevationSize - 1, y0 + 1);

            const fx = elevationLocalX - x0;
            const fy = elevationLocalY - y0;

            const e00 = elevationTile.elevation[y0 * elevationSize + x0];
            const e01 = elevationTile.elevation[y0 * elevationSize + x1];
            const e10 = elevationTile.elevation[y1 * elevationSize + x0];
            const e11 = elevationTile.elevation[y1 * elevationSize + x1];

            const e0 = e00 + (e01 - e00) * fx;
            const e1 = e10 + (e11 - e10) * fx;
            let elevation = e0 + (e1 - e0) * fy;

            if (this.map.elevationMap.options.zScale) {
                elevation *= this.map.elevationMap.options.zScale;
            }

            // Clamp to geoid sea level to avoid z-fighting with ocean tiles
            const seaLevel = interpolateGeoidOffset(geoidCorners, xTileFraction, yTileFraction);
            if (elevation < seaLevel) elevation = seaLevel;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }
            // V5 Phase 1.2: feed measurement.
            this._addRenderedVertex(elevation);

            // Convert to ECEF and translate to tile-local space; in-place to avoid GC.
            LLAToECEFInto(lat, lon, elevation, _vertexScratch).sub(tileCenter);

            assert(!isNaN(_vertexScratch.x), 'vertex.x is NaN in QuadTreeTile.js i=' + i);
            assert(!isNaN(_vertexScratch.y), 'vertex.y is NaN in QuadTreeTile.js');
            assert(!isNaN(_vertexScratch.z), 'vertex.z is NaN in QuadTreeTile.js');

            geometry.attributes.position.setXYZ(i, _vertexScratch.x, _vertexScratch.y, _vertexScratch.z);
        }

        this.generateElevationColorTexture(geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom).catch(error => {
            console.warn(`Failed to generate elevation color texture for tile ${this.key()}:`, error);
        });

        await fastComputeVertexNormalsAsync(geometry).catch(error => {
            console.warn(`Failed to compute vertex normals for tile ${this.key()}:`, error);
        });

        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;

        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        } else if (this._measurement) {
            this._markSkirtCommitted();
        }
        // V5 Phase 1.2: commit measurement.
        this._commitRenderedBounds();

        EventManager.dispatchEvent("tileChanged", this);
    }

    // Flat version of recalculateCurve that assumes elevation is always 0
    // This skips all elevation tile lookups and interpolation for better performance
    // when using flat terrain
    async recalculateCurveFlat(skipNormalComputation = false) {
        this.highestAltitude = 0;

        let geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeTile.js')

        // Get the tile center for relative positioning
        const tileCenter = this.mesh.position;

        // Get dimensions
        const nPosition = Math.sqrt(geometry.attributes.position.count); // size of side of mesh in points

        // V5 Phase 1.2: begin transactional measurement (flat → all zeros).
        this.beginRenderedBoundsMeasurement(geometry.attributes.position.count);

        // Apply flat elevation (0) to all vertices
        for (let i = 0; i < geometry.attributes.position.count; i++) {
            const xIndex = i % nPosition;
            const yIndex = Math.floor(i / nPosition);

            // Calculate the fraction of the tile that the vertex is in
            let yTileFraction = yIndex / (nPosition - 1);
            let xTileFraction = xIndex / (nPosition - 1);

            // Clamp fractions to tile bounds
            if (xTileFraction >= 1) xTileFraction = 1 - 1e-6;
            if (yTileFraction >= 1) yTileFraction = 1 - 1e-6;

            // Get world tile coordinates
            const xWorld = this.x + xTileFraction;
            const yWorld = this.y + yTileFraction;

            // Convert to lat/lon
            const lat = this.map.options.mapProjection.getNorthLatitude(yWorld, this.z);
            const lon = this.map.options.mapProjection.getLeftLongitude(xWorld, this.z);

            // Use flat elevation (0)
            const elevation = 0;
            // V5 Phase 1.2: feed measurement.
            this._addRenderedVertex(elevation);

            // Convert to ECEF coordinates
            const vertexECEF = LLAToECEF(lat, lon, elevation);

            // Subtract the center of the tile for relative positioning
            const vertex = vertexECEF.sub(tileCenter);

            assert(!isNaN(vertex.x), 'vertex.x is NaN in QuadTreeTile.js i=' + i);
            assert(!isNaN(vertex.y), 'vertex.y is NaN in QuadTreeTile.js');
            assert(!isNaN(vertex.z), 'vertex.z is NaN in QuadTreeTile.js');

            // Set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }

        // Generate elevation color texture if needed (all blue since elevation is 0)
        this.generateElevationColorTextureFlat().catch(error => {
            console.warn(`Failed to generate flat elevation color texture for tile ${this.key()}:`, error);
        });


        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;

        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        } else if (this._measurement) {
            this._markSkirtCommitted();
        }
        // V5 Phase 1.2: commit measurement.
        this._commitRenderedBounds();

        if (skipNormalComputation) {
            return;
        }

        // Update geometry using async worker for normal computation
        await fastComputeVertexNormalsAsync(geometry).catch(error => {
            console.warn(`Failed to compute vertex normals for tile ${this.key()}:`, error);
        });
        
        EventManager.dispatchEvent("tileChanged", this);
    }

    // Optimized Web Mercator version of recalculateCurve that steps directly over tile coordinates
    // This avoids the expensive mapProjection method calls by calculating lat/lon directly
    // Assumes Web Mercator projection (EPSG:3857) - use only when mapProjection is CTileMappingGoogleMapsCompatible
    async recalculateCurveWebMercator(radius) {
        // Performance timing for optimization verification
        const startTime = performance.now();

        this.highestAltitude = 0;

        let geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeTile.js')

        // Get the tile center for relative positioning
        const tileCenter = this.mesh.position;

        // Find elevation tile - try exact match first, then higher zoom levels
        let elevationTile = null;
        let elevationZoom = this.z;
        let tileOffsetX = 0;
        let tileOffsetY = 0;
        let tileFractionX = 1.0;
        let tileFractionY = 1.0;

        // First try exact match
        elevationTile = this.map.elevationMap?.getTile(this.x, this.y, this.z);

        if (!elevationTile || !elevationTile.elevation) {
            // Try lower zoom levels (parent tiles with less detailed but available elevation data)
            // Note: We must calculate parent coordinates mathematically because we're looking up
            // tiles in a different QuadTree (elevationMap) than this tile belongs to (textureMap)
            let searchX = this.x;
            let searchY = this.y;
            let searchZoom = this.z - 1;

            while (searchZoom >= 0) {
                searchX = Math.floor(searchX / 2);
                searchY = Math.floor(searchY / 2);
                const candidateTile = this.map.elevationMap?.getTile(searchX, searchY, searchZoom);

                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    // Calculate which portion of the parent tile this texture tile represents
                    const zoomDiff = this.z - searchZoom;
                    const tilesPerParent = Math.pow(2, zoomDiff);
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
                    break;
                }

                searchZoom--;
            }
        }

        if (!elevationTile || !elevationTile.elevation) {
            // No elevation tile found at any zoom level, fall back to old method
            return this.recalculateCurveOld(radius);
        }

        // Pre-calculate Web Mercator constants for this tile
        const numTiles = Math.pow(2, this.z);
        const tileBaseX = this.x;
        const tileBaseY = this.y;

        // Pre-calculate longitude constants (longitude is linear in Web Mercator)
        const lonScale = 360.0 / numTiles;
        const lonOffset = -180.0;

        // Pre-calculate latitude constants (latitude uses Web Mercator formula)
        const latScale = Math.PI / numTiles;

        // Get dimensions
        const nPosition = Math.sqrt(geometry.attributes.position.count); // size of side of mesh in points
        const elevationSize = Math.sqrt(elevationTile.elevation.length); // size of elevation data

        // Create abort controller for elevation computation (allows cancellation if tile is switched)
        this.elevationAbortController = new AbortController();

        // V5 Phase 1.2: begin transactional measurement before the inner
        // vertex pass starts. applyWebMercatorElevation calls
        // _addRenderedVertex per vertex.
        this.beginRenderedBoundsMeasurement(geometry.attributes.position.count);

        // Apply elevation and then run texture generation and normal computation in parallel
        await this.applyWebMercatorElevation(
            geometry, nPosition, elevationTile, elevationSize,
            tileBaseX, tileBaseY, numTiles, lonScale, lonOffset, latScale,
            elevationZoom, this.z, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY,
            tileCenter, this.elevationAbortController.signal
        );

        // V5 Phase 1.2: abort measurement if the vertex pass was cancelled.
        if (this.elevationAbortController?.signal.aborted) {
            this._abortRenderedBounds();
        }

        // Clear the abort controller after elevation is complete
        this.elevationAbortController = null;

        // Generate elevation color texture and compute normals in parallel
        // Both operations are independent and can run concurrently
        await Promise.all([
            this.generateElevationColorTexture(geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom).catch(error => {
                console.warn(`Failed to generate elevation color texture for tile ${this.key()}:`, error);
            }),
            fastComputeVertexNormalsAsync(geometry).catch(error => {
                console.warn(`Failed to compute vertex normals for tile ${this.key()}:`, error);
            })
        ]);

        // Update geometry after both async operations complete
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;

        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        } else if (this._measurement) {
            this._markSkirtCommitted();
        }
        // V5 Phase 1.2: commit measurement.
        this._commitRenderedBounds();

        // Performance logging
        const endTime = performance.now();
        const duration = endTime - startTime;
        // if (duration > 5) { // Only log if it takes more than 5ms
        //     console.log(`recalculateCurveWebMercator for tile ${this.key()}: ${duration.toFixed(2)}ms (${geometry.attributes.position.count} vertices)`);
        // }
        
        EventManager.dispatchEvent("tileChanged", this);
    }

    // Helper function to apply texture to mesh with proper cleanup
    applyElevationTexture(texture, logMessage) {
        // Dispose of old material if it exists
        if (this.mesh.material) {
            this.mesh.getMap()?.dispose();
        }
        if (this.mesh.material && this.mesh.material !== tileMaterial) {
            this.mesh.material.dispose();
        }

        // Create new material
        const transparency = this.map.terrainNode.UI.transparency ?? 1;
        const material = createTerrainDayNightMaterial(texture, 0.3, false, transparency);

        // Dispose of the old material properly
        const oldMaterial = this.mesh.material;
        if (oldMaterial && oldMaterial !== tileMaterial) {
            oldMaterial.getMap()?.dispose();
            oldMaterial.dispose();
        }

        this.mesh.material = material;
        this.mesh.material.needsUpdate = true;
        this.updateSkirtMaterial(); // Update skirt to use the same material

        // Force a complete refresh by temporarily removing and re-adding to scene
        if (this.mesh.parent && this.added) {
            const parent = this.mesh.parent;
            parent.remove(this.mesh);
            parent.add(this.mesh);

            // Also refresh the skirt mesh if it exists
            if (this.skirtMesh && this.skirtMesh.parent) {
                parent.remove(this.skirtMesh);
                parent.add(this.skirtMesh);
            }
        }

//        console.log(logMessage);
    }

    async generateElevationColorTexture(geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom) {
        // Only generate elevation color texture if the current map source is elevation color
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (!sourceDef.isElevationColor) {
            return;
        }

        // Ensure mesh exists before trying to apply texture
        if (!this.mesh) {
            console.warn(`Cannot generate elevation color texture for tile ${this.key()}: mesh not initialized`);
            return;
        }

//        console.log(`Generating elevation color texture for tile ${this.key()}, elevationSize: ${elevationSize}, elevationZoom: ${elevationZoom}, tileZoom: ${this.z}`);
//        console.log(`Mesh exists: ${!!this.mesh}, Mesh material: ${this.mesh ? this.mesh.material.constructor.name : 'N/A'}`);

        // Generate heightmap from tile data
        const heightmapData = this.generateHeightmapFromTileData(elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom);


        // all zero data is quite possible for ocean surface
        // // If all elevations are 0, it means elevation data is invalid - skip texture generation
        // if (heightmapData.minElevation === 0 && heightmapData.maxElevation === 0) {
        //     console.log(`Invalid elevation data (all zeros) for tile ${this.key()}, skipping texture generation`);
        //     return;
        // }

        // Get color bands from the source definition
        const colorBands = sourceDef.colorBands || null;

        // Convert heightmap to color texture (now async to load OceanSurface texture)
        const textureData = await this.heightmapToColorTexture(heightmapData, 256, null, colorBands);

//        console.log(`Elevation range: ${heightmapData.minElevation.toFixed(2)}m to ${heightmapData.maxElevation.toFixed(2)}m, Blue: ${textureData.bluePixels}, Green: ${textureData.greenPixels}, Grey: ${textureData.greyPixels}, White: ${textureData.whitePixels}`);

        // Apply the texture to the mesh
        this.applyElevationTexture(
            textureData.texture,
            `Applied elevation color texture to tile ${this.key()}, material type: ${this.mesh.material.constructor.name}, has texture: ${!!this.mesh.getMap()}`
        );
    }

    // Generate elevation color texture for flat terrain (all blue since elevation is 0)
    async generateElevationColorTextureFlat() {
        // Only generate elevation color texture if the current map source is elevation color
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (!sourceDef.isElevationColor) {
            return;
        }

        // Ensure mesh exists before trying to apply texture
        if (!this.mesh) {
            console.warn(`Cannot generate flat elevation color texture for tile ${this.key()}: mesh not initialized`);
            return;
        }

        // If we have elevation data, use the full generateElevationColorTexture method
        if (this.elevation) {
//            console.log(`Generating elevation color texture for tile ${this.key()} using direct elevation data`);
            const elevationSize = Math.sqrt(this.elevation.length);
            await this.generateElevationColorTexture(
                this.mesh.geometry,
                this, // Use this tile as the elevation source
                elevationSize,
                0, 0, 1, 1, // No offset or fraction needed for direct data
                this.z
            );
            return;
        }

//        console.log(`Generating flat elevation color texture for tile ${this.key()} (no elevation data)`);

        // Generate flat heightmap (all zeros)
        const heightmapData = this.generateHeightmapFlat();

        // Get color bands from the source definition
        const colorBands = sourceDef.colorBands || null;

        // Convert heightmap to color texture (now async to load OceanSurface texture)
        const textureData = await this.heightmapToColorTexture(heightmapData, 256, null, colorBands);

        // Apply the texture to the mesh
        this.applyElevationTexture(
            textureData.texture,
            `Applied flat elevation color texture (all blue) to tile ${this.key()}`
        );
    }

    // Generate elevation color texture using interpolated elevation data (fallback method)
    async generateElevationColorTextureInterpolated() {
        // Only generate elevation color texture if the current map source is elevation color
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (!sourceDef.isElevationColor) {
            return;
        }

        // Ensure mesh exists before trying to apply texture
        if (!this.mesh) {
            console.warn(`Cannot generate interpolated elevation color texture for tile ${this.key()}: mesh not initialized`);
            return;
        }

        // console.log(`Generating interpolated elevation color texture for tile ${this.key()}`);

        // Generate heightmap from interpolated data
        const heightmapData = this.generateHeightmapFromInterpolation();

        // If all elevations are 0, it means no elevation data is loaded yet - skip texture generation
        if (heightmapData.minElevation === 0 && heightmapData.maxElevation === 0) {
            // console.log(`No elevation data loaded yet for tile ${this.key()}, skipping texture generation`);
            return;
        }

        // Get color bands from the source definition
        const colorBands = sourceDef.colorBands || null;

        // Convert heightmap to color texture with custom test pattern colors for interpolated method
        const testPatternColors = {
            color1: [128, 0, 128], // Purple squares (different from the main method)
            color2: [255, 165, 0]  // Orange squares
        };
        const textureData = await this.heightmapToColorTexture(heightmapData, 256, testPatternColors, colorBands);

        console.log(`Interpolated elevation range: ${heightmapData.minElevation.toFixed(2)}m to ${heightmapData.maxElevation.toFixed(2)}m, Blue: ${textureData.bluePixels}, Green: ${textureData.greenPixels}, Grey: ${textureData.greyPixels}, White: ${textureData.whitePixels}`);

        // Apply the texture to the mesh
        this.applyElevationTexture(
            textureData.texture,
            `Applied interpolated elevation color texture to tile ${this.key()}`
        );
    }

    async applyMaterial() {
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (sourceDef.isDebug) {

            // Simulate failure percentage for debug tiles (see "Debuggy" source)
            // if failurePct is defined, use it to randomly fail loading by using the
            // supplied invalid url, such as https://invalid.url/doesnotexist.png
            if (!sourceDef.failurePct || this.z<5 || Math.random() * 100 >= sourceDef.failurePct) {

                // possible debugging delay
                // we make it random so that multiple tiles load in staggered fashion
                // which might better replicate real world conditions
                if (Globals.tileDelay > 0) {
                    const delayPromise = new Promise(resolve => setTimeout(resolve, Math.random() * Globals.tileDelay * 1000))
                    await delayPromise;
                }

                this.updateDebugMaterial();
                this.addAfterLoaded();

                // Return early for debug materials
                return Promise.resolve(this.mesh.material);
            }
        }

        // Handle wireframe material
        if (sourceDef.name === "Wireframe") {
            this.updateWireframeMaterial();
            
            // Remove skirt mesh for wireframe mode - wireframes don't need skirts
            if (this.skirtMesh) {
                if (this.skirtMesh.parent) {
                    this.skirtMesh.parent.remove(this.skirtMesh);
                }
                if (this.skirtMesh.geometry) {
                    this.skirtMesh.geometry.dispose();
                }
                if (this.skirtMesh.material && this.skirtMesh.material !== tileMaterial) {
                    this.skirtMesh.material.dispose();
                }
                this.skirtMesh = undefined;
            }
            
            this.addAfterLoaded();

            // Return early for wireframe materials
            return Promise.resolve(this.mesh.material);
        }

        // Handle elevation color material
        if (sourceDef.isElevationColor) {
            // For elevation color, we need to wait for elevation data and then generate the texture
            // For now, use the debug info texture showing tile coordinates
            this.updateDebugMaterial().then((material) => {
                this.addAfterLoaded();

                // Check if elevation data is already available and apply elevation color texture
                this.checkAndApplyElevationColorTexture();
            });

            // The actual elevation color texture will be applied when recalculateCurve() is called
            // or when elevation data becomes available
            return Promise.resolve(this.mesh.material);
        }

        // Don't start loading if cancellation is in progress
        if (this.isCancelling) {
            console.log(`Tile ${this.key()} is being cancelled, deferring material application`);
            return Promise.reject(new Error('Tile is being cancelled'));
        }

        // Set loading state and update debug geometry
        this.isLoading = true;
        this.updateDebugGeometry();

        return new Promise((resolve, reject) => {
            if (this.textureUrl() !== null) {
                this.buildMaterial().then((material) => {
                    // Dispose of old material if we're replacing parent data
                    if (this.usingParentData && this.mesh.material) {
                        const oldMaterial = this.mesh.material;
                        oldMaterial.getMap()?.dispose();
                        oldMaterial.dispose();
                    }

                    this.mesh.material = material
                    // Clear synchronously when the high-res material is
                    // installed. The .then() in triggerLazyLoadIfNeeded also
                    // clears this, but that runs in a later microtask — a
                    // surgical reactivation landing in the window between
                    // mesh.material = material and the .then() would see a
                    // stale usingParentData=true and stomp the freshly-
                    // installed high-res material back to parent data.
                    this.usingParentData = false;
                    this.updateSkirtMaterial(); // Update skirt to use the same material
                    if (!this.map.scene) {
                        console.warn("QuadTreeTile.applyMaterial: map.scene is not defined, not adding mesh to scene (changed levels?)")
                        this.loaded = true; // Mark as loaded even if scene is not available
                        this.map.invalidateCoverageCache(this);
                        this.isLoading = false;
                        this.isCancelling = false; // Clear cancelling state
                        this.updateDebugGeometry();
                        return resolve(material);
                    }

                    // Only add to scene if not already added (parent data tiles are already in scene)
                    if (!this.added) {
                        this.addAfterLoadedWhenReady(() => {
                            this.isLoading = false;
                            this.isCancelling = false;
                            this.updateDebugGeometry();
                        });
                    } else {
                        this.loaded = true;
                        this.map.invalidateCoverageCache(this);
                        this.isLoading = false;
                        this.isCancelling = false;
                        this.updateDebugGeometry();
                    }

                    resolve(material)
                }).catch((error) => {
                    // Even if material loading fails, mark tile as "loaded" to prevent infinite pending state
                    this.loaded = true;
                    this.map.invalidateCoverageCache(this);
                    this.isLoading = false; // Clear loading state on error
                    this.isCancelling = false; // Clear cancelling state on error
                    this.updateDebugGeometry(); // Update debug geometry to remove loading indicator
                    reject(error);
                })
            } else {
                // No texture URL available, but tile is still considered "loaded"
                this.loaded = true;
                this.map.invalidateCoverageCache(this);
                this.isLoading = false;
                this.isCancelling = false; // Clear cancelling state
                this.updateDebugGeometry();
                resolve(null)
            }
        });
    }

    addAfterLoaded() {
        this.loaded = true;
        this.map.invalidateCoverageCache(this);

        if (this.tileLayers > 0) {
            this.map.scene.add(this.mesh);
            if (this.skirtMesh) {
                this.map.scene.add(this.skirtMesh);
            }
            this.added = true;

            this.map.setTileLayerMask(this, this.tileLayers);
        }
    }

    addAfterLoadedWhenReady(callback) {
        const addToScene = () => {
            if (this.map.scene) {
                this.addAfterLoaded();
                if (callback) callback();
            }
        };

        if (this.geometryReady) {
            addToScene();
        } else if (this.curvePromise) {
            this.curvePromise.then(() => {
                addToScene();
            }).catch(() => {
                this.addAfterLoaded();
                if (callback) callback();
            });
        } else {
            addToScene();
        }
    }

    buildMesh() {
        this.mesh = new Mesh(this.geometry, tileMaterial)
//        console.log(`buildMesh: ${this.key()} - mesh created with layers.mask=${this.mesh.layers.mask.toString(2)} (${this.mesh.layers.mask})`);

        // V5 shadows: terrain casts and receives when the user opts in via the
        // Lighting menu's "Terrain receives shadows" toggle. Skirts are NEVER
        // receivers (degenerate UVs/normals -> seam artifacts) and NEVER casters.
        // We read from Globals.terrainReceivesShadow which mirrors the lighting
        // node's field; this avoids a NodeMan circular import here.
        if (Globals.shadowsEnabled) {
            const terrainShadows = !!Globals.terrainReceivesShadow;
            this.mesh.castShadow = terrainShadows;
            this.mesh.receiveShadow = terrainShadows;
            if (terrainShadows) {
                markShadowCastersDirty(`terrain tile ${this.key()}:buildMesh`);
            }
        }

        // Build and create skirt mesh
        this.buildSkirtGeometry();
        // Create skirt mesh with the same material as the main tile initially
        this.skirtMesh = new Mesh(this.skirtGeometry, tileMaterial);
        // V5 shadows: skirts always opt out.
        this.skirtMesh.castShadow = false;
        this.skirtMesh.receiveShadow = false;
//        console.log(`buildMesh: ${this.key()} - skirtMesh created with layers.mask=${this.skirtMesh.layers.mask.toString(2)} (${this.skirtMesh.layers.mask})`);
    }

    // Update skirt material to match the main tile material
    updateSkirtMaterial() {
        if (this.skirtMesh && this.mesh) {
            const mainMaterial = this.mesh.material;
            if (mainMaterial) {
                // Just use the same material directly
                this.skirtMesh.material = mainMaterial;
            }
        }
    }


////////////////////////////////////////////////////////////////////////////////////
    async fetchElevationTile(signal) {
        const elevationURL = this.elevationURL();

        // make sure X,Y and Z are valid. Assert on Dev, throw error otherwise
        if (this.x < 0 || this.y < 0 || this.z < 0) {
            assert(0, `Invalid tile coordinates for elevation fetch: x=${this.x}, y=${this.y}, z=${this.z}`);
            throw new Error(`Invalid tile coordinates for elevation fetch: x=${this.x}, y=${this.y}, z=${this.z}`);
        }


        if (signal?.aborted) {
            throw new Error('Aborted');
        }

        // Set elevation loading state and update debug geometry
        this.isLoadingElevation = true;
        this.updateDebugGeometry();

        if (!elevationURL) {
            // No elevation URL - this is normal for flat terrain
            // Mark the tile as having no elevation data
            this.elevation = null;
            this.elevationLoadFailed = false; // Not a failure, just no elevation source
            this.isLoadingElevation = false;
            this.updateDebugGeometry();
            return this;
        }

//        console.log(`Fetching elevation data for tile ${this.key()} from ${elevationURL}`);

        try {
            if (elevationURL.endsWith('.png') || elevationURL.includes('.pngraw')) {
                await this.handlePNGElevation(elevationURL);
            } else {
                await this.handleGeoTIFFElevation(elevationURL);
            }
            ServiceAvailability.recordSuccessByUrl(elevationURL);
            this.isLoadingElevation = false; // Clear elevation loading state
            this.updateDebugGeometry(); // Update debug geometry to remove elevation loading indicator
            return this;
        } catch (error) {
            ServiceAvailability.recordFailureByUrl(elevationURL);
            this.isLoadingElevation = false; // Clear elevation loading state on error
            this.updateDebugGeometry(); // Update debug geometry to remove elevation loading indicator
            throw error;
        }
    }

    async handleGeoTIFFElevation(url) {
        // Use plain fetch with concurrency limiting instead of quickFetch.
        // GeoTIFF elevation tiles are small (~130KB) and don't need chunked downloads.
        // quickFetch's Range requests multiply connections to the server, which overwhelms
        // dynamic rendering endpoints like USGS exportImage.
        const response = await geoTiffFetchWithLimit(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const tiff = await fromArrayBuffer(arrayBuffer); // Use GeoTIFF library to parse the array buffer
        const image = await tiff.getImage();

        const width = image.getWidth();
        const height = image.getHeight();
        console.log(`GeoTIFF x = ${this.x} y = ${this.y}, z = ${this.z}, width=${width}, height=${height}`);

        const processedElevation = convertTIFFToElevationArray(image);
        this.computeElevationFromGeoTIFF(processedElevation, width, height);


    }

    async handlePNGElevation(url) {
        return new Promise((resolve, reject) => {
            getPixels(url, (err, pixels) => {
                if (err) {
                    reject(new Error(`PNG processing error: ${err.message}`));
                    return;
                }
                if (url.includes('.pngraw')) {
                    this.computeElevationFromRGBA_MB(pixels);
                } else {
                    this.computeElevationFromRGBA(pixels);
                }
                resolve();
            });
        });
    }

    computeElevationFromRGBA(pixels) {
        this.shape = pixels.shape;
        const width = pixels.shape[0];
        const height = pixels.shape[1];
        const elevation = new Float32Array(width * height);
        const geoidCorners = geoidCorrectionForTile(this.map.options.mapProjection, this.z, this.x, this.y);
        const xScale = width > 1 ? 1 / (width - 1) : 0;
        const yScale = height > 1 ? 1 / (height - 1) : 0;
        for (let i = 0; i < width; i++) {
            for (let j = 0; j < height; j++) {
                const ij = i + width * j;
                const rgba = ij * 4;
                elevation[ij] =
                    pixels.data[rgba] * 256.0 +
                    pixels.data[rgba + 1] +
                    pixels.data[rgba + 2] / 256.0 -
                    32768.0 +
                    interpolateGeoidOffset(geoidCorners, i * xScale, j * yScale);
            }
        }
        this.elevation = elevation;
    }

    // Mapbox is height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
    computeElevationFromRGBA_MB(pixels) {
        this.shape = pixels.shape;
        const width = pixels.shape[0];
        const height = pixels.shape[1];
        const elevation = new Float32Array(width * height);
        const geoidCorners = geoidCorrectionForTile(this.map.options.mapProjection, this.z, this.x, this.y);
        const xScale = width > 1 ? 1 / (width - 1) : 0;
        const yScale = height > 1 ? 1 / (height - 1) : 0;
        for (let i = 0; i < width; i++) {
            for (let j = 0; j < height; j++) {
                const ij = i + width * j;
                const rgba = ij * 4;
                elevation[ij] =
                    (pixels.data[rgba] * 256.0 * 256.0 +
                        pixels.data[rgba + 1] * 256 +
                        pixels.data[rgba + 2]) * 0.1
                    - 10000 +
                    interpolateGeoidOffset(geoidCorners, i * xScale, j * yScale);
            }
        }
        this.elevation = elevation;
    }

    computeElevationFromGeoTIFF(elevationData, width, height) {
        if (!elevationData || elevationData.length !== width * height) {
            throw new Error('Invalid elevation data dimensions');
        }

        this.shape = [width, height];

        // Apply geoid correction (convert from MSL/NAVD88 to HAE) — same as PNG path.
        // Without this, tiles at different positions get different uncorrected geoid offsets,
        // causing visible discontinuities at tile boundaries.
        const geoidCorners = geoidCorrectionForTile(this.map.options.mapProjection, this.z, this.x, this.y);
        const xScale = width > 1 ? 1 / (width - 1) : 0;
        const yScale = height > 1 ? 1 / (height - 1) : 0;

        const stats = { min: Infinity, max: -Infinity, nanCount: 0 };

        for (let i = 0; i < width; i++) {
            for (let j = 0; j < height; j++) {
                const idx = j * width + i;
                let value = elevationData[idx];
                if (Number.isNaN(value)) {
                    stats.nanCount++;
                    elevationData[idx] = 0;
                } else {
                    value += interpolateGeoidOffset(geoidCorners, i * xScale, j * yScale);
                    elevationData[idx] = value;
                    stats.min = Math.min(stats.min, value);
                    stats.max = Math.max(stats.max, value);
                }
            }
        }

        this.elevation = elevationData;

        console.log('Elevation statistics:', {
            width, height,
            min: stats.min, max: stats.max,
            nanCount: stats.nanCount, totalPoints: elevationData.length
        });
    }

    // Check if elevation data is available and apply elevation color texture if needed
    checkAndApplyElevationColorTexture() {
        // Only proceed if we're in elevation color mode
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (!sourceDef.isElevationColor) {
            return;
        }

        // if flat, then return, as the intial geometry is flat
        if (this.map.elevationMap?.options.elevationType === "Flat") {
            return;
        }

        // Only proceed if mesh exists
        if (!this.mesh) {
            return;
        }

        // Check if elevation data is available for this tile or parent tiles
        let elevationTile = null;
        let elevationZoom = this.z;
        let tileOffsetX = 0;
        let tileOffsetY = 0;
        let tileFractionX = 1.0;
        let tileFractionY = 1.0;

        // First try exact match
        elevationTile = this.map.elevationMap?.getTile(this.x, this.y, this.z);

        if (!elevationTile || !elevationTile.elevation) {
            // Try lower zoom levels (parent tiles with less detailed but available elevation data)
            // Note: We must calculate parent coordinates mathematically because we're looking up
            // tiles in a different QuadTree (elevationMap) than this tile belongs to (textureMap)
            let searchX = this.x;
            let searchY = this.y;
            let searchZoom = this.z - 1;

            while (searchZoom >= 0) {
                searchX = Math.floor(searchX / 2);
                searchY = Math.floor(searchY / 2);
                const candidateTile = this.map.elevationMap?.getTile(searchX, searchY, searchZoom);

                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    // Calculate which portion of the parent tile this texture tile represents
                    const zoomDiff = this.z - searchZoom;
                    const tilesPerParent = Math.pow(2, zoomDiff);
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
                    break;
                }

                searchZoom--;
            }
        }

        // If elevation data is available, generate the elevation color texture
        if (elevationTile && elevationTile.elevation) {
//            console.log(`Applying elevation color texture immediately for tile ${this.key()} using elevation zoom ${elevationZoom}`);
            const elevationSize = Math.sqrt(elevationTile.elevation.length);
            this.generateElevationColorTexture(this.mesh.geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom).catch(error => {
                console.warn(`Failed to generate elevation color texture for tile ${this.key()}:`, error);
            });
        } else {
            // console.log(`No elevation data available yet for tile ${this.key()}, will wait for elevation tile to load`);
        }
    }

    /**
     * Get OceanSurface texture with appropriate mipmap level for this tile's zoom
     * Uses the same optimized caching as buildStaticMipmapMaterial
     */
    async getOceanSurfaceTexture() {
        // Get the OceanSurface map source definition
        const oceanSourceDef = this.map.terrainNode.UI.mapSources.OceanSurface;
        if (!oceanSourceDef) {
            throw new Error('OceanSurface map source not found');
        }

        // Get the base URL for OceanSurface texture (same for all coordinates)
        const oceanUrl = oceanSourceDef.mapURL(0, 0, 0); // Coordinates don't matter for OceanSurface
        if (!oceanUrl) {
            throw new Error('OceanSurface URL not available');
        }

        // Use the same optimized static mipmap material building
        // This ensures we share the same cache and avoid duplicate loads
        const material = await this.buildStaticMipmapMaterial(oceanUrl, oceanSourceDef);
        return material.getMap();
    }


//////////////////////////////////////////////////////////////////////////////////

    setPosition(center) {

        // We are ignoring the passed "Center", and just calculating a local origin from the midpoint of the Lat, Lon extents

        const lat1 = this.map.options.mapProjection.getNorthLatitude(this.y, this.z);
        const lon1 = this.map.options.mapProjection.getLeftLongitude(this.x, this.z);
        const lat2 = this.map.options.mapProjection.getNorthLatitude(this.y + 1, this.z);
        const lon2 = this.map.options.mapProjection.getLeftLongitude(this.x + 1, this.z);
        const lat = (lat1 + lat2) / 2;
        const lon = (lon1 + lon2) / 2;

        const p = LLAToECEF(lat, lon, 0);

        this.mesh.position.copy(p)

        // Position the skirt mesh at the same location
        if (this.skirtMesh) {
            this.skirtMesh.position.copy(p);
            this.skirtMesh.updateMatrix();
            this.skirtMesh.updateMatrixWorld();
        }

        // we need to update the matrices, otherwise collision will not work until rendered
        // which can lead to odd asynchronous bugs where the last tiles loaded
        // don't have matrices set, and so act as holes, but this varies with loading order
        this.mesh.updateMatrix()
        this.mesh.updateMatrixWorld() //
    }

}

// Install material-building / elevation prototype methods.
Object.assign(QuadTreeTile.prototype, materialMethods);
// Preserve the QuadTreeTile.* cache statics for external callers.
QuadTreeTile.clearMaterialCache = clearMaterialCacheImpl;
QuadTreeTile.removeMaterialFromCache = removeMaterialFromCacheImpl;
QuadTreeTile.removeMaterialByCacheKey = removeMaterialByCacheKeyImpl;
QuadTreeTile.getMaterialCacheStats = getMaterialCacheStatsImpl;
QuadTreeTile.logCacheStats = logCacheStatsImpl;
