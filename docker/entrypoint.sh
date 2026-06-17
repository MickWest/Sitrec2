#!/bin/bash
# Sitrec Docker entrypoint
# Converts Docker environment variables into runtime configuration for both
# PHP (shared.env.php) and JavaScript (window.__SITREC_ENV__ in index.html).

set -e

HTML_FILE="/var/www/html/index.html"
ENV_PHP_FILE="/var/www/html/shared.env.php"

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
CESIUM_ION_TOKEN
GOOGLE_MAPS_API_KEY
"

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
SERVER_VARS="
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

    # Inject a <script> tag right after <head> in index.html
    SCRIPT_TAG="<script>window.__SITREC_ENV__=${JSON};<\/script>"

    # Insert after the opening <head> tag (the built index.html has <head> on a
    # single line). Read, then delete-and-recreate (not `sed -i`, and not an
    # in-place truncate): the image's index.html is root-owned, so a non-root UID
    # can neither rewrite it in place (overlay copy-up denied) nor let sed -i
    # rename a temp over it — but it CAN remove it and write a fresh file in the
    # world-writable webroot. Works for both root and non-root UIDs.
    NEW_HTML=$(sed "s|<head>|<head>${SCRIPT_TAG}|" "$HTML_FILE")
    rm -f "$HTML_FILE"
    printf '%s\n' "$NEW_HTML" > "$HTML_FILE"

    echo "[entrypoint] Injected runtime env into $HTML_FILE"
else
    echo "[entrypoint] WARNING: $HTML_FILE not found, skipping JS env injection"
fi

# ---------------------------------------------------------------------------
# 3. Hand off to the default Apache entrypoint
# ---------------------------------------------------------------------------
exec docker-php-entrypoint "$@"
