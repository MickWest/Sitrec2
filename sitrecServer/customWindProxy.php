<?php
/**
 * Custom wind data proxy for Sitrec — fetches a user-supplied wind grid JSON
 * by substituting date/hour/level into the CUSTOM_WIND_URL template defined
 * in shared.env, then returns the response.
 *
 * Usage: customWindProxy.php?date=20220919&hour=18&level=surface
 * Levels: surface, 1000, 925, 850, 700, 500, 300, 250, 200, ...
 *
 * The URL template uses placeholders {YYYY} {MM} {DD} {HH} {LEVEL}.
 * {LEVEL} expands to "10m" for surface, or "<n>hPa" for pressure levels
 * — same encoding as tools/fetch_wind.py and the GFS path.
 *
 * The remote endpoint MUST return earth.nullschool-format JSON
 * (see CNodeDisplayWindField._fillFromGFS for the consumer):
 *   { nx, ny, lon0, lat0, dlon, dlat, u:[...], v:[...], refTime, source, level }
 *
 * If CACHE_CUSTOM_WIND=true is set in shared.env, responses are cached to
 * disk in ../data/wind/ (keyed by date/hour/level) and served from cache on
 * subsequent requests. Otherwise the upstream is hit on every call.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/curlGetRequest.php';
require_once __DIR__ . '/audit.php';
sitrecAuditRequest('wind.read');

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$date  = preg_replace('/[^0-9]/', '', $_GET['date'] ?? '');
$hour  = intval($_GET['hour'] ?? 0);
$level = preg_replace('/[^a-z0-9]/', '', $_GET['level'] ?? 'surface');

if (!preg_match('/^\d{8}$/', $date)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid date format, use YYYYMMDD']);
    exit;
}

if ($hour < 0 || $hour > 23) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid hour']);
    exit;
}

sitrecAuditResource('wind/' . $date . '/' . $hour . '/' . $level);
$urlTemplate = getenv('CUSTOM_WIND_URL');
if (!$urlTemplate) {
    http_response_code(500);
    echo json_encode(['error' => 'CUSTOM_WIND_URL not configured']);
    exit;
}

// Snap hour to a 6-hour cycle so cache keys line up with the GFS proxy.
// If a custom source publishes on a different cadence (hourly, 3-hourly), the
// remote endpoint can interpret the {HH} placeholder however it likes — we
// just normalise the cache filename here.
$cycleHour = intdiv($hour, 6) * 6;
$cycleHourStr = sprintf('%02d', $cycleHour);
$levelStr = ($level === 'surface') ? '10m' : "{$level}hPa";

// Substitute placeholders into the URL template.
$year = (int)substr($date, 0, 4);
$month = (int)substr($date, 4, 2);
$day = (int)substr($date, 6, 2);

$url = str_replace(
    ['{YYYY}', '{MM}', '{DD}', '{HH}', '{LEVEL}'],
    [
        sprintf('%04d', $year),
        sprintf('%02d', $month),
        sprintf('%02d', $day),
        $cycleHourStr,
        $levelStr,
    ],
    $urlTemplate
);

// Cache directory shared with windProxy.php (GFS).
// Custom files are prefixed with "custom_" to avoid colliding with GFS data
// at the same date/hour/level.
$cacheDir = __DIR__ . '/../data/wind/';
$caching = (bool)getenv('CACHE_CUSTOM_WIND');
$cacheFile = $cacheDir . "custom_wind_{$date}_{$cycleHourStr}z_{$levelStr}.json";

if ($caching) {
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    if (file_exists($cacheFile)) {
        if (readfile($cacheFile) !== false) sitrecAuditResult();
        exit;
    }
}

$result = curlGetRequest($url);
$data = $result['data'];
$http_status = $result['http_status'];

if ($data === false || empty($data)) {
    http_response_code(502);
    echo json_encode(['error' => 'Empty response from custom wind source']);
    exit;
}

if ($http_status !== 200) {
    http_response_code(502);
    echo json_encode([
        'error' => "Custom wind source returned HTTP {$http_status}",
    ]);
    exit;
}

// Sanity-check that the response is JSON before we cache it.
$decoded = json_decode($data, true);
if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
    http_response_code(502);
    echo json_encode([
        'error' => 'Custom wind source returned non-JSON: ' . json_last_error_msg(),
    ]);
    exit;
}

if ($caching) {
    @file_put_contents($cacheFile, $data, LOCK_EX);
}

sitrecAuditResult();
echo $data;
