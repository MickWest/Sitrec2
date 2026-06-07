/**
 * Module: Sitrec object reference resolver.
 *
 * Responsibilities:
 * - Accept legacy and canonical object reference formats.
 * - Normalize references into canonical `sitrec://<key>` form.
 * - Resolve references through `sitrecServer/object.php` into temporary fetch URLs.
 * - Cache resolver responses with expiry awareness to reduce repeat network calls.
 */
import {SITREC_SERVER} from "./configUtils";
import {withTestUser, Globals} from "./Globals";

const SITREC_REF_PREFIX = "sitrec://";
const objectUrlCache = new Map();

// object.php is a small JSON round-trip, but a bare fetch with no timeout will
// hang the entire asset load forever if the request stalls (half-open socket).
// Bound it. This is the resolve step that runs INSIDE loadAsset's fetch chain,
// so a hang here leaves both the "Asset" and "Video" loading tasks at 0%.
const RESOLVE_TIMEOUT_MS = 30000;

/**
 * Fetch object.php with a bounded timeout, combined with an optional caller
 * AbortSignal (so situation teardown / a video watchdog can cancel it too).
 */
async function fetchObjectResolver(url, callerSignal) {
    const init = {mode: "cors", cache: "no-store"};
    if (Globals.regression) {
        // Deterministic CI: no wall-clock timer (would add flakes); honor only the caller signal.
        return fetch(url, callerSignal ? {...init, signal: callerSignal} : init);
    }
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(
        new DOMException(`object.php resolve timed out after ${RESOLVE_TIMEOUT_MS}ms`, "TimeoutError")),
        RESOLVE_TIMEOUT_MS);
    let signal = timeoutController.signal;
    if (callerSignal) {
        signal = (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function")
            ? AbortSignal.any([callerSignal, timeoutController.signal])
            : timeoutController.signal;
    }
    try {
        return await fetch(url, {...init, signal});
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Converts resolver expiry metadata into epoch milliseconds.
 *
 * Supported input formats:
 * - Unix seconds (number)
 * - Unix milliseconds (number)
 * - Date string parseable by `Date.parse`
 *
 * @param {number|string|null|undefined} expiresAt
 * @returns {number} Epoch milliseconds, or 0 when no valid expiry is available.
 */
function getExpiryMs(expiresAt) {
    if (expiresAt === undefined || expiresAt === null) return 0;
    if (typeof expiresAt === "number") {
        return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
    }
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts a Sitrec object key from legacy S3 URLs.
 *
 * Handles both:
 * - Virtual-hosted style: `https://bucket.s3.region.amazonaws.com/<key>`
 * - Path style: `https://s3.region.amazonaws.com/bucket/<key>`
 *
 * Keys must begin with `<numericUserId>/...` to be considered valid Sitrec keys.
 *
 * @param {string} value
 * @returns {string|null} Decoded object key (without leading slash), or `null` if not recognized.
 */
function extractKeyFromLegacyS3Url(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        const path = decodeURIComponent(url.pathname || "");
        const isS3Host = host.includes(".s3.") || host === "s3.amazonaws.com" || host.startsWith("s3.");
        if (!isS3Host) return null;

        // Virtual-hosted-style: https://bucket.s3.region.amazonaws.com/key
        if (/^\/\d+\//.test(path)) {
            return path.slice(1);
        }

        // Path-style: https://s3.region.amazonaws.com/bucket/key
        const pathStyleMatch = path.match(/^\/[^/]+\/(\d+\/.+)$/);
        if (pathStyleMatch) {
            return pathStyleMatch[1];
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Tests whether a value is already in canonical Sitrec object-ref format.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSitrecObjectRef(value) {
    return typeof value === "string" && value.startsWith(SITREC_REF_PREFIX);
}

/**
 * Tests whether a value looks like a raw Sitrec object key (`<userId>/...`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRawSitrecObjectPath(value) {
    return typeof value === "string" && /^\d+\/.+/.test(value);
}

/**
 * Tests whether a value is a legacy S3 URL containing a Sitrec-compatible key.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLegacySitrecS3Url(value) {
    return extractKeyFromLegacyS3Url(value) !== null;
}

/**
 * Tests whether a value can be resolved via `object.php`.
 *
 * Accepted forms:
 * - canonical `sitrec://...`
 * - raw key `<userId>/...`
 * - legacy S3 URL
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isResolvableSitrecReference(value) {
    return isSitrecObjectRef(value) || isRawSitrecObjectPath(value) || isLegacySitrecS3Url(value);
}

/**
 * Normalizes any supported Sitrec reference form into a decoded object key.
 *
 * @param {unknown} value
 * @returns {string|null} Decoded key (`<userId>/...`) or `null` when not resolvable.
 */
export function extractSitrecObjectKey(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    if (isSitrecObjectRef(value)) {
        return decodeURIComponent(value.slice(SITREC_REF_PREFIX.length));
    }
    if (isRawSitrecObjectPath(value)) {
        return decodeURIComponent(value);
    }
    return extractKeyFromLegacyS3Url(value);
}

/**
 * Converts supported reference formats into canonical `sitrec://<key>` form.
 *
 * If the input is not a resolvable reference, the original value is returned unchanged.
 *
 * @param {string} value
 * @returns {string}
 */
export function toCanonicalSitrecRef(value) {
    const key = extractSitrecObjectKey(value);
    if (!key) return value;
    return SITREC_REF_PREFIX + key;
}

/**
 * Converts an internal reference into the compact URL-share value.
 *
 * For resolvable references, this returns the raw key (`<userId>/...`) so shared links do
 * not hardcode storage hosts. For non-resolvable inputs, returns the original value.
 *
 * @param {string} value
 * @returns {string}
 */
export function toShareableCustomValue(value) {
    const key = extractSitrecObjectKey(value);
    return key ?? value;
}

/**
 * Encodes a share value for use in a URL query parameter, preserving
 * slashes and spaces for readability in the browser address bar.
 *
 * Only characters that break URL query parsing (&, =, #, ?) are encoded.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeShareParam(value) {
    // Decode first to prevent double-encoding (e.g. a value containing %20
    // would otherwise become %2520 after encodeURIComponent).
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { decoded = value; }
    return encodeURIComponent(decoded)
        .replace(/%2F/gi, '/');
}

/**
 * Extracts the leading numeric user id from any supported reference form.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function extractUserIdFromSitrecReference(value) {
    const key = extractSitrecObjectKey(value);
    if (!key) return null;
    const match = key.match(/^(\d+)\//);
    return match ? match[1] : null;
}

/**
 * Stores resolved object metadata in cache by both lookup key and canonical ref (if different).
 *
 * @param {string} cacheKey
 * @param {{ref?: string, expiresAt?: number|string|null}} data
 * @returns {void}
 */
function setCacheEntry(cacheKey, data) {
    const expiresMs = getExpiryMs(data.expiresAt);
    objectUrlCache.set(cacheKey, {data, expiresMs});
    if (data.ref && data.ref !== cacheKey) {
        objectUrlCache.set(data.ref, {data, expiresMs});
    }
}

/**
 * Resolves a Sitrec reference into resolver metadata and a fetchable URL.
 *
 * Cache behavior:
 * - Cached entries are reused until they are within 30 seconds of expiry.
 * - Set `force=true` to bypass cache.
 *
 * @param {string} value
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{
 *   ref: string,
 *   key: string,
 *   shareValue?: string,
 *   url: string,
 *   expiresAt?: number|string|null,
 *   version?: string
 * }|null>}
 */
export async function resolveSitrecReference(value, {force = false, signal} = {}) {
    if (!isResolvableSitrecReference(value)) {
        return null;
    }

    // Normalize to decoded canonical ref to avoid double-encoding keys like "%20".
    const canonicalRef = toCanonicalSitrecRef(value);
    const cacheKey = canonicalRef;
    const now = Date.now();
    const cached = objectUrlCache.get(cacheKey);
    if (!force && cached && cached.data?.url && (!cached.expiresMs || cached.expiresMs - now > 30_000)) {
        return cached.data;
    }

    const url = withTestUser(SITREC_SERVER + "object.php?ref=" + encodeURIComponent(canonicalRef));
    const response = await fetchObjectResolver(url, signal);
    if (!response.ok) {
        throw new Error(`Object resolver failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data?.url || !data?.ref) {
        throw new Error("Object resolver returned an incomplete response");
    }

    setCacheEntry(cacheKey, data);
    return data;
}

/**
 * Resolves any Sitrec reference to a concrete fetch URL.
 *
 * Non-resolvable inputs are returned unchanged to preserve legacy call sites.
 *
 * @param {string} value
 * @param {{force?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function resolveURLForFetch(value, options) {
    const resolved = await resolveSitrecReference(value, options);
    return resolved?.url ?? value;
}
