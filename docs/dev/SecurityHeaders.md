# Security Headers

For server activity records and protected collection, see [Audit Logging](AuditLogging.md).

What Sitrec sets for you, what it deliberately leaves to you, and why the split falls
where it does.

Response headers are attached by whatever terminates the request — your nginx, Apache,
Caddy, load balancer or CDN. Most of that is outside this repository. Sitrec sets headers
only where it *is* the server: the container image, and the two Node servers it ships.
On a normal install behind your own web server, **every header below is yours to
configure**, and nothing in a Sitrec build can do it for you.

## What Sitrec sets by default

| Header | Value | Where |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | container Apache, `standalone-server.js`, `standalone-serverless.js` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | same three |

Only two, and both chosen because they cannot break a feature on any deployment.

**`nosniff`** stops a browser second-guessing a declared `Content-Type`. That matters here
more than in an ordinary app, because Sitrec serves user-supplied files back to the page —
imported tracks, videos, images and rehosted uploads.

**`Referrer-Policy`** is already Chrome's default, so it changes nothing there and improves
browsers that still send a full URL cross-origin. It is worth setting explicitly because a
Sitrec URL is not opaque: it carries the sitch name, and often a latitude and longitude, in
its query string. A full referrer tells every third-party host where the user was looking.

`tests/securityHeaders.test.js` asserts all three servers agree, and that the Apache conf is
both installed *and* enabled with `mod_headers` loaded — a `Header` directive in a conf that
was never enabled reads exactly like a working control and sets nothing.

The restricted build's application page also sets `<meta name="referrer"
content="no-referrer">`. This suppresses the hostname as well as the path/query on
requests originating from that page. Other HTML pages and directly served content
still need the operator's response-header policy; a meta tag on the app page does
not configure the whole server. Public builds retain their existing referrer behavior.

Every built application page prohibits `<base>` overrides with `base-uri 'none'`
in its existing CSP meta tag. Sitrec uses document-relative URLs and does not need
a base element. The supplied restricted AWS CSP response-header default uses the
same directive. This small meta policy does not replace a complete deployment CSP.

## What Sitrec deliberately does not set

Each of these needs a decision about *your* deployment. Two of them break features outright
if set carelessly, which is the reason none ships as a default.

### Permissions-Policy — will disable features if you get it wrong

**Sitrec uses geolocation and device orientation.** `src/GeoLocation.js` backs "use my
location"; `src/ARMode.js` uses device orientation for AR mode. A restrictive policy turns
both off, silently, with no error a user can act on.

If you set one, allow what the app uses:

```
Permissions-Policy: geolocation=(self), gyroscope=(self), accelerometer=(self), magnetometer=(self), camera=(), microphone=(), payment=()
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
allow your own origin. If other people embed your instance, you cannot set this at all.

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
wrong. Sitrec loads map tiles, elevation, 3D tiles, star catalogues and optionally an AI
endpoint, and *which* hosts depends entirely on what you configured. There is no single
correct policy to ship.

**The allow-list is the input.** `scripts/egress-allowlist.json` already enumerates every
destination the application can contact, with its purpose — it is maintained per push by the
[user-data egress check](../UserDataEgressCheck.md). That file is the correct source for a
`connect-src` and `img-src`, and it is kept current, which a hand-written CSP would not be.

Two constraints to know before you start:

- The 3D engine and the OpenCV build use **WebAssembly** and **web workers**, so a policy
  needs `'wasm-unsafe-eval'` in `script-src` and a `worker-src` that permits `blob:`.
- Map tiles arrive as images from third-party hosts, so `img-src` must include them and
  `data:` for generated textures.

Build it in report-only mode first, against a session that exercises the map, the night sky
and a video import, and read what it would have blocked:

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
# add_header Permissions-Policy "geolocation=(self), gyroscope=(self), accelerometer=(self), magnetometer=(self), camera=(), microphone=()" always;
```

**`always` is load-bearing in nginx**, and for a reason people are caught by: without it the
header is attached only to 2xx and 3xx replies, so it is missing from exactly the 404 and 500
responses where content sniffing is most interesting.

**`add_header` does not inherit.** If any `location` block in the same server defines its own
`add_header`, it discards every one from the enclosing scope and must repeat them. This is
the single most common reason a header that "is configured" does not arrive.

### Apache

```apache
<IfModule mod_headers.c>
    Header always set X-Content-Type-Options "nosniff"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
```

`mod_headers` is not enabled by default in every distribution's Apache; run
`a2enmod headers` if the directives appear to do nothing. This is what the container image
ships — see `docker/security-headers.conf`.

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
curl -sIL https://your-host/sitrec/ | grep -iE "content-security|x-frame|strict-transport|x-content-type|referrer|permissions"
```

Do it against the deployed origin rather than a local build, and against a path that
404s as well as one that succeeds — that is where a missing `always` shows up.

Related: [Installing and configuring](Installing-and-configuring.md) for the install itself,
and [Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md), whose
verification table checks these headers on a load-balancer deployment.
