# Deploying Sitrec on a VPS with Podman and Caddy

This is the process used to put a public Sitrec site on its own domain, as a container on a
small virtual private server, with HTTPS and with updates that need no further deploy step.
It is written from doing it once end to end, and the second half is the list of things that
went wrong or nearly did.

What you get:

- `https://your-domain/` serving the released Sitrec container image.
- Certificates obtained and renewed by the server itself.
- Every published Sitrec release goes live on its own, overnight, or on demand with one command.
- A box that comes back by itself after a reboot, with nothing to log in for.
- A setup you can rebuild from a handful of small text files.

What it assumes: a domain whose DNS you control, a VPS with root SSH, and about an hour.

Tested with: AlmaLinux 9.8, Podman 5.8, Caddy 2, a 2 vCPU / 2 GB / 40 GB VPS, Sitrec 2.147.
This is how `sitrec.work` is deployed.

---

## 1. The shape, and why

**The released image, not a build.** Every tagged Sitrec release publishes
`ghcr.io/mickwest/sitrec2:<version>` and, if that tag is the newest, moves `latest` to it,
but only after an automated smoke test of the amd64 image has passed. So `latest` means
"the current release, known to start and render", which is exactly what an unattended
server should track. Nothing is compiled on the VPS.

**Configuration is an environment file, not a build.** The image's entrypoint rewrites the
PHP settings file from the container's environment at every start and injects the client
settings into the page. Only the variables you set exist; the file on the VPS is the whole
configuration of the site. Changing a setting is editing one file and restarting one service.

**Rootless Podman under a dedicated user, managed by systemd.** Quadlet turns a
`.container` file into a systemd service, so the site starts at boot, restarts on failure,
and can be updated by `podman auto-update` on a timer. Nothing runs as root.

**Caddy in front, for HTTPS.** The Sitrec image is Apache on port 8080 with no TLS. Caddy
terminates HTTPS, obtains certificates from Let's Encrypt, renews them, and proxies to the
Sitrec container. Its whole configuration is six lines.

