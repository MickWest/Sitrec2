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

## Quick Start For Metabunk.org Users

This path is for someone using Sitrec at `https://www.metabunk.org/sitrec`.
You do **not** need to clone the Sitrec source code or run `npm install`.

**You need:**

- Chrome or another Chromium browser that can load unpacked extensions
- [Node.js](https://nodejs.org/) 18 or later
- An MCP client such as Claude Desktop or Claude Code

### 1. Download the Bridge

1. Open Sitrec at `https://www.metabunk.org/sitrec`.
2. Open **Help → Documentation → Download MCP Bridge**.
3. Save `SitrecBridge.zip`.
4. Unzip it somewhere you can find again, for example:
   - macOS: `~/Downloads/SitrecBridge/`
   - Windows: `C:\Users\<you>\Downloads\SitrecBridge\`
   - Linux: `~/Downloads/SitrecBridge/`

After unzipping, the folder should contain files such as:

- `README.md`
- `mcp-server.mjs`
- `run.sh`
- `run.bat`
- `extension/`
- `local-compute/`

### 2. Load the Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked**.
5. Select the unzipped `SitrecBridge/extension/` folder.
6. Pin the SitrecBridge extension if you want quick access to the popup.

Do not select the zip file. Chrome needs the unzipped `extension/` folder.

### 3. Tell your MCP client how to start SitrecBridge

You normally do **not** double-click `mcp-server.mjs`. Your MCP client starts
SitrecBridge for you using the command in its config.

#### Claude Desktop

1. Open Claude Desktop.
2. Open **Settings → Developer → Edit Config**.
3. Add a `sitrec-bridge` entry using the launcher script from your unzipped
   Bridge folder.

macOS / Linux example:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "/Users/<you>/Downloads/SitrecBridge/run.sh"
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "C:\\Users\\<you>\\Downloads\\SitrecBridge\\run.bat"
    }
  }
}
```

Use your real folder path. On Windows JSON paths need doubled backslashes
(`\\`), as shown above.

4. Save the config file.
5. Quit and restart Claude Desktop.

Claude Desktop starts SitrecBridge in the background after restart. If the
path is wrong, Claude will not be able to start the Bridge.

> **Why use `run.sh` / `run.bat`?** Claude Desktop may not inherit your normal
> terminal PATH. The launcher scripts help find Node.js reliably.

#### Claude Code

Add this to `.mcp.json` in the project folder where you use Claude Code:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "node",
      "args": ["/Users/<you>/Downloads/SitrecBridge/mcp-server.mjs"]
    }
  }
}
```

Use the real path to your unzipped `mcp-server.mjs`. On Windows, use doubled
backslashes in the JSON path.

### 4. Check that the Bridge is connected

1. Open Sitrec in Chrome, for example `https://www.metabunk.org/sitrec`.
2. Click the SitrecBridge extension icon.
3. The popup should show:
   - a green **MCP Servers** indicator
   - a green **Sitrec Tabs** indicator
   - the current Sitrec tab routed to a local port such as `:9780`

If either indicator is not green:

- Make sure Claude Desktop or Claude Code is running.
- Click **Reconnect** in the extension popup.
- Check that the extension was loaded from the same Bridge folder you configured.
- Check that the path in your MCP client config points to the unzipped Bridge.

### 5. Install or update Local Compute

Local Compute is optional. It lets Motion Analysis run a native Python/OpenCV
worker through SitrecBridge, then import the result back into Sitrec's normal
overlay, graph, panorama, stabilization, CSV export, and track-creation paths.

1. Make sure the Bridge is connected as described above.
2. Open the SitrecBridge extension popup.
3. Click **Install/Update Local Compute**.
4. Wait for the popup to report that Local Compute dependencies are ready.

The button installs or updates the local Python/OpenCV/NumPy dependencies used
by the Bridge folder you are currently running. After installation, Motion
Analysis automatically tries Local Compute first and falls back to browser
analysis if Local Compute is unavailable.

Important update distinction:

- To update the **Bridge code or Local Compute worker code**, download a fresh
  MCP Bridge zip from **Help → Documentation → Download MCP Bridge**, unzip it,
  restart your MCP client, and reload the Chrome extension from the new
  `extension/` folder.
- To update the **local Python/OpenCV/NumPy dependencies**, click
  **Install/Update Local Compute** in the extension popup.

### 6. Updating later

When Sitrec offers a newer Bridge version:

1. Download a fresh `SitrecBridge.zip` from **Help → Documentation →
   Download MCP Bridge**.
2. Unzip it, replacing the old Bridge folder or creating a new one.
3. If the folder path changed, update your Claude Desktop or Claude Code MCP
   config.
4. Reload the Chrome extension from the new `SitrecBridge/extension/` folder.
5. Restart your MCP client.
6. Open the extension popup and click **Install/Update Local Compute** if you
   use Motion Analysis acceleration.

Current Local Compute platform status:

| Platform | Status |
|----------|--------|
| macOS | Supported by the bundled installer (`python3`, `pip`, `ffmpeg`/`ffprobe`) |
| Linux | Supported when `python3`, `pip`, and `ffmpeg`/`ffprobe` are available |
| Windows | Supported by the bundled PowerShell installer. Install Python 3 and ffmpeg first if they are not already available. The installer suggests `winget install --id Python.Python.3.12` and `winget install --id Gyan.FFmpeg` when dependencies are missing. |

Set `SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` before starting SitrecBridge
to use a specific Python environment. On Windows, the installer uses `py -3`
first when no explicit Python is set, then falls back to `python` or `python3`.

## Available Tools

| Tool | Description |
|------|-------------|
| `sitrec_status` | Check bridge connection status |
| `sitrec_diagnostics` | Diagnose connection/port problems: port-pool census, this bridge's event trail, and the extension's persisted service-worker log |
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
| `SITREC_BRIDGE_IDLE_TIMEOUT_MS` | `3600000` (one hour) | Exit after this long without an MCP message, unless Local Compute or an extension request is active. MCP hosts restart live bridges when needed. Set to `0` to disable. |
| `SITREC_LOCAL_COMPUTE_PYTHON` | `python3` | Python executable used for Local Compute installs and jobs |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_MB` | `1024` | Local Compute Motion Analysis grayscale-frame cache memory budget |
| `SITREC_LOCAL_COMPUTE_GRAY_CACHE_LIMIT` | (unset) | Optional hard frame-count cap for the grayscale cache; overrides the memory-budget cap |
| `SITREC_BRIDGE_UNUSED_RELEASE_MS` | `180000` (3 min) | How long a bridge that has never relayed a call keeps its port before returning it to the pool |
| `SITREC_BRIDGE_IDLE_RELEASE_MS` | `1800000` (30 min) | How long a bridge that *has* been used keeps its port after going quiet |
| `SITREC_BRIDGE_LOG_DIR` | `~/.sitrec-bridge/logs` | Where the JSONL diagnostic trail is written |

The Chrome extension scans ports 9780–9799 for MCP servers and opens a connection to each. Multi-sandbox isolation: `wt sandbox` pairs build port `8080+N` ↔ MCP port `9780+N`, advertising `pairedOrigin: http://localhost:80NN`. The extension routes commands by matching the originating server's `pairedOrigin` to the tab's URL origin.

### Ports are leased, not owned

A host-fallback bridge borrows a port rather than keeping one for life. This matters because most
bridges are started by processes that will never touch Sitrec: `claude bg-spare` pre-warms,
`claude --remote-control` instances, and `codex app-server` daemons that outlive their conversations
by days. Measured on a normal working machine, 7 of the 20 ports were held by bridges that had
served zero tool calls between them.

- A bridge that has never relayed a call gives its port back after `SITREC_BRIDGE_UNUSED_RELEASE_MS`;
  one that has been used but gone quiet gives it back after `SITREC_BRIDGE_IDLE_RELEASE_MS`.
- **Releasing is not fatal.** The process stays alive and silently takes a port again on the next
  tool call that needs the browser. Nothing needs reconnecting.
- Four things pin a port: an in-flight request, a paired sandbox origin, a connected Local Compute
  client, and being the bridge the extension has chosen to route through.
- The oldest bound fallback bridge is the *anchor* and always keeps its port, so the range is never
  left empty — the Sitrec page discovers Local Compute by scanning the range directly, with no MCP
  call involved.

If every port is occupied when a bridge starts, it asks the least-useful peer (never-used first) to
*release* rather than exit, and falls back to asking it to shut down only for pre-v5 bridges that
have no release endpoint. A bridge that still cannot get a port stays alive without one and retries
later; it no longer exits, which used to leave the session with a permanently dead MCP server.

## Troubleshooting

**Start here: `sitrec_diagnostics`.** It answers without needing the extension, and returns

- **`portPool`** — every bridge on 9780–9799: its pid, *which parent process spawned it*
  (`parentCommand`), whether it has ever relayed a call, how long it has been idle. This is the view
  that identifies a port leak and names the culprit.
- **`serverEvents`** — this process's trail: port binds and releases, extension connect/disconnect,
  relay timings, timeouts.
- **`crossSessionLog`** — the same trail merged across *all* bridge processes, from
  `~/.sitrec-bridge/logs/bridge-YYYY-MM-DD.jsonl`. This is what shows a port changing hands.
- **`extensionLog`** — the extension's own event log, kept in `chrome.storage.local` so it
  **survives service-worker restarts**. A burst of `worker-start` entries means Chrome is killing
  the worker repeatedly; that is the signature of the connection dropping on its own.

**Bridge keeps disconnecting / "extension is not connected":**
- Check `extensionLog` for repeated `worker-start` events. Chrome suspends an MV3 service worker
  after 30 s of inactivity, and a WebSocket *protocol ping* does not count as activity — Chrome
  answers it in the network stack without waking the extension's JavaScript. The bridge therefore
  sends an application-level `server-ping` every 10 s, and the content script sends a port heartbeat
  every 20 s; either one resets the timer. If you see the worker dying anyway, confirm a Sitrec tab
  is actually open (the heartbeat comes from the page).
- After changing any file under `extension/`, reload the extension (`sitrec_reload_extension`, or
  the Reload button on `chrome://extensions`) — the old worker keeps running otherwise.

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
- On Windows, install Python 3 and ffmpeg, then restart the app that starts SitrecBridge so updated `PATH` entries are visible

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
