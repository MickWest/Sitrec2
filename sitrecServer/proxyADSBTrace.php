<?php
/**
 * proxyADSBTrace.php — CORS proxy for adsb.lol readsb "trace_full" JSON:
 * roughly the last 24 hours of positions for one aircraft, by ICAO hex.
 *
 * Upstream (constructed server-side, never taken from the client):
 *   https://adsb.lol/data/traces/{last two hex digits}/trace_full_{hex}.json
 *
 * Parameters:
 *   hex = a1b2c3   (required, exactly 6 hex digits, case-insensitive)
 *
 * Returns: the raw trace JSON (application/json), or an error message.
 *
 * Rate limit: 30 requests per minute per IP (cache hits never consume one).
 * Caching: 5 minutes fresh (a live trace grows over time); on an upstream
 * failure any older cached copy is served with X-Trace-Cache: stale, so a
 * transient adsb.lol outage degrades to slightly old data instead of a dead
 * import. A 404 (aircraft not seen today) is negative-cached for 15 minutes.
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

// ── Rate limiting (30 req/min per IP) ────────────────────────────────────
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_adsbtrace_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
// NOTE: the token is consumed just before the actual upstream fetch below,
// NOT here — cache hits (positive OR negative) never consume one.

/**
 * Atomically consume one rate-limit token. The whole read-increment-write
 * runs under flock(), so parallel requests from one IP serialize on the
 * counter instead of all observing the same count and bypassing the limit.
 * Returns true when a token was granted. Fails OPEN on filesystem trouble —
 * a broken temp dir must degrade the limiter, not the proxy.
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
 * Atomically publish a cache file: write to a temp sibling, then rename()
 * into place (atomic on the same filesystem). A concurrent cache-hit
 * readfile() therefore sees either the old complete file or the new complete
 * file — never a truncated body mid-write.
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
$hex = strtolower($_GET['hex'] ?? '');
if (!preg_match('/^[0-9a-f]{6}$/', $hex)) {
    http_response_code(400);
    exit("Invalid hex. Must be exactly 6 hex digits (an ICAO 24-bit address, e.g. a1b2c3).");
}

// ── Build adsb.lol URL (server-side only — client can never name a host) ─
$url = "https://adsb.lol/data/traces/" . substr($hex, -2) . "/trace_full_" . $hex . ".json";

// ── Check cache ─────────────────────────────────────────────────────────
$cacheLifetime = 5 * 60; // 5 minutes — a live trace keeps growing
$cacheFile = $CACHE_PATH . md5($url) . ".json";

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheLifetime) {
    header("Content-Type: application/json; charset=utf-8");
    header("X-Trace-Cache: hit");
    readfile($cacheFile);
    exit();
}

// ── Negative cache: aircraft not seen today ──────────────────────────────
// adsb.lol returns 404 when it holds no current-day trace for this hex. The
// aircraft may take off later today, so the miss is cached only briefly.
$missFile = $CACHE_PATH . md5($url) . ".miss";
$missLifetime = 15 * 60;
if (file_exists($missFile) && (time() - filemtime($missFile)) < $missLifetime) {
    http_response_code(404);
    header("Content-Type: text/plain");
    header("X-Trace-Cache: miss-hit");
    readfile($missFile);
    exit();
}

// ── Fetch from adsb.lol ─────────────────────────────────────────────────
// Consume a rate-limit token (atomic) — only real upstream fetches reach here.
if (!consumeRateToken($rateLimitFile, 30)) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait a minute.");
}

// A timeout is not optional here either. curlGetRequest waits FOREVER by
// default, so a stalled upstream holds a PHP-FPM worker for the whole request —
// and adsb.lol's trace host stalls, observed twice on 2026-08-30. This proxy is
// now reachable by CLICKING an aircraft in the live traffic layer, so it is easy
// to trigger repeatedly and fast; before that it took a deliberate dialog entry.
// 15s rather than the live feed's 10: a full 24-hour trace is a much larger body.
$result = curlGetRequest($url, [
    'User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)',
], 15);
$data = $result['data'];
$httpStatus = $result['http_status'];

// Serve-stale helper: on a transient upstream failure, an older cached copy
// beats a dead layer. Falls through to a hard error only with no cache.
function serveStaleOrFail($cacheFile, $failCode, $failMessage) {
    if (file_exists($cacheFile)) {
        header("Content-Type: application/json; charset=utf-8");
        header("X-Trace-Cache: stale");
        header("X-Trace-Stale-Seconds: " . (time() - filemtime($cacheFile)));
        readfile($cacheFile);
        exit();
    }
    http_response_code($failCode);
    header("Content-Type: text/plain");
    exit($failMessage);
}

if ($data === false || strlen($data) === 0) {
    serveStaleOrFail($cacheFile, 502, "Failed to fetch trace data from adsb.lol.");
}

if ($httpStatus >= 400) {
    if ($httpStatus === 404) {
        // Definitive "not seen today" — negative-cache briefly.
        $missMsg = "No trace available for " . htmlspecialchars($hex)
            . " — adsb.lol has no positions for this aircraft today (HTTP 404).";
        atomicWrite($missFile, $missMsg);
        http_response_code(404);
        header("Content-Type: text/plain");
        header("X-Trace-Cache: miss-store");
        exit($missMsg);
    }
    // Other 4xx/5xx: transient or upstream trouble — prefer stale data.
    serveStaleOrFail($cacheFile, 502, "adsb.lol returned HTTP " . intval($httpStatus));
}

// ── Decompress ──────────────────────────────────────────────────────────
// adsb.lol serves trace files pre-compressed (Content-Encoding: gzip)
// regardless of Accept-Encoding, and curlGetRequest does not auto-decode,
// so the raw body arrives as gzip bytes. Detect the gzip magic and decode;
// the cache below always holds (and serves) the PLAIN JSON.
if (strncmp($data, "\x1f\x8b", 2) === 0) {
    $decoded = @gzdecode($data);
    if ($decoded === false || $decoded === null) {
        serveStaleOrFail($cacheFile, 502, "Failed to decompress trace data from adsb.lol.");
    }
    $data = $decoded;
}

// ── Sanity checks: bounded size, valid JSON with the trace shape ─────────
if (strlen($data) > 8 * 1024 * 1024) {
    serveStaleOrFail($cacheFile, 502, "Trace response too large.");
}
$parsed = json_decode($data, true);
if (!is_array($parsed) || !isset($parsed['trace']) || !is_array($parsed['trace'])) {
    // An HTML error page or malformed body must never be cached as a trace.
    serveStaleOrFail($cacheFile, 502, "adsb.lol returned an unexpected response.");
}

// ── Cache and return ────────────────────────────────────────────────────
atomicWrite($cacheFile, $data);
@unlink($missFile);   // a prior miss is now stale — this trace exists

header("Content-Type: application/json; charset=utf-8");
header("X-Trace-Cache: miss");
echo $data;
