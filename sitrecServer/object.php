<?php

/*
 * Module: Sitrec object resolver endpoint.
 *
 * Responsibilities:
 * - Accept object references in canonical, raw-key, or legacy S3 URL forms.
 * - Normalize and validate references into internal object keys.
 * - Resolve folder references to the latest versioned `.js` file.
 * - Return canonical ref metadata and a concrete fetch URL.
 * - Generate presigned GET URLs in AWS mode (or direct local URLs in filesystem mode).
 */

header('Content-Type: application/json');

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
        header('Access-Control-Allow-Headers: Content-Type');
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/object_helpers.php';

/**
 * Sends a JSON error response and terminates execution.
 *
 * @param int $status HTTP status code.
 * @param string $message Error message.
 * @return void
 */
function jsonError($status, $message) {
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit();
}

/**
 * Builds a direct local-storage URL for an object key (non-AWS mode).
 *
 * @param string $key
 * @return string
 */
function buildLocalObjectUrl($key) {
    global $UPLOAD_URL;
    return rtrim($UPLOAD_URL, '/') . '/' . encodeObjectKeyForUrl($key);
}

/**
 * Builds the same-origin S3 proxy URL for an object key. Used in non-AWS mode
 * when the local mirror is missing a referenced object but S3 credentials are
 * configured.
 *
 * @param string $key
 * @return string
 */
function buildS3ProxyObjectUrl($key) {
    global $APP_URL;
    return rtrim($APP_URL, '/') . '/sitrecServer/s3-proxy.php?key=' . rawurlencode($key);
}

/**
 * Returns true when the given key points at a readable file inside the local
 * upload mirror.
 *
 * @param string $key
 * @return bool
 */
function localObjectExists($key) {
    global $UPLOAD_PATH;
    $path = rtrim($UPLOAD_PATH, '/') . '/' . $key;
    return is_file($path);
}

/**
 * Returns true when S3 credentials are populated enough to round-trip a
 * read through the proxy (bucket + region set). Access keys are not required
 * for public objects.
 *
 * @return bool
 */
function s3ProxyConfigured() {
    global $s3creds;
    return !empty($s3creds['bucket']) && !empty($s3creds['region']);
}

/**
 * Attempts to parse a Sitrec object key from a legacy S3 URL.
 *
 * Supports:
 * - Virtual-hosted style: `https://bucket.s3.region.amazonaws.com/<key>`
 * - Path style: `https://s3.region.amazonaws.com/bucket/<key>`
 *
 * Only returns keys matching `<numericUserId>/...`.
 *
 * @param string $ref
 * @return string|null
 */
function parseLegacyS3Key($ref) {
    $parts = @parse_url($ref);
    if (!$parts || empty($parts['host'])) return null;

    $host = strtolower($parts['host']);
    $path = rawurldecode($parts['path'] ?? '');
    $isS3Host = strpos($host, '.s3.') !== false || $host === 's3.amazonaws.com' || str_starts_with($host, 's3.');
    if (!$isS3Host) return null;

    // Virtual-hosted style: https://bucket.s3.region.amazonaws.com/key
    if (preg_match('#^/\d+/.+#', $path)) {
        return ltrim($path, '/');
    }

    // Path style: https://s3.region.amazonaws.com/bucket/key
    if (preg_match('#^/[^/]+/(\d+/.+)$#', $path, $matches)) {
        return $matches[1];
    }

    return null;
}

/**
 * Normalizes user-supplied `ref` values into a validated Sitrec object key.
 *
 * Accepted input forms:
 * - `sitrec://<key>`
 * - raw key `<userId>/...`
 * - legacy S3 URL containing such a key
 *
 * Validation rejects:
 * - empty values
 * - control chars/backslashes
 * - path traversal segments (`.`/`..`)
 * - keys that do not start with numeric user id
 *
 * @param string $ref
 * @return string|null Normalized decoded key, or null when invalid.
 */
function normalizeRequestedRef($ref) {
    $ref = trim((string)$ref);
    if ($ref === '') return null;

    if (str_starts_with($ref, SITREC_REF_PREFIX)) {
        $key = substr($ref, strlen(SITREC_REF_PREFIX));
    } else {
        $legacyKey = parseLegacyS3Key($ref);
        $key = $legacyKey !== null ? $legacyKey : $ref;
    }

    // Note: do NOT rawurldecode here. $_GET values are already decoded by PHP,
    // and parseLegacyS3Key already decodes the URL path component.
    $key = ltrim($key, '/');

    if ($key === '') return null;
    if (preg_match('/[\x00-\x1f\\\\]/', $key)) return null;
    if (preg_match('#(^|/)\.\.?(/|$)#', $key)) return null;
    if (!preg_match('#^\d+/.+#', $key)) return null;

    return $key;
}

/**
 * Resolves a folder key to the latest `.js` object in that folder.
 *
 * "Latest" is determined lexicographically by filename, matching existing version naming.
 * Works in both local filesystem and AWS S3 modes.
 *
 * @param string $folderKey Key with or without trailing slash.
 * @return string|null Full key including filename, or null when no matching versions exist.
 */
