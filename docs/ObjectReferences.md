# Object References

This page is for people who run a Sitrec server or write code for it. It explains how a
saved sitch and a share link point to stored files. To save or share a sitch, see
[Saving and Loading Sitches](SavingAndLoading.md). For 3D objects in a scene, see
[Adding Objects and Tracks](SceneObjects.md).

An object reference identifies a stored file without embedding the storage bucket or host
in a saved sitch. An installation that uploads directly to object storage
(`SAVE_TO_S3=true` and `USE_S3_PRESIGNED_URLS=true`) stores references. The canonical
internal form is:

```text
sitrec://42/My Situation/20260904_120000_0123456789abcdef0123456789abcdef.js
```

The share link for that save uses the same object key without the `sitrec://` prefix:

```text
?custom=42/My%20Situation/20260904_120000_0123456789abcdef0123456789abcdef.js
```

For these saves, the indirection lets an installation change storage hosts or issue
temporary read URLs without invalidating saved sitches and share links.

Other uploads store a direct URL. This includes filesystem storage, which is the default.
The link made by a save then carries that URL. The URL stays tied to its location, so a
storage move breaks it. A compatible S3 URL is the exception: the resolver recognises it,
so the share link carries the key and a storage move does not break it. A sitch opened
from **File → Server → Open** or **File → Server → Versions** gets a link with the key on
all server storage, because the version list gives a reference for each version.

## Forms Sitrec accepts

The resolver recognises:

- a canonical `sitrec://<key>` reference;
- a raw key beginning with a numeric user id, such as `42/My Situation/file.js`;
- a compatible legacy S3 URL whose path contains such a key; and
- a folder key ending in `/`, which asks for that folder's newest `.js` version.

Ordinary `https://` URLs that are not recognised storage references remain ordinary URLs.
Sitrec does not route every external URL through its object resolver.

## Resolution

When Sitrec needs the bytes behind a reference, `src/SitrecObjectResolver.js` sends the
canonical reference to `sitrecServer/object.php`. The endpoint returns JSON containing:

- `ref`, the canonical reference;
- `key` and `shareValue`, the decoded object key and compact share value;
- `url`, a fetchable URL;
- `expiresAt`, an expiry time when the URL is temporary; and
- `version`, the file name of the resolved version.

The browser caches that result until 30 seconds before it expires; a URL with no expiry is
cached until the page reloads. A private object can therefore
use a short-lived signed URL while a public object can use a stable URL. Callers use
`resolveURLForFetch()` or `resolveSitrecReference()` rather than depending on either
storage form.

Public and private are installation settings. `S3_DEFAULT_VISIBILITY` sets the default,
which is `public`. `S3_PRIVATE_PREFIXES` and `S3_PUBLIC_PREFIXES` set exceptions by key
prefix. A user cannot change this in the app. The **Private** label in the **Open** dialog
only hides a sitch from the other views of that dialog. It does not change storage
visibility, so share links and folder links to that sitch work as before.

## Saving and sharing

A direct object-storage upload returns an `objectRef` and an `objectUrl`, and Sitrec stores
the `objectRef`. An upload that sends its bytes through `rehost.php` returns only a URL, and
Sitrec stores that URL. Older saved sitches with direct URLs remain loadable.

A complete, versioned key is the right value for a public share link. A folder reference
means "latest version". For a public folder, anyone with the link gets the newest public
version; private versions in the folder are skipped, so a shared folder URL does not reveal a
newer version that is private. A private folder resolves only for its owner or an
administrator, who always get the newest version.

Folders are public by default. A versioned link contains its folder key, and that key has
no random part. A person with a versioned link can write that folder key as
`?custom=42/My%20Situation/` and open the newest public version of that sitch, with no
login.

For the complete upload, storage, and configuration contract, see [File rehosting and
object references](dev/FileRehosting.md).

## Security boundary

Anyone who has the complete key of an object, for example in a share link, can normally
read it, even when the installation stores that object as private. Choosing private
object-storage visibility changes how the bytes are delivered, but does not by itself
create per-object user authorization. Do not use a guessable key as an access-control
boundary. New saved version names end in 128 random bits. Older names have fewer random
bits, or only a timestamp.

Folder references to private folders are more restricted, as described above. Upload and deletion requests
also require an authenticated nonzero user and are constrained to that user's prefix.

## Serverless and local files

Static serverless deployments have no `object.php` resolver and no server-side object
store. Use **File → Local** to save and open sitches with local assets. A raw object key
from a full-server share link requires that server's resolver; copying only the key into an
unrelated static deployment does not make the stored object available there.

The included `standalone-serverless.js` helper is one of these deployments. It serves the
static build, and it has no `object.php` route and no upload service.
