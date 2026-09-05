<?php
/**
 * User Settings API
 *
 * Handles loading and saving user settings.
 * Settings are stored as JSON files in the format: settings/<userID>.json
 *
 * When SAVE_TO_S3 is enabled, uses S3 storage.
 * Otherwise, uses local filesystem at $UPLOAD_PATH/settings/<userID>.json
 *
 * GET request: Fetch user settings
 * POST request: Save user settings
 *
 * Falls back gracefully if storage is unavailable or user is not logged in.
 */

require('./user.php');
require_once __DIR__ . '/s3_client.php';
sitrecAuditRequest(($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' ? 'settings.write' : 'settings.read');

header('Content-Type: application/json');

$user_id = getUserID();
sitrecAuditResource('settings/' . $user_id);

global $useAWS, $s3creds, $UPLOAD_PATH;

if ($useAWS) {
    if (!isset($s3creds) || !is_array($s3creds) ||
       !isset($s3creds['region']) ||
       !isset($s3creds['bucket']) ||
        !s3HasCredentials()
    ) {
        http_response_code(503);
        echo json_encode(['error' => 'S3 credentials incomplete']);
        exit();
    }
}

// If user is not logged in, return error
if ($user_id == 0) {
    http_response_code(401);
    echo json_encode(['error' => 'Not logged in', 'userID' => 0]);
    exit();
}

// Initialize S3 client
function startS3() {
    global $s3creds;

    $aws = $s3creds;

    $s3 = getS3Client();
    
    return ['s3' => $s3, 'aws' => $aws];
}

// Sanitize settings to prevent exploits
// NOTE: When adding new settings, you must update BOTH:
//   1. This function (settings.php)
//   2. sanitizeSettings() in SettingsManager.js
function sanitizeSettings($settings) {
    if (!is_array($settings)) {
        return [];
    }
    
    $sanitized = [];
    
    // Only allow specific known settings with type checking
    if (isset($settings['maxDetails'])) {
        $maxDetails = floatval($settings['maxDetails']);
        // Clamp to valid range
        $sanitized['maxDetails'] = max(5, min(30, $maxDetails));
    }
    
    if (isset($settings['fpsLimit'])) {
        $fpsLimit = intval($settings['fpsLimit']);
        // Only allow specific allowed values
        $allowedValues = [60, 30, 20, 15];
        if (in_array($fpsLimit, $allowedValues)) {
            $sanitized['fpsLimit'] = $fpsLimit;
        }
    }
    
    if (isset($settings['videoMaxSize'])) {
        $videoMaxSize = strval($settings['videoMaxSize']);
        // Only allow specific allowed values
        $allowedValues = ['None', '1080P', '720P', '480P', '360P'];
        if (in_array($videoMaxSize, $allowedValues)) {
            $sanitized['videoMaxSize'] = $videoMaxSize;
        }
    }
    
    if (isset($settings['lastBuildingRotation'])) {
        // Rotation angle in radians - allow any numeric value
        $sanitized['lastBuildingRotation'] = floatval($settings['lastBuildingRotation']);
    }
    
    if (isset($settings['tileSegments'])) {
        $tileSegments = intval($settings['tileSegments']);
        // Clamp to valid range (16-256)
        $sanitized['tileSegments'] = max(16, min(256, $tileSegments));
    }

    if (isset($settings['renderScale'])) {
        $rs = floatval($settings['renderScale']);
        $allowed = [1.0, 0.85, 0.7, 0.5, 0.35];
        $best = 1.0; $bestErr = INF;
        foreach ($allowed as $v) {
            $err = abs($v - $rs);
            if ($err < $bestErr) { $bestErr = $err; $best = $v; }
        }
        $sanitized['renderScale'] = $best;
    }

    if (isset($settings['msaaSamples'])) {
        $s = intval($settings['msaaSamples']);
        if (in_array($s, [0, 2, 4, 8])) {
            $sanitized['msaaSamples'] = $s;
        }
    }

    if (isset($settings['performancePreset'])) {
        $p = strval($settings['performancePreset']);
        if (in_array($p, ['Quality', 'Balanced', 'Fast', 'Potato', 'Custom'])) {
            $sanitized['performancePreset'] = $p;
        }
    }
    
    if (isset($settings['chatModel'])) {
        $chatModel = strval($settings['chatModel']);
        // "provider:model". The model half is namespaced differently by every route -
        // "claude-opus-5", "openai/gpt-5-mini" (aggregator slug), "llama3.2:3b" (a local
        // model tag) - so segments may be separated by "/" or ":". Each must be non-empty
        // and free of traversal syntax, query strings and whitespace.
        if ($chatModel === '' || preg_match('/^[a-zA-Z0-9_-]+:[a-zA-Z0-9._-]+(?:[\/:][a-zA-Z0-9._-]+)*$/', $chatModel)) {
            $sanitized['chatModel'] = $chatModel;
        }
    }

    if (isset($settings['enableOldAIModels']) && is_bool($settings['enableOldAIModels'])) {
        $sanitized['enableOldAIModels'] = $settings['enableOldAIModels'];
    }

    if (isset($settings['byokSitrecFocused']) && is_bool($settings['byokSitrecFocused'])) {
        $sanitized['byokSitrecFocused'] = $settings['byokSitrecFocused'];
    }

    if (isset($settings['voiceModel'])) {
        $voiceModel = strval($settings['voiceModel']);
        // A bare model id, or empty for "use the default". No provider prefix: unlike
        // chatModel this always goes to OpenAI's realtime endpoint.
        if ($voiceModel === '' || preg_match('/^[a-zA-Z0-9._-]+$/', $voiceModel)) {
            $sanitized['voiceModel'] = $voiceModel;
        }
    }

    if (isset($settings['centerSidebar']) && is_bool($settings['centerSidebar'])) {
        $sanitized['centerSidebar'] = $settings['centerSidebar'];
    }

    if (isset($settings['showAttribution']) && is_bool($settings['showAttribution'])) {
        $sanitized['showAttribution'] = $settings['showAttribution'];
    }

    if (isset($settings['showFilename']) && is_bool($settings['showFilename'])) {
        $sanitized['showFilename'] = $settings['showFilename'];
    }

    if (isset($settings['language'])) {
        $language = strtolower(strval($settings['language']));
        if (preg_match('/^[a-z]{2}$/', $language)) {
            $sanitized['language'] = $language;
        }
    }

    // ---- New-sitch startup preferences ----

    if (isset($settings['startupUnits'])) {
        $units = strtolower(strval($settings['startupUnits']));
        if (in_array($units, ['nautical', 'imperial', 'metric', 'feet'])) {
            $sanitized['startupUnits'] = $units;
        }
    }

    if (isset($settings['startupLocation']) && is_bool($settings['startupLocation'])) {
        $sanitized['startupLocation'] = $settings['startupLocation'];
    }

    if (isset($settings['startupLat'])) {
        $sanitized['startupLat'] = max(-90, min(90, floatval($settings['startupLat'])));
    }

    if (isset($settings['startupLon'])) {
        $sanitized['startupLon'] = max(-180, min(180, floatval($settings['startupLon'])));
    }

    if (isset($settings['startupAlt'])) {
        // Metres above ground, so 0 is the floor.
        $sanitized['startupAlt'] = max(0, min(100000, floatval($settings['startupAlt'])));
    }

    if (isset($settings['startupBuildings']) && is_bool($settings['startupBuildings'])) {
        $sanitized['startupBuildings'] = $settings['startupBuildings'];
    }

    return $sanitized;
}

// Handle GET request - Fetch settings
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        if ($useAWS) {
            $s3Data = startS3();
            $s3 = $s3Data['s3'];
            $aws = $s3Data['aws'];
            $s3Path = 'settings/' . $user_id . '.json';

            try {
                $result = $s3->getObject([
                    'Bucket' => $aws['bucket'],
                    'Key' => $s3Path
                ]);
                $settings = json_decode($result['Body']->getContents(), true);
            } catch (Aws\S3\Exception\S3Exception $e) {
                if ($e->getAwsErrorCode() === 'NoSuchKey') {
                    $settings = null;
                } else {
                    throw $e;
                }
            }
        } else {
            $localPath = $UPLOAD_PATH . 'settings/' . $user_id . '.json';
            if (file_exists($localPath)) {
                $storedSettings = file_get_contents($localPath);
                if ($storedSettings === false) throw new RuntimeException('Settings read failed');
                $settings = json_decode($storedSettings, true);
            } else {
                $settings = null;
            }
        }

        $sanitized = ($settings !== null) ? sanitizeSettings($settings) : [];
        sitrecAuditResult();
        http_response_code(200);
        echo json_encode(['settings' => $sanitized, 'userID' => $user_id]);

    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Settings storage unavailable']);
    }
    exit();
}

