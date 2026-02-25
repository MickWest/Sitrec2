/**
 * Async wrapper for elevation interpolation using a Web Worker
 *
 * Offloads the computationally expensive vertex elevation calculation to a background thread,
 * allowing the main thread to remain responsive during tile recalculation.
 *
 * This handles:
 * - Coordinate mapping and projection calculations
 * - Bilinear elevation interpolation
 * - LLA to EUS coordinate conversion
 * - Tile center relative positioning
 */

import {geoidCorrectionForTile} from "./EGM96Geoid";

let elevationWorker = null;

/**
 * Initialize the elevation interpolation worker
 */
function initElevationWorker() {
    if (!elevationWorker) {
        elevationWorker = new Worker(new URL('./ElevationInterpolationWorker.js', import.meta.url));
    }
    return elevationWorker;
}

/**
 * Apply elevation interpolation to tile geometry asynchronously
 * 
 * This function pre-calculates lat/lon in the main thread (fast operation) and
 * offloads the expensive elevation interpolation and coordinate conversion to the worker.
 * 
 * @param {BufferGeometry} geometry - The tile geometry to update with elevation data
 * @param {Object} elevationTile - Object containing elevation data array
 * @param {number} elevationSize - Size of elevation data grid (e.g., 256)
 * @param {number} elevationZoom - Zoom level of elevation tile
 * @param {number} tileX - X coordinate of this tile
 * @param {number} tileY - Y coordinate of this tile
 * @param {number} tileZ - Zoom level of this tile
 * @param {number} tileOffsetX - Offset within parent tile (if using lower zoom elevation)
 * @param {number} tileOffsetY - Offset within parent tile
 * @param {number} tileFractionX - Fraction of parent tile (if using lower zoom elevation)
 * @param {number} tileFractionY - Fraction of parent tile
 * @param {number} zScale - Scale factor for elevation values
 * @param {Vector3} tileCenter - Center position of the tile (for relative positioning)
 * @param {Object} mapProjection - Map projection object with getNorthLatitude() and getLeftLongitude()
 * @returns {Promise<{vertexPositions: Float32Array, highestAltitude: number}>}
 */
export async function applyElevationInterpolationAsync(
    geometry,
    elevationTile,
    elevationSize,
    elevationZoom,
    tileX,
    tileY,
    tileZ,
    tileOffsetX,
    tileOffsetY,
    tileFractionX,
    tileFractionY,
    zScale,
    tileCenter,
    mapProjection
) {
    return new Promise((resolve, reject) => {
        try {
            const worker = initElevationWorker();

            // Pre-calculate lat/lon values in main thread (fast operation)
            // This avoids serialization issues with the projection object
            const nPosition = Math.sqrt(geometry.attributes.position.count);
            const latLonData = new Float32Array(geometry.attributes.position.count * 2);

            for (let i = 0; i < geometry.attributes.position.count; i++) {
                const xIndex = i % nPosition;
                const yIndex = Math.floor(i / nPosition);

                let yTileFraction = yIndex / (nPosition - 1);
                let xTileFraction = xIndex / (nPosition - 1);

                if (xTileFraction >= 1) xTileFraction = 1 - 1e-6;
                if (yTileFraction >= 1) yTileFraction = 1 - 1e-6;

                const xWorld = tileX + xTileFraction;
                const yWorld = tileY + yTileFraction;

                // Calculate lat/lon in main thread - this is fast compared to elevation interpolation
                const lat = mapProjection.getNorthLatitude(yWorld, tileZ);
                const lon = mapProjection.getLeftLongitude(xWorld, tileZ);

                latLonData[i * 2] = lat;
                latLonData[i * 2 + 1] = lon;
            }

            // Create a handler for the worker response
            const messageHandler = (event) => {
                // Remove this handler after receiving response
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);

                const { vertexPositions, highestAltitude, error, stack } = event.data;

                if (error) {
                    reject(new Error(`Elevation interpolation worker error: ${error}\n${stack}`));
                } else {
                    // Apply the computed vertex positions to the geometry
                    geometry.attributes.position.array.set(vertexPositions);
                    geometry.attributes.position.needsUpdate = true;

                    resolve({
                        vertexPositions,
                        highestAltitude,
                    });
                }
            };

            const errorHandler = (error) => {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                reject(error);
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);

            // IMPORTANT: Create a COPY of elevation data because transferring the buffer
            // would detach it from the main thread. The worker gets a copy it can process
            // while the main thread retains access to the original.
            const elevationDataCopy = new Float32Array(elevationTile.elevation);

            // Compute geoid correction corners for this tile
            const geoidCorners = geoidCorrectionForTile(mapProjection, tileZ, tileX, tileY);

            // Send message to worker with pre-calculated lat/lon
            worker.postMessage(
                {
                    positionCount: geometry.attributes.position.count,
                    nPosition, // Grid dimension (nPosition x nPosition grid)
                    latLonData, // Pre-calculated in main thread
                    elevationData: elevationDataCopy,
                    elevationSize,
                    elevationZoom,
                    tileX,
                    tileY,
                    tileZ,
                    tileOffsetX,
                    tileOffsetY,
                    tileFractionX,
                    tileFractionY,
                    zScale,
                    tileCenterX: tileCenter.x,
                    tileCenterY: tileCenter.y,
                    tileCenterZ: tileCenter.z,
                    geoidCorners,
                },
                [elevationDataCopy.buffer, latLonData.buffer] // Transfer both buffers
            );
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Terminate the worker when no longer needed (e.g., on page unload)
 */
export function terminateElevationWorker() {
    if (elevationWorker) {
        elevationWorker.terminate();
        elevationWorker = null;
    }
}