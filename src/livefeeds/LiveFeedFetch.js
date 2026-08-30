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
