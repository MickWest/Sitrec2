<?php
// Simple cURL proxy function to forward requests with Authorization header (if present)
//
// $extraHeaders: optional additional request headers, e.g.
//   ['User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)']
// PHP's cURL sends NO User-Agent unless one is set, and some upstreams reject
// that outright — api.adsb.lol answers 403 to a request with no User-Agent and
// 200 to the identical request with one. Passing none keeps the previous
// behaviour exactly, so existing callers are unaffected.
// $timeoutSec: optional overall and connect timeout. 0 (the default) leaves
// cURL's behaviour unchanged, which for a total timeout means WAIT FOREVER.
//
// That default is dangerous for any endpoint that is POLLED. A stalled upstream
// then holds a PHP-FPM worker for the life of the request; a caller polling every
// few seconds exhausts the worker pool within a minute, and the whole PHP backend
// stops answering — every other Sitrec server feature with it, not just the one
// doing the polling. Observed for real on 2026-08-29 when api.adsb.lol began
// stalling instead of answering. Any new polling proxy should pass a timeout.
function curlGetRequest($url, $extraHeaders = [], $timeoutSec = 0) {
    $ch = curl_init();

    if ($timeoutSec > 0) {
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeoutSec);
        // Connect phase gets a shorter budget: an upstream that will not even
        // complete a TCP handshake is not going to serve a body in time either.
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, min(5, $timeoutSec));
    }

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
    $http_status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return [
        'data' => $data,
        'http_status' => $http_status
    ];
}
?>
