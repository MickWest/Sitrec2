#!/bin/bash
# Sitrec Docker entrypoint
# Converts Docker environment variables into runtime configuration for both
# PHP (shared.env.php) and JavaScript (window.__SITREC_ENV__ in index.html).

set -e

# Paths are overridable so the entrypoint can be exercised end-to-end by
# automated tests (tests/dockerEntrypointEnv.test.js) without a real
# /var/www/html. Defaults are unchanged for the real container.
HTML_FILE="${SITREC_HTML_FILE:-/var/www/html/index.html}"
ENV_PHP_FILE="${SITREC_ENV_PHP_FILE:-/var/www/html/shared.env.php}"

# Literal carriage return. Used to strip a trailing CR from values that arrive
# from a Windows (CRLF) env file via docker-compose `env_file:` / `docker run
# --env-file` (these bypass the install.sh/sitrec.sh bake parser and feed the
# raw value straight into the container env). Without stripping it first, the CR
# sits after the closing quote and defeats the end-anchored quote-strip below,
# leaving a stray quote + CR that silently breaks downstream exact-string checks
# (getEnvBool, map-type lookups) and can corrupt the injected JS string literal.
# $(printf '\r') is portable to every shell.
CR=$(printf '\r')

# ---------------------------------------------------------------------------
# CLIENT_VARS: safe to expose in the browser (injected into both PHP and JS).
# These are the same variables that dotenv-webpack already bakes into the
# JS bundle at build time, so exposing them at runtime is not a new risk.
# ---------------------------------------------------------------------------
CLIENT_VARS="
NO_TERRAIN
LOCAL_DOCS
LOCALHOST
BANNER_ACTIVE
BANNER_TOP_TEXT
BANNER_BOTTOM_TEXT
BANNER_COLOR
BANNER_BACKGROUND_COLOR
BANNER_HEIGHT
BANNER_TEXT_HEIGHT
BANNER_FONT
VERSION
DEFAULT_MAP_TYPE
DOCKER_MAP_TYPE
DEFAULT_ELEVATION_TYPE
DOCKER_ELEVATION_TYPE
SITREC_ENABLE_DEFAULT_MAP_SOURCES
SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES
SAVE_TO_SERVER
SAVE_TO_S3
USE_S3_PRESIGNED_URLS
S3_MULTIPART_THRESHOLD_MB
S3_CHUNK_SIZE_MB
S3_PARALLEL_UPLOADS
S3_BUCKET
S3_REGION
SAVE_TO_LOCAL
MAX_FILE_SIZE_MB
ADMIN_MAX_FILE_SIZE_MB
CHATBOT_ENABLED
CHATBOT_PROVIDER
DEFAULT_PLATFORM_MODEL
SETTINGS_COOKIES_ENABLED
SETTINGS_SERVER_ENABLED
SETTINGS_DB_ENABLED
SITREC_USE_CUSTOM_TLE
SITREC_CUSTOM_TLE_MENU_NAME
SITREC_CUSTOM_TLE_TOOLTIP
SITREC_ENABLE_DEFAULT_TLE_SOURCES
CURRENT_STARLINK
CURRENT_ACTIVE
SITREC_TRACK_STATS
MAPBOX_TOKEN
MAPTILER_KEY
"
# CESIUM_ION_TOKEN and GOOGLE_MAPS_API_KEY are deliberately NOT client vars. They
# reach the browser only through rehost.php?getuser, which gates them on group
# membership and remaining daily quota. Injecting them into window.__SITREC_ENV__
# would publish them in the page source to every visitor and defeat that gate.
# Mapbox and MapTiler stay: the browser fetches those tiles directly, so their
# credentials are unavoidably public.

# Dynamically add any SITREC_CUSTOM_MAP_* and SITREC_CUSTOM_ELEVATION_* env vars
# so custom map/elevation sources with arbitrary names are forwarded to the browser.
for var in $(env | grep -oE '^SITREC_CUSTOM_(MAP|ELEVATION)_[^=]+'); do
    CLIENT_VARS="$CLIENT_VARS
$var"
done

# ---------------------------------------------------------------------------
# SERVER_VARS: secrets and server-only config. Written to shared.env.php
# for PHP but NEVER injected into index.html.
# ---------------------------------------------------------------------------
#
# CESIUM_ION_TOKEN and GOOGLE_MAPS_API_KEY are here, not in CLIENT_VARS: they reach
# the browser only via rehost.php?getuser, which gates them on group and remaining
# quota. PHP still needs them, index.html must not have them.
#
# NB: no comments inside the list itself - the writer loop does
# `for var in $CLIENT_VARS $SERVER_VARS`, which word-splits, so a comment would be
# treated as variable names.
SERVER_VARS="
CESIUM_ION_TOKEN
GOOGLE_MAPS_API_KEY
GOOGLE_MAPS_SERVER_API_KEY
XENFORO_PATH
SITREC_DEFAULT_USERID
SITREC_DEFAULT_USER_GROUPS
SITREC_FORUM_ORIGIN
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_ACL
S3_DEFAULT_VISIBILITY
S3_PRIVATE_PREFIXES
S3_PUBLIC_PREFIXES
S3_PUBLIC_BASE_URL
S3_PUBLIC_OBJECT_ACL
S3_PRIVATE_OBJECT_ACL
S3_PRESIGNED_GET_EXPIRY_SECONDS
S3_PRESIGNED_PUT_EXPIRY_SECONDS
S3_PRESIGNED_MULTIPART_EXPIRY_SECONDS
CUSTOM_TLE
CACHE_CUSTOM_TLE
TLE_ZIP_ENABLED
SITREC_DISABLE_SSL_VERIFY
SPACEDATA_USERNAME
SPACEDATA_PASSWORD
OPENAI_API
ANTHROPIC_API
GROQ_API
GROK_API
"

