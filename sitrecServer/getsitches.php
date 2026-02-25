<?php

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
    echo json_encode(getSitches());
    exit();
}

// Handle latestversion BEFORE authentication - returns just the latest .js filename
if (isset($_GET['get']) && $_GET['get'] == "latestversion") {
    if (!isset($_GET['userid']) || !isset($_GET['name'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing userid or name parameter']);
        exit();
    }
    
    $publicUserID = $_GET['userid'];
    $name = $_GET['name'];
    
    if (!preg_match('/^\d+$/', $publicUserID)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid userid parameter']);
        exit();
    }
    
    if (!preg_match(SITCH_NAME_PATTERN, $name)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid name parameter']);
        exit();
    }
    $name = basename($name);
    
    $publicDir = $publicUserID . "/" . $name;
    $latestFile = null;
    
    if (!$useAWS) {
        global $UPLOAD_PATH;
        $localDir = $UPLOAD_PATH . $publicDir;
        if (!is_dir($localDir)) {
            echo json_encode(['latest' => null]);
            exit();
        }
        $files = scandir($localDir);
        foreach ($files as $file) {
            if (is_file($localDir . '/' . $file) && preg_match('/\.js$/', $file)) {
                if ($latestFile === null || $file > $latestFile) {
                    $latestFile = $file;
                }
            }
        }
        echo json_encode(['latest' => $latestFile]);
        exit();
    } else {
        require 'vendor/autoload.php';
        global $s3creds;
        if (!isset($s3creds) || !is_array($s3creds) || empty($s3creds['accessKeyId'])) {
            http_response_code(503);
            echo json_encode(['error' => 'Storage not configured']);
            exit();
        }
        $aws = $s3creds;
        $credentials = new Aws\Credentials\Credentials($aws['accessKeyId'], $aws['secretAccessKey']);
        $s3 = new Aws\S3\S3Client([
            'version' => 'latest',
            'region' => $aws['region'],
            'credentials' => $credentials
        ]);
        try {
            $objects = $s3->getIterator('ListObjects', array(
                "Bucket" => $aws['bucket'],
                "Prefix" => $publicDir . "/"
            ));
            foreach ($objects as $object) {
                $key = $object['Key'];
                $filename = str_replace($publicDir . "/", "", $key);
                if ($filename != "" && strpos($filename, '/') === false && preg_match('/\.js$/', $filename)) {
                    if ($latestFile === null || $filename > $latestFile) {
                        $latestFile = $filename;
                    }
                }
            }
            echo json_encode(['latest' => $latestFile]);
            exit();
        } catch (Exception $e) {
            http_response_code(503);
            echo json_encode(['error' => 'Storage error']);
            exit();
        }
    }
}

// if there's a "get" parameter then it depends on the value of the "get" parameter
// if it's "myfiles", then return a list of the files in the local folder

if (isset($_GET['get'])) {
    require('./user.php');

    $userID = getUserID();
    $dir = getUserDir($userID);

    if ($dir == "") {
        // return an empty array if the user is not logged in
        echo json_encode(array());
        exit();
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

        require 'vendor/autoload.php';

        $aws = $s3creds;

        // Get it into the right format
        $credentials = new Aws\Credentials\Credentials($aws['accessKeyId'], $aws['secretAccessKey']);

        // Create an S3 client
        $s3 = new Aws\S3\S3Client([
            'version' => 'latest',
            'region' => $aws['region'],
            'credentials' => $credentials
        ]);

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
                    echo json_encode(array());
                    exit();
                }
                $files = @scandir($dir);
                if ($files === false) {
                    echo json_encode(array());
                    exit();
                }
                $folders = array();
                foreach ($files as $file) {
                    if (is_dir($dir . '/' . $file) && $file != '.' && $file != '..' && $file != '.DS_Store') {
                        $sitchPath = $dir . '/' . $file;
                        $versions = @scandir($sitchPath);
                        $newestTime = 0;
                        if ($versions !== false) {
                            foreach ($versions as $v) {
                                if ($v !== '.' && $v !== '..' && is_file($sitchPath . '/' . $v)) {
                                    $vTime = @filemtime($sitchPath . '/' . $v);
                                    if ($vTime > $newestTime) {
                                        $newestTime = $vTime;
                                    }
                                }
                            }
                        }
                        $lastDate = $newestTime ? date('Y-m-d H:i:s', $newestTime) : '1970-01-01 00:00:00';
                        $folders[] = [$file, $lastDate];
                    }
                }
                echo json_encode($folders);
                exit();
            } catch (Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'Server error: ' . $e->getMessage()]);
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
                        
                        if (!isset($folderDates[$folderName]) || $lastDate > $folderDates[$folderName]) {
                            $folderDates[$folderName] = $lastDate;
                        }
                    }
                }
                
                $folders = array();
                foreach ($folderDates as $name => $date) {
                    $folders[] = [$name, $date];
                }
                echo json_encode($folders);
                exit();
            } catch (Aws\S3\Exception\S3Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'S3 error: ' . $e->getMessage()]);
                exit();
            } catch (Exception $e) {
                http_response_code(503);
                echo json_encode(['error' => 'Server error: ' . $e->getMessage()]);
                exit();
            }
        }


    } else if ($_GET['get'] == "validate_names") {
        global $UPLOAD_PATH;
        $invalid = array();
        $pattern = SITCH_NAME_PATTERN;
        
        if (!$useAWS) {
            if (is_dir($UPLOAD_PATH)) {
                $userDirs = @scandir($UPLOAD_PATH);
                if ($userDirs !== false) {
                    foreach ($userDirs as $userDir) {
                        if ($userDir == '.' || $userDir == '..') continue;
                        $userPath = $UPLOAD_PATH . $userDir;
                        if (!is_dir($userPath)) continue;
                        
                        $sitchDirs = @scandir($userPath);
                        if ($sitchDirs !== false) {
                            foreach ($sitchDirs as $sitchDir) {
                                if ($sitchDir == '.' || $sitchDir == '..') continue;
                                if (!is_dir($userPath . '/' . $sitchDir)) continue;
                                
                                if (!preg_match($pattern, $sitchDir)) {
                                    $invalid[] = ['user' => $userDir, 'name' => $sitchDir];
                                }
                            }
                        }
                    }
                }
            }
        } else {
            $objects = $s3->getIterator('ListObjects', array(
                "Bucket" => $aws['bucket'],
                "Prefix" => ''
            ));
            $seen = array();
            foreach ($objects as $object) {
                $key = $object['Key'];
                $parts = explode('/', $key);
                if (count($parts) >= 2 && $parts[0] != '' && $parts[1] != '') {
                    $userDir = $parts[0];
                    $sitchDir = $parts[1];
                    $seenKey = $userDir . '/' . $sitchDir;
                    if (!isset($seen[$seenKey])) {
                        $seen[$seenKey] = true;
                        if (!preg_match($pattern, $sitchDir)) {
                            $invalid[] = ['user' => $userDir, 'name' => $sitchDir];
                        }
                    }
                }
            }
        }
        echo json_encode(['invalid' => $invalid, 'pattern' => $pattern]);
        exit();

    } else if ($_GET['get'] == "versions") {
            $name = $_GET['name'];
            
            // SECURITY: Validate name to prevent path traversal
            if (!preg_match(SITCH_NAME_PATTERN, $name)) {
                http_response_code(400);
                echo json_encode(['error' => 'Invalid name parameter']);
                exit();
            }
            $name = basename($name); // Extra safety: strip any path components
            
            $dir .= "/" . $name;
            $versions = array();
            if (!$useAWS) {
                $files = scandir($dir);
                foreach ($files as $file) {
                    if (is_file($dir . '/' . $file) && $file != '.' && $file != '..' && $file != '.DS_Store') {
                        $url = $storagePath . $userID . '/' . $name. '/' . $file;
                        // add to the array and object that contains the url and the version
                        $versions[] = array('version' => $file, 'url' => $url);
                    }
                }
                echo json_encode($versions);
                exit();
            } else {
                // get the list of files in the S3 bucket
                try {
                    $objects = $s3->getIterator('ListObjects', array(
                        "Bucket" => $aws['bucket'],
                        "Prefix" => $dir
                    ));
                    foreach ($objects as $object) {
                        $key = $object['Key'];
                        // we need to strip off the full dir prefix to get the filename (the version)
                        $key = str_replace($dir, "", $key);
                        if ($key != "") {
                            // get the url to the file in the bucket
                            $url = $s3->getObjectUrl($aws['bucket'], $dir . $key);

                            // add to the array and object that contains the url and the version
                            $versions[] = array('version' => $key, 'url' => $url);

                        }
                    }
                    echo json_encode($versions);
                    exit();
                } catch (Aws\S3\Exception\S3Exception $e) {
                    http_response_code(503);
                    echo json_encode(['error' => 'S3 error: ' . $e->getMessage()]);
                    exit();
                } catch (Exception $e) {
                    http_response_code(503);
                    echo json_encode(['error' => 'Server error: ' . $e->getMessage()]);
                    exit();
                }
            }
    }
}
