/**
 * ADSBLiveFetch — the live local-traffic feed.
 *
 * Fetches every aircraft adsb.lol currently sees within a radius of a point,
 * and normalises the ADSBExchange-v2 records into the small, explicit shape the
 * display layer wants.
 *
 * ALWAYS through sitrecServer/proxyADSBLive.php. api.adsb.lol sends no
 * Access-Control-Allow-Origin header (verified 2026-08-29), so unlike the trace
 * importer there is no direct browser route and no serverless fallback — the
 * layer reports itself unavailable rather than failing on every poll. The
 * static host adsb.lol/data/traces/ that CTrackFileADSBTrace uses IS
 * CORS-permissive; the two hosts differ, and one must not be assumed from the
 * other.
 *
 * Data license: adsb.lol data is ODbL — credit "adsb.lol" when publishing
 * imagery made with it. The data is fetched live, never bundled.
 */

import {SITREC_SERVER, isServerless} from "./configUtils";
import {f2m} from "./utils";

// The API's own ceiling, and its floor.
export const ADSB_LIVE_MIN_RADIUS_NM = 1;
export const ADSB_LIVE_MAX_RADIUS_NM = 250;

export function adsbLiveURL(lat, lon, radiusNM) {
    return SITREC_SERVER + "proxyADSBLive.php"
        + "?lat=" + encodeURIComponent(lat.toFixed(6))
        + "&lon=" + encodeURIComponent(lon.toFixed(6))
        + "&radius=" + encodeURIComponent(Math.round(radiusNM));
}

/** Is the live feed reachable from this build at all? */
export function isADSBLiveAvailable() {
    // Serverless and desktop builds have no PHP, and the upstream cannot be
    // called directly from a browser, so the honest answer is no. The caller
    // disables the control rather than offering one that can only fail.
    return !isServerless;
}

// A callsign arrives space-padded to eight characters ("N360KS  ").
function cleanCallsign(flight) {
    const s = String(flight ?? "").trim();
    return s.length ? s : null;
}

/**
 * Turn one raw v2 aircraft record into the display shape, or null when it
 * carries no usable position.
 *
 * ALTITUDE DATUM. `alt_geom` is height above the WGS84 ellipsoid (HAE);
 * `alt_baro` is a pressure altitude conventionally treated as MSL. They differ
 * by the geoid separation — tens of metres in most of the world — so the two
 * must never be mixed silently into one number. Geometric is preferred where
 * the aircraft reports it, and `altitudeIsHAE` tells the caller which datum it
 * got, exactly as CTrackFileADSBTrace does for the trace files.
 *
 * `alt_baro` is also the string "ground" for an aircraft on the surface, which
 * is why this is a typeof check and not a truthiness one — "ground" is truthy
 * and Number("ground") is NaN.
 */