# ---------------------------------------------------------------------------
# 1. Generate shared.env.php from ALL environment variables (client + server)
#    PHP's injectEnv.php reads this file via putenv().
#    We wrap it in a PHP comment so it can't be served as plain text.
#
#    rm -f first, then write a fresh file: the copy shipped in the image is owned
#    by root, and a non-root UID (rootless Podman --user, OpenShift's arbitrary
#    assigned UIDs, etc.) cannot modify it in place — rootless overlay copy-up of
#    a file you don't own is denied even at mode 666. Deleting it and creating a
#    new file in the world-writable webroot works for both root and non-root UIDs.
# ---------------------------------------------------------------------------
rm -f "$ENV_PHP_FILE"
echo "<?php /*;" > "$ENV_PHP_FILE"

for var in $CLIENT_VARS $SERVER_VARS; do
    val="${!var}"
    # Strip a trailing CR (CRLF env files) BEFORE the quote-strip, so the closing
    # quote is once again the last character and the strip below actually matches.
    val="${val%"$CR"}"
    # Strip surrounding quotes (some compose tools pass them literally)
    val="${val#\"}" ; val="${val%\"}"
    val="${val#\'}" ; val="${val%\'}"
    if [ -n "$val" ]; then
        echo "${var}=${val}" >> "$ENV_PHP_FILE"
    fi
done

echo "*/" >> "$ENV_PHP_FILE"

echo "[entrypoint] Wrote $ENV_PHP_FILE"

# ---------------------------------------------------------------------------
# 2. Inject window.__SITREC_ENV__ into index.html
#    Only CLIENT_VARS are injected — server secrets stay out of the browser.
# ---------------------------------------------------------------------------
if [ -f "$HTML_FILE" ]; then
    # Build a JSON object from set client env vars only
    JSON="{"
    FIRST=true
    for var in $CLIENT_VARS; do
        val="${!var}"
        # Strip a trailing CR (CRLF env files) BEFORE the quote-strip (see above).
        val="${val%"$CR"}"
        # Strip surrounding quotes (some compose tools pass them literally)
        val="${val#\"}" ; val="${val%\"}"
        val="${val#\'}" ; val="${val%\'}"
        if [ -n "$val" ]; then
            # Escape double quotes and backslashes in the value
            escaped=$(echo "$val" | sed 's/\\/\\\\/g; s/"/\\"/g')
            if [ "$FIRST" = true ]; then
                FIRST=false
            else
                JSON+=","
            fi
            JSON+="\"${var}\":\"${escaped}\""
        fi
    done
    JSON+="}"

    # Inject a <script> tag right after the opening <head> in index.html.
    SCRIPT_TAG="<script>window.__SITREC_ENV__=${JSON};</script>"

    # Split on the FIRST <head> and re-assemble with the script tag inserted,
    # using pure shell parameter expansion rather than sed. A value can legally
    # contain &, \, and | — e.g. a custom map URL like ...?token=a&style=b — all
    # of which are special on sed's REPLACEMENT side (& expands to the whole
    # match, so the URL would get "<head>" spliced into it). Parameter expansion
    # treats the value as a literal, so it is injection-safe.
    #
    # Delete-and-recreate (not `sed -i`, not in-place truncate): the image's
    # index.html is root-owned, so a non-root UID can't rewrite it in place
    # (overlay copy-up denied) but CAN remove it and write a fresh file in the
    # world-writable webroot. Works for both root and non-root UIDs.
    HTML_CONTENT=$(cat "$HTML_FILE")
    case "$HTML_CONTENT" in
        *"<head>"*)
            HTML_HEAD="${HTML_CONTENT%%<head>*}"   # everything before the first <head>
            HTML_TAIL="${HTML_CONTENT#*<head>}"    # everything after the first <head>
            NEW_HTML="${HTML_HEAD}<head>${SCRIPT_TAG}${HTML_TAIL}"
            rm -f "$HTML_FILE"
            printf '%s\n' "$NEW_HTML" > "$HTML_FILE"
            echo "[entrypoint] Injected runtime env into $HTML_FILE"
            ;;
        *)
            echo "[entrypoint] WARNING: no <head> tag in $HTML_FILE, skipping JS env injection" >&2
            ;;
    esac
else
    echo "[entrypoint] WARNING: $HTML_FILE not found, skipping JS env injection"
fi

