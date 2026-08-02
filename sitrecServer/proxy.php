<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/curlGetRequest.php';
require_once __DIR__ . '/gpData.php';

// SECURITY: Rate limiting by IP - max 30 requests per minute
$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_proxy_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 30) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait.");
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

// These are no-longer configurable via config.php
// Instead, set them in shared.env (see example file)
if (getenv("CURRENT_STARLINK")) {
    // Lookup table for requests
    $request_url_map = array(
        "CURRENT_STARLINK" => getEnv("CURRENT_STARLINK"),
        "CURRENT_ACTIVE" => getEnv("CURRENT_ACTIVE"),
    );
} else {        $request_url_map = array(
    // these are the defaults if you don't set something in shared.env
    //
    // FORMAT=csv, not tle. The TLE format cannot express catalog numbers above
    // 99999, and the catalog passed that limit on 2026-07-11 (CelesTrak added
    // Saramago). CelesTrak omits those objects from TLE feeds entirely, so the
    // TLE feed is now silently incomplete - as of 2026-08 it is missing ~128
    // Starlinks. CSV carries the full CCSDS OMM keyword set, has no catalog
    // number limit, keeps the full-precision epoch, and is marginally SMALLER
    // on the wire than TLE. Sitrec parses both (see src/TLEUtils.ts).
    "CURRENT_STARLINK" => "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=csv",
    "CURRENT_ACTIVE" => "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv",
);}

$request = isset($_GET["request"]) ? $_GET["request"] : null;

// the request code might have a ?v=8234823958235 parameter at the end (with a random string)
// so strip that off (just strip off everything after the ?)
$request = strtok($request, "?");


if (!$request) {
    exit("No request");
}
if (!array_key_exists($request, $request_url_map)) {
    exit("Invalid request key ".htmlspecialchars($request, ENT_QUOTES, 'UTF-8'));
}



$url = $request_url_map[$request];
$url_parts = parse_url($url);

// We don't need this check any more, as all URLs are from the $request_url_map array
//if (!$url_parts || $url_parts['scheme'] !== 'https' || $url_parts['host'] !== 'celestrak.org') {
//    exit("Illegal URL or scheme");
//}

$path_parts = pathinfo($url);
$ext = strtolower($path_parts['extension'] ?? '');

// CelesTrak serves everything from gp.php / sup-gp.php, so the path has no
// meaningful extension - the FORMAT query parameter says what we actually get.
if (strcmp($url_parts['host'], "celestrak.org") === 0) {
    $ext = "tle";
    if (isset($url_parts['query'])) {
        parse_str($url_parts['query'], $query_params);
        $format = strtolower($query_params['FORMAT'] ?? '');
        if ($format !== '') {
            $ext = $format;
        }
    }
}


// csv is the OMM format Sitrec now prefers; the *le formats are legacy TLE.
$allowed_extensions = ["txt", "tle", "2le", "3le", "csv"];
if (!in_array($ext, $allowed_extensions, true)) {
    exit("Illegal File Type " . $ext);
}

$hash = md5($url) . "." . $ext;
$cachePath = $CACHE_PATH . $hash;
$fileLocation = $CACHE_PATH;
$cachedFile = $fileLocation . $hash;

// CelesTrak regenerates GP data every 2 hours, and answers a re-request made
// before then with HTTP 403 and a "GP data has not updated since your last
// successful download" body. Polling faster than the publication rate earns
// nothing but rejections, so match the upstream cadence.
$lifetime = 2 * 60 * 60; // 2 hours

// How long to wait before retrying after a failed refresh. Short, so a
// transient upstream error doesn't pin us to stale data for a full lifetime.
$retryAfterFailure = 10 * 60; // 10 minutes

// gpCacheEntry(), not file_exists($cachedFile): only the compressed copy is
// stored now, so testing the uncompressed path would report "no cache" on every
// request and re-fetch from CelesTrak each time - which is exactly what earns
// its 403 "GP data has not updated" response.
$cacheEntry = gpCacheEntry($cachedFile);
$haveCache = ($cacheEntry !== null);
$isFresh = $haveCache && (time() - filemtime($cacheEntry)) < $lifetime;

if (!$isFresh) {
    $result = curlGetRequest($url);
    $dataBlob = $result['data'];
    $httpStatus = $result['http_status'];

    if (isValidGPData($dataBlob, $httpStatus, $ext)) {
        if (!writeGPCache($cachedFile, $dataBlob)) {
            exit("ERROR: Failed to write cache file");
        }
    } else if ($haveCache) {
        // Upstream had nothing new (or nothing valid) for us. Keep serving the
        // copy we already have rather than caching an error page as if it were
        // satellite data, but re-arm a refresh attempt reasonably soon.
        // Touch the file that actually holds the entry - touching the
        // uncompressed path would just create an empty file and leave the
        // backoff with no effect.
        @touch($cacheEntry, time() - $lifetime + $retryAfterFailure);
    } else {
        // Nothing cached and nothing usable upstream - tell the client plainly.
        // The "ERROR:" prefix is what src/TLEUtils.ts looks for to surface this.
        exit("ERROR: Failed to fetch GP data (HTTP " . $httpStatus . "): "
            . substr(trim((string)$dataBlob), 0, 200));
    }
}

// Serve pre-compressed when the client can take it, which cuts the
// current-Starlink payload from ~1.7 MB to ~480 KB. Clients that don't
// advertise gzip get the original redirect to the plain cached file.
serveGPCached($cachedFile, $cachePath, $lifetime);
?>
