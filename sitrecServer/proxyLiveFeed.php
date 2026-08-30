<?php
/**
 * proxyLiveFeed.php — one CORS/caching proxy for every keyless live feed.
 *
 * Adding a feed is a row in $FEEDS below, not a new file. Each row names an
 * upstream URL template, the request headers that upstream demands, a cache
 * lifetime, and which of the optional numeric parameters it takes.
 *
 * SECURITY: the client names a FEED ID, never a URL. Every upstream host is
 * hardcoded here, and the only client-supplied values that reach the URL are
 * numbers that have been range-checked. There is no path by which a caller can
 * point this proxy at a host of their choosing, which is the whole reason the
 * feed table lives server-side.
 *
 * TIMEOUTS ARE MANDATORY, not a nicety: these endpoints are POLLED. cURL waits
 * forever by default, so a stalled upstream holds a PHP-FPM worker for the life
 * of the request; at a few seconds per poll the worker pool is exhausted within
 * a minute and the whole PHP backend stops answering — every other Sitrec
 * feature with it. Observed for real with api.adsb.lol on 2026-08-29. Every row
 * therefore gets a timeout, and curlGetRequest is called with it.
 *
 * Licensing: every feed here is fetched live and NEVER bundled. Attribution
 * strings live client-side in src/livefeeds/LiveFeedRegistry.js and are shown in
 * the app; keep the two in step.
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

// Identifies Sitrec to volunteer-run aggregators, and is outright REQUIRED by
// some: api.adsb.lol answers 403 to a request with no User-Agent, and PHP's
// cURL sends none unless told to.
const SITREC_UA = 'User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)';

/**
 * The feed table.
 *
 *   url       upstream template; {lat} {lon} {radius} are substituted with
 *             validated numbers, and nothing else is ever interpolated.
 *   params    which client parameters this feed accepts (others are ignored).
 *   ttl       seconds a cached body stays fresh.
 *   timeout   seconds before the upstream fetch is abandoned.
 *   headers   request headers the upstream requires.
 *   check     a top-level JSON key that must be present for the body to be
 *             cached — stops an HTML error page being stored as a feed.
 */
$FEEDS = [
    // Military and government aircraft, worldwide. Same provider and licence as
    // the civil live layer (ODbL), so it shares its attribution.
    'mil' => [
        'url' => 'https://api.adsb.lol/v2/mil',
        'params' => [],
        'ttl' => 8,
        'timeout' => 10,
        'headers' => [SITREC_UA],
        'check' => 'ac',
    ],

    // Radiosondes — weather balloons — worldwide, from the SondeHub community
    // network. Directly useful to Sitrec: a balloon aloft is one of the standard
    // mundane explanations, and this says whether one was actually up.
    'balloons' => [
        'url' => 'https://api.v2.sondehub.org/sondes/telemetry?duration=1h',
        'params' => [],
        'ttl' => 60,
        'timeout' => 20,
        'headers' => [SITREC_UA],
        'check' => null,   // keyed by serial at the top level; no fixed key
    ],

    // Upcoming and recent launches. "Was there a launch near time T?" is a
    // recurring mundane explanation, which is why this is here at all.
    'launches' => [
        // /launch/previous/ — launches that have ALREADY HAPPENED, most recent
        // first. The unfiltered /launch/ endpoint sorted by -net puts far-future
        // placeholders at the top (the first result was dated 2039-12-31 "TBD"),
        // which is useless for the question this layer exists to answer: "was
        // there a launch around the time of this sighting?"
        'url' => 'https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=40',
        'params' => [],
        // The free tier is rate-limited and launch schedules move in hours, not
        // seconds, so this is cached hard.
        'ttl' => 1800,
        'timeout' => 20,
        'headers' => [SITREC_UA],
        'check' => 'results',
    ],

    // Earthquakes, magnitude 2.5+, last day. USGS, public domain.
    'quakes' => [
        'url' => 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
        'params' => [],
        'ttl' => 300,
        'timeout' => 15,
        'headers' => [SITREC_UA],
        'check' => 'features',
    ],
];

// ── Parameter validation ─────────────────────────────────────────────────
$feedId = $_GET['feed'] ?? '';
if (!is_string($feedId) || !isset($FEEDS[$feedId])) {
    http_response_code(400);
    exit("Unknown feed. Valid feeds: " . implode(', ', array_keys($FEEDS)));
}
$feed = $FEEDS[$feedId];

$url = $feed['url'];
$cacheParts = [$feedId];

