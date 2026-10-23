<?php
/**
 * ADSBx API proxy — keeps the RapidAPI key server-side.
 *
 * Usage: proxyADSBx.php?lat=33.94&lon=-118.41&dist=30
 *
 * Features:
 * - Per-airport response caching (30s TTL) — all users watching the same
 *   airport share one API call per cache window
 * - Per-IP rate limiting (10 req/min)
 * - API key stored in shared.env (ADSBX_RAPIDAPI_KEY)
 *
 * Cache key is rounded lat/lon (2 decimals) + dist, so nearby requests
 * for the same airport hit the same cache slot.
 */

require_once __DIR__ . '/config.php';

// Only allow GET requests
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── Rate limiting: 10 req/min per IP ──
// Use X-Forwarded-For or CF-Connecting-IP if behind a reverse proxy
$clientIP = $_SERVER['HTTP_CF_CONNECTING_IP']
    ?? $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? $_SERVER['REMOTE_ADDR']
    ?? 'unknown';
// X-Forwarded-For may contain multiple IPs — use the first (client)
$clientIP = explode(',', $clientIP)[0];
$clientIP = trim($clientIP);
$rateLimitDir = sys_get_temp_dir() . '/sitrec_adsbx_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . '.json';
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 10) {
    http_response_code(429);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Rate limit exceeded. Max 10 requests per minute.']);
    exit;
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

// ── Validate parameters ──
$lat  = isset($_GET['lat'])  ? floatval($_GET['lat'])  : null;
$lon  = isset($_GET['lon'])  ? floatval($_GET['lon'])  : null;
$dist = isset($_GET['dist']) ? intval($_GET['dist'])    : null;

if ($lat === null || $lon === null || $dist === null) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Missing required parameters: lat, lon, dist']);
    exit;
}

// Clamp values to sane ranges
$lat  = max(-90, min(90, $lat));
$lon  = max(-180, min(180, $lon));
$dist = max(1, min(250, $dist));

// ── Per-airport response cache (30s TTL) ──
// Round lat/lon to 2 decimals (~1km) so all requests for the same airport
// converge to the same cache key regardless of minor floating point differences.
$CACHE_TTL = 30;
$cacheDir = sys_get_temp_dir() . '/sitrec_adsbx_cache/';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}
$cacheKey = sprintf("%.2f_%.2f_%d", $lat, $lon, $dist);
$cacheFile = $cacheDir . md5($cacheKey) . '.json';

if (file_exists($cacheFile)) {
    $cacheAge = time() - filemtime($cacheFile);
    if ($cacheAge < $CACHE_TTL) {
        // Serve cached response
        $cached = file_get_contents($cacheFile);
        if ($cached !== false) {
            http_response_code(200);
            header('Content-Type: application/json');
            header('X-Cache: HIT');
            header("X-Cache-Age: {$cacheAge}");
            echo $cached;
            exit;
        }
    }
}

// ── Get API key ──
$apiKey = getenv('ADSBX_RAPIDAPI_KEY');
if (!$apiKey) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'ADSBx API key not configured on server']);
    exit;
}

// ── Proxy the request ──
$url = "https://adsbexchange-com1.p.rapidapi.com/v2/lat/{$lat}/lon/{$lon}/dist/{$dist}/";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'X-RapidAPI-Key: ' . $apiKey,
    'X-RapidAPI-Host: adsbexchange-com1.p.rapidapi.com',
]);

$data = curl_exec($ch);
$httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($data === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Failed to reach ADSBx API']);
    exit;
}

// Cache successful responses
if ($httpStatus === 200 && $data) {
    file_put_contents($cacheFile, $data, LOCK_EX);
}

// Forward the upstream status and response
http_response_code($httpStatus);
header('Content-Type: application/json');
header('X-Cache: MISS');
echo $data;
