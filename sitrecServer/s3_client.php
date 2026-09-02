<?php
/*
 * Module: Sitrec S3 client factory.
 *
 * The one place that turns the S3_* environment into an Aws\S3\S3Client, so every
 * endpoint (rehost, object, getsitches, settings, metadata, the admin pages and the
 * object proxy) builds the client the same way. It covers:
 *
 * - Static keys (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY): the default whenever both
 *   are set, and exactly what every existing deployment does today.
 * - Role credentials (S3_CREDENTIAL_SOURCE=role): no keys in the configuration at all;
 *   the SDK's default provider chain supplies them (instance or container role, the
 *   AWS_* environment, a shared profile).
 * - Anonymous (S3_CREDENTIAL_SOURCE=anonymous, or no keys and no source): the SDK is
 *   only ever used for unsigned URL building; callers that need to sign skip S3.
 * - FIPS endpoints (S3_USE_FIPS), and a custom endpoint (S3_ENDPOINT, S3_USE_PATH_STYLE)
 *   for another AWS partition, an isolated deployment or an S3-compatible store.
 *
 * buildS3ClientConfig() is pure - no SDK, no globals - so it is unit-tested from Jest
 * through a PHP harness (tests/s3ClientConfig.test.js). getS3Client() reads the
 * environment (after injectEnv.php has run, i.e. after config.php) and memoises the
 * client for the rest of the request.
 */

require_once __DIR__ . '/object_helpers.php';

/**
 * Environment names buildS3ClientConfig() understands. Kept in one list so the
 * process-env reader and the tests agree on what is consulted.
 */
const S3_CLIENT_ENV_NAMES = [
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_USE_FIPS',
    'S3_ENDPOINT',
    'S3_USE_PATH_STYLE',
    'S3_CREDENTIAL_SOURCE',
];

/**
 * Reads one string setting from an env map. A missing entry (or getenv()'s `false`)
 * is null; everything else is trimmed to a string. injectEnv.php turns an unquoted
 * `true`/`false` into a PHP bool before putenv(), which getenv() then hands back as
 * "1" or "", so bools are normalised the same way here.
 *
 * @param array $env
 * @param string $name
 * @return string|null
 */
function s3EnvValue(array $env, $name) {
    if (!array_key_exists($name, $env)) return null;
    $value = $env[$name];
    if ($value === null || $value === false) return null;
    if ($value === true) return '1';
    return trim((string)$value);
}

/**
 * Reads one boolean setting from an env map.
 *
 * - missing, or an unrecognised word: null (the caller applies its default)
 * - "1", "true", "yes", "on": true
 * - "", "0", "false", "no", "off": false  ("" is how an unquoted `false` arrives
 *   through injectEnv.php, see s3EnvValue)
 *
 * @param array $env
 * @param string $name
 * @return bool|null
 */
function s3EnvFlag(array $env, $name) {
    $value = s3EnvValue($env, $name);
    if ($value === null) return null;
    $value = strtolower($value);
    if (in_array($value, ['1', 'true', 'yes', 'on'], true)) return true;
    if (in_array($value, ['', '0', 'false', 'no', 'off'], true)) return false;
    return null;
}

/**
 * Builds the Aws\S3\S3Client constructor array from an env map. Pure: no SDK
 * classes, no getenv(), no globals.
 *
 * Returned keys:
 * - version, region: always
 * - use_fips_endpoint: always (bool)
 * - endpoint, use_path_style_endpoint: only when S3_ENDPOINT is set; path style
 *   defaults to true for a custom endpoint unless S3_USE_PATH_STYLE is false
 * - credentials: `['static', key, secret]` marker for static keys (turned into an
 *   Aws\Credentials\Credentials by createS3Client), `false` for anonymous, and
 *   ABSENT for role credentials so the SDK runs its default provider chain
 * - credentialSource: 'static' | 'role' | 'anonymous', for callers; stripped before
 *   the array reaches the SDK
 *
 * S3_CREDENTIAL_SOURCE unset means: static when both keys are present, otherwise
 * anonymous. That is exactly the pre-existing behaviour, so an install that has no
 * keys (a local checkout fetching public regression sitches through s3-proxy.php)
 * keeps working and never probes for role credentials. Role credentials are an
 * explicit opt-in.
 *
 * @param array $env Map of S3_* names to values (see S3_CLIENT_ENV_NAMES).
 * @return array
 * @throws InvalidArgumentException on an unrecognised S3_CREDENTIAL_SOURCE.
 */
