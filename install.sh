#!/bin/bash
# Sitrec one-liner installer (works with Docker or Podman)
# Usage: curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash
#   or:  curl -sL ... | bash -s -- --podman    (force Podman)
#   or:  curl -sL ... | bash -s -- --docker    (force Docker)
#   or:  curl -sL ... | bash -s -- --bake registry.example.com/sitrec:configured --env-file prod.env
#   or:  curl -sL ... | bash -s -- --bake sitrec-configured:latest --env-file prod.env --tarball sitrec-configured.tar
#   or:  ./install.sh --tarball                 (install from local .tar image)
#   or:  ./install.sh --tarball sitrec-image.tar  (specify tarball path)
#   or:  ./install.sh --offline                 (image already loaded, skip pull)
#
# Creates a sitrec/ directory with docker-compose.yml and .env template,
# then pulls and starts the container.
#
# Air-gapped / tarball install:
#   On a connected machine, export the image:
#     docker save ghcr.io/mickwest/sitrec2:latest -o sitrec-image.tar
#       (or: podman save ghcr.io/mickwest/sitrec2:latest -o sitrec-image.tar)
#   Copy install.sh and sitrec-image.tar to the air-gapped machine, then:
#     ./install.sh --tarball
#   If the image is already loaded (e.g. via docker load), use --offline instead.
#
# Options:
#   --podman      Force Podman (default: auto-detect)
#   --docker      Force Docker
#   --image <image>  Install/run a specific image (default: ghcr.io/mickwest/sitrec2:latest)
#   --tarball [path]  Load image from a .tar file (auto-detected if path omitted)
#   --offline     Air-gapped install (skip pull, image must already be loaded)
#   --videos      Mount sitrec-videos/ volume for legacy sitches (default)
#   --no-videos   Do not mount sitrec-videos/
#   --no-selinux  Skip :Z volume labels even on SELinux systems
#
# Bake mode:
#   --bake <image>       Build a pre-configured image from the published GHCR image and exit
#   --env-file <file>    Env file to bake in (default: .env)
#   --base <tag>         Base Sitrec image tag to build FROM (default: latest)
#   --push               Push the baked image after building
#   --tarball [path]     In bake mode, save the baked image to a tarball

set -e

DIR="sitrec"
IMAGE="ghcr.io/mickwest/sitrec2"
INSTALL_IMAGE="${IMAGE}:latest"
FORCE_RUNTIME=""
OFFLINE=false
USE_TARBALL=false
TARBALL_PATH=""
NO_SELINUX=false
MOUNT_VIDEOS=true
BAKE_MODE=false
BAKE_TARGET=""
BAKE_ENV_FILE=".env"
BAKE_BASE_TAG="latest"
BAKE_PUSH=false
BAKE_TARBALL=false
BAKE_TARBALL_PATH=""

while [ $# -gt 0 ]; do
    case "$1" in
        --podman)     FORCE_RUNTIME="podman" ;;
        --docker)     FORCE_RUNTIME="docker" ;;
        --offline)    OFFLINE=true ;;
        --image)
            if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
                echo "[sitrec] ERROR: --image requires an image name."
                exit 1
            fi
            INSTALL_IMAGE="$2"
            shift
            ;;
        --bake)
            BAKE_MODE=true
            if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then
                BAKE_TARGET="$2"
                shift
            fi
            ;;
        --env-file)
            if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
                echo "[sitrec] ERROR: --env-file requires a path."
                exit 1
            fi
            BAKE_ENV_FILE="$2"
            shift
            ;;
        --base)
            if [ -z "${2:-}" ] || [ "${2#--}" != "$2" ]; then
                echo "[sitrec] ERROR: --base requires a tag."
                exit 1
            fi
            BAKE_BASE_TAG="$2"
            shift
            ;;
        --push)       BAKE_PUSH=true ;;
        --tarball)
            if [ "$BAKE_MODE" = true ]; then
                BAKE_TARBALL=true
                # In bake mode, --tarball is an output path for the baked image.
                if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then
                    BAKE_TARBALL_PATH="$2"
                    shift
                fi
            else
                USE_TARBALL=true
                # If the next arg exists and doesn't start with --, treat it as the path
                if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then
                    TARBALL_PATH="$2"
                    shift
                fi
            fi
            ;;
        --bake-tarball|--save-tarball)
            BAKE_TARBALL=true
            if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then
                BAKE_TARBALL_PATH="$2"
                shift
            fi
            ;;
        --no-selinux) NO_SELINUX=true ;;
        --videos)     MOUNT_VIDEOS=true ;;
        --no-videos)  MOUNT_VIDEOS=false ;;
        *)
            if [ "$BAKE_MODE" = true ] && [ -z "$BAKE_TARGET" ]; then
                BAKE_TARGET="$1"
            fi
            ;;
    esac
    shift
