# Sitrec Local Compute

Local Compute lets the Sitrec browser UI submit heavy jobs to the local
SitrecBridge process. Motion Analysis uses this path to run native Python/OpenCV
over the source video and import the result back into the existing
`MotionAnalyzer` cache.

## Dependencies

- `python3`
- Python `opencv-python-headless` or an equivalent `cv2` install
- Python `numpy`
- `ffmpeg` / `ffprobe`

## Before you start

Local Compute is installed through a running SitrecBridge. If you have not yet
downloaded the Bridge, loaded the Chrome extension, or configured your MCP
client, follow the main SitrecBridge `README.md` in the downloaded Bridge
folder first.

The short version is:

1. Download **MCP Bridge** from Sitrec's **Help -> Documentation** menu.
2. Unzip `SitrecBridge.zip`.
3. Load `SitrecBridge/extension/` in Chrome.
4. Configure Claude Desktop or Claude Code to start SitrecBridge.
5. Confirm the SitrecBridge extension popup shows green **MCP Servers** and
   **Sitrec Tabs** indicators.

## Install or update

Once SitrecBridge is connected:

1. Open Sitrec in Chrome.
2. Click the SitrecBridge extension icon.
3. Click **Install/Update Local Compute**.
4. Wait for the popup to report that Local Compute dependencies are ready.

That button asks the currently running Bridge to install or update the Python,
OpenCV, NumPy, and ffmpeg/ffprobe dependencies used by Local Compute.

If the Local Compute worker code itself has changed, update the Bridge package
first:

1. Download a fresh **MCP Bridge** zip from Sitrec's **Help -> Documentation**
   menu.
2. Unzip it, replacing the old Bridge folder or creating a new one.
3. Restart your MCP client so it starts the new Bridge.
4. Reload the Chrome extension from the new `SitrecBridge/extension/` folder.
5. Click **Install/Update Local Compute** again.

From a cloned Sitrec source tree on macOS or Linux, run:

```bash
npm run local-compute-install
```

or:

```bash
tools/SitrecBridge/local-compute/install.sh
```

From a cloned Sitrec source tree on Windows, run:

```powershell
npm run local-compute-install-win
```

or:

```powershell
powershell -ExecutionPolicy Bypass -File tools/SitrecBridge/local-compute/install.ps1
```

Set `SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` before starting
SitrecBridge if you want a specific Python environment. On Windows, the
PowerShell installer uses `py -3` first when no explicit Python is set, then
falls back to `python` or `python3`.

Current platform status:

| Platform | Status |
|----------|--------|
| macOS | Supported by the bundled Bash installer. If `ffmpeg` is missing, install it with Homebrew (`brew install ffmpeg`) or another package manager. |
| Linux | Supported when `python3`, `pip`, and `ffmpeg`/`ffprobe` are available. Install `ffmpeg` through your distribution package manager. |
| Windows | Supported by the bundled PowerShell installer. Install Python 3 and ffmpeg first if they are not already available. The installer suggests `winget install --id Python.Python.3.12` and `winget install --id Gyan.FFmpeg` when dependencies are missing. |

Useful environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SITREC_LOCAL_COMPUTE_PYTHON` | `python3` | Python executable used for installs and jobs |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_MB` | `1024` | Motion Analysis grayscale-frame cache memory budget |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_LIMIT` | unset | Hard frame-count cache cap; overrides the memory budget |

## Motion Analysis

The worker mirrors Sitrec's browser-side motion analyzer result format. It
supports:

- Linear Tracklet
- Sparse + Consensus
- Phase Correlation
- ECC Euclidean
- Affine RANSAC
- duplicate-frame detection
- motion masks
- static feature rejection
- moving-object/background rejection
- bad-frame gap fill

The browser still owns the UI, overlays, graph, panorama, stabilization, CSV
export, and track creation. Local Compute only accelerates the full-frame
analysis pass and returns cache-compatible results.

If Local Compute is unavailable, Sitrec logs the error and automatically falls
back to the existing in-browser analysis path.
