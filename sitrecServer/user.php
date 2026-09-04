<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/audit.php';

// Cached wrapper around getUserInfoCustom() (defined in config.php).
// getUserInfoCustom() must only be called once per request because
// re-initializing XenForo in the same PHP process crashes it.
function getCachedUserInfoCustom() {
  static $cached = null;
  if ($cached !== null) return $cached;
  $cached = getUserInfoCustom();
  sitrecAuditIdentity($cached);
  return $cached;
}

// Check if the current user is admin (group 3) based on their real identity
function isAdmin($userInfo = null) {
  if ($userInfo === null) {
    $userInfo = getCachedUserInfoCustom();
  }
  $groups = is_array($userInfo['user_groups'] ?? null) ? $userInfo['user_groups'] : [];
  return in_array(3, $groups);
}

function getUserID() {
  $info = getUserInfo();
  return $info['user_id'];
}

function getUserInfo() {
  static $cached = null;
  if ($cached !== null) return $cached;

  $info = getCachedUserInfoCustom();
  // Allow admin to operate as another user via testUserID parameter
  $testUserID = isset($_GET['testUserID']) ? intval($_GET['testUserID']) : 0;
  if (isAdmin($info) && $testUserID > 1) {
    $info['user_id'] = $testUserID;
    sitrecAuditIdentity(getCachedUserInfoCustom(), $info);
    sitrecAuditWrite('authorization.impersonation', 'accepted', 'administrator');
  } elseif ($testUserID > 1) {
    sitrecAuditWrite('authorization.impersonation', 'denied', 'administrator_required');
  }
  $cached = $info;
  return $info;
}


// get a short directory unique to the user, OR an empty string if the user is not logged in
// this is used for the user's directory in the upload folder
// or will be the full path in an S3 bucket
function getShortDir($user_id)
{
    if ($user_id == 0) {
        return ""; // return an empty string if the user is not logged in
    }

    // convert user id to a string, as it might be an integer at this point
    $userDir = strval($user_id);


    return $userDir;
}

// return a directory unique to the user, OR an empty string if the user is not logged in
// does NOT create the directory, which you can do with:
//     if (!file_exists($userDir)) {
//        mkdir($userDir, 0777, true);
//    }
//
function getUserDir($user_id)
{
    global $UPLOAD_PATH;
    if ($user_id == 0) {
        return ""; // return an empty string if the user is not logged in
    }

// Directory to store rehosted files
    $userDir = $UPLOAD_PATH . getShortDir($user_id) . '/';

    return $userDir;
}
