# Rehosting files in Sitrec

## Introduction

In Sitrec two type of files are rehosted

1. *Dynamic Links* - Specifically links to satellite orbital data (OMM CSV, or legacy TLE). Both current and historical sets are rehosted on save, so a sitch reopens with exactly the elements it was saved with rather than depending on an external data source.

   One consequence is worth knowing: orbital data is published a while *after* it applies, so a set downloaded within a couple of days of the date it covers is only partly filled in, and rehosting freezes it in that state. On reopening a sitch they own, users are offered a merge of the now-complete data — see `src/TLERefresh.js`, and [Saving and Loading](../SavingAndLoading.md#satellite-data-in-a-saved-sitch) for the user-facing description. The original rehosted file is never modified or deleted, so older versions of a sitch keep resolving.
2. *User files* - The user can drag-and-drop file, or open a local sitch folder, or manually uploaded a file for rehosting

Sitrec has a JavaScript client (95% of the code) and a PHP backend. The Metabunk implementation also makes some use of the Xenforo forum software for user authentication. 

## How the Client uploads

Uploading is initiated from the client via a CRehoster object in CRehoster.js, this encapsulates a call to rehost.php on the server and handles returning the response

```javascript
            let formData = new FormData();
            formData.append('fileContent', new Blob([data]));
            formData.append('filename', filename);

            const serverURL = SITREC_SERVER + 'rehost.php?unique=' + Date.now();

            // The simple-POST path uploads via XMLHttpRequest so it can report
            // upload-progress events (rather than a plain fetch).
            const xhr = new XMLHttpRequest();
            xhr.open('POST', serverURL);
            xhr.send(formData);  // Send FormData with file and filename
```

This is called via FileManager.rehoster.rehostFile, which returns a promise. Before queuing the promise it enforces a client-side size limit (MAX_FILE_SIZE_MB, with the ADMIN_MAX_FILE_SIZE_MB override for admins) and trims any trailing space/dot from the filename
```javascript
    rehostFile(filename, data, version, options) {
        // ... size-limit check + filename sanitization ...
        var promise = this.rehostFilePromise(filename, data, version, options)
        this.rehostPromises.push(promise);
        return promise;
    }
```

You can use the promise returned by the function FileManager.rehoster.waitForAllRehosts() to ensure it has all been uploaded. 

Currently, error handling is minimal.


The simple-POST path is limited by two variables:
 - **client_max_body_size** in the Nginx .conf file (or Apache equivalent)
 - **upload_max_filesize** in php.ini (e.g in /etc/php/8.3/fpm/php.ini)

In the Metabunk implementation, these are both set to 100M.

Large files can instead use an S3 presigned-URL / multipart-upload path (gated by `SAVE_TO_S3` + `USE_S3_PRESIGNED_URLS`, with the multipart size threshold set by `S3_MULTIPART_THRESHOLD_MB`), which uploads directly to S3 and so bypasses the simple-POST size limit. See rehost.php (`action=getPresignedUrl` / `initiateMultipart` / `completeMultipart`).

Regardless of the path, there is also a client-side cap **MAX_FILE_SIZE_MB** (with an **ADMIN_MAX_FILE_SIZE_MB** override for admins) enforced in `CRehoster.rehostFile()` before any upload.

## Server Rehosting Configuration

The server can be configured to either rehost to the server's filesystem or to an S3 bucket. Both methods will return a URL that resolves to the file. 


### User authentication and User Upload Folders

To upload a file, the user must be authenticated. This is done by a function that returns a user ID. The ID can be a number, or a string. This ID is used as the name of the user's upload folder. Each user can only upload to their own folder, so determination of the ID is entirely server-side. 

A custom authentication method can be implemented with a function getUserInfoCustom() in config.php, which returns an array with the user ID and the user's groups (user_id = 0 if not logged in). getUserIDCustom() is a thin wrapper that just returns its user_id. For example, this is the Metabunk authenticator. 
```php
function getUserIDCustom()
{
    $info = getUserInfoCustom();
    return $info['user_id'];
}

// Returns user ID and user groups
// Groups example: admin=3, registered=2, verified=9, sitrec=14
function getUserInfoCustom()
{
    // a default user id for testing
    // and for if there's no xenforo
    $user_id = 0; // default to not logged in
    $user_groups = [];

    // More secure localhost check
    $isLocalhost = ($_SERVER['REMOTE_ADDR'] === '127.0.0.1' ||
                    $_SERVER['REMOTE_ADDR'] === '::1');

    $fileDir = getenv('XENFORO_PATH');
    if ($fileDir) {
        // check if the file exists
        $xf_file = $fileDir . 'src/XF.php';
        if (file_exists($xf_file)) {
            require($xf_file);
            XF::start($fileDir);
            $app = XF::setupApp('XF\Pub\App');
            $app->start();
            $user = XF::visitor();
            $user_id = $user->user_id;

            // Get user groups (primary + secondary)
            $user_groups = [$user->user_group_id];
            if (!empty($user->secondary_group_ids)) {
                $user_groups = array_merge($user_groups, $user->secondary_group_ids);
            }
        }
    }

    // If not authenticated, use SITREC_DEFAULT_USERID env var (defaults to 0 = not logged in)
    if ($user_id == 0) {
        $defaultUserId = getenv('SITREC_DEFAULT_USERID');
        if ($defaultUserId !== false && $defaultUserId !== '') {
            $user_id = intval($defaultUserId);
            // ... optionally read SITREC_DEFAULT_USER_GROUPS ...
        } elseif ($isLocalhost) {
            $user_id = 99999999;
        }
    }

    return ['user_id' => $user_id, 'user_groups' => $user_groups];
}
```
The user id defaults to 0 (not logged in, which disables file rehosting). When deployed, the Xenforo forum framework (i.e. the software that runs Metabunk.org) supplies the real user id and groups (assuming the user is logged in). For non-authenticated requests it falls back to the user id set by the SITREC_DEFAULT_USERID env var, and only uses 99999999 as a local-testing fallback (localhost detected via REMOTE_ADDR, not the spoofable HTTP_HOST). 

Supplying a getUserInfoCustom() is required in config.php — it returns the user_id (plus user_groups, used for admin/role checks); getUserIDCustom() just returns its user_id. Returning 0 means they are not logged in. If you don't have rehosting of files available, then return 0.

### Filesystem Rehosting

Filesystem rehosting is the default and has no additional configuration. The uploaded file is stored in the sitrec-upload/<UserID> folder which needs to be writable)

