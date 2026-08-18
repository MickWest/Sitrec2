#!/bin/bash
# Launcher for SitrecBridge MCP server.
# Finds node even when launched outside a login shell (for example, from a
# desktop MCP client). Distribution builds contain mcp-server.mjs; the source
# tree contains mcp-server.js.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/mcp-server.mjs" ]; then
    SERVER_PATH="$SCRIPT_DIR/mcp-server.mjs"
elif [ -f "$SCRIPT_DIR/mcp-server.js" ]; then
    SERVER_PATH="$SCRIPT_DIR/mcp-server.js"
else
    echo "Error: SitrecBridge server not found beside run.sh." >&2
    exit 1
fi

# If node is already on PATH, use it.
if command -v node &>/dev/null; then
    exec node "$SERVER_PATH" "$@"
fi

# Try nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    exec node "$SERVER_PATH" "$@"
fi

# Try fnm
if [ -d "$HOME/.local/share/fnm" ]; then
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)" 2>/dev/null
    if command -v node &>/dev/null; then
        exec node "$SERVER_PATH" "$@"
    fi
fi

# Try volta
if [ -d "$HOME/.volta" ]; then
    export VOLTA_HOME="$HOME/.volta"
    export PATH="$VOLTA_HOME/bin:$PATH"
    if command -v node &>/dev/null; then
        exec node "$SERVER_PATH" "$@"
    fi
fi

# Try Homebrew (macOS)
for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$p" ]; then
        exec "$p" "$SERVER_PATH" "$@"
    fi
done

echo "Error: node not found. Install Node.js 18+ from https://nodejs.org/" >&2
exit 1
