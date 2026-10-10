# Control Sitrec from an AI assistant (MCP Bridge)

SitrecBridge connects an AI assistant to Sitrec running in your browser. It uses MCP (the
Model Context Protocol), the standard way for an AI client to call outside tools. With the
Bridge, the assistant can read and change the open sitch: load satellites, set the time and
the camera, step through frames, take screenshots, and run the Sitrec API.

The Bridge has two parts, and you install both:

- a small **MCP server**, which your AI client starts on your computer, and
- a **Chrome extension**, which connects that server to the Sitrec tab.

This guide is for people who use Sitrec at
[https://www.metabunk.org/sitrec](https://www.metabunk.org/sitrec). You do **not** need the
Sitrec source code, and you do not run `npm install`.

If you use the ChatGPT desktop app, you can control Sitrec without installing anything. See
[Control Sitrec with ChatGPT site tools](https://www.metabunk.org/sitrec/docs/WebMCP.html).

**You need:**

- Chrome or another Chromium browser that can load unpacked extensions
- [Node.js](https://nodejs.org/) 18 or later
- An MCP client: Codex (desktop app, CLI, or IDE extension), Claude Code, or
  Claude Desktop

## 1. Download the Bridge

1. Open Sitrec at `https://www.metabunk.org/sitrec`.
2. Open **Help → Documentation → Download MCP Bridge**, or download
   [SitrecBridge.zip](https://www.metabunk.org/sitrec/tools/SitrecBridge/dist/SitrecBridge.zip)
   directly. The menu item is there only when the installation's build includes the Bridge
   download; the demo on GitHub Pages does not.
3. Save `SitrecBridge.zip`.
4. Unzip it to a permanent folder. Your MCP configuration will point to this
   exact location, so do not leave it somewhere that may be cleaned up. For
   example:
   - macOS/Linux: `~/SitrecBridge/`
   - Windows: `C:\Users\YOUR_NAME\SitrecBridge\`

After unzipping, the folder should contain files such as:

- `README.md` and `SETUP.md` (a copy of this guide)
- `mcp-server.mjs`
- `run.sh`
- `run.bat`
- `extension/`
- `local-compute/`

## 2. Load the Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Turn on **Developer mode** in the top right.
4. Click **Load unpacked**.
5. Select the unzipped `SitrecBridge/extension/` folder.
6. Pin the SitrecBridge extension if you want quick access to the popup.

Do not select the zip file. Chrome needs the unzipped `extension/` folder.

## 3. Tell your MCP client how to start SitrecBridge

You normally do **not** double-click `mcp-server.mjs`. Your MCP client starts
SitrecBridge for you using the command in its config.

Choose the client you use below. Use an absolute path to the unzipped Bridge
folder. You can configure more than one client; each starts its own Bridge
process when needed.

### Codex

The easiest setup is with the Codex CLI. On macOS or Linux, run:

```bash
codex mcp add sitrec-bridge -- "$HOME/SitrecBridge/run.sh"
codex mcp list
```

On Windows PowerShell, run:

```powershell
codex mcp add sitrec-bridge -- node "$env:USERPROFILE\SitrecBridge\mcp-server.mjs"
codex mcp list
```

If you use the Codex desktop app or IDE extension instead, open **Settings →
MCP servers → Add server**, choose **STDIO**, and use:

- Name: `sitrec-bridge`
- macOS/Linux command: the absolute path to `run.sh`, with no arguments
- Windows command: `node`, with the absolute path to `mcp-server.mjs` as its
  only argument

Save, then restart Codex (or select **Restart extension** in the IDE). Codex's
desktop app, CLI, and IDE extension share the same MCP configuration, so you
only need to add the server once on a given Codex host. Use `/mcp` in Codex to
see its connection status.

For more detail, see the [official Codex MCP
documentation](https://developers.openai.com/codex/mcp).

### Claude Code

Add SitrecBridge at user scope so it is available from any Claude Code
project. On macOS or Linux, run:

```bash
claude mcp add --transport stdio --scope user sitrec-bridge -- "$HOME/SitrecBridge/run.sh"
claude mcp list
```

On Windows PowerShell, run:

```powershell
claude mcp add --transport stdio --scope user sitrec-bridge -- node "$env:USERPROFILE\SitrecBridge\mcp-server.mjs"
claude mcp list
```

Then start a new Claude Code session and run `/mcp` to confirm that
`sitrec-bridge` is connected.

To limit SitrecBridge to only the current project, use `--scope local` instead
of `--scope user` and run the command from that project. To share the setup in
a repository, use `--scope project`; Claude Code will create or update
`.mcp.json` and ask each user to approve the project-scoped server.

For more detail, see the [official Claude Code MCP
documentation](https://code.claude.com/docs/en/mcp).

### Claude Desktop (optional)

1. Open Claude Desktop.
2. Open **Settings → Developer → Edit Config**.
3. Add a `sitrec-bridge` entry using the launcher script from your unzipped
   Bridge folder.

macOS / Linux example:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "/Users/YOUR_NAME/SitrecBridge/run.sh"
    }
  }
}
```

Windows example:

```json
{
  "mcpServers": {
    "sitrec-bridge": {
      "command": "C:\\Users\\YOUR_NAME\\SitrecBridge\\run.bat"
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

> **Why use `run.sh` / `run.bat`?** Desktop apps may not inherit your normal
> terminal PATH. The launcher scripts help find Node.js reliably.

## 4. Check that the Bridge is connected

1. Start or restart Codex, Claude Code, or Claude Desktop so it loads the new
   MCP configuration.
2. In Codex or Claude Code, run `/mcp` and check that `sitrec-bridge` is
   connected. From a terminal, `codex mcp list` or `claude mcp list` provides
   the same basic check.
3. Open Sitrec in Chrome, for example `https://www.metabunk.org/sitrec`.
4. Click the SitrecBridge extension icon. The popup should show:
   - a green **MCP Servers** indicator
   - a green **Sitrec Tabs** indicator
   - the current Sitrec tab routed to a local port such as `:9780`

If either indicator is not green:

- Make sure Codex, Claude Code, or Claude Desktop is running.
- Click **Reconnect** in the extension popup.
- Check that the extension was loaded from the same Bridge folder you configured.
- Check that the path in your MCP client config points to the unzipped Bridge.

## 5. Use Sitrec from your AI client

Ask naturally for what you want. For example:

- “Check the Sitrec connection and tell me which situation is open.”
- “Pause Sitrec at frame 100, take a screenshot, and describe both views.”
- “List the tracks and explain how they are connected.”
- “Get the Sitrec MCP guide, then help me inspect this situation.”

The client chooses the appropriate `sitrec_*` tools automatically. Start with
`sitrec_status` when diagnosing a connection and `sitrec_guide` when you need
the full tool and workflow reference. Keep the Sitrec tab open in Chrome while
using the tools.

## 6. Install or update Local Compute

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

## 7. Updating later

When Sitrec offers a newer Bridge version:

1. Download a fresh `SitrecBridge.zip` from **Help → Documentation →
   Download MCP Bridge**.
2. Unzip it, replacing the old Bridge folder or creating a new one.
3. If the folder path changed, update your Codex, Claude Code, or Claude
   Desktop MCP config.
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

## More detail

The [SitrecBridge README](https://github.com/MickWest/Sitrec2/tree/main/tools/SitrecBridge)
(also `README.md` in the Bridge folder) has the technical reference: how the Bridge is put
together, the full list of tools and resources, configuration, and troubleshooting for a
Bridge that does not connect or start.
