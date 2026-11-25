#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SITMAP_PACKAGE_PATH="${SITMAP_PACKAGE_PATH:-$PWD}"
swift build -c release --package-path "$SITMAP_PACKAGE_PATH" "$@"
SITMAP_BIN_DIR="$(swift build -c release --package-path "$SITMAP_PACKAGE_PATH" --show-bin-path "$@")"
mkdir -p build/SitMap.app/Contents/MacOS build/SitMap.app/Contents/Resources build/AppIcon.iconset
cp "$SITMAP_BIN_DIR/SitMap" build/SitMap.app/Contents/MacOS/SitMap
cp Info.plist build/SitMap.app/Contents/Info.plist
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" Assets/AppIcon.png --out "build/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
    retina_size=$((size * 2))
    sips -z "$retina_size" "$retina_size" Assets/AppIcon.png --out "build/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
swift -module-cache-path .build/icon-module-cache package-icon.swift build/AppIcon.iconset build/SitMap.app/Contents/Resources/AppIcon.icns
codesign --force --sign - build/SitMap.app
echo "Built $PWD/build/SitMap.app"
