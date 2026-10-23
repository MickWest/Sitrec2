<?php
/*
 * Shared helpers for Sitrec object-reference handling.
 *
 * Included by object.php, rehost.php, and getsitches.php to ensure
 * consistent env-reading, visibility policy, URL encoding, and
 * canonical-ref generation across all endpoints.
 */

if (!defined('SITREC_REF_PREFIX')) {
    define('SITREC_REF_PREFIX', 'sitrec://');
}

// s3ObjectUrl() and the client factory. s3_client.php includes this file back for
// encodeObjectKeyForUrl(); both use require_once, so either may be loaded first.
require_once __DIR__ . '/s3_client.php';

/**
 * Reads an integer seconds value from environment with fallback validation.
 *
 * @param string $name Environment variable name.
 * @param int $default Fallback value when env var is missing/empty/invalid.
 * @return int Positive integer number of seconds.
 */
function getEnvIntSeconds($name, $default) {
    $value = getenv($name);
    if ($value === false || $value === '') return $default;
    $intValue = intval($value);
    return $intValue > 0 ? $intValue : $default;
}

/**
 * Reads a string environment variable with fallback.
 *
 * @param string $name
 * @param string $default
 * @return string
 */
function getEnvString($name, $default = '') {
    $value = getenv($name);
    if ($value === false) return $default;
    $value = trim((string)$value);
    return $value === '' ? $default : $value;
}

/**
 * Parses a comma-separated environment variable into normalized object-key prefixes.
 *
 * @param string $name
 * @return array<int,string>
 */
function getEnvPrefixList($name) {
    $raw = getEnvString($name, '');
    if ($raw === '') return [];

    $parts = explode(',', $raw);
    $prefixes = [];
    foreach ($parts as $part) {
        $prefix = rawurldecode(trim($part));
        $prefix = ltrim($prefix, '/');
        if ($prefix === '') continue;
        $prefixes[] = $prefix;
    }
    return $prefixes;
}

/**
 * Checks whether an object key matches a configured prefix.
 *
 * A prefix without trailing `/` matches either exact key or descendant path.
 *
 * @param string $key
 * @param string $prefix
 * @return bool
 */
function objectKeyMatchesPrefix($key, $prefix) {
    if ($prefix === '') return false;
    if (str_ends_with($prefix, '/')) {
        return str_starts_with($key, $prefix);
    }
    return $key === $prefix || str_starts_with($key, $prefix . '/');
}

/**
 * Checks whether an object key matches any prefix in a list.
 *
 * @param string $key
 * @param array<int,string> $prefixes
 * @return bool
 */
function objectKeyMatchesAnyPrefix($key, $prefixes) {
    foreach ($prefixes as $prefix) {
        if (objectKeyMatchesPrefix($key, $prefix)) {
            return true;
        }
    }
    return false;
}

/**
 * Determines whether a key should be treated as public for read resolution.
 *
 * Policy:
 * - `S3_DEFAULT_VISIBILITY=public|private` (default: `public`)
 * - `S3_PRIVATE_PREFIXES` applies when default is `public`
 * - `S3_PUBLIC_PREFIXES` applies when default is `private`
 *
 * @param string $key
 * @return bool
 */
function isObjectKeyPublic($key) {
    $defaultVisibility = strtolower(getEnvString('S3_DEFAULT_VISIBILITY', 'public'));
    if ($defaultVisibility !== 'public' && $defaultVisibility !== 'private') {
        $defaultVisibility = 'public';
    }

    if ($defaultVisibility === 'public') {
        $privatePrefixes = getEnvPrefixList('S3_PRIVATE_PREFIXES');
        return !objectKeyMatchesAnyPrefix($key, $privatePrefixes);
    }

    $publicPrefixes = getEnvPrefixList('S3_PUBLIC_PREFIXES');
    return objectKeyMatchesAnyPrefix($key, $publicPrefixes);
}

/**
 * True when object reads must stay on the application's own origin (S3_READS_VIA_SERVER):
 * the server streams every object through s3-proxy.php instead of handing the browser a
 * storage URL, presigned or public. For deployments whose browsers cannot reach the
 * storage endpoint at all. Off unless set, so existing deployments are unchanged.
 *
 * @param array|null $env Optional env map (tests); getenv() otherwise.
 * @return bool
 */
function s3ReadsViaServer($env = null) {
    $value = ($env === null) ? getenv('S3_READS_VIA_SERVER') : ($env['S3_READS_VIA_SERVER'] ?? false);
    if ($value === false || $value === null || $value === '') return false;
    if ($value === true) return true;
    return in_array(strtolower(trim((string)$value)), ['1', 'true', 'yes', 'on'], true);
}

/**
 * The same-origin read URL for an object key: s3-proxy.php on this application, which
 * streams the object with the server's own credentials.
 *
 * @param string $key
 * @param string|null $appUrl Optional base (tests); the global $APP_URL from config_paths.php otherwise.
 * @return string
 */
function buildServerObjectUrl($key, $appUrl = null) {
    if ($appUrl === null) {
        global $APP_URL;
        $appUrl = $APP_URL;
    }
    return rtrim((string)$appUrl, '/') . '/sitrecServer/s3-proxy.php?key=' . rawurlencode($key);
}

/**
 * The type headers s3-proxy.php sends for an object, decided from the key's extension only.
 *
 * The stored Content-Type is never used. A presigned PUT does not sign it, so the uploader
 * chooses it, and passing it through would let an upload be served as HTML, SVG or XML that
 * runs script on this application's origin. Images, video and audio get their real types.
 * Text data (sitch .js, JSON, KML, CSV, TLE, SRT) gets text/plain or application/json, never
 * a type the browser renders as a document or runs as script. Everything else, including a
 * key with no extension, is application/octet-stream.
 *
 * Every type that is not image, video or audio is also sent as an attachment, so opening the
 * URL downloads it. fetch() ignores Content-Disposition, so Sitrec's own loading is unchanged.
 *
 * @param string $key Object key.
 * @return array<string,string> Header name => value, Content-Type first.
 */
