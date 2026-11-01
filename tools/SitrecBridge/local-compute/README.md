# Sitrec Local Compute

Local Compute is an optional helper for **Video → Motion Analysis**. It is part
of SitrecBridge. It runs the full-range analysis on your own computer in native
Python/OpenCV, and returns the result to Sitrec. See
[Motion Analysis](https://www.metabunk.org/sitrec/docs/MotionAnalysis.html#local-compute).

Local Compute works only when the Sitrec page comes from `local.metabunk.org`,
`localhost` or `127.0.0.1`. The Bridge refuses pages from `www.metabunk.org`, so
Motion Analysis on the public site runs in the browser.

The worker reads the video from its URL. A video that you dropped into Sitrec
and have not uploaded has no URL, so that analysis runs in the browser.

## Before you start

Local Compute is installed through a running SitrecBridge. If you have not yet
downloaded the Bridge, loaded the Chrome extension, or configured your MCP
client, follow `SETUP.md` in the downloaded Bridge folder first. It is the same
guide as
[Control Sitrec from an AI assistant (MCP Bridge)](https://www.metabunk.org/sitrec/docs/MCPBridge.html).

The short version is:

1. In Sitrec, select **Help → Documentation → Download MCP Bridge**.
2. Unzip `SitrecBridge.zip`.
3. Load `SitrecBridge/extension/` in Chrome.
4. Configure Codex, Claude Code, Claude Desktop, or another MCP client to start
   SitrecBridge.
5. Confirm the SitrecBridge extension popup shows green **MCP Servers** and
   **Sitrec Tabs** indicators.

## Dependencies

Install these first. The **Install/Update Local Compute** button does not
install them.

- Python 3 with `pip`
- `ffmpeg` and `ffprobe` (the installer stops if either one is missing)

Current platform status:

| Platform | Status |
|----------|--------|
| macOS | Supported by the bundled Bash installer. If `ffmpeg` is missing, install it with Homebrew (`brew install ffmpeg`) or another package manager. |
| Linux | Supported when `python3`, `pip`, and `ffmpeg`/`ffprobe` are available. Install `ffmpeg` through your distribution package manager. |
| Windows | Supported by the bundled PowerShell installer. Install Python 3 and ffmpeg first if they are not already available. The installer suggests `winget install --id Python.Python.3.12` and `winget install --id Gyan.FFmpeg` when dependencies are missing. |

## Install or update

Once SitrecBridge is connected, click **Install/Update Local Compute** in the
SitrecBridge extension popup. The result appears in the popup's **Activity**
list: `local_compute_install` with a ✓ or a ✗.
[Section 6 of the guide](https://www.metabunk.org/sitrec/docs/MCPBridge.html#6-install-or-update-local-compute)
has the full steps.

That button asks the running Bridge to run the Local Compute installer. The
installer checks for Python, ffmpeg and ffprobe. It then uses pip to install or
update the Python packages `opencv-python-headless` and `numpy`. The popup text
`Local Compute available on :PORT` means only that the Bridge can run the
installer. It does not show that an install has finished.

If the Local Compute worker code itself has changed, update the Bridge package
first. The button does not update the worker. Follow
[Updating later](https://www.metabunk.org/sitrec/docs/MCPBridge.html#7-updating-later)
in the guide.

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

To use a specific Python, set `SITREC_LOCAL_COMPUTE_PYTHON` to its absolute path
in your MCP client. Then restart the client and click
**Install/Update Local Compute** again. The client starts the Bridge, and the
Bridge passes the variable to installs and jobs.
[The guide](https://www.metabunk.org/sitrec/docs/MCPBridge.html#6-install-or-update-local-compute)
shows how for each client. If you run an installer from a terminal, set the same
value there.

You need this variable in two cases:

- pip stops with `externally-managed-environment`. Homebrew Python does this,
  and a Linux distribution's Python can do it too. Make a virtual environment
  with `python3 -m venv ~/sitrec-python`, and use the absolute path of its
  `bin/python`.
- You use Windows. The installer tries `py -3`, then `python`, then `python3`,
  but analysis jobs start only `python3`. Use the full path of `python.exe`.

Useful environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SITREC_LOCAL_COMPUTE_PYTHON` | `python3` (the Windows installer searches first, see above) | Python executable used for installs and jobs |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_MB` | `1024` | Motion Analysis grayscale-frame cache memory budget |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_LIMIT` | unset | Hard frame-count cache cap; overrides the memory budget |

## Motion Analysis

The worker mirrors Sitrec's browser-side motion analyzer result format. It
supports:

- Linear Tracklet
- Sparse + Consensus
- Phase Correlation
- ECC Euclidean (the worker runs Affine RANSAC for this option)
- Affine RANSAC
- duplicate-frame detection
- motion masks
- static feature rejection
- moving-object/background rejection
- bad-frame gap fill

The browser still owns the UI, overlays, graph, panorama, stabilization, CSV
export, and track creation. Local Compute runs only the full-range analysis pass
that **Create Track from Motion**, **Export Motion**, **Stabilize Video** and the
motion panorama exports start. **Analyze Motion** still runs in the browser.

**Use Local Compute**, in **Video → Motion Analysis**, is on by default. The
**Local Compute** row below it shows `Done (N frames)` after a Local Compute run.
If Local Compute is unavailable, the row shows `Fallback:` and the reason, and
Sitrec analyzes in the browser. The Bridge must be running, so keep your MCP
client open.
