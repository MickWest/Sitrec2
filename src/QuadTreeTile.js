import {assert} from "./assert";
import {boxMark, DebugArrowAB, removeDebugArrow} from "./threeExt";
import {LLAToEUS, wgs84} from "./LLA-ECEF-ENU";
import {GlobalScene} from "./LocalFrame";
import {getLocalDownVector, getLocalNorthVector, getLocalUpVector, pointOnSphereBelow} from "./SphericalMath";
import {loadTextureWithRetries} from "./js/map33/material/QuadTextureMaterial";
import {convertTIFFToElevationArray} from "./TIFFUtils";
import {fromArrayBuffer} from 'geotiff';
import {getPixels} from "./js/get-pixels-mick";
import {PlaneGeometry} from "three/src/geometries/PlaneGeometry";
import {BufferGeometry} from "three/src/core/BufferGeometry";
import {Float32BufferAttribute} from "three/src/core/BufferAttribute";
import {Mesh} from "three/src/objects/Mesh";
import {MeshStandardMaterial} from "three/src/materials/MeshStandardMaterial";
import {Sphere} from "three/src/math/Sphere";
import {CanvasTexture} from "three/src/textures/CanvasTexture";
import {NearestFilter} from "three/src/constants";
import {globalMipmapGenerator} from "./MipmapGenerator";
import {fastComputeVertexNormals} from "./FastComputeVertexNormals";
import {showError} from "./showError";

//const tileMaterial = new MeshStandardMaterial({wireframe: true, color: "#408020", transparent: true, opacity: 0.5})

// invisible material used when we don't want to see anything but still need a mesh
const tileMaterial = new MeshStandardMaterial({
    wireframe: true,
    color: '#ffffff',
    transparent: true,
    opacity: 0.0
});

// Static cache for materials to avoid loading the same texture multiple times
const materialCache = new Map();

