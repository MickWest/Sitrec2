<?php
/**
 * User Settings API
 * 
 * Handles loading and saving user settings to S3 storage.
 * Settings are stored as JSON files in the format: settings/<userID>.json
 * 
 * GET request: Fetch user settings from S3
 * POST request: Save user settings to S3
 * 
 * Falls back gracefully if S3 is unavailable or user is not logged in.
 */

require('./user.php');

header('Content-Type: application/json');

$user_id = getUserID();

global $s3creds;
if (!isset($s3creds)) {
    http_response_code(503);
    echo json_encode(['error' => 'S3 credentials not configured']);
    exit();
}

if (!is_array($s3creds) ||
   !isset($s3creds['accessKeyId']) ||
   !isset($s3creds['secretAccessKey']) ||
   !isset($s3creds['region']) ||
   !isset($s3creds['bucket']) ||
    empty($s3creds['accessKeyId']) ||
    $s3creds['accessKeyId'] === 0
) {
    http_response_code(503);
    echo json_encode(['error' => 'S3 credentials incomplete']);
    exit();
}

// If user is not logged in, return error
if ($user_id == 0) {
    http_response_code(401);
    echo json_encode(['error' => 'Not logged in', 'userID' => 0]);
    exit();
}

// Initialize S3 client
function startS3() {
    require 'vendor/autoload.php';
    global $s3creds;

    $aws = $s3creds;

    $credentials = new Aws\Credentials\Credentials($aws['accessKeyId'], $aws['secretAccessKey']);

    $s3 = new Aws\S3\S3Client([
        'version' => 'latest',
        'region' => $aws['region'],
        'credentials' => $credentials
    ]);
    
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
    
    // Add more settings here as needed
    // Remember to also update SettingsManager.js!
    
    return $sanitized;
}

// Handle GET request - Fetch settings
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $s3Data = startS3();
        $s3 = $s3Data['s3'];
        $aws = $s3Data['aws'];
        
        $s3Path = 'settings/' . $user_id . '.json';
        
        try {
            $result = $s3->getObject([
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path
            ]);
            
            $settingsJson = $result['Body']->getContents();
            $settings = json_decode($settingsJson, true);
            
            if ($settings === null) {
                // Invalid JSON
                http_response_code(200);
                echo json_encode(['settings' => [], 'userID' => $user_id]);
                exit();
            }
            
            // Sanitize before returning
            $sanitized = sanitizeSettings($settings);
            
            http_response_code(200);
            echo json_encode(['settings' => $sanitized, 'userID' => $user_id]);
            
        } catch (Aws\S3\Exception\S3Exception $e) {
            // File doesn't exist or other S3 error
            if ($e->getAwsErrorCode() === 'NoSuchKey') {
                // No settings file yet - return empty settings
                http_response_code(200);
                echo json_encode(['settings' => [], 'userID' => $user_id]);
            } else {
                // Other S3 error
                http_response_code(500);
                echo json_encode(['error' => 'S3 error: ' . $e->getMessage()]);
            }
        }
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Server error: ' . $e->getMessage()]);
    }
    exit();
}

// Handle POST request - Save settings
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        // Get JSON from request body
        $input = file_get_contents('php://input');
        $data = json_decode($input, true);
        
        if ($data === null || !isset($data['settings'])) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid JSON or missing settings']);
            exit();
        }
        
        // Sanitize settings
        $sanitized = sanitizeSettings($data['settings']);
        
        $s3Data = startS3();
        $s3 = $s3Data['s3'];
        $aws = $s3Data['aws'];
        
        $s3Path = 'settings/' . $user_id . '.json';
        
        // Convert to JSON
        $settingsJson = json_encode($sanitized, JSON_PRETTY_PRINT);
        
        // Upload to S3
        try {
            $result = $s3->putObject([
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path,
                'Body' => $settingsJson,
                'ContentType' => 'application/json',
                'ACL' => 'private' // Keep settings private
            ]);
            
            http_response_code(200);
            echo json_encode([
                'success' => true,
                'settings' => $sanitized,
                'userID' => $user_id
            ]);
            
        } catch (Aws\S3\Exception\S3Exception $e) {
            http_response_code(500);
            echo json_encode(['error' => 'S3 error: ' . $e->getMessage()]);
        }
        
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Server error: ' . $e->getMessage()]);
    }
    exit();
}

// Method not allowed
http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
?>