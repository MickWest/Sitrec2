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

// Only allow GET requests
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── Per-IP rate limiting: 20 req/min ──
$clientIP = $_SERVER['HTTP_CF_CONNECTING_IP']
    ?? $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? $_SERVER['REMOTE_ADDR']
    ?? 'unknown';
$clientIP = trim(explode(',', $clientIP)[0]);
$rateLimitDir = sys_get_temp_dir() . '/sitrec_flysfo_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . '.json';
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 20) {
    http_response_code(429);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Rate limit exceeded']);
    exit;
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

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
