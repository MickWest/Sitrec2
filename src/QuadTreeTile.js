import {assert} from "./assert";
import {DebugArrowAB, removeDebugArrow} from "./threeExt";
import {LLAToEUS} from "./LLA-ECEF-ENU";
import {GlobalScene} from "./LocalFrame";
import {pointOnSphereBelow} from "./SphericalMath";
import {loadTextureWithRetries} from "./js/map33/material/QuadTextureMaterial";
import {convertTIFFToElevationArray} from "./TIFFUtils";
import { fromArrayBuffer } from 'geotiff';
import {getPixels} from "./js/get-pixels-mick";
import {MeshBasicMaterial} from "three/src/materials/MeshBasicMaterial";
import {PlaneGeometry} from "three/src/geometries/PlaneGeometry";
import {Mesh} from "three/src/objects/Mesh";
import {MeshStandardMaterial} from "three/src/materials/MeshStandardMaterial";
import {Sphere} from "three/src/math/Sphere";
import {CanvasTexture} from "three/src/textures/CanvasTexture";
import {NearestFilter} from "three/src/constants";

const tileMaterial = new MeshBasicMaterial({wireframe: true, color: "#408020"})

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
    }


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


    removeDebugGeometry() {
        if (this.debugArrows !== undefined) {
            this.debugArrows.forEach(arrow => {
                removeDebugArrow(arrow)
            })
        }
        this.debugArrows = []
    }



    buildDebugGeometry(color ="#FF00FF", altitude = 0) {
        // patch in a debug rectangle around the tile using arrows
        // this is useful for debugging the tile positions - especially elevation vs map
        // arrows are good as they are more visible than lines

        if (this.active === false) {
            color = "#808080" // grey if not active
        }

        this.removeDebugGeometry()

        if (!this.map.terrainNode.UINode.debugElevationGrid) return;


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


    }


    // recalculate the X,Y, Z values for all the verticles of a tile
    // at this point we are Z-up
    recalculateCurve(radius) {
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
            let elevation = this.map.getElevationInterpolated(lat, lon);

            // clamp to sea level to avoid z-fighting with ocean tiles
            if (elevation < 0) elevation = 0;

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

        // Removed this as it's expensive. And seems not needed for just curve flattenog.
        // might be an ideal candidate for multi-threading
        geometry.computeVertexNormals()

        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        geometry.attributes.position.needsUpdate = true;
    }


    // returns the four children tiles of this tile
    // this is used to build the QuadTextureMaterial
    // and all we do is get the four URLs of the children's textures
    // and then combine them in
    children() {
        return [
            new QuadTreeTile(this.map, this.z + 1, this.x * 2, this.y * 2),
            new QuadTreeTile(this.map, this.z + 1, this.x * 2, this.y * 2 + 1),
            new QuadTreeTile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2),
            new QuadTreeTile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2 + 1),
        ]
    }

    // QuadTextureMaterial uses four textures from the children tiles
    // (which are not actually loaded, but we have the URLs)
    // there's a custom shader to combine them together
    //
    buildMaterial() {

        const url = this.textureUrl();
        return loadTextureWithRetries(url).then((texture) => {
            return new MeshStandardMaterial({map: texture, color: "#ffffff"});
        })


        // const url = this.mapUrl();
        // // If url is a texture or a promise that resolves to a texture, handle accordingly
        // if (url) {
        //   // If url is already a texture, use it directly
        //   if (url.isTexture) {
        //     return Promise.resolve(new MeshStandardMaterial({ map: url, color: "#ffffff" }));
        //   }
        //   // If url is a string (URL), load the texture asynchronously
        //   if (typeof url === "string") {
        //     return new Promise((resolve, reject) => {
        //       const loader = new TextureLoader();
        //       loader.load(
        //           url,
        //           texture => resolve(new MeshStandardMaterial({ map: texture, color: "#ffffff" })),
        //           undefined,
        //           err => reject(err)
        //       );
        //     });
        //   }
        // }


        // If no url, use the QuadTextureMaterial which returns a Promise resolving to a material
        //  const urls = this.children().map(tile => tile.mapUrl());
        //  return QuadTextureMaterial(urls);
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
        const material = new MeshBasicMaterial({map: texture});



        this.mesh.material = material;
        this.mesh.material.needsUpdate = true; // ensure the material is updated

        // return the material wrapped in a Promise
        return new Promise((resolve) => {
            resolve(material);
        });
    }

    applyMaterial() {
        const sourceDef = this.map.terrainNode.UINode.getSourceDef();
        if (sourceDef.isDebug) {


            this.updateDebugMaterial();
            this.loaded = true; // mark the tile as loaded

            this.map.scene.add(this.mesh); // add the mesh to the scene
            this.added = true; // mark the tile as added to the scene

        }



        return new Promise((resolve, reject) => {
            if (this.textureUrl(0, 0, 0) != null) {
                this.buildMaterial().then((material) => {
                    this.mesh.material = material
                    this.map.scene.add(this.mesh); // add the mesh to the scene
                    this.added = true; // mark the tile as added to the scene
                    this.loaded = true;
                    resolve(material)
                }).catch(reject)
            } else {
                resolve(null)
            }
        });
    }

    buildMesh() {
        this.mesh = new Mesh(this.geometry, tileMaterial)
    }


////////////////////////////////////////////////////////////////////////////////////
    async fetchElevationTile(signal) {
        const elevationURL = this.elevationURL();

        if (signal?.aborted) {
            throw new Error('Aborted');
        }


        if (!elevationURL) {
            return this;
        }

//        console.log(`Fetching elevation data for tile ${this.key()} from ${elevationURL}`);

        try {
            if (elevationURL.endsWith('.png')) {
                await this.handlePNGElevation(elevationURL);
            } else {
                await this.handleGeoTIFFElevation(elevationURL);
            }
            return this;
        } catch (error) {
            console.error('Error fetching elevation data:', error);
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
                this.computeElevationFromRGBA(pixels);
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
    //         console.error("resolveSeamY only implemented for geometries of same size")
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
    //         console.error("resolveSeamX only implemented for geometries of same size")
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