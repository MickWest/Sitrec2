# SitrecBridge

An MCP (Model Context Protocol) server that bridges AI assistants to a running
Sitrec instance via a Chrome extension.

## Architecture

```
Claude Code / Claude Desktop
    │  (MCP protocol, stdio)
    ▼
mcp-server  (Node.js)
    │  (WebSocket, ws://localhost:9780)
    ▼
Chrome Extension  (background service worker)
    │  (chrome.tabs.sendMessage)
    ▼
content-script.js  (content script, isolated world)
    │  (window.postMessage)
    ▼
page-bridge.js  (page main world)
    │  (direct access)
    ▼
Sitrec globals  (NodeMan, Sit, par, Globals, etc.)
```

## Quick Start (Production)

**Prerequisites:** [Node.js](https://nodejs.org/) 18 or later.

### 1. Download and unzip

Download [`SitrecBridge.zip`](https://www.metabunk.org/sitrec/tools/SitrecBridge/dist/SitrecBridge.zip) and unzip it anywhere.

### 2. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `SitrecBridge/extension/` folder
5. The SitrecBridge extension should appear with a blue icon

### 3. Configure your MCP client

**Claude Code** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "node",
      "args": ["/path/to/SitrecBridge/mcp-server.mjs"]
    }
  }
}
```

**Claude Desktop** — edit `claude_desktop_config.json`
(Settings gear → Developer → Edit Config):

*macOS / Linux:*
```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "/path/to/SitrecBridge/run.sh"
    }
  }
}
```

*Windows:*
```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "/path/to/SitrecBridge/run.bat"
    }
  }
}
```

Replace `/path/to/SitrecBridge/` with the actual path where you unzipped the files.
Then restart Claude Desktop.

> **Why `run.sh` instead of `node` directly?** Claude Desktop launches MCP
> servers without sourcing your shell profile, so if you installed Node via
> nvm, fnm, or Volta, the bare `node` command won't be found. The launcher
> script locates Node automatically.

### 4. Use it

1. Open Sitrec in Chrome (e.g. `https://www.metabunk.org/sitrec`)
2. Check the extension popup — both indicators should be green
3. In Claude Code, the `sitrec_*` tools are now available

### 5. Optional: Install Local Compute

Local Compute lets Sitrec send heavier browser workflows to the local
SitrecBridge process. Motion Analysis uses it to run native Python/OpenCV over
the source video, then imports the result back into Sitrec's normal overlay,
graph, panorama, stabilization, CSV export, and track-creation paths.

To install or update the local dependencies:

1. Start SitrecBridge from your MCP client.
2. Open a Sitrec tab in Chrome.
3. Click the SitrecBridge extension icon.
4. Click **Install/Update Local Compute**.

The popup streams installer progress and reports completion. After that, Motion
Analysis automatically tries Local Compute first and falls back to browser
analysis if Local Compute is unavailable.

Current platform status:

| Platform | Status |
|----------|--------|
| macOS | Supported by the bundled installer (`python3`, `pip`, `ffmpeg`/`ffprobe`) |
| Linux | Supported when `python3`, `pip`, and `ffmpeg`/`ffprobe` are available |
| Windows | The worker is portable Python/OpenCV, but the bundled one-click installer is currently Bash-based. Install Python/OpenCV/NumPy/ffmpeg manually or use Git Bash/WSL until a PowerShell installer is added. |

Set `SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` before starting SitrecBridge
to use a specific Python environment.

## Available Tools

| Tool | Description |
|------|-------------|
| `sitrec_status` | Check bridge connection status |
| `sitrec_list_tabs` | List all open Sitrec tabs (ID, URL, title) |
| `sitrec_get_sitch` | Get current situation info (name, frames, FPS, coordinates) |
| `sitrec_load_sitch` | Load a named sitch (e.g. `gimbal`, `chilean`) |
| `sitrec_list_sitches` | List all available sitches |
| `sitrec_list_nodes` | List all nodes in the graph (with optional filters) |
| `sitrec_get_node` | Get a node's type, connections, and value at a frame |
| `sitrec_get_frame` | Get current frame, total frames, FPS, paused state |
| `sitrec_set_frame` | Jump to a specific frame |
| `sitrec_play_pause` | Toggle or set play/pause |
| `sitrec_screenshot` | Capture the Sitrec viewport or page as JPEG by default, with PNG available via `quality: "png"` |
| `sitrec_get_video_frame` | Capture the raw decoded source-video frame before overlays/effects |
| `sitrec_debug_log` | Enable, clear, export, or inspect Sitrec page console/debug-log capture |
| `sitrec_eval` | Evaluate JavaScript in the Sitrec page context |
| `sitrec_api_call` | Call a named Sitrec API function |
| `sitrec_api_list` | List Sitrec API functions and menu controls |
| `sitrec_reload_extension` | Reload the SitrecBridge Chrome extension after extension-file changes |
| `sitrec_guide` | Return the full Sitrec MCP agent guide |

Most tools accept an optional `tab` parameter to target a specific Sitrec tab (by URL substring like `"build2"` or numeric Chrome tab ID). Omit to use the default (first) tab.

## MCP Resources

| URI | Description |
|-----|-------------|
| `sitrec://sitch/current` | Current sitch as JSON |
| `sitrec://nodes` | Full node graph listing |
| `sitrec://guide` | Sitrec MCP agent guide as Markdown |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SITREC_BRIDGE_PORT` | `9780` (sandbox) / scan 9799→9780 (host fallback) | WebSocket server port |
| `SITREC_BRIDGE_HOST` | `127.0.0.1` | Bind address (set to `0.0.0.0` inside Docker) |
| `SITREC_BRIDGE_PAIRED_ORIGIN` | (unset) | If set (e.g. `http://localhost:8081`), this server is paired to that browser origin and the extension routes only matching tabs here. Unset = host fallback (catches any unmatched tab). |
| `SITREC_LOCAL_COMPUTE_PYTHON` | `python3` | Python executable used for Local Compute installs and jobs |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_MB` | `1024` | Local Compute Motion Analysis grayscale-frame cache memory budget |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_LIMIT` | (unset) | Optional hard frame-count cap for the grayscale cache; overrides the memory-budget cap |

The Chrome extension scans ports 9780–9799 for MCP servers and opens a connection to each. Multi-sandbox isolation: `wt sandbox` pairs build port `8080+N` ↔ MCP port `9780+N`, advertising `pairedOrigin: http://localhost:80NN`. The extension routes commands by matching the originating server's `pairedOrigin` to the tab's URL origin.

## Troubleshooting

**Popup shows "No MCP servers":**
- Make sure at least one MCP server is running (Claude Code or `node mcp-server.js`)
- Click "Reconnect" in the popup to force a fresh port scan
- Check the service worker console (`chrome://extensions` → SitrecBridge → "service worker") for `probe error` lines

**"No Sitrec tab found":**
- Open Sitrec in Chrome (not Firefox/Safari)
- The URL must match: `metabunk.org/sitrec*`, `metabunk.org/build*`, `localhost:*/sitrec*`, `localhost:*/build*`, or `127.0.0.1:*`
- If targeting a specific tab with `tab: "build2"`, make sure that tab is open

**"Sitrec is not ready yet":**
- Wait for the page to fully load (all assets, terrain, etc.)
- The page sets `data-ready="complete"` when ready

**Timeouts:**
- Default timeout is 15 seconds per request
- Complex operations (loading sitches) may need more time
- The `sitrec_load_sitch` tool waits for the sitch to finish loading

**Local Compute is unavailable or Motion Analysis falls back to browser analysis:**
- Click **Install/Update Local Compute** in the SitrecBridge extension popup
- Make sure `python3`, `pip`, `ffmpeg`, and `ffprobe` are available in the environment that starts SitrecBridge
- If you use a virtual environment or non-default Python, set `SITREC_LOCAL_COMPUTE_PYTHON` before starting SitrecBridge
- On Windows, install the dependencies manually or run the installer through Git Bash/WSL; the built-in one-click installer currently runs `bash`

## Development Setup

If you're working on the Sitrec codebase itself:

```bash
cd tools/SitrecBridge
npm install
```

The extension has no build step — edit files directly and reload in
`chrome://extensions/`. The MCP server also runs directly with Node.js (ESM).

For development, point your MCP config at the source file instead:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "node",
      "args": ["./tools/SitrecBridge/mcp-server.js"]
    }
  }
}
```

### Building the Distribution Zip

```bash
cd tools/SitrecBridge
npm install          # Installs deps including esbuild
npm run build        # Produces dist/SitrecBridge.zip
```

This bundles all npm dependencies into a single `mcp-server.mjs` file so end
users don't need to run `npm install`.

To regenerate placeholder icons: `node generate-icons.cjs`
