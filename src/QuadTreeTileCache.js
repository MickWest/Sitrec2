/**
 * Module-level caches shared between QuadTreeTile and QuadTreeTileMaterial.
 *
 * Kept in a dedicated module so the two files don't form an import cycle: both
 * import the same state here instead of reaching into each other.
 */

// Bad texture URLs — per-session to avoid retrying fetches that we know fail.
export const badTextureUrls = new Set();

// Reusable material instances keyed by texture URL/params.
export const materialCache = new Map();

// In-flight texture loads keyed by URL to coalesce concurrent requests.
export const textureLoadPromises = new Map();
