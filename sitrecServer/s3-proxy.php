<?php

/*
 * Module: Sitrec public S3 object proxy.
 *
 * Streams a single object from the configured Sitrec S3 bucket back to the
 * browser same-origin. Used as a fallback by object.php when the server is
 * running in local-filesystem mode (SAVE_TO_S3=false) but a referenced
 * object (e.g. a regression-test sitch under 99999999/...) is not mirrored
 * locally. Routing through PHP avoids the bucket's cross-origin restriction
 * (no Access-Control-Allow-Origin on sitrec.s3.us-west-2.amazonaws.com for
 * arbitrary origins like http://localhost:8080).
 *
 * Only the configured sitrec bucket is accessible; callers pass an object
 * key, not an arbitrary URL, so this is not a general-purpose open proxy.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/object_helpers.php';

$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($requestOrigin) {
    $serverOrigin = $_SERVER['REQUEST_SCHEME'] . '://' . $_SERVER['HTTP_HOST'];
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

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

function proxyError($status, $message) {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit();
}

$key = $_GET['key'] ?? '';
$key = ltrim(trim((string)$key), '/');

if ($key === '') {
    proxyError(400, 'Missing key parameter');
}
if (preg_match('/[\x00-\x1f\\\\]/', $key)) {
    proxyError(400, 'Invalid key');
}
if (preg_match('#(^|/)\.\.?(/|$)#', $key)) {
    proxyError(400, 'Invalid key');
}
if (!preg_match('#^\d+/.+#', $key)) {
    proxyError(400, 'Invalid key');
}

if (empty($s3creds['bucket']) || empty($s3creds['region'])) {
    proxyError(503, 'S3 proxy not configured');
}

$remoteUrl = buildDefaultS3ObjectUrl($key);

// Forward Range header so video streaming and quickFetch chunked downloads work.
// Validate strictly against RFC 7233 byte-range grammar to close a header-
// injection vector via CRLF in the client-supplied Range header.
$forwardedHeaders = ['Accept: */*'];
$rangeHeader = $_SERVER['HTTP_RANGE'] ?? '';
if ($rangeHeader !== '' && preg_match('/^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/', $rangeHeader)) {
    $forwardedHeaders[] = 'Range: ' . $rangeHeader;
}

$ch = curl_init($remoteUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER => false,
    // Do NOT follow redirects: the initial URL points at the configured
    // sitrec bucket, but a chained redirect into an internal/metadata host
    // would let cURL follow it and turn this endpoint into an SSRF lever.
    // S3 GetObject does not redirect in normal use.
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_HTTPHEADER => $forwardedHeaders,
]);

// Capture response headers so we can forward Content-Type / Content-Length
// while dropping anything cookie- or cache-related we don't want to proxy.
$responseHeaders = [];
$statusCode = 0;
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $headerLine) use (&$responseHeaders, &$statusCode) {
    // Status line resets the captured headers so a redirect (shouldn't happen
    // with FOLLOWLOCATION=false, but belt+suspenders) wouldn't leak prior
    // headers into our forwarded response.
    if (preg_match('#^HTTP/\S+\s+(\d{3})#', $headerLine, $m)) {
        $statusCode = (int)$m[1];
        $responseHeaders = [];
        return strlen($headerLine);
    }
    $trimmed = trim($headerLine);
    if ($trimmed === '') return strlen($headerLine);
    if (strpos($trimmed, ':') !== false) {
        list($name, $value) = explode(':', $trimmed, 2);
        $responseHeaders[strtolower(trim($name))] = trim($value);
    }
    return strlen($headerLine);
});

$headersSent = false;
$emitHeaders = function () use (&$headersSent, &$responseHeaders, &$statusCode) {
    if ($headersSent) return;
    http_response_code($statusCode ?: 502);
    if (!empty($responseHeaders['content-type'])) {
        header('Content-Type: ' . $responseHeaders['content-type']);
    }
    if (!empty($responseHeaders['content-length'])) {
        header('Content-Length: ' . $responseHeaders['content-length']);
    }
    if (!empty($responseHeaders['content-range'])) {
        header('Content-Range: ' . $responseHeaders['content-range']);
    }
    if (!empty($responseHeaders['accept-ranges'])) {
        header('Accept-Ranges: ' . $responseHeaders['accept-ranges']);
    }
    // Cache sitch/object responses client-side; they're immutable per version.
    header('Cache-Control: public, max-age=300');
    $headersSent = true;
};
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use ($emitHeaders) {
    $emitHeaders();
    echo $chunk;
    return strlen($chunk);
});

$ok = curl_exec($ch);
if ($ok === false && !$headersSent) {
    proxyError(502, 'Upstream S3 fetch failed: ' . curl_error($ch));
}
// Emit headers+status even when upstream returned an empty body (e.g. 404 with
// no content). Without this, the write callback never fires, no status is
// sent, and PHP defaults to "200 OK, empty body."
$emitHeaders();
curl_close($ch);
