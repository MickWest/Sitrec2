<?php
/*
 * Module: Sitrec upload/rehost API.
 *
 * Responsibilities:
 * - Handle authenticated user upload and deletion operations.
 * - Support filesystem uploads and S3 uploads (single-part and multipart).
 * - Mint presigned upload URLs and complete multipart uploads.
 * - Return stable object references (`sitrec://...`) alongside legacy direct URLs.
 * - Expose user capability/quota metadata via `getuser`.
 */
// need to modify php.ini?
// /opt/homebrew/etc/php/8.4/php.ini
// brew services restart php

// CRITICAL: Prevent caching of rehost.php responses
// Each upload is unique and must never return a cached result from a previous request
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');  // HTTP/1.0 compatibility
header('Expires: 0');        // For older browsers

require('./user.php');
require_once __DIR__ . '/object_helpers.php';

$auditActions = [
    'getPresignedUrl' => 'upload.authorize',
    'initiateMultipart' => 'upload.initiate',
    'completeMultipart' => 'upload.complete',
];
$auditAction = $_GET['action'] ?? '';
sitrecAuditRequest(isset($_GET['getuser']) ? 'identity.read'
    : ((isset($_POST['delete']) && $_POST['delete'] === 'true') ? 'object.delete'
    : ($auditActions[is_string($auditAction) ? $auditAction : ''] ?? 'object.upload')));

$aws = null;

function startS3() {
    require_once __DIR__ . '/s3_client.php';
    global $aws;
    global $s3creds;

    $aws = $s3creds;

    // Create an S3 client. Static keys, role credentials, FIPS and custom
    // endpoints are all decided in s3_client.php from the S3_* environment.
    return getS3Client();
}

function buildObjectAccessUrl($key) {
    // Same-origin reads when the deployment's browsers cannot reach the storage endpoint
    // (S3_READS_VIA_SERVER); see object_helpers.php.
    if (s3ReadsViaServer()) {
        return buildServerObjectUrl($key);
    }
    if (isObjectKeyPublic($key)) {
        return buildPublicObjectUrl($key);
    }
    return buildDefaultS3ObjectUrl($key);
}

function getUploadAclForKey($key) {
    global $s3creds;
    $baseAcl = $s3creds['acl'] ?? null;
    if (!$baseAcl) {
        // No ACL configured — don't use ACLs at all (e.g. Bucket Owner Enforced)
        $publicAcl = getEnvString('S3_PUBLIC_OBJECT_ACL', '');
        $privateAcl = getEnvString('S3_PRIVATE_OBJECT_ACL', '');
    } else {
        $publicAcl = getEnvString('S3_PUBLIC_OBJECT_ACL', $baseAcl);
        $privateAcl = getEnvString('S3_PRIVATE_OBJECT_ACL', 'private');
    }
    $acl = isObjectKeyPublic($key) ? $publicAcl : $privateAcl;
    return $acl ?: null;
}

/**
 * Return the effective file-upload size limit (in MB) for the current user.
 * Admins get ADMIN_MAX_FILE_SIZE_MB when it is configured; everyone else gets MAX_FILE_SIZE_MB.
 */
function getMaxFileSizeMB($userInfo = null) {
    $defaultLimit = getEnvIntSeconds('MAX_FILE_SIZE_MB', 100); // reuses int parser (works for MB too)
    if (isAdmin($userInfo)) {
        $adminLimit = getEnvIntSeconds('ADMIN_MAX_FILE_SIZE_MB', 0);
        if ($adminLimit > 0) {
            return $adminLimit;
        }
    }
    return $defaultLimit;
}

function getGoogle3DRootDailyLimitForGroups($userGroups) {
    $dailyLimits = [
        3 => 1000000, // Admin: effectively unlimited
        2 => 30,      // Registered (baseline, same as Verified)
        9 => 30,      // Verified (baseline)
        14 => 60,     // Meta Members (2x baseline)
        19 => 120,    // Sitrec Plus (4x baseline)
    ];

    $limit = 0;
    foreach ($userGroups as $group) {
        if (isset($dailyLimits[$group])) {
            $limit = max($limit, $dailyLimits[$group]);
        }
    }
    return $limit;
}

