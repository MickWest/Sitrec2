<?php
// streetview.php — Google Map Tiles API "Street View tiles" proxy + equirectangular stitcher.
//
// Fetches a Street View panorama via the LICENSED Map Tiles API (tile.googleapis.com),
// stitches the 512px tile pyramid into a single equirectangular JPEG (server-side, so the
// API key never reaches the browser), caches the result, and serves it for use as a
// textured background sphere (see src/nodes/CNodeStreetViewPano.js).
//
// Two operations:
//   ?op=meta&lat=<lat>&lon=<lon>[&radius=<m>]   -> JSON metadata for the nearest pano
//   ?op=meta&pano=<panoId>                       -> JSON metadata for a specific pano
//   ?op=image&pano=<panoId>[&zoom=<0..5>]        -> image/jpeg stitched equirectangular pano
//
// The GOOGLE_MAPS_API_KEY in shared.env is HTTP-referrer-restricted (browser key). Server
// requests therefore send a Referer header matching the allowed referrer; override with the
// GOOGLE_MAPS_REFERER env var if the key allows a different referrer (or is IP-restricted).
//
// Cost note: Street View TILE fetches are billed against the project's key, and one op=image
// request fans out to many tile fetches. To limit abuse of this unauthenticated endpoint we
// (a) restrict CORS to the app's own origin, (b) clamp zoom and cap output pixels, (c) cache
// completed stitches to disk, and (d) apply PER-GROUP rate limits — admin & Sitrec groups are
// unlimited, other logged-in users get the standard caps, anonymous callers get 1/10th — plus
// a global backstop on fresh (cache-miss) stitches/min from non-privileged callers. This is
// prototype-grade hardening, not a substitute for a proper billing-budget cap on the Google key.

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