// Only the parameters a feed declares are read, and each is range-checked before
// it can reach the URL. is_numeric comes first because (float)"abc" is 0.0 in
// PHP, which is a valid latitude — a range check alone would accept garbage as
// the equator.
foreach ($feed['params'] as $name) {
    $raw = $_GET[$name] ?? null;
    if ($raw === null || !is_numeric($raw)) {
        http_response_code(400);
        exit("Feed '$feedId' requires a numeric '$name'.");
    }
    $value = (float)$raw;
    $ok = match ($name) {
        'lat' => $value >= -90 && $value <= 90,
        'lon' => $value >= -180 && $value <= 180,
        'radius' => $value >= 1 && $value <= 250,
        default => false,
    };
    if (!$ok) {
        http_response_code(400);
        exit("Parameter '$name' is out of range for feed '$feedId'.");
    }
    $url = str_replace('{' . $name . '}', sprintf('%.6f', $value), $url);
    // Rounded into the cache key so nearby callers share one upstream fetch,
    // while the URL above keeps full precision for a correct result set.
    $cacheParts[] = $name . round($value, 1);
}

// ── Rate limiting (per IP, across all feeds) ─────────────────────────────
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_livefeed_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";

/**
 * Atomically consume one rate-limit token. The read-increment-write runs under
 * flock(), so parallel requests from one IP serialize on the counter instead of
 * all observing the same count. Fails OPEN on filesystem trouble — a broken temp
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

/** Write to a temp sibling then rename() — atomic, so a concurrent reader never sees a half-written body. */
function atomicWrite($path, $data) {
    $tmp = $path . "." . getmypid() . "." . uniqid("", true) . ".tmp";
    if (@file_put_contents($tmp, $data, LOCK_EX) === false) return false;
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

// ── Cache ────────────────────────────────────────────────────────────────
// The upstream URL is part of the key. Without it, editing a feed's URL in the
// table above goes on serving the OLD body for the whole TTL — a launches feed
// pointed at a new endpoint kept returning the previous one's results for half
// an hour, which looks exactly like the edit not having worked.
$cacheFile = $CACHE_PATH . 'livefeed_' . md5(implode('_', $cacheParts) . '|' . $url) . ".json";

if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $feed['ttl']) {
    header("Content-Type: application/json; charset=utf-8");
    header("X-Feed-Cache: hit");
    readfile($cacheFile);
    exit();
}

// ── Fetch ────────────────────────────────────────────────────────────────
// 60/min across all feeds: several layers can be on at once, and each polls on
// its own schedule. Cache hits never reach here, so this counts real upstream
// fetches only.
if (!consumeRateToken($rateLimitFile, 60)) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait a minute.");
}

$result = curlGetRequest($url, $feed['headers'], $feed['timeout']);
$data = $result['data'];
$httpStatus = $result['http_status'];

/**
 * On an upstream failure serve the newest cached body rather than nothing: a few
 * minutes of staleness is almost always better than an empty layer. The header
 * tells the client, which must then SAY so — a stale layer presented as current
 * is worse than an honest gap.
 */
function serveStaleOrFail($cacheFile, $failCode, $failMessage) {
    if (file_exists($cacheFile)) {
        header("Content-Type: application/json; charset=utf-8");
        header("X-Feed-Cache: stale");
        header("X-Feed-Stale-Seconds: " . (time() - filemtime($cacheFile)));
        readfile($cacheFile);
        exit();
    }
    http_response_code($failCode);
    header("Content-Type: text/plain");
    exit($failMessage);
}

if ($data === false || strlen($data) === 0) {
    serveStaleOrFail($cacheFile, 502, "Failed to fetch the '$feedId' feed.");
}
if ($httpStatus >= 400) {
    serveStaleOrFail($cacheFile, 502, "Upstream returned HTTP " . intval($httpStatus) . " for '$feedId'.");
}

// Digitraffic is asked for gzip and curlGetRequest does not auto-decode, so the
// body arrives compressed. Detect by magic bytes rather than by feed, since any
// upstream may compress unprompted (the adsb.lol trace host always does).
if (strncmp($data, "\x1f\x8b", 2) === 0) {
    $decoded = @gzdecode($data);
    if ($decoded === false || $decoded === null) {
        serveStaleOrFail($cacheFile, 502, "Failed to decompress the '$feedId' feed.");
    }
    $data = $decoded;
}

// Bounded size, and the shape the feed is supposed to have. An HTML error page
// or a truncated body must never be cached and then served as if it were data.
if (strlen($data) > 16 * 1024 * 1024) {
    serveStaleOrFail($cacheFile, 502, "Response too large for '$feedId'.");
}
$parsed = json_decode($data, true);
if (!is_array($parsed)) {
    serveStaleOrFail($cacheFile, 502, "Upstream returned an unexpected response for '$feedId'.");
}
if ($feed['check'] !== null && !isset($parsed[$feed['check']])) {
    serveStaleOrFail($cacheFile, 502, "Upstream response for '$feedId' is missing '{$feed['check']}'.");
}

atomicWrite($cacheFile, $data);

header("Content-Type: application/json; charset=utf-8");
header("X-Feed-Cache: miss");
echo $data;
