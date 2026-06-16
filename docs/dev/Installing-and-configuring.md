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

**Prerequisites:** Install either Docker or Podman (see below), then run the one-liner install.

### Installing Docker (Simplest)

Download and install [Docker Desktop](https://www.docker.com/) for your platform — it includes everything you need (engine, compose, and GUI). Available for Windows, Mac, and Linux.

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

Open a terminal and paste the command for your platform. This downloads a small install script that sets everything up automatically. The script auto-detects whether you have Docker or Podman installed.

**Mac / Linux / WSL:**
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.ps1 | iex
```

If you have both Docker and Podman installed, the script defaults to Docker. Use `--podman` or `--docker` to override:
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --podman
```
Or if you have `install.sh` locally:
```bash
./install.sh --podman
```

If you have a pre-configured `.env` file, place it in the current directory before running the installer — it will be copied into the `sitrec/` folder automatically instead of generating a new template.

This creates a `sitrec/` folder in your current directory, downloads Sitrec, and starts it. Once you see "resuming normal operations" in the output, open **http://localhost:8080** in your browser.

### Manual Install

If you prefer to set things up yourself instead of using the install script:

1. Create a new folder (e.g. `sitrec`), and inside it create a text file named `docker-compose.yml` with this content:

```yaml
services:
  sitrec:
    image: ghcr.io/mickwest/sitrec2:latest
    ports:
      - '8080:80'
    env_file:
      - .env
    volumes:
      - ./sitrec-videos:/var/www/html/sitrec-videos
```

2. Create an empty `.env` file in the same folder (required by the compose file; you can add settings to it later).

3. Open a terminal in that folder and run:
```bash
docker compose up        # Docker
podman-compose up        # Podman
```

4. Once you see "resuming normal operations", open **http://localhost:8080** in your browser.

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
```

After editing `.env`, you must recreate the container (not just restart it). Environment variables are baked in at creation time. The easiest way is to use the included management script:
```bash
./sitrec.sh restart
```

Or manually:
```bash
docker compose down && docker compose up          # Docker
podman-compose down && podman-compose up           # Podman
```

Map sources that require an API token (e.g. MapBox, MapTiler) only appear in the terrain menu when the corresponding token is provided. Without any tokens, the app uses ESRI World Imagery and AWS Terrarium elevation, which require no keys.

### Videos for Legacy Sitches (Optional)

Sitrec works fully without any video files — you can create and view custom sitches, load tracks, and explore 3D terrain. Video files are only needed to view legacy analysis sitches (Gimbal, GoFast, Aguadilla, etc.). These sitches can also be viewed online at [metabunk.org/sitrec](https://www.metabunk.org/sitrec).

If you want to run legacy sitches locally, download the public video files into a `sitrec-videos` folder next to your `docker-compose.yml`:

**Mac / Linux / WSL:**
```bash
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.ps1 | iex
```

Or download manually from [this Dropbox folder](https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=0) and place the files in `sitrec-videos/public/`. Then restart the container.

### Updating to the Latest Version

To get the newest release:
```bash
./sitrec.sh pull
```

Or manually:
```bash
docker compose pull && docker compose down && docker compose up      # Docker
podman-compose pull && podman-compose down && podman-compose up      # Podman
```

### Pinning a Specific Version

By default Sitrec uses the latest release. To lock to a specific version, edit the `image:` line in `docker-compose.yml`:
```yaml
image: ghcr.io/mickwest/sitrec2:2.36.0
```

### Baking a Pre-Configured Image

By default the published image (`ghcr.io/mickwest/sitrec2`) is **unconfigured**: its
entrypoint reads your environment variables (from `.env` / `env_file`) at *container
start* and writes them into `shared.env.php` (PHP) and `window.__SITREC_ENV__` (JS).

Sometimes you instead want a **self-configured image** that already contains your
settings, so it can be stored in your own registry and deployed without supplying a
`.env` at all — for example to push a ready-to-run image to a private registry, or to
hand a pre-configured tarball to an air-gapped site. The `bake` command does this:

```bash
# Build a new image FROM the published one, with .env baked in:
./sitrec.sh bake registry.example.com/sitrec:configured

# Build and push it to its registry in one step:
./sitrec.sh bake --push registry.example.com/sitrec:configured

# Use a different env file and pin a specific base version:
./sitrec.sh bake --env-file prod.env --base 2.84.4 --push myregistry.io/team/sitrec:1.0
```

| Option | Meaning |
|--------|---------|
| `--env-file <file>` | Env file to bake in (default: `.env`) |
| `--base <tag>` | Base image tag to build `FROM` (default: `latest`) |
| `--push` | Push the resulting image to its registry after building |

How it works: `bake` generates a tiny derived `Dockerfile` (`FROM
ghcr.io/mickwest/sitrec2:<tag>` plus one `ENV` line per variable) and builds it. No
rebuild of the app is needed — the same runtime entrypoint that normally reads `.env`
simply reads the baked-in `ENV` values instead. Because Docker `ENV` is the
lowest-priority source, a deployment can still **override** any baked value by passing
`-e`/`env_file` at run time, so the image is pre-configured but not frozen.

> ⚠️ **Security:** every value in the env file is embedded in the image as build-time
> `ENV` layers, recoverable by anyone who can pull the image or read its `docker
> history` / `docker inspect`. Since the env set includes secrets (API keys, S3
> credentials, etc.), only push baked images to a **private** registry you trust. If
> you only need banners/map tokens baked in, bake a secrets-free env file and keep the
> secrets in the runtime `.env`.

### Using Podman Instead of Docker

[Podman](https://podman.io/) is a drop-in Docker alternative commonly used on systems where Docker is unavailable (e.g. secure environments, RHEL, Fedora). Sitrec's install script and compose file are compatible with both. See [Installing Podman](#installing-podman) above for setup instructions.

**Key differences from Docker:**

- **SELinux (RHEL/Fedora):** The install script automatically adds `:Z` labels to volume mounts when SELinux is detected. If you're writing a manual `docker-compose.yml`, add `:Z` to your volume paths:
  ```yaml
  volumes:
    - ./sitrec-videos:/var/www/html/sitrec-videos:Z
  ```
- **GHCR access:** If you get "403 Forbidden" pulling the image, clear stale credentials with `podman logout ghcr.io` and retry.
- **Rootless by default:** Podman runs without root privileges. This is normally transparent, but if you see permission errors on mounted volumes, ensure the directories exist before starting the container.

**Daily usage** — the `sitrec.sh` management script handles Docker/Podman differences automatically:

| Task | Command |
|------|---------|
| Start | `./sitrec.sh start` |
| Stop | `./sitrec.sh stop` |
| Restart (after .env changes) | `./sitrec.sh restart` |
| Update to latest | `./sitrec.sh pull` |
| Bake a configured image | `./sitrec.sh bake [--push] <target-image>` |
| View logs | `./sitrec.sh logs` |
| Show status | `./sitrec.sh status` |

### Air-Gapped / Offline Install

For systems with no internet access (e.g. secure or classified environments), you can transfer the image and install files manually.

**On a machine with internet access:**

1. Pull and save the image to a tar file:
```bash
podman pull ghcr.io/mickwest/sitrec2:latest
podman save ghcr.io/mickwest/sitrec2:latest -o sitrec-image.tar
```
(Substitute `docker` for `podman` if using Docker.)

2. Download the install files:
```bash
curl -sLO https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh
curl -sLO https://raw.githubusercontent.com/MickWest/Sitrec2/main/sitrec.sh
curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/config/shared.env.example -o shared.env.example
```

3. Transfer `sitrec-image.tar`, `install.sh`, `sitrec.sh`, and `shared.env.example` to the target system. Optionally include a pre-configured `.env` file.

**On the air-gapped system:**

1. Load the image:
```bash
podman load -i sitrec-image.tar
```

2. Place `install.sh`, `sitrec.sh`, and `shared.env.example` in the same directory, then run:
```bash
chmod +x install.sh
./install.sh --offline --podman
```

The `--offline` flag skips image pull and file downloads. It copies `sitrec.sh` and `shared.env.example` from alongside `install.sh` instead.

---

*The sections below are for developers. If you just want to run Sitrec, the Docker Image method above is all you need.*

---

## Docker Build from Source

Build the Docker image locally from the source code. Useful for testing changes before they're released, or for customizing `config.js` with additional map sources.

**Prerequisites:** Docker Desktop, Git

```bash
git clone https://github.com/MickWest/sitrec2 sitrec-test-dev
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
git clone https://github.com/MickWest/sitrec2 sitrec-test-dev
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
git clone https://github.com/MickWest/sitrec2 sitrec-test-dev
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
git clone https://github.com/MickWest/sitrec2 sitrec-test-dev
cd sitrec-test-dev
for f in config/*.example; do cp "$f" "${f%.example}"; done
npm install
```

**Windows:** Replace the `for` line with: `for %f in (config\*.example) do copy /Y "%f" "%~dpnf"`

### Configure Paths

Edit `config/config-install.js` to point at your web server:

```javascript
module.exports = {
    dev_path: '/path/to/your/webserver/sitrec',
    prod_path: '/path/to/staging/folder'
}
```

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
| `npm run build` | Build to `dev_path` (requires web server) |
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
| Docker / Docker Image | 8080 | (docker-compose.yml) |
| Docker Dev | 8080/8081 | (docker-compose.dev.yml) |

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

Debug endpoints (standalone/serverless): `/debug/status`, `/debug/files`, `/api/health`
