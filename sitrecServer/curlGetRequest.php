<?php
require_once __DIR__ . '/audit.php';
// Simple cURL GET helper for the proxies.
//
// Only the headers a caller passes in $extraHeaders go upstream. The browser's
// own request headers are not forwarded by default, Authorization included: most
// callers fetch a third-party host, and browsers attach HTTP Basic credentials to
// every request in a protected realm, so forwarding it would hand a site's
// password to CelesTrak, adsb.lol and the rest. A caller that fetches a source
// the site's operator configured passes curlConfiguredSourceHeaders($url), which
// does forward it. Any other caller that needs upstream auth passes its own
// server-side header in $extraHeaders.
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

/**
 * The headers for a fetch from a source the site's operator set in shared.env
 * (CUSTOM_TLE, CUSTOM_WIND_URL, CURRENT_STARLINK, CURRENT_ACTIVE): the browser's
 * Authorization header, if it sent one. Such a source can sit behind the same
 * sign-on as the site, and without the header it answers with a login page. The
 * operator chose the host, so the credential goes nowhere they did not pick.
 *
 * CelesTrak is the exception. It needs no credential, and it is the default and
 * the sample value of these settings, so an unedited install must not send it one.
 *
 * This forwarding is a requirement, not a leftover: see SR-17 in
 * docs/dev/SecurityRequirements.md. 2.183.6 removed it because nothing seemed to need
 * it, and a custom satellite source then failed with "returned HTML instead of TLE
 * data". The public site has no such source, so its checks cannot show that failure:
 * a clean production run is not evidence that this can go. To change it, withdraw
 * SR-17 in writing first. tests/serverProxiesCurlAuth.test.js holds the rule in place.
 */
function curlConfiguredSourceHeaders($url) {
    if (strcasecmp((string)parse_url($url, PHP_URL_HOST), 'celestrak.org') === 0) {
        return [];
    }
    $headers = function_exists('getallheaders') ? array_change_key_case(getallheaders(), CASE_LOWER) : [];
    return isset($headers['authorization']) ? ['Authorization: ' . $headers['authorization']] : [];
}

function curlGetRequest($url, $extraHeaders = [], $timeoutSec = null) {
    $ch = curl_init();

    [$totalSec, $connectSec] = curlGetTimeouts($timeoutSec);
    curl_setopt($ch, CURLOPT_TIMEOUT, $totalSec);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, $connectSec);

    if (!empty($extraHeaders)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, array_values($extraHeaders));
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
