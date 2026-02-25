<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/curlGetRequest.php';

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
    "CURRENT_STARLINK" => "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle",
    "CURRENT_ACTIVE" => "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
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
$ext = strtolower($path_parts['extension']);

// for hosts that don't have an extension, add the right one here.
if (strcmp($url_parts['host'],"celestrak.org") === 0) {
    $ext = "tle";
}


$allowed_extensions = ["txt", "tle", "2le", "3le"];
if (!in_array($ext, $allowed_extensions, true)) {
    exit("Illegal File Type " . $ext);
}

$hash = md5($url) . "." . $ext;
$cachePath = $CACHE_PATH . $hash;
$fileLocation = $CACHE_PATH;
$cachedFile = $fileLocation . $hash;

$lifetime = 60 * 60; // 1 hour

if (file_exists($cachedFile) && (time() - filemtime($cachedFile)) < $lifetime) {
    header("Location: " . $cachePath);
    exit();
} else {
    $result = curlGetRequest($url);
    $dataBlob = $result['data'];

    if ($dataBlob === false || strlen($dataBlob) === 0) {
        exit("Failed to fetch the URL");
    }

    if (file_put_contents($cachedFile, $dataBlob) === false) {
        exit("Failed to write cache file");
    }

    header("Location: " . $cachePath);
    exit();
}
?>
