<?php
// Simple cURL proxy function to forward requests with Authorization header (if present)
//
// $extraHeaders: optional additional request headers, e.g.
//   ['User-Agent: Sitrec/1.0 (+https://www.metabunk.org/sitrec)']
// PHP's cURL sends NO User-Agent unless one is set, and some upstreams reject
// that outright — api.adsb.lol answers 403 to a request with no User-Agent and
// 200 to the identical request with one. Passing none keeps the previous
// behaviour exactly, so existing callers are unaffected.
function curlGetRequest($url, $extraHeaders = []) {
    $ch = curl_init();

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