done

# In bake mode, a plain --tarball means "save the baked image" regardless of
# where it appeared on the command line. If it was parsed before --bake (so it
# landed in the install-from-tar variables), reinterpret it here as a bake
# output path — otherwise bake mode exits before the install path and the
# tarball would be silently dropped.
if [ "$BAKE_MODE" = true ] && [ "$USE_TARBALL" = true ] && [ "$BAKE_TARBALL" = false ]; then
    BAKE_TARBALL=true
    BAKE_TARBALL_PATH="$TARBALL_PATH"
    USE_TARBALL=false
fi

# ---------------------------------------------------------------------------
# Detect container runtime: prefer docker, fall back to podman.
# Use --docker or --podman to override when both are installed.
# ---------------------------------------------------------------------------
install_podman() {
    echo ""
    echo "[sitrec] Neither Docker nor Podman found."

    # Non-interactive (piped from curl) — just print instructions and exit
    if [ ! -t 0 ]; then
        echo "[sitrec] Install Docker or Podman first, then re-run this script."
        echo ""
        echo "  Docker:  https://docs.docker.com/get-docker/"
        echo "  Podman:  https://podman.io/getting-started/installation"
        exit 1
    fi

    # Detect OS and package manager
    PKG_MGR=""
    if command -v apt-get &>/dev/null; then
        PKG_MGR="apt"
    elif command -v dnf &>/dev/null; then
        PKG_MGR="dnf"
    elif command -v yum &>/dev/null; then
        PKG_MGR="yum"
    elif command -v brew &>/dev/null; then
        PKG_MGR="brew"
    elif command -v pacman &>/dev/null; then
        PKG_MGR="pacman"
    fi

    if [ -z "$PKG_MGR" ]; then
        echo "[sitrec] Could not detect a supported package manager."
        echo "[sitrec] Please install Docker or Podman manually:"
        echo ""
        echo "  Docker:  https://docs.docker.com/get-docker/"
        echo "  Podman:  https://podman.io/getting-started/installation"
        exit 1
    fi

    printf "[sitrec] Install podman + podman-compose using %s? [y/N] " "$PKG_MGR"
    read -r answer
    if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
        echo "[sitrec] Aborted. Install Docker or Podman manually, then re-run."
        exit 1
    fi

    # Check if we can write to system dirs (or use sudo)
    SUDO=""
    if [ "$PKG_MGR" != "brew" ]; then
        if [ "$(id -u)" -ne 0 ]; then
            if command -v sudo &>/dev/null; then
                SUDO="sudo"
                echo "[sitrec] Will use sudo for installation."
            else
                echo "[sitrec] Root privileges required but sudo not available."
                echo "[sitrec] Run as root or install manually:"
                case "$PKG_MGR" in
                    apt)    echo "  apt-get install -y podman podman-compose" ;;
                    dnf)    echo "  dnf install -y podman podman-compose" ;;
                    yum)    echo "  yum install -y podman podman-compose" ;;
                    pacman) echo "  pacman -S --noconfirm podman podman-compose" ;;
                esac
                exit 1
            fi
        fi
    fi

    echo "[sitrec] Installing podman..."
    case "$PKG_MGR" in
        apt)
            $SUDO apt-get update -qq
            $SUDO apt-get install -y podman
            ;;
        dnf)
            $SUDO dnf install -y podman
            ;;
        yum)
            $SUDO yum install -y podman
            ;;
        brew)
            brew install podman
            ;;
        pacman)
            $SUDO pacman -S --noconfirm podman
            ;;
    esac

    if ! command -v podman &>/dev/null; then
        echo "[sitrec] ERROR: podman installation failed."
        exit 1
    fi

    echo "[sitrec] Installing podman-compose..."
    case "$PKG_MGR" in
        apt)    $SUDO apt-get install -y podman-compose 2>/dev/null ;;
        dnf)    $SUDO dnf install -y podman-compose 2>/dev/null ;;
        yum)    $SUDO yum install -y podman-compose 2>/dev/null ;;
        brew)   brew install podman-compose 2>/dev/null ;;
        pacman) $SUDO pacman -S --noconfirm podman-compose 2>/dev/null ;;
    esac

    # Fallback: install via pip if package manager didn't have it
    if ! command -v podman-compose &>/dev/null; then
        if command -v pip3 &>/dev/null; then
            echo "[sitrec] Package not available, trying pip3..."
            pip3 install --user podman-compose 2>/dev/null
        elif command -v pip &>/dev/null; then
            echo "[sitrec] Package not available, trying pip..."
            pip install --user podman-compose 2>/dev/null
        fi
    fi

    if ! command -v podman-compose &>/dev/null; then
        # podman might still have the compose subcommand
        if podman compose --help &>/dev/null 2>&1; then
            echo "[sitrec] podman-compose not available, but 'podman compose' works."
        else
            echo "[sitrec] WARNING: podman-compose could not be installed."
            echo "[sitrec] Try: pip3 install podman-compose"
            exit 1
        fi
    fi

    echo "[sitrec] Installation complete."
}

