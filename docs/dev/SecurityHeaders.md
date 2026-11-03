# Security Headers

This page is for operators who run a Sitrec site. It lists the HTTP response headers Sitrec
sets, the headers you must set yourself, and why the split falls where it does.

Response headers are attached by whatever terminates the request — your nginx, Apache,
Caddy, load balancer or CDN. Most of that is outside this repository. Sitrec sets headers
only where it *is* the server: the published container image, and the two Node servers it
ships.
On a normal install behind your own web server, **every header below is yours to
configure**, and nothing in a Sitrec build can do it for you.

## What Sitrec sets by default

| Header | Value | Where |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | published container image (Apache), `standalone-server.js`, `standalone-serverless.js` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | same three |

Only these two go on every response, and both were chosen because they cannot break a
feature on any deployment. The container adds the path-specific headers in the next two
sections.

**`nosniff`** stops a browser second-guessing a declared `Content-Type`. That matters here
more than in an ordinary app, because Sitrec serves user-supplied files back to the page —
imported tracks, videos, images and rehosted uploads.

**`Referrer-Policy`** is already Chrome's default, so it changes nothing there and improves
browsers that still send a full URL cross-origin. It is worth setting explicitly because a
Sitrec URL is not opaque: its query string carries the sitch name or the address of a saved
sitch or video, and it can carry a position (`?latlon=`) and a date (`?datetime=`). A full
referrer tells every third-party host where the user was looking.

`tests/securityHeaders.test.js` asserts all three servers agree, and that the Apache conf is
both installed *and* enabled with `mod_headers` loaded — a `Header` directive in a conf that
was never enabled reads exactly like a working control and sets nothing.

The [secure build](Secure-Build.md) is what `npm run build-secure` makes. Its application
page also sets `<meta name="referrer" content="no-referrer">`. This suppresses the hostname
as well as the path/query on requests originating from that page. Other HTML pages and
directly served content still need the operator's response-header policy; a meta tag on the
app page does not configure the whole server. Standard builds, which are all other builds,
retain their existing referrer behavior.

Every built application page carries a Content Security Policy (CSP) meta tag:
`object-src 'none'; base-uri 'none'; form-action 'self'`. A CSP response header applies
in addition to this tag and cannot relax it. Sitrec uses document-relative URLs and does
not need a base element. The `csp` default in `deploy/aws/variables.tf` uses the same
directives. This small meta policy does not replace a complete deployment CSP.

## Cache headers

The published image also sets `Cache-Control` on the application files at the web root, by
file name (`docker/cache-headers.conf`):

| Files | Value | Why |
|---|---|---|
| Hashed names: `name.<hash>.bundle.js`, `<hash>.js`, `<hash>.wasm`, `name.<hash>.css` | `public, max-age=31536000, immutable` | A new build gets a new name, so the content never changes under the URL |
| `index.html` (and the directory request), `index.css`, `app-entry.json`, `build-info.json`, `sitrec-runtime-env.js`, `sitrec-channel-config.js` | `no-cache` | The name stays the same at each release, so the browser must check before use |

`no-cache` does not stop caching. The browser keeps its copy and checks it; an unchanged
file costs one `304 Not Modified`.

**Without a header on `index.html`, a release can stop Sitrec starting.** The browser
guesses how long the page stays fresh from its `Last-Modified` date, and can reuse the
previous release's page for hours. That page names the previous bootstrap bundle, which
the new release no longer has. The `<meta http-equiv="Cache-Control">` tag in the page
does not prevent this: browsers ignore it for HTTP caching.

Only files directly in the web root match, so a hash-like name uploaded to
`sitrec-upload/` is not cached for a year. A 404 gets no cache header.

If you serve a production build from your own web server, set the same two rules for the
application's own directory only, not for uploads or server endpoints below it. A CDN in
front can also add or override browser cache times, so check the response it sends, not
only the origin's.

## Uploaded and cached files

The same conf sends this on every file under `sitrec-upload/` and `sitrec-cache/`:

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
```

These are files that users uploaded or that the server fetched from other hosts, served
from the application's origin. `rehost.php` refuses SVG and similar uploads and stores HTML
as `.txt`, but Sitrec imports XML and KML, which a browser also renders as a page that can
run script. The sandbox gives such a page its own origin and no script. It does not affect
the application: Sitrec reads these files with `fetch()`, `<img>` and `<video>`, and a
policy on a fetched file applies only when that file is opened as a page. It is not the
site-wide policy discussed below. If you serve these directories from your own web server,
set the same header for them.

## What Sitrec deliberately does not set

Each of these needs a decision about *your* deployment. Two of them break features outright
if set carelessly, which is the reason none ships as a default. The exception is the
Terraform module in `deploy/aws/`, which sets `Strict-Transport-Security`, `X-Frame-Options`
and a CSP on the load balancer.

### Permissions-Policy — will disable features if you get it wrong

**Sitrec uses device orientation, the microphone and geolocation.** AR mode (`src/ARMode.js`)
uses device orientation. The [spoken assistant](../AIAssistant.md)
(`src/voice/CVoiceSession.js`) uses the microphone. The Starlink Flare Predictor
(`tools/shf/`) uses the browser's Geolocation API. A restrictive policy turns these off.
AR mode then gets no orientation data and shows no error. The assistant asks the user to
allow the microphone, which the user cannot do. The predictor asks the user to enter a place.

**Geolocate from IP Address** in the main application does not use the Geolocation API. It asks
ipapi.co for an approximate position, so `connect-src` controls it, not this header.

If you set one, allow what the app uses:

```
Permissions-Policy: geolocation=(self), gyroscope=(self), accelerometer=(self), magnetometer=(self), microphone=(self), camera=(), payment=()
```

### Strict-Transport-Security — applies to the whole host

HSTS is not scoped to a path. Setting it on `example.org/sitrec` commits `example.org`
entirely, including everything else served from that name, for the whole `max-age`. That is
the operator's decision about their domain, not an application's decision about its path.
It also cannot be undone quickly — a browser that has seen it will honour it until it
expires.

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Set it once you are certain every host and subdomain is HTTPS-only.

### X-Frame-Options / frame-ancestors — depends on whether you embed

If Sitrec is only ever opened directly, deny framing. If you embed it in your own pages,
allow your own origin. If known sites embed your instance, list their origins in
`frame-ancestors`. If anyone may embed it, do not set this header.

```
Content-Security-Policy: frame-ancestors 'self';
```

Prefer `frame-ancestors` over the older `X-Frame-Options`; set both only if you need to
support browsers that do not implement CSP.

Note that WebMCP tool discovery does not work in an embedded frame — see
[WebMCP](../WebMCP.md) — so a deployment relying on that should open Sitrec top-level
regardless.

### Content-Security-Policy — the highest value and the most work

A CSP is the header most worth having and the one most likely to break the globe if it is
wrong. Sitrec loads map tiles, elevation, 3D tiles and optionally an AI endpoint, and
*which* hosts depends entirely on what you configured. There is no single correct policy to
ship. The `csp` default in `deploy/aws/variables.tf` is a starting point: it allows no
outside host. Section 8.1 of
[Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md#81-load-balancer)
explains its directives.

**The allow-list is the input.** `scripts/egress-allowlist.json` lists the destinations
Sitrec is designed to call, with the purpose and trigger of each. The
[user-data egress check](../UserDataEgressCheck.md) reads it on every push to `main`. Use it
to build `connect-src`. Leave out entries that the page never fetches: links the user opens,
hosts that only the server contacts, and the XML namespaces marked `never requested`. Add
your own map, elevation and model sources, because the file cannot list them. A restricted
`connect-src` also stops `?custom=` from loading a sitch from a host you did not list.

Any policy must also allow for these:

- The image decoders and OpenCV use **WebAssembly**, and several features start
  **web workers** from `blob:` URLs. A policy needs `'wasm-unsafe-eval'` in `script-src` and
  `blob:` in `worker-src`.
- The control panel library injects a `<style>` element with an embedded font. `style-src`
  needs `'unsafe-inline'`, or the whole page has no styling, and `font-src` needs `data:`.
- Map tiles arrive by `fetch()` and are then shown from a `blob:` URL. The tile hosts go in
  `connect-src`. `img-src` must include `blob:`, or the map has no imagery, and `data:` for
  generated textures.
- If saved sitches are in object storage and `S3_READS_VIA_SERVER` is off, the browser reads
  them from the storage host. That host goes in `connect-src` and `img-src`: the sitch browser
  shows screenshots with `<img>`, and ground overlays load as images.
- `connect-src` needs `blob:` for 3D models that embed their textures.
- OpenCV also compiles code from strings in the page. If the page's `script-src` has no
  `'unsafe-eval'`, OpenCV does not start, so the features that use it do not run, among them
  Motion Analysis and the Motion (Background) and Template Match tracking methods. Sending
  the policy with HTML responses only does not change this.
- [Scripted Camera Moves](../ScriptedVideo.md) compiles each script in a worker, and that
  worker takes its policy from the response for its own file. If the server sends the policy
  on every response and `script-src` has no `'unsafe-eval'`, scripts do not run. To make
  scripts run, add `'unsafe-eval'`, or send the policy with HTML responses only, which leaves
  worker files with no policy.
- The `deploy/aws/` load balancer sends its default policy on every response, with no
  `'unsafe-eval'`. OpenCV and scripts do not run there until you add it.

Build it in report-only mode first, against a session that exercises the map, the night sky,
a video import, Motion Analysis and a scripted camera move, and read what it would have
blocked:

```
Content-Security-Policy-Report-Only: default-src 'self'; ...
```

A policy that has not been exercised against a real session is a policy that will break one.

## Configuration snippets

### nginx

```nginx
# Inside the server or location block that serves Sitrec.
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# Decide these for your deployment — see the sections above.
# add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
# add_header Content-Security-Policy "frame-ancestors 'self';" always;
# add_header Permissions-Policy "geolocation=(self), gyroscope=(self), accelerometer=(self), magnetometer=(self), microphone=(self), camera=(), payment=()" always;
```

**`always` is load-bearing in nginx**, and for a reason people are caught by: without it the
header is attached only to 2xx and 3xx replies, so it is missing from exactly the 404 and 500
responses where content sniffing is most interesting.

**`add_header` does not inherit.** If any `location` block in the same server defines its own
`add_header`, it discards every one from the enclosing scope and must repeat them. This is
the single most common reason a header that "is configured" does not arrive.

Uploaded and cached files need their own `location`, so it repeats the two baseline headers:

```nginx
location ~ /sitrec-(upload|cache)/ {
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;
}
```

This block takes its `root` from the `server` block. If only a `location` sets `root` or
`alias` for these files, put the block inside that `location`. Beside it, these files return
404. If a `location` serves only these directories, add the headers there and leave this block
out. Do not add this policy directly to a `location` that also serves the application: it
blocks every script, so the application does not run.

If a `location` sends these files to a backend with `proxy_pass`, this block returns 404,
beside that `location` or inside it. For the published image, leave this block out: the image
already sends this policy. For another backend, add a `proxy_pass` line to this block.

### Apache

```apache
<IfModule mod_headers.c>
    Header always set X-Content-Type-Options "nosniff"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
```

`mod_headers` is not enabled by default in every distribution's Apache; run
`a2enmod headers` if the directives appear to do nothing. These two lines are in
`docker/security-headers.conf`. For uploaded and cached files, copy the second `<IfModule>`
block of `docker/cache-headers.conf`, which matches on the URL. The cache block above it
tests the container's `/var/www/html` path, so change that path if you copy it.

### Caddy

```caddy
header {
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
}
```

## Checking what you actually serve

Configuration is not evidence. Ask the running site:

```bash
curl -sIL https://your-host/sitrec/ | grep -iE "content-security|x-frame|strict-transport|x-content-type|referrer|permissions|cache-control"
```

Do it against the deployed origin rather than a local build, and against a path that
404s as well as one that succeeds — that is where a missing `always` shows up. If you serve
`sitrec-upload/`, repeat the check for a file there.

Related: [Installing Sitrec](Installing-and-configuring.md) for the install itself,
[Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md), whose verification
table checks `Strict-Transport-Security`, `X-Frame-Options` and the CSP on a load-balancer
deployment, and [Server audit logging](AuditLogging.md) for server activity records.