function getCesiumOSM3DBytesDailyLimitForGroups($userGroups) {
    $dailyLimitBytes = intdiv(1024 * 1024 * 1024, 30); // 1 GiB / 30 days per day (baseline)
    $dailyLimits = [
        3 => 1000000000000,             // Admin: effectively unlimited
        2 => $dailyLimitBytes,          // Registered (baseline ~35.8 MB/day, same as Verified)
        9 => $dailyLimitBytes,          // Verified (baseline ~35.8 MB/day)
        14 => $dailyLimitBytes * 2,     // Meta Members (2x baseline)
        19 => $dailyLimitBytes * 4,     // Sitrec Plus (4x baseline)
    ];

    $limit = 0;
    foreach ($userGroups as $group) {
        if (isset($dailyLimits[$group])) {
            $limit = max($limit, $dailyLimits[$group]);
        }
    }
    return $limit;
}

function getTileServiceDailyUsage($userId, $service) {
    $usageDir = sys_get_temp_dir() . '/sitrec_tile_usage/';
    $file = $usageDir . "user_{$userId}.json";
    if (!file_exists($file)) {
        return 0;
    }

    $data = json_decode(file_get_contents($file), true);
    if (!$data) {
        return 0;
    }

    $now = time();
    if ($now > ($data['dayReset'] ?? 0)) {
        return 0;
    }

    return max(0, intval($data['daily'][$service] ?? 0));
}

// if we were passed the parameter "getuser", then we return user data as JSON
if (isset($_GET['getuser'])) {
    header('Content-Type: application/json');

    // Avoid double auth initialization by resolving identity once on this path.
    $userInfo = getUserInfo();
    $user_id = $userInfo['user_id'] ?? 0;
    $userGroups = is_array($userInfo['user_groups'] ?? null) ? $userInfo['user_groups'] : [];
    $allowed3DBuildingGroups = [3, 2, 9, 14, 19]; // Admin, Registered, Verified, Sitrec Members, Sitrec Plus
    $has3DBuildingGroup = count(array_intersect($userGroups, $allowed3DBuildingGroups)) > 0;

    $response = [
        'userID' => $user_id,
        'userGroups' => $userGroups,
        'canUse3DBuildings' => false,
        'maxFileSizeMB' => getMaxFileSizeMB($userInfo),
    ];

    $googleRootLimit = getGoogle3DRootDailyLimitForGroups($userGroups);
    $googleRootUsed = getTileServiceDailyUsage($user_id, 'google_3d_root');
    $googleRootRemaining = max(0, $googleRootLimit - $googleRootUsed);
    $response['google3DRootDailyLimit'] = $googleRootLimit;
    $response['google3DRootDailyRemaining'] = $googleRootRemaining;

    $cesiumBytesLimit = getCesiumOSM3DBytesDailyLimitForGroups($userGroups);
    $cesiumBytesUsed = getTileServiceDailyUsage($user_id, 'cesium_osm_3d_bytes');
    $cesiumBytesRemaining = max(0, $cesiumBytesLimit - $cesiumBytesUsed);
    $response['cesium3DBytesDailyLimit'] = $cesiumBytesLimit;
    $response['cesium3DBytesDailyRemaining'] = $cesiumBytesRemaining;

    // Include 3D buildings API keys only for allowed groups (or localhost).
    // The localhost shortcut belongs to the forum/default identity path (AUTH_MODE unset or
    // "forum"); under client certificate authentication or AUTH_MODE=none only the groups count.
    $authMode = getenv('AUTH_MODE');
    $authMode = ($authMode === false) ? 'forum' : strtolower(trim($authMode));
    $isLocalhost = ($authMode === 'forum' || $authMode === '') &&
                   ($_SERVER['REMOTE_ADDR'] === '127.0.0.1' ||
                    $_SERVER['REMOTE_ADDR'] === '::1');
    if ($has3DBuildingGroup || $isLocalhost) {
        $googleKey = getenv('GOOGLE_MAPS_API_KEY');
        $cesiumToken = getenv('CESIUM_ION_TOKEN');
        $googleAllowedByQuota = $isLocalhost || $googleRootRemaining > 0;
        $cesiumAllowedByQuota = $isLocalhost || $cesiumBytesRemaining > 0;
        if ($googleKey && $googleAllowedByQuota) $response['GOOGLE_MAPS_API_KEY'] = $googleKey;
        if ($cesiumToken && $cesiumAllowedByQuota) $response['CESIUM_ION_TOKEN'] = $cesiumToken;
        $response['canUse3DBuildings'] = true;
    }

    sitrecAuditResult();
    echo json_encode($response);
    exit();
}

$user_id = getUserID();
$userDir = getUserDir($user_id);