detect_runtime() {
    if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
        COMPOSE="docker compose"
        RUNTIME="docker"
    elif command -v podman-compose &>/dev/null; then
        COMPOSE="podman-compose"
        RUNTIME="podman"
    elif command -v podman &>/dev/null && podman compose --help &>/dev/null 2>&1; then
        COMPOSE="podman compose"
        RUNTIME="podman"
    else
        install_podman
        # Re-detect after install
        if command -v podman-compose &>/dev/null; then
            COMPOSE="podman-compose"
            RUNTIME="podman"
        elif command -v podman &>/dev/null && podman compose --help &>/dev/null 2>&1; then
            COMPOSE="podman compose"
            RUNTIME="podman"
        else
            echo "[sitrec] ERROR: Installation succeeded but runtime not detected."
            exit 1
        fi
    fi
}

bake_image() {
    if [ -z "$BAKE_TARGET" ]; then
        echo "[sitrec] ERROR: --bake requires a target image name."
        echo ""
        echo "  Usage:"
        echo "    ./install.sh --bake <target-image> [--env-file <file>] [--base <tag>] [--push] [--tarball [file]]"
        echo ""
        echo "  Examples:"
        echo "    curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --bake registry.example.com/sitrec:configured --env-file prod.env"
        echo "    curl -sL https://raw.githubusercontent.com/MickWest/Sitrec2/main/install.sh | bash -s -- --bake sitrec-configured:latest --env-file prod.env --tarball sitrec-configured.tar"
        exit 1
    fi

    if [ ! -f "$BAKE_ENV_FILE" ]; then
        echo "[sitrec] ERROR: env file '$BAKE_ENV_FILE' not found."
        exit 1
    fi

    BASE_IMAGE="${IMAGE}:${BAKE_BASE_TAG}"

    echo "[sitrec] Baking '$BAKE_ENV_FILE' into $BASE_IMAGE  ->  $BAKE_TARGET"
    echo "[sitrec] WARNING: every value in '$BAKE_ENV_FILE' is embedded in the image as"
    echo "          build-time ENV layers. Anyone who can pull '$BAKE_TARGET' (or read its"
    echo "          'docker history' / 'inspect') can recover these values, including"
    echo "          secrets such as API keys and S3 credentials. Only push baked"
    echo "          images to a PRIVATE registry you trust."
    echo ""

    # Explicit TMPDIR-honoring template: bare `mktemp -d` ignores $TMPDIR on
    # macOS/BSD (always the Darwin per-user temp), which some sandboxed
    # environments deny. Falls back to /tmp when TMPDIR is unset (Linux/CI).
    BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sitrec-build.XXXXXX")"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    DF="$BUILD_DIR/Dockerfile"

    {
        echo "# Auto-generated by install.sh --bake - do not edit."
        echo "# Bakes '$BAKE_ENV_FILE' into $BASE_IMAGE so the image is self-configured."
        echo "FROM ${BASE_IMAGE}"
    } > "$DF"

    # Parse the env file into ENV lines, mirroring docker/entrypoint.sh and
    # ./sitrec.sh bake: skip blanks/comments/empty values, allow optional
    # 'export ', split on the first '=', and strip one surrounding quote layer.
    #
    # CR is a literal carriage return. A trailing CR is stripped from every line
    # so Windows (CRLF) env files parse correctly: otherwise the CR sits AFTER
    # the closing quote, defeats the quote-strip below (its closing-quote glob is
    # end-anchored), and the literal quotes + CR get baked into the ENV value
    # (e.g. a map name shows up as 'OpenStreetMap"' and DOCKER_MAP_TYPE /
    # SITREC_ENABLE_DEFAULT_*_SOURCES are silently ignored). $(printf '\r') is
    # portable to every shell, unlike $'\r' which silently no-ops under dash/ash.
    CR=$(printf '\r')
    crlf_seen=0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in *"$CR") crlf_seen=1; line="${line%"$CR"}" ;; esac
        while case "$line" in " "*|$'\t'*) true ;; *) false ;; esac; do
            line="${line#?}"
        done
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        line="${line#export }"
        case "$line" in *=*) ;; *) continue ;; esac
        key="${line%%=*}"
        val="${line#*=}"
        case "$val" in
            \"*\") val="${val#\"}"; val="${val%\"}" ;;
            \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        [ -z "$val" ] && continue
        esc="${val//\\/\\\\}"
        esc="${esc//\"/\\\"}"
        esc="${esc//\$/\\\$}"
        printf 'ENV %s="%s"\n' "$key" "$esc" >> "$DF"
    done < "$BAKE_ENV_FILE"
    [ "$crlf_seen" = 1 ] && echo "[sitrec] note: '$BAKE_ENV_FILE' has Windows (CRLF) line endings — stripped them while baking."

    BAKED_COUNT=$(grep -c '^ENV ' "$DF" || true)
    if [ "$BAKED_COUNT" -eq 0 ]; then
        echo "[sitrec] ERROR: no usable KEY=value lines found in '$BAKE_ENV_FILE'."
        exit 1
    fi
    echo "[sitrec] Generated Dockerfile with $BAKED_COUNT baked env var(s)."

    # Test/preview hook: print the generated Dockerfile and stop before building,
    # so the env-file parser can be exercised without a container runtime.
    if [ -n "${SITREC_BAKE_DRY_RUN:-}" ]; then
        cat "$DF"
        exit 0
    fi

    $RUNTIME build --pull -f "$DF" -t "$BAKE_TARGET" "$BUILD_DIR"
    echo "[sitrec] Built $BAKE_TARGET"

    if [ "$BAKE_TARBALL" = true ]; then
        if [ -z "$BAKE_TARBALL_PATH" ]; then
            safe_name=$(printf '%s' "$BAKE_TARGET" | sed 's|[^A-Za-z0-9_.-]|_|g')
            BAKE_TARBALL_PATH="${safe_name}.tar"
        fi
        echo "[sitrec] Saving $BAKE_TARGET to $BAKE_TARBALL_PATH ..."
        $RUNTIME save -o "$BAKE_TARBALL_PATH" "$BAKE_TARGET"
        echo "[sitrec] Saved $BAKE_TARBALL_PATH"
    fi

    if [ "$BAKE_PUSH" = true ]; then
        echo "[sitrec] Pushing $BAKE_TARGET ..."
        $RUNTIME push "$BAKE_TARGET"
        echo "[sitrec] Pushed $BAKE_TARGET"
    else
        echo "[sitrec] Not pushed (no --push). To push it yourself:"
        echo "           $RUNTIME push $BAKE_TARGET"
    fi
}

