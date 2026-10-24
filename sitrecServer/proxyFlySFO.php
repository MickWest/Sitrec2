<?php
/**
 * FlySFO flight status proxy — caches the SFO airport flight status API.
 *
 * Usage: proxyFlySFO.php
 *
 * Returns the full FlySFO flight-status JSON, cached for 5 minutes.
 * No API key needed — this is SFO's public status board data.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/rate_limit.php';

// Only allow GET requests
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── Response cache (5 min TTL, shared across all users) ──
$CACHE_TTL = 300; // 5 minutes
$cacheDir = sys_get_temp_dir() . '/sitrec_flysfo_cache/';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}
$cacheFile = $cacheDir . 'flight-status.json';

if (file_exists($cacheFile)) {
    $cacheAge = time() - filemtime($cacheFile);
    if ($cacheAge < $CACHE_TTL) {
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

// ── Per-IP rate limiting of upstream fetches: 20/min ──
// Only a cache miss spends a token; cached answers are never refused.
if (!sitrecConsumeRateToken('flysfo', 20, 60, $resetAt)) {
    http_response_code(429);
    header('Content-Type: application/json');
    header('Retry-After: ' . max(1, $resetAt - time()));
    echo json_encode(['error' => 'Rate limit exceeded']);
    exit;
}

// ── Fetch from FlySFO ──
$url = 'https://www.flysfo.com/flysfo/api/flight-status';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 20);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Accept: application/json',
    'User-Agent: Sitrec/1.0',
]);

$data = curl_exec($ch);
$httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($data === false || $httpStatus !== 200) {
    // If we have a stale cache, serve it rather than failing
    if (file_exists($cacheFile)) {
        $cached = file_get_contents($cacheFile);
        if ($cached !== false) {
            http_response_code(200);
            header('Content-Type: application/json');
            header('X-Cache: STALE');
            echo $cached;
            exit;
        }
    }
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Failed to fetch FlySFO data']);
    exit;
}

// Cache the response
file_put_contents($cacheFile, $data, LOCK_EX);

http_response_code(200);
header('Content-Type: application/json');
header('X-Cache: MISS');
echo $data;
