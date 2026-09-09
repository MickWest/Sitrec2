<?php
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: private, no-store');
header('Vary: Cookie');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/user.php';
require_once __DIR__ . '/channel_preferences.php';
sitrecAuditRequest(($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? 'channel.write' : 'channel.read');

try {
    $path = getenv('SITREC_CHANNEL_MANIFEST');
    if (!$path || !is_file($path)) {
        echo json_encode(['enabled' => false]);
        exit;
    }
    $appPath = rtrim(parse_url($APP_URL, PHP_URL_PATH) ?: '/', '/') . '/';
    $manifest = publicChannelManifest(json_decode(file_get_contents($path), true, 32, JSON_THROW_ON_ERROR), $appPath);
    $userId = (int)getUserID();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'POST') {
        if ($userId <= 0) { http_response_code(401); echo json_encode(['error' => 'Login required']); exit; }
        // JSON plus a custom header prevents cross-site form writes. Browsers do
        // not receive CORS permission for this endpoint. Also verify Origin using
        // the configured canonical app URL, not a forwarded host supplied by a client.
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $configured = parse_url($APP_URL);
        $expected = ($configured['scheme'] ?? 'https') . '://' . ($configured['host'] ?? '') .
            (isset($configured['port']) ? ':' . $configured['port'] : '');
        if ($origin !== $expected || ($_SERVER['HTTP_X_SITREC_CHANNEL'] ?? '') !== '1' ||
            strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
            http_response_code(403); echo json_encode(['error' => 'Invalid request origin']); exit;
        }
        $raw = file_get_contents('php://input', false, null, 0, 1025);
        $input = strlen($raw) <= 1024 ? json_decode($raw, true) : null;
        if (!is_array($input) || !is_bool($input['betaProgram'] ?? null) || count($input) !== 1) {
            http_response_code(400); echo json_encode(['error' => 'Expected betaProgram boolean']); exit;
        }
        writeChannelPreference($userId, $input['betaProgram']);
        sitrecAuditResult();
        echo json_encode(['betaProgram' => $input['betaProgram'], 'userID' => $userId]);
        exit;
    }
    if ($method !== 'GET') {
        http_response_code(405); header('Allow: GET, POST'); echo json_encode(['error' => 'Method not allowed']); exit;
    }
    $preference = false;
    $available = true;
    try { if ($userId > 0) $preference = readChannelPreference($userId); }
    catch (Throwable $e) { $available = false; }
    sitrecAuditResult();
    echo json_encode(['enabled' => true, 'manifest' => $manifest, 'userID' => $userId,
        'betaProgram' => $preference, 'preferenceAvailable' => $available]);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Channel selection unavailable']);
}
