<?php
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/user.php';
require_once __DIR__ . '/input_recording.php';
require_once __DIR__ . '/rate_limit.php';

// Authenticate independently of the client's user id and the admin test override.
$identity = getCachedUserInfoCustom();
if (!inputRecordingAllowed($identity)) {
    http_response_code(403);
    echo json_encode(['error' => 'Recording is not authorized']);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'POST required']);
    exit;
}
// sendBeacon cannot supply a custom CSRF header. Its Origin is browser-controlled;
// require it and never grant CORS access to another site.
$url = parse_url($APP_URL);
$origin = ($url['scheme'] ?? 'https') . '://' . ($url['host'] ?? '') . (isset($url['port']) ? ':' . $url['port'] : '');
if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
    http_response_code(403);
    echo json_encode(['error' => 'Invalid request origin']);
    exit;
}
if (!inputRecordingConfigured($identity)) {
    echo json_encode(['disabled' => true]);
    exit;
}
if (!sitrecConsumeRateToken('input_recording', 120, 60, $resetAt)) {
    http_response_code(429);
    header('Retry-After: ' . max(1, $resetAt - time()));
    echo json_encode(['error' => 'Recording rate limit']);
    exit;
}
$raw = file_get_contents('php://input', false, null, 0, 65537);
if (strlen($raw) > 65536) {
    http_response_code(413);
    echo json_encode(['error' => 'Recording batch too large']);
    exit;
}
try {
    $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    $result = appendInputRecording($data, (int)$identity['user_id'], (int)getUserInfo()['user_id']);
    echo json_encode($result);
} catch (JsonException | InvalidArgumentException $e) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid recording batch']);
} catch (Throwable $e) {
    error_log('Input recording: ' . $e->getMessage());
    http_response_code(503);
    echo json_encode(['error' => 'Recording storage unavailable']);
}
