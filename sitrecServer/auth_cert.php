<?php
/*
 * Client certificate authentication for the Sitrec PHP backend.
 *
 * A load balancer or reverse proxy terminates mutual TLS, validates the client
 * certificate chain and its revocation status, and forwards the leaf certificate to
 * PHP - either in a request header carrying the URL-encoded PEM (AWS Application
 * Load Balancer sends X-Amzn-Mtls-Clientcert-Leaf), or through Apache's own
 * SSL_CLIENT_CERT export when Apache terminates TLS itself. This file re-verifies
 * the leaf against a local trust store and maps the identifier it carries to a
 * Sitrec user id and group list through a JSON file.
 *
 * Selected from getUserInfoCustom() in config.php when AUTH_MODE=cert. Every
 * setting is read from the environment; see docs/dev/Installing-and-configuring.md,
 * "Client certificate authentication".
 *
 * resolveCertIdentity() is pure apart from OpenSSL and two file reads (the trust
 * store, read by OpenSSL, and the user map). It takes $_SERVER-shaped and
 * getenv()-shaped arrays so it can be exercised against a throw-away certificate
 * authority (tests/authCertMode.test.js).
 *
 * Nothing here logs or returns the certificate itself. The reason strings are short,
 * fixed tokens with no identifier in them, and the audit line carries a hash prefix
 * of the identifier rather than the identifier.
 */

// Settings and their defaults. Absent and empty are the same for every setting
// except the ones marked "empty = refuse", where both refuse.
const AUTH_CERT_DEFAULTS = [
    'AUTH_CERT_SOURCE'        => 'header',                       // header | apache
    'AUTH_CERT_HEADER'        => 'X-Amzn-Mtls-Clientcert-Leaf',  // header carrying the URL-encoded PEM leaf
    'AUTH_TRUSTED_PROXIES'    => '',                             // empty = refuse every header
    'AUTH_TRUST_STORE'        => '',                             // empty = refuse
    'AUTH_POLICY_OIDS'        => '',                             // empty = no policy check
    'AUTH_ID_SOURCE'          => 'san_principal,cn_suffix',      // first source that yields wins
    'AUTH_ID_PATTERN'         => '^[A-Za-z0-9._-]{3,64}$',       // the identifier must fully match
    'AUTH_USER_MAP'           => '',                             // empty = every identifier refused
    'AUTH_REQUIRE_CLIENT_EKU' => 'true',
];

const AUTH_CERT_CLIENT_EKU = 'TLS Web Client Authentication';

/**
 * Read one setting from an env-shaped array. Absent or empty means the default.
 */
function authCertSetting(array $env, string $key): string
{
    $value = $env[$key] ?? null;
    if ($value === null || $value === false) {
        return AUTH_CERT_DEFAULTS[$key];
    }
    $value = trim((string)$value);
    return $value === '' ? AUTH_CERT_DEFAULTS[$key] : $value;
}

/**
 * Parse a boolean setting. injectEnv.php turns a literal true/false in shared.env into
 * "1" / "" through putenv(), so an empty string is treated as false when the key is
 * present, and only an absent key takes the default.
 */
function authCertFlag(array $env, string $key): bool
{
    $value = $env[$key] ?? null;
    if ($value === null || $value === false) {
        return authCertFlagValue(AUTH_CERT_DEFAULTS[$key]);
    }
    return authCertFlagValue((string)$value);
}

function authCertFlagValue(string $value): bool
{
    return in_array(strtolower(trim($value)), ['1', 'true', 'yes', 'on'], true);
}

/**
 * Split a comma-separated setting into trimmed, non-empty items.
 */
function authCertList(string $value): array
{
    $items = [];
    foreach (explode(',', $value) as $item) {
        $item = trim($item);
        if ($item !== '') {
            $items[] = $item;
        }
    }
    return $items;
}

// ---------------------------------------------------------------------------
// Trusted proxy matching (IPv4 and IPv6, exact addresses and CIDR ranges)
// ---------------------------------------------------------------------------

/**
 * True when $ip lies inside $cidr. $cidr is "address" (exact) or "address/prefix".
 * A malformed entry, or a family mismatch, matches nothing.
 */
