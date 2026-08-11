/**
 * Material and elevation prototype methods for QuadTreeTile.
 *
 * Covers the tile-material pipeline (buildMaterial + family,
 * buildMaterialFromParent/Ancestor fallbacks while child tiles wait on their
 * own texture, and buildElevationFromAncestor for upscaling) plus
 * heightmap generation from tile elevation data, interpolation, or flat
 * fallbacks, and load-cancellation bookkeeping.
 *
 * Installed on QuadTreeTile.prototype via Object.assign (see QuadTreeTile.js).
 */

import {
    CanvasTexture,
    MeshStandardMaterial,
    NearestFilter,
} from "three";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {Globals, NodeMan} from "./Globals";
import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {loadTextureWithRetries} from "./js/map33/material/QuadTextureMaterial";
import {globalMipmapGenerator} from "./MipmapGenerator";
import {compositeWaterFromOSM, processTextureColors} from "./TextureColorProcessor";
import {createTerrainDayNightMaterial} from "./js/map33/material/TerrainDayNightMaterial";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {materialCache, textureLoadPromises} from "./QuadTreeTileCache";
import {osmTileForTile} from "./OSMWaterTileMapping";
import {unpaintedTextureImage} from "./GroundPaintState";

// Module-level implementations of the cache-management statics that used to live
// on the QuadTreeTile class. They're re-exposed as statics on the class from
// QuadTreeTile.js so external call sites (`QuadTreeTile.clearMaterialCache()`)
// keep working.
export function clearMaterialCacheImpl() {
    materialCache.forEach((material, cacheKey) => {
        material.getMap()?.dispose();
        material.dispose();
    });
    materialCache.clear();
    textureLoadPromises.clear();
    globalMipmapGenerator.clearCache();
    console.log('Material cache cleared');
}

// Targeted single-entry eviction. Used by tile-prune to free a material
// the moment its owning tile is destroyed, instead of letting it leak in
// the cache until the next clearMaterialCache() (which only fires on sitch
// reload). Idempotent — safe to call with a key that's already gone.
export function removeMaterialByCacheKeyImpl(cacheKey) {
    if (!cacheKey) return;
    const material = materialCache.get(cacheKey);
    if (material) {
        material.getMap()?.dispose();
        material.dispose();
        materialCache.delete(cacheKey);
    }
    textureLoadPromises.delete(cacheKey);
}

