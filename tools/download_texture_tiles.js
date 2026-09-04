#!/usr/bin/env node

/**
 * Script to download satellite tiles
 * Tiles are saved to sitrec-terrain/imagery/${SET_NAME}/z/y/x.jpg
 * 
 * NOTE: ESRI uses z/y/x format (not z/x/y like some other services)
 * and this means the folder structure seems backwards from most other services.
 *
 * JPEG tiles are relatively compact, averaging 6.2KB per tile.
 * (2K for ocean to 20K for noisy land areas)
 *
 * Estimated storage usage for jpg tiles:
 * Level 0 zoom has 1 tile, about 6.2K
 * Level 1 zoom has 4 tiles, about 25K
 * Level 2 zoom has 16 tiles, about 99K
 * Level 3 zoom has 64 tiles, about 397K
 * Level 4 zoom has 256 tiles, about 1.5MB
 * Level 5 zoom has 1024 tiles, about 6.2MB
 * Level 6 zoom has 4096 tiles, about 25MB
 * Level 7 zoom has 16384 tiles, about 99MB
 * Level 8 zoom has 65536 tiles, about 397MB
 *
 * This script can take a while to complete depending on your internet speed
 * and machine resources.
 *
 * Usage:
 *   node tools/download_texture_tiles.js

 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { getTotalTiles, ensureDir, tileExists, calculateDirSize } = require('./tile-download-utils');

const BASE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const SET_NAME = "esri";


const OUTPUT_DIR = path.join(__dirname, '..', '..', 'sitrec-terrain', 'imagery', SET_NAME);
const MAX_ZOOM = 4; // Start conservative - adjust as needed, but at least 3 for the basic globe
const BATCH_SIZE = 50; // Adjust based on available memory and network speed

// To avoid hammering the servers, we wait this long before downloading another batch
// with a large number (e.g. 1000mx, 1 second) this will determine the run length
// of the script  = 4^zoom * delay / 1000 / BATCH_SIZE
// For example at zoom 8, it would take approx 4^8 * 1000ms / 1000 / 50 = 256 seconds or about 4 minutes
const delayBetweenBatches = 1000;


const TOTAL_TILES = getTotalTiles(MAX_ZOOM);
let downloadedCount = 0;
let errorCount = 0;
let skippedCount = 0;

// Download a single tile
function downloadTile(z, x, y) {
    return new Promise((resolve, reject) => {
        // ESRI uses z/y/x format in the URL
        const url = `${BASE_URL}/${z}/${y}/${x}`;
        const outputPath = path.join(OUTPUT_DIR, String(z), String(y), `${x}.jpg`);
        
        // Check if file already exists - use optimized single filesystem check
        if (tileExists(outputPath)) {
            skippedCount++;
            if (skippedCount % 100 === 0 || downloadedCount + skippedCount <= 10) {
                console.log(`[${downloadedCount + skippedCount}/${TOTAL_TILES}] Skipping (exists): ${z}/${y}/${x}.jpg`);
            }
            resolve({ skipped: true });
            return;
        }
        
        // Ensure directory exists
        ensureDir(path.dirname(outputPath));
        
        const file = fs.createWriteStream(outputPath);
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                console.error(`[ERROR] Failed to download ${z}/${y}/${x}.jpg - Status: ${response.statusCode}`);
                errorCount++;
                file.close();
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath); // Remove empty file
                }
                resolve({ skipped: false }); // Continue with other downloads
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                downloadedCount++;
                console.log(`[${downloadedCount + skippedCount}/${TOTAL_TILES}] Downloaded: ${z}/${y}/${x}.jpg`);
                resolve({ skipped: false });
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath); // Remove partial file
            }
            console.error(`[ERROR] Failed to download ${z}/${y}/${x}.jpg:`, err.message);
            errorCount++;
            resolve({ skipped: false }); // Continue with other downloads
        });
    });
}

// Download all tiles for a given zoom level
async function downloadZoomLevel(z) {
    const tilesPerSide = Math.pow(2, z);
    const totalTilesThisZoom = tilesPerSide * tilesPerSide;
    console.log(`\n=== Downloading zoom level ${z} (${tilesPerSide}x${tilesPerSide} = ${totalTilesThisZoom} tiles) ===\n`);
    
    const promises = [];
    for (let x = 0; x < tilesPerSide; x++) {
        for (let y = 0; y < tilesPerSide; y++) {
            promises.push(downloadTile(z, x, y));
            
            // Process in batches of 50 for better performance
            if (promises.length >= BATCH_SIZE) {
                const results = await Promise.all(promises);
                promises.length = 0;
                
                // Only delay if we actually downloaded files (not just skipped)
                const downloadedInBatch = results.filter(r => r && !r.skipped).length;
                if (downloadedInBatch > 0) {
                    // Small delay between download batches to be respectful to ESRI servers
                    await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
                }
            }
        }
    }
    
    // Process remaining tiles
    if (promises.length > 0) {
        const results = await Promise.all(promises);
        const downloadedInBatch = results.filter(r => r && !r.skipped).length;
        if (downloadedInBatch > 0) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }
}

// Main function
async function main() {
    console.log('Tile Downloader');
    console.log('========================================');
    console.log(`Output directory: ${OUTPUT_DIR}`);
    console.log(`Max zoom level: ${MAX_ZOOM}`);
    console.log(`Total tiles to download: ${TOTAL_TILES}`);
    
    // Estimate storage
    const avgTileSize = 7;
    const estimatedSize = (TOTAL_TILES * avgTileSize / 1024).toFixed(1);
    console.log(`Estimated storage: ~${estimatedSize} MB`);
    console.log('========================================\n');
    
    const startTime = Date.now();
    
    // Ensure base output directory exists
    ensureDir(OUTPUT_DIR);
    
    // Download tiles for each zoom level
    for (let z = 0; z <= MAX_ZOOM; z++) {
        await downloadZoomLevel(z);
    }
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log('\n========================================');
    console.log('Download Complete!');
    console.log(`Total tiles: ${TOTAL_TILES}`);
    console.log(`Successfully downloaded: ${downloadedCount}`);
    console.log(`Skipped (already exist): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Time taken: ${duration} seconds`);
    
    // Calculate actual storage used
    const totalSizeMB = (calculateDirSize(OUTPUT_DIR) / (1024 * 1024)).toFixed(2);
    console.log(`Actual storage used: ${totalSizeMB} MB`);
    console.log('========================================');
}

// Run the script
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
