/**
 * LiveFeedFetch — the browser side of sitrecServer/proxyLiveFeed.php.
 *
 * Thin on purpose: the proxy owns the upstream URLs, the caching, the rate limit
 * and the timeouts, so this only has to name a feed and report what came back.
 */

import {SITREC_SERVER, isServerless} from "./../configUtils";

export function liveFeedURL(feedId, params = {}) {
    const query = new URLSearchParams({feed: feedId});
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) query.set(k, String(v));
    }
    return SITREC_SERVER + "proxyLiveFeed.php?" + query.toString();
}

/**
 * Are the live feeds reachable from this build at all?
 *
 * Serverless and desktop builds have no PHP, and none of these upstreams can be
 * read directly from a browser — some send no CORS headers, others require
 * request headers a page is not allowed to set. So the honest answer is no, and
 * the caller disables the controls rather than offering ones that can only fail.
 */
export function areLiveFeedsAvailable() {
    return !isServerless;
}

/**
 * Fetch one feed.
 *
 * Resolves {json, stale}. `stale` is true when the proxy served an older cached
 * body because the upstream was unreachable — the caller must SAY so rather than
 * present old data as current.
 */
export async function fetchLiveFeed(feedId, {params, signal} = {}) {
    if (!areLiveFeedsAvailable()) {
        throw new Error("Live feeds need the Sitrec server; they are not available in this build.");
    }
    const res = await fetch(liveFeedURL(feedId, params), {signal});
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}. ${detail.slice(0, 160)}`);
    }
    return {
        json: await res.json(),
        stale: res.headers.get("X-Feed-Cache") === "stale",
    };
}

/**
 * Fetch a KEYED feed straight from this browser to the provider.
 *
 * Deliberately does NOT go through sitrecServer/proxyLiveFeed.php.
 * docs/APIKeys.md promises that a user's keys are never sent to the Sitrec
 * server, and proxying a keyed feed would quietly break that promise — so every
 * keyed provider here was checked to serve CORS to a browser first
 * (Windy allows x-windy-api-key by preflight; TomTom echoes the Origin).
 *
 * The trade is that these work in serverless and desktop builds too, since no
 * PHP is involved.
 */
export async function fetchKeyedFeed(feed, key, center, {signal} = {}) {
    const {url, headers} = feed.buildRequest(key, center);
    const res = await fetch(url, {headers, signal});
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // 401/403 almost always means the key, so say so rather than making the
        // user decode an HTTP status.
        if (res.status === 401 || res.status === 403) {
            throw new Error(`${feed.attribution} rejected the key (HTTP ${res.status}).`);
        }
        throw new Error(`HTTP ${res.status}. ${detail.slice(0, 160)}`);
    }
    return {json: await res.json(), stale: false};
}