// Promise cache to prevent concurrent loading of the same texture
const textureLoadPromises = new Map();

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
        this.usingParentData = false; // Track if this tile is using resampled parent texture/elevation
        this.needsHighResLoad = false; // Track if this tile needs to load high-res data when visible
        
        // AbortController for cancelling texture loading
        this.textureAbortController = null;
        
        // Private property to store tileLayers value
        this._tileLayers = undefined;
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

        // convert to EUS
        const alt = 0;
        const vertexSW = LLAToEUS(latSW, lonSW, alt)
        const vertexNW = LLAToEUS(latNW, lonNW, alt)
        const vertexSE = LLAToEUS(latSE, lonSE, alt)
        const vertexNE = LLAToEUS(latNE, lonNE, alt)

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
        return this.worldSphere;

        // if (!tile.mesh.geometry.boundingSphere) {
        //     tile.mesh.geometry.computeBoundingSphere();
        // }
        // const worldSphere = tile.mesh.geometry.boundingSphere.clone();
        // worldSphere.applyMatrix4(tile.mesh.matrixWorld);
        // return worldSphere;
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
        const geometry = new PlaneGeometry(
            this.size,
            this.size,
            this.map.options.tileSegments,
            this.map.options.tileSegments
        )

        this.geometry = geometry
    }

    // Create skirt geometry that extends downward around the tile edges
    buildSkirtGeometry() {
        const segments = this.map.options.tileSegments;
        const halfSize = this.size / 2;
        const skirtDepth = this.size * 0.1; // 1/10 the width of the tile
        
        // Calculate the center position of the tile in world coordinates
        const lat1 = this.map.options.mapProjection.getNorthLatitude(this.y, this.z);
        const lon1 = this.map.options.mapProjection.getLeftLongitude(this.x, this.z);
        const lat2 = this.map.options.mapProjection.getNorthLatitude(this.y + 1, this.z);
        const lon2 = this.map.options.mapProjection.getLeftLongitude(this.x + 1, this.z);
        const centerLat = (lat1 + lat2) / 2;
        const centerLon = (lon1 + lon2) / 2;
        const centerPosition = LLAToEUS(centerLat, centerLon, 0);
        
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
            // Bottom edge (y = 0)
            { start: [0, 0], end: [segments, 0], direction: [1, 0] },
            // Right edge (x = segments)
            { start: [segments, 0], end: [segments, segments], direction: [0, 1] },
            // Top edge (y = segments)
            { start: [segments, segments], end: [0, segments], direction: [-1, 0] },
            // Left edge (x = 0)
            { start: [0, segments], end: [0, 0], direction: [0, -1] }
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
                
                // Get the normal from the main tile surface for fake lighting
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
                
                // Two triangles per segment (clockwise winding for outward-facing normals)
                // Triangle 1: current top, next top, current bottom
                indices.push(currentVertexIndex, nextVertexIndex, currentVertexIndex + 1);
                // Triangle 2: current bottom, next top, next bottom
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
        const centerPosition = LLAToEUS(centerLat, centerLon, 0);
        
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
            { start: [0, 0], end: [segments, 0], direction: [1, 0] },
            // Right edge (x = segments)
            { start: [segments, 0], end: [segments, segments], direction: [0, 1] },
            // Top edge (y = segments)
            { start: [segments, segments], end: [0, segments], direction: [-1, 0] },
            // Left edge (x = 0)
            { start: [0, segments], end: [0, 0], direction: [0, -1] }
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
    }

    // Dispose of this tile's resources (but keep materials in cache for reuse)
    dispose() {
        // Remove debug geometry first
        this.removeDebugGeometry();
        
        // Remove mesh from scene if it exists
        if (this.mesh) {
            if (this.mesh.parent) {
                this.mesh.parent.remove(this.mesh);
            }
            
            // Dispose geometry (but not material since it's cached)
            if (this.mesh.geometry) {
                this.mesh.geometry.dispose();
            }
            
            // Note: We don't dispose the material here since it's cached
            // and may be used by other tiles. Use static methods to manage cache.
            
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



    buildDebugGeometry(color ="#FF00FF", altitude = 0) {
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

        // convert to EUS
        const alt = 10000 + altitude;
        const vertexSW = LLAToEUS(latSW, lonSW, alt)
        const vertexNW = LLAToEUS(latNW, lonNW, alt)
        const vertexSE = LLAToEUS(latSE, lonSE, alt)
        const vertexNE = LLAToEUS(latNE, lonNE, alt)

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
    recalculateCurveOld(radius) {
        var geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
            //    console.log("Recalculating Mesh Geometry"+geometry)
        } else {
            //    console.log("Recalculating First Geometry"+geometry)
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeMap.js')

        // we will be calculating the tile vertex positions in EUS
        // but they will be relative to the tileCenter
        //
        const tileCenter = this.mesh.position;

        // for a 100x100 mesh, that's 100 squares on a side
        // but an extra row and column of vertices
        // so 101x101 points = 10201 points
        //

        const nPosition = Math.sqrt(geometry.attributes.position.count) // size of side of mesh in points

        const xTile = this.x;
        const yTile = this.y;
        const zoomTile = this.z;


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

            // clamp to sea level to avoid z-fighting with ocean tiles
            if (elevation < 0) elevation = 0;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }

           // elevation = Math.random()*100000

            // convert that to EUS
            const vertexESU = LLAToEUS(lat, lon, elevation)

            // subtract the center of the tile
            const vertex = vertexESU.sub(tileCenter)

            assert(!isNaN(vertex.x), 'vertex.x is NaN in QuadTreeMap.js i=' + i)
            assert(!isNaN(vertex.y), 'vertex.y is NaN in QuadTreeMap.js')
            assert(!isNaN(vertex.z), 'vertex.z is NaN in QuadTreeMap.js')

            // set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }

        // Generate elevation color texture if needed (using interpolated elevation data)
        this.generateElevationColorTextureInterpolated().catch(error => {
            console.warn(`Failed to generate interpolated elevation color texture for tile ${this.key()}:`, error);
        });
        
        // Also check if we can now use actual elevation tile data instead of interpolated
        this.checkAndApplyElevationColorTexture();

        // Optimized version - much faster than the original
        // might be an ideal candidate for multi-threading
        fastComputeVertexNormals(geometry)

        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        geometry.attributes.position.needsUpdate = true;
        
        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        }
    }

    // NEW OPTIMIZED VERSION - works with elevation tiles at same or lower zoom levels
    // Tries exact coordinate match first, then searches parent tiles (lower zoom) and uses tile fractions
    // Applies elevation data directly from elevation tiles with bilinear interpolation
    recalculateCurve(radius=wgs84.RADIUS) {

        this.highestAltitude = 0;

         if (this.map.options.elevationMap.options.elevationType === "Flat") {
             return this.recalculateCurveFlat(radius)
         }

        // Use optimized Web Mercator version if we're using GoogleMapsCompatible projection
        if (this.map.options.mapProjection && this.map.options.mapProjection.name === "GoogleMapsCompatible") {
            return this.recalculateCurveWebMercator(radius);
        }

        var geometry = this.geometry;
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
            for (let searchZoom = this.z - 1; searchZoom >= 0; searchZoom--) {
                // Calculate which parent tile covers this tile
                const zoomDiff = this.z - searchZoom;
                const tilesPerParent = Math.pow(2, zoomDiff);
                
                // Find the parent tile coordinates
                const elevationX = Math.floor(this.x / tilesPerParent);
                const elevationY = Math.floor(this.y / tilesPerParent);
                const candidateTile = this.map.elevationMap.getTile(elevationX, elevationY, searchZoom);
                
                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    // Calculate which portion of the parent tile this texture tile represents
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
//                    console.log(`Using parent elevation tile ${elevationKey} (zoom ${searchZoom}) for texture tile ${this.key()}`);
                    break;
                }
            }
        }
        
        if (!elevationTile || !elevationTile.elevation) {
            // No elevation tile found at any zoom level, fall back to old method
//            console.warn(`No elevation tile found for ${this.key()} at any zoom level, falling back to interpolated method`);
            return this.recalculateCurveOld(radius);
        }

        // Get dimensions
        const nPosition = Math.sqrt(geometry.attributes.position.count); // size of side of mesh in points
        const elevationSize = Math.sqrt(elevationTile.elevation.length); // size of elevation data

        // Log the tile information for debugging
        if (elevationZoom !== this.z) {
//            console.log(`Tile ${this.key()}: using elevation zoom ${elevationZoom} (${elevationSize}x${elevationSize}) for texture zoom ${this.z} (${nPosition}x${nPosition}), fraction: ${tileFractionX.toFixed(3)}x${tileFractionY.toFixed(3)}`);
        } else if (nPosition !== elevationSize && nPosition !== elevationSize + 1) {
//            console.log(`Tile ${this.key()}: geometry ${nPosition}x${nPosition} vertices, elevation ${elevationSize}x${elevationSize} data points`);
        }

        // Apply elevation data directly to vertices
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

            // Get elevation with bilinear interpolation from the elevation tile data
            // Map vertex position to elevation data coordinates, accounting for tile fraction and offset
            // If we're using a higher-zoom elevation tile, we need to map to the correct portion
            let elevationLocalX, elevationLocalY;
            
            if (elevationZoom === this.z) {
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

            // Clamp to sea level to avoid z-fighting with ocean tiles
            if (elevation < 0) elevation = 0;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }

            // Convert to EUS coordinates
            const vertexESU = LLAToEUS(lat, lon, elevation);

            // Subtract the center of the tile for relative positioning
            const vertex = vertexESU.sub(tileCenter);

            assert(!isNaN(vertex.x), 'vertex.x is NaN in QuadTreeTile.js i=' + i);
            assert(!isNaN(vertex.y), 'vertex.y is NaN in QuadTreeTile.js');
            assert(!isNaN(vertex.z), 'vertex.z is NaN in QuadTreeTile.js');

            // Set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }

        // Generate elevation color texture if needed
        this.generateElevationColorTexture(geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom).catch(error => {
            console.warn(`Failed to generate elevation color texture for tile ${this.key()}:`, error);
        });

        // Update geometry
        fastComputeVertexNormals(geometry);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;
        
        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        }

    }

    // Flat version of recalculateCurve that assumes elevation is always 0
    // This skips all elevation tile lookups and interpolation for better performance
    // when using flat terrain
    recalculateCurveFlat(radius) {
        this.highestAltitude = 0;

        var geometry = this.geometry;
        if (this.mesh !== undefined) {
            geometry = this.mesh.geometry;
        }

        assert(geometry !== undefined, 'Geometry not defined in QuadTreeTile.js')

        // Get the tile center for relative positioning
        const tileCenter = this.mesh.position;

        // Get dimensions
        const nPosition = Math.sqrt(geometry.attributes.position.count); // size of side of mesh in points

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

            // Convert to EUS coordinates
            const vertexESU = LLAToEUS(lat, lon, elevation);

            // Subtract the center of the tile for relative positioning
            const vertex = vertexESU.sub(tileCenter);

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

        // Update geometry
        fastComputeVertexNormals(geometry);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;
        
        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        }
    }

    // Optimized Web Mercator version of recalculateCurve that steps directly over tile coordinates
    // This avoids the expensive mapProjection method calls by calculating lat/lon directly
    // Assumes Web Mercator projection (EPSG:3857) - use only when mapProjection is CTileMappingGoogleMapsCompatible
    recalculateCurveWebMercator(radius) {
        // Performance timing for optimization verification
        const startTime = performance.now();
        
        this.highestAltitude = 0;

        var geometry = this.geometry;
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
            for (let searchZoom = this.z - 1; searchZoom >= 0; searchZoom--) {
                // Calculate which parent tile covers this tile
                const zoomDiff = this.z - searchZoom;
                const tilesPerParent = Math.pow(2, zoomDiff);
                
                // Find the parent tile coordinates
                const elevationX = Math.floor(this.x / tilesPerParent);
                const elevationY = Math.floor(this.y / tilesPerParent);
                const candidateTile = this.map.elevationMap.getTile(elevationX, elevationY, searchZoom);
                
                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    // Calculate which portion of the parent tile this texture tile represents
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
                    break;
                }
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

        // Apply elevation data directly to vertices
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
            
            if (elevationZoom === this.z) {
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

            // Clamp to sea level to avoid z-fighting with ocean tiles
            if (elevation < 0) elevation = 0;

            if (elevation > this.highestAltitude) {
                this.highestAltitude = elevation;
            }

            // Convert to EUS coordinates
            const vertexESU = LLAToEUS(lat, lon, elevation);

            // Subtract the center of the tile for relative positioning
            const vertex = vertexESU.sub(tileCenter);

            assert(!isNaN(vertex.x), 'vertex.x is NaN in QuadTreeTile.js i=' + i);
            assert(!isNaN(vertex.y), 'vertex.y is NaN in QuadTreeTile.js');
            assert(!isNaN(vertex.z), 'vertex.z is NaN in QuadTreeTile.js');

            // Set the vertex position in tile space
            geometry.attributes.position.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }

        // Generate elevation color texture if needed
        this.generateElevationColorTexture(geometry, elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom).catch(error => {
            console.warn(`Failed to generate elevation color texture for tile ${this.key()}:`, error);
        });

        // Update geometry
        fastComputeVertexNormals(geometry);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometry.attributes.position.needsUpdate = true;
        
        // Update skirt geometry to match the new main tile geometry
        if (this.skirtMesh && this.skirtGeometry) {
            this.updateSkirtGeometry();
        }
        
        // Performance logging
        const endTime = performance.now();
        const duration = endTime - startTime;
        if (duration > 5) { // Only log if it takes more than 5ms
            console.log(`recalculateCurveWebMercator for tile ${this.key()}: ${duration.toFixed(2)}ms (${geometry.attributes.position.count} vertices)`);
        }
    }

    buildMaterial() {
        const url = this.textureUrl();
        const sourceDef = this.map.terrainNode.getMapSourceDef();
        
        // For static textures (same URL for all tiles), use a simplified cache key
        // This prevents creating separate materials for each tile of the same static texture
        // Check if URL contains tile coordinates as path parameters (more precise than simple string includes)
        const hasXParam = url && (url.includes(`/${this.x}/`) || url.includes(`x=${this.x}`) || url.includes(`&x=${this.x}`));
        const hasYParam = url && (url.includes(`/${this.y}/`) || url.includes(`y=${this.y}`) || url.includes(`&y=${this.y}`));
        const hasZParam = url && (url.includes(`/${this.z}/`) || url.includes(`z=${this.z}`) || url.includes(`&z=${this.z}`));
        const isStaticTexture = url && !hasXParam && !hasYParam && !hasZParam;
        
        // For static textures with mipmaps, we need to separate base texture loading from mipmap generation
        if (isStaticTexture && sourceDef.generateMipmaps) {
            return this.buildStaticMipmapMaterial(url, sourceDef);
        }
        
        // For non-static textures or static textures without mipmaps, use the original approach
        const cacheKey = isStaticTexture ? `static_${url}` : 
            (sourceDef.generateMipmaps ? `${url}_z${this.z}` : url);
        
        // Check if we already have a cached material for this cache key
        if (materialCache.has(cacheKey)) {
            return Promise.resolve(materialCache.get(cacheKey));
        }
        
        // Check if we're already loading this material to prevent concurrent loads
        if (textureLoadPromises.has(cacheKey)) {
//            console.log(`QuadTreeTile: Waiting for concurrent texture load: ${cacheKey}`);
            return textureLoadPromises.get(cacheKey);
        }
        
        // Create AbortController for this texture load
        this.textureAbortController = new AbortController();
        
        // Create and cache the loading promise to prevent concurrent loads
        const loadPromise = loadTextureWithRetries(url, 3, 100, 0, 0, this.textureAbortController.signal).then((texture) => {
            let finalTexture = texture;


            // Generate mipmap if enabled for this source (only for non-static textures here)
            if (sourceDef.generateMipmaps && sourceDef.maxZoom && !isStaticTexture) {
//                console.log(`QuadTreeTile: Generating mipmap for tile ${this.z}/${this.x}/${this.y}`);
                finalTexture = globalMipmapGenerator.generateTiledMipmap(
                    texture, 
                    this.z, 
                    sourceDef.maxZoom,
                    false  // Non-static textures
                );
            }
            
            const material = new MeshStandardMaterial({map: finalTexture, color: "#ffffff"});
            // Cache the material for future use
            materialCache.set(cacheKey, material);
            // Clean up the promise cache once loading is complete
            textureLoadPromises.delete(cacheKey);
            // Clear the abort controller since loading is complete
            this.textureAbortController = null;
            return material;
        }).catch((error) => {
            // Clean up on error
            textureLoadPromises.delete(cacheKey);
            this.textureAbortController = null;
            throw error;
        });
        
        textureLoadPromises.set(cacheKey, loadPromise);
        return loadPromise;
    }

    /**
     * Build material for static textures with mipmaps
     * Loads the base texture once and generates different mipmap levels from it
     */
    async buildStaticMipmapMaterial(url, sourceDef) {
        // Create cache key for the final material (includes zoom level)
        const materialCacheKey = `static_${url}_z${this.z}`;
        
        // Check if we already have the final material cached
        if (materialCache.has(materialCacheKey)) {
            return materialCache.get(materialCacheKey);
        }
        
        // Check if we're already building this specific material
        if (textureLoadPromises.has(materialCacheKey)) {
//            console.log(`QuadTreeTile: Waiting for concurrent static mipmap material build: z${this.z}`);
            return textureLoadPromises.get(materialCacheKey);
        }
        
        // Create AbortController for this texture load
        this.textureAbortController = new AbortController();
        
        // Create cache key for the base texture (without zoom level)
        const baseCacheKey = `static_${url}_base`;
        
        // Create the material building promise
        const buildPromise = (async () => {
            try {
                // First, ensure we have the base texture loaded and cached
                let baseTexture;
                if (materialCache.has(baseCacheKey)) {
                    baseTexture = materialCache.get(baseCacheKey).map;
                } else {
                    // Check if we're already loading the base texture
                    if (textureLoadPromises.has(baseCacheKey)) {
                        const cachedMaterial = await textureLoadPromises.get(baseCacheKey);
                        baseTexture = cachedMaterial.map;
                    } else {
                        
                        // Create and cache the base texture loading promise
                        const baseLoadPromise = loadTextureWithRetries(url, 3, 100, 0, 0, this.textureAbortController.signal).then((texture) => {
                            const baseMaterial = new MeshStandardMaterial({map: texture, color: "#ffffff"});
                            materialCache.set(baseCacheKey, baseMaterial);
                            // Clean up the promise cache once loading is complete
                            textureLoadPromises.delete(baseCacheKey);
                            return baseMaterial;
                        });
                        
                        textureLoadPromises.set(baseCacheKey, baseLoadPromise);
                        const cachedMaterial = await baseLoadPromise;
                        baseTexture = cachedMaterial.map;
                    }
                }
                
                // Generate the appropriate mipmap level for this zoom
                const mipmapTexture = globalMipmapGenerator.generateTiledMipmap(
                    baseTexture, 
                    this.z, 
                    sourceDef.maxZoom,
                    true  // isSeamless = true for static textures
                );
                
                const material = new MeshStandardMaterial({map: mipmapTexture, color: "#ffffff"});
                
                // Cache the final material
                materialCache.set(materialCacheKey, material);
                // Clean up the promise cache once building is complete
                textureLoadPromises.delete(materialCacheKey);
                // Clear the abort controller since loading is complete
                this.textureAbortController = null;
                
                return material;
            } catch (error) {
                // Clean up on error
                textureLoadPromises.delete(materialCacheKey);
                this.textureAbortController = null;
                throw error;
            }
        })();
        
        textureLoadPromises.set(materialCacheKey, buildPromise);
        return buildPromise;
    }

    /**
     * Create a material from parent tile's texture by extracting the appropriate quadrant
     * @param {QuadTreeTile} parentTile - The parent tile to extract texture from
     * @returns {Material} A material with the resampled texture from parent
     */
    buildMaterialFromParent(parentTile) {
        if (!parentTile || !parentTile.mesh || !parentTile.mesh.material || !parentTile.mesh.material.map) {
            console.warn(`Cannot build material from parent for tile ${this.key()}: parent data not available`);
            return null;
        }

        // Determine which quadrant of the parent this tile represents
        // Parent tile coordinates: (parentX, parentY, parentZ)
        // This tile coordinates: (this.x, this.y, this.z)
        // This tile's position within parent: (this.x % 2, this.y % 2)
        const quadrantX = this.x % 2; // 0 = left, 1 = right
        const quadrantY = this.y % 2; // 0 = top, 1 = bottom

        // Get parent texture
        const parentTexture = parentTile.mesh.material.map;
        
        // Create a canvas to extract and resample the quadrant
        const canvas = document.createElement('canvas');
        const size = 256; // Standard tile texture size
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Create a temporary image from the parent texture
        const img = parentTexture.image;
        if (!img) {
            console.warn(`Cannot build material from parent for tile ${this.key()}: parent texture has no image`);
            return null;
        }

        // Calculate source rectangle in parent texture (which quadrant to extract)
        const srcX = quadrantX * (img.width / 2);
        const srcY = quadrantY * (img.height / 2);
        const srcWidth = img.width / 2;
        const srcHeight = img.height / 2;

        // Draw the quadrant scaled up to full size
        ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, 0, 0, size, size);

        // DEBUG: Clear blue channel to make temporary tiles red/yellow
        // const imageData = ctx.getImageData(0, 0, size, size);
        // const data = imageData.data;
        // for (let i = 0; i < data.length; i += 4) {
        //     data[i + 2] = 0; // Clear blue channel (R, G, B, A)
        // }
        // ctx.putImageData(imageData, 0, 0);

        // Create texture from canvas
        const texture = new CanvasTexture(canvas);
        texture.needsUpdate = true;

        // Create and return material
        const material = new MeshStandardMaterial({map: texture, color: "#ffffff"});
        
        return material;
    }

    // Static method to clear the entire material cache
    static clearMaterialCache() {
        // Dispose of all cached materials and their textures
        materialCache.forEach((material, cacheKey) => {
            if (material.map) {
                material.map.dispose();
            }
            material.dispose();
        });
        materialCache.clear();
        // Clear the promise cache as well
        textureLoadPromises.clear();
        // Also clear the mipmap generator cache
        globalMipmapGenerator.clearCache();
        console.log('Material cache cleared');
    }

    // Method to cancel pending loads for this specific tile
    cancelPendingLoads() {
        let cancelledCount = 0;
        
        // Cancel texture loading if in progress
        if (this.isLoading) {
            // Set cancelling state to prevent reactivation during cancellation
            this.isCancelling = true;
            
            // Abort the texture loading using AbortController
            if (this.textureAbortController) {
//                console.log(`Aborting texture load for tile ${this.key()}`);
                this.textureAbortController.abort();
                this.textureAbortController = null;
                cancelledCount++;
            }
            
            const url = this.textureUrl();
            if (url) {
                const sourceDef = this.map.terrainNode.getMapSourceDef();
                
                // Determine the cache keys that might be associated with this tile
                const hasXParam = url.includes(`/${this.x}/`) || url.includes(`x=${this.x}`) || url.includes(`&x=${this.x}`);
                const hasYParam = url.includes(`/${this.y}/`) || url.includes(`y=${this.y}`) || url.includes(`&y=${this.y}`);
                const hasZParam = url.includes(`/${this.z}/`) || url.includes(`z=${this.z}`) || url.includes(`&z=${this.z}`);
                const isStaticTexture = !hasXParam && !hasYParam && !hasZParam;
                
                // Determine the single cache key for this tile's pending load
                let cacheKey;
                if (isStaticTexture && sourceDef.generateMipmaps) {
                    // For static textures with mipmaps, use the material-specific key
                    cacheKey = `static_${url}_z${this.z}`;
                } else if (isStaticTexture) {
                    // For static textures without mipmaps
                    cacheKey = `static_${url}`;
                } else {
                    // For non-static (tile-specific) textures
                    cacheKey = sourceDef.generateMipmaps ? `${url}_z${this.z}` : url;
                }
                
                // Remove the pending promise for this tile
                if (textureLoadPromises.has(cacheKey)) {
//                    console.log(`Removing pending promise for key: ${cacheKey}`);
                    textureLoadPromises.delete(cacheKey);
                }
            }
            
            // Clear the texture loading state
            this.isLoading = false;
        }
        
        // Cancel elevation loading if in progress
        if (this.isLoadingElevation) {
            // Clear the elevation loading state
            this.isLoadingElevation = false;
            cancelledCount++;
        }
        
        if (cancelledCount > 0) {
//            console.log(`Cancelled ${cancelledCount} pending load(s) for tile ${this.key()}`);
            // Update debug geometry to reflect the cancelled loading state
            this.updateDebugGeometry();
        }
    }

    // Static method to remove a specific material from cache
    static removeMaterialFromCache(url) {
        // Remove both regular and mipmap cache entries for this URL
        const keysToDelete = [];
        materialCache.forEach((material, cacheKey) => {
            if (cacheKey === url || 
                cacheKey.startsWith(`${url}_z`) || 
                cacheKey === `static_${url}` || 
                cacheKey.startsWith(`static_${url}_z`) ||
                cacheKey === `static_${url}_base`) {
                if (material.map) {
                    material.map.dispose();
                }
                material.dispose();
                keysToDelete.push(cacheKey);
            }
        });
        
        keysToDelete.forEach(key => materialCache.delete(key));
        
        // Also remove any pending promises for these keys
        const promiseKeysToDelete = [];
        textureLoadPromises.forEach((promise, cacheKey) => {
            if (cacheKey === url || 
                cacheKey.startsWith(`${url}_z`) || 
                cacheKey === `static_${url}` || 
                cacheKey.startsWith(`static_${url}_z`) ||
                cacheKey === `static_${url}_base`) {
                promiseKeysToDelete.push(cacheKey);
            }
        });
        promiseKeysToDelete.forEach(key => textureLoadPromises.delete(key));
        
        if (keysToDelete.length > 0) {
            console.log(`Materials removed from cache for URL: ${url} (${keysToDelete.length} entries)`);
        }
    }

    // Static method to get cache statistics
    static getMaterialCacheStats() {
        const stats = {
            size: materialCache.size,
            urls: Array.from(materialCache.keys()),
            staticTextures: 0,
            staticBaseTextures: 0,
            zoomSpecificTextures: 0,
            mipmapGeneratorCacheSize: globalMipmapGenerator.mipmapCache.size,
            pendingLoads: textureLoadPromises.size,
            pendingLoadKeys: Array.from(textureLoadPromises.keys())
        };
        
        // Count different types of cached textures
        stats.urls.forEach(url => {
            if (url.includes('_base')) {
                stats.staticBaseTextures++;
            } else if (url.startsWith('static_')) {
                stats.staticTextures++;
            } else if (url.includes('_z')) {
                stats.zoomSpecificTextures++;
            }
        });
        
        return stats;
    }

    // Static method to log cache statistics to console
    static logCacheStats() {
        const stats = QuadTreeTile.getMaterialCacheStats();
        console.log("=== Material Cache Statistics ===");
        console.log(`Total cached materials: ${stats.size}`);
        console.log(`Static base textures: ${stats.staticBaseTextures}`);
        console.log(`Static zoom textures: ${stats.staticTextures}`);
        console.log(`Dynamic zoom textures: ${stats.zoomSpecificTextures}`);
        console.log(`Mipmap generator cache size: ${stats.mipmapGeneratorCacheSize}`);
        console.log(`Pending texture loads: ${stats.pendingLoads}`);
        if (stats.pendingLoads > 0) {
            console.log(`Pending load keys:`, stats.pendingLoadKeys);
        }
        
        if (stats.urls.length > 0) {
            console.log("Cached URLs:");
            stats.urls.forEach(url => {
                const isStatic = !url.includes('_z');
                console.log(`  ${isStatic ? '[STATIC]' : '[ZOOM]'} ${url}`);
            });
        }
        
        // Calculate potential memory savings for static textures
        const oceanSurfaceEntries = stats.urls.filter(url => url.includes('sea water texture')).length;
        if (oceanSurfaceEntries > 0) {
            console.log(`Ocean Surface texture entries: ${oceanSurfaceEntries} (should be 1 with optimization)`);
        }
        
        return stats;
    }


    updateDebugMaterial() {
        // create a 512x512 canvas we can render things to and then use as a texture
        // this is useful for debugging the tile positions
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        // ctx.fillStyle = "#404040";
        // ctx.fillRect(0, 0, canvas.width, canvas.height);

        const color1 = "#505050";
        const color2 = "#606060";
        // draw a checkerboard pattern
        for (let y = 0; y < canvas.height; y += 64) {
            for (let x = 0; x < canvas.width; x += 64) {
                ctx.fillStyle = (x / 64 + y / 64) % 2 === 0 ? color1 : color2;
                ctx.fillRect(x, y, 64, 64);
            }
        }

        // draw a border around the canvas 1 pixel wide
        ctx.strokeStyle = "#a0a0a0";

        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, canvas.width, canvas.height);



        // draw the word "Debug" in the center of the canvas
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "48px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const text = this.key();
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
        // create a texture from the canvas
        const texture = new CanvasTexture(canvas);
        texture.minFilter = NearestFilter;
        texture.magFilter = NearestFilter;
        const material = new MeshStandardMaterial({map: texture});



        this.mesh.material = material;
        this.mesh.material.needsUpdate = true; // ensure the material is updated
        this.updateSkirtMaterial(); // Update skirt to use the same material

        // return the material wrapped in a Promise
        return new Promise((resolve) => {
            resolve(material);
        });
    }

    updateWireframeMaterial() {
        // Create a wireframe material
        const material = new MeshStandardMaterial({
            color: "#ffffff",
            wireframe: true
        });

        this.mesh.material = material;
        this.mesh.material.needsUpdate = true; // ensure the material is updated
        this.updateSkirtMaterial(); // Update skirt to use the same material

        // return the material wrapped in a Promise
        return new Promise((resolve) => {
            resolve(material);
        });
    }

    // Helper function to generate heightmap array from elevation tile data
    generateHeightmapFromTileData(elevationTile, elevationSize, tileOffsetX, tileOffsetY, tileFractionX, tileFractionY, elevationZoom, textureSize = 256) {
        const heightmap = new Float32Array(textureSize * textureSize);
        let minElevation = Infinity;
        let maxElevation = -Infinity;

        for (let y = 0; y < textureSize; y++) {
            for (let x = 0; x < textureSize; x++) {
                const index = y * textureSize + x;

                // Calculate the fraction of the tile that this pixel represents
                const xTileFraction = x / (textureSize - 1);
                const yTileFraction = y / (textureSize - 1);

                // Get elevation data coordinates, accounting for tile fraction and offset
                let elevationLocalX, elevationLocalY;
                
                if (elevationZoom === this.z) {
                    // Same zoom level - direct mapping
                    elevationLocalX = xTileFraction * (elevationSize - 1);
                    elevationLocalY = yTileFraction * (elevationSize - 1);
                } else {
                    // Lower zoom level (parent tile) - map to the specific portion of the parent
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

                heightmap[index] = elevation;
                minElevation = Math.min(minElevation, elevation);
                maxElevation = Math.max(maxElevation, elevation);
            }
        }

        return { heightmap, minElevation, maxElevation };
    }

    // Helper function to generate heightmap array using interpolated elevation data
    generateHeightmapFromInterpolation(textureSize = 256) {
        const heightmap = new Float32Array(textureSize * textureSize);
        let minElevation = Infinity;
        let maxElevation = -Infinity;

        for (let y = 0; y < textureSize; y++) {
            for (let x = 0; x < textureSize; x++) {
                const index = y * textureSize + x;

                // Calculate the fraction of the tile that this pixel represents
                const xTileFraction = x / (textureSize - 1);
                const yTileFraction = y / (textureSize - 1);

                // Get world tile coordinates
                const xWorld = this.x + xTileFraction;
                const yWorld = this.y + yTileFraction;

                // Convert to lat/lon
                const lat = this.map.options.mapProjection.getNorthLatitude(yWorld, this.z);
                const lon = this.map.options.mapProjection.getLeftLongitude(xWorld, this.z);

                // Get elevation using the interpolated method
                let elevation = this.map.getElevationInterpolated(lat, lon, this.z);

                // Clamp to sea level
                if (elevation < 0) elevation = 0;

                heightmap[index] = elevation;
                minElevation = Math.min(minElevation, elevation);
                maxElevation = Math.max(maxElevation, elevation);
            }
        }

        return { heightmap, minElevation, maxElevation };
    }

    // Helper function to generate heightmap array with flat elevation (all zeros)
    generateHeightmapFlat(textureSize = 256) {
        const heightmap = new Float32Array(textureSize * textureSize);
        // All values are already 0 due to Float32Array initialization
        return { heightmap, minElevation: 0, maxElevation: 0 };
    }

    // Helper function to convert heightmap to color texture
    async heightmapToColorTexture(heightmapData, textureSize = 256, testPatternColors = null, colorBands = null) {
        const { heightmap, minElevation, maxElevation } = heightmapData;

        const elevationScale = this.map.terrainNode.UI.elevationScale
        // Create a canvas for the elevation color texture
        const canvas = document.createElement('canvas');
        canvas.width = textureSize;
        canvas.height = textureSize;
        const ctx = canvas.getContext('2d');

        // Create image data for pixel manipulation
        const imageData = ctx.createImageData(canvas.width, canvas.height);
        const data = imageData.data;
        
        // Get OceanSurface texture for blue pixels (water areas)
        let oceanTexture = null;
        let oceanImageData = null;
        try {
            oceanTexture = await this.getOceanSurfaceTexture();
            if (oceanTexture && oceanTexture.image) {
                // Create a temporary canvas to get pixel data from ocean texture
                const oceanCanvas = document.createElement('canvas');
                oceanCanvas.width = textureSize;
                oceanCanvas.height = textureSize;
                const oceanCtx = oceanCanvas.getContext('2d');
                
                // Draw the ocean texture scaled to our texture size
                oceanCtx.drawImage(oceanTexture.image, 0, 0, textureSize, textureSize);
                oceanImageData = oceanCtx.getImageData(0, 0, textureSize, textureSize);
            }
        } catch (error) {
            console.warn('Failed to load OceanSurface texture for ElevationColor, using solid blue:', error);
        }

        let bluePixels = 0;
        let greenPixels = 0;
        let greyPixels = 0;
        let whitePixels = 0;

        // Check if we need to create a test pattern
        const needsTestPattern = minElevation === maxElevation && minElevation !== 0;

        // Default color bands if none provided (maintains backward compatibility)
        const defaultColorBands = [
            {altitude: 1, color: {red: 0, green: 0, blue: 255}}, // Blue for water/low elevation
            {altitude: 1, color: {red: 0, green: 255, blue: 0}}, // Green start
            {altitude: 6000, color: {red: 30, green: 30, blue: 30}}, // Black at 6000 feet
            {altitude: 6000, color: {red: 128, green: 128, blue: 128}}, // Grey start
            {altitude: 10000, color: {red: 255, green: 255, blue: 255}} // White at 10000 feet
        ];


        // Use provided color bands or default ones
        const bands = colorBands || defaultColorBands;
        
        // Convert altitude from feet to meters and sort by altitude
        const sortedBands = bands.map(band => ({
            altitude: band.altitude * 0.3048, // Convert feet to meters
            color: band.color
        })).sort((a, b) => a.altitude - b.altitude);

        // Helper function to interpolate between two colors
        const interpolateColor = (color1, color2, t) => {
            return {
                red: Math.round(color1.red + (color2.red - color1.red) * t),
                green: Math.round(color1.green + (color2.green - color1.green) * t),
                blue: Math.round(color1.blue + (color2.blue - color1.blue) * t)
            };
        };

        // Helper function to get color for a given elevation
        const getColorForElevation = (elevation) => {

            // scale back to original
            elevation /= elevationScale;

            // Handle special case for water level (use ocean texture if available)
            if (elevation <= 1 && oceanImageData) {
                return 'ocean'; // Special marker for ocean texture
            }

            // Find the appropriate color band
            for (let i = 0; i < sortedBands.length - 1; i++) {
                const currentBand = sortedBands[i];
                const nextBand = sortedBands[i + 1];
                
                if (elevation >= currentBand.altitude && elevation <= nextBand.altitude) {
                    // Interpolate between current and next band
                    const t = (elevation - currentBand.altitude) / (nextBand.altitude - currentBand.altitude);
                    return interpolateColor(currentBand.color, nextBand.color, t);
                }
            }
            
            // If elevation is below the first band, use the first color
            if (elevation < sortedBands[0].altitude) {
                return sortedBands[0].color;
            }
            
            // If elevation is above the last band, use the last color
            return sortedBands[sortedBands.length - 1].color;
        };

        // Surface normal modification parameters
        const normalModificationPercent = 20; // ±20% brightness adjustment
        const tiltThresholdDegrees = 45; // 45° threshold for full effect

        // Get tile center coordinates for local up/north calculation
        const tileCenterLat = this.map.options.mapProjection.getNorthLatitude(this.y + 0.5, this.z);
        const tileCenterLon = this.map.options.mapProjection.getLeftLongitude(this.x + 0.5, this.z);
        const tileCenterEUS = LLAToEUS(tileCenterLat, tileCenterLon, 0);
        
        // Get local up and north vectors for the tile center
        const localUp = getLocalUpVector(tileCenterEUS);
        const localNorth = getLocalNorthVector(tileCenterEUS);

        // Process each pixel in the canvas
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const pixelIndex = (y * canvas.width + x) * 4;
                const heightmapIndex = y * textureSize + x;
                const elevation = heightmap[heightmapIndex];

                if (needsTestPattern) {
                    // Create a checkerboard pattern for testing
                    const isEven = ((Math.floor(x / 32) + Math.floor(y / 32)) % 2) === 0;
                    if (isEven) {
                        // Use first test pattern color (default: red)
                        const color1 = testPatternColors?.color1 || [255, 0, 0];
                        data[pixelIndex] = color1[0];     // Red
                        data[pixelIndex + 1] = color1[1]; // Green
                        data[pixelIndex + 2] = color1[2]; // Blue
                    } else {
                        // Use second test pattern color (default: yellow)
                        const color2 = testPatternColors?.color2 || [255, 255, 0];
                        data[pixelIndex] = color2[0];     // Red
                        data[pixelIndex + 1] = color2[1]; // Green
                        data[pixelIndex + 2] = color2[2]; // Blue
                    }
                } else {
                    let red, green, blue;

                    // Get color for this elevation using the new dynamic system
                    const elevationColor = getColorForElevation(elevation);
                    
                    if (elevationColor === 'ocean') {
                        // Use OceanSurface texture for water/low elevation
                        const oceanPixelIndex = pixelIndex;
                        red = oceanImageData.data[oceanPixelIndex];
                        green = oceanImageData.data[oceanPixelIndex + 1];
                        blue = oceanImageData.data[oceanPixelIndex + 2];
                        bluePixels++;
                    } else {
                        // Use the interpolated color from the color bands
                        red = elevationColor.red;
                        green = elevationColor.green;
                        blue = elevationColor.blue;
                        
                        // Update pixel counters based on dominant color (for backward compatibility)
                        if (red < 100 && green < 100 && blue > 150) {
                            bluePixels++;
                        } else if (green > red && green > blue) {
                            greenPixels++;
                        } else if (red > 200 && green > 200 && blue > 200) {
                            whitePixels++;
                        } else {
                            greyPixels++;
                        }
                    }

                    // Calculate surface normal and apply tilt-based color modification
                    let colorModifier = 1.0; // Default: no modification
                    
                    // Only apply surface normal modification if we have elevation variation
                    if (maxElevation > minElevation) {
                        // Calculate surface normal from heightmap gradients
                        const scale = 1.0; // Scale factor for gradient calculation
                        
                        // Get neighboring elevation values (with boundary checks)
                        const leftX = Math.max(0, x - 1);
                        const rightX = Math.min(textureSize - 1, x + 1);
                        const topY = Math.max(0, y - 1);
                        const bottomY = Math.min(textureSize - 1, y + 1);
                        
                        const leftElevation = heightmap[y * textureSize + leftX];
                        const rightElevation = heightmap[y * textureSize + rightX];
                        const topElevation = heightmap[topY * textureSize + x];
                        const bottomElevation = heightmap[bottomY * textureSize + x];
                        
                        // Calculate gradients (dx, dy)
                        const dx = (rightElevation - leftElevation) / (2.0 * scale);
                        const dy = (bottomElevation - topElevation) / (2.0 * scale);
                        
                        // Calculate surface normal (normalized)
                        const normalLength = Math.sqrt(dx * dx + dy * dy + 1.0);
                        const surfaceNormal = {
                            x: -dx / normalLength,
                            y: 1.0 / normalLength,  // Up component
                            z: -dy / normalLength
                        };
                        
                        // Convert surface normal to world space using local up and north
                        // Project the surface normal onto the north-south axis
                        const northDot = surfaceNormal.x * localNorth.x + 
                                        surfaceNormal.y * localNorth.y + 
                                        surfaceNormal.z * localNorth.z;
                        
                        // Calculate tilt angle relative to north (in radians)
                        const tiltAngleRad = Math.asin(Math.abs(northDot));
                        const tiltAngleDeg = tiltAngleRad * (180.0 / Math.PI);
                        
                        // Apply color modification based on tilt direction and magnitude
                        if (tiltAngleDeg >= tiltThresholdDegrees) {
                            // Full effect at 45° or more
                            if (northDot > 0) {
                                // Tilting north: darken by 20%
                                colorModifier = 1.0 - (normalModificationPercent / 100.0);
                            } else {
                                // Tilting south: brighten by 20%
                                colorModifier = 1.0 + (normalModificationPercent / 100.0);
                            }
                        } else {
                            // Partial effect based on tilt angle
                            const effectStrength = tiltAngleDeg / tiltThresholdDegrees;
                            if (northDot > 0) {
                                // Tilting north: partial darkening
                                colorModifier = 1.0 - (normalModificationPercent / 100.0) * effectStrength;
                            } else {
                                // Tilting south: partial brightening
                                colorModifier = 1.0 + (normalModificationPercent / 100.0) * effectStrength;
                            }
                        }
                    }
                    
                    // Apply color modifier and clamp to valid range
                    red = Math.round(Math.min(255, Math.max(0, red * colorModifier)));
                    green = Math.round(Math.min(255, Math.max(0, green * colorModifier)));
                    blue = Math.round(Math.min(255, Math.max(0, blue * colorModifier)));

                    data[pixelIndex] = red;     // Red
                    data[pixelIndex + 1] = green; // Green
                    data[pixelIndex + 2] = blue;  // Blue
                }
                data[pixelIndex + 3] = 255; // Alpha (fully opaque)
            }
        }

        // Put the image data onto the canvas
        ctx.putImageData(imageData, 0, 0);

        // Create a texture from the canvas
        const texture = new CanvasTexture(canvas);
        texture.minFilter = NearestFilter;
        texture.magFilter = NearestFilter;
        texture.needsUpdate = true;

        return { texture, minElevation, maxElevation, bluePixels, greenPixels, greyPixels, whitePixels };
    }

    // Helper function to apply texture to mesh with proper cleanup
    applyElevationTexture(texture, logMessage) {
        // Dispose of old material if it exists
        if (this.mesh.material && this.mesh.material.map) {
            this.mesh.material.map.dispose();
        }
        if (this.mesh.material && this.mesh.material !== tileMaterial) {
            this.mesh.material.dispose();
        }

        // Create new material
        const material = new MeshStandardMaterial({map: texture});

        // Dispose of the old material properly
        const oldMaterial = this.mesh.material;
        if (oldMaterial && oldMaterial !== tileMaterial) {
            if (oldMaterial.map) {
                oldMaterial.map.dispose();
            }
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
            `Applied elevation color texture to tile ${this.key()}, material type: ${this.mesh.material.constructor.name}, has texture: ${!!this.mesh.material.map}`
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

        console.log(`Generating interpolated elevation color texture for tile ${this.key()}`);

        // Generate heightmap from interpolated data
        const heightmapData = this.generateHeightmapFromInterpolation();
        
        // If all elevations are 0, it means no elevation data is loaded yet - skip texture generation
        if (heightmapData.minElevation === 0 && heightmapData.maxElevation === 0) {
            console.log(`No elevation data loaded yet for tile ${this.key()}, skipping texture generation`);
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

    applyMaterial() {
        const sourceDef = this.map.terrainNode.UI.getSourceDef();
        if (sourceDef.isDebug) {


            this.updateDebugMaterial();
            this.addAfterLoaded();
            
            // Return early for debug materials
            return Promise.resolve(this.mesh.material);
        }
        
        // Handle wireframe material
        if (sourceDef.name === "Wireframe") {
            this.updateWireframeMaterial();
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
            if (this.textureUrl() != null) {
                this.buildMaterial().then((material) => {
                    // Dispose of old material if we're replacing parent data
                    if (this.usingParentData && this.mesh.material) {
                        const oldMaterial = this.mesh.material;
                        if (oldMaterial.map) {
                            oldMaterial.map.dispose();
                        }
                        oldMaterial.dispose();
                    }
                    
                    this.mesh.material = material
                    this.updateSkirtMaterial(); // Update skirt to use the same material
                    if (! this.map.scene) {
                        console.warn("QuadTreeTile.applyMaterial: map.scene is not defined, not adding mesh to scene (changed levels?)")
                        this.loaded = true; // Mark as loaded even if scene is not available
                        this.isLoading = false;
                        this.isCancelling = false; // Clear cancelling state
                        this.updateDebugGeometry();
                        return resolve(material);
                    }
                    
                    // Only add to scene if not already added (parent data tiles are already in scene)
                    if (!this.added) {
                        this.addAfterLoaded();
                    } else {
                        // Already in scene, just mark as loaded with high-res data
                        this.loaded = true;
                    }
                    
                    this.isLoading = false; // Clear loading state
                    this.isCancelling = false; // Clear cancelling state
                    this.updateDebugGeometry(); // Update debug geometry to remove loading indicator
                    resolve(material)
                }).catch((error) => {
                    // Even if material loading fails, mark tile as "loaded" to prevent infinite pending state
                    this.loaded = true;
                    this.isLoading = false; // Clear loading state on error
                    this.isCancelling = false; // Clear cancelling state on error
                    this.updateDebugGeometry(); // Update debug geometry to remove loading indicator
                    reject(error);
                })
            } else {
                // No texture URL available, but tile is still considered "loaded"
                this.loaded = true;
                this.isLoading = false;
                this.isCancelling = false; // Clear cancelling state
                this.updateDebugGeometry();
                resolve(null)
            }
        });
    }

    addAfterLoaded() {
//        console.log(`addAfterLoaded: ${this.key()} - BEFORE: mesh.layers.mask=${this.mesh.layers.mask.toString(2)} (${this.mesh.layers.mask}), tileLayers=${this.tileLayers ? this.tileLayers.toString(2) : 'undefined'} (${this.tileLayers})`);
        
        this.loaded = true; // mark the tile as loaded

        this.map.scene.add(this.mesh); // add the mesh to the scene
        if (this.skirtMesh) {
            this.map.scene.add(this.skirtMesh); // add the skirt mesh to the scene
        }
        this.added = true; // mark the tile as added to the scene
        
//        console.log(`addAfterLoaded: ${this.key()} - AFTER scene.add: mesh.layers.mask=${this.mesh.layers.mask.toString(2)} (${this.mesh.layers.mask}), tileLayers=${this.tileLayers ? this.tileLayers.toString(2) : 'undefined'} (${this.tileLayers})`);
        
        // Apply current layer mask (use tileLayers which may have been combined from multiple views)
        if (this.tileLayers > 0) {
            this.map.setTileLayerMask(this, this.tileLayers);
        }
        
//        console.log(`addAfterLoaded: ${this.key()} - FINAL: mesh.layers.mask=${this.mesh.layers.mask.toString(2)} (${this.mesh.layers.mask}), tileLayers=${this.tileLayers ? this.tileLayers.toString(2) : 'undefined'} (${this.tileLayers})`);
    }

    buildMesh() {
        this.mesh = new Mesh(this.geometry, tileMaterial)
//        console.log(`buildMesh: ${this.key()} - mesh created with layers.mask=${this.mesh.layers.mask.toString(2)} (${this.mesh.layers.mask})`);
        
        // Build and create skirt mesh
        this.buildSkirtGeometry();
        // Create skirt mesh with the same material as the main tile initially
         this.skirtMesh = new Mesh(this.skirtGeometry, tileMaterial);
//        console.log(`buildMesh: ${this.key()} - skirtMesh created with layers.mask=${this.skirtMesh.layers.mask.toString(2)} (${this.skirtMesh.layers.mask})`);
    }

    // Update skirt material to match the main tile material
    updateSkirtMaterial() {
        if (this.skirtMesh && this.mesh) {
            // Clone the main tile material for the skirt to avoid sharing issues
            const mainMaterial = this.mesh.material;
            if (mainMaterial) {
                // Create a new material with the same properties
                const skirtMaterial = mainMaterial.clone();
                
                // Dispose of old skirt material if it exists and is not the shared tileMaterial
                if (this.skirtMesh.material && this.skirtMesh.material !== tileMaterial) {
                    this.skirtMesh.material.dispose();
                }
                
                // Preserve the layer mask when assigning new material to skirt
                this.skirtMesh.material = skirtMaterial;
                this.skirtMesh.material.needsUpdate = true;
            }
        }
    }


////////////////////////////////////////////////////////////////////////////////////
    async fetchElevationTile(signal) {
        const elevationURL = this.elevationURL();

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
            this.isLoadingElevation = false; // Clear elevation loading state
            this.updateDebugGeometry(); // Update debug geometry to remove elevation loading indicator
            return this;
        } catch (error) {
            showError('Error fetching elevation data:', error);
            this.isLoadingElevation = false; // Clear elevation loading state on error
            this.updateDebugGeometry(); // Update debug geometry to remove elevation loading indicator
            throw error;
        }
    }

    async handleGeoTIFFElevation(url) {
        const response = await fetch(url);
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
        const elevation = new Float32Array(pixels.shape[0] * pixels.shape[1]);
        for (let i = 0; i < pixels.shape[0]; i++) {
            for (let j = 0; j < pixels.shape[1]; j++) {
                const ij = i + pixels.shape[0] * j;
                const rgba = ij * 4;
                elevation[ij] =
                    pixels.data[rgba] * 256.0 +
                    pixels.data[rgba + 1] +
                    pixels.data[rgba + 2] / 256.0 -
                   32768.0;
            }
        }
        this.elevation = elevation;
    }

    // Mapbox is height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
    computeElevationFromRGBA_MB(pixels) {
        this.shape = pixels.shape;
        const elevation = new Float32Array(pixels.shape[0] * pixels.shape[1]);
        for (let i = 0; i < pixels.shape[0]; i++) {
            for (let j = 0; j < pixels.shape[1]; j++) {
                const ij = i + pixels.shape[0] * j;
                const rgba = ij * 4;
                elevation[ij] =
                    (pixels.data[rgba] * 256.0 *256.0 +
                    pixels.data[rgba + 1] *256 +
                    pixels.data[rgba + 2] ) * 0.1
                    -10000;
            }
        }
        this.elevation = elevation;
    }

    computeElevationFromGeoTIFF(elevationData, width, height) {
        if (!elevationData || elevationData.length !== width * height) {
            throw new Error('Invalid elevation data dimensions');
        }

        this.shape = [width, height];
        this.elevation = elevationData;

        // Validate elevation data
        const stats = {
            min: Infinity,
            max: -Infinity,
            nanCount: 0
        };

        for (let i = 0; i < elevationData.length; i++) {
            const value = elevationData[i];
            if (Number.isNaN(value)) {
                stats.nanCount++;
            } else {
                stats.min = Math.min(stats.min, value);
                stats.max = Math.max(stats.max, value);
            }
        }

        // Log statistics for debugging
        console.log('Elevation statistics:', {
            width,
            height,
            min: stats.min,
            max: stats.max,
            nanCount: stats.nanCount,
            totalPoints: elevationData.length
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
        if (this.map.elevationMap?.options.elevationType == "Flat") {
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
            for (let searchZoom = this.z - 1; searchZoom >= 0; searchZoom--) {
                // Calculate which parent tile covers this tile
                const zoomDiff = this.z - searchZoom;
                const tilesPerParent = Math.pow(2, zoomDiff);
                
                // Find the parent tile coordinates
                const elevationX = Math.floor(this.x / tilesPerParent);
                const elevationY = Math.floor(this.y / tilesPerParent);
                const candidateTile = this.map.elevationMap?.getTile(elevationX, elevationY, searchZoom);
                
                if (candidateTile && candidateTile.elevation) {
                    elevationTile = candidateTile;
                    elevationZoom = searchZoom;
                    // Calculate which portion of the parent tile this texture tile represents
                    tileOffsetX = this.x % tilesPerParent;
                    tileOffsetY = this.y % tilesPerParent;
                    tileFractionX = 1.0 / tilesPerParent;
                    tileFractionY = 1.0 / tilesPerParent;
                    break;
                }
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
            console.log(`No elevation data available yet for tile ${this.key()}, will wait for elevation tile to load`);
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
        return material.map;
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

        const p = LLAToEUS(lat, lon, 0);

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

    // resolveSeamY(neighbor) {
    //     const tPosition = this.mesh.geometry.attributes.position.count
    //     const nPosition = Math.sqrt(tPosition)
    //     const nPositionN = Math.sqrt(
    //         neighbor.mesh.geometry.attributes.position.count
    //     )
    //     if (nPosition !== nPositionN) {
    //         showError("resolveSeamY only implemented for geometries of same size")
    //         return
    //     }
    //
    //     // the positions are relative to the tile centers
    //     // so we need to adjust by the offset
    //     const tileCenter = this.mesh.position;
    //     const neighborCenter = neighbor.mesh.position;
    //     const offset = neighborCenter.clone().sub(tileCenter);
    //
    //     for (let i = tPosition - nPosition; i < tPosition; i++) {
    //         // copy the entire position vector
    //         this.mesh.geometry.attributes.position.setXYZ(
    //             i,  // this is the index of the vertex in the mesh
    //             neighbor.mesh.geometry.attributes.position.getX(i - (tPosition - nPosition)) + offset.x,
    //             neighbor.mesh.geometry.attributes.position.getY(i - (tPosition - nPosition)) + offset.y,
    //             neighbor.mesh.geometry.attributes.position.getZ(i - (tPosition - nPosition)) + offset.z
    //         )
    //     }
    // }
    //
    // // TODO: this fixes the seams, but is not quite right, there are angular and texture discontinuities:
    // // http://localhost/sitrec/?custom=http://localhost/sitrec-upload/99999999/Custom-8c549374795aec6f133bfde7f25bad93.json
    // resolveSeamX(neighbor) {
    //     const tPosition = this.mesh.geometry.attributes.position.count
    //     const nPosition = Math.sqrt(tPosition)
    //     const nPositionN = Math.sqrt(
    //         neighbor.mesh.geometry.attributes.position.count
    //     )
    //     if (nPosition !== nPositionN) {
    //         showError("resolveSeamX only implemented for geometries of same size")
    //         return
    //     }
    //
    //     // the positions are relative to the tile centers
    //     // so we need to adjust by the offset
    //     const tileCenter = this.mesh.position;
    //     const neighborCenter = neighbor.mesh.position;
    //     const offset = neighborCenter.clone().sub(tileCenter);
    //
    //     for (let i = nPosition - 1; i < tPosition; i += nPosition) {
    //         // copy the entire position vector
    //         this.mesh.geometry.attributes.position.setXYZ(
    //             i,  // this is the index of the vertex in the mesh
    //             neighbor.mesh.geometry.attributes.position.getX(i - nPosition + 1) + offset.x,
    //             neighbor.mesh.geometry.attributes.position.getY(i - nPosition + 1) + offset.y,
    //             neighbor.mesh.geometry.attributes.position.getZ(i - nPosition + 1) + offset.z
    //         )
    //     }
    // }
    //
    // resolveSeams(cache, doNormals = true) {
    //     let worked = false
    //     const neighY = cache[this.keyNeighY()]
    //     const neighX = cache[this.keyNeighX()]
    //     if (this.seamY === false && neighY && neighY.mesh) {
    //         this.resolveSeamY(neighY)
    //         this.seamY = true
    //         worked = true
    //     }
    //     if (this.seamX === false && neighX && neighX.mesh) {
    //         this.resolveSeamX(neighX)
    //         this.seamX = true
    //         worked = true
    //     }
    //     if (worked) {
    //         this.mesh.geometry.attributes.position.needsUpdate = true
    //         if (doNormals)
    //             this.mesh.geometry.computeVertexNormals()
    //     }
    // }


}

// Make QuadTreeTile available globally for debugging
if (typeof window !== 'undefined') {
    window.QuadTreeTile = QuadTreeTile;
}