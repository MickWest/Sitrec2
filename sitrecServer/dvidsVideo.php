<?php
/**
 * Resolve a public DVIDS video page to its MP4 source URL.
 *
 * DVIDS video pages do not currently send CORS headers, so browser-side fetch
 * cannot always inspect the page HTML. This endpoint is deliberately narrow:
 * it only accepts dvidshub.net /video/ URLs and only returns an MP4 URL found
 * in that page.
 */

require_once __DIR__ . '/config.php';

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit();
}

header("Content-Type: application/json; charset=utf-8");

function dvids_json_error($status, $message) {
    http_response_code($status);
    echo json_encode(["error" => $message]);
    exit();
}

function decode_html_url($url) {
    return html_entity_decode($url, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

function fetch_dvids_page($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; Sitrec DVIDS resolver)',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
        ],
    ]);

    if (defined('CURL_IPRESOLVE_V4')) {
        curl_setopt($ch, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    }

    $data = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    return [
        'data' => $data,
        'http_status' => $status,
        'error' => $error,
    ];
}

$pageUrl = $_GET['url'] ?? '';
if (!is_string($pageUrl) || $pageUrl === '') {
    dvids_json_error(400, "Missing url");
}

$parts = parse_url($pageUrl);
$host = strtolower($parts['host'] ?? '');
$path = $parts['path'] ?? '';

if (($parts['scheme'] ?? '') !== 'https') {
    dvids_json_error(400, "Only https DVIDS URLs are supported");
}

if ($host !== 'www.dvidshub.net' && $host !== 'dvidshub.net') {
    dvids_json_error(400, "Only dvidshub.net URLs are supported");
}

if (!preg_match('#^/video/(embed/)?\d+(/|$)#', $path)) {
    dvids_json_error(400, "URL is not a DVIDS video page");
}

$clientIP = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rateLimitDir = sys_get_temp_dir() . '/sitrec_dvids_video_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . md5($clientIP) . ".json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 20) {
    dvids_json_error(429, "Rate limit exceeded. Please wait.");
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

$result = fetch_dvids_page($pageUrl);
if (($result['http_status'] ?? 0) < 200 || ($result['http_status'] ?? 0) >= 300) {
    $errorDetail = $result['error'] ? " (" . $result['error'] . ")" : "";
    dvids_json_error(502, "DVIDS returned HTTP " . ($result['http_status'] ?? 0) . $errorDetail);
}

$html = $result['data'] ?? '';
if (!is_string($html) || $html === '') {
    dvids_json_error(502, "Empty DVIDS response");
}

$videoUrl = null;
if (preg_match_all('/<source\b[^>]*\bsrc\s*=\s*(["\'])(.*?)\1[^>]*>/i', $html, $matches, PREG_SET_ORDER)) {
    foreach ($matches as $match) {
        $tag = $match[0];
        $src = decode_html_url(trim($match[2]));
        if (preg_match('/\.mp4([?#]|$)/i', $src) || preg_match('/\btype\s*=\s*(["\'])[^"\']*video\/mp4/i', $tag)) {
            $videoUrl = $src;
            break;
        }
    }
}

if (!$videoUrl && preg_match('/https?:\/\/[^"\'<>\s]+\.mp4(\?[^"\'<>\s]*)?/i', $html, $match)) {
    $videoUrl = decode_html_url($match[0]);
}

if (!$videoUrl) {
    dvids_json_error(404, "No MP4 source found on DVIDS page");
}

if (strpos($videoUrl, '//') === 0) {
    $videoUrl = 'https:' . $videoUrl;
} elseif (strpos($videoUrl, '/') === 0) {
    $videoUrl = 'https://www.dvidshub.net' . $videoUrl;
}

$videoParts = parse_url($videoUrl);
if (($videoParts['scheme'] ?? '') !== 'https' || !preg_match('/\.mp4$/i', $videoParts['path'] ?? '')) {
    dvids_json_error(502, "Resolved source is not an HTTPS MP4 URL");
}

echo json_encode([
    "videoUrl" => $videoUrl,
    "pageUrl" => $pageUrl,
]);
?>
