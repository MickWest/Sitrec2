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