**Two containers, each in its own pasta network namespace. Not one pod, and not a bridge
network.** Both halves of that are correctness requirements, not style: the pod would make
every visitor an administrator (see [the administrator trap](#the-administrator-trap)), and a
rootless bridge network throws away every visitor's address (see
[section 4.2](#42-networking-why-pasta)).

---

## 2. Choosing the VPS

- **Size.** 2 vCPU, 2 GB RAM, 40 GB disk is comfortable: the two containers idle at about
  20 MB each, the image is about a gigabyte, and the legacy videos are 1.7 GB. 1 GB of RAM is
  too little once Apache, PHP workers and the wind proxy's GRIB parsing are all busy. Bandwidth
  of 1 TB a month covers a demonstration site many times over.
- **OS.** AlmaLinux or Rocky 9. Podman and Quadlet are the supported container stack there
  and ship in the base repositories, and SELinux is on by default once you turn it on (see
  below). Ubuntu works too, with older Podman and different package names; this document
  assumes the RHEL family.
- **No control panel.** A cPanel or Plesk add-on installs its own Apache on ports 80 and 443,
  which Caddy needs. Order the plain OS.
- **Shared hosting cannot do this at all.** No root, no user namespaces, a jailed shell.
  Containers need a VPS. If a domain currently lives on shared hosting, note where its DNS
  is served from before you cancel that hosting (see [DNS](#7-dns-and-certificates)).

A provider's OS template is not a clean install. The one used here had SELinux disabled, no
firewall, no Podman, and password SSH login for root. The baseline script below assumes all
of that and fixes it.

---

## 3. Host baseline, as root

Run this once, as root, piped over SSH. It is idempotent. It ends by printing
`REBOOT_REQUIRED` when a reboot is needed, which on a fresh template it always is.

```bash
ssh root@203.0.113.10 bash -s < vps-root-setup.sh
```

```bash
#!/bin/bash
# Host baseline for a Sitrec VPS (AlmaLinux / Rocky 9). Run as root. Idempotent.
set -euo pipefail
SITE_USER=sitrec

# This script turns password login off. Refuse to start unless root already has a key, so a
# run over a password session can never lock the operator out.
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "refusing: /root/.ssh/authorized_keys is empty. Authorize your key and log in with it first."
  exit 1
fi

echo "== packages"
dnf -y -q update
dnf -y -q install podman passt firewalld dnf-automatic policycoreutils-python-utils rsync yum-utils

echo "== firewall: ssh, http, https"
systemctl enable --now firewalld >/dev/null
firewall-cmd -q --permanent --add-service=http
firewall-cmd -q --permanent --add-service=https
firewall-cmd -q --permanent --add-port=443/udp    # HTTP/3, which Caddy advertises
firewall-cmd -q --reload

echo "== let a rootless process bind 80 and 443 (Caddy)"
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/90-rootless-ports.conf
sysctl -q --system

echo "== automatic security updates"
sed -i 's/^apply_updates = .*/apply_updates = yes/; s/^upgrade_type = .*/upgrade_type = security/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer >/dev/null

echo "== service user $SITE_USER (rootless Podman, starts at boot)"
id -u $SITE_USER >/dev/null 2>&1 || useradd -m $SITE_USER
loginctl enable-linger $SITE_USER
install -d -m 700 -o $SITE_USER -g $SITE_USER /home/$SITE_USER/.ssh
install -m 600 -o $SITE_USER -g $SITE_USER /root/.ssh/authorized_keys /home/$SITE_USER/.ssh/authorized_keys
if ! grep -q "^$SITE_USER:" /etc/subuid; then
  usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $SITE_USER
fi

# Last, once both accounts hold the key: password login off. The provider's web console
# still works without a key if something is wrong.
echo "== sshd: keys only"
cat > /etc/ssh/sshd_config.d/40-keys-only.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
sshd -t
systemctl reload sshd

echo "== selinux"
REBOOT=""
if [ "$(getenforce)" = Disabled ]; then
  grep -qw 'selinux=0' /proc/cmdline && grubby --update-kernel ALL --remove-args selinux=0
  sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config
  touch /.autorelabel
  REBOOT=yes
fi
needs-restarting -r >/dev/null 2>&1 || REBOOT=yes
[ -n "$REBOOT" ] && echo "REBOOT_REQUIRED" || true
```

What each block is for, and what bit us:

- **`passt`** is the user-mode network stack rootless Podman 5 uses to publish ports. Without
  it, `PublishPort` fails with an unhelpful error.
- **Keys only, last, and guarded.** Within minutes of the VPS existing, the SSH log showed
  password guesses for `root`, `test` and `admin` from the internet, so password login goes
  off. The script refuses to run at all unless root already has an authorized key, and it
  disables passwords only after the service user has a copy of that key, so a run from a
  password session cannot lock you out. Keep the provider's web console as the fallback.
- **UDP 443.** `--add-service=https` opens TCP only. Caddy advertises HTTP/3, which runs
  over UDP 443; without that port open, browsers try it, fail silently, and fall back to
  TCP on every visit.
- **The sysctl.** Ports below 1024 are privileged. Caddy runs rootless and must publish 80
  and 443, so the privileged range is moved down to 80. This is the one host-level change
  the container setup needs.
- **`enable-linger`.** Without it, a user's systemd services stop when their last session
  ends and do not start at boot. This is the line that makes the site survive a reboot with
  nobody logged in.
- **Subordinate IDs.** Rootless containers map their internal users onto a range of host
  IDs from `/etc/subuid`. `useradd` on EL9 allocates them; the `usermod` line is the fallback
  if it did not.
- **SELinux.** The template had it disabled. Going straight from disabled to enforcing is
  not the safe path: files created while it was off carry no label at all (`ls -Z` shows `?`)
  and an enforcing kernel then refuses to read them. The script sets **permissive** and
  requests a full relabel on the next boot. After the setup below is running, check for
  denials and switch to enforcing:

  ```bash
  ausearch -m avc -ts boot        # expect "<no matches>"
  setenforce 1
  sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config
  ```

  With the files below, the relabel took about thirty seconds and there were no denials.
  Also check `/proc/cmdline` for `selinux=0`; some templates disable it in the boot
  arguments, where the config file cannot override it. The script removes it.

Reboot, wait for it to come back, and confirm `getenforce` says `Permissive`.

---

## 4. The service user's files

Everything below lives in `/home/sitrec/sitrec/` and `~/.config/`, owned by the `sitrec`
user. Keep the originals in a directory on your own machine and copy them over with `rsync`;
the VPS is then reproducible from that directory.

### 4.1 `sitrec.env`, the site's configuration

```bash
# Runtime settings for the Sitrec container. The image's entrypoint writes these into the PHP
# settings file and into the page at every start. Only variables set here exist there.
DEFAULT_MAP_TYPE=ESRI
DEFAULT_ELEVATION_TYPE=AWS_Terrarium
LOCAL_DOCS=true
SETTINGS_COOKIES_ENABLED=true
SETTINGS_SERVER_ENABLED=false
SAVE_TO_SERVER=false
SAVE_TO_S3=false
SAVE_TO_LOCAL=true
CHATBOT_ENABLED=false
```

This is a keyless, anonymous configuration: ESRI imagery and AWS Terrarium elevation need
no API key, and with no `SITREC_DEFAULT_USERID` every visitor is user 0, who can load and
view everything and save to their own disk but cannot write to the server. Add a key by
adding its line and restarting the service. `chmod 600` the file once it holds one.

**Only the settings the entrypoint knows are forwarded.** `docker/entrypoint.sh` copies the
variables on its `CLIENT_VARS` and `SERVER_VARS` lists, plus any `SITREC_CUSTOM_MAP_*` and
`SITREC_CUSTOM_ELEVATION_*`, and silently ignores everything else. Every setting in
`config/shared.env.example` that applies to a server build is on those lists in releases
after 2.147.2 (a few settings are for serverless builds only and are not forwarded, which
the example file says next to each); up to and including 2.147.2 eight were missing and
are dropped by the image: `SITREC_USE_CUSTOM_WIND`,
`SITREC_CUSTOM_WIND_MENU_NAME`, `SITREC_CUSTOM_WIND_TOOLTIP`, `CUSTOM_WIND_URL`,
`CACHE_CUSTOM_WIND`, `LOG_UI_INTERACTIONS`, `ADSBX_RAPIDAPI_KEY` and `GEMINI_API`. When a
setting you set has no effect, check those lists first. When a new setting is added to the
example file, it must be added to the entrypoint too.

**Do not set `SITREC_DEFAULT_USERID` on a public site.** It exists for closed, single-user
installs. On a public site it makes every visitor that user, with that user's groups, which
by default include administrator.

### 4.2 Networking: why pasta

There is no network unit. Both containers use Podman's default rootless networking, `pasta`,
each in its own namespace, and they meet on the host's loopback: Sitrec publishes
`127.0.0.1:8080`, and Caddy is started with `pasta:-T,8080`, which splices the container's
own `127.0.0.1:8080` to the host's.

The first version of this deployment put both containers on a named bridge network, which is
the obvious layout. It worked, and it had a flaw that only showed up in the logs: **rootless
Podman publishes a bridge network's ports through a userspace proxy that replaces the
source address.** Caddy's access log recorded every visitor as `10.89.0.8`. Measured on the
same box with a throwaway container answering on a scratch port:

| Container network | Address it saw for an outside client |
|---|---|
| bridge (`podman network create`) | `10.89.0.9`, the proxy |
| `pasta` | `104.176.36.231`, the client's real address |

Without the real address there is no answering "who was that" after the fact, no per-client
limits, and nothing for a future `mod_remoteip` to use. pasta is the fix, and it costs
nothing: it is already the default for rootless containers on EL9.

One consequence matters for security. From inside the Sitrec container, a connection from
Caddy arrives from the host's own public address (`203.0.113.10` in this document; Apache's
log shows it), not from `127.0.0.1`, so the localhost rule in `config.php` is not triggered.
That was measured, not assumed: a first guess that it would be pasta's `169.254.1.2` host
alias was wrong, which is exactly why the smoke test's `getuser` check exists and must be
re-run after any networking change.

### 4.3 The Sitrec service

`~/.config/containers/systemd/sitrec.container`:

```ini
[Unit]
Description=Sitrec (ghcr.io/mickwest/sitrec2)
After=network-online.target
Wants=network-online.target

[Container]
Image=ghcr.io/mickwest/sitrec2:latest
ContainerName=sitrec
# Follow the published release. podman-auto-update.timer pulls a moved `latest`.
# Pin a version by changing the tag.
AutoUpdate=registry
# Default rootless networking (pasta). Reachable only from the host's loopback, where Caddy
# picks it up. Apache then sees the host's own address as the client (measured), never
# 127.0.0.1, which config.php would treat as an administrator.
PublishPort=127.0.0.1:8080:8080
EnvironmentFile=%h/sitrec/sitrec.env
# No volumes: see "Persistent data" below. For a site that serves the legacy videos:
# Volume=%h/sitrec/sitrec-videos:/var/www/html/sitrec-videos:ro,Z
# Apache's access and error output is the container log. Cap it; the durable access log
# with client addresses is Caddy's (below).
LogOpt=max-size=50mb

[Service]
Restart=always
TimeoutStartSec=900

[Install]
WantedBy=default.target
```

- **`ContainerName=sitrec`.** Without it Quadlet names the container `systemd-sitrec`, which
  is what you type into `podman logs` and `podman exec` all day.
- **`PublishPort=127.0.0.1:8080:8080`.** The loopback prefix is what keeps 8080 off the
  public interface; the firewall would block it anyway, but this makes it not exist.
- **No volumes, deliberately.** See [section 5](#5-persistent-data). If you do add one for
  a directory Apache writes, use a *named* volume: Apache runs as `www-data`, which rootless
  Podman maps to a subordinate ID on the host, so a bind mount of a directory you created
  would be owned by the wrong ID and not writable, while a named volume is initialised
  from the image's directory with its modes. For read-only data such as videos a bind mount
  with `:Z` (the SELinux label containers may read) is fine.
- **`TimeoutStartSec=900`.** The first start pulls the image, which can take minutes on a
  slow link. The default timeout would kill it.
- **`AutoUpdate=registry`** labels the container so `podman auto-update` checks the registry
  for a newer image with the same tag, pulls it, and restarts the service. If the restarted
  service fails, it rolls back to the previous image.
- **`LogOpt=max-size=50mb`.** The container log is a plain file with no rotation; a public
  site's Apache access log would grow without limit. It also vanishes when auto-update
  replaces the container, which is why the durable access log lives in Caddy.

### 4.4 The Caddy service

`~/.config/containers/systemd/caddy.container`:

```ini
[Unit]
Description=Caddy (HTTPS)
After=network-online.target sitrec.service
Wants=network-online.target

[Container]
Image=docker.io/library/caddy:2
ContainerName=caddy
AutoUpdate=registry
# pasta keeps the visitor's real address on inbound connections, which a rootless bridge
# network does not. -T,8080 splices this container's 127.0.0.1:8080 to the host's, where
# the Sitrec container is published.
Network=pasta:-T,8080
PublishPort=80:80
PublishPort=443:443
PublishPort=443:443/udp
Volume=%h/sitrec/Caddyfile:/etc/caddy/Caddyfile:ro,Z
# Certificates and ACME state persist here, so a restart never re-issues a certificate.
Volume=caddy-data:/data
Volume=caddy-config:/config

[Service]
Restart=always
TimeoutStartSec=300

[Install]
WantedBy=default.target
```

The UDP port is HTTP/3. The two named volumes matter: Let's Encrypt limits how often a
certificate may be issued, and a Caddy that forgets its certificates on every restart would
exhaust that limit.

### 4.5 `Caddyfile`

```
sitrec.example.com {
	# Access log with the real client address, rotated, in the caddy-data volume so it
	# survives container replacement.
	log {
		output file /data/access.log {
			roll_size 50mb
			roll_keep 10
		}
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
www.sitrec.example.com {
	redir https://sitrec.example.com{uri} permanent
}
```

That is the whole reverse proxy. Caddy logs nothing about requests unless asked, and it is
the only component that sees the visitor's address, so the `log` block is what makes a
later "who was that" answerable. Caddy redirects plain HTTP to HTTPS by itself, sends the
`X-Forwarded-*` headers by itself, and obtains a certificate for every hostname named here.
The `www` block therefore needs its own DNS record, or Caddy will retry that certificate
forever (harmlessly, but noisily).

### 4.6 A weekly image prune

Auto-update leaves the previous image behind each time. On a 40 GB disk that adds up.
`~/.config/systemd/user/podman-prune.service` and `.timer`:

```ini
[Unit]
Description=Remove images left behind by podman auto-update
[Service]
Type=oneshot
ExecStart=/usr/bin/podman image prune -f
```

```ini
[Unit]
Description=Weekly image prune
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
```

### 4.7 Install and start

As the `sitrec` user, after the files are in place:

```bash
mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
cp ~/sitrec/quadlet/*.container ~/.config/containers/systemd/
cp ~/sitrec/systemd/podman-prune.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart sitrec.service
systemctl --user restart caddy.service
systemctl --user enable --now podman-auto-update.timer podman-prune.timer
```

Quadlet units cannot be `enable`d; the `[Install]` section makes them start at boot. Use
`restart` rather than `start` so the same commands re-apply an edited file.

To read logs, use `podman logs sitrec` and `podman logs caddy`. `journalctl --user` fails
with "insufficient permissions" for a plain user on a default EL9 install, which is
confusing the first time.

---

## 5. Persistent data

There is none, and that is worth understanding because it decides what kind of host can run
this. Three directories look like state and are not:

- **`sitrec-cache`** is the server's scratch space: current satellite element sets from
  CelesTrak with a freshness window, ADS-B traces, soundings, live-feed responses, a
  street-view session token, and 28 days of usage counters. Every one regenerates on
  demand. The earlier per-tile cache proxy is gone. What made this directory large on the
  original production server was a permanent archive of historical element sets, which
  needs credentials this site does not have and is not wanted here.
- **`sitrec-upload`** receives nothing while visitors are anonymous.
- **`sitrec-videos`** holds the clips the legacy sitches play. This site does not carry
  them. A site that does needs a read-only bind mount and one `rsync` of the files, and
  that is the only persistent data such a site has.

The container's own writable filesystem, which the image already provides, covers the
rest. It is discarded when auto-update replaces the container, and nothing is lost.

---

## 6. Test before DNS

You can prove the whole stack before the domain points at it. Add a temporary site to the
Caddyfile that answers plain HTTP on the bare IP:

```
http://203.0.113.10 {
	reverse_proxy sitrec:8080
}
```

Then run the checks in [section 8](#8-verifying) against `http://203.0.113.10/`. Remove the
block once DNS is switched; do not leave a plain-HTTP door open.

Expect Caddy's log to show certificate failures for the real hostnames during this period.
It is trying, DNS still points elsewhere, and it backs off. That is fine, up to a point: see
the next section.

---

## 7. DNS and certificates

Point the domain's `A` record for the apex and for `www` at the VPS. Then, because Caddy
has been failing and backing off, restart it so it tries again immediately:

```bash
systemctl --user restart caddy.service
podman logs --since 2m caddy | grep -E "certificate obtained|challenge"
```

Both certificates arrived within about five seconds of the restart. Without the restart,
the back-off can leave the site without HTTPS for an hour or more after DNS is correct.

Do not restart Caddy in a loop while DNS is wrong. Let's Encrypt counts failed validations
per hostname per hour, and a script that keeps retrying can lock you out for the rest of
the hour.

**Where the zone lives.** If the domain was on shared hosting, its nameservers were very
likely the hosting company's, and the zone was managed inside that hosting account. Cancel
the hosting and those nameservers stop answering for your domain. Move the domain to the
registrar's own DNS first, recreate the records there, and only then cancel. Mail records
that pointed at the shared host go with it too.

---

## 8. Verifying

A smoke test over plain `curl`, run from anywhere. Each check has caught something real:

| Check | What it proves |
|---|---|
| `GET /` returns 200 | Caddy reaches Apache |
| `sitrecServer/config_paths.php?FETCH_CONFIG` returns JSON | PHP runs and the settings file loaded |
| `sitrecServer/rehost.php?getuser` reports `userID: 0` | **a visitor is not an administrator** |
| `sitrecServer/proxy.php?request=CURRENT_STARLINK` returns CSV text | the server can fetch from the internet and write its cache |
| `GET /shared.env.php` contains no setting names | the settings file is executed as PHP, not served as text |
| a byte-range request for a legacy video returns 200 or 206 | only on a site that carries the videos: the mount is right |
| the `APP` URL in the config JSON starts with `https://` | the backend knows it is behind TLS (see [section 9](#9-a-sitrec-bug-this-deployment-exposed)) |

Then a real browser. Sitrec logs `No pending actions` to the console when a sitch has
finished loading, so a short Playwright script can load the default page and a legacy sitch,
wait for that line, screenshot, and list console errors and failed requests. Two things about
the browser:

- **Playwright's bundled Chromium could not create a WebGL context** on the machine used
  here, so Sitrec failed before rendering anything. The installed Google Chrome, launched
  through Playwright with `channel: 'chrome'` and `--ignore-gpu-blocklist`, rendered both
  sitches in about thirteen seconds. The repository's `playwright.config.js` shows the
  SwiftShader flags that make the bundled Chromium work in CI.
- **Headless Chrome cannot decode the videos.** The video panes report that WebCodec
  playback is unsupported. That is the browser; the `curl` check above proves the server
  delivers the file. Confirm playback in a normal browser.

Finally, **reboot the VPS and do nothing.** Both services were back 33 seconds after boot
and every check passed. If they are not, `loginctl enable-linger` was skipped or the
`[Install]` sections are missing.

---

## 9. A Sitrec bug this deployment exposed

The PHP backend builds absolute URLs from `$_SERVER['REQUEST_SCHEME']`: the app, cache,
upload and terrain URLs it hands to the page, and the origin it uses for CORS checks. Behind
Caddy, Apache is spoken to over plain HTTP, so it reported `http://` while the page was
`https://`, and a browser refuses to fetch `http://` resources from an `https://` page.

Releases after 2.147.2 read the standard `X-Forwarded-Proto` header
(`sitrecServer/requestScheme.php`), which Caddy sends by default and nginx sends with
`proxy_set_header X-Forwarded-Proto $scheme;`. Only the scheme is taken from the proxy.
The client address is deliberately not, for the reason below.

With the default configuration the impact was nil, because the browser fetches ESRI and
Terrarium tiles directly and server saves are off. The tile cache's redirect is relative,
so it was never affected. It would have bitten the first time someone chose a proxied map
source or uploaded a file.

A related limitation remains: per-caller throttles in the backend key on the client
address, which behind the proxy is always Caddy's. They act as global limits. Trusting
`X-Forwarded-For` in PHP would be wrong (see the trap below); the correct fix is Apache's
`mod_remoteip` inside the image, trusting only the proxy's network.

### The administrator trap

`config.php` grants a request from `127.0.0.1` a synthetic administrator identity, so a
developer running the PHP built-in server is logged in. Two ways to hand that identity to
the whole internet:

1. Put Caddy and Sitrec in one **pod**. Containers in a pod share a network namespace, so
   Caddy proxies to `127.0.0.1:8080` and Apache sees every visitor as localhost.
2. Make PHP take `REMOTE_ADDR` from `X-Forwarded-For`. Any client can send that header
   with `127.0.0.1` in it.

Separate namespaces avoid the first: with pasta, Apache sees the host's own address (on a
bridge network it would see Caddy's `10.89.0.x`). Not trusting forwarded addresses
avoids the second. The `getuser` smoke check exists to catch either regressing, and it is
the first thing to run after any change to how the two containers are connected.

---

## 10. Day to day

**Updating.** Nothing to do. The timer runs nightly; a release published today is live
tomorrow. To make it live now:

```bash
ssh sitrec@203.0.113.10 podman auto-update
```

**Pinning.** Change `latest` to a version tag in `sitrec.container`, `daemon-reload`, restart.

**Changing a setting or adding a key.** Edit `sitrec.env`, then
`systemctl --user restart sitrec.service`. A key with a referrer restriction at its provider
must have the new domain added there first.

**Logs.** Three places, for three questions:

- *Who requested what, from where:* Caddy's access log, JSON, one line per request, in the
  `caddy-data` volume. `podman exec caddy cat /data/access.log`, or copy it out with
  `podman cp caddy:/data/access.log .`. Rotated at 50 MB, ten files kept.
- *What PHP did and any PHP errors:* `podman logs sitrec`. Apache's access lines here show
  Caddy's address as the client, not the visitor's; use them for paths and status codes.
  This log restarts empty whenever the container is replaced.
- *SSH and the host:* `/var/log/secure` and `/var/log/messages`, kept by rsyslog. The
  systemd journal on a default EL9 install is volatile and is lost at every reboot, so
  `journalctl` only ever shows the current boot; rsyslog's files are the durable record.

**Disk.** `podman system df`. The prune timer removes old images weekly.

**Resizing or rebuilding.** The box holds no state beyond the files under `~/sitrec`, which
you keep a copy of. Rebuilding on a bigger VPS, or a different provider, is the root script
and the user files. Nothing needs to be migrated.

---

## 11. Gotchas, collected

Things that cost time, in the order they were met.

- **The SSH key that "did not work" was passphrase-protected.** Non-interactive `ssh` with
  `BatchMode=yes` cannot ask for a passphrase and cannot use a key the agent does not hold,
  so the server refused it while its `authorized_keys` was correct. A key that scripts will
  use needs to be in the agent, loadable from the keychain, or have no passphrase.
- **A hosting panel's "generate key" makes the pair on the server.** The public half is
  then authorized there and the private half has to be downloaded, the reverse of what you
  want. Importing your own public key is the right direction.
- **`ls -Z` showing `?` means "no label", not "unlabeled type".** It happens when SELinux is
  off when a file is created. `restorecon` cannot fix it while SELinux is disabled; the
  autorelabel at boot does.
- **Shared hosting cannot run containers.** Decide the hosting model before choosing the
  account.
- **A provider template is not the distribution's defaults.** Assume SELinux off, firewall
  off, password login on, and check.
- **Quadlet's default container name has a prefix.** Set `ContainerName` if anything
  resolves the container by name.
- **A bind mount for a directory the container writes needs the right owner**, which under
  rootless Podman is a subordinate ID you do not have on the host. Use a named volume, if
  you need one at all: this deployment turned out to need none.
- **"Cache" hid two different things.** A 24-hour tile cache almost nobody used, and a
  multi-gigabyte permanent archive of satellite element sets. Measuring the production
  server (584 cached tiles ever, 13 in a month) is what made it safe to drop the tile proxy
  and every volume.
- **Caddy backs off after failed certificate attempts.** Restart it once DNS is right.
- **`www` is a separate certificate.** Give it an `A` record or leave it out of the Caddyfile.
- **The image reports `http://` behind a TLS proxy** on releases up to 2.147.2. Newer
  releases honour `X-Forwarded-Proto`.
- **Never one pod for proxy and app.** Localhost is an administrator.
- **A rootless bridge network hides every visitor's address.** Its port proxy rewrites the
  source, so the access log showed one internal address for the whole internet. Use pasta
  and the host's loopback instead; it was a two-line change once measured.
- **`journalctl --user` needs group membership** a fresh user lacks. `podman logs` does not.
- **Headless Chromium and WebGL.** Use the installed Chrome or the harness's SwiftShader
  flags; and expect no video decoding in headless mode either way.
- **The journal does not survive a reboot** on a default EL9 install, and `podman logs`
  does not survive a container replacement. Look in `/var/log/secure` and Caddy's access
  log for anything older than the current boot or the current image.
- **Internet scanners arrive within minutes.** The access log filled with requests for
  `/.env`, `/wp-admin/.env` and friends before the site had a name. None of those paths
  exist in the image, but it is a reminder that the settings file is served as PHP
  precisely so that it never serves as text.
