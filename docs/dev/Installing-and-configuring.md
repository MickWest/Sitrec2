# Installing Sitrec

**Just want to run Sitrec?** Follow the [Zero-Config Docker Image](#zero-config-docker-image-recommended) instructions below — it takes about 30 seconds and requires no programming knowledge.

For developers, there are additional options:

| Method | Best For | Requirements | Setup Time |
|--------|----------|--------------|------------|
| **Docker Image** | Running Sitrec, no setup needed | Docker Desktop or Podman | ~30 seconds |
| Docker Build | Testing from source | Docker Desktop + Git | ~2 minutes |
| Serverless | Offline/portable use | Node.js (or just a browser) | ~30 seconds |
| Standalone | Development without web server | Node.js + PHP | ~30 seconds |
| Local Server | Full development environment | Node.js + Nginx/Apache + PHP | ~5 minutes |

---

## Zero-Config Docker Image (Recommended)

The fastest way to run Sitrec. No source code, no build tools, no configuration required. A pre-built image is published on each release and works on Windows, Mac (Intel and Apple Silicon), and Linux.

**Prerequisites:** Install either Docker or Podman (see below), then run the one-liner install. **If you're not sure which to use, choose Docker** — Podman is an alternative for advanced or restricted setups (no admin rights, RHEL/Fedora, etc.).

### Installing Docker (Simplest)

Download and install [Docker Desktop](https://www.docker.com/) for your platform — it includes everything you need (engine, compose, and GUI). Available for Windows, Mac, and Linux.

**After installing, launch Docker Desktop and wait until it reports "Engine running"** (the whale icon stops animating). The install commands below fail with a "cannot connect to the Docker daemon" error if Docker Desktop isn't actually running. On Windows, Docker Desktop requires WSL2 — its installer will prompt you to enable it.

### Installing Podman (Optional)

[Podman](https://podman.io/) is a Docker alternative that doesn't require Docker Desktop. See [Using Podman](#using-podman-instead-of-docker) below for more details.

**Mac:**
```bash
brew install podman podman-compose
podman machine init && podman machine start
```

**Linux (RHEL / Fedora / CentOS):**
```bash
sudo dnf install podman podman-compose
```

**Linux (Ubuntu / Debian):**
```bash
sudo apt install podman
pip install podman-compose
```

**Windows:**
Download the Podman installer from [podman.io](https://podman.io/) or use `winget install RedHat.Podman`, then install podman-compose with `pip install podman-compose`.

### One-liner Install

Open a terminal and paste the command for your platform. (On **Mac**, open *Terminal* — press Cmd-Space and type "Terminal". On **Windows**, open *PowerShell* — press the Start button and type "PowerShell". "WSL" in the headings below means Windows Subsystem for Linux, an advanced option — if you're on Windows and unsure, use the **Windows PowerShell** command.) This downloads a small install script that sets everything up automatically, auto-detecting whether you have Docker or Podman installed.

**Mac / Linux / WSL:**
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1 | iex
```

If you have both Docker and Podman installed, the script defaults to Docker. Use `--podman` / `--docker` for the Mac/Linux/WSL script, or `-Podman` / `-Docker` for PowerShell:
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --podman
```
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1))) -Podman
```
Or if you have the installer locally:
```bash
./install.sh --podman
```
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Podman
```

If you have a pre-configured `.env` file, place it in the current directory before running the installer — it will be copied into the `sitrec/` folder automatically instead of generating a new template.

This creates a `sitrec/` folder in your current directory, downloads Sitrec, and starts it. On Windows it also creates `sitrec.cmd`; use that for daily commands (Windows can otherwise block the management script for security reasons). Once the container is running, open **http://localhost:8080** in your browser.

The first launch may take a minute while the image downloads; when it's ready you'll see the Sitrec 3D globe view. If the page doesn't load, wait a moment and refresh, or run `./sitrec.sh logs` (`.\sitrec.cmd logs` on Windows) to see what the container is doing. To stop Sitrec later, run `./sitrec.sh stop` (`.\sitrec.cmd stop`). Run these management commands from inside the `sitrec/` folder the installer created.

### Manual Install

If you prefer to set things up yourself instead of using the install script:

1. Create a new folder (e.g. `sitrec`), and inside it create a text file named `docker-compose.yml` with this content (on Windows, in Notepad choose **Save as type: All Files** so it isn't saved as `docker-compose.yml.txt`; keep the indentation exactly as shown):

```yaml
services:
  sitrec:
    image: ghcr.io/mickwest/sitrec2:latest
    ports:
      - '8080:8080'
    env_file:
      - .env
    volumes:
      - ./sitrec-videos:/var/www/html/sitrec-videos
      # Optional: keep user uploads across container recreation. Without this (and
      # without S3) uploads live inside the container and are lost on `down`.
      #- ./sitrec-upload:/var/www/html/sitrec-upload
```

2. Create an empty `.env` file in the same folder (required by the compose file; you can add settings to it later).

3. Open a terminal in that folder and run:
```bash
docker compose up        # Docker
podman-compose up        # Podman
```

4. Once the container is running, open **http://localhost:8080** in your browser.

### Configuration (Optional)

Sitrec works out of the box with no configuration. To customize it, create a text file named `.env` in the same folder as `docker-compose.yml`. To enable a setting, remove the `#` at the start of the line and fill in your value.

The example below shows some commonly used settings. For the full list of available configuration variables, see [config/shared.env.example](../../config/shared.env.example).

```env
# === Maps (optional — enables higher quality satellite imagery) ===
#MAPBOX_TOKEN=pk.your_token_here
#MAPTILER_KEY=your_key_here

# === 3D Buildings (optional) ===
#CESIUM_ION_TOKEN=your_token_here
#GOOGLE_MAPS_API_KEY=your_key_here

# === AI Chat (optional) ===
#CHATBOT_ENABLED=true
#OPENAI_API=sk-your_key_here

# === Cloud Storage (optional — enables server-side saves) ===
#SAVE_TO_S3=true
#S3_ACCESS_KEY_ID=your_key_here
#S3_SECRET_ACCESS_KEY=your_secret_here
#S3_BUCKET=your-bucket
#S3_REGION=us-west-2

# === Satellite data (optional — defaults are correct; see note below) ===
#CURRENT_STARLINK="https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=csv"
#CURRENT_ACTIVE="https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv"
```

> **Upgrading an existing install:** if you already set `CURRENT_STARLINK` or
> `CURRENT_ACTIVE`, check they end in `FORMAT=csv` and not `FORMAT=tle`. The TLE
> format cannot represent catalog numbers above 99999, a limit the satellite
> catalog passed on 2026-07-11, so CelesTrak now leaves those objects out of TLE
> feeds entirely — a `FORMAT=tle` URL returns a silently incomplete catalog that
> is missing the newest satellites. These settings override the built-in
> defaults, so an old value keeps taking effect until you change it.

After editing `.env`, apply your changes with the management script — it safely recreates the container and your `.env` file is never modified:
```bash
./sitrec.sh restart
```
```powershell
.\sitrec.cmd restart
```
(Settings are read when the container is created, so `restart` recreates it for you; a plain container restart would not pick up `.env` changes. Your saved settings stay in `.env`.)

Or manually:
```bash
docker compose down && docker compose up          # Docker
podman-compose down && podman-compose up           # Podman
```

Map sources that require an API token (e.g. MapBox, MapTiler) only appear in the terrain menu when the corresponding token is provided. Without any tokens, the app uses ESRI World Imagery and AWS Terrarium elevation, which require no keys.

### Videos for Legacy Sitches (Optional)

Sitrec works fully without any video files — you can create and view custom sitches, load tracks, and explore 3D terrain. Video files are only needed to view legacy analysis sitches (Gimbal, GoFast, Aguadilla, etc.). These sitches can also be viewed online at [metabunk.org/sitrec](https://www.metabunk.org/sitrec).

If you want to run legacy sitches locally, download the public video files into a `sitrec-videos` folder next to your `docker-compose.yml`. The installer and manual compose example mount this folder by default. Run the downloader from either your `sitrec/` install folder or the folder that contains it; the script detects the install folder before downloading.

**Mac / Linux / WSL:**
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.ps1 | iex
```

Or download manually from [this Dropbox folder](https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=0) and place the files in `sitrec-videos/public/`. Then restart the container with `./sitrec.sh restart` or `.\sitrec.cmd restart`.

### Updating to the Latest Version

To get the newest release:
```bash
./sitrec.sh pull
```
```powershell
.\sitrec.cmd pull
```

`pull` updates the **Sitrec image**. To update the management script itself (and your local `shared.env.example`), run `./sitrec.sh update` (`.\sitrec.cmd update`).

**Checking for new settings after an update.** Your settings live in `.env`, which
updating never touches, so a new release can add options you never hear about. The
reference file `shared.env.example` carries a `SHARED_ENV_VERSION` stamp near the top
— a date that changes whenever the available settings change:

```bash
grep SHARED_ENV_VERSION shared.env.example
```

If that date moved since you last looked, skim the file for settings worth adding to
your `.env`. (Docker installs are not blocked by this — the build-time check applies
only to source installs that keep their own `config/shared.env`.)

Or manually:
```bash
docker compose pull && docker compose down && docker compose up      # Docker
podman-compose pull && podman-compose down && podman-compose up      # Podman
```

### Pinning a Specific Version

By default Sitrec uses the latest release. To lock to a specific version, edit the `image:` line in `docker-compose.yml` (replace `<version>` with a published release tag such as `2.87.0`):
```yaml
image: ghcr.io/mickwest/sitrec2:<version>
```
Or run `./sitrec.sh versions` (`.\sitrec.cmd versions`) to pick a version interactively.

### Baking a Pre-Configured Image (Advanced)

> **Most people don't need this.** If you just want to run Sitrec and keep a few
> settings, edit the `.env` file (see [Configuration](#configuration-optional) above)
> and skip this section. *Baking* is for I.T. staff deploying a ready-to-run Sitrec to
> **other** machines — a private registry, a fleet of servers, or an offline/air-gapped
> system — without copying a `.env` file around.

Normally the published image is **unconfigured**: you supply settings in a `.env` file
and Sitrec reads them each time it starts. *Baking* instead builds a new **image** (a
packaged, ready-to-run copy of Sitrec) with your settings already inside it, so it runs
configured anywhere with no `.env` needed.

**Quickest path** — from inside your `sitrec/` install folder (where `sitrec.sh` or
`sitrec.cmd` lives),
bake the `.env` you already configured into a **tarball** (a single `.tar` file you can
copy on a USB stick or `scp`):

```bash
./sitrec.sh bake sitrec-configured:latest --tarball sitrec-configured.tar
```
```powershell
.\sitrec.cmd bake sitrec-configured:latest -Tarball sitrec-configured.tar
```

That writes `sitrec-configured.tar` to the current folder. To install it on the target
machine, see [Air-Gapped / Offline Install](#air-gapped--offline-install) below.

**Or push to a registry** (an online store for images) instead of making a tarball:

```bash
docker login registry.example.com          # one time (or: podman login registry.example.com)
./sitrec.sh bake --push registry.example.com/sitrec:configured
```
```powershell
docker login registry.example.com          # one time (or: podman login registry.example.com)
.\sitrec.cmd bake -Push registry.example.com/sitrec:configured
```

**Or bake straight from the one-line installer** — without installing Sitrec first. The
env file must already exist in the current directory:

```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --bake registry.example.com/sitrec:configured --env-file prod.env
```
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1))) -Bake registry.example.com/sitrec:configured -EnvFile prod.env
```

**Options** (`./sitrec.sh bake`, `install.sh --bake`, `.\sitrec.cmd bake`, and
`install.ps1 -Bake` accept the same options; PowerShell examples use single-dash
parameter names):

| Option | Meaning |
|--------|---------|
| `<target-image>` | Name:tag for the image you're creating (required) — e.g. `sitrec-configured:latest`, or `registry.example.com/sitrec:configured` to push |
| `--env-file <file>` | Settings file to bake in (default: the `.env` in the current folder) |
| `--base <tag>` | Which published version to build on top of (default: `latest`) |
| `--push` | Push to the target's registry after building (run `docker login`/`podman login` first) |
| `--tarball [file]` | Save the image to a `.tar` file (written to the current folder; the default name is the target image with `/` and `:` replaced by `_` — e.g. `registry.example.com/sitrec:configured` → `registry.example.com_sitrec_configured.tar`) |

> **Podman + local registries:** Docker auto-trusts `localhost` registries, but Podman
> does not. To `--push` to a plain-HTTP or LAN registry under Podman, first mark it
> insecure in `registries.conf` (`/etc/containers/registries.conf` or a drop-in):
> ```toml
> [[registry]]
> location = "registry.example.com:5000"
> insecure = true
> ```
> Private registries also need `podman login` first (credentials go to
> `$XDG_RUNTIME_DIR/containers/auth.json`). On macOS, `podman` runs inside the
> `podman machine` VM, so keep tarball paths under your home directory (the shared
> mount), and remember "localhost" means localhost *inside the VM*.

**Deploying a baked image** — point an install at it with `--image` (works for a
registry image or one loaded from a tarball):

```bash
./install.sh --image registry.example.com/sitrec:configured   # pulls from your registry
./install.sh --offline --image sitrec-configured:latest       # uses an already-loaded image
```
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Image registry.example.com/sitrec:configured   # pulls from your registry
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Offline -Image sitrec-configured:latest        # uses an already-loaded image
```

**Keep secrets out of the image (recommended).** Because baked values are readable by
anyone who can pull the image (see warning), bake only non-secret settings and supply
secrets at runtime:

```bash
# bake-public.env: banners, map tokens — no secrets
./sitrec.sh bake --env-file bake-public.env --push registry.example.com/sitrec:configured
# On deploy, secrets (OpenAI / S3 keys) stay in the runtime .env the container reads.
```
```powershell
# bake-public.env: banners, map tokens - no secrets
.\sitrec.cmd bake -EnvFile bake-public.env -Push registry.example.com/sitrec:configured
# On deploy, secrets (OpenAI / S3 keys) stay in the runtime .env the container reads.
```

**How it works:** `bake` writes a tiny `Dockerfile` (`FROM ghcr.io/mickwest/sitrec2:<tag>`
plus one `ENV` line per setting) and builds it — no app rebuild. The entrypoint reads the
same environment variables as always; they're just supplied by the image's `ENV` layers now
instead of by `.env` (values are escaped, so a secret containing `$` is baked literally). It
works identically under Podman (`podman build`/`history`/`inspect`). Baked values are the
**lowest-priority** source, so a deployment can still override any of them with
`-e`/`env_file` (or Kubernetes `env:`) at run time — pre-configured, but not frozen.

> **Single architecture:** a baked image is built for the CPU architecture you bake on
> (it adds layers on your machine rather than copying the base's multi-arch manifest).
> To deploy to a different CPU type — e.g. baking on Apple Silicon for x86 servers —
> bake on a host that matches the target architecture, or bake once per architecture.

> ⚠️ **Security:** every baked value is embedded in the image and is recoverable by
> anyone who can pull it or run `docker history` / `docker inspect` (`podman history` /
> `podman inspect` too). Since settings can include secrets (API keys, S3 credentials),
> only push baked images to a **private** registry you trust — or use the
> secrets-out-of-the-image pattern above.

### Running on Kubernetes (Advanced)

> **Most people don't need this.** This section is for I.T. staff deploying Sitrec on a
> Kubernetes (K8s) cluster. If you're running Sitrec on a single machine with Docker or
> Podman, use the `.env` file (see [Configuration](#configuration-optional)) and skip this.

**Is this you?** Kubernetes is one way to run the Sitrec container — an alternative to
`docker compose` on a single machine, not a replacement for the image itself (Kubernetes
runs that same image). This section applies to you **only if all of these are true**:

- You deploy with `kubectl` (not `docker run` or `docker compose`).
- You have a **cluster** — multiple machines, or a managed service like EKS, GKE, AKS, or
  OpenShift — rather than a single Docker/Podman host.
- Your S3 credentials are (or will be) a Kubernetes **Secret**, not a `.env` file.

If any of those is "no," you're running Sitrec under plain Docker or Podman — use the
[Configuration](#configuration-optional) `.env` file instead and skip this section. The
Sitrec image and how it reads settings are identical either way; only *how the environment
variables are supplied* differs.

Sitrec reads its settings from **environment variables** at container startup — the same
ones you'd normally put in a `.env` file. Kubernetes doesn't use `.env` files; instead you
supply those environment variables from the Deployment, and supply **secrets** (like S3
credentials) from a Kubernetes **Secret**. The container's entrypoint reads them all the
same way, so nothing inside Sitrec changes.

The recommended split is the same two-layer pattern as everywhere else:

- **Non-secret settings** (`SAVE_TO_S3`, `S3_BUCKET`, `S3_REGION`, banners, map tokens):
  bake them into a pre-configured image (see [Baking](#baking-a-pre-configured-image-advanced)
  above) **or** list them as plain `env:` entries in the Deployment.
- **Secrets** (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, API keys): keep them in a
  Kubernetes Secret and inject them at run time. They never go in the image.

> **Ready-to-use manifests:** the steps below are explained from scratch, but a complete,
> copy-paste version of everything here — Deployment, Service, optional Ingress, plus the
> non-root, probe, and resource settings from *Production hardening* — lives in
> [`docs/dev/k8s-example/`](k8s-example/), validated end-to-end against a local `kind`
> cluster.

#### Step 1 — Create the Secret with your S3 credentials

A Secret is an object stored **in the cluster**, not a file on a server. Create it
directly so the credential values never sit in a YAML file you might commit to git:

```bash
kubectl create secret generic sitrec-s3 \
  --from-literal=S3_ACCESS_KEY_ID=AKIA... \
  --from-literal=S3_SECRET_ACCESS_KEY=...
```

> The Secret must live in the **same namespace** as the Deployment that uses it. Add
> `-n your-namespace` to the command (and to the Deployment) if you're not using `default`.

> ⚠️ **Kubernetes Secrets are base64-encoded, not encrypted.** Anyone with `get secret`
> permission on the namespace — or direct etcd access — can read them in clear text. For
> production, enable [etcd encryption at rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/),
> restrict `get`/`list` on secrets via RBAC, and consider an external secrets manager
> (External Secrets Operator, HashiCorp Vault) rather than hand-created secrets.

#### Step 2 — Reference the Secret from your Deployment

There are two ways to wire the Secret into the container, depending on whether the keys in
your Secret are **named exactly as Sitrec expects** or not.

**Method A — keys named exactly as Sitrec expects (simplest).** If the Secret's keys are
already `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (as in Step 1 above), use `envFrom`
to inject *every* key in the Secret as an environment variable in one line:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sitrec
spec:
  replicas: 1
  selector:
    matchLabels: { app: sitrec }
  template:
    metadata:
      labels: { app: sitrec }
    spec:
      containers:
        - name: sitrec
          image: registry.example.com/sitrec:configured   # your baked image, or ghcr.io/mickwest/sitrec2:latest
          ports:
            - containerPort: 8080
          env:                          # non-secret settings (omit any you baked into the image)
            - { name: SAVE_TO_S3, value: "true" }
            - { name: S3_BUCKET,  value: "your-bucket" }
            - { name: S3_REGION,  value: "us-west-2" }
          envFrom:
            - secretRef:
                name: sitrec-s3         # injects S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY
```

**Method B — Secret keys have different names.** If you already have an S3 Secret with its
own naming (e.g. an existing `aws-creds` Secret with keys `aws_access_key_id` /
`aws_secret_access_key`), map each one to the variable name Sitrec expects with
`secretKeyRef`:

```yaml
          env:                          # non-secret settings as above, plus:
            - { name: SAVE_TO_S3, value: "true" }
            - { name: S3_BUCKET,  value: "your-bucket" }
            - { name: S3_REGION,  value: "us-west-2" }
            - name: S3_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: aws-creds            # the existing Secret
                  key: aws_access_key_id     # its key name
            - name: S3_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: aws-creds
                  key: aws_secret_access_key
```

The left side (`name:`) is always the Sitrec variable; the right side (`key:`) is whatever
your Secret happens to call it. Use Method B whenever you can't (or don't want to) rename
the keys in an existing Secret.

Apply the Deployment:

```bash
kubectl apply -f sitrec-deployment.yaml
```

Either way, by the time Sitrec's entrypoint runs, `S3_ACCESS_KEY_ID` and the rest are
ordinary environment variables in the container — Sitrec assembles them into its S3
configuration automatically. No `config.php` editing, no secrets in the image.

> The Deployment YAML contains **no secret values** — only the image name and the Secret's
> *name*. That makes it safe to keep in git. The credentials live only in the cluster
> (in the `sitrec-s3` / `aws-creds` Secret).

Two things to know about the manifest above:

- `envFrom: secretRef` injects **every** key in the Secret as an environment variable —
  keep `sitrec-s3` limited to Sitrec's variables, don't park unrelated keys in it.
- `replicas: 1` is deliberate. Don't scale beyond one replica unless `SAVE_TO_S3=true` and
  you use no local-filesystem storage — user uploads and the tile cache are written inside
  each pod and aren't shared between replicas (see [Production hardening](#production-hardening-recommended) below).

**Private registry?** If you used the baked-image pattern above, your image lives in a
private registry and the cluster needs pull credentials — without them the pod fails with
`ImagePullBackOff`. Create a pull secret and reference it from the Deployment `spec`:

```bash
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=<user> --docker-password=<token-or-password>
```
```yaml
    spec:
      imagePullSecrets:
        - name: regcred       # must be in the same namespace as the Deployment
      containers:
        - name: sitrec
          # ...as above
```

#### Step 3 — Expose Sitrec so you can reach it

A Deployment only *runs* the container — nothing can reach it yet except
`kubectl port-forward` (used in testing below). To serve it to users, add a **Service** (a
stable in-cluster address) and usually an **Ingress** (an external URL, typically with TLS).
Sitrec serves at the container's web root on port 8080, so there's no `/sitrec` path prefix:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: sitrec
spec:
  selector: { app: sitrec }      # matches the Deployment's pod labels
  ports:
    - name: http
      port: 80                   # the Service's port
      targetPort: 8080           # the container's port
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sitrec
spec:
  rules:
    - host: sitrec.example.com   # your DNS name
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sitrec
                port: { number: 80 }
```

Apply them like any other manifest (`kubectl apply -f sitrec-service.yaml`, or put
everything in one file separated by `---`). The Ingress needs an ingress controller
(nginx-ingress, Traefik, or your cloud provider's) already installed in the cluster.

#### Step 4 — Test that it worked

```bash
# 1. Is the pod running?
kubectl get pods -l app=sitrec

# 2. Did the credentials reach the container? This file should list all five S3 lines
#    between a "<?php /*;" header and a "*/" footer.
kubectl exec deploy/sitrec -- cat /var/www/html/shared.env.php

# 3. Is Sitrec actually serving? (no browser needed)
kubectl exec deploy/sitrec -- curl -sf http://localhost:8080/ >/dev/null && echo OK

# 4. Full functional check via a temporary tunnel:
kubectl port-forward deploy/sitrec 8080:8080
#    then open http://localhost:8080 in a browser and try saving a sitch ("Save" menu).
#    With SAVE_TO_S3=true and valid keys, the file is written to your S3 bucket.
#    (If you added the Ingress in Step 3, open https://sitrec.example.com instead.)
```

If `S3_ACCESS_KEY_ID` is **missing** from `shared.env.php`, the most common causes are:
the Secret name is misspelled, the Secret is in a different namespace than the pod, or
(Method B) the `key:` name doesn't match a key that actually exists in the Secret. Check
`kubectl describe pod -l app=sitrec` — it will report a Secret it couldn't find.

#### Production hardening (recommended)

The minimal Deployment runs, but a real deployment should add four things. They all slot
into the same Deployment `spec`/container:

**1. Persistent storage — or accept that uploads/cache are scratch.** Sitrec writes user
uploads to `/var/www/html/sitrec-upload` and a tile cache to `/var/www/html/sitrec-cache`,
both *inside the pod* — so both are **wiped on every pod restart or reschedule**. Either set
`SAVE_TO_S3=true` (saves go to S3; local uploads/cache stay disposable) or attach
PersistentVolumeClaims:

```yaml
          volumeMounts:
            - { name: uploads, mountPath: /var/www/html/sitrec-upload }
            - { name: cache,   mountPath: /var/www/html/sitrec-cache }
      volumes:
        - name: uploads
          persistentVolumeClaim: { claimName: sitrec-uploads }
        - name: cache
          persistentVolumeClaim: { claimName: sitrec-cache }
```

A `ReadWriteOnce` PVC ties the pod to one node, so it can't be shared across scaled-out
replicas — another reason to keep `replicas: 1` unless you go S3-only.

**2. Run as non-root.** The image is built to run as an unprivileged user on port 8080, but
a vanilla cluster still starts the pod as root unless you ask otherwise:

```yaml
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: sitrec
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
```

(Running non-root, the container listens *only* on 8080 — exactly what the Service's
`targetPort: 8080` already targets.)

**3. Health probes** so Kubernetes routes traffic only to ready pods and restarts wedged
ones. Probe the web root `/` — it returns the app's index page to anyone. (Don't probe
`/sitrecServer/info.php`: it's admin-only and returns **403** to the kubelet, which would
leave the pod permanently *NotReady* and crash-loop on the liveness check.)

```yaml
          readinessProbe:
            httpGet: { path: /, port: 8080 }
            initialDelaySeconds: 5
          livenessProbe:
            httpGet: { path: /, port: 8080 }
            initialDelaySeconds: 15
```

**4. Resource requests/limits** so the pod schedules predictably and isn't first evicted
under node pressure (Sitrec's heavy 3D runs in the browser, so the container — Apache + PHP
— stays modest):

```yaml
          resources:
            requests: { cpu: "100m", memory: "256Mi" }
            limits:   { memory: "512Mi" }
```

> **Tip:** for the many *non-secret* variables (banners, `S3_BUCKET`/`S3_REGION`, map
> tokens), a ConfigMap + `envFrom: [{ configMapRef: { name: sitrec-cfg } }]` is cleaner than
> a long inline `env:` list. Treat rate-limited map API tokens as semi-secret — if that
> matters, keep them in the Secret rather than a ConfigMap. Every referenced object (Secret,
> imagePullSecret, ConfigMap, PVCs) must live in the Deployment's namespace.

#### Rotating credentials

Environment variables are read **once, at container startup**, so updating the Secret does
not affect already-running pods. After changing the Secret, restart the Deployment to pick
up the new values (the image and Deployment YAML stay untouched):

```bash
kubectl rollout restart deployment/sitrec
```

### Using Podman Instead of Docker

[Podman](https://podman.io/) is a drop-in Docker alternative commonly used on systems where Docker is unavailable (e.g. secure environments, RHEL, Fedora). Sitrec's install script and compose file are compatible with both. See [Installing Podman](#installing-podman-optional) above for setup instructions.

**Key differences from Docker:**

- **SELinux (RHEL/Fedora):** The install script automatically adds `:Z` labels to volume mounts when SELinux is detected. If you're writing a manual `docker-compose.yml`, add `:Z` to your volume paths:
  ```yaml
  volumes:
    - ./sitrec-videos:/var/www/html/sitrec-videos:Z
  ```
- **GHCR access:** If you get "403 Forbidden" pulling the image, clear stale credentials with `podman logout ghcr.io` and retry.
- **Rootless by default:** Podman runs without root privileges. This is normally transparent, but if you see permission errors on mounted volumes, ensure the directories exist before starting the container.

**Daily usage** — the management scripts handle Docker/Podman differences automatically:

| Task | Mac / Linux / WSL | Windows PowerShell |
|------|-------------------|--------------------|
| Start | `./sitrec.sh start` | `.\sitrec.cmd start` |
| Stop | `./sitrec.sh stop` | `.\sitrec.cmd stop` |
| Restart (after .env changes) | `./sitrec.sh restart` | `.\sitrec.cmd restart` |
| Update to latest | `./sitrec.sh pull` | `.\sitrec.cmd pull` |
| Pick / pin a version | `./sitrec.sh versions` | `.\sitrec.cmd versions` |
| Update the management script | `./sitrec.sh update` | `.\sitrec.cmd update` |
| Bake a configured image | `./sitrec.sh bake [--push] <target-image> [--tarball [file]]` | `.\sitrec.cmd bake [-Push] <target-image> [-Tarball [file]]` |
| View logs | `./sitrec.sh logs` | `.\sitrec.cmd logs` |
| Show status | `./sitrec.sh status` | `.\sitrec.cmd status` |

### Air-Gapped / Offline Install

For systems with no internet access (e.g. secure or classified environments), you can transfer the image and install files manually.

**On a machine with internet access:**

1. Pull and save the image to a tar file:
```bash
podman pull ghcr.io/mickwest/sitrec2:latest
podman save ghcr.io/mickwest/sitrec2:latest -o sitrec-image.tar
```
(Substitute `docker` for `podman` if using Docker.)

To transfer a pre-configured image instead, put `prod.env` in the current directory
and bake the tarball in one step:
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --podman --bake sitrec-configured:latest --env-file prod.env --tarball sitrec-image.tar
```
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1))) -Podman -Bake sitrec-configured:latest -EnvFile prod.env -Tarball sitrec-image.tar
```

2. Download the installer:
```bash
curl -sLO https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh
```
```powershell
irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1 -OutFile install.ps1
```

3. Transfer `sitrec-image.tar` and the installer (`install.sh` or `install.ps1`) to the target system. Optionally include a pre-configured `.env` file.

**On the air-gapped system:**

1. Load the image, then check the exact name it loaded under:
```bash
podman load -i sitrec-image.tar
podman images          # note the name:tag — Podman may show it as localhost/sitrec-configured:latest
```
```powershell
podman load -i sitrec-image.tar
podman images          # note the name:tag - Podman may show it as localhost/sitrec-configured:latest
```
Use that exact name with `--image` / `-Image` below.

2. Place the installer in the same directory, then run:
```bash
chmod +x install.sh
./install.sh --offline --podman
```
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Offline -Podman
```

If you transferred a pre-configured image with a custom tag, tell the installer which
loaded image to run:
```bash
./install.sh --offline --podman --image sitrec-configured:latest
```
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Offline -Podman -Image sitrec-configured:latest
```

The `--offline` flag skips image pull and expects the selected image to already be
loaded locally. The installer extracts `sitrec.sh` and `shared.env.example` from
that image on Mac/Linux/WSL, and extracts `sitrec.ps1`, `sitrec.cmd`, and
`shared.env.example` on Windows PowerShell.

---

*The sections below are for developers. If you just want to run Sitrec, the Docker Image method above is all you need.*

---

## Docker Build from Source

Build the Docker image locally from the source code. Useful for testing changes before they're released, or for customizing `config.js` with additional map sources.

**Prerequisites:** Docker Desktop, Git

```bash
git clone https://github.com/MickWest/Sitrec2 sitrec-test-dev
cd sitrec-test-dev
docker compose up --build
```

The app will be at **http://localhost:8080**. The Dockerfile automatically copies `.example` config files if the live versions don't exist, so no manual config setup is needed.

### Docker Development Build (Hot Reload)

For active development with automatic recompilation:

```bash
docker-compose -f docker-compose.dev.yml up --build
```

| Feature | Standard Docker | Development Docker |
|---------|----------------|-------------------|
| Purpose | Production-like | Active development |
| File Changes | Requires rebuild | Auto-recompile |
| Ports | 8080 | 8080 (webpack), 8081 (Apache) |
| Hot Reload | No | Yes |

---

## Serverless Build (No Backend Required)

Creates a version of Sitrec that runs without PHP. All data is stored in the browser's IndexedDB.

**Prerequisites:** Node.js (for server mode) or just a modern browser (for static files)

### Node.js Server Mode

```bash
git clone https://github.com/MickWest/Sitrec2 sitrec-test-dev
cd sitrec-test-dev
for f in config/*.example; do cp "$f" "${f%.example}"; done
npm install
npm run dev-serverless
```

Open **http://localhost:3000/sitrec**

### Static Files Mode

After building with `npm run build-serverless`, the files in `dist-serverless/` can be opened directly in a browser, hosted on any static server (GitHub Pages, S3, etc.), or run completely offline.

**Limitations:** No server-side saves, no cloud sync, no AI chat.
**Advantages:** Zero backend dependencies, works offline, data never leaves your machine.

---

## Standalone Node.js Server

Self-contained build using Node.js + your system's PHP. No separate web server needed.

**Prerequisites:** Node.js, PHP 8.3+ in PATH

```bash
git clone https://github.com/MickWest/Sitrec2 sitrec-test-dev
cd sitrec-test-dev
for f in config/*.example; do cp "$f" "${f%.example}"; done
npm install
npm run dev-standalone-debug
```

**Windows:** Replace the `for` line with: `for %f in (config\*.example) do copy /Y "%f" "%~dpnf"`

Open **http://localhost:3000/sitrec**

This starts a Node.js Express server on port 3000 and PHP's built-in server on port 8000, with proxying between them.

---

## Local Web Server Installation

Full development environment with Nginx/Apache + PHP. This is the setup used for production deployments and active Sitrec development.

### Prerequisites

- Web server (Nginx or Apache) with PHP 8.3+ and HTTPS support
- Node.js with npm

### Setup

```bash
git clone https://github.com/MickWest/Sitrec2 sitrec-test-dev
cd sitrec-test-dev
for f in config/*.example; do cp "$f" "${f%.example}"; done
npm install
```

**Windows:** Replace the `for` line with: `for %f in (config\*.example) do copy /Y "%f" "%~dpnf"`

### Configure Paths

`config/config-install.js` controls where the build is written. By default it derives the output folder from your current git branch — `main` builds to `dist/sitrec`, any other branch to `dist/<branch>` — inside the repo:

```javascript
const buildFolder = (branch === 'main' || branch === 'HEAD') ? 'sitrec' : branch;
module.exports = {
    dev_path:  path.resolve(__dirname, '..', 'dist', buildFolder),   // npm run build
    prod_path: path.resolve(__dirname, '..', 'dist', buildFolder),   // npm run deploy
    buildFolder: buildFolder,
}
```

These paths apply to `npm run build` and `npm run deploy` only — those produce **static files that your own web server serves** (Apache/Nginx + PHP), so point `dev_path` / `prod_path` at a directory your web server serves: a docroot like `/var/www/html/sitrec`, or serve the default `dist/<branch>` directly. The two can differ if you want development and production builds in separate locations.

> The **Standalone** and **Serverless** builds ignore `config-install.js` — they always write to fixed `dist-standalone/` and `dist-serverless/` and bundle their own Node server, so they need no external web server.

### Create Server Directory Structure

Your web server root needs these directories:

- `sitrec/` — the built application (created by webpack)
- `sitrec-cache/` — server-side tile cache (must be writable)
- `sitrec-upload/` — user file uploads (must be writable)
- `sitrec-videos/` — video files (see "Download the Videos" below)
- `sitrec-terrain/` — local terrain tile cache (optional)

### Build

```bash
npm run build    # development build
npm run deploy   # production build (minified)
```

### Configure

Edit the files in `config/`:

- **`shared.env`** — API keys, feature flags, storage settings. See `shared.env.example` for all options.
- **`config.js`** — Custom map sources, help links, local sitch selection. See `config.js.example`.
- **`config.php`** — Server-side auth integration (XenForo, etc.). See `config.php.example`.
- **`config-install.js`** — Build output paths.

### Keeping shared.env up to date

Your `config/shared.env` is yours — it holds your API keys and your settings, and
updating Sitrec never touches it. That creates a problem: when a new Sitrec version
adds a setting to `config/shared.env.example`, nothing in your copy tells you. You
would only find out when a feature quietly failed to work.

So `shared.env.example` carries a version stamp near the top:

```bash
SHARED_ENV_VERSION=2026-08-06
```

It is a date (with a `.1`, `.2` suffix if it changes more than once in a day), and it
is updated automatically whenever the example file's settings change. Your
`shared.env` carries the same line, recording which version of the example you are
in sync with. **The build compares the two and refuses to build if yours is older.**

#### What you will see

Every build command that reads your config — `npm run build`, `npm run deploy`,
`npm run copy`, `npm run build-standalone`, `npm run build-serverless` — stops
immediately with a report like this:

```
============================================================================
 BUILD STOPPED: your config/shared.env is out of date
============================================================================

 config/shared.env.example has changed since your config/shared.env was last brought
 up to date. New or changed settings may affect this install.

     your    config/shared.env          SHARED_ENV_VERSION=2026-05-01
     current config/shared.env.example  SHARED_ENV_VERSION=2026-08-06

 Commits touching config/shared.env.example since your version:
   0fd2bfb0 2026-08-02  Satellites: read OMM CSV, not TLE — the TLE format ran out of...
   3475a5c8 2026-06-23  Added SITREC_TRACK_STATS (false)
   ...

 diff --git a/config/shared.env.example b/config/shared.env.example
 ...the actual changes, so you can see exactly which settings are new...

 What to do:
   ...
```

The commit list and diff come from your git history, so you see precisely which
settings appeared and why. If you installed from a zip (no git history available),
the report links to the file's history on GitHub instead.

#### What you need to do

1. **Read the diff in the report.** It shows every change to the example since your
   version. Most additions are new optional settings with safe defaults that you can
   ignore; what matters is anything affecting how *your* install works — storage,
   authentication, map or elevation sources, or a setting whose default changed.

2. **Copy anything relevant into your `config/shared.env`.** Add the new lines and
   adjust the values for your deployment. Settings you have no opinion about can
   usually be left out — most are optional, and the example file's comments say what
   each one does and what happens when it is unset.

3. **Update the version line in your `config/shared.env`** to match the example's,
   exactly as the report gives it:

   ```bash
   SHARED_ENV_VERSION=2026-08-06
   ```

   If your `shared.env` has no such line (it predates version stamping), add one
   anywhere in the file.

4. **Build again.** This is the only step that clears the block, so do it after you
   have merged what you need — the version line is your statement that you have
   looked.

To see the full picture at any time, compare the two files directly:

```bash
diff config/shared.env config/shared.env.example
```

Expect plenty of differences even when you are current: your file has your real keys
and your own choices. Only the version line decides whether the build proceeds.

#### Notes

- **Fresh installs are never blocked.** Copying `shared.env.example` to `shared.env`
  (as the setup step above does) brings the current stamp with it. The same applies
  to the Docker image and CI, which build from the example.
- **Older branches still build.** If your `shared.env` stamp is *newer* than the
  example's — for instance after checking out an older release — the build proceeds.
- **You can check without building:**
  ```bash
  node scripts/sharedEnvVersion.js --check
  ```

### Download Videos

Public videos (government-produced, unrestricted) are available at:
https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=0

Place them in `sitrec-videos/public/`.

### Testing

After building, verify with these URL tests (adjust the path if not at `/sitrec/`):

- PHP: `http://localhost/sitrec/sitrecServer/info.php` — should show PHP info page
- Terrain proxy: `http://localhost/sitrec/sitrecServer/cachemaps.php?url=https%3A%2F%2Fs3.amazonaws.com%2Felevation-tiles-prod%2Fterrarium%2F14%2F3188%2F6188.png` — should return a terrain tile image
- Default sitch: `http://localhost/sitrec/` — loads the default sitch
- Smoke test: `http://localhost/sitrec/?testAll=1` — loads all sitches sequentially

---

## Build Commands Reference

### Development

| Command | Description |
|---------|-------------|
| `npm run build` | Dev build to `dev_path` — static files served by your web server (default `dist/<branch>`) |
| `npm run start` | Webpack dev server with hot reload (port 3000) |
| `npm run copy` | Copy data/PHP files only (no JS rebuild) |

### Standalone

| Command | Description |
|---------|-------------|
| `npm run dev-standalone-debug` | Build + run with debugging |
| `npm run build-standalone` | Build only |
| `npm run start-standalone` | Run only |

### Serverless

| Command | Description |
|---------|-------------|
| `npm run dev-serverless` | Build + run |
| `npm run build-serverless` | Build only |
| `npm run start-serverless` | Run only |

### Production

| Command | Description |
|---------|-------------|
| `npm run deploy` | Minified production build to `prod_path` |

### Port Configuration

| Mode | Default | Environment Variable |
|------|---------|---------------------|
| Dev server | 3000 | `SITREC_PORT` |
| Dev backend proxy | 8081 | `SITREC_BACKEND_PORT` |
| Standalone PHP | 8000 | `SITREC_PHP_PORT` |
| Docker / Docker Image | 8080 host → **8080 container** | `SITREC_DOCKER_INTERNAL_PORT` (container port) |
| Docker Dev | 8080/8081 | (docker-compose.dev.yml) |

The Docker image's Apache listens on **container port 8080**, not 80. Port 80 is
privileged (only root can bind it), so listening on 8080 lets the container run as a
non-root user — rootless Podman with `--user`, OpenShift's arbitrary assigned UIDs, etc.
The container port almost never needs to change — adjust the **host** port (the left side
of the `ports:` mapping) instead. In the rare case you must change the *container* port
(e.g. another in-container service already uses 8080), set `SITREC_DOCKER_INTERNAL_PORT`
(must be ≥ 1024 when running non-root) and update the right side of the mapping to match.
Note this is **not** `SITREC_PORT`, which is the dev server's host port (default 3000).

> **Upgrading an existing install?** Releases before this one mapped `'8080:80'` in
> `docker-compose.yml`. **If you run the container as root** (the default for plain
> `docker compose` / `docker run`), nothing changes: the container also listens on 80, so
> an old `'8080:80'` mapping keeps working unchanged — no edit needed. **Only non-root
> runs** (rootless Podman with `--user`, OpenShift's arbitrary UIDs, etc.) need the new
> mapping: there the container listens *only* on 8080, so an old `'8080:80'` file forwards
> to container port 80 where nothing listens and the page won't load. **Fix:** change the
> mapping to `'8080:8080'` (or just re-run the installer, which rewrites it).

---

## Production Deployment

```bash
npm run deploy
```

Builds a minified production version to `prod_path`. Transfer to your production server via rsync, scp, or your preferred method:

```bash
rsync -avz --delete -e ssh "$LOCAL_DIR/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
```

Ensure the five server directories exist on the production server with appropriate write permissions for `sitrec-cache` and `sitrec-upload`.

### Production Server Requirements

The Docker images (`Dockerfile`, `Dockerfile.dev`, `Dockerfile.release`) already include everything below. Bare-metal / non-Docker deploys must install it manually on the server.

| Feature | Requirement |
|---------|-------------|
| PHP backend | `php-cli`, `php-xml`, `php-mbstring`, `php-curl`, `php-zip`, `composer` |
| Wind visualization | `python3`, `pip3`, and the pip packages `eccodes` and `certifi` — `sitrecServer/windProxy.php` shells out to `tools/fetch_wind.py`, which parses GRIB2 with `eccodes`. Without these, every wind request returns HTTP 502. |
| Wind cache dir | `data/wind/` writable by the web-server user (auto-created on first request if the parent is writable). |

One-time setup on a fresh Ubuntu / Debian server (run as root or with `sudo`):

```bash
apt-get update
apt-get install -y php-cli php-xml php-mbstring php-curl php-zip composer \
                   python3 python3-pip
pip3 install --no-cache-dir --break-system-packages eccodes certifi
```

`--break-system-packages` is a no-op on Ubuntu ≤ 22.04 and required on Debian 12+ / Ubuntu 24.04+ (PEP 668).

---

## Code Overview

Sitrec runs mostly client-side using JavaScript and Three.js for 3D rendering. Server-side scripts are written in PHP. The code is compiled using webpack.

### Project Structure

- `config/` — configuration files (`.example` templates provided)
- `data/` — per-sitch data (ADS-B, CSV, TLE, models, images)
- `docker/` — Docker build support files
- `docs/` — documentation
- `sitrecServer/` — PHP backend (map proxy, chat, user management)
- `src/` — JavaScript source code (entry point: `index.js`)
- `tests/` — Jest unit tests

### Debugging

Debug builds include source maps, no minification, and Node.js inspector support:

```bash
npm run dev-standalone-debug   # Build + run with full debugging
```

- **Browser:** Open DevTools → Sources → `webpack://sitrec/src/`
- **Node.js:** Connect Chrome DevTools via `chrome://inspect`
- **VS Code:** Use a launch config targeting `standalone-server.js`

Debug endpoints: `/debug/status` and `/debug/files` (standalone); `/api/debug/status`, `/api/debug/files`, and `/api/health` (serverless)