export function removeMaterialFromCacheImpl(url) {
    const keysToDelete = [];
    materialCache.forEach((material, cacheKey) => {
        if (cacheKey === url ||
            cacheKey.startsWith(`${url}_z`) ||
            cacheKey === `static_${url}` ||
            cacheKey.startsWith(`static_${url}_z`) ||
            cacheKey === `static_${url}_base`) {
            material.getMap()?.dispose();
            material.dispose();
            keysToDelete.push(cacheKey);
        }
    });

    keysToDelete.forEach(key => materialCache.delete(key));

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

export function getMaterialCacheStatsImpl() {
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

export function logCacheStatsImpl() {
    const stats = getMaterialCacheStatsImpl();
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

    const oceanSurfaceEntries = stats.urls.filter(url => url.includes('sea water texture')).length;
    if (oceanSurfaceEntries > 0) {
        console.log(`Ocean Surface texture entries: ${oceanSurfaceEntries} (should be 1 with optimization)`);
    }

    return stats;
}

// "Combine Terrain with OSM": work out which OSM tile covers this tile, and
// which part of it. Returns null when the combination is not possible or not
// wanted, so the caller can take the plain path.
//
// OSM stops at zoom 19 while satellite sources go deeper, so past that we take
// the deepest available OSM ancestor and use only the sub-rectangle of it that
// this tile covers.
export function osmWaterSourceForTile(tile) {
    // The flag lives on the Water Reflection node, which is what the combine
    // exists to feed. No night sky in this sitch means no node and no combine.
    if (!NodeMan.get("waterReflection", false)?.combineWithOSM) return null;

    const terrainNode = tile.map.terrainNode;
    const ui = terrainNode.UI;
    const sourceDef = terrainNode.getMapSourceDef();
    const osmDef = ui.mapSources?.osm;
    if (!osmDef || sourceDef === osmDef) return null;      // already OSM, nothing to combine
    if (!osmDef.waterColor) return null;

    // Same tiling scheme only. `mapping: 4326` selects GoogleCRS84Quad, whose
    // tiles do not line up with OSM's Web Mercator grid at all.
    if (sourceDef.mapping === 4326 || osmDef.mapping === 4326) return null;

    // srcRect comes back as fractions of the ancestor tile; the caller scales
    // them by the OSM image's pixel size.
    const {z, x, y, srcRect} = osmTileForTile(tile.z, tile.x, tile.y, osmDef.maxZoom ?? 19);

    const url = osmDef.mapURL(z, x, y);
    if (!url) return null;

    return {url, srcRect, waterColor: osmDef.waterColor};
}

// In-flight OSM water tiles, shared between terrain tiles. Past OSM's max zoom
// several terrain tiles crop from the SAME OSM ancestor, and loadTextureWithRetries
// has no dedup of its own — without this they each issue their own request to a
// rate-limited public tile server. Repeat loads after one settles are left to the
// browser's HTTP cache rather than held here.
//
// Deliberately NOT given a tile's abortSignal: the result is shared, so one tile
// being pruned must not cancel the fetch out from under its siblings.
const osmWaterImageLoads = new Map();

function loadOSMWaterImage(url) {
    const existing = osmWaterImageLoads.get(url);
    if (existing) return existing;

    const promise = loadTextureWithRetries(url, 1, 500, 0, 0, null)
        .then((texture) => {
            // Only ever read on the CPU into a canvas, never uploaded, so the
            // texture wrapper can go immediately; the image stays alive as long
            // as callers hold it.
            const image = texture.image;
            texture.dispose();
            return image;
        })
        .finally(() => {
            osmWaterImageLoads.delete(url);
        });

    osmWaterImageLoads.set(url, promise);
    return promise;
}

export const materialMethods = {
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
        // Include processColors flag in cache key to prevent mixing processed and unprocessed textures
        const processColorsSuffix = sourceDef.processColors ? '_processed' : '';
        // Combined tiles must not share a cache entry with plain ones — the URL
        // is identical either way, so without this the toggle would appear to
        // do nothing for every tile already in the cache.
        const osmWater = osmWaterSourceForTile(this);
        const osmWaterSuffix = osmWater ? '_osmwater' : '';
        const cacheKey = isStaticTexture ? `static_${url}${processColorsSuffix}${osmWaterSuffix}` :
            (sourceDef.generateMipmaps ? `${url}_z${this.z}${processColorsSuffix}${osmWaterSuffix}` : `${url}${processColorsSuffix}${osmWaterSuffix}`);

        // Check if we already have a cached material for this cache key
        if (materialCache.has(cacheKey)) {
            this.materialCacheKey = cacheKey;
            return Promise.resolve(materialCache.get(cacheKey));
        }

        // Check if we're already loading this material to prevent concurrent loads
        if (textureLoadPromises.has(cacheKey)) {
//            console.log(`QuadTreeTile: Waiting for concurrent texture load: ${cacheKey}`);
            this.materialCacheKey = cacheKey;
            return textureLoadPromises.get(cacheKey);
        }

        // Create AbortController for this texture load
        this.textureAbortController = new AbortController();
        const abortSignal = this.textureAbortController.signal;

        // Apply delay if configured
        const delayPromise = Globals.tileDelay > 0
            ? new Promise(resolve => setTimeout(resolve, Globals.tileDelay * 1000))
            : Promise.resolve();

        // Create and cache the loading promise to prevent concurrent loads.
        // One retry after 500ms: a transient failure (browser resource
        // starvation while Google 3D tiles stream, brief network blip) must not
        // permanently dead-branch the tile. Deterministic failures
        // (PlaceholderTile) skip the retry inside the loader.
        const loadPromise = delayPromise.then(() => {
            const mainLoad = loadTextureWithRetries(url, 1, 500, 0, 0, abortSignal);
            if (!osmWater) return mainLoad;

            // Both fetches start together. Chaining the OSM one after the tile's
            // own texture doubled the time each tile spent waiting on the
            // network, which showed up as tiles filling in seconds late after a
            // camera sweep. A failed OSM fetch is not fatal — the tile keeps its
            // own imagery and simply has no detectable water.
            const osmLoad = loadOSMWaterImage(osmWater.url).catch(() => null);

            return Promise.all([mainLoad, osmLoad]).then(([texture, osmImage]) => {
                if (!osmImage) return texture;
                try {
                    const rect = osmWater.srcRect ? {
                        x: osmWater.srcRect.fx * osmImage.width,
                        y: osmWater.srcRect.fy * osmImage.height,
                        w: osmWater.srcRect.fw * osmImage.width,
                        h: osmWater.srcRect.fh * osmImage.height,
                    } : null;
                    const combined = compositeWaterFromOSM(texture, osmImage, {
                        waterColor: osmWater.waterColor,
                        srcRect: rect,
                    });
                    texture.dispose();
                    return combined;
                } catch (e) {
                    return texture;
                }
            });
        }).then((texture) => {
            let finalTexture = texture;

            // Apply color processing if enabled for this source
            if (sourceDef.processColors && sourceDef.colorProcessingOptions) {
                finalTexture = processTextureColors(texture, sourceDef.colorProcessingOptions);
                // Dispose the original texture since we've created a processed version
                texture.dispose();
            }

            // Generate mipmap if enabled for this source (only for non-static textures here)
            if (sourceDef.generateMipmaps && sourceDef.maxZoom && !isStaticTexture) {
//                console.log(`QuadTreeTile: Generating mipmap for tile ${this.z}/${this.x}/${this.y}`);
                finalTexture = globalMipmapGenerator.generateTiledMipmap(
                    finalTexture,
                    this.z,
                    sourceDef.maxZoom,
                    false  // Non-static textures
                );
            }

            const transparency = this.map.terrainNode.UI.transparency ?? 1;
            const material = createTerrainDayNightMaterial(finalTexture, 0.3, false, transparency);
            // Cache the material for future use
            materialCache.set(cacheKey, material);
            // Record the key on the tile so prune can evict the cache entry
            this.materialCacheKey = cacheKey;
            // Clean up the promise cache once loading is complete
            textureLoadPromises.delete(cacheKey);
            // Clear the abort controller since loading is complete
            this.textureAbortController = null;
            return material;
        }).catch((error) => {
            // Terminal fetch failures are recorded in badTextureUrls by
            // loadTextureWithRetries itself (so processing errors here — mipmap
            // generation, color processing — never poison the URL blacklist).
            // Keep the console quiet for the expected cases: aborts, ESRI
            // placeholder tiles, and URLs already known bad from a prior attempt.
            if (error.message !== "Aborted"
                && error.message !== "PlaceholderTile"
                && error.message !== "KnownBadUrl") {
                console.warn(`Failed to load texture for tile ${this.key()} from URL: ${url}`, error);
            }

            // Clean up on error
            textureLoadPromises.delete(cacheKey);
            this.textureAbortController = null;
            throw error;
        });

        textureLoadPromises.set(cacheKey, loadPromise);
        return loadPromise;
    },

    /**
     * Build material for static textures with mipmaps
     * Loads the base texture once and generates different mipmap levels from it
     */
    async buildStaticMipmapMaterial(url, sourceDef) {
        // Include processColors flag in cache keys to prevent mixing processed and unprocessed textures
        const processColorsSuffix = sourceDef.processColors ? '_processed' : '';

        // Create cache key for the final material (includes zoom level)
        const materialCacheKey = `static_${url}_z${this.z}${processColorsSuffix}`;

        // Check if we already have the final material cached
        if (materialCache.has(materialCacheKey)) {
            this.materialCacheKey = materialCacheKey;
            return materialCache.get(materialCacheKey);
        }

        // Check if we're already building this specific material
        if (textureLoadPromises.has(materialCacheKey)) {
//            console.log(`QuadTreeTile: Waiting for concurrent static mipmap material build: z${this.z}`);
            this.materialCacheKey = materialCacheKey;
            return textureLoadPromises.get(materialCacheKey);
        }

        // Create AbortController for this texture load
        this.textureAbortController = new AbortController();
        const abortSignal = this.textureAbortController.signal;

        // Create cache key for the base texture (without zoom level)
        const baseCacheKey = `static_${url}_base${processColorsSuffix}`;

        // Create the material building promise
        const buildPromise = (async () => {
            try {
                // Apply delay if configured
                if (Globals.tileDelay > 0) {
                    await new Promise(resolve => setTimeout(resolve, Globals.tileDelay * 1000));
                }

                // First, ensure we have the base texture loaded and cached
                let baseTexture;
                if (materialCache.has(baseCacheKey)) {
                    const cachedMaterial = materialCache.get(baseCacheKey);
                    baseTexture = cachedMaterial.uniforms?.map?.value;
                } else {
                    // Check if we're already loading the base texture
                    if (textureLoadPromises.has(baseCacheKey)) {
                        const cachedMaterial = await textureLoadPromises.get(baseCacheKey);
                        baseTexture = cachedMaterial.uniforms?.map?.value;
                    } else {

                        // Create and cache the base texture loading promise
                        // One retry, matching the dynamic-tile path above. Extra
                        // important here: this static texture is shared by ALL
                        // tiles, so a single transient failure would blank the
                        // entire layer.
                        const baseLoadPromise = loadTextureWithRetries(url, 1, 500, 0, 0, abortSignal).then((texture) => {
                            let finalTexture = texture;

                            // Apply color processing if enabled for this source
                            if (sourceDef.processColors && sourceDef.colorProcessingOptions) {
                                finalTexture = processTextureColors(texture, sourceDef.colorProcessingOptions);
                                // Dispose the original texture since we've created a processed version
                                texture.dispose();
                            }

                            const transparency = this.map.terrainNode.UI.transparency ?? 1;
                            const baseMaterial = createTerrainDayNightMaterial(finalTexture, 0.3, false, transparency);
                            materialCache.set(baseCacheKey, baseMaterial);
                            // Clean up the promise cache once loading is complete
                            textureLoadPromises.delete(baseCacheKey);
                            return baseMaterial;
                        });

                        textureLoadPromises.set(baseCacheKey, baseLoadPromise);
                        const cachedMaterial = await baseLoadPromise;
                        baseTexture = cachedMaterial.uniforms?.map?.value;
                    }
                }

                if (!baseTexture) {
                    throw new Error(`Failed to load base texture for static mipmap material: baseTexture is ${baseTexture}`);
                }

                // Generate the appropriate mipmap level for this zoom
                const mipmapTexture = globalMipmapGenerator.generateTiledMipmap(
                    baseTexture,
                    this.z,
                    sourceDef.maxZoom,
                    true  // isSeamless = true for static textures
                );

                const transparency = this.map.terrainNode.UI.transparency ?? 1;
                const material = createTerrainDayNightMaterial(mipmapTexture, 0.3, false, transparency);

                // Cache the final material
                materialCache.set(materialCacheKey, material);
                this.materialCacheKey = materialCacheKey;
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
    },

    /**
     * Create a material from parent tile's texture by extracting the appropriate quadrant
     * @param {QuadTreeTile} parentTile - The parent tile to extract texture from
     * @returns {Material} A material with the resampled texture from parent
     */
    buildMaterialFromParent(parentTile) {
        if (!parentTile || !parentTile.mesh || !parentTile.mesh.material || !parentTile.mesh.getMap()) {
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
        const parentTexture = parentTile.mesh.getMap();

        // Create a canvas to extract and resample the quadrant
        const canvas = document.createElement('canvas');
        const size = 256; // Standard tile texture size
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Create a temporary image from the parent texture. Deliberately the
        // UNPAINTED image: while the parent is painted its texture.image is the
        // ground-paint canvas, and baking that into the child makes the child's
        // "original" imagery contain paint that erase/undo/clear could never remove.
        // See unpaintedTextureImage().
        const img = unpaintedTextureImage(parentTexture);
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
        // NOTE: NOT setting SRGBColorSpace here — terrain shader does lighting
        // in sRGB space (Phase 4 will convert it to linear workflow)
        texture.needsUpdate = true;

        // Create and return material
        const transparency = this.map.terrainNode.UI.transparency ?? 1;
        const material = createTerrainDayNightMaterial(texture, 0.3, false, transparency);

        return material;
    },

    /**
     * Create a material from ancestor tile's texture by extracting the appropriate region
     * This handles cases where the ancestor is multiple zoom levels away (not just immediate parent)
     * @param {QuadTreeTile} ancestorTile - The ancestor tile at maxZoom to extract texture from
     * @returns {Material} A material with the resampled texture from ancestor
     */
    buildMaterialFromAncestor(ancestorTile) {
        if (!ancestorTile || !ancestorTile.mesh || !ancestorTile.mesh.material || !ancestorTile.mesh.getMap()) {
            console.warn(`Cannot build material from ancestor for tile ${this.key()}: ancestor data not available`);
            return null;
        }

        // Calculate zoom level difference
        const zoomDiff = this.z - ancestorTile.z;
        if (zoomDiff <= 0) {
            console.warn(`Cannot build material from ancestor for tile ${this.key()}: invalid zoom difference ${zoomDiff}`);
            return null;
        }

        // Calculate which region of the ancestor tile this tile corresponds to
        // For example, if ancestor is at zoom 7 and this tile is at zoom 9 (diff=2):
        // - The ancestor covers a 4x4 grid of tiles at zoom 9 (2^2 = 4)
        // - We need to find which cell in that 4x4 grid this tile occupies
        const scale = Math.pow(2, zoomDiff); // e.g., 2^2 = 4 for zoom diff of 2

        // Calculate this tile's position relative to the ancestor's coverage area
        const relativeX = this.x - (ancestorTile.x * scale);
        const relativeY = this.y - (ancestorTile.y * scale);

        // Normalize to 0-1 range to get the region within the ancestor texture
        const regionX = relativeX / scale; // e.g., 0, 0.25, 0.5, 0.75 for scale=4
        const regionY = relativeY / scale;
        const regionWidth = 1 / scale; // e.g., 0.25 for scale=4
        const regionHeight = 1 / scale;

        // Get ancestor texture — unpainted, for the same reason as the parent path.
        const ancestorTexture = ancestorTile.mesh.getMap();
        const img = unpaintedTextureImage(ancestorTexture);
        if (!img) {
            console.warn(`Cannot build material from ancestor for tile ${this.key()}: ancestor texture has no image`);
            return null;
        }

        // Create a canvas to extract and resample the region
        const canvas = document.createElement('canvas');
        const size = 256; // Standard tile texture size
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Calculate source rectangle in ancestor texture
        const srcX = regionX * img.width;
        const srcY = regionY * img.height;
        const srcWidth = regionWidth * img.width;
        const srcHeight = regionHeight * img.height;

        // Draw the region scaled up to full size
        ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, 0, 0, size, size);

        // Create texture from canvas
        const texture = new CanvasTexture(canvas);
        // NOTE: NOT setting SRGBColorSpace here — terrain shader does lighting
        // in sRGB space (Phase 4 will convert it to linear workflow)
        texture.needsUpdate = true;

        // Create and return material
        const transparency = this.map.terrainNode.UI.transparency ?? 1;
        const material = createTerrainDayNightMaterial(texture, 0.3, false, transparency);

        return material;
    },

    /**
     * Create elevation data from ancestor tile's elevation by extracting and resampling the appropriate region
     * This handles cases where the ancestor is multiple zoom levels away (not just immediate parent)
     * @param {QuadTreeTile} ancestorTile - The ancestor tile at maxZoom to extract elevation from
     * @param {number} dataSize - The size of the output elevation array (typically 256)
     * @returns {Object} Object with {elevation: Float32Array, shape: [width, height]} or null if failed
     */
    buildElevationFromAncestor(ancestorTile, dataSize = 256) {
        if (!ancestorTile || !ancestorTile.elevation || !ancestorTile.shape) {
            console.warn(`Cannot build elevation from ancestor for tile ${this.key()}: ancestor data not available`);
            return null;
        }

        // Calculate zoom level difference
        const zoomDiff = this.z - ancestorTile.z;
        if (zoomDiff <= 0) {
            console.warn(`Cannot build elevation from ancestor for tile ${this.key()}: invalid zoom difference ${zoomDiff}`);
            return null;
        }

        // Calculate which region of the ancestor tile this tile corresponds to
        const scale = Math.pow(2, zoomDiff); // e.g., 2^2 = 4 for zoom diff of 2

        // Calculate this tile's position relative to the ancestor's coverage area
        const relativeX = this.x - (ancestorTile.x * scale);
        const relativeY = this.y - (ancestorTile.y * scale);

        // Get ancestor elevation data dimensions
        const [ancestorWidth, ancestorHeight] = ancestorTile.shape;

        // Calculate the region within the ancestor elevation data
        const regionStartX = Math.floor((relativeX / scale) * ancestorWidth);
        const regionStartY = Math.floor((relativeY / scale) * ancestorHeight);
        const regionWidth = Math.ceil(ancestorWidth / scale);
        const regionHeight = Math.ceil(ancestorHeight / scale);

        // Create output elevation array
        const elevation = new Float32Array(dataSize * dataSize);

        // Resample the ancestor elevation data to the output size
        // Use bilinear interpolation for smoother results
        for (let y = 0; y < dataSize; y++) {
            for (let x = 0; x < dataSize; x++) {
                // Map output coordinates to ancestor region coordinates
                const srcX = regionStartX + (x / dataSize) * regionWidth;
                const srcY = regionStartY + (y / dataSize) * regionHeight;

                // Bilinear interpolation
                const x0 = Math.floor(srcX);
                const x1 = Math.min(x0 + 1, ancestorWidth - 1);
                const y0 = Math.floor(srcY);
                const y1 = Math.min(y0 + 1, ancestorHeight - 1);

                const fx = srcX - x0;
                const fy = srcY - y0;

                // Get the four surrounding elevation values
                const e00 = ancestorTile.elevation[y0 * ancestorWidth + x0];
                const e10 = ancestorTile.elevation[y0 * ancestorWidth + x1];
                const e01 = ancestorTile.elevation[y1 * ancestorWidth + x0];
                const e11 = ancestorTile.elevation[y1 * ancestorWidth + x1];

                // Bilinear interpolation
                const e0 = e00 * (1 - fx) + e10 * fx;
                const e1 = e01 * (1 - fx) + e11 * fx;
                const e = e0 * (1 - fy) + e1 * fy;

                elevation[y * dataSize + x] = e;
            }
        }

        return {
            elevation: elevation,
            shape: [dataSize, dataSize]
        };
    },

    // Instance-safe wrapper around clearMaterialCacheImpl (kept as a method so
    // existing `tile.clearMaterialCache()` call sites keep working after the
    // move out of the class body). The exported module function below is what
    // QuadTreeTile.clearMaterialCache (the static) forwards to.
    clearMaterialCache() {
        clearMaterialCacheImpl();
    },

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

        // Cancel elevation computation if in progress
        if (this.elevationAbortController) {
            this.elevationAbortController.abort();
            this.elevationAbortController = null;
            cancelledCount++;
        }

        if (cancelledCount > 0) {
//            console.log(`Cancelled ${cancelledCount} pending load(s) for tile ${this.key()}`);
            // Update debug geometry to reflect the cancelled loading state
            this.updateDebugGeometry();
        }
    },



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
        const transparency = this.map.terrainNode.UI.transparency ?? 1;
        const material = createTerrainDayNightMaterial(texture, 0.3, false, transparency);


        this.mesh.material = material;
        this.mesh.material.needsUpdate = true; // ensure the material is updated
        this.updateSkirtMaterial(); // Update skirt to use the same material

        // return the material wrapped in a Promise
        return new Promise((resolve) => {
            resolve(material);
        });
    },

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
    },

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

        return {heightmap, minElevation, maxElevation};
    },

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

                // Clamp to geoid sea level
                const seaLevel = meanSeaLevelOffset(lat, lon);
                if (elevation < seaLevel) elevation = seaLevel;

                heightmap[index] = elevation;
                minElevation = Math.min(minElevation, elevation);
                maxElevation = Math.max(maxElevation, elevation);
            }
        }

        return {heightmap, minElevation, maxElevation};
    },

    // Helper function to generate heightmap array with flat elevation (all zeros)
    generateHeightmapFlat(textureSize = 256) {
        const heightmap = new Float32Array(textureSize * textureSize);
        // All values are already 0 due to Float32Array initialization
        return {heightmap, minElevation: 0, maxElevation: 0};
    },

    // Helper function to convert heightmap to color texture
    async heightmapToColorTexture(heightmapData, textureSize = 256, testPatternColors = null, colorBands = null) {
        const {heightmap, minElevation, maxElevation} = heightmapData;

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
        const tileCenterECEF = LLAToECEF(tileCenterLat, tileCenterLon, 0);

        // Get local up and north vectors for the tile center
        const localUp = getLocalUpVector(tileCenterECEF);
        const localNorth = getLocalNorthVector(tileCenterECEF);

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

        return {texture, minElevation, maxElevation, bluePixels, greenPixels, greyPixels, whitePixels};
    },

};