function authCertIpInCidr(string $ip, string $cidr): bool
{
    $ipBin = @inet_pton(trim($ip));
    if ($ipBin === false) {
        return false;
    }
    $cidr = trim($cidr);
    $slash = strpos($cidr, '/');
    $network = $slash === false ? $cidr : substr($cidr, 0, $slash);
    $netBin = @inet_pton($network);
    if ($netBin === false || strlen($netBin) !== strlen($ipBin)) {
        return false;
    }
    $bits = strlen($ipBin) * 8;
    if ($slash === false) {
        $prefix = $bits;
    } else {
        $prefixText = substr($cidr, $slash + 1);
        if ($prefixText === '' || !ctype_digit($prefixText)) {
            return false;
        }
        $prefix = (int)$prefixText;
        if ($prefix > $bits) {
            return false;
        }
    }
    $fullBytes = intdiv($prefix, 8);
    if ($fullBytes > 0 && substr($ipBin, 0, $fullBytes) !== substr($netBin, 0, $fullBytes)) {
        return false;
    }
    $restBits = $prefix % 8;
    if ($restBits === 0) {
        return true;
    }
    $mask = (0xFF << (8 - $restBits)) & 0xFF;
    return (ord($ipBin[$fullBytes]) & $mask) === (ord($netBin[$fullBytes]) & $mask);
}

/**
 * True when $ip matches any entry of the comma-separated $list. An empty list
 * matches nothing.
 */
