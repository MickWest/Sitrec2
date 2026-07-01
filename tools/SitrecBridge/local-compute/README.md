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

## Install or update

Run:

```bash
tools/SitrecBridge/local-compute/install.sh
```

Or use the SitrecBridge browser extension popup's
`Install/Update Local Compute` button. That asks the selected running
SitrecBridge process to run the same installer and streams the latest installer
line into the popup.

Set `SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` before starting
SitrecBridge if you want a specific Python environment.

Current platform status:

| Platform | Status |
|----------|--------|
| macOS | Supported by the bundled Bash installer. If `ffmpeg` is missing, install it with Homebrew (`brew install ffmpeg`) or another package manager. |
| Linux | Supported when `python3`, `pip`, and `ffmpeg`/`ffprobe` are available. Install `ffmpeg` through your distribution package manager. |
| Windows | The worker is portable Python/OpenCV, but the bundled one-click installer currently runs `bash`. Install Python/OpenCV/NumPy/ffmpeg manually, or use Git Bash/WSL until a PowerShell installer is added. |

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
