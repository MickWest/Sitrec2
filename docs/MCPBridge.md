# Control Sitrec from an AI assistant (MCP Bridge)

SitrecBridge connects an outside AI tool, such as Codex or Claude Code, to Sitrec running in
your browser. It uses MCP (the Model Context Protocol), the standard way for an AI tool to
call outside tools. This page calls that AI tool the **MCP client**. It is not the AI
Assistant that is built into Sitrec.

With the Bridge, the client can read and change the open sitch: load satellites, set the time
and the camera, step through frames, take screenshots, and call Sitrec's own functions.

**What the client can reach.** The Bridge can also run any JavaScript in the Sitrec tab. The
client then has the same access as that tab, so it can read your stored keys. Connect only a
client that you trust. See [Your API Keys](https://www.metabunk.org/sitrec/docs/APIKeys.html).
A sitch from another person can hold text that tries to instruct the client, so check what the
client does.

The Bridge has two parts, and you install both:

- a small **MCP server**, which your MCP client starts on your computer, and
- a **Chrome extension**, which connects that server to the Sitrec tab.

This guide is for people who use Sitrec at
[https://www.metabunk.org/sitrec](https://www.metabunk.org/sitrec). You do **not** need the
Sitrec source code, and you do not run `npm install`. The extension works with Sitrec at
`www.metabunk.org/sitrec`, `local.metabunk.org`, `localhost` and `127.0.0.1`. It does not work
on the GitHub Pages demo or on another domain.

Two other routes need no Bridge:

- The [AI Assistant](https://www.metabunk.org/sitrec/docs/AIAssistant.html) is built into
  Sitrec. To use it, log in or add your own key.
- In the ChatGPT desktop app, the built-in browser can use a smaller set of Sitrec controls.
  Availability depends on your account and model. See
  [Control Sitrec with ChatGPT site tools](https://www.metabunk.org/sitrec/docs/WebMCP.html).

**You need:**

- Chrome or another Chromium browser that can load unpacked extensions
- [Node.js](https://nodejs.org/) 18 or later. To check, run `node --version` in a terminal.
- An MCP client: Codex (CLI or IDE extension), the ChatGPT desktop app, Claude Code, or
  Claude Desktop

## 1. Download the Bridge

1. Open Sitrec at `https://www.metabunk.org/sitrec`.
2. Open **Help → Documentation → Download MCP Bridge**, or download
   [SitrecBridge.zip](https://www.metabunk.org/sitrec/tools/SitrecBridge/dist/SitrecBridge.zip)
   directly. The menu item is there only when the installation's build includes the Bridge
   download; the demo on GitHub Pages does not.
3. Save `SitrecBridge.zip`.
4. The zip holds one folder named `SitrecBridge`. Unzip it into a permanent
   location. Your MCP configuration will point to this exact location, so do not
   leave it somewhere that may be cleaned up. For example, unzip it so that you get:
   - macOS/Linux: `~/SitrecBridge/run.sh`
   - Windows: `C:\Users\YOUR_NAME\SitrecBridge\run.bat`

   If you get a `SitrecBridge` folder inside another `SitrecBridge` folder, move
   everything in the inner folder up one level. Then delete the empty inner
   folder.

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
folder: the full path from the top of the disk, such as
`/Users/YOUR_NAME/SitrecBridge/run.sh`. You can configure more than one client;
each starts its own Bridge process when needed.

Run the commands below in a terminal: Terminal on macOS, PowerShell on Windows.

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

In the ChatGPT desktop app, open **Settings → MCP servers → Add server**. In the
IDE extension, open the gear menu, select **MCP servers**, and add a server.
Choose **STDIO** and use:

- Name: `sitrec-bridge`
- macOS/Linux command: the absolute path to `run.sh`, with no arguments
- Windows command: `node`, with the absolute path to `mcp-server.mjs` as its
  only argument

Save, then select **Restart** (**Restart extension** in the IDE). The ChatGPT
desktop app, Codex CLI, and IDE extension share the same MCP configuration, so
you only need to add the server once on a given computer. Use `/mcp` in Codex to
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

macOS example (on Linux, the path starts with `/home/YOUR_NAME`):

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
> terminal PATH. `run.sh` also looks in the nvm, fnm, Volta and Homebrew
> locations. `run.bat` checks only PATH.

## 4. Check that the Bridge is connected

1. Start or restart your MCP client so it loads the new MCP configuration.
2. In Codex or Claude Code, run `/mcp` and check that `sitrec-bridge` is
   connected. From a terminal, `claude mcp list` provides the same basic check.
   `codex mcp list` shows only that the server is configured, not that it starts.
3. Open Sitrec in Chrome, for example `https://www.metabunk.org/sitrec`.
4. Click the SitrecBridge extension icon. The popup should show:
   - a green **MCP Servers** indicator
   - a green **Sitrec Tabs** indicator
   - the current Sitrec tab, for example
     `https://www.metabunk.org/sitrec #123 → fallback`

The word `fallback` is normal here. It means that the tab uses your Bridge, which
the **MCP Servers** list shows on a port such as `:9799`.

If either indicator is not green:

- Open Sitrec in a tab. The extension looks for MCP servers only while a Sitrec
  tab is open.
- Make sure your MCP client is running.
- Click **Reconnect** in the extension popup.
- Check that the extension was loaded from the same Bridge folder you configured.
- Check that the path in your MCP client config points to the unzipped Bridge.

## 5. Use Sitrec from your AI client

Ask naturally for what you want. For example:

- “Check the Sitrec connection and tell me which situation is open.”
- “Pause Sitrec at frame 100, take a screenshot, and describe both views.”
- “List the tracks and explain how they are connected.”
- “Get the Sitrec MCP guide, then help me inspect this situation.”

The client chooses the appropriate `sitrec_*` tools automatically. Use
`sitrec_status` for a quick check, `sitrec_diagnostics` when the connection
fails, and `sitrec_guide` when you need the full tool and workflow reference.
Keep the Sitrec tab open in Chrome while using the tools.

## 6. Install or update Local Compute

Local Compute is optional. With it, the full-range analysis of Motion Analysis
runs on your computer in Python and OpenCV, not in the browser. Commands that
need the whole frame range, such as **Create Track from Motion** and **Export
Motion**, start this analysis. **Analyze Motion** still runs in the browser. The
results appear in Sitrec as usual.

Local Compute works only when Sitrec runs at `local.metabunk.org`, `localhost`
or `127.0.0.1`. At `www.metabunk.org`, the Bridge refuses the page's connection,
and Motion Analysis runs in the browser.

Install these first. The button does not install them.

| Platform | Install first |
|----------|---------------|
| macOS | Python 3 with pip, and ffmpeg with ffprobe (`brew install ffmpeg`) |
| Linux | `python3`, `pip`, `ffmpeg` and `ffprobe` |
| Windows | `winget install --id Python.Python.3.12` and `winget install --id Gyan.FFmpeg`, then restart your MCP client |

1. Make sure the Bridge is connected as described above.
2. Open the SitrecBridge extension popup.
3. Click **Install/Update Local Compute**.
4. Keep the popup open until the **Activity** list shows `local_compute_install`
   with a ✓ or a ✗. The popup also shows `Local Compute ready on :PORT`, or
   `Install failed:` and the reason, but this text stays for only a few seconds.
   To read a failure reason again, click the button again.

The button uses pip to install or update OpenCV and NumPy in your Python
environment, and it updates nothing else. To update the Bridge or the Local
Compute worker, see section 7.

With **Use Local Compute** on (the default), the full-range analysis tries Local
Compute first and falls back to browser analysis. To see which one ran, read the
**Local Compute** line in **Video → Motion Analysis**. It shows *Done (N frames)*,
or *Fallback:* and the reason.

To use a specific Python, give your MCP client the variable
`SITREC_LOCAL_COMPUTE_PYTHON`, set to the absolute path of that Python. Then
restart the client and click **Install/Update Local Compute** again. The install
and the analysis jobs both use this Python.

- Codex CLI: run your `codex mcp add` command again, with
  `--env SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` before `sitrec-bridge`.
- ChatGPT desktop app or IDE extension: add these lines to
  `~/.codex/config.toml` (`~` is your home folder). Keep the single quotes.

  ```toml
  [mcp_servers.sitrec-bridge.env]
  SITREC_LOCAL_COMPUTE_PYTHON = '/path/to/python'
  ```

- Claude Code: run `claude mcp remove sitrec-bridge`. Then run your
  `claude mcp add` command again, with
  `-e SITREC_LOCAL_COMPUTE_PYTHON=/path/to/python` after `sitrec-bridge`.
- Claude Desktop: add
  `"env": { "SITREC_LOCAL_COMPUTE_PYTHON": "/path/to/python" }` to the
  `sitrec-bridge` entry.

You need this variable in two cases:

- pip stops with `externally-managed-environment`. Homebrew Python does this, and
  a Linux distribution's Python can do it too. Make a virtual environment with
  `python3 -m venv ~/sitrec-python`, and use the absolute path of its `bin/python`.
- You use Windows. Use the full path of `python.exe`. The installer can find
  Python with `py -3`, but analysis jobs look only for `python3`.

## 7. Updating later

Sitrec does not tell you when a newer Bridge exists. To update the Bridge:

1. Download a fresh `SitrecBridge.zip` from **Help → Documentation →
   Download MCP Bridge**.
2. Unzip it, replacing the old Bridge folder or creating a new one.
3. If the folder path changed, update your MCP client's config.
4. Update the extension in `chrome://extensions/`. If you replaced the old folder
   at the same path, click the reload icon on the SitrecBridge card. If you made
   a new folder, click **Remove** on the old card, then click **Load unpacked**
   and select the new `extension/` folder.
5. Restart your MCP client.
6. If you use Local Compute, open the extension popup and click
   **Install/Update Local Compute**.

## More detail

The [SitrecBridge README](https://github.com/MickWest/Sitrec2/tree/main/tools/SitrecBridge)
(also `README.md` in the Bridge folder) has the technical reference: how the Bridge is put
together, the full list of tools and resources, configuration, and troubleshooting for a
Bridge that does not connect or start.
