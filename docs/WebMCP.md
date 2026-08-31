# Control Sitrec with ChatGPT site tools

Sitrec can expose a small set of controls to ChatGPT while the same Sitrec page is open in the ChatGPT desktop app's built-in browser. ChatGPT calls these **site tools**; they use the proposed WebMCP standard.

This route does not require an OpenAI API key in Sitrec, a SitrecBridge installation, a Chrome extension, a local WebSocket, or a separately configured MCP server. Sitrec provides browser-side controls only. Your ChatGPT plan and feature availability govern the agent.

## Use site tools

1. Update and open the ChatGPT desktop app.
2. Start ChatGPT Work or Codex with a site-tools-capable model.
3. Open the built-in browser and visit [https://www.metabunk.org/sitrec](https://www.metabunk.org/sitrec) directly. Do not open Sitrec inside another page's iframe.
4. Sign in to Metabunk/Sitrec in that browser profile if necessary.
5. Open a Sitrec case.
6. Select **Site tools** in the browser address bar to review the tools the page provides.
7. Ask the agent to inspect or operate the open case and verify the result on the page.

For example:

```text
Read the current Sitrec state and tell me the case, frame, FPS, and camera position.
```

```text
Pause Sitrec and move to frame 850. Verify the resulting frame.
```

```text
List the current tracks. Then give me the target's latitude, longitude, and altitude at the current frame.
```

```text
Move the camera to latitude 38.5816, longitude -121.4944, altitude 2000 meters, then report the actual camera position.
```

```text
List the available Sitrec cases containing "Gimbal." Load the matching saved case and report when its core state is ready.
```

## Available Sitrec tools

The initial public surface is deliberately limited:

| Tool | What it does |
|---|---|
| `sitrec_get_state` | Reads the current case, frame, playback, simulation time, camera, and loading state. |
| `sitrec_list_sitches` | Searches Sitrec's built-in and saved-case catalogs. |
| `sitrec_load_sitch` | Loads an exact case returned by the catalog tool. It does not accept a URL or file path. |
| `sitrec_seek_frame` | Moves to an exact zero-based frame and reads the frame back. |
| `sitrec_set_playback` | Plays, pauses, or toggles playback and reads the resulting state. |
| `sitrec_get_camera` | Reads the camera latitude, longitude, and altitude. |
| `sitrec_goto_lla` | Moves the camera to validated latitude, longitude, and altitude values. |
| `sitrec_list_tracks` | Searches the current track list and returns exact track identifiers. |
| `sitrec_get_track_position` | Reads a catalogued track's position at the current or specified frame. |
| `sitrec_list_views` | Lists current views, visibility, and layout bounds. |

These tools do not expose arbitrary JavaScript, arbitrary API calls, URLs, file selection, saving, sharing, credentials, browser storage, or destructive operations.

## Current limitations

The following product details were verified on **August 31, 2026** and may change:

- Site tools currently work in the built-in browser in the ChatGPT desktop app, not ordinary Chrome.
- Availability depends on the account, selected model, desktop app version, rollout, and current page.
- OpenAI currently documents GPT-5.6 Sol and GPT-5.6 Terra for site tools. GPT-5.6 Luna currently has WebMCP disabled, and Enterprise and Edu workspaces are currently excluded.
- The Sitrec page must remain open. Its tools disappear when the page is closed or navigates away.
- Tools registered by embedded iframes are not currently discovered, so open Sitrec as the top-level page.
- The built-in browser uses its own profile; you may need to sign in again.
- Select local video, KML, MISB, CSV, or other files yourself. The site tools do not automate local file selection.

See OpenAI's current [site-tools documentation](https://learn.chatgpt.com/docs/webmcp) and [built-in browser documentation](https://learn.chatgpt.com/docs/browser) before relying on a particular model or workspace rollout.

## Site tools and SitrecBridge serve different workflows

WebMCP site tools operate only the Sitrec page currently open in ChatGPT's built-in browser. They are the low-setup route for a person and agent working on the same visible page.

SitrecBridge remains the appropriate route for Codex CLI/IDE, Claude Code/Desktop, local automation, screenshots, local compute, multi-tab routing, diagnostics, and other development workflows outside that browser. WebMCP does not replace it.

## Developer notes

The production registration lives in `src/WebMCP.js` and is imported by the normal top-level `src/index.js` bundle. Unsupported browsers simply skip registration.

Every site-tool operation passes through `CSitrecAPI.handleAPICall(..., "webmcp")`. Sitrec classifies `webmcp` with the untrusted `chat` source for non-LLM-callable functions, external URL blocking, external-sitch write confirmation, and untrusted-result fencing. The installed/developer `mcp` source used by SitrecBridge retains its existing trust model.

The adapter validates strict inputs before CSitrecAPI argument coercion, accepts only case and track identifiers returned by current catalog tools, reads state back after visible mutations, and reports partial case loading honestly. Cancelling a site-tool invocation stops only its observer; it never cancels Sitrec's unrelated application work.

Run the focused checks with:

```bash
npx jest tests/WebMCP.test.js tests/CSitrecAPI.test.js --runInBand
node scripts/security-scan-ai-surface.mjs
```
