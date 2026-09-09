<?php
// Channel preference is separate from the legacy replace-on-save settings file.
// It deliberately uses the existing private settings namespace and identity.
function channelPreferenceKey($userId) {
    if (!is_int($userId) || $userId <= 0) throw new InvalidArgumentException('Invalid identity');
    return 'settings/' . $userId . '/channel.json';
}

function readChannelPreference($userId) {
    global $useAWS, $s3creds, $UPLOAD_PATH;
    $key = channelPreferenceKey($userId);
    if ($useAWS) {
        require_once __DIR__ . '/s3_client.php';
        try {
            $result = getS3Client()->getObject(['Bucket' => $s3creds['bucket'], 'Key' => $key]);
            $raw = (string)$result['Body'];
        } catch (\Aws\S3\Exception\S3Exception $e) {
            if ($e->getAwsErrorCode() === 'NoSuchKey' || $e->getStatusCode() === 404) return true;
            throw $e;
        }
    } else {
        $path = $UPLOAD_PATH . $key;
        if (!file_exists($path)) return true;
        $raw = file_get_contents($path);
        if ($raw === false) throw new RuntimeException('Preference read failed');
    }
    $value = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    if (!is_array($value) || !is_bool($value['betaProgram'] ?? null)) throw new RuntimeException('Invalid preference');
    return $value['betaProgram'];
}

function writeChannelPreference($userId, $beta) {
    global $useAWS, $s3creds, $UPLOAD_PATH;
    $key = channelPreferenceKey($userId);
    $raw = json_encode(['betaProgram' => $beta], JSON_THROW_ON_ERROR);
    if ($useAWS) {
        require_once __DIR__ . '/s3_client.php';
        $params = ['Bucket' => $s3creds['bucket'], 'Key' => $key,
            'Body' => $raw, 'ContentType' => 'application/json', 'CacheControl' => 'private, no-store'];
        if (!empty($s3creds['acl'])) $params['ACL'] = 'private';
        getS3Client()->putObject($params);
    } else {
        $path = $UPLOAD_PATH . $key;
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new RuntimeException('Preference directory unavailable');
        }
        $temporary = tempnam($directory, '.channel-');
        if ($temporary === false) throw new RuntimeException('Preference write unavailable');
        try {
            chmod($temporary, 0600);
            if (file_put_contents($temporary, $raw, LOCK_EX) === false || !rename($temporary, $path)) {
                throw new RuntimeException('Preference write failed');
            }
        } finally {
            if (file_exists($temporary)) unlink($temporary);
        }
    }
}

function publicChannelManifest($manifest, $appPath) {
    if (($manifest['format'] ?? null) !== 1) throw new RuntimeException('Invalid channel format');
    $output = ['format' => 1, 'betaEnabled' => ($manifest['betaEnabled'] ?? true) === true];
    foreach (['shipped', 'beta'] as $channel) {
        $entry = $manifest[$channel] ?? null;
        if ($channel === 'beta' && $entry === null) { $output[$channel] = null; continue; }
        if (!is_array($entry) || ($entry['channel'] ?? '') !== $channel ||
            !preg_match('/^[a-z0-9][a-z0-9-]{0,95}$/D', $entry['id'] ?? '') ||
            !preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/D', $entry['version'] ?? '') ||
            !is_string($entry['builtAt'] ?? null) || strtotime($entry['builtAt']) === false) {
            throw new RuntimeException('Invalid channel entry');
        }
        $output[$channel] = array_intersect_key($entry, array_flip(['id', 'channel', 'version', 'builtAt']));
        $output[$channel]['assetBase'] = $appPath . 'builds/' . $entry['id'] . '/';
        $output[$channel]['coveredBetaIds'] = array_values(array_filter($entry['coveredBetaIds'] ?? [],
            fn($id) => is_string($id) && preg_match('/^[a-z0-9][a-z0-9-]{0,95}$/D', $id)));
    }
    return $output;
}