// Handle POST request - Save settings
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $input = file_get_contents('php://input');
        $data = json_decode($input, true);

        if ($data === null || !isset($data['settings'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON or missing settings']);
            exit();
        }

        $sanitized = sanitizeSettings($data['settings']);
        $settingsJson = json_encode($sanitized, JSON_PRETTY_PRINT);

        if ($useAWS) {
            $s3Data = startS3();
            $s3 = $s3Data['s3'];
            $aws = $s3Data['aws'];
            $s3Path = 'settings/' . $user_id . '.json';

            $putParams = [
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path,
                'Body' => $settingsJson,
                'ContentType' => 'application/json',
            ];
            if (!empty($aws['acl'])) {
                $putParams['ACL'] = 'private';
            }
            $s3->putObject($putParams);
        } else {
            $localDir = $UPLOAD_PATH . 'settings/';
            if (!is_dir($localDir)) {
                mkdir($localDir, 0777, true);
            }
            if (file_put_contents($localDir . $user_id . '.json', $settingsJson, LOCK_EX) === false) {
                throw new RuntimeException('Settings write failed');
            }
        }

        sitrecAuditResult();
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'settings' => $sanitized,
            'userID' => $user_id
        ]);

    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Settings storage unavailable']);
    }
    exit();
}

// Method not allowed
http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
?>