function resolveLatestObjectKey($folderKey) {
    global $useAWS, $UPLOAD_PATH, $s3creds;

    $latestFile = null;
    $folderKey = rtrim($folderKey, '/') . '/';

    if (!$useAWS) {
        $localDir = rtrim($UPLOAD_PATH, '/') . '/' . $folderKey;
        if (is_dir($localDir)) {
            $files = scandir($localDir);
            foreach ($files as $file) {
                if (is_file($localDir . $file) && preg_match('/\.js$/', $file)) {
                    if ($latestFile === null || strcmp($file, $latestFile) > 0) {
                        $latestFile = $file;
                    }
                }
            }
            if ($latestFile !== null) {
                return $folderKey . $latestFile;
            }
        }

        // Fall through to S3 listing when nothing is mirrored locally. This
        // lets sandbox installs (SAVE_TO_S3=false) still resolve folders that
        // only exist upstream, paired with the s3-proxy.php fetch path.
        if (empty($s3creds['accessKeyId']) || empty($s3creds['secretAccessKey'])
            || empty($s3creds['bucket']) || empty($s3creds['region'])) {
            return null;
        }
    }

    require_once __DIR__ . '/vendor/autoload.php';
    $credentials = new Aws\Credentials\Credentials($s3creds['accessKeyId'], $s3creds['secretAccessKey']);
    $s3 = new Aws\S3\S3Client([
        'version' => 'latest',
        'region' => $s3creds['region'],
        'credentials' => $credentials
    ]);

    $objects = $s3->getIterator('ListObjects', [
        'Bucket' => $s3creds['bucket'],
        'Prefix' => $folderKey
    ]);

    foreach ($objects as $object) {
        $candidate = $object['Key'];
        if (!str_starts_with($candidate, $folderKey)) continue;
        $filename = substr($candidate, strlen($folderKey));
        if ($filename === '' || strpos($filename, '/') !== false) continue;
        if (!preg_match('/\.js$/', $filename)) continue;
        if ($latestFile === null || strcmp($filename, $latestFile) > 0) {
            $latestFile = $filename;
        }
    }

    return $latestFile ? $folderKey . $latestFile : null;
}

/**
 * Builds a fetchable URL for a resolved object key.
 *
 * Local mode: returns direct local object URL and no expiry.
 * AWS mode:
 * - public objects return stable unsigned URLs for cache reuse
 * - private objects return presigned GET URLs with expiry
 *
 * @param string $key
 * @return array{url:string,expiresAt:int|null}
 */
function buildResolvedObjectUrl($key) {
    global $useAWS, $s3creds;

    if (!$useAWS) {
        if (!localObjectExists($key) && s3ProxyConfigured()) {
            return [
                'url' => buildS3ProxyObjectUrl($key),
                'expiresAt' => null
            ];
        }
        return [
            'url' => buildLocalObjectUrl($key),
            'expiresAt' => null
        ];
    }

    if (isObjectKeyPublic($key)) {
        return [
            'url' => buildPublicObjectUrl($key),
            'expiresAt' => null
        ];
    }

    require_once __DIR__ . '/vendor/autoload.php';
    $credentials = new Aws\Credentials\Credentials($s3creds['accessKeyId'], $s3creds['secretAccessKey']);
    $s3 = new Aws\S3\S3Client([
        'version' => 'latest',
        'region' => $s3creds['region'],
        'credentials' => $credentials
    ]);

    $cmd = $s3->getCommand('GetObject', [
        'Bucket' => $s3creds['bucket'],
        'Key' => $key
    ]);
    $expirySeconds = getEnvIntSeconds('S3_PRESIGNED_GET_EXPIRY_SECONDS', 1800);
    $request = $s3->createPresignedRequest($cmd, '+' . $expirySeconds . ' seconds');

    return [
        'url' => (string)$request->getUri(),
        'expiresAt' => time() + $expirySeconds
    ];
}

if (!isset($_GET['ref'])) {
    jsonError(400, 'Missing ref parameter');
}

$resolvedKey = normalizeRequestedRef($_GET['ref']);
if ($resolvedKey === null) {
    jsonError(400, 'Invalid ref parameter');
}

if (str_ends_with($resolvedKey, '/')) {
    // Folder resolution turns <userid>/<name>/ into the newest version inside it.
    //
    // For an anonymous caller that is an ENUMERATION ORACLE against the sharing
    // model. A share URL is <userid>/<name>/<version>.js and the VERSION is the
    // capability, but the NAME is not secret: it is human-readable and appears in
    // full in every shared link. Resolving a folder without identity would hand
    // out the current version for any name that can be guessed or read off a
    // shared link, exposing versions the owner never shared - including drafts
    // they replaced.
    //
    // Owners browsing their own sitches need this, so it is allowed for the
    // prefix owner and for admins.
    //
    // Identity is resolved HERE rather than at the top of the file on purpose:
    // the common case is a complete key, which IS the capability and needs no
    // identity, so it must not pay for a forum session lookup on every asset
    // load. user.php (not config.php) because it caches - calling the XenForo
    // resolver twice in one request is known to crash it.
    require_once __DIR__ . '/user.php';
    $userInfo = getUserInfo();
    $callerId = (int)($userInfo['user_id'] ?? 0);
    $ownerId  = (int)explode('/', $resolvedKey, 2)[0];

    if ($callerId === 0 || ($callerId !== $ownerId && !isAdmin($userInfo))) {
        jsonError(403, 'Folder references are only resolvable by their owner. Use the full object key.');
    }

    $latestKey = resolveLatestObjectKey($resolvedKey);
    if ($latestKey === null) {
        jsonError(404, 'No versions found for folder');
    }
    $resolvedKey = $latestKey;
}

$result = buildResolvedObjectUrl($resolvedKey);

echo json_encode([
    'ref' => canonicalObjectRef($resolvedKey),
    'key' => $resolvedKey,
    'shareValue' => $resolvedKey,
    'url' => $result['url'],
    'expiresAt' => $result['expiresAt'],
    'version' => basename($resolvedKey),
]);