# ---------------------------------------------------------------------------
# 3. Decide which port Apache listens on (inside the container).
#
#    The base php:apache image hard-codes Apache to port 80, which is a
#    PRIVILEGED port: only UID 0 (root) can bind it. When the container is run
#    as a non-root UID (rootless Podman with --user, OpenShift's arbitrary
#    assigned UIDs, etc.) Apache cannot bind 80 and dies with
#    "Could not bind to address ... No listening sockets available".
#
#    So this image listens on 8080 by default (unprivileged -> works as ANY
#    UID). The Dockerfile rewrote ports.conf / the vhost to "Listen
#    ${SITREC_LISTEN_PORT}", and we export that variable here so Apache's
#    config expansion picks it up.
#
#    The container port almost never needs to change — the host side of the
#    port mapping is the knob users actually turn — so this is NOT controlled by
#    SITREC_PORT (which is the dev-server's host port, default 3000, and must
#    keep that meaning). The rare override is SITREC_DOCKER_INTERNAL_PORT.
# ---------------------------------------------------------------------------
SITREC_LISTEN_PORT="${SITREC_DOCKER_INTERNAL_PORT:-8080}"
SITREC_LISTEN_PORT="${SITREC_LISTEN_PORT%"$CR"}"   # tolerate a trailing CR (CRLF env file)

# Validate: must be a bare integer, else fall back to the safe default.
case "$SITREC_LISTEN_PORT" in
    ''|*[!0-9]*)
        echo "[entrypoint] WARNING: SITREC_DOCKER_INTERNAL_PORT='${SITREC_DOCKER_INTERNAL_PORT}' is not a number; using 8080" >&2
        SITREC_LISTEN_PORT=8080
        ;;
esac

CONTAINER_UID="$(id -u)"

# Preflight: a non-root UID physically cannot bind a privileged (<1024) port.
# Fail loudly and early with an actionable message instead of letting Apache
# emit its cryptic "No listening sockets available, shutting down".
if [ "$CONTAINER_UID" != "0" ] && [ "$SITREC_LISTEN_PORT" -lt 1024 ]; then
    echo "============================================================" >&2
    echo "[sitrec] FATAL: cannot listen on port ${SITREC_LISTEN_PORT} as a non-root user (UID ${CONTAINER_UID})." >&2
    echo "[sitrec] Ports below 1024 are privileged and require root inside the container." >&2
    echo "[sitrec] Fix: leave the container port at its 8080 default (or set SITREC_DOCKER_INTERNAL_PORT >= 1024)," >&2
    echo "[sitrec]      or run the container as root (drop --user / rootful mode)." >&2
    echo "============================================================" >&2
    exit 1
fi

export SITREC_LISTEN_PORT

# Back-compat for existing installs: a non-root UID can't bind 80, but ROOT
# can. Older docker-compose.yml files map the host to the container's port 80
# (the pre-8080 default). When we're root and not already on 80, ALSO listen on
# 80 so those old "8080:80" mappings keep working without edits. (Adding
# "Listen 80" unconditionally would make Apache abort for non-root UIDs, which
# is exactly the failure we're avoiding — so this is gated on being root.)
COMPAT_CONF="/etc/apache2/conf-enabled/zz-sitrec-port80-compat.conf"
if [ "$CONTAINER_UID" = "0" ] && [ "$SITREC_LISTEN_PORT" != "80" ]; then
    cat > "$COMPAT_CONF" <<'EOF'
# Auto-added by sitrec-entrypoint.sh (root only): keep legacy port-80 host
# mappings working now that the canonical container port is 8080.
Listen 80
<VirtualHost *:80>
    DocumentRoot /var/www/html
</VirtualHost>
EOF
    COMPAT_NOTE=" (+ legacy port 80, root)"
else
    # Ensure a stale compat file from a previous root run doesn't linger if we
    # later start non-root (where binding 80 would abort Apache).
    rm -f "$COMPAT_CONF" 2>/dev/null || true
    COMPAT_NOTE=""
fi

# Loud, unmissable banner. The container cannot see the host-side port mapping,
# but it knows its own UID and listen port — so if the browser can't connect,
# `docker logs` / `podman logs` shows the likely cause in plain English.
echo "============================================================"
echo "[sitrec] Apache listening on container port: ${SITREC_LISTEN_PORT}${COMPAT_NOTE}  (UID ${CONTAINER_UID})"
if [ "$CONTAINER_UID" != "0" ]; then
    echo "[sitrec] Running NON-ROOT: your port mapping MUST target ${SITREC_LISTEN_PORT}, e.g.  -p 8080:${SITREC_LISTEN_PORT}"
    echo "[sitrec] If the browser can't connect, a mapping to :80 is the cause"
    echo "[sitrec]   (this image moved off privileged port 80 so it can run non-root)."
fi
echo "============================================================"

# ---------------------------------------------------------------------------
# 4. Hand off to the default Apache entrypoint
# ---------------------------------------------------------------------------
# Test hook: let automated tests run the env-injection logic above without
# execing Apache (which isn't present outside the container).
if [ -n "${SITREC_ENTRYPOINT_NO_EXEC:-}" ]; then
    exit 0
fi
exec docker-php-entrypoint "$@"