// ---- CORS: only the app's own origin (and configured LOCALHOST), never '*'. ----
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($requestOrigin) {
    $serverOrigin = ($_SERVER['REQUEST_SCHEME'] ?? 'https') . '://' . ($_SERVER['HTTP_HOST'] ?? '');
    $allowedOrigins = [$serverOrigin];
    $localhostEnv = getenv('LOCALHOST');
    if ($localhostEnv) {
        $allowedOrigins[] = 'https://' . $localhostEnv;
        $allowedOrigins[] = 'http://' . $localhostEnv;
    }
    if (in_array($requestOrigin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $requestOrigin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: GET, OPTIONS');
    }
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// ---- Atomic rate limiter (flock across the whole read-modify-write). Returns false when over cap. ----
function rateLimit($key, $max, $window) {
    $dir = sys_get_temp_dir() . '/sitrec_streetview_ratelimit/';
    if (!is_dir($dir)) { @mkdir($dir, 0755, true); }
    $file = $dir . md5($key) . '.json';
    $fp = @fopen($file, 'c+');
    if (!$fp) return true; // fail-open: never break the feature on a temp-dir hiccup
    flock($fp, LOCK_EX);
    $now = time();
    $raw = stream_get_contents($fp);
    $data = $raw ? json_decode($raw, true) : null;
    if (!$data || $now > ($data['reset'] ?? 0)) { $data = ['count' => 0, 'reset' => $now + $window]; }
    $ok = $data['count'] < $max;
    if ($ok) { $data['count']++; }
    rewind($fp); ftruncate($fp, 0); fwrite($fp, json_encode($data));
    flock($fp, LOCK_UN); fclose($fp);
    return $ok;
}

// ---- Per-group throttle tier. Admin (group 3) and the Sitrec groups (14 = Members,
//      19 = Plus) are UNLIMITED. Other logged-in users get the standard limits; anonymous
//      callers get one tenth. getUserInfo() reads the same-origin forum session and must be
//      called once per request. ----
$userInfo = getUserInfo();
$userGroups = is_array($userInfo['user_groups'] ?? null) ? $userInfo['user_groups'] : [];
$unlimitedUser = isAdmin($userInfo) || count(array_intersect($userGroups, [14, 19])) > 0;
$loggedIn = ($userInfo['user_id'] ?? 0) > 0;
$tier = $unlimitedUser ? 'unlimited' : ($loggedIn ? 'logged_in' : 'anon');

// Per-minute caps by tier: 'req' = all requests per IP, 'stitch' = fresh (cache-miss,
// billed) stitches per IP. Anonymous = 1/10th of logged-in. 'unlimited' bypasses both.
$TIER_LIMITS = [
    'logged_in' => ['req' => 120, 'stitch' => 60],
    'anon'      => ['req' => 12,  'stitch' => 6],
];

$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if ($tier !== 'unlimited') {
    if (!rateLimit('ip_' . $tier . '_' . $clientIP, $TIER_LIMITS[$tier]['req'], 60)) {
        http_response_code(429);
        exit('Rate limit exceeded. Please wait.');
    }
}

// ---- Config ----
$API_KEY = getenv('GOOGLE_MAPS_API_KEY');
$REFERER = getenv('GOOGLE_MAPS_REFERER');
if (!$REFERER) { $REFERER = 'https://www.metabunk.org/'; }
$TILE_BASE = 'https://tile.googleapis.com/v1';
$MAX_PIXELS = 40000000;   // ~8960x4480 cap on the stitched canvas (memory guard)
$MAX_STITCHES_PER_MIN = 60; // global backstop on fresh stitches from all NON-privileged callers (anti IP-rotation abuse)

function fail($code, $msg, $upstream = null) {
    if ($upstream !== null) {
        // Log upstream detail server-side; never echo it to anonymous callers.
        error_log('streetview.php: ' . $msg . ' :: ' . substr((string)$upstream, 0, 500));
    }
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['status' => 'ERROR', 'error' => $msg]);
    exit();
}

if (!$API_KEY) {
    fail(500, 'GOOGLE_MAPS_API_KEY is not configured on the server.');
}

// ---- HTTP helper (curl), always sending the Referer the key expects ----
function gfetch($url, $postJson = null) {
    global $REFERER;
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_REFERER, $REFERER);
    if ($postJson !== null) {
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $postJson);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    }
    if (getenv('SITREC_DISABLE_SSL_VERIFY')) {
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);
    }
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    return [$status, $body, $ctype];
}

// ---- Session token: created once, cached up to ~2 weeks, reused. ----
function getSession() {
    global $TILE_BASE, $API_KEY, $CACHE_PATH;
    $sessionFile = $CACHE_PATH . 'streetview_session.json';
    if (file_exists($sessionFile)) {
        $cached = json_decode(file_get_contents($sessionFile), true);
        if ($cached && !empty($cached['session']) && time() < (($cached['expiry'] ?? 0) - 3600)) {
            return $cached['session'];
        }
    }
    list($status, $body) = gfetch($TILE_BASE . '/createSession?key=' . urlencode($API_KEY),
        json_encode(['mapType' => 'streetview', 'language' => 'en-US', 'region' => 'US']));
    if ($status !== 200) {
        fail(502, 'createSession failed (' . $status . ')', $body);
    }
    $json = json_decode($body, true);
    if (empty($json['session'])) {
        fail(502, 'createSession returned no session token.', $body);
    }
    @file_put_contents($sessionFile,
        json_encode(['session' => $json['session'], 'expiry' => (int)($json['expiry'] ?? (time() + 1209600))]),
        LOCK_EX);
    return $json['session'];
}

// ---- Resolve nearest panoId from lat/lon ----
function resolvePano($session, $lat, $lon, $radius) {
    global $TILE_BASE, $API_KEY;
    $url = $TILE_BASE . '/streetview/panoIds?session=' . urlencode($session) . '&key=' . urlencode($API_KEY);
    list($status, $body) = gfetch($url,
        json_encode(['locations' => [['lat' => $lat, 'lng' => $lon]], 'radius' => $radius]));
    if ($status !== 200) {
        fail(502, 'panoIds failed (' . $status . ')', $body);
    }
    $json = json_decode($body, true);
    $ids = $json['panoIds'] ?? [];
    foreach ($ids as $id) {
        if (!empty($id)) return $id;
    }
    return null;
}

