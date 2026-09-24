# Reference Objects

Sitrec uses object references for files stored by a full-server installation. A reference
identifies an object without permanently embedding the storage bucket or host in a saved
situation.

For example, the canonical internal form is:

```text
sitrec://42/My Situation/20260904_120000.js
```

A share link normally uses the same object key without the `sitrec://` prefix:

```text
?custom=42/My%20Situation/20260904_120000.js
```

This indirection lets an installation change storage hosts or issue temporary read URLs
without invalidating saved sitches and share links.

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
cached for the rest of the session. A private object can therefore
use a short-lived signed URL while a public object can use a stable URL. Callers use
`resolveURLForFetch()` rather than depending on either storage form.

## Saving and sharing

New object-storage uploads prefer the `objectRef` returned by the server. Compatibility
responses may also include an `objectUrl`, and older saved sitches with direct URLs remain
loadable.

A complete, versioned key is the right value for a public share link. A folder reference
means "latest version". For a public folder, anyone with the link gets the newest public
version; private versions in the folder are skipped, so a shared folder URL does not reveal a
newer version that is private. A private folder resolves only for its owner or an
administrator, who always get the newest version.

For the complete upload, storage, and configuration contract, see [File Rehosting and
Object References](dev/FileRehosting.md).

## Security boundary

An exact object key currently acts as a read capability: knowing a valid complete key is
normally enough to ask the resolver for it. Choosing private object-storage visibility
changes how the bytes are delivered, but does not by itself create per-object user
authorization. Do not use a guessable key as an access-control boundary.

Folder references to private folders are more restricted, as described above. Upload and deletion requests
also require an authenticated nonzero user and are constrained to that user's prefix.

## Serverless and local files

Static serverless deployments have no `object.php` resolver and no server-side object
store. Use **File → Local** to save and open sitches with local assets. A raw object key
from a full-server share link requires that server's resolver; copying only the key into an
unrelated static deployment does not make the stored object available there.

The included `standalone-serverless.js` helper deliberately returns errors for unsupported
server operations instead of pretending that server objects were saved in browser
storage.