if [ "$BAKE_MODE" = true ] && [ -n "${SITREC_BAKE_DRY_RUN:-}" ]; then
    # Bake dry-run (test/preview): emit the generated Dockerfile and stop, with
    # no container runtime needed. Skip detection — detect_runtime would try to
    # INSTALL podman if none is found, which must never happen under test.
    RUNTIME="dry-run"
    COMPOSE="dry-run"
elif [ "$FORCE_RUNTIME" = "podman" ]; then
    if command -v podman-compose &>/dev/null; then
        COMPOSE="podman-compose"
    elif command -v podman &>/dev/null && podman compose --help &>/dev/null 2>&1; then
        COMPOSE="podman compose"
    elif command -v podman &>/dev/null; then
        COMPOSE="podman compose"
    else
        echo "[sitrec] ERROR: --podman specified but podman not found."
        exit 1
    fi
    RUNTIME="podman"
elif [ "$FORCE_RUNTIME" = "docker" ]; then
    if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
        COMPOSE="docker compose"
    else
        echo "[sitrec] ERROR: --docker specified but docker compose not available."
        exit 1
    fi
    RUNTIME="docker"
else
    detect_runtime
fi

echo "[sitrec] Using $RUNTIME ($COMPOSE)"

if [ "$BAKE_MODE" = true ]; then
    bake_image
    exit 0
