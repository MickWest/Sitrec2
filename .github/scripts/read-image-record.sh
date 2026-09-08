#!/usr/bin/env bash
# Emit immutable image references for GITHUB_ENV from this run's build artifact.
set -euo pipefail
ARCH="$1"
RECORD="$2"
case "$ARCH" in amd64|arm64) ;; *) exit 1 ;; esac

# The attempt may be older when only failed jobs are rerun. Run and commit must
# still match, and a future attempt must never be consumed by an older job.
jq -e -s --arg arch "$ARCH" --arg commit "$GITHUB_SHA" \
  --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" '
    def digest: type == "string" and length == 71 and test("^sha256:[0-9a-f]{64}$");
    length == 1 and (.[0] |
      .arch == $arch and .commit == $commit and .run == $run and
      (.attempt | type == "string" and test("^[1-9][0-9]*$")) and
      ((.attempt | tonumber) <= ($attempt | tonumber)) and
      (.index | digest) and (.platform | digest))
  ' "$RECORD" > /dev/null
SUFFIX=$(printf '%s' "$ARCH" | tr '[:lower:]' '[:upper:]')
printf 'SOURCE_%s=%s/%s@%s\n' "$SUFFIX" "$REGISTRY" "$IMAGE_NAME_LC" "$(jq -r .index "$RECORD")"
printf 'PLATFORM_%s=%s/%s@%s\n' "$SUFFIX" "$REGISTRY" "$IMAGE_NAME_LC" "$(jq -r .platform "$RECORD")"
