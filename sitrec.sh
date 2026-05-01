#!/bin/bash
# Sitrec management script
# Usage: ./sitrec.sh [command]
#
# Commands:
#   start       Start the container
#   stop        Stop the container
#   restart     Stop and recreate the container (picks up .env changes)
#   pull        Pull the latest image and recreate the container
#   versions    List available versions and switch to one
#   update      Update this script and shared.env.example from GitHub
#   logs        Follow container logs
#   status      Show container status
#
# The compose command (docker compose / podman-compose) is read from
# .runtime, which is written by install.sh during initial setup.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="ghcr.io/mickwest/sitrec2"

# ---------------------------------------------------------------------------
# Read the compose command from .runtime (written by install.sh)
# ---------------------------------------------------------------------------
if [ -f ".runtime" ]; then
    COMPOSE="$(cat .runtime)"
else
    # Fall back to auto-detection if .runtime is missing
    if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
        COMPOSE="docker compose"
    elif command -v podman-compose &>/dev/null; then
        COMPOSE="podman-compose"
    elif command -v podman &>/dev/null && podman compose --help &>/dev/null 2>&1; then
        COMPOSE="podman compose"
    else
        echo "[sitrec] ERROR: Neither docker nor podman found."
        exit 1
    fi
    echo "[sitrec] Note: .runtime not found, auto-detected: $COMPOSE"
fi

# ---------------------------------------------------------------------------
# Helper: print a "running" status line with the live version probed from
# the container's build-version.txt (written by webpack into the webroot).
# Polls for up to ~10s while the container starts serving HTTP.
# ---------------------------------------------------------------------------
print_running() {
    local prefix="$1"  # e.g. "Running" or "Updated and running"
    local version=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        version=$(curl -sf http://localhost:8080/build-version.txt 2>/dev/null) && break
        sleep 1
    done
    if [ -n "$version" ]; then
        echo "[sitrec] ${prefix} at http://localhost:8080 — $version"
    else
        echo "[sitrec] ${prefix} at http://localhost:8080 (version probe timed out)"
    fi
}

# ---------------------------------------------------------------------------
# Helper: switch the image tag in docker-compose.yml
# ---------------------------------------------------------------------------
switch_version() {
    local tag="$1"
    sed -i.bak "s|image: ${IMAGE}:.*|image: ${IMAGE}:${tag}|" docker-compose.yml
    rm -f docker-compose.yml.bak
    echo "[sitrec] Switched to ${IMAGE}:${tag}"
    $COMPOSE pull
    $COMPOSE down
    $COMPOSE up -d
    print_running "Running"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
case "${1:-help}" in
    start|restart)
        echo "[sitrec] Starting (recreating container to pick up any .env changes)..."
        $COMPOSE down 2>/dev/null || true
        $COMPOSE up -d
        print_running "Running"
        ;;
    stop)
        echo "[sitrec] Stopping..."
        $COMPOSE down
        ;;
    pull)
        echo "[sitrec] Pulling latest image and restarting..."
        # Always re-pin docker-compose.yml to :latest before pulling, so that
        # `pull` reliably means "get the newest version" regardless of any
        # prior `versions <X>` selection that pinned an older tag. Without
        # this, pull would re-fetch the same older tag in a loop.
        sed -i.bak "s|image: ${IMAGE}:.*|image: ${IMAGE}:latest|" docker-compose.yml
        rm -f docker-compose.yml.bak
        $COMPOSE pull
        $COMPOSE down
        $COMPOSE up -d
        print_running "Updated and running"
        ;;
    versions)
        echo "[sitrec] Fetching available versions from GHCR..."

        # Get anonymous auth token
        TOKEN=$(curl -sf "https://ghcr.io/token?scope=repository:mickwest/sitrec2:pull" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

        if [ -z "$TOKEN" ]; then
            echo "[sitrec] ERROR: Could not reach GHCR. Are you online?"
            exit 1
        fi

        # Fetch tags, filter to version numbers, sort newest first
        AUTH_HDR="Authorization: Bearer $TOKEN"
        # ?n=1000 bypasses GHCR's default 100-tag page; build-* tags otherwise
        # crowd the page and truncate the newest version tags from the list.
        TAGS=$(curl -sf -H "$AUTH_HDR" \
            "https://ghcr.io/v2/mickwest/sitrec2/tags/list?n=1000" \
            | python3 -c "
import sys, json
data = json.load(sys.stdin)
tags = [t for t in data['tags'] if not t.startswith('build-') and t != 'latest']
tags.sort(key=lambda t: tuple(int(p) for p in t.split('.')) if all(p.isdigit() for p in t.split('.')) else (-1,), reverse=True)
for t in tags:
    print(t)
" 2>/dev/null)

        if [ -z "$TAGS" ]; then
            echo "[sitrec] ERROR: Could not fetch version list."
            exit 1
        fi

        # Find which version tag 'latest' points to by comparing manifest digests.
        # Uses HEAD requests for speed; only checks the 3 newest tags.
        LATEST_VERSION=""
        ACCEPT_HDR="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
        MANIFEST_URL="https://ghcr.io/v2/mickwest/sitrec2/manifests"
        LATEST_DIGEST=$(curl -sf -I -H "$AUTH_HDR" -H "$ACCEPT_HDR" \
            "$MANIFEST_URL/latest" 2>/dev/null \
            | grep -i docker-content-digest | awk '{print $2}' | tr -d '\r' || true)

        if [ -n "$LATEST_DIGEST" ]; then
            CHECK_COUNT=0
            while IFS= read -r tag; do
                [ $CHECK_COUNT -ge 3 ] && break
                TAG_DIGEST=$(curl -sf -I -H "$AUTH_HDR" -H "$ACCEPT_HDR" \
                    "$MANIFEST_URL/$tag" 2>/dev/null \
                    | grep -i docker-content-digest | awk '{print $2}' | tr -d '\r' || true)
                if [ "$TAG_DIGEST" = "$LATEST_DIGEST" ]; then
                    LATEST_VERSION="$tag"
                    break
                fi
                CHECK_COUNT=$((CHECK_COUNT + 1))
            done <<< "$TAGS"
        fi

        # Show current version
        CURRENT=$(grep "image:" docker-compose.yml | sed "s|.*${IMAGE}:||" | tr -d ' ')

        # When pinned to 'latest', resolve the actual locally-installed version.
        LOCAL_VERSION=""
        if [ "$CURRENT" = "latest" ]; then
            case "$COMPOSE" in
                docker*)  RUNTIME_CMD="docker" ;;
                *)        RUNTIME_CMD="podman" ;;
            esac

            # Method 1: Read the version label baked into the image by CI.
            # The docker/metadata-action sets org.opencontainers.image.version.
            LOCAL_VERSION=$($RUNTIME_CMD image inspect "${IMAGE}:latest" \
                --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)

            # Method 2: Fall back to digest comparison against remote tags.
            if [ -z "$LOCAL_VERSION" ] || [ "$LOCAL_VERSION" = "<no value>" ]; then
                LOCAL_VERSION=""
                LOCAL_DIGEST=$($RUNTIME_CMD image inspect "${IMAGE}:latest" \
                    --format '{{index .RepoDigests 0}}' 2>/dev/null \
                    | sed 's/.*@//' || true)
                if [ -n "$LOCAL_DIGEST" ]; then
                    MULTI_ACCEPT="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
                    if [ -n "$LATEST_DIGEST" ] && [ "$LOCAL_DIGEST" = "$LATEST_DIGEST" ]; then
                        LOCAL_VERSION="$LATEST_VERSION"
                    else
                        _lc=0
                        while IFS= read -r _ltag; do
                            [ $_lc -ge 10 ] && break
                            _ld=$(curl -sf -I -H "$AUTH_HDR" -H "$MULTI_ACCEPT" \
                                "$MANIFEST_URL/$_ltag" 2>/dev/null \
                                | grep -i docker-content-digest | awk '{print $2}' | tr -d '\r' || true)
                            if [ "$_ld" = "$LOCAL_DIGEST" ]; then
                                LOCAL_VERSION="$_ltag"
                                break
                            fi
                            _lc=$((_lc + 1))
                        done <<< "$TAGS"
                    fi
                fi
            fi
        fi

        echo ""
        if [ "$CURRENT" = "latest" ]; then
            if [ -n "$LOCAL_VERSION" ]; then
                echo "  Installed: $LOCAL_VERSION (pinned to latest)"
                if [ -n "$LATEST_VERSION" ] && [ "$LOCAL_VERSION" != "$LATEST_VERSION" ]; then
                    echo "  Available: $LATEST_VERSION  ← run ./sitrec.sh pull to update"
                fi
            else
                echo "  Current: latest (could not determine installed version)"
            fi
        else
            echo "  Current: $CURRENT"
        fi
        echo ""

        # If latest didn't match any version tag, show it as a separate entry
        if [ -z "$LATEST_VERSION" ]; then
            TAGS="latest"$'\n'"$TAGS"
        fi

        # Number the list, merging 'latest' onto its matching version
        i=1
        while IFS= read -r tag; do
            LABEL="$tag"
            if [ -n "$LATEST_VERSION" ] && [ "$tag" = "$LATEST_VERSION" ]; then
                LABEL="$tag (latest)"
            fi
            if [ "$tag" = "$CURRENT" ] || { [ "$CURRENT" = "latest" ] && [ "$tag" = "${LOCAL_VERSION:-$LATEST_VERSION}" ]; }; then
                printf "  %2d) %s  <-- installed\n" "$i" "$LABEL"
            else
                printf "  %2d) %s\n" "$i" "$LABEL"
            fi
            i=$((i + 1))
        done <<< "$TAGS"

        echo ""
        printf "Enter number to switch (or press Enter/Esc to cancel): "

        # Read first character silently so we can detect Escape (\x1b)
        read -rsn1 first_char

        if [[ "$first_char" == $'\x1b' ]] || [[ -z "$first_char" ]]; then
            echo ""
            echo "[sitrec] Cancelled."
            exit 0
        fi

        # Echo the typed character, then read the rest of the line normally
        echo -n "$first_char"
        read -r rest
        choice="${first_char}${rest}"

        # Get the selected tag
        SELECTED=$(echo "$TAGS" | sed -n "${choice}p")

        if [ -z "$SELECTED" ]; then
            echo "[sitrec] Invalid selection."
            exit 1
        fi

        # If they picked the version that 'latest' points to, use 'latest' as the
        # tag so it auto-tracks future releases
        if [ "$SELECTED" = "$LATEST_VERSION" ]; then
            SELECTED="latest"
        fi

        # Skip only if the local image is genuinely up to date.
        # When pinned to 'latest', compare the resolved local version
        # against the resolved remote version, not just the tag name.
        if [ "$SELECTED" = "$CURRENT" ]; then
            if [ "$CURRENT" != "latest" ] || \
               { [ -n "$LOCAL_VERSION" ] && [ "$LOCAL_VERSION" = "$LATEST_VERSION" ]; }; then
                echo "[sitrec] Already running $CURRENT."
                exit 0
            fi
        fi

        switch_version "$SELECTED"
        ;;
    update)
        echo "[sitrec] Updating sitrec.sh from GitHub..."
        REPO_URL="https://raw.githubusercontent.com/MickWest/Sitrec2/main"
        # Download to temp file first — replacing a running script mid-execution is unsafe
        curl -sf "$REPO_URL/sitrec.sh" -o sitrec.sh.tmp
        if [ $? -ne 0 ] || [ ! -s sitrec.sh.tmp ]; then
            rm -f sitrec.sh.tmp
            echo "[sitrec] ERROR: Download failed. Are you online?"
            exit 1
        fi
        mv sitrec.sh.tmp sitrec.sh
        chmod +x sitrec.sh
        echo "[sitrec] Updated sitrec.sh"

        echo "[sitrec] Updating shared.env.example..."
        curl -sf "$REPO_URL/config/shared.env.example" -o shared.env.example.tmp
        if [ -s shared.env.example.tmp ]; then
            mv shared.env.example.tmp shared.env.example
            echo "[sitrec] Updated shared.env.example"
        else
            rm -f shared.env.example.tmp
            echo "[sitrec] WARNING: Could not update shared.env.example"
        fi

        echo "[sitrec] Done. Run ./sitrec.sh pull to also update the Sitrec image."
        ;;
    logs)
        $COMPOSE logs -f
        ;;
    status)
        $COMPOSE ps
        ;;
    help|--help|-h)
        echo "Usage: ./sitrec.sh [command]"
        echo ""
        echo "Commands:"
        echo "  start     Start (or restart) the container"
        echo "  stop      Stop the container"
        echo "  pull      Pull latest image and recreate"
        echo "  versions  List available versions and switch"
        echo "  update    Update this script from GitHub"
        echo "  logs      Follow container logs"
        echo "  status    Show container status"
        ;;
    *)
        echo "[sitrec] Unknown command: $1"
        echo "Run ./sitrec.sh help for usage."
        exit 1
        ;;
esac