// need to be logged in, and a member of group 9 (Verified users)
if ($user_id == 0 /*|| !in_array(9,$user->secondary_group_ids)*/) {
    http_response_code(401);
    exit("Internal Server Error");
}

if (isset($_GET['action']) && $_GET['action'] === 'getPresignedUrl') {
    header('Content-Type: application/json');
    
    $input = file_get_contents('php://input');
    $requestData = json_decode($input, true);
    
    if (!isset($requestData['filename'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Filename not provided']);
        exit();
    }
    
    $fileName = basename($requestData['filename']);
    $version = isset($requestData['version']) ? basename($requestData['version']) : null;
    $contentHash = isset($requestData['contentHash']) ? $requestData['contentHash'] : null;

    $fileName = preg_replace('/[^\w\s\.\-\(\),]/', '_', $fileName);

    if (!isSafeName($fileName) || !isSafeExtension($fileName) ||
        ($version && (!isSafeName($version) || !isSafeExtension($version)))) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid filename, version, or file type']);
        exit();
    }

    if ($contentHash && !preg_match('/^[a-f0-9]+$/', $contentHash)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid content hash']);
        exit();
    }

    // Enforce file size limit when the client reports file size
    if (isset($requestData['fileSize'])) {
        $maxBytes = getMaxFileSizeMB() * 1024 * 1024;
        if ((int)$requestData['fileSize'] > $maxBytes) {
            http_response_code(413);
            echo json_encode(['error' => 'File exceeds maximum upload size of ' . getMaxFileSizeMB() . ' MB']);
            exit();
        }
    }

    if (!$useAWS) {
        http_response_code(400);
        echo json_encode(['error' => 'S3 not enabled']);
        exit();
    }
    
    $s3 = startS3();
    
    $extension = pathinfo($fileName, PATHINFO_EXTENSION);
    $baseName = pathinfo($fileName, PATHINFO_FILENAME);
    
    if ($version) {
        $newFileName = $version;
    } else {
        $uniqueId = $contentHash ? $contentHash : uniqid();
        $newFileName = $baseName . '-' . $uniqueId . '.' . $extension;
    }
    
    $s3Path = $user_id . '/' . $newFileName;
    if ($version) {
        $s3Path = $user_id . '/' . $fileName . '/' . $newFileName;
    }
    
    sitrecAuditResource($s3Path);

    if ($contentHash) {
        try {
            $s3->headObject([
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path
            ]);
            $objectUrl = buildObjectAccessUrl($s3Path);
            sitrecAuditResult('success', 'already_exists');
            echo json_encode([
                'exists' => true,
                'objectRef' => canonicalObjectRef($s3Path),
                'objectUrl' => $objectUrl
            ]);
            exit();
        } catch (Aws\S3\Exception\S3Exception $e) {
        }
    }
    
    try {
        $uploadAcl = getUploadAclForKey($s3Path);
        $putParams = [
            'Bucket' => $aws['bucket'],
            'Key' => $s3Path,
        ];
        if ($uploadAcl) {
            $putParams['ACL'] = $uploadAcl;
        }
        $cmd = $s3->getCommand('PutObject', $putParams);
        
        $putExpirySeconds = getEnvIntSeconds('S3_PRESIGNED_PUT_EXPIRY_SECONDS', 900);
        $request = $s3->createPresignedRequest($cmd, '+' . $putExpirySeconds . ' seconds');
        
        $presignedUrl = (string) $request->getUri();
        
        $objectUrl = buildObjectAccessUrl($s3Path);
        
        sitrecAuditResult();
        echo json_encode([
            'objectRef' => canonicalObjectRef($s3Path),
            'presignedUrl' => $presignedUrl,
            'objectUrl' => $objectUrl
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to generate presigned URL']);
    }
    
    exit();
}

if (isset($_GET['action']) && $_GET['action'] === 'initiateMultipart') {
    header('Content-Type: application/json');
    
    $input = file_get_contents('php://input');
    $requestData = json_decode($input, true);
    
    if (!isset($requestData['filename']) || !isset($requestData['parts'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Filename and parts count required']);
        exit();
    }
    
    $fileName = basename($requestData['filename']);
    $version = isset($requestData['version']) ? basename($requestData['version']) : null;
    $contentHash = isset($requestData['contentHash']) ? $requestData['contentHash'] : null;
    $totalParts = (int)$requestData['parts'];
    
    $fileName = preg_replace('/[^\w\s\.\-\(\),]/', '_', $fileName);
    
    if (!isSafeName($fileName) || !isSafeExtension($fileName) ||
        ($version && (!isSafeName($version) || !isSafeExtension($version)))) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid filename, version, or file type']);
        exit();
    }
    
    if ($contentHash && !preg_match('/^[a-f0-9]+$/', $contentHash)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid content hash']);
        exit();
    }

    // Enforce file size limit when the client reports file size
    if (isset($requestData['fileSize'])) {
        $maxBytes = getMaxFileSizeMB() * 1024 * 1024;
        if ((int)$requestData['fileSize'] > $maxBytes) {
            http_response_code(413);
            echo json_encode(['error' => 'File exceeds maximum upload size of ' . getMaxFileSizeMB() . ' MB']);
            exit();
        }
    }

    if (!$useAWS) {
        http_response_code(400);
        echo json_encode(['error' => 'S3 not enabled']);
        exit();
    }

    $s3 = startS3();

    $extension = pathinfo($fileName, PATHINFO_EXTENSION);
    $baseName = pathinfo($fileName, PATHINFO_FILENAME);
    
    if ($version) {
        $newFileName = $version;
    } else {
        $uniqueId = $contentHash ? $contentHash : uniqid();
        $newFileName = $baseName . '-' . $uniqueId . '.' . $extension;
    }
    
    $s3Path = $user_id . '/' . $newFileName;
    if ($version) {
        $s3Path = $user_id . '/' . $fileName . '/' . $newFileName;
    }
    
    sitrecAuditResource($s3Path);

    if ($contentHash) {
        try {
            $s3->headObject([
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path
            ]);
            $objectUrl = buildObjectAccessUrl($s3Path);
            sitrecAuditResult('success', 'already_exists');
            echo json_encode([
                'exists' => true,
                'objectRef' => canonicalObjectRef($s3Path),
                'objectUrl' => $objectUrl
            ]);
            exit();
        } catch (Aws\S3\Exception\S3Exception $e) {
        }
    }
    
    try {
        $uploadAcl = getUploadAclForKey($s3Path);
        $multipartParams = [
            'Bucket' => $aws['bucket'],
            'Key' => $s3Path,
        ];
        if ($uploadAcl) {
            $multipartParams['ACL'] = $uploadAcl;
        }
        $result = $s3->createMultipartUpload($multipartParams);
        
        $uploadId = $result['UploadId'];
        
        $uploadUrls = [];
        for ($partNumber = 1; $partNumber <= $totalParts; $partNumber++) {
            $cmd = $s3->getCommand('UploadPart', [
                'Bucket' => $aws['bucket'],
                'Key' => $s3Path,
                'UploadId' => $uploadId,
                'PartNumber' => $partNumber
            ]);
            
            $multipartExpirySeconds = getEnvIntSeconds('S3_PRESIGNED_MULTIPART_EXPIRY_SECONDS', 3600);
            $request = $s3->createPresignedRequest($cmd, '+' . $multipartExpirySeconds . ' seconds');
            $uploadUrls[] = (string) $request->getUri();
        }
        
        $objectUrl = buildObjectAccessUrl($s3Path);
        
        sitrecAuditResult();
        echo json_encode([
            'uploadId' => $uploadId,
            'uploadUrls' => $uploadUrls,
            'objectRef' => canonicalObjectRef($s3Path),
            'objectUrl' => $objectUrl
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to initiate multipart upload']);
    }
    
    exit();
}

if (isset($_GET['action']) && $_GET['action'] === 'completeMultipart') {
    header('Content-Type: application/json');
    
    $input = file_get_contents('php://input');
    $requestData = json_decode($input, true);
    
    if (!isset($requestData['filename']) || !isset($requestData['uploadId']) || !isset($requestData['parts'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Filename, uploadId, and parts required']);
        exit();
    }
    
    $fileName = basename($requestData['filename']);
    $version = isset($requestData['version']) ? basename($requestData['version']) : null;
    $uploadId = $requestData['uploadId'];
    $parts = $requestData['parts'];
    
    $fileName = preg_replace('/[^\w\s\.\-\(\),]/', '_', $fileName);
    
    if (!isSafeName($fileName) || !isSafeExtension($fileName) ||
        ($version && (!isSafeName($version) || !isSafeExtension($version)))) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid filename, version, or file type']);
        exit();
    }
    
    if (!$useAWS) {
        http_response_code(400);
        echo json_encode(['error' => 'S3 not enabled']);
        exit();
    }
    
    $s3 = startS3();
    
    try {
        $multipartUploads = $s3->listMultipartUploads([
            'Bucket' => $aws['bucket'],
            'Prefix' => $user_id . '/'
        ]);
        
        $s3Path = null;
        foreach ($multipartUploads['Uploads'] as $upload) {
            if ($upload['UploadId'] === $uploadId) {
                $s3Path = $upload['Key'];
                break;
            }
        }
        
        if (!$s3Path) {
            http_response_code(400);
            echo json_encode(['error' => 'Upload ID not found or expired']);
            exit();
        }
        
        sitrecAuditResource($s3Path);
        $result = $s3->completeMultipartUpload([
            'Bucket' => $aws['bucket'],
            'Key' => $s3Path,
            'UploadId' => $uploadId,
            'MultipartUpload' => [
                'Parts' => $parts
            ]
        ]);
        
        $objectUrl = buildObjectAccessUrl($s3Path);
        
        sitrecAuditResult();
        echo json_encode([
            'objectRef' => canonicalObjectRef($s3Path),
            'objectUrl' => $objectUrl,
            'eTag' => $result['ETag']
        ]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to complete multipart upload']);
    }
    
    exit();
}

$isLocal = false;

//if ($_SERVER['HTTP_HOST'] === 'localhost' || $_SERVER['SERVER_NAME'] === 'localhost') {
//    // for local testing
//    $storagePath = $ROOT_URL . "sitrec-upload/";
//    $isLocal = true;
//} else {
$storagePath = $UPLOAD_URL;  // from config.php
//}

function writeLog($message) {
//    global $logPath;
//    // Ensure message is a string
//    if (!is_string($message)) {
//        $message = print_r($message, true);
//    }
//
//    // Add a timestamp to each log entry for easier tracking
//    $timestamp = date("Y-m-d H:i:s");
//    $logEntry = "[$timestamp] " . $message . "\n";
//
//    // Append the log entry to the log file
//    file_put_contents($logPath, $logEntry, FILE_APPEND);
}

// Secure validation function
function isSafeName($name) {
    // Check if the name contains only allowed characters
    // which are A-Z, a-z, 0-9, space, _, -, ., (, ), ,
    return preg_match('/^[A-Za-z0-9 _\\-\\.\\(\\),]+$/', $name);
}

// Extensions that must never be stored — server-side executables and config overrides
function isSafeExtension($filename) {
    static $DANGEROUS_EXTENSIONS = [
        'php', 'php3', 'php4', 'php5', 'php7', 'phtml', 'phar',
        'shtml', 'shtm', 'cgi', 'pl', 'py', 'rb', 'sh', 'bash',
        'asp', 'aspx', 'jsp', 'cfm', 'htaccess', 'htpasswd'
    ];
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    return !in_array($ext, $DANGEROUS_EXTENSIONS, true);
}

// check to see if we have delete = true
if (isset($_POST['delete']) && $_POST['delete'] == 'true') {
    $filename = $_POST['filename'] ?? '';
    $version = $_POST['version'] ?? null;
    sitrecAuditResource($user_id . '/' . (is_string($filename) ? $filename : '') . '/' . (is_string($version) ? $version : ''));

    // Strictly validate filename and version
    if (!isSafeName($filename) || ($version && !isSafeName($version))) {
        // exit with error code
        http_response_code(400);
        exit("Invalid filename or version");
    }

    try {
        if ($useAWS) {
            // delete the entire folder from s3
            require 'vendor/autoload.php';
            $s3 = startS3();
        }

        // if no version name is supplied, then we delete the entire folder
        if (!$version) {
            if ($useAWS) {
                $s3Path = $user_id . '/' . $filename . '/';
                $s3->deleteMatchingObjects($aws['bucket'], $s3Path);
            } else {
                $dir = $userDir . basename($filename);
                if (file_exists($dir)) {
                    $files = glob($dir . '/*'); // get all file names
                    if ($files === false) throw new RuntimeException('Object deletion failed');
                    foreach ($files as $file) { // iterate files
                        if (is_file($file)) {
                            if (!unlink($file)) throw new RuntimeException('Object deletion failed');
                        }
                    }
                    if (!rmdir($dir)) throw new RuntimeException('Object deletion failed');
                }
            }
        } else {
            if ($useAWS) {
                // delete the specific version from s3
                $s3Path = $user_id . '/' . $filename . '/' . $version;
                $s3->deleteMatchingObjects($aws['bucket'], $s3Path);
            } else {
                $file = $userDir . basename($filename) . '/' . basename($version);
                if (file_exists($file)) {
                    if (!unlink($file)) throw new RuntimeException('Object deletion failed');
                }
            }
        }
    } catch (Exception $e) {
        http_response_code(500);
        exit('Object deletion failed');
    }
    sitrecAuditResult();
    exit(0);
}

// Check if file and filename are provided
if (!isset($_FILES['fileContent']) || !isset($_POST['filename'])) {
    http_response_code(400);
    die("File or filename not provided");
}

if (($_FILES['fileContent']['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
    http_response_code(400);
    exit('Upload did not complete');
}

// Enforce file size limit on filesystem uploads
$maxBytes = getMaxFileSizeMB() * 1024 * 1024;
if ($_FILES['fileContent']['size'] > $maxBytes) {
    http_response_code(413);
    die("File exceeds maximum upload size of " . getMaxFileSizeMB() . " MB");
}

// Securely retrieve the file and filename
$fileName = basename($_POST['filename']);
$fileContent = file_get_contents($_FILES['fileContent']['tmp_name']);
if ($fileContent === false) {
    http_response_code(500);
    exit('Upload could not be read');
}
$version = isset($_POST['version']) ? basename($_POST['version']) : null;

// sanitize the filename by removing any path components
// or any characters that are not alphanumeric, space, _, -, ., (, )
$fileName = preg_replace('/[^\w\s\.\-\(\),]/', '_', $fileName);


// Validate names and extensions
if (!isSafeName($fileName) || !isSafeExtension($fileName) ||
    ($version && (!isSafeName($version) || !isSafeExtension($version)))) {
    http_response_code(400);
    echo("Invalid filename, version, or file type provided " . $fileName);
    exit("Invalid filename, version, or file type provided");
}

writeLog(print_r($_FILES, true));
writeLog(print_r($_POST, true));

// Create a filename with MD5 checksum of the contents of the file
$md5Checksum = md5($fileContent);

// Separate the filename and extension
$extension = pathinfo($fileName, PATHINFO_EXTENSION);
$baseName = pathinfo($fileName, PATHINFO_FILENAME);

// Append MD5 checksum before the extension
$newFileName = $baseName . '-' . $md5Checksum . '.' . $extension;

if ($version) {
    // versioned files sit in a folder based on the file name
    // like /sitrec-upload/99999998/MyFile/versionnumber.jpg
    $userDir = $userDir . $baseName . '/';
    $newFileName = $version;  // Assume front-end has supplied a unique version number with correct extension
}

if ($useAWS) {
    $s3 = startS3();

    $filePath = $_FILES['fileContent']['tmp_name'];
    $fileStream = fopen($filePath, 'r');

    $s3Path = $user_id . '/' . $newFileName;
    if ($version) {
        $s3Path = $user_id . '/' . $fileName . '/' . $newFileName;
    }

    sitrecAuditResource($s3Path);

    // Upload the file using the high-level upload method
    // Using upload instead of putObject to allow for larger files
    // putObject was giving odd timeout errors.
    try {
        $uploadAcl = getUploadAclForKey($s3Path);
        if ($uploadAcl) {
            $s3->upload($aws['bucket'], $s3Path, $fileStream, $uploadAcl);
        } else {
            // No ACL configured (e.g. Bucket Owner Enforced) — omit ACL param
            $s3->upload($aws['bucket'], $s3Path, $fileStream);
        }
        echo buildObjectAccessUrl($s3Path);
    } catch (Exception $e) {
        // Catch an S3 specific exception.
        http_response_code(500);
        exit('Upload failed');
    } finally {
        if (is_resource($fileStream)) {
            fclose($fileStream);  // Close the file stream to free up resources
        }
    }
    sitrecAuditResult();
    exit(0);
}

// Local server storage
if (!file_exists($userDir)) {
    if (!mkdir($userDir, 0755, true) && !is_dir($userDir)) {
        http_response_code(500);
        exit('Upload storage unavailable');
    }
}

$userFilePath = $userDir . $newFileName;
sitrecAuditResource($user_id . '/' . ($version ? $baseName . '/' : '') . $newFileName);


// Move the file to the user's directory
if (!file_exists($userFilePath)) {
    if (!move_uploaded_file($_FILES['fileContent']['tmp_name'], $userFilePath)) {
        http_response_code(500);
        exit('Upload failed');
    }
}
sitrecAuditResult();

// Return the URL of the rehosted file
if ($version) {
    echo $storagePath . $user_id . '/' . $fileName . '/' . $newFileName;
} else {
    echo $storagePath . $user_id . '/' . $newFileName;
}
?>
