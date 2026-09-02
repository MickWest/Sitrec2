<?php
// SECURITY: Require admin access for S3 test endpoint
// Note, invoking getUserID() will initialize XenForo, which means the S2 code
// will try to use XenForo's version of guzzle, which is currently 6.5.5
// but the S3 code WAS using 7
// so we need to make sure the S3 code is using the same version of guzzle as XenForo
// to do this I force the version of guzzle to be 6.5.5 in the composer.json file
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require('./user.php');

$userInfo = getUserInfo();
if (!isAdmin($userInfo)) {
    http_response_code(403);
    die('Admin access required');
}

$user_id = $userInfo['user_id'];


// just test if we can connect to S3
require_once __DIR__ . '/s3_client.php';


$aws = $s3creds;

$s3 = getS3Client();

// create a 100-byte file
// and upload it to S3
$filename = 'test.txt';
$contents = str_repeat('x', 100);
$s3->putObject([
    'Bucket' => $aws['bucket'],
    'Key' => $filename,
    'Body' => $contents
]);


echo "Connected to S3";
?>