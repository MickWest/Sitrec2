#!/bin/bash
# Download public video files for Sitrec legacy sitches (Gimbal, GoFast, etc.)
# Usage: curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/download-videos.sh | bash
#
# These videos are only needed to run legacy analysis sitches locally.
# They can also be viewed online at https://www.metabunk.org/sitrec

set -e

DROPBOX_URL="https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=1"
DEST="sitrec-videos/public"
ZIP_FILE="sitrec-videos-public.zip"

if [ -f "docker-compose.yml" ]; then
    :
elif [ -f "sitrec/docker-compose.yml" ]; then
    cd sitrec
else
    echo "[sitrec] ERROR: run this from your Sitrec install folder, or from the folder that contains it."
    echo "[sitrec] Expected to find docker-compose.yml or sitrec/docker-compose.yml."
    exit 1
fi

if ! grep -q "sitrec-videos" docker-compose.yml; then
    echo "[sitrec] WARNING: docker-compose.yml does not mount sitrec-videos/."
    echo "[sitrec] The current installer adds this by default; older installs may need reinstalling or manual compose edits."
fi

if [ -d "$DEST" ] && [ "$(ls -A "$DEST" 2>/dev/null)" ]; then
    echo "[sitrec] $DEST already exists and is not empty. Skipping download."
    echo "[sitrec] To re-download, remove the folder first: rm -rf sitrec-videos"
    exit 0
fi

mkdir -p "$DEST"

echo "[sitrec] Downloading public video files (~1.3 GB)..."
echo "[sitrec] This may take a few minutes depending on your connection."
echo ""

if command -v curl &>/dev/null; then
    curl -L -o "$ZIP_FILE" "$DROPBOX_URL"
elif command -v wget &>/dev/null; then
    wget -O "$ZIP_FILE" "$DROPBOX_URL"
else
    echo "[sitrec] ERROR: curl or wget is required. Please install one and try again."
    echo "[sitrec] Or download manually from:"
    echo "  https://www.dropbox.com/scl/fo/biko4zk689lgh5m5ojgzw/h?rlkey=stuaqfig0f369jzujgizsicyn&dl=0"
    exit 1
fi

echo "[sitrec] Extracting..."
unzip -o "$ZIP_FILE" -d "$DEST"
rm -f "$ZIP_FILE"

echo ""
echo "[sitrec] Videos downloaded to $DEST/"
echo "[sitrec] Restart the container to pick them up:"
if [ -x "./sitrec.sh" ]; then
    echo "  ./sitrec.sh restart"
else
    echo "  docker compose down && docker compose up"
fi