fi

# ---------------------------------------------------------------------------
# Create install directory
# ---------------------------------------------------------------------------
if [ -d "$DIR" ]; then
    echo "[sitrec] Directory '$DIR' already exists. To reinstall, remove it first."
    exit 1
fi

echo "[sitrec] Creating $DIR/"
mkdir "$DIR"

# If a .env file exists in the current directory (pre-configured),
# copy it into the install directory instead of generating a template.
HAVE_EXISTING_ENV=false
if [ -f ".env" ]; then
    cp ".env" "$DIR/.env"
    HAVE_EXISTING_ENV=true
    echo "[sitrec] Copied existing .env into $DIR/"
fi

cd "$DIR"

# ---------------------------------------------------------------------------
# Write docker-compose.yml
# Uses simple string-form env_file (compatible with both Docker and Podman).
# Mount the local video folder by default. It can stay empty, and this keeps the
# later download-videos step from silently writing files the container cannot see.
# ---------------------------------------------------------------------------
VOLUMES_BLOCK=""
if [ "$MOUNT_VIDEOS" = true ]; then
    mkdir -p sitrec-videos

    VOL_SUFFIX=""
    if [ "$NO_SELINUX" = false ] \
        && command -v getenforce &>/dev/null \
        && [ "$(getenforce 2>/dev/null)" = "Enforcing" ] \
        && [ -d /sys/fs/selinux ]; then
        VOL_SUFFIX=":Z"
        echo "[sitrec] SELinux enforcing — using :Z volume labels"
        echo "[sitrec] (use --no-selinux to disable if this causes problems)"
    fi

    VOLUMES_BLOCK="    volumes:
      - ./sitrec-videos:/var/www/html/sitrec-videos${VOL_SUFFIX}"
fi

cat > docker-compose.yml <<COMPOSE
services:
  sitrec:
    image: ${INSTALL_IMAGE}
    ports:
      - '8080:8080'
    env_file:
      - .env
${VOLUMES_BLOCK}
COMPOSE

# ---------------------------------------------------------------------------
# Write .env template (only if no pre-existing .env was copied)
# ---------------------------------------------------------------------------
if [ "$HAVE_EXISTING_ENV" = false ]; then
cat > .env <<'ENV'
# Sitrec configuration — uncomment and edit as needed.
# After changes, run: ./sitrec.sh restart

# === Banners (optional) ===
#BANNER_ACTIVE=true
#BANNER_TOP_TEXT=Welcome to Sitrec
#BANNER_BOTTOM_TEXT=
#BANNER_COLOR="#FFFFFF"
#BANNER_BACKGROUND_COLOR="#377e22"
#BANNER_HEIGHT=20