function buildS3ClientConfig(array $env) {
    $region = (string)(s3EnvValue($env, 'S3_REGION') ?? '');

    $config = [
        'version' => 'latest',
        'region' => $region,
    ];

    $useFips = s3EnvFlag($env, 'S3_USE_FIPS');
    if ($useFips === null) {
        $useFips = str_starts_with($region, 'us-gov-');
    }
    $config['use_fips_endpoint'] = $useFips;

    $endpoint = (string)(s3EnvValue($env, 'S3_ENDPOINT') ?? '');
    if ($endpoint !== '') {
        $config['endpoint'] = $endpoint;
        $config['use_path_style_endpoint'] = s3EnvFlag($env, 'S3_USE_PATH_STYLE') ?? true;
    }

    $key = (string)(s3EnvValue($env, 'S3_ACCESS_KEY_ID') ?? '');
    $secret = (string)(s3EnvValue($env, 'S3_SECRET_ACCESS_KEY') ?? '');
    $haveStaticKeys = $key !== '' && $secret !== '';

    $source = strtolower((string)(s3EnvValue($env, 'S3_CREDENTIAL_SOURCE') ?? ''));
    if ($source === '') {
        $source = $haveStaticKeys ? 'static' : 'anonymous';
    } elseif ($source === 'static' && !$haveStaticKeys) {
        // "static" with a key missing is what the old per-endpoint gates refused
        // with 503 / skip; anonymous reproduces that.
        $source = 'anonymous';
    }

    switch ($source) {
        case 'static':
            $config['credentials'] = ['static', $key, $secret];
            break;
        case 'role':
            // No credentials entry: the SDK's default provider chain runs.
            break;
        case 'anonymous':
            $config['credentials'] = false;
            break;
        default:
            throw new InvalidArgumentException(
                "S3_CREDENTIAL_SOURCE must be static, role or anonymous (got '$source')"
            );
    }
    $config['credentialSource'] = $source;

    return $config;
}

/**
 * Collects the S3_* settings from the process environment (populated by
 * injectEnv.php) into the map buildS3ClientConfig() takes.
 *
 * @return array
 */
function s3EnvFromProcess() {
    $env = [];
    foreach (S3_CLIENT_ENV_NAMES as $name) {
        $value = getenv($name);
        if ($value !== false) {
            $env[$name] = $value;
        }
    }
    return $env;
}

/**
 * The resolved client configuration for this process, memoised.
 *
 * @return array
 */
function s3ProcessConfig() {
    static $config = null;
    if ($config === null) {
        $config = buildS3ClientConfig(s3EnvFromProcess());
    }
    return $config;
}

/**
 * Constructs an S3Client from a buildS3ClientConfig() array. Loads the SDK.
 *
 * @param array $config
 * @return Aws\S3\S3Client
 */
function createS3Client(array $config) {
    require_once __DIR__ . '/vendor/autoload.php';

    unset($config['credentialSource']);
    if (isset($config['credentials']) && is_array($config['credentials'])
        && ($config['credentials'][0] ?? null) === 'static') {
        $config['credentials'] = new Aws\Credentials\Credentials(
            $config['credentials'][1],
            $config['credentials'][2]
        );
    }

    return new Aws\S3\S3Client($config);
}

/**
 * The S3 client for this request, built once from the environment.
 *
 * Callers must have included config.php (which runs injectEnv.php) first, the
 * same precondition the old inline constructions had.
 *
 * @return Aws\S3\S3Client
 */
function getS3Client() {
    static $client = null;
    if ($client === null) {
        $client = createS3Client(s3ProcessConfig());
    }
    return $client;
}

/**
 * Whether requests can be signed: true for static keys and role credentials,
 * false for anonymous. Replaces the old "is the static key empty?" gates.
 *
 * @return bool
 */
function s3HasCredentials() {
    return s3ProcessConfig()['credentialSource'] !== 'anonymous';
}

/**
 * Host of the configured custom endpoint (S3_ENDPOINT), lower-cased, or '' when
 * the deployment uses the standard endpoints.
 *
 * @return string
 */
function s3ConfiguredEndpointHost() {
    $config = s3ProcessConfig();
    if (empty($config['endpoint'])) return '';
    $parts = @parse_url($config['endpoint']);
    return strtolower((string)($parts['host'] ?? ''));
}

/**
 * The canonical unsigned URL for an object.
 *
 * For the plain case - no FIPS endpoint, no custom endpoint - this returns the
 * exact string form Sitrec has always produced, `https://<bucket>.s3.<region>.amazonaws.com/<key>`
 * with each key segment rawurlencode'd. That form is kept deliberately, not routed
 * through the SDK, so the URLs handed out by existing deployments stay byte-identical
 * (they are cached, shared and compared by clients). tests/s3ClientConfig.test.js
 * checks that the SDK would produce the same string, so the two forms cannot drift
 * unnoticed. Every other case (FIPS, custom endpoint) asks the SDK, which resolves the
 * endpoint for the region, partition and options without a network call.
 *
 * @param string $bucket
 * @param string $key
 * @return string
 */
function s3ObjectUrl($bucket, $key) {
    $config = s3ProcessConfig();
    $plain = !$config['use_fips_endpoint'] && !isset($config['endpoint']);
    if ($plain) {
        return 'https://' . $bucket . '.s3.' . $config['region'] . '.amazonaws.com/' . encodeObjectKeyForUrl($key);
    }
    return getS3Client()->getObjectUrl($bucket, $key);
}
