# File rehosting and object references

Sitrec rehosts files so a saved situation does not depend on a file that exists only on
one user's computer or on a changing external URL. A full-server installation can store
rehosted files either on its own filesystem or in S3-compatible object storage.

## What is rehosted

Two broad classes of file go through this system:

1. **Dynamic external data.** In particular, current and historical satellite orbital
   data (OMM CSV, or legacy TLE) is copied when a situation is saved. Reopening the save
   therefore uses the same element sets rather than whatever the upstream source serves
   later.

   Orbital data is published after the time it describes, so a set downloaded within a
   couple of days of its date may still be incomplete. Rehosting preserves that incomplete
   set. When the owner reopens the situation, Sitrec can offer to merge in data published
   since the save; it does not modify or delete the original copy. See `src/TLERefresh.js`
   and [Saving and Loading](../SavingAndLoading.md#satellite-data-in-a-saved-sitch).
2. **User files.** These include files dropped into Sitrec, files opened from a local
   situation folder, videos, tracks, overlays, screenshots, and saved situation versions.

The browser-side transport is `src/CRehoster.js`; the upload endpoint is
`sitrecServer/rehost.php`.

## Stable object references

Object-storage uploads prefer a host-independent reference over a permanent storage URL:

```text
sitrec://42/My Situation/20260904_120000.js
```

The part after `sitrec://` is the object key. Share links normally put the compact raw key
in the `custom` query parameter instead of exposing the bucket host:

```text
?custom=42/My%20Situation/20260904_120000.js
```

`src/SitrecObjectResolver.js` sends canonical references, raw keys, and compatible legacy
S3 URLs to `sitrecServer/object.php`. The server returns the canonical reference, key,
share value, fetchable URL, and an expiry time when the URL is temporary. This indirection
allows storage hosts and public/private read modes to change without changing saved
situations. Legacy direct URLs remain supported.

A folder reference such as `42/My Situation/` means "the newest `.js` version". Because
that would otherwise reveal an unshared version, only its owner or an administrator may
resolve it. Public share links should contain the complete versioned key.

An exact object key currently acts as a read capability: knowing a valid complete key is
normally enough to ask the resolver for it. `S3_DEFAULT_VISIBILITY=private` controls how
the object is fetched, but does not by itself add per-object authorization. Do not treat a
guessable key as an access-control boundary.

## Upload paths

`CRehoster.rehostFile()` checks the effective size limit, normalizes a trailing space or
dot in the filename, starts the upload, and records the promise. Call
`FileManager.rehoster.waitForAllRehosts()` when subsequent work must wait for every queued
upload.

There are two transports:

- **Server POST.** The browser sends multipart form data to `rehost.php`. The server writes
  it to the filesystem, or streams it into object storage when `SAVE_TO_S3=true`. Upload
  progress is reported with `XMLHttpRequest` events. This is also the only upload path in
  the secure build, which forces `USE_S3_PRESIGNED_URLS=false`.
- **Direct object-storage upload.** When both `SAVE_TO_S3=true` and
  `USE_S3_PRESIGNED_URLS=true`, the browser first asks `rehost.php` for a presigned PUT.
  Files larger than `S3_MULTIPART_THRESHOLD_MB` use presigned multipart uploads with
  `S3_CHUNK_SIZE_MB` per part and up to `S3_PARALLEL_UPLOADS` concurrent transfers. The
  server initiates and completes the multipart upload; the file bytes go directly from the
  browser to storage.

Presigned responses include `objectRef` and a compatibility `objectUrl`; the client stores
the reference when it is present. The server-POST response is a fetch URL, so code that
consumes a rehost result must continue accepting either a reference or a URL.

### Size limits

The server reports the authenticated user's limit from `rehost.php?getuser=1`. The client
uses that value. Server-POST uploads are checked against their actual uploaded size, while
the presigning endpoints check the `fileSize` reported by the client. Members of the
administrator group use `ADMIN_MAX_FILE_SIZE_MB` when it is a positive value. The default
server limit is 100 MB. If the limit is a security boundary, also enforce it in the proxy
or object-storage policy rather than relying only on the direct-upload request metadata.

The server-POST path is also limited by the web stack. Set all applicable limits above
Sitrec's limit, including:

- nginx `client_max_body_size`, or the equivalent request-body limit in another proxy;
- PHP `upload_max_filesize`; and
- PHP `post_max_size` (which must be larger than the complete multipart form request).

Direct presigned uploads avoid those request-body limits, but they do not bypass
`MAX_FILE_SIZE_MB` in the normal Sitrec flow.

The server accepts only a restricted filename character set and rejects executable or
server-configuration extensions. Unversioned uploads are content-addressed by a short
client hash on the presigned path or an MD5 suffix on the server-POST path. Versioned
situation files live under `<user-id>/<situation-name>/<version>`.

## Authentication and user folders

Every upload and delete request resolves identity on the server. User id `0` means
anonymous and is refused. The nonzero id becomes the first path segment of every uploaded
object, so callers cannot choose another user's directory.

`getUserInfoCustom()` in `config/config.php` returns:

```php
['user_id' => $userId, 'user_groups' => $groupIds]
```

The tracked [configuration example](../../config/config.php.example) supports three modes:

- `AUTH_MODE=forum` (the default): use the configured forum session, then
  `SITREC_DEFAULT_USERID`, then the loopback-only development identity;
- `AUTH_MODE=cert`: resolve a mapped X.509 client identity as described in
  [Installing and configuring](Installing-and-configuring.md#client-certificate-authentication);
- `AUTH_MODE=none`: make every request anonymous.

`getUserIDCustom()` is only a wrapper around `getUserInfoCustom()`. A custom installation
may replace the forum branch, but it must derive the user id from authenticated server-side
state. Do not accept a user id supplied by the browser. If rehosting is unavailable, return
user id `0`.

## Filesystem storage

Filesystem storage is selected with:

```dotenv
SAVE_TO_SERVER=true
SAVE_TO_S3=false
```

Files are written beneath the `$UPLOAD_PATH` calculated by
`sitrecServer/config_paths.php`, normally `sitrec-upload/<user-id>/`. The directory must be
writable by the PHP process and served at the matching `$UPLOAD_URL`. Filesystem storage is
local to one server: use shared persistent storage or object storage when more than one app
instance must see the same saves.

## Upload input and generated names

New saved-version and screenshot names retain their sortable timestamp prefix and
append 128 random bits. New share-link codes use 22 alphanumeric characters (over
128 random bits). Unversioned presigned uploads without a content hash also use
128 random bits. Existing object references and shorter share links keep working.
Content-derived names still support deduplication; they are not unpredictable
access tokens and require appropriate access controls when that distinction matters.

Upload JSON requires string filenames and optional string versions/content hashes.
An optional `fileSize` must be a nonnegative JSON integer; the configured size
limit still applies. Multipart initialization accepts integer part counts from 1
through 10,000. Completion requires a nonempty JSON array of at most 10,000 parts,
with strictly increasing integer `PartNumber` values in that range and nonempty
string `ETag` values. These checks reject malformed requests before storage work;
they do not independently measure bytes sent directly to storage. The protocol
bounds follow the [storage service's multipart limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html).

Upload/delete names cannot consist only of dots or spaces. Deleting a single
object version uses an exact key; it does not delete other keys sharing that
version's prefix. Whole-folder deletion remains a separate operation.

## S3-compatible object storage

The PHP AWS SDK is pinned by `sitrecServer/composer.lock`. A bare-metal deployment installs
it from the server directory:

```shell
cd sitrecServer
composer install --no-dev --optimize-autoloader
```

The released container builds `vendor/` from the same lock file, so no runtime Composer
step is needed there.

All endpoints create their client through `getS3Client()` in
`sitrecServer/s3_client.php`. Setting `SAVE_TO_S3=true` selects object storage; it does
**not** fall back to the filesystem when credentials or bucket settings are missing.

### Credential and endpoint settings

| Setting | Default | Purpose |
|---|---|---|
| `SAVE_TO_S3` | `false` | Select object storage instead of filesystem storage. |
| `S3_BUCKET`, `S3_REGION` | example values only | Bucket and region used by every endpoint. |
| `S3_CREDENTIAL_SOURCE` | inferred | `static`, `role`, or `anonymous`. Unset means `static` only when both static keys exist; otherwise `anonymous`. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | example placeholders | Required only for `S3_CREDENTIAL_SOURCE=static`. Prefer a workload role where the platform provides one. |
| `S3_USE_FIPS` | region-dependent | Select the SDK's FIPS S3 endpoint. |
| `S3_ENDPOINT` | empty | Custom S3-compatible endpoint. |
| `S3_USE_PATH_STYLE` | `true` with a custom endpoint | Set `false` if that endpoint requires virtual-hosted bucket URLs. |

A role-based private deployment normally starts with:

```dotenv
SAVE_TO_S3=true
S3_BUCKET="sitrec-data"
S3_REGION="us-west-2"
S3_CREDENTIAL_SOURCE=role
```

Do not also set static keys in that mode. `role` deliberately omits an explicit SDK
credential so the normal provider chain can use a task, instance, or workload role.

### Upload, visibility, and read settings

| Setting | Default | Purpose |
|---|---|---|
| `USE_S3_PRESIGNED_URLS` | `true` | Let the browser upload directly; `false` sends file bytes through `rehost.php`. |
| `S3_MULTIPART_THRESHOLD_MB` | `40` | Files larger than this use multipart upload. |
| `S3_CHUNK_SIZE_MB` | `16` | Part size. Respect the storage service's multipart minimum and maximum part counts. |
| `S3_PARALLEL_UPLOADS` | `8` | Maximum concurrent part uploads. |
| `S3_PRESIGNED_GET_EXPIRY_SECONDS` | `1800` | Lifetime of private read URLs. |
| `S3_PRESIGNED_PUT_EXPIRY_SECONDS` | `900` | Lifetime of a single-part PUT URL. |
| `S3_PRESIGNED_MULTIPART_EXPIRY_SECONDS` | `3600` | Lifetime of each multipart part URL. |
| `S3_DEFAULT_VISIBILITY` | `public` | `public` returns unsigned URLs; `private` returns presigned reads unless reads stay on the server. |
| `S3_PRIVATE_PREFIXES`, `S3_PUBLIC_PREFIXES` | empty | Comma-separated exceptions to the default visibility. |
| `S3_READS_VIA_SERVER` | `false` | Return a same-origin `s3-proxy.php?key=...` URL and stream reads with server credentials. Supports range requests. |
| `S3_PUBLIC_BASE_URL` | empty | Optional public/CDN base used for unsigned object URLs. |
| `S3_ACL` | empty | Legacy default ACL override. |
| `S3_PUBLIC_OBJECT_ACL`, `S3_PRIVATE_OBJECT_ACL` | `public-read`, `private` in the example file | ACL selected from the key's visibility. |

For a private bucket whose browser clients cannot reach the storage endpoint, use:

```dotenv
S3_DEFAULT_VISIBILITY=private
S3_READS_VIA_SERVER=true
USE_S3_PRESIGNED_URLS=false
S3_ACL=
S3_PUBLIC_OBJECT_ACL=
S3_PRIVATE_OBJECT_ACL=
```

The three empty ACL settings are important for buckets with bucket-owner-enforced object
ownership: such buckets reject any upload request that carries an ACL. Reads and writes in
this configuration remain on the application's origin.

For public objects, `s3ObjectUrl()` produces the standard virtual-hosted URL with each key
segment encoded. FIPS and custom endpoints are resolved through the SDK, and
`S3_PUBLIC_BASE_URL` overrides the public base. Private reads use the resolver and a
short-lived GET URL unless `S3_READS_VIA_SERVER=true`.

### CORS for direct browser uploads

`USE_S3_PRESIGNED_URLS=true` requires bucket CORS. Allow the Sitrec origin to perform
`PUT`, `GET`, and `HEAD`, allow the request headers used by uploads, and expose `ETag`;
multipart completion cannot work if browser JavaScript cannot read each part's ETag. A
minimal AWS-style rule is:

```json
[
  {
    "AllowedOrigins": ["https://sitrec.example.org"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use the exact application origin rather than `*`. No bucket CORS rule is needed when both
uploads and reads stay on the application server.

## Verification

1. Request `sitrecServer/rehost.php?getuser=1` while logged in. Confirm a nonzero `userID`,
   the expected groups, and `maxFileSizeMB`.
2. Upload a small file and a file above the multipart threshold (when direct uploads are
   enabled). Confirm both complete and reload.
3. Inspect the saved situation: new direct-object-storage uploads should use a
   `sitrec://...` reference rather than a bucket hostname.
4. Resolve the reference through `sitrecServer/object.php?ref=...` and check whether the
   returned URL is public, presigned, or same-origin as configured.
5. Seek within a rehosted video. This exercises range requests, including the
   `s3-proxy.php` path.
6. Verify an unauthenticated upload is refused and that one user cannot upload to or delete
   another user's prefix.

The focused implementation tests are `tests/SitrecObjectResolver.test.js`,
`tests/s3ClientConfig.test.js`, and `tests/s3ReadsViaServer.test.js`.
