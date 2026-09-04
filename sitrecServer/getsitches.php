<?php

/*
 * Module: Sitrec sitch listing and version metadata API.
 *
 * Responsibilities:
 * - Return built-in sitch definitions and user sitch lists.
 * - Serve version listings for user sitches across filesystem/S3 storage backends.
 * - Include canonical object references for versioned files so clients can resolve via object.php.
 */

// The CORS origin below is built before config_paths.php is loaded, so settle the scheme first.
require_once __DIR__ . '/requestScheme.php';

header('Content-Type: application/json');

// SECURITY: Restrict CORS to own origin and the configured dev host (LOCALHOST env var).
// Only set Allow-Origin when an Origin header is present (i.e. a cross-origin browser request).
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($requestOrigin) {
    $serverOrigin = $_SERVER['REQUEST_SCHEME'] . '://' . $_SERVER['HTTP_HOST'];
    $allowedOrigins = [$serverOrigin];
    $localhostEnv = getenv('LOCALHOST');
    if ($localhostEnv) {
        $allowedOrigins[] = 'https://' . $localhostEnv;
        $allowedOrigins[] = 'http://'  . $localhostEnv;
    }
    if (in_array($requestOrigin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $requestOrigin);
        header('Vary: Origin');
        header('Access-Control-Allow-Methods: GET, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type');
    }
    // Origin not in allowlist: no Allow-Origin header → browser blocks the request.
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/object_helpers.php';
require_once __DIR__ . '/s3_client.php';
require_once __DIR__ . '/audit.php';
sitrecAuditRequest(($_GET['get'] ?? '') === 'versions' ? 'sitch.versions' : 'sitch.list');

define('SITCH_NAME_PATTERN', '/^[^\/\\\\<>\x00-\x1f]+$/u');

$storagePath = $UPLOAD_URL; // from config.php

// find all the sitches in the sitrec/data folder and return them as a json object
// a sitchs is a folder with a file inside it with the same name with a .sitch.js extension
// The file contains a text description of the sitch in javascript object notation

function getSitches()
{
    global $APP_PATH;

// get the list of folders in the data folder
    // note "data" is not configurable, as it's hardcoded by the webpack config
    $dir = $APP_PATH . "data";

    $files = scandir($dir);
    $folders = array();
    foreach ($files as $file) {
        if (is_dir($dir . '/' . $file) && $file != '.' && $file != '..') {
            $folders[] = $file;
        }
    }

// filer out the folders that do not have a .sitch.js file inside of the same name as the folder
//    $sitches = array();
//    foreach ($folders as $folder) {
//        // Normalize the folder name to lowercase for comparison
//        $normalizedFolderName = strtolower($folder);
//        $folderPath = $dir . '/' . $folder;
//
//        // Check if the folder path is actually a directory
//        if (is_dir($folderPath)) {
//            // Scan the directory for files
//            $filesInFolder = scandir($folderPath);
//
//            // Normalize file names to lowercase for case-insensitive comparison
//            $normalizedFiles = array_map('strtolower', $filesInFolder);
//
//            // Construct the expected file name based on the folder name
//            $expectedFileName = $normalizedFolderName . '.sitch.js';
//
//            // Check if the normalized file names array contains the expected file name
//            if (in_array($expectedFileName, $normalizedFiles)) {
//                // Find the original file name by matching the normalized name
//                foreach ($filesInFolder as $file) {
//                    if (strtolower($file) === $expectedFileName) {
//                        // Read the content of the file when the case-insensitive match is found
//                        $sitches[$folder] = file_get_contents($folderPath . '/' . $file);
//                        break; // Stop the loop after finding the matching file
//                    }
//                }
//            }
//        }
//    }

    // new naming convention is Sitname.js
    // eg. for 29palms is Sit29palms.js
    // so filter out the folders that do not have a .js file inside of the same name as the folder (with Sit prefix)
    $sitches = array();
    foreach ($folders as $folder) {
        // Normalize the folder name to lowercase for comparison
        $normalizedFolderName = strtolower($folder);
        $folderPath = $dir . '/' . $folder;

        // Check if the folder path is actually a directory
        if (is_dir($folderPath)) {
            // Scan the directory for files
            $filesInFolder = scandir($folderPath);

            // Normalize file names to lowercase for case-insensitive comparison
            $normalizedFiles = array_map('strtolower', $filesInFolder);

            // Construct the expected file name based on the folder name
            // also in lower case, for comparision
            $expectedFileName = 'sit' . $normalizedFolderName . '.js';

            // Check if the normalized file names array contains the expected file name
            if (in_array($expectedFileName, $normalizedFiles)) {
                // Find the original file name by matching the normalized name
                foreach ($filesInFolder as $file) {
                    if (strtolower($file) === $expectedFileName) {
                        // Read the content of the file when the case-insensitive match is found
                        $sitches[$folder] = file_get_contents($folderPath . '/' . $file);
                        break; // Stop the loop after finding the matching file
                    }
                }
            }
        }
    }

    return $sitches;

}

// if no parapmeters passed then return the sitches as a json object
// return the text-based sitches as a json object
if (count($_GET) == 0) {
    $sitches = getSitches();
    sitrecAuditResult();
    echo json_encode($sitches);
    exit();
}

// The `latestversion` endpoint was REMOVED (2026-09-01).
//
// It answered `?get=latestversion&userid=<N>&name=<X>` before authentication,
// mapping a sitch NAME to its current version string. That is an enumeration
// oracle against the sharing model: a share URL is <userid>/<name>/<version>.js
// and the version is the capability, but the name is not secret - it is
// human-readable and appears in full in every shared link. Anyone who knew or
// guessed a name could obtain the version, including for sitches never shared.
//
// It had no callers: nothing in src/, tools/, tests/ or docs/ referenced it.
// Deleted rather than gated, because dead code cannot be reviewed into safety.

// Is (userID, name) on the published featured list?
//
// The featured list (metadata/featured.json, written by the admin featured-list
// editor and served by metadata.php?featured=1) is the ONLY reason a cross-user
// or anonymous version listing is allowed. Featured sitches are deliberately
// published, so enumerating their versions discloses nothing that was not
// already public; every other sitch's version list is private to its owner.
//
// Deliberately a local copy rather than a require of metadata.php: that file is
// an endpoint and including it would execute it.
function isFeaturedSitch($userID, $name) {
    global $useAWS, $UPLOAD_PATH, $s3creds;

    $entries = null;
    if (!$useAWS) {
        $path = $UPLOAD_PATH . 'metadata/featured.json';
        if (!is_file($path)) return false;
        $entries = json_decode(@file_get_contents($path), true);
    } else {
        if (!s3HasCredentials() || empty($s3creds['bucket'])) return false;
        try {
            $s3 = getS3Client();
            $res = $s3->getObject(['Bucket' => $s3creds['bucket'], 'Key' => 'metadata/featured.json']);
            $entries = json_decode((string)$res['Body'], true);
        } catch (Exception $e) {
            return false;   // fail CLOSED: no featured list means no cross-user access
        }
    }

    if (!is_array($entries)) return false;
    foreach ($entries as $entry) {
        if (!is_array($entry)) continue;
        if ((string)($entry['userID'] ?? '') === (string)$userID
            && (string)($entry['name'] ?? '') === (string)$name) {
            return true;
        }
    }
    return false;
}

// if there's a "get" parameter then it depends on the value of the "get" parameter
// if it's "myfiles", then return a list of the files in the local folder

if (isset($_GET['get'])) {
    require_once __DIR__ . '/user.php';

    $userID = getUserID();
    $dir = getUserDir($userID);
    sitrecAuditResource('sitches/' . $userID);

    // Not logged in: an empty array, EXCEPT for the version list of a sitch that is
    // actually on the published featured list. The old condition allowed any
    // `versions` request carrying any `userid`, which let an anonymous caller
    // enumerate every version of any sitch whose name they knew - and the name is
    // not secret, it appears in full in every shared link. The featured check
    // narrows that to the set that is deliberately public.
    if ($dir == "") {
        $featuredOK = ($_GET['get'] ?? '') === 'versions'
            && isset($_GET['userid']) && preg_match('/^\d+$/', $_GET['userid'])
            && isset($_GET['name']) && preg_match(SITCH_NAME_PATTERN, $_GET['name'])
            && isFeaturedSitch($_GET['userid'], basename($_GET['name']));
        if (!$featuredOK) {
            sitrecAuditResult('denied', 'authentication_required');
            echo json_encode(array());
            exit();
        }
    }


    if ($useAWS) {
        // Validate S3 credentials before attempting to use them
        global $s3creds;
        if (!isset($s3creds)) {
            http_response_code(503);
            echo json_encode(['error' => 'S3 credentials not configured']);
            exit();
        }

        if (!is_array($s3creds) ||
           !isset($s3creds['region']) ||
           !isset($s3creds['bucket']) ||
            !s3HasCredentials()
        ) {
            http_response_code(503);
            echo json_encode(['error' => 'S3 credentials incomplete']);
            exit();
        }

        $aws = $s3creds;

        // Create an S3 client
        $s3 = getS3Client();

        // convert the dir to an S3 path
        // dir will be like '../../sitrec-upload/99999998/'
        // we want to convert it to '99999998/'
        $dir = getShortDir($userID);

    }


    // myfiles will return a list of files in the user's root directory
    //

//    wht;at's tigetting? dirs? files'

    if ($_GET['get'] == "myfiles") {


        if (!$useAWS) {
            try {
                if (!is_dir($dir)) {
                    sitrecAuditResult();
                    echo json_encode(array());
                    exit();
                }
                $files = @scandir($dir);
                if ($files === false) {
                    sitrecAuditResult('failure', 'storage_error');
                    echo json_encode(array());
                    exit();
                }
                $folders = array();
                foreach ($files as $file) {
                    if (is_dir($dir . '/' . $file) && $file != '.' && $file != '..' && $file != '.DS_Store') {
                        $sitchPath = $dir . '/' . $file;
                        $versions = @scandir($sitchPath);
                        $newestTime = 0;
                        $latestVersion = null;
                        if ($versions !== false) {
                            foreach ($versions as $v) {
                                if ($v !== '.' && $v !== '..' && !isScreenshotFile($v) && $v !== 'metadata.json' && is_file($sitchPath . '/' . $v)) {
                                    $vTime = @filemtime($sitchPath . '/' . $v);
                                    if ($vTime > $newestTime) {
                                        $newestTime = $vTime;
                                        $latestVersion = $v;
                                    }
                                }
                            }
                        }
                        $lastDate = $newestTime ? date('Y-m-d H:i:s', $newestTime) : '1970-01-01 00:00:00';
                        // Avoid a per-sitch screenshot existence check on this hot path.
                        // The browser already falls back gracefully if an image is missing.
                        // Screenshots carry their own token now, so pick the newest from the
                        // directory listing we already have; fall back to the legacy fixed
                        // name for sitches saved before that change.
                        $shot = ($versions !== false) ? newestScreenshotName($versions) : null;
                        $screenshotUrl = $storagePath . $userID . '/' . $file . '/' . ($shot ?? 'screenshot.jpg');
                        $folders[] = [$file, $lastDate, $screenshotUrl, $latestVersion];
                    }
                }
                sitrecAuditResult();
                echo json_encode($folders);
                exit();
            } catch (Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'Sitch storage unavailable']);
                exit();
            }
        } else {
            // get the list of files in the S3 bucket
            try {
                $objects = $s3->getIterator('ListObjects', array(
                    "Bucket" => $aws['bucket'],
                    "Prefix" => $dir . '/'
                ));
                $folderDates = array();
                $folderLatest = array();
                $folderShots = array();   // newest screenshot filename per sitch folder
                foreach ($objects as $object) {
                    $key = $object['Key'];

                    $startText = $dir . '/';
                    if (strpos($key, $startText) === 0) {
                        $key = substr($key, strlen($startText));
                    }

                    if ($key != "" && strpos($key, "/") !== false) {
                        $folderName = strtok($key, "/");
                        $lastModified = $object['LastModified'];
                        $lastDate = $lastModified->format('Y-m-d H:i:s');

                        // Ignore screenshot/metadata for date calculations.
                        $fileName = substr($key, strlen($folderName) + 1);
                        if (isScreenshotFile($fileName) || $fileName === 'metadata.json') {
                            // Not a version. Screenshots carry their own token now, so keep
                            // the newest one per folder rather than assuming a fixed name.
                            if (isScreenshotFile($fileName)
                                && (!isset($folderShots[$folderName])
                                    || strcmp($fileName, $folderShots[$folderName]) > 0)) {
                                $folderShots[$folderName] = $fileName;
                            }
                        } else {
                            if (!isset($folderDates[$folderName]) || $lastDate > $folderDates[$folderName]) {
                                $folderDates[$folderName] = $lastDate;
                                $folderLatest[$folderName] = $fileName;
                            }
                        }
                    }
                }

                $folders = array();
                foreach ($folderDates as $name => $date) {
                    // Avoid a separate screenshot existence test. Missing screenshots are
                    // handled client-side via img.onerror.
                    $shot = isset($folderShots[$name]) ? $folderShots[$name] : 'screenshot.jpg';
                    $screenshotKey = $dir . '/' . $name . '/' . $shot;
                    // Same-origin when the deployment's browsers cannot reach storage (S3_READS_VIA_SERVER).
                    $screenshotUrl = s3ReadsViaServer()
                        ? buildServerObjectUrl($screenshotKey)
                        : $s3->getObjectUrl($aws['bucket'], $screenshotKey);
                    $latestVersion = isset($folderLatest[$name]) ? $folderLatest[$name] : null;
                    $folders[] = [$name, $date, $screenshotUrl, $latestVersion];
                }
                sitrecAuditResult();
                echo json_encode($folders);
                exit();
            } catch (Aws\S3\Exception\S3Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'Sitch storage unavailable']);
                exit();
            } catch (Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'Sitch storage unavailable']);
                exit();
            }
        }


    } else if ($_GET['get'] == "validate_names") {
        http_response_code(403);
        echo json_encode(['error' => 'validate_names is disabled']);
        exit();

    } else if ($_GET['get'] == "versions") {
            $name = $_GET['name'];
            sitrecAuditResource('versions/' . $userID . '/' . (is_string($name) ? $name : ''));

            // SECURITY: Validate name to prevent path traversal
            if (!preg_match(SITCH_NAME_PATTERN, $name)) {
                http_response_code(400);
                echo json_encode(['error' => 'Invalid name parameter']);
                exit();
            }
            $name = basename($name); // Extra safety: strip any path components

            // A `userid` may name ANOTHER user's directory, so it is restricted to the
            // three cases that are legitimate: your own id, a sitch on the published
            // featured list, or an admin. Anything else falls through and lists your
            // own directory, which is what an unentitled caller is allowed to see.
            if (isset($_GET['userid']) && preg_match('/^\d+$/', $_GET['userid'])) {
                $requested = $_GET['userid'];
                if ((string)$requested === (string)$userID
                    || isAdmin()
                    || isFeaturedSitch($requested, $name)) {
                    $userID = $requested;
                    $dir = $useAWS ? getShortDir($userID) : getUserDir($userID);
                } else {
                    sitrecAuditResource('versions/' . $requested . '/' . $name);
                    sitrecAuditWrite('authorization.version_list', 'denied', 'owner_or_featured_required');
                }
            }

            sitrecAuditResource('versions/' . $userID . '/' . $name);
            $dir .= "/" . $name;
            $versions = array();
            if (!$useAWS) {
                $files = scandir($dir);
                if ($files === false) {
                    http_response_code(500);
                    exit('Sitch storage unavailable');
                }
                foreach ($files as $file) {
                    if (is_file($dir . '/' . $file) && $file != '.' && $file != '..' && $file != '.DS_Store' && !isScreenshotFile($file) && $file !== 'metadata.json') {
                        $url = $storagePath . $userID . '/' . $name. '/' . $file;
                        // add to the array and object that contains the url and the version
                        $versions[] = array(
                            'version' => $file,
                            'ref' => canonicalObjectRef($userID . '/' . $name . '/' . $file),
                            'url' => $url
                        );
                    }
                }
                sitrecAuditResult();
                echo json_encode($versions);
                exit();
            } else {
                // get the list of files in the S3 bucket
                try {
                    $prefix = $dir . '/';
                    $objects = $s3->getIterator('ListObjects', array(
                        "Bucket" => $aws['bucket'],
                        "Prefix" => $prefix
                    ));
                    foreach ($objects as $object) {
                        $key = $object['Key'];
                        // Strip the prefix to get just the filename (the version)
                        if (strpos($key, $prefix) === 0) {
                            $key = substr($key, strlen($prefix));
                        }
                        if ($key != "" && strpos($key, '/') === false && !isScreenshotFile($key) && $key !== 'metadata.json') {
                            // get the url to the file in the bucket
                            $url = $s3->getObjectUrl($aws['bucket'], $prefix . $key);

                            // add to the array and object that contains the url and the version
                            $versions[] = array(
                                'version' => $key,
                                'ref' => canonicalObjectRef($prefix . $key),
                                'url' => $url
                            );

                        }
                    }
                    sitrecAuditResult();
                    echo json_encode($versions);
                    exit();
                } catch (Aws\S3\Exception\S3Exception $e) {
                    http_response_code(503);
                    echo json_encode(['error' => 'Sitch storage unavailable']);
                    exit();
                } catch (Exception $e) {
                    http_response_code(503);
                    echo json_encode(['error' => 'Sitch storage unavailable']);
                    exit();
                }
            }
    }
}
