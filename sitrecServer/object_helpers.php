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
 * Uses $s3creds from config.php.
 *
 * @param string $key
 * @return string
 */
function buildDefaultS3ObjectUrl($key) {
    global $s3creds;
    return 'https://' . $s3creds['bucket'] . '.s3.' . $s3creds['region'] . '.amazonaws.com/' . encodeObjectKeyForUrl($key);
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