function authCertIpInList(string $ip, string $list): bool
{
    foreach (authCertList($list) as $entry) {
        if (authCertIpInCidr($ip, $entry)) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Certificate extraction
// ---------------------------------------------------------------------------

/**
 * Re-flow whatever PEM shape arrived (URL-decoded header, Apache export with
 * newlines, a proxy export with spaces or tabs for line breaks) into a canonical
 * PEM block. Returns null when there is no certificate block.
 */
function authCertNormalizePem(string $raw): ?string
{
    if (!preg_match('~-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----~s', $raw, $m)) {
        return null;
    }
    $body = preg_replace('~\s+~', '', $m[1]);
    if ($body === '' || $body === null) {
        return null;
    }
    return "-----BEGIN CERTIFICATE-----\n" . chunk_split($body, 64, "\n") . "-----END CERTIFICATE-----\n";
}

/**
 * The $_SERVER key a request header lands under.
 */
function authCertHeaderKey(string $headerName): string
{
    return 'HTTP_' . strtoupper(str_replace('-', '_', trim($headerName)));
}

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

/**
 * Pull the identifier out of the parsed certificate using the first source that
 * yields one. Sources:
 *   san_principal - a principal-name style "user@domain" in the Subject Alternative
 *                   Name (email: or an otherName printed as name::user@domain);
 *                   yields the part before "@"
 *   cn_suffix     - the part of the Common Name after its last "."
 *   cn            - the whole Common Name
 */
function authCertExtractIdentifier(array $parsed, array $sources): ?string
{
    $cn = $parsed['subject']['CN'] ?? null;
    if (is_array($cn)) {
        $cn = end($cn);
    }
    $cn = is_string($cn) ? trim($cn) : '';
    $san = $parsed['extensions']['subjectAltName'] ?? '';
    $san = is_string($san) ? $san : '';

    foreach ($sources as $source) {
        switch (strtolower($source)) {
            case 'san_principal':
                if ($san !== '' && preg_match('~(?:^|[\s,:])([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+~', $san, $m)) {
                    return $m[1];
                }
                break;
            case 'cn_suffix':
                $dot = strrpos($cn, '.');
                if ($dot !== false && $dot < strlen($cn) - 1) {
                    return substr($cn, $dot + 1);
                }
                break;
            case 'cn':
                if ($cn !== '') {
                    return $cn;
                }
                break;
        }
    }
    return null;
}

/**
 * The extended key usages named on the leaf, as printed by OpenSSL.
 */
function authCertExtendedKeyUsages(array $parsed): array
{
    $eku = $parsed['extensions']['extendedKeyUsage'] ?? '';
    return is_string($eku) ? authCertList($eku) : [];
}

/**
 * The certificate policy OIDs on the leaf.
 */
function authCertPolicyOids(array $parsed): array
{
    $text = $parsed['extensions']['certificatePolicies'] ?? '';
    if (!is_string($text) || !preg_match_all('~Policy:\s*([0-9.]+)~', $text, $m)) {
        return [];
    }
    return $m[1];
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

function authCertRefuse(string $reason, array $result): array
{
    $result['user_id'] = 0;
    $result['user_groups'] = [];
    $result['reason'] = $reason;
    return $result;
}

/**
 * Resolve the identity presented by a client certificate.
 *
 * @param array         $server     $_SERVER-shaped: REMOTE_ADDR, the HTTP_* header, or
 *                                  SSL_CLIENT_CERT / SSL_CLIENT_VERIFY
 * @param array         $env        getenv()-shaped: the AUTH_* settings
 * @param callable|null $fileReader function(string $path): string|false, used for the
 *                                  user map; defaults to a guarded file_get_contents
 * @return array ['user_id' => int, 'user_groups' => int[], 'reason' => string,
 *                'identifier' => ?string, 'remote_addr' => ?string]
 *         user_id is 0 and user_groups is [] on every refusal.
 */
function resolveCertIdentity(array $server, array $env, ?callable $fileReader = null): array
{
    $remoteAddr = isset($server['REMOTE_ADDR']) ? (string)$server['REMOTE_ADDR'] : null;
    $result = [
        'user_id'     => 0,
        'user_groups' => [],
        'reason'      => 'ok',
        'identifier'  => null,
        'remote_addr' => $remoteAddr,
    ];

    $source = strtolower(authCertSetting($env, 'AUTH_CERT_SOURCE'));

    // (1) In header mode only a trusted proxy may assert the certificate header.
    //     An empty list trusts nobody.
    if ($source !== 'apache') {
        $proxies = authCertSetting($env, 'AUTH_TRUSTED_PROXIES');
        if ($remoteAddr === null || $proxies === '' || !authCertIpInList($remoteAddr, $proxies)) {
            return authCertRefuse('untrusted_proxy', $result);
        }
    }

    // (2) The certificate is present.
    if ($source === 'apache') {
        if (($server['SSL_CLIENT_VERIFY'] ?? '') !== 'SUCCESS') {
            return authCertRefuse('not_verified_by_server', $result);
        }
        $raw = $server['SSL_CLIENT_CERT'] ?? '';
    } else {
        $raw = $server[authCertHeaderKey(authCertSetting($env, 'AUTH_CERT_HEADER'))] ?? '';
        // The header carries the PEM URL-encoded; rawurldecode leaves "+" alone, which
        // the proxy also leaves unencoded.
        $raw = rawurldecode((string)$raw);
    }
    $pem = is_string($raw) && $raw !== '' ? authCertNormalizePem($raw) : null;
    if ($pem === null) {
        return authCertRefuse('no_certificate', $result);
    }
    // Exactly one certificate. A proxy that appended its header to one the client sent
    // (or a client that sent a chain) yields two blocks, and taking the first would let
    // the sender choose which certificate is examined. Refuse rather than guess.
    if (substr_count($raw, '-----BEGIN CERTIFICATE-----') !== 1) {
        return authCertRefuse('multiple_certificates', $result);
    }

    // (3) It parses.
    $parsed = @openssl_x509_parse($pem);
    if (!is_array($parsed)) {
        return authCertRefuse('certificate_unparseable', $result);
    }

    // (4) It chains to the trust store, for the client purpose.
    $trustStore = authCertSetting($env, 'AUTH_TRUST_STORE');
    if ($trustStore === '' || !is_readable($trustStore)) {
        return authCertRefuse('no_trust_store', $result);
    }
    $now = time();
    $notBefore = (int)($parsed['validFrom_time_t'] ?? 0);
    $notAfter = (int)($parsed['validTo_time_t'] ?? 0);
    $requireEku = authCertFlag($env, 'AUTH_REQUIRE_CLIENT_EKU');
    $ekus = authCertExtendedKeyUsages($parsed);
    $hasClientEku = in_array(AUTH_CERT_CLIENT_EKU, $ekus, true);

    $verified = @openssl_x509_checkpurpose($pem, X509_PURPOSE_SSL_CLIENT, [$trustStore]);
    if ($verified !== true) {
        // OpenSSL folds the validity window and the extended key usage into the same
        // verdict. Name the specific cause when it is one of those, so the audit line
        // says what happened; otherwise the chain itself is untrusted.
        if ($now < $notBefore) {
            return authCertRefuse('not_yet_valid', $result);
        }
        if ($now > $notAfter) {
            return authCertRefuse('expired', $result);
        }
        if (!$hasClientEku && count($ekus) > 0) {
            return authCertRefuse('eku_missing', $result);
        }
        return authCertRefuse('chain_untrusted', $result);
    }

    // (5) Validity window, checked here as well so the verdict never rests on the
    //     chain builder alone.
    if ($now < $notBefore) {
        return authCertRefuse('not_yet_valid', $result);
    }
    if ($now > $notAfter) {
        return authCertRefuse('expired', $result);
    }

    // (6) Extended key usage names client authentication. With the requirement
    //     switched off a leaf with no extended key usage extension is accepted; one
    //     that names other usages only is still refused by the purpose check above.
    if ($requireEku && !$hasClientEku) {
        return authCertRefuse('eku_missing', $result);
    }

    // (7) Certificate policy, when configured: at least one listed OID must be present.
    $wantedPolicies = authCertList(authCertSetting($env, 'AUTH_POLICY_OIDS'));
    if (count($wantedPolicies) > 0) {
        $present = authCertPolicyOids($parsed);
        if (count(array_intersect($wantedPolicies, $present)) === 0) {
            return authCertRefuse('policy_missing', $result);
        }
    }

    // (8) Identifier extraction, then the pattern check.
    $sources = authCertList(authCertSetting($env, 'AUTH_ID_SOURCE'));
    $identifier = authCertExtractIdentifier($parsed, $sources);
    if ($identifier === null || $identifier === '') {
        return authCertRefuse('identifier_missing', $result);
    }
    $result['identifier'] = $identifier;
    $pattern = '~^(?:' . str_replace('~', '\~', authCertSetting($env, 'AUTH_ID_PATTERN')) . ')$~D';
    $matched = @preg_match($pattern, $identifier);
    if ($matched === false) {
        return authCertRefuse('pattern_invalid', $result);
    }
    if ($matched !== 1) {
        return authCertRefuse('identifier_invalid', $result);
    }

    // (9) Map lookup.
    $mapPath = authCertSetting($env, 'AUTH_USER_MAP');
    if ($mapPath === '') {
        return authCertRefuse('no_user_map', $result);
    }
    $reader = $fileReader ?? function (string $path) {
        return is_readable($path) ? file_get_contents($path) : false;
    };
    $mapText = $reader($mapPath);
    if (!is_string($mapText)) {
        return authCertRefuse('no_user_map', $result);
    }
    $map = json_decode($mapText, true);
    if (!is_array($map)) {
        return authCertRefuse('user_map_invalid', $result);
    }
    if (!array_key_exists($identifier, $map)) {
        return authCertRefuse('identifier_unmapped', $result);
    }
    $entry = $map[$identifier];
    $userId = $entry['user_id'] ?? null;
    $groups = $entry['groups'] ?? [];
    if (!is_array($entry) || !is_int($userId) || $userId <= 0 || !is_array($groups)) {
        return authCertRefuse('mapping_invalid', $result);
    }
    foreach ($groups as $group) {
        if (!is_int($group)) {
            return authCertRefuse('mapping_invalid', $result);
        }
    }

    $result['user_id'] = $userId;
    $result['user_groups'] = array_values($groups);
    $result['reason'] = 'ok';
    return $result;
}

/**
 * One-line JSON audit record for error_log(). Carries the outcome, the reason, a
 * sha256 prefix of the identifier (never the identifier), the remote address and
 * the resolved user id.
 */
function authCertLogLine(array $result): string
{
    $identifier = $result['identifier'] ?? null;
    $userId = (int)($result['user_id'] ?? 0);
    return json_encode([
        'auth'              => 'cert',
        'outcome'           => $userId > 0 ? 'accepted' : 'refused',
        'reason'            => (string)($result['reason'] ?? 'ok'),
        'user_id'           => $userId,
        'identifier_sha256' => (is_string($identifier) && $identifier !== '')
            ? substr(hash('sha256', $identifier), 0, 16)
            : null,
        'remote_addr'       => $result['remote_addr'] ?? null,
    ]);
}