# === Maps (optional — enables higher quality imagery) ===
#MAPBOX_TOKEN=pk.your_token_here
#MAPTILER_KEY=your_key_here

# === 3D Buildings (optional) ===
#CESIUM_ION_TOKEN=your_token_here
#GOOGLE_MAPS_API_KEY=your_key_here

# === AI Chat (optional) ===
#CHATBOT_ENABLED=true
#OPENAI_API=sk-your_key_here

# === Cloud Storage (optional — enables server-side saves) ===
#SAVE_TO_S3=true
#S3_ACCESS_KEY_ID=your_key_here
#S3_SECRET_ACCESS_KEY=your_secret_here
#S3_BUCKET=your-bucket
#S3_REGION=us-west-2
ENV
fi

# ---------------------------------------------------------------------------
# Save the detected runtime so sitrec.sh knows which compose command to use
# ---------------------------------------------------------------------------
echo "$COMPOSE" > .runtime

# ---------------------------------------------------------------------------
# Detect local tarball — prompt interactively or honour --tarball flag
# ---------------------------------------------------------------------------
TARBALL=""
if [ -n "$TARBALL_PATH" ]; then
    # Explicit path given — resolve relative to original dir (parent of $DIR)
    if [ "${TARBALL_PATH#/}" = "$TARBALL_PATH" ]; then
        TARBALL="../$TARBALL_PATH"
    else
        TARBALL="$TARBALL_PATH"
    fi
elif [ "$USE_TARBALL" = true ] || [ "$OFFLINE" = false ]; then
    # Auto-detect: look for .tar files in the parent dir (we've already cd'd into $DIR)
    for f in ../*.tar; do
        [ -f "$f" ] || continue
        TARBALL="$f"
        break
    done
fi

if [ "$USE_TARBALL" = true ]; then
    if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
        echo "[sitrec] ERROR: --tarball specified but no .tar file found."
        [ -n "$TARBALL_PATH" ] && echo "[sitrec]   path: $TARBALL_PATH"
        exit 1
    fi
    echo "[sitrec] Loading image from $TARBALL..."
    $RUNTIME load -i "$TARBALL"
    OFFLINE=true
elif [ "$OFFLINE" = false ] && [ -n "$TARBALL" ] && [ -t 0 ]; then
    # Interactive terminal and tarball found — ask the user
    echo "[sitrec] Found local image tarball: $TARBALL"
    printf "[sitrec] Load image from this file instead of pulling? [y/N] "
    read -r answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        echo "[sitrec] Loading image from $TARBALL..."
        $RUNTIME load -i "$TARBALL"
        OFFLINE=true
    fi
fi

if [ "$OFFLINE" = true ]; then
    echo "[sitrec] Offline mode — skipping image pull"
else
    echo "[sitrec] Pulling image..."
    $COMPOSE pull
fi

# Extract support files from the image
echo "[sitrec] Extracting support files from image..."
_cid=$($RUNTIME create "$INSTALL_IMAGE" --entrypoint /bin/true 2>/dev/null) || \
_cid=$($RUNTIME create "$INSTALL_IMAGE" 2>/dev/null)
$RUNTIME cp "$_cid":/usr/local/share/sitrec/sitrec.sh sitrec.sh
$RUNTIME cp "$_cid":/usr/local/share/sitrec/shared.env.example shared.env.example
$RUNTIME rm "$_cid" >/dev/null 2>&1 || true
chmod +x sitrec.sh 2>/dev/null || true

echo ""
echo "============================================"
echo "  Sitrec installed in ./$DIR/"
echo "  "
echo "  Start:     ./sitrec.sh start"
echo "  Stop:      ./sitrec.sh stop"
echo "  Restart:   ./sitrec.sh restart  (after .env changes)"
echo "  Update:    ./sitrec.sh pull"
echo "  Open:      http://localhost:8080"
echo "  Config:    edit .env"
echo "============================================"
echo ""
# Clean up any stale containers from a previous install (e.g. if the user
# deleted the sitrec/ directory without running "down" first)
$COMPOSE down 2>/dev/null || true

echo "[sitrec] Starting..."
$COMPOSE up