// ---- Fetch pano metadata ----
function fetchMeta($session, $panoId) {
    global $TILE_BASE, $API_KEY;
    $url = $TILE_BASE . '/streetview/metadata?session=' . urlencode($session)
         . '&key=' . urlencode($API_KEY) . '&panoId=' . urlencode($panoId);
    list($status, $body) = gfetch($url);
    if ($status !== 200) {
        fail(502, 'metadata failed (' . $status . ')', $body);
    }
    $json = json_decode($body, true);
    if (!$json || empty($json['imageWidth']) || empty($json['imageHeight'])) {
        fail(502, 'metadata returned no image dimensions.', $body);
    }
    return $json;
}

$op = $_GET['op'] ?? 'meta';

if ($op === 'meta') {
    $session = getSession();
    $panoId = isset($_GET['pano']) ? $_GET['pano'] : null;
    if (!$panoId) {
        if (!isset($_GET['lat']) || !isset($_GET['lon'])) {
            fail(400, 'op=meta requires lat & lon, or pano.');
        }
        $lat = (float)$_GET['lat'];
        $lon = (float)$_GET['lon'];
        $radius = isset($_GET['radius']) ? max(1, min(1000, (int)$_GET['radius'])) : 50;
        $panoId = resolvePano($session, $lat, $lon, $radius);
        if (!$panoId) {
            header('Content-Type: application/json');
            echo json_encode(['status' => 'ZERO_RESULTS']);
            exit();
        }
    }
    $meta = fetchMeta($session, $panoId);
    header('Content-Type: application/json');
    echo json_encode([
        'status'      => 'OK',
        'panoId'      => $meta['panoId'] ?? $panoId,
        'lat'         => $meta['lat'] ?? null,
        'lng'         => $meta['lng'] ?? null,
        'heading'     => $meta['heading'] ?? 0,
        'tilt'        => $meta['tilt'] ?? 90,
        'roll'        => $meta['roll'] ?? 0,
        'date'        => $meta['date'] ?? null,
        'copyright'   => $meta['copyright'] ?? '',
        'imageWidth'  => $meta['imageWidth'] ?? null,
        'imageHeight' => $meta['imageHeight'] ?? null,
        'imageryType' => $meta['imageryType'] ?? null,
    ]);
    exit();
}

