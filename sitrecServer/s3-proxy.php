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
 *
 * With credentials configured (static keys or a role) the object is fetched
 * through the SDK, so private objects, FIPS endpoints and custom endpoints work.
 * Without credentials the unsigned public URL is fetched with cURL, as before.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/object_helpers.php';
require_once __DIR__ . '/s3_client.php';

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

/**
 * A short sha256 prefix of an object key, for the log. An object key is
 * `<userId>/<fileName>/<newFileName>`, so the key itself carries the user's file
 * name and is the capability that grants access to the object; neither belongs in
 * a log. The hash still lets repeated failures on one object be correlated. Same
 * approach as authCertLogLine() in auth_cert.php.
 *
 * @param string $key
 * @return string
 */
function objectKeyDigest($key) {
    return substr(hash('sha256', (string)$key), 0, 16);
}

/**
 * Streams the object through the SDK with the configured credentials.
 *
 * Returns true once the response has been sent (the object, or a 404 for a
 * missing key). Returns false, before anything has been sent, when the signed
 * fetch could not be made at all - no resolvable credentials, a key S3 rejects,
 * a role without permission - so the caller can fall back to the unsigned URL.
 *
 * @param string $key
 * @param string|null $rangeHeader Validated Range header value, or null.
 * @return bool
 */
function proxyObjectWithSdk($key, $rangeHeader) {
    global $s3creds;
    try {
        $s3 = getS3Client();
        $params = [
            'Bucket' => $s3creds['bucket'],
            'Key' => $key,
            '@http' => ['stream' => true],
        ];
        if ($rangeHeader !== null) {
            $params['Range'] = $rangeHeader;
        }
        $result = $s3->getObject($params);
    } catch (Aws\S3\Exception\S3Exception $e) {
        if ($e->getAwsErrorCode() === 'NoSuchKey') {
            proxyError(404, 'Object not found');
        }
        // getMessage() embeds the request URI, and so the object key: the SDK formats it
        // as `Error executing "GetObject" on "<url>"; ...`. getAwsErrorMessage() is the
        // service's concise text, without the URI.
        error_log('s3-proxy: signed fetch failed for key ' . objectKeyDigest($key)
            . ' (' . ($e->getAwsErrorCode() ?: get_class($e)) . '), using the unsigned URL: '
            . ($e->getAwsErrorMessage() ?: 'no service message'));
        return false;
    } catch (Exception $e) {
        // No message here: a transport exception embeds the request URI in its own text.
        error_log('s3-proxy: signed fetch failed for key ' . objectKeyDigest($key)
            . ' (' . get_class($e) . '), using the unsigned URL');
        return false;
    }

    $status = (int)($result['@metadata']['statusCode'] ?? 200);
    http_response_code($status === 206 ? 206 : 200);
    if (!empty($result['ContentType'])) {
        header('Content-Type: ' . $result['ContentType']);
    }
    if (isset($result['ContentLength'])) {
        header('Content-Length: ' . $result['ContentLength']);
    }
    if (!empty($result['ContentRange'])) {
        header('Content-Range: ' . $result['ContentRange']);
    }
    if (!empty($result['AcceptRanges'])) {
        header('Accept-Ranges: ' . $result['AcceptRanges']);
    }
    // Cache sitch/object responses client-side; they're immutable per version.
    header('Cache-Control: public, max-age=300');

    $body = $result['Body'];
    while (!$body->eof()) {
        echo $body->read(65536);
    }
    return true;
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

// Forward Range header so video streaming and quickFetch chunked downloads work.
// Validate strictly against RFC 7233 byte-range grammar to close a header-
// injection vector via CRLF in the client-supplied Range header.
$rangeHeader = $_SERVER['HTTP_RANGE'] ?? '';
$validRange = $rangeHeader !== '' && preg_match('/^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/', $rangeHeader) === 1;

// Signed fetch first when the server has credentials. If it cannot be made (see
// proxyObjectWithSdk) fall through to the unsigned public URL, which is what a
// credential-less local install uses for the public regression sitches.
if (s3HasCredentials() && proxyObjectWithSdk($key, $validRange ? $rangeHeader : null)) {
    exit();
}

$remoteUrl = buildDefaultS3ObjectUrl($key);

$forwardedHeaders = ['Accept: */*'];
if ($validRange) {
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
