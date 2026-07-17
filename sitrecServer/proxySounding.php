<?php
/**
 * proxySounding.php — CORS proxy for radiosonde sounding data from UWYO.
 *
 * Parameters:
 *   source   = uwyo              (required, only 'uwyo' supported for now)
 *   station  = 72451             (required, 5-digit WMO station number)
 *   date     = 2024-01-01        (required, YYYY-MM-DD)
 *   hour     = 0 | 12            (required, UTC launch hour)
 *   format   = csv | list        (optional, default 'list')
 *
 * Returns: raw HTML from UWYO (text/html), or error message.
 *
 * Rate limit: 20 requests per minute per IP.
 * Caching: 24 hours (sounding data is static once published).
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

// ── Rate limiting (20 req/min per IP) ────────────────────────────────────
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_sounding_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
// NOTE: the rate-limit check + increment happen just before the actual UWYO
// fetch below, NOT here — so cache hits (positive OR negative) never consume a
// token. Walking many nearby stations that are already cached (or cached as
// missing) must not burn the 20/min UWYO budget and trigger spurious waits.

// ── Parameter validation ─────────────────────────────────────────────────
$source  = $_GET['source']  ?? '';
$station = $_GET['station'] ?? '';
$date    = $_GET['date']    ?? '';
$hour    = $_GET['hour']    ?? '';
$format  = $_GET['format']  ?? 'list';

if ($source !== 'uwyo') {
    http_response_code(400);
    exit("Invalid source. Only 'uwyo' is supported.");
}

if (!preg_match('/^\d{5}$/', $station)) {
    http_response_code(400);
    exit("Invalid station ID. Must be a 5-digit WMO number (e.g. 72451).");
}

if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    http_response_code(400);
    exit("Invalid date. Use YYYY-MM-DD format.");
}

if ($hour !== '0' && $hour !== '12' && $hour !== '00') {
    http_response_code(400);
    exit("Invalid hour. Must be 0 or 12 (UTC).");
}

$allowedFormats = ['csv', 'list'];
$format = strtolower($format);
if (!in_array($format, $allowedFormats, true)) {
    http_response_code(400);
    exit("Invalid format. Must be 'csv' or 'list'.");
}

// ── Build UWYO URL ──────────────────────────────────────────────────────
$hourPad = str_pad($hour, 2, '0', STR_PAD_LEFT);

// WSGI endpoint for both formats. The legacy cgi-bin/sounding endpoint was
// REMOVED by UWYO (returns 404 as of July 2026), so TEXT:LIST goes through
// WSGI too — same fixed-width table, wrapped in the newer page HTML, with
// wind speed in a SPED (m/s) column instead of SKNT (knots); the client
// parser (ParseSonde.js parseUWYOList) handles both.
// The '+' in the datetime is URL-space (UWYO expects "YYYY-MM-DD HH:MM:SS").
$wsgiType = ($format === 'csv') ? "TEXT%3ACSV" : "TEXT%3ALIST";
$url = "https://weather.uwyo.edu/wsgi/sounding?"
     . "datetime=" . $date . "+" . $hourPad . "%3A00%3A00"
     . "&id=" . $station
     . "&type=" . $wsgiType;

// ── Check cache ─────────────────────────────────────────────────────────
$cacheLifetime = 60 * 60 * 24; // 24 hours
$cacheHash = md5($url) . ".html";
$cacheFile = $CACHE_PATH . $cacheHash;

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheLifetime) {
    header("Content-Type: text/html; charset=utf-8");
    header("X-Sounding-Cache: hit");
    readfile($cacheFile);
    exit();
}

// ── Negative cache: known-missing soundings ─────────────────────────────
// A station with no data for this date/hour returns 404 below; cache that so
// the next relocate/refresh doesn't re-hit UWYO (and burn the rate limit) for
// the same missing sounding. A miss for a sounding well in the past is
// permanent; a very recent one might still be processing at UWYO, so cache
// that miss only briefly and recheck.
$missFile = $CACHE_PATH . md5($url) . ".miss";
$soundingTs = strtotime($date . ' ' . $hourPad . ':00:00 UTC');
$missLifetime = ($soundingTs !== false && ($now - $soundingTs) > 12 * 3600)
    ? 30 * 24 * 3600   // clearly in the past — the miss is permanent
    : 3600;            // recent — may still be processing; recheck in an hour
if (file_exists($missFile) && ($now - filemtime($missFile)) < $missLifetime) {
    http_response_code(404);
    header("Content-Type: text/plain");
    header("X-Sounding-Cache: miss-hit");
    readfile($missFile);
    exit();
}

// ── Fetch from UWYO ─────────────────────────────────────────────────────
// Consume a rate-limit token — only real UWYO fetches reach here (cache hits
// above already returned).
if ($rateData['count'] >= 20) {
    http_response_code(429);
    exit("Rate limit exceeded. UWYO is rate-sensitive — please wait a minute.");
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

$result = curlGetRequest($url);
$data = $result['data'];
$httpStatus = $result['http_status'];

if ($data === false || strlen($data) === 0) {
    http_response_code(502);
    exit("Failed to fetch sounding data from UWYO.");
}

if ($httpStatus >= 400) {
    // A 4xx from UWYO (it returns 404 for a station/date/hour with no sounding)
    // is a definitive "missing" answer — negative-cache it so the next
    // relocate/refresh doesn't re-hit UWYO (a cold miss can take ~16s and burns
    // a rate-limit token). A 5xx is a transient UWYO server error: return 502
    // and do NOT cache it.
    if ($httpStatus < 500) {
        $missMsg = "No sounding data available for station " . htmlspecialchars($station)
           . " on " . htmlspecialchars($date) . " " . htmlspecialchars($hourPad) . "Z "
           . "(UWYO HTTP " . intval($httpStatus) . "). The station may not exist or no "
           . "data was recorded for this time.";
        @file_put_contents($missFile, $missMsg, LOCK_EX);
        http_response_code(404);
        header("Content-Type: text/plain");
        header("X-Sounding-Cache: miss-store");
        exit($missMsg);
    }
    http_response_code(502);
    exit("UWYO returned HTTP " . $httpStatus);
}

// Check for UWYO error pages
// cgi-bin errors: "Can't get ...", "Please try again"
// WSGI errors: "Unable to retrieve the data for ..."
if (strpos($data, "Can't get") !== false
    || strpos($data, "Please try again") !== false
    || strpos($data, "Unable to retrieve") !== false) {
    $missMsg = "No sounding data available for station " . htmlspecialchars($station)
       . " on " . htmlspecialchars($date) . " " . htmlspecialchars($hourPad) . "Z. "
       . "The station may not exist or no data was recorded for this time.";
    // Negative-cache the miss so we don't re-hit UWYO for it (see check above).
    @file_put_contents($missFile, $missMsg, LOCK_EX);
    http_response_code(404);
    header("Content-Type: text/plain");
    header("X-Sounding-Cache: miss-store");
    exit($missMsg);
}

// ── Cache and return ────────────────────────────────────────────────────
file_put_contents($cacheFile, $data, LOCK_EX);
@unlink($missFile);   // a prior miss is now stale — this sounding exists

header("Content-Type: text/html; charset=utf-8");
header("X-Sounding-Cache: miss");
echo $data;
