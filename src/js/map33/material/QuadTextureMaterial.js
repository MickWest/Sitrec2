import {CanvasTexture, Texture} from "three";
import {createTerrainDayNightMaterial} from "./TerrainDayNightMaterial";
import {TileUsageTracker} from "../../../TileUsageTracker";
import {ServiceAvailability} from "../../../ServiceAvailability";

function logNetwork(url, status) {
    // if (Globals.regression) {
    //     console.log(`[NET:${url}:${status}]`);
    // }
}


// Queue to hold pending requests
const requestQueue = [];
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 5;

// ESRI World Imagery's "Map Data Not Yet Available" placeholder tile is
// returned with HTTP 200 OK for any tile beyond the available zoom level
// for that area. The bytes are identical for every placeholder request
// (verified with SHA-256 against multiple out-of-coverage tiles, 2026).
//
// Detection by SIZE is unreliable — real ocean tiles can be smaller than
// the placeholder (e.g. tile 12/603/1900 is 1652 bytes vs the placeholder
// at 2521 bytes). And ETag isn't accessible from JS — ESRI doesn't include
// `Access-Control-Expose-Headers: ETag` in its CORS headers, so
// `response.headers.get('ETag')` returns null.
//
// So we identify by content fingerprint: SHA-256 of the blob bytes. To
// avoid hashing every tile fetched, we gate on size === placeholder size
// first; only candidates of the exact placeholder size get hashed and
// compared. This adds zero overhead to ~99.9% of fetches.
const ESRI_WORLD_IMAGERY_URL_PATTERN = /\/World_Imagery\/MapServer\/tile\//i;
const ESRI_PLACEHOLDER_SIZE = 2521;
const ESRI_PLACEHOLDER_SHA256 =
    '9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858';

async function isLikelyEsriPlaceholderTile(url, blob) {
    if (!ESRI_WORLD_IMAGERY_URL_PATTERN.test(url)) return false;
    if (blob.size !== ESRI_PLACEHOLDER_SIZE) return false;
    const buf = await blob.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return hashHex === ESRI_PLACEHOLDER_SHA256;
}

function processQueue() {
  // Process the next request if we have capacity
  if (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
    const nextRequest = requestQueue.shift();
    activeRequests++;
    nextRequest();
  }
}

// Function to load a texture with retries and delay on error
export function loadTextureWithRetries(url, maxRetries = 0, delay = 100, currentAttempt = 0, urlIndex = 0, abortSignal = null) {
  // we expect url to be an array of 1 or more urls which we try in sequence until one works
  // if we are passed in a single string, convert it to an array
  if (typeof url === 'string') {
    url = [url];
  }

  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (abortSignal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    // Pre-flight: reject immediately if the service is known to be unavailable
    if (!ServiceAvailability.isAvailableByUrl(url[0])) {
      reject(new Error('ServiceUnavailable'));
      return;
    }

    const attemptLoad = () => {
      // Check abort signal before each attempt
      if (abortSignal?.aborted) {
        activeRequests--;
        processQueue();
        reject(new Error('Aborted'));
        return;
      }

      const currentUrl = url[urlIndex];
      logNetwork(currentUrl, 'pending');

      fetch(currentUrl, {signal: abortSignal ?? undefined})
        .then(response => {
          if (abortSignal?.aborted) throw new Error('Aborted');

          if (!response.ok) {
            // We have the actual HTTP status code — only count server errors
            // (5xx) as service failures. 404/403 are expected for missing tiles.
            const status = response.status;
            logNetwork(currentUrl, status);
            if (status >= 500) {
              ServiceAvailability.recordFailureByUrl(currentUrl);
            }
            throw new Error(`HTTP ${status}`);
          }
          return response.blob();
        })
        .then(async blob => {
          // ESRI World Imagery returns a placeholder JPEG with HTTP 200 OK for
          // out-of-coverage tiles. Treat it as a load failure so the existing
          // dead-branch path leaves the parent's higher-resolution texture
          // visible instead of showing the "Map Data Not Yet Available" image.
          if (await isLikelyEsriPlaceholderTile(currentUrl, blob)) {
            logNetwork(currentUrl, 'placeholder');
            throw new Error('PlaceholderTile');
          }
          return blob;
        })
        .then(blob => {
          // Create an Image element (same as Three.js TextureLoader) rather than
          // ImageBitmap, because Texture.flipY has no effect on ImageBitmap.
          return new Promise((resolveImg, rejectImg) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(objectUrl); resolveImg(img); };
            img.onerror = () => { URL.revokeObjectURL(objectUrl); rejectImg(new Error('Image decode failed')); };
            img.src = objectUrl;
          });
        })
        .then(img => {
          if (abortSignal?.aborted) {
            throw new Error('Aborted');
          }

          const texture = new Texture(img);
          texture.needsUpdate = true;

          TileUsageTracker.trackTile(currentUrl);
          ServiceAvailability.recordSuccessByUrl(currentUrl);
          logNetwork(currentUrl, 200);
          resolve(texture);
          activeRequests--;
          processQueue();
        })
        .catch(err => {
          activeRequests--;

          if (err.message === 'Aborted' || abortSignal?.aborted) {
            processQueue();
            reject(new Error('Aborted'));
            return;
          }

          // Network errors (fetch failed entirely) count as service failures
          if (err.name === 'TypeError') {
            ServiceAvailability.recordFailureByUrl(currentUrl);
          }

          // Try next URL in the list
          if (urlIndex < url.length - 1) {
            urlIndex++;
            activeRequests++;
            attemptLoad();
          } else if (currentAttempt < maxRetries) {
            console.log(`Retry ${currentAttempt + 1}/${maxRetries} for ${currentUrl} after delay`);
            setTimeout(() => {
              if (abortSignal?.aborted) {
                reject(new Error('Aborted'));
                return;
              }
              loadTextureWithRetries(url, maxRetries, delay, currentAttempt + 1, urlIndex, abortSignal)
                  .then(resolve)
                  .catch(reject);
            }, delay);
          } else {
            console.log(`Failed to load ${currentUrl} after ${maxRetries} attempts`);
            logNetwork(currentUrl, 'failed');
            reject(err);
            processQueue();
          }
        });
    };

    // Set up abort listener
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        reject(new Error('Aborted'));
      });
    }

    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
      activeRequests++;
      attemptLoad();
    } else {
      // Add to queue
      requestQueue.push(attemptLoad);
    }
  });
}


const QuadTextureMaterial = (urls) => {
  return Promise.all(urls.map(url => loadTextureWithRetries(url))).then(maps => {
    // Combine the 4 texture tiles into a single double resolution texture
    // Maps are arranged as: [SW, NW, SE, NE]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = maps[0].image.width * 2
    canvas.height = maps[0].image.height * 2
    ctx.drawImage(maps[0].image, 0, 0)  // SW - bottom left
    ctx.drawImage(maps[1].image, 0, maps[0].image.height)  // NW - top left
    ctx.drawImage(maps[2].image, maps[0].image.width, 0)  // SE - bottom right
    ctx.drawImage(maps[3].image, maps[0].image.width, maps[0].image.height)  // NE - top right
    
    const texture = new CanvasTexture(canvas)
    // NOTE: NOT setting SRGBColorSpace here — terrain shader does lighting
    // in sRGB space (Phase 4 will convert it to linear workflow)
    texture.needsUpdate = true
    
    // Clean up temporary resources
    canvas.remove()
    maps.forEach(map => map.dispose())

    // Use custom terrain shader with day/night lighting and terrain shading
    return createTerrainDayNightMaterial(texture, 0.3);
  })
}

export default QuadTextureMaterial
