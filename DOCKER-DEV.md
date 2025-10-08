# Docker Development Environment

This setup provides a rapid development environment where you can edit source files on your host machine and see changes instantly with hot module reloading.

## What is Docker?

Docker is a platform that packages applications and their dependencies into containers - isolated environments that run consistently across different machines. Think of it as a lightweight virtual machine that includes everything needed to run the application.

**Benefits for Sitrec development:**
- No need to manually install Node.js, PHP, Apache, or other dependencies
- Consistent environment across all developers' machines
- Easy to start, stop, and reset without affecting your system
- Automatic hot reloading for rapid development

## Installing Docker

Before you begin, you need to install Docker Desktop:

1. **Download Docker Desktop** from [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
2. **Install** the application for your operating system (Mac, Windows, or Linux)
3. **Launch Docker Desktop** and wait for it to start (you'll see the Docker icon in your system tray/menu bar)
4. **Verify installation** by opening a terminal and running:
   ```bash
   docker --version
   docker-compose --version
   ```
   You should see version numbers for both commands.

**Note:** Docker Desktop includes both `docker` and `docker-compose` commands that you'll need for this setup.

## Architecture

- **Webpack Dev Server** (port 8080): Serves the frontend with hot reload
- **Apache/PHP** (port 8081): Handles backend API requests
- **Source Code**: Mounted from your host machine for live editing
- **node_modules**: Kept inside the container for performance

## Prerequisites

Before starting, you need to create configuration files from the provided examples:

**Mac/Linux:**
```bash
for f in config/*.example; do cp "$f" "${f%.example}"; done
```

**Windows:**
```bat
for %f in (config\*.example) do copy /Y "%f" "%~dpnf"
```

This creates:
- `config/config.js` - Client-side configuration (paths, API endpoints)
- `config/config-install.js` - Build system paths
- `config/config.php` - Server-side PHP configuration (API keys, credentials)
- `config/shared.env` - Shared environment variables

For basic development, the default values in these files will work. You can edit them later if you need to add API keys for services like Mapbox, Space-Data, etc.

## Quick Start

### First Time Setup

```bash
# 1. Create config files (see Prerequisites above)
for f in config/*.example; do cp "$f" "${f%.example}"; done
```
This copies the example configuration files to create your local config files with default values.

```bash
# 2. Build the development image
docker-compose -f docker-compose.dev.yml build
```
This builds the Docker image by installing Node.js, PHP, Apache, and all project dependencies. This may take 5-10 minutes the first time. Docker caches each build step, so subsequent builds are much faster (usually under a minute) unless you change dependencies.

```bash
# 3. Start the development environment
docker-compose -f docker-compose.dev.yml up
```
This starts the containers and launches both the webpack dev server (port 8080) and Apache/PHP backend (port 8081). You'll see compilation logs in your terminal.

### Daily Development

```bash
# Start (if already built)
docker-compose -f docker-compose.dev.yml up

# Or run in background
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop
docker-compose -f docker-compose.dev.yml stop

# Stop and remove containers
docker-compose -f docker-compose.dev.yml down
```

## Access the Application

- **Frontend**: http://localhost:8080
- **Backend API**: http://localhost:8081 (proxied automatically)

## Development Workflow

1. **Edit files** on your host machine in the `src/`, `data/`, `docs/`, or `sitrecServer/` directories
2. **Save** your changes
3. **View changes** in your browser:
   - **JavaScript/CSS files** (`src/`): Webpack automatically detects changes and hot reloads (no page refresh needed in most cases)
   - **PHP files** (`sitrecServer/`): Changes are immediately available (refresh the page to see them)
   - **Sitch files** (`data/`): Changes are immediately available (refresh the page to see them)
   - **Webpack config changes**: Require restarting the container

## Manual Builds Inside Container

If you need to run commands inside the container:

```bash
# Get a shell in the running container
docker-compose -f docker-compose.dev.yml exec sitrec-dev bash

# Then run commands:
npm run build          # Full development build
npm run deploy         # Production build
npm test              # Run tests
```

## Rebuilding After Dependency Changes

If you modify `package.json` or `package-lock.json`:

```bash
# Rebuild the image to install new dependencies
docker-compose -f docker-compose.dev.yml build

# Restart
docker-compose -f docker-compose.dev.yml up
```

**Note:** Docker uses layer caching, so it only rebuilds the steps that changed. If you need to force a complete rebuild without using any cache (useful if something seems broken):

```bash
# Clear cache and rebuild everything from scratch
docker-compose -f docker-compose.dev.yml build --no-cache
```

This will take the full 5-10 minutes again but ensures a completely fresh build.

## Troubleshooting

### Changes not reflecting?

- **For JavaScript changes**: Check the browser console for webpack compilation messages. You should see "webpack compiled successfully" after saving a file.
- **For PHP changes**: Make sure you refresh the page (F5 or Cmd+R)
- Check that webpack dev server is running: `docker-compose -f docker-compose.dev.yml logs -f`
- Ensure file permissions allow Docker to read your files
- Try a hard refresh in browser (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows/Linux)

### Testing Hot Reload

To verify hot reload is working:

1. Open the browser console (F12)
2. Edit a JavaScript file in `src/` (e.g., add a `console.log("test")`)
3. Save the file
4. Watch the console - you should see webpack recompiling
5. The page should update automatically (or with a quick refresh)

### Port already in use?

```bash
# Check what's using the port
lsof -i :8080
lsof -i :8081

# Stop the conflicting service or change ports in docker-compose.dev.yml
```

### Need to reset everything?

```bash
# Stop and remove everything
docker-compose -f docker-compose.dev.yml down -v

# Rebuild from scratch
docker-compose -f docker-compose.dev.yml build --no-cache
docker-compose -f docker-compose.dev.yml up
```

### Empty sitrecServer/config.php file appearing?

You may notice an empty `sitrecServer/config.php` file (0 bytes) appearing on your host machine. **This is normal Docker behavior** and not a bug.

**Why it happens:**
- The `docker-compose.dev.yml` has overlapping volume mounts:
  - Line 87: Mounts the entire `sitrecServer/` directory
  - Line 94: Mounts `config/config.php` as a single file inside that directory
- Docker creates an empty placeholder file on the host to track this mount point

**What you should know:**
- The empty file is harmless and can be ignored
- It's already in `.gitignore` so it won't be committed
- The actual config used by PHP comes from `config/config.php` (2953 bytes), not this empty file
- The file will be recreated each time you start the container - this is expected
- Do not delete it while the container is running

## Production Build

For production deployment, use the standard `docker-compose.yml` (without the `.dev` suffix).

**Note:** Since `docker-compose.yml` is the default filename, you don't need the `-f` parameter (unlike development which requires `-f docker-compose.dev.yml`).

```bash
# Build the production image
docker-compose build

# Start in detached mode
docker-compose up -d

# Check it's running
docker-compose ps

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

**Key differences from development:**
- Uses multi-stage build with optimized production webpack bundle
- Runs on port **6425** (not 8080/8081)
- No hot reloading - this is a static build
- Much smaller final image (only includes Apache + PHP + built files)
- Source code is NOT mounted - changes require rebuilding the image

**Access:** http://localhost:6425

This creates an optimized production build without development dependencies or source code mounts.