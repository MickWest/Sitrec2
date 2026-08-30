<?php
/**
 * proxyADSBLive.php — CORS proxy for adsb.lol's live area query: every
 * aircraft currently seen within a radius of a point.
 *
 * Upstream (constructed server-side, never taken from the client):
 *   https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}
 *
 * A proxy is REQUIRED here, unlike the trace importer which can go direct in
 * serverless builds. api.adsb.lol sends no Access-Control-Allow-Origin header
 * at all (verified 2026-08-29), so a browser cannot read the response. The
 * static trace host adsb.lol/data/traces/ is a different host with different
 * headers — do not assume one from the other.
 *
 * Parameters:
 *   lat    = -90..90
 *   lon    = -180..180
 *   radius = 1..250   (nautical miles, the API's own ceiling)
 *
 * Returns: the raw ADSBExchange-v2-shaped JSON ({ac: [...], now, total, ...}).
 *
 * Caching: 5 seconds, on a cache key built from lat/lon ROUNDED to 0.1 degrees
 * (about 11 km) and the radius. Rounding is what makes the cache do any work:
 * this endpoint is polled continuously, and without it two users a hundred
 * metres apart would never share an entry and every poll would hit upstream.
 * The rounding is applied to the cache key ONLY — the query sent upstream uses
 * the exact position, so the aircraft set is correct for the caller.
 *
 * Rate limit: 30 upstream fetches per minute per IP. Cache hits never consume
 * one, so a client polling every 5 s costs about 12 a minute.
 *
 * Data license: adsb.lol data is ODbL — the client credits "adsb.lol".
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/curlGetRequest.php';

// ── CORS headers ─────────────────────────────────────────────────────────
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit();
}

// ── Rate limiting (30 upstream fetches/min per IP) ───────────────────────
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_adsblive_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
// NOTE: the token is consumed just before the upstream fetch below, NOT here —
// cache hits never consume one.

/**
 * Atomically consume one rate-limit token. The whole read-increment-write runs
 * under flock(), so parallel requests from one IP serialize on the counter
 * instead of all observing the same count and bypassing the limit. Returns true
 * when a token was granted. Fails OPEN on filesystem trouble — a broken temp
 * dir must degrade the limiter, not the proxy.
 */
function consumeRateToken($rateLimitFile, $limit) {
    $fh = @fopen($rateLimitFile, 'c+');
    if ($fh === false) return true;
    if (!flock($fh, LOCK_EX)) { fclose($fh); return true; }
    $now = time();
    $raw = stream_get_contents($fh);
    $rateData = $raw ? json_decode($raw, true) : null;
    if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
        $rateData = ['count' => 0, 'reset' => $now + 60];
    }
    $allowed = $rateData['count'] < $limit;
    if ($allowed) {
        $rateData['count']++;
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($rateData));
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $allowed;
}

/**
 * Atomically publish a cache file: write to a temp sibling, then rename() into
 * place (atomic on the same filesystem). A concurrent cache-hit readfile()
 * therefore sees either the old complete file or the new complete file — never
 * a truncated body mid-write.
 */
function atomicWrite($path, $data) {
    $tmp = $path . "." . getmypid() . "." . uniqid("", true) . ".tmp";
    if (@file_put_contents($tmp, $data, LOCK_EX) === false) return false;
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

// ── Parameter validation ─────────────────────────────────────────────────
// is_numeric first: (float)"abc" is 0.0 in PHP, which is a VALID latitude, so a
// range check alone would silently accept garbage as the equator.
$latRaw = $_GET['lat'] ?? '';
$lonRaw = $_GET['lon'] ?? '';
$radRaw = $_GET['radius'] ?? '';

if (!is_numeric($latRaw) || !is_numeric($lonRaw) || !is_numeric($radRaw)) {
    http_response_code(400);
    exit("lat, lon and radius are required and must be numbers.");
}

$lat = (float)$latRaw;
$lon = (float)$lonRaw;
$radius = (int)round((float)$radRaw);

if ($lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) {
    http_response_code(400);
    exit("lat must be -90..90 and lon must be -180..180.");
}
if ($radius < 1 || $radius > 250) {
    http_response_code(400);
    exit("radius must be 1..250 nautical miles.");
}

// ── Build the upstream URL (server-side only — client never names a host) ─
$url = sprintf(
    "https://api.adsb.lol/v2/point/%.6f/%.6f/%d",
    $lat, $lon, $radius
);

// ── Check cache ──────────────────────────────────────────────────────────
// The key deliberately uses the ROUNDED position (see the file header): nearby
// pollers share one upstream fetch. 0.1 degrees is about 11 km, well inside a
// radius measured in tens of nautical miles.
$cacheKey = sprintf("adsblive_%.1f_%.1f_%d", $lat, $lon, $radius);
$cacheLifetime = 5; // seconds — this is a live feed
$cacheFile = $CACHE_PATH . md5($cacheKey) . ".json";

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheLifetime) {
    header("Content-Type: application/json; charset=utf-8");
    header("X-ADSB-Cache: hit");
    readfile($cacheFile);
    exit();
}