if ($op === 'image') {
    if (!function_exists('imagecreatetruecolor')) {
        fail(500, 'PHP GD extension is required for stitching but is not available.');
    }
    $panoId = $_GET['pano'] ?? null;
    if (!$panoId) { fail(400, 'op=image requires pano.'); }
    // Clamp zoom to the documented [0,5] ON READ, and key the cache on the clamped value,
    // so junk like zoom=999999 can neither bypass the cache nor grow it without bound.
    $zoomReq = isset($_GET['zoom']) ? max(0, min(5, (int)$_GET['zoom'])) : 3;

    $cacheFile = $CACHE_PATH . 'sv_' . md5($panoId . '_' . $zoomReq) . '.jpg';
    if (file_exists($cacheFile) && filesize($cacheFile) > 0) {
        header('Content-Type: image/jpeg');
        header('Cache-Control: public, max-age=86400');
        readfile($cacheFile);
        exit();
    }

    // Cache miss => this will hit the billed Google tile API. Privileged users (admin/Sitrec)
    // bypass; others get a per-IP per-minute stitch cap (tiered) plus a shared global backstop.
    if ($tier !== 'unlimited') {
        if (!rateLimit('stitch_' . $tier . '_' . $clientIP, $TIER_LIMITS[$tier]['stitch'], 60)) {
            fail(429, 'Panorama stitch rate limit reached for your access level. Please try again shortly.');
        }
        if (!rateLimit('global_image', $MAX_STITCHES_PER_MIN, 60)) {
            fail(429, 'Server busy (panorama stitch limit reached). Please try again shortly.');
        }
    }

    $session = getSession();
    $meta = fetchMeta($session, $panoId);
    $imageWidth  = (int)$meta['imageWidth'];
    $imageHeight = (int)$meta['imageHeight'];
    $tileWidth   = (int)($meta['tileWidth']  ?? 512);
    $tileHeight  = (int)($meta['tileHeight'] ?? 512);
    if ($tileWidth <= 0) $tileWidth = 512;
    if ($tileHeight <= 0) $tileHeight = 512;

    // Per-pano max zoom: the zoom at which the native full-res image is tiled.
    // (NOT a fixed 5 — lower-res photospheres top out earlier; verified empirically.)
    $zmax = ($imageWidth <= $tileWidth) ? 0 : (int)ceil(log($imageWidth / $tileWidth, 2));
    $z = max(0, min($zoomReq, $zmax));

    // Compute dimensions, lowering zoom if the canvas would exceed the pixel cap (memory guard).
    $scale = pow(2, $zmax - $z);
    $wz = (int)ceil($imageWidth / $scale);
    $hz = (int)ceil($imageHeight / $scale);
    while ($z > 0 && ($wz * $hz) > $MAX_PIXELS) {
        $z--;
        $scale = pow(2, $zmax - $z);
        $wz = (int)ceil($imageWidth / $scale);
        $hz = (int)ceil($imageHeight / $scale);
    }
    if ($wz <= 0 || $hz <= 0) { fail(502, 'invalid panorama dimensions.'); }

    $tilesX = (int)ceil($wz / $tileWidth);
    $tilesY = (int)ceil($hz / $tileHeight);
    $expected = $tilesX * $tilesY;

    // Allocate at the TRUE dimensions so padded edge tiles get cropped -> exact 2:1.
    $canvas = imagecreatetruecolor($wz, $hz);
    imagefilledrectangle($canvas, 0, 0, $wz - 1, $hz - 1, imagecolorallocate($canvas, 0, 0, 0));

    $ok = 0;
    for ($ty = 0; $ty < $tilesY; $ty++) {
        for ($tx = 0; $tx < $tilesX; $tx++) {
            $url = $TILE_BASE . '/streetview/tiles/' . $z . '/' . $tx . '/' . $ty
                 . '?session=' . urlencode($session) . '&key=' . urlencode($API_KEY)
                 . '&panoId=' . urlencode($panoId);
            list($status, $body, $ctype) = gfetch($url);
            if ($status !== 200 || $body === false || strpos((string)$ctype, 'image') === false) {
                continue;
            }
            $tile = @imagecreatefromstring($body);
            if ($tile === false) continue;
            imagecopy($canvas, $tile, $tx * $tileWidth, $ty * $tileHeight, 0, 0, $tileWidth, $tileHeight);
            imagedestroy($tile);
            $ok++;
        }
    }

    // Only cache and serve a COMPLETE stitch. A partial/failed fetch (expired session,
    // upstream 429/5xx, network blip) must NOT poison the cache — fail so it retries.
    if ($ok < $expected) {
        imagedestroy($canvas);
        fail(502, 'panorama stitch incomplete (' . $ok . '/' . $expected . ' tiles).');
    }

    @imagejpeg($canvas, $cacheFile, 90);
    imagedestroy($canvas);

    if (file_exists($cacheFile) && filesize($cacheFile) > 0) {
        header('Content-Type: image/jpeg');
        header('Cache-Control: public, max-age=86400');
        readfile($cacheFile);
    } else {
        fail(500, 'Failed to write stitched panorama.');
    }
    exit();
}

fail(400, 'Unknown op (expected meta or image).');
