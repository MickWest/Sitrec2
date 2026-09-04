<?php

// Directory to store shortened URLs

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';
sitrecAuditRequest('share.create');
$user_id = getUserID();


// need to be logged in
if ($user_id === 0 ) {
    http_response_code(401);
    exit("Internal Server Error");
}

// SECURITY: Rate limiting - max 10 URLs per minute per user
$rateLimitDir = sys_get_temp_dir() . '/sitrec_shortener_ratelimit/';
if (!is_dir($rateLimitDir)) {
    @mkdir($rateLimitDir, 0755, true);
}
$rateLimitFile = $rateLimitDir . "user_{$user_id}.json";
$now = time();
$rateData = file_exists($rateLimitFile) ? json_decode(file_get_contents($rateLimitFile), true) : null;
if (!$rateData || $now > ($rateData['reset'] ?? 0)) {
    $rateData = ['count' => 0, 'reset' => $now + 60];
}
if ($rateData['count'] >= 10) {
    http_response_code(429);
    exit("Rate limit exceeded. Please wait.");
}
$rateData['count']++;
file_put_contents($rateLimitFile, json_encode($rateData), LOCK_EX);

$queryString = parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
parse_str($queryString, $params);

if (isset($params['url'])) {
    $url = $params['url'];
    if (is_string($url)) sitrecAuditResource($url);

    // SECURITY: Validate URL scheme - only allow http/https
    // Also block javascript: and data: URLs that could be embedded
    $parsedUrl = parse_url($url);
    $scheme = isset($parsedUrl['scheme']) ? strtolower($parsedUrl['scheme']) : '';
    if (!$parsedUrl || !in_array($scheme, ['http', 'https'])) {
        http_response_code(400);
        echo "Only http/https URLs are allowed.";
        exit;
    }
    // SECURITY: Block URLs containing javascript: or data: anywhere (for meta refresh attacks)
    if (preg_match('/javascript:|data:/i', $url)) {
        http_response_code(400);
        echo "Invalid URL content.";
        exit;
    }

    // Check if the URL contains the string "sitRecServer"
    if (strpos($url, 'sitrecServer') !== false) {
        http_response_code(400);
        echo "URL containing 'sitrecServer' is not allowed.";
        exit;
    }

    // Generate a unique code for the URL
    $code = generateUniqueCode($SHORTENER_PATH);

   // $shortURL = $_SERVER['HTTP_HOST'] . '/u/' . $code . '.html';

    $shortURL = $SHORTENER_URL . $code . '.html';

    $html = createRedirectHtml($url);

    // Save the URL to the filesystem
    if (file_put_contents($SHORTENER_PATH . $code . '.html', $html, LOCK_EX) === false) {
        http_response_code(500);
        exit('Share link could not be saved');
    }
    sitrecAuditResult();

    // Return the shortened URL to the client
    echo $shortURL;
} else {
    http_response_code(400);
    echo "Please provide a URL to shorten.";
}


function createRedirectHtml($url) {
    // SECURITY: Properly escape URL to prevent XSS
    $safeUrl = htmlspecialchars($url, ENT_QUOTES, 'UTF-8');
    return '<html><head><meta http-equiv="refresh" content="0;url=' . $safeUrl . '"></head></html>';
}

function generateRandomCode($length = 6) {
    $characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    $charactersLength = strlen($characters);
    $randomString = '';
    for ($i = 0; $i < $length; $i++) {
        // SECURITY: Use cryptographically secure random
        $randomString .= $characters[random_int(0, $charactersLength - 1)];
    }
    return $randomString;
}

function generateUniqueCode($SHORTENER_PATH) {
    do {
        $code = generateRandomCode();
    } while (file_exists($SHORTENER_PATH . $code));
    return $code;
}