// ── Fetch from adsb.lol ──────────────────────────────────────────────────
if (!consumeRateToken($rateLimitFile, 30)) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait a minute.");
}

// api.adsb.lol answers 403 to a request with no User-Agent — PHP's cURL sends
// none by default — and 200 to the identical request with one. It is also the
// polite thing: the aggregator is volunteer-run and asks callers to identify
// themselves so it can see who its traffic is.
//
// The 10-second timeout is NOT optional for this endpoint. curlGetRequest waits
// forever by default, and this proxy is polled every few seconds: when
// api.adsb.lol stalled instead of answering (observed 2026-08-29) every request
// held a PHP-FPM worker until the pool was exhausted, at which point the whole
// PHP backend stopped answering — every other server feature with it. A polled
// upstream must always be given a deadline.
$result = curlGetRequest($url, [
    'User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)',
], 10);
$data = $result['data'];
$httpStatus = $result['http_status'];

/**
 * Serve-stale helper: on a transient upstream failure an older cached copy
 * beats a dead layer. For a live traffic display a few seconds of staleness is
 * invisible; an empty sky is not. The client is told via the header so it can
 * mark the layer degraded rather than silently showing old aircraft as current.
 */
function serveStaleOrFail($cacheFile, $failCode, $failMessage) {
    if (file_exists($cacheFile)) {
        header("Content-Type: application/json; charset=utf-8");
        header("X-ADSB-Cache: stale");
        header("X-ADSB-Stale-Seconds: " . (time() - filemtime($cacheFile)));
        readfile($cacheFile);
        exit();
    }
    http_response_code($failCode);
    header("Content-Type: text/plain");
    exit($failMessage);
}

if ($data === false || strlen($data) === 0) {
    serveStaleOrFail($cacheFile, 502, "Failed to fetch live traffic from adsb.lol.");
}

if ($httpStatus >= 400) {
    serveStaleOrFail($cacheFile, 502, "adsb.lol returned HTTP " . intval($httpStatus));
}

// ── Decompress if needed ─────────────────────────────────────────────────
// api.adsb.lol did NOT pre-compress when this was written, but its sibling
// trace host compresses unconditionally regardless of Accept-Encoding, and
// curlGetRequest does not auto-decode. The magic-byte check costs nothing and
// stops a gzip body being cached and served as if it were JSON.
if (strncmp($data, "\x1f\x8b", 2) === 0) {
    $decoded = @gzdecode($data);
    if ($decoded === false || $decoded === null) {
        serveStaleOrFail($cacheFile, 502, "Failed to decompress traffic data from adsb.lol.");
    }
    $data = $decoded;
}

// ── Sanity checks: bounded size, valid JSON with the expected shape ──────
// A 250 nm query over a busy region is the worst case; 8 MB is far above any
// observed response (a 50 nm LA query is about 64 KB) and exists to stop an
// unexpected upstream body being cached wholesale.
if (strlen($data) > 8 * 1024 * 1024) {
    serveStaleOrFail($cacheFile, 502, "Traffic response too large.");
}
$parsed = json_decode($data, true);
if (!is_array($parsed) || !isset($parsed['ac']) || !is_array($parsed['ac'])) {
    // An HTML error page or malformed body must never be cached as traffic.
    serveStaleOrFail($cacheFile, 502, "adsb.lol returned an unexpected response.");
}

// ── Cache and return ─────────────────────────────────────────────────────
atomicWrite($cacheFile, $data);

header("Content-Type: application/json; charset=utf-8");
header("X-ADSB-Cache: miss");
echo $data;