function objectProxyContentHeaders($key) {
    static $MEDIA_TYPES = [
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
        'webp' => 'image/webp', 'bmp' => 'image/bmp', 'tif' => 'image/tiff', 'tiff' => 'image/tiff',
        'heic' => 'image/heic', 'heif' => 'image/heif',
        'mp4' => 'video/mp4', 'm4v' => 'video/mp4', 'mp4v' => 'video/mp4', 'mov' => 'video/quicktime',
        'webm' => 'video/webm', 'avi' => 'video/x-msvideo', 'mpg' => 'video/mpeg', 'mpeg' => 'video/mpeg',
        'm1v' => 'video/mpeg', 'm2v' => 'video/mpeg', 'ts' => 'video/mp2t', 'm2ts' => 'video/mp2t',
        'mts' => 'video/mp2t',
        'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg',
        'flac' => 'audio/flac', 'aac' => 'audio/aac', 'aif' => 'audio/aiff', 'aiff' => 'audio/aiff',
        'caf' => 'audio/x-caf',
    ];
    static $TEXT_TYPES = [
        'json' => 'application/json; charset=utf-8', 'geojson' => 'application/json; charset=utf-8',
        'js' => 'text/plain; charset=utf-8', 'kml' => 'text/plain; charset=utf-8',
        'ksv' => 'text/plain; charset=utf-8', 'xml' => 'text/plain; charset=utf-8',
        'csv' => 'text/plain; charset=utf-8', 'txt' => 'text/plain; charset=utf-8',
        'tle' => 'text/plain; charset=utf-8', '2le' => 'text/plain; charset=utf-8',
        '3le' => 'text/plain; charset=utf-8', 'srt' => 'text/plain; charset=utf-8',
    ];

    // The extension of the last path segment, so a dot in a folder name does not count.
    $segments = explode('/', (string)$key);
    $name = end($segments);
    $ext = preg_match('/\.([A-Za-z0-9]+)\z/', $name, $m) ? strtolower($m[1]) : '';

    if (isset($MEDIA_TYPES[$ext])) {
        return ['Content-Type' => $MEDIA_TYPES[$ext], 'X-Content-Type-Options' => 'nosniff'];
    }
    return [
        'Content-Type' => $TEXT_TYPES[$ext] ?? 'application/octet-stream',
        'Content-Disposition' => 'attachment',
        'X-Content-Type-Options' => 'nosniff',
    ];
}

/**
 * URL-encodes each path segment of an object key while preserving `/` separators.
 *
 * @param string $key
 * @return string
 */
function encodeObjectKeyForUrl($key) {
    $segments = explode('/', $key);
    $encoded = array_map(fn($segment) => rawurlencode($segment), $segments);
    return implode('/', $encoded);
}

/**
 * Converts an object key to canonical Sitrec ref format.
 *
 * @param string $key
 * @return string
 */
function canonicalObjectRef($key) {
    return SITREC_REF_PREFIX . $key;
}

/**
 * Builds the canonical S3 bucket URL for an object key.
 * Bucket from $s3creds (config.php); host, endpoint and key encoding from
 * s3ObjectUrl() in s3_client.php.
 *
 * @param string $key
 * @return string
 */
function buildDefaultS3ObjectUrl($key) {
    global $s3creds;
    return s3ObjectUrl((string)($s3creds['bucket'] ?? ''), $key);
}

/**
 * Builds a public unsigned URL for an object key.
 *
 * If `S3_PUBLIC_BASE_URL` is set, that base is used (e.g. CloudFront/custom CDN domain).
 * Otherwise falls back to bucket virtual-hosted S3 URL.
 *
 * @param string $key
 * @return string
 */
function buildPublicObjectUrl($key) {
    $publicBase = getEnvString('S3_PUBLIC_BASE_URL', '');
    if ($publicBase !== '') {
        return rtrim($publicBase, '/') . '/' . encodeObjectKeyForUrl($key);
    }
    return buildDefaultS3ObjectUrl($key);
}

/**
 * Is this filename a sitch preview screenshot?
 *
 * Screenshots used to use the single fixed name "screenshot.jpg". Because stored
 * objects are public-read and the sitch NAME appears in full in every shared
 * link, that made <userid>/<name>/screenshot.jpg reachable with no version at
 * all - so sharing one version exposed the screenshot of whatever the owner had
 * saved most recently. Each screenshot now carries its own unguessable token:
 * screenshot_<token>.jpg.
 *
 * BOTH forms must be recognised: the legacy name still exists for every sitch
 * saved before the change, and neither form may ever be mistaken for a saved
 * version by the listing code.
 */
function isScreenshotFile($filename) {
    return (bool)preg_match('/^screenshot(_[A-Za-z0-9_]+)?\.jpg$/', (string)$filename);
}

/**
 * Newest screenshot filename from the files in one sitch folder, or null if none.
 *
 * "Newest" is lexicographic, matching the token format (timestamp first) and the
 * same rule used for versions. The legacy "screenshot.jpg" sorts BEFORE every
 * tokenised name ('.' is 0x2E, '_' is 0x5F), so a tokenised screenshot always
 * wins when both are present - which is what we want during the transition.
 */
function newestScreenshotName($filenames) {
    $best = null;
    foreach ($filenames as $f) {
        $f = (string)$f;
        if (!isScreenshotFile($f)) continue;
        if ($best === null || strcmp($f, $best) > 0) $best = $f;
    }
    return $best;
}

