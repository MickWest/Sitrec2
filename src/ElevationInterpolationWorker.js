/**
 * Web Worker for async elevation interpolation and vertex position calculation
 * 
 * This worker processes elevation data from tiles with bilinear interpolation
 * and converts vertices from lat/lon/elevation to EUS coordinates.
 * 
 * This is computationally expensive (10K+ vertices per tile) and moving it to a worker
 * prevents blocking the main thread during terrain tile recalculation.
 */

/**
 * Convert LLA (Latitude, Longitude, Altitude) to EUS (Earth-Centered Universe System)
 * This is imported from LLA-ECEF-ENU in the main thread, but we need a copy here
 */
class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    sub(v) {
        this.x -= v.x;
        this.y -= v.y;
        this.z -= v.z;
        return this;
    }
}

// Replicate wgs84 constants
const wgs84 = {
    RADIUS: 6378137,
    ECCENTRICITY_SQUARED: 0.00669437999014132,
};

/**
 * Convert LLA to EUS (Earth-Centered Universe System)
 * Based on WGS84 ellipsoid
 */
function LLAToEUS(lat, lon, alt) {
    const radLat = (lat * Math.PI) / 180;
    const radLon = (lon * Math.PI) / 180;

    const cosLat = Math.cos(radLat);
    const sinLat = Math.sin(radLat);
    const cosLon = Math.cos(radLon);
    const sinLon = Math.sin(radLon);

    const N = wgs84.RADIUS / Math.sqrt(1 - wgs84.ECCENTRICITY_SQUARED * sinLat * sinLat);

    const x = (N + alt) * cosLat * cosLon;
    const y = (N + alt) * cosLat * sinLon;
    const z = (N * (1 - wgs84.ECCENTRICITY_SQUARED) + alt) * sinLat;

    return new Vector3(x, y, z);
}

/**
 * Bilinear interpolation of geoid offset within a tile.
 * xFrac and yFrac are in [0,1], where (0,0) is the NW corner.
 */
function interpolateGeoidOffset(corners, xFrac, yFrac) {
    const top = corners.nw + (corners.ne - corners.nw) * xFrac;
    const bot = corners.sw + (corners.se - corners.sw) * xFrac;
    return top + (bot - top) * yFrac;
}

/**
 * Main worker message handler
 */
self.onmessage = function(event) {
    try {
        const {
            // Geometry data
            positionCount,
            // nPosition passed but not strictly needed (we calculate from positionCount)

            // Pre-calculated lat/lon from main thread
            latLonData,

            // Elevation data
            elevationData,
            elevationSize,
            elevationZoom,

            // Tile information
            tileX,
            tileY,
            tileZ,
            tileOffsetX,
            tileOffsetY,
            tileFractionX,
            tileFractionY,

            // Configuration
            zScale,
            tileCenterX,
            tileCenterY,
            tileCenterZ,

            // Geoid correction corners (WGS84 height of MSL at tile corners)
            geoidCorners,
        } = event.data;

        // Initialize output arrays
        const vertexPositions = new Float32Array(positionCount * 3);
        let highestAltitude = 0;

        // Precompute nPosition from positionCount
        const nPositionSq = Math.sqrt(positionCount);

        // Process each vertex
        for (let i = 0; i < positionCount; i++) {
            // Calculate vertex grid position
            const xIndex = i % nPositionSq;
            const yIndex = Math.floor(i / nPositionSq);

            // Calculate the fraction of the tile that the vertex is in
            let yTileFraction = yIndex / (nPositionSq - 1);
            let xTileFraction = xIndex / (nPositionSq - 1);

            // Get pre-calculated lat/lon from main thread
            const lat = latLonData[i * 2];
            const lon = latLonData[i * 2 + 1];

            // Map vertex position to elevation data coordinates
            let elevationLocalX, elevationLocalY;

            if (elevationZoom === tileZ) {
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

            // Get the four surrounding elevation data points for bilinear interpolation
            const x0 = Math.floor(elevationLocalX);
            const x1 = Math.min(elevationSize - 1, x0 + 1);
            const y0 = Math.floor(elevationLocalY);
            const y1 = Math.min(elevationSize - 1, y0 + 1);

            // Get the fractional parts for interpolation
            const fx = elevationLocalX - x0;
            const fy = elevationLocalY - y0;

            // Sample the four corner elevation values
            const e00 = elevationData[y0 * elevationSize + x0];
            const e01 = elevationData[y0 * elevationSize + x1];
            const e10 = elevationData[y1 * elevationSize + x0];
            const e11 = elevationData[y1 * elevationSize + x1];

            // Bilinear interpolation
            const e0 = e00 + (e01 - e00) * fx;
            const e1 = e10 + (e11 - e10) * fx;
            let elevation = e0 + (e1 - e0) * fy;

            // Apply z-scale if available
            if (zScale) {
                elevation *= zScale;
            }

            // Clamp to geoid sea level to avoid z-fighting with ocean tiles
            if (geoidCorners) {
                const seaLevel = interpolateGeoidOffset(geoidCorners, xTileFraction, yTileFraction);
                if (elevation < seaLevel) elevation = seaLevel;
            } else if (elevation < 0) {
                elevation = 0;
            }

            if (elevation > highestAltitude) {
                highestAltitude = elevation;
            }

            // Convert to EUS coordinates
            const vertexEUS = LLAToEUS(lat, lon, elevation);

            // Subtract the center of the tile for relative positioning
            const x = vertexEUS.x - tileCenterX;
            const y = vertexEUS.y - tileCenterY;
            const z = vertexEUS.z - tileCenterZ;

            // Store the vertex position
            vertexPositions[i * 3] = x;
            vertexPositions[i * 3 + 1] = y;
            vertexPositions[i * 3 + 2] = z;
        }

        // Send results back to main thread
        // Transfer the vertexPositions buffer for zero-copy performance
        self.postMessage(
            {
                vertexPositions,
                highestAltitude,
            },
            [vertexPositions.buffer] // Transfer buffer ownership back to main thread
        );
    } catch (error) {
        // Send error back to main thread
        self.postMessage({
            error: error.message,
            stack: error.stack,
        });
    }
};