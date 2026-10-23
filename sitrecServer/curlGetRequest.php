<?php
require_once __DIR__ . '/audit.php';
// Simple cURL proxy function to forward requests with Authorization header (if present)
//
// $extraHeaders: optional additional request headers, e.g.
//   ['User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)']
// PHP's cURL sends NO User-Agent unless one is set, and some upstreams reject
// that outright — api.adsb.lol answers 403 to a request with no User-Agent and
// 200 to the identical request with one. Passing none keeps the previous
// behaviour exactly, so existing callers are unaffected.
// $timeoutSec: overall time limit in seconds. Omitted, or not a positive number,
// it is CURL_GET_DEFAULT_TIMEOUT_SEC. Pass a longer limit only for an upstream
// that legitimately sends a large body, and a shorter one for a polled endpoint.
//
// There is deliberately no "wait forever" setting. cURL's own default is to wait
// forever, and a stalled upstream then holds a PHP worker for the life of the
// request; a few such requests at once, or one caller polling every few seconds,
// exhaust the worker pool, and the whole PHP backend stops answering — every
// other Sitrec server feature with it, not just the one that is waiting.
// Observed for real on 2026-08-29 when api.adsb.lol began stalling instead of
// answering. On a timeout the request fails like any other transport error:
// 'data' is false and 'http_status' is 0.
//
// The default is a define() rather than a const so that config.php (or a test)
// can set a different one before this file is loaded.
if (!defined('CURL_GET_DEFAULT_TIMEOUT_SEC')) {
    define('CURL_GET_DEFAULT_TIMEOUT_SEC', 20);
}
// The connect phase gets a shorter budget: an upstream that will not even
// complete a TCP handshake is not going to serve a body in time either.
const CURL_GET_CONNECT_TIMEOUT_SEC = 5;

/**
 * The [total, connect] time limits, in whole seconds, that curlGetRequest()
 * applies for a requested $timeoutSec. Both are always at least one second.
 */
function curlGetTimeouts($timeoutSec = null) {
    $total = (int)$timeoutSec > 0 ? (int)$timeoutSec : max(1, (int)CURL_GET_DEFAULT_TIMEOUT_SEC);
    return [$total, min(CURL_GET_CONNECT_TIMEOUT_SEC, $total)];
}

function curlGetRequest($url, $extraHeaders = [], $timeoutSec = null) {
    $ch = curl_init();

    [$totalSec, $connectSec] = curlGetTimeouts($timeoutSec);
    curl_setopt($ch, CURLOPT_TIMEOUT, $totalSec);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $connectSec);

    // check for Authorization header and pass it along if present
    $headers = getallheaders();
    $curl_headers = [];
    if (array_key_exists('Authorization', $headers)) {
        $curl_headers[] = 'Authorization: ' . $headers['Authorization'];
    }
    foreach ($extraHeaders as $h) {
        $curl_headers[] = $h;
    }
    if (!empty($curl_headers)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $curl_headers);
    }
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $data = curl_exec($ch);
    if ($data === false) {
        // PHP exposes libcurl's peer-verification error under CURLE_SSL_CACERT;
        // the newer libcurl alias is not defined by every PHP cURL extension.
        $tlsErrors = [CURLE_SSL_CONNECT_ERROR, CURLE_SSL_CACERT, CURLE_SSL_CACERT_BADFILE];
        sitrecAuditWrite('storage.fetch', 'failure',
            in_array(curl_errno($ch), $tlsErrors, true) ? 'tls_error' : 'transport_error');
    }
    $http_status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return [
        'data' => $data,
        'http_status' => $http_status
    ];
}
?>
