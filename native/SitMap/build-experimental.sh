#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
python3 Experiments/prepare.py
SITMAP_PACKAGE_PATH="$PWD/build/Experimental/Package" bash build.sh "$@"