export function normalizeAircraft(raw) {
    if (!raw || typeof raw !== "object") return null;
    // An aircraft heard but not yet positioned (a bare Mode-S track) has no
    // lat/lon. It cannot be drawn, so it is dropped rather than placed at null
    // island.
    //
    // The null/undefined test has to come BEFORE Number(): Number(null) is 0,
    // and 0 is a perfectly finite latitude, so a finiteness check alone accepts
    // an explicitly null position and silently puts the aircraft in the Gulf of
    // Guinea. Number(undefined) is NaN, so a missing field was already caught —
    // which is exactly why this was easy to miss.
    if (raw.lat === null || raw.lat === undefined) return null;
    if (raw.lon === null || raw.lon === undefined) return null;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const geomFt = Number(raw.alt_geom);
    const hasGeom = Number.isFinite(geomFt);
    const baroRaw = raw.alt_baro;
    const onGround = baroRaw === "ground";
    const baroFt = Number(baroRaw);
    const hasBaro = Number.isFinite(baroFt);

    let altitudeM = null;
    let altitudeIsHAE = false;
    if (hasGeom) {
        altitudeM = f2m(geomFt);
        altitudeIsHAE = true;
    } else if (hasBaro) {
        altitudeM = f2m(baroFt);
    } else if (onGround) {
        // Known to be on the surface but with no figure. Left null so the
        // display layer can put it on the terrain rather than at sea level,
        // which is a different and usually wrong place.
        altitudeM = null;
    }

    const groundSpeedKt = Number(raw.gs);
    // `track` is the true course over ground. `calc_track` is the aggregator's
    // estimate from successive positions, present on records where the aircraft
    // does not transmit a heading — worth using, but only as a fallback.
    const trackDeg = Number.isFinite(Number(raw.track))
        ? Number(raw.track)
        : (Number.isFinite(Number(raw.calc_track)) ? Number(raw.calc_track) : null);

    return {
        hex: String(raw.hex ?? "").toLowerCase(),
        callsign: cleanCallsign(raw.flight),
        registration: raw.r ? String(raw.r).trim() : null,
        typeCode: raw.t ? String(raw.t).trim() : null,
        category: raw.category ?? null,
        lat,
        lon,
        altitudeM,
        altitudeIsHAE,
        onGround,
        groundSpeedKt: Number.isFinite(groundSpeedKt) ? groundSpeedKt : null,
        trackDeg,
        verticalRateFpm: Number.isFinite(Number(raw.baro_rate)) ? Number(raw.baro_rate)
            : (Number.isFinite(Number(raw.geom_rate)) ? Number(raw.geom_rate) : null),
        // How old this position is, in seconds. The feed includes aircraft last
        // heard some time ago, and a stale position drawn as current is a lie —
        // the display layer fades or drops them on this.
        positionAgeSec: Number.isFinite(Number(raw.seen_pos)) ? Number(raw.seen_pos) : null,
        distanceNM: Number.isFinite(Number(raw.dst)) ? Number(raw.dst) : null,
    };
}

/**
 * Normalise a whole proxy response.
 *
 * `now` is the feed's own timestamp in epoch SECONDS. It is carried through
 * rather than replaced with the browser's clock: position ages are relative to
 * the server's view, and a client whose clock is off by a minute would
 * otherwise age every aircraft out of existence.
 */
export function normalizeResponse(json) {
    const list = Array.isArray(json?.ac) ? json.ac : [];
    const aircraft = [];
    for (const raw of list) {
        const a = normalizeAircraft(raw);
        if (a) aircraft.push(a);
    }
    return {
        aircraft,
        nowSec: Number.isFinite(Number(json?.now)) ? Number(json.now) : null,
        // What the feed says it holds, before positionless records were dropped.
        reportedTotal: Number.isFinite(Number(json?.total)) ? Number(json.total) : aircraft.length,
    };
}

/**
 * Fetch the current traffic around a point.
 *
 * Resolves {aircraft, nowSec, reportedTotal, stale}. `stale` is true when the
 * proxy served an older cached copy because adsb.lol was unreachable — the
 * caller shows the layer as degraded rather than presenting old positions as
 * live. Rejects on a hard failure.
 */
export async function fetchLiveTraffic({lat, lon, radiusNM, signal} = {}) {
    if (!isADSBLiveAvailable()) {
        throw new Error("Live ADS-B traffic needs the Sitrec server; it is not available in this build.");
    }
    const clamped = Math.min(ADSB_LIVE_MAX_RADIUS_NM,
        Math.max(ADSB_LIVE_MIN_RADIUS_NM, Math.round(radiusNM)));

    const res = await fetch(adsbLiveURL(lat, lon, clamped), {signal});
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Live traffic unavailable (HTTP ${res.status}). ${detail.slice(0, 200)}`);
    }
    const json = await res.json();
    const normalized = normalizeResponse(json);
    normalized.stale = res.headers.get("X-ADSB-Cache") === "stale";
    return normalized;
}
