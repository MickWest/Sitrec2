#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${SITREC_LOCAL_COMPUTE_PYTHON:-python3}"

echo "Sitrec Local Compute dependency check"
echo "Python: $($PYTHON_BIN --version 2>&1)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Missing ffmpeg. Install it with Homebrew: brew install ffmpeg" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "Missing ffprobe. Install it with Homebrew: brew install ffmpeg" >&2
  exit 1
fi

"$PYTHON_BIN" -m pip install --upgrade --disable-pip-version-check opencv-python-headless numpy

"$PYTHON_BIN" - <<'PY'
import cv2
import numpy
print("OpenCV:", cv2.__version__)
print("NumPy:", numpy.__version__)
PY

echo "ffmpeg: $(command -v ffmpeg)"
echo "ffprobe: $(command -v ffprobe)"
echo "Local Compute dependencies are ready."