### AWS S3 Rehosting

S3 requires the AWS PHP SDK installed. This can be installed using Composer, which means you have to install composer, e.g.
```shell
apt-get install composer
```

Then in the sitrecServer folder, where you should have a **composer.json** and a **composer.lock** file, run 
```shell
composer install
```
This will install the AWS SDK in a folder called vendor. (Use `composer update` only when you intentionally want to upgrade the locked dependency versions.) 

Configuring the AWS S3 connection is done with a set of credentials. These are set in config/shared.env, for example:

```shell
SAVE_TO_S3=true
S3_ACCESS_KEY_ID="Aasd...6D6"
S3_SECRET_ACCESS_KEY="GRF...sKyX"
S3_REGION="us-west-2"
S3_BUCKET="sitrec"
S3_ACL="public-read"
```
if you don't supply these credentials file then the server will just attempt to use the filesystem rehosting.

See shared.env for additional configuration.

Every server endpoint builds its S3 client in one place, `sitrecServer/s3_client.php`
(`getS3Client()`), from the `S3_*` settings. Besides the static keys above it supports
role credentials (`S3_CREDENTIAL_SOURCE=role`, no keys in the configuration), FIPS
endpoints (`S3_USE_FIPS`) and a custom endpoint (`S3_ENDPOINT`, `S3_USE_PATH_STYLE`);
they are described in
[Installing and configuring](Installing-and-configuring.md#object-storage-in-another-partition-or-with-role-credentials).
The unsigned URL that rehosting returns for a public object comes from `s3ObjectUrl()`
in the same file: `https://<bucket>.s3.<region>.amazonaws.com/<key>` (each key segment
URL-encoded) for a standard region, or the SDK's resolved endpoint when a FIPS or custom
endpoint is configured. `S3_PUBLIC_BASE_URL` still overrides the public base for a CDN.
