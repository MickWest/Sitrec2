# Control Sitrec with ChatGPT site tools

Sitrec can expose a small set of controls to ChatGPT while the same Sitrec page is open in the ChatGPT desktop app's built-in browser. ChatGPT calls these **site tools**; they use the proposed WebMCP standard.

This route does not require an OpenAI API key in Sitrec, a SitrecBridge installation, a Chrome extension, or a separately configured MCP (Model Context Protocol) server. MCP is a standard way for an AI client to call outside tools. Sitrec provides browser-side controls only. What the agent can do depends on your ChatGPT plan and on OpenAI's rollout.

## Use site tools

1. Update and open the ChatGPT desktop app.
2. Start ChatGPT Work or Codex with a model that supports site tools. See [Current limitations](#current-limitations) for the models and plans that work.
3. Select **New tab** to open the built-in browser, and visit [https://www.metabunk.org/sitrec](https://www.metabunk.org/sitrec) directly. Do not open Sitrec inside another page's iframe.
4. To use your saved sitches, sign in to Metabunk/Sitrec in that browser profile.
5. Open a Sitrec sitch.
6. Select **Site tools** in the browser address bar to review the tools the page provides.
7. Ask the agent to inspect or operate the open sitch and verify the result on the page.

If **Site tools** does not appear, wait for the page to finish loading. Then check that Sitrec is the top-level page, and that your app version, model, and plan are supported. Otherwise, use SitrecBridge: see [MCP Bridge](MCPBridge.md).

For example:

```text
Read the current Sitrec state and tell me the sitch, frame, FPS, and camera position.
```

```text
Pause Sitrec and move to frame 850. Verify the resulting frame.
```

```text
List the current tracks. Then read the position of the first track at the current frame.
```

```text
Move the camera to latitude 38.5816, longitude -121.4944, altitude 2000 meters above ground, then report the camera position.
```

```text
List the built-in Sitrec sitches containing "Horizon Flares". Load the match and report when its core state is ready.
```

```text
Set the simulation time to 10pm tonight in my local timezone, then tell me what it became.
```

```text
List the controls in the view menu, then turn the video overlay off.
```

## Available Sitrec tools

Sitrec gives the agent these tools:

| Tool | What it does |
|---|---|
| `sitrec_get_state` | Reads the current sitch, frame, playback, simulation time, camera, and loading state. |
| `sitrec_list_sitches` | Searches Sitrec's built-in sitches and your own saved sitches. Sign in to see saved sitches. |
| `sitrec_load_sitch` | Loads a sitch returned by the catalog tool. It does not accept a URL or file path. Some built-in sitches, including Gimbal, GoFast, Agua, and Nightsky, cannot load this way, and the tool returns an error. Open these yourself. |
| `sitrec_seek_frame` | Moves to an exact zero-based frame and reads the frame back. |
| `sitrec_set_playback` | Plays, pauses, or toggles playback and reads the resulting state. |
| `sitrec_get_camera` | Reads the camera's manual latitude, longitude, and altitude. Altitude is in meters [above ground level (AGL)](GIS.md#three-kinds-of-height) or above mean sea level (MSL), as set by **Above Ground Level**. |
| `sitrec_goto_lla` | Moves the camera to validated latitude, longitude, and altitude values and reads the position back. Altitude is in meters above ground level, and the tool turns on **Above Ground Level**. Other routes use a different unit or reference: see [Coordinate formats](GIS.md#coordinate-formats). |
| `sitrec_list_tracks` | Searches the current track list and returns exact track identifiers. |
| `sitrec_get_track_position` | Reads a catalogued track's position at the current or specified frame, as Earth-centered x, y, z in meters. |
| `sitrec_list_views` | Lists current views, visibility, and layout bounds. |
| `sitrec_set_datetime` | Sets the simulation date and time at frame 0, which moves the sun, moon, stars, and satellites. On a later frame, the time that the tool reads back is later than the time you set. Requires an explicit timezone offset. |
| `sitrec_list_menu_controls` | Lists the menus, or the controls in one menu with their type, current value, and permitted options. |
| `sitrec_set_menu_value` | Sets one menu control to a value and reads the result back. |

These tools do not expose arbitrary JavaScript, arbitrary API calls, URLs, file selection, saving, sharing, credentials, or browser storage. They do change the open sitch. `sitrec_load_sitch` replaces the open sitch without a prompt, and unsaved changes are lost. Save your work before you ask the agent to load a sitch.

`sitrec_set_menu_value` sets plain values only. It refuses buttons, such as Add Object and Save, structured values, such as an array-backed color, and any value that looks like a URL. Dropdown controls accept only their listed options.

`sitrec_set_datetime` refuses a bare local time such as `2026-08-31T22:00:00`, because the same clock time is a different moment in each time zone.

## Current limitations

The following product details were verified on **October 31, 2026** and may change:

- Site tools currently work in the built-in browser in the ChatGPT desktop app, not ordinary Chrome.
- Availability depends on the account, selected model, desktop app version, rollout, and current page.
- OpenAI currently documents GPT-5.6 Sol and GPT-6 Sol for site tools. GPT-5.6 Luna currently has WebMCP disabled. In Enterprise workspaces, an admin must allow Site tools through workspace policy. Edu workspaces are excluded.
- The Sitrec page must remain open. Its tools disappear when the page is closed or navigates away.
- Tools registered by embedded iframes are not currently discovered, so open Sitrec as the top-level page.
- The built-in browser uses its own profile; you may need to sign in again.
- Select local video, KML, MISB, CSV, or other files yourself. The site tools do not automate local file selection.
- Most built-in sitches, such as Gimbal, Chilean, and AA2292, have no manual camera position. In these sitches, `sitrec_get_state`, `sitrec_get_camera`, and `sitrec_goto_lla` return an error. The custom sitch, and sitches that you build from it, are not affected.
- While a track drives the camera, the camera position in `sitrec_get_state` and `sitrec_get_camera` does not follow the track. `sitrec_goto_lla` can report success and leave the camera where it was, so compare `requested` with `camera` in its result.
- If you opened a sitch from an outside link or from another user, Sitrec can show an **Allow this change?** dialog on the page when the agent calls a tool. The tool waits for your answer. Select **Allow once** or **Trust this sitch** to continue.

See OpenAI's current [site-tools documentation](https://learn.chatgpt.com/docs/webmcp) and [built-in browser documentation](https://learn.chatgpt.com/docs/browser) before relying on a particular model or workspace rollout.

## Site tools and SitrecBridge serve different workflows

WebMCP site tools operate only the Sitrec page currently open in ChatGPT's built-in browser. They are the low-setup route for a person and agent working on the same visible page.

SitrecBridge remains the appropriate route for Codex CLI/IDE, Claude Code/Desktop, local automation, screenshots, [local compute](MCPBridge.md#6-install-or-update-local-compute) (local hosts only), multi-tab routing, diagnostics, and other development workflows outside that browser. WebMCP does not replace it.

## Developer notes

The production registration lives in `src/WebMCP.js` and is imported by the normal top-level `src/index.js` bundle. Unsupported browsers simply skip registration.

Every site-tool operation passes through `CSitrecAPI.handleAPICall(..., "webmcp")`. Sitrec classifies `webmcp` with the untrusted `chat` source for non-LLM-callable functions, external URL blocking, and external-sitch write confirmation. Result fencing covers only `getNotes`, which no site tool calls. Site-tool labels pass through `sanitizeLabelForPrompt`, and the tools that read sitch text set `untrustedContentHint`. The installed/developer `mcp` source used by SitrecBridge retains its existing trust model.

The adapter validates strict inputs before CSitrecAPI argument coercion, accepts only sitch and track identifiers returned by current catalog tools, reads state back after visible mutations, and reports when a sitch is only partly loaded. Cancelling a site-tool invocation stops only its observer; it never cancels Sitrec's unrelated application work.

`sitrec_list_menu_controls` marks a control that the setter refuses as `settable: false`. The setter refuses `http:`, `https:`, `ftp:`, `ws:`, `wss:`, `data:`, `blob:`, `file:`, `filesystem:`, `javascript:`, `vbscript:`, and browser-extension URLs, and a value that starts with `//`. A free-text control that holds a texture or feed URL would otherwise fetch a remote resource with no review. The check normalizes the value the way a browser does. Ordinary text with a colon, such as `Plane: N123`, is accepted.

To convert a local time, the model reads `wallClock.timezone` from `sitrec_get_state`. This is the IANA zone name from the browser. `wallClock.dateTime` and `wallClock.timezoneOffsetHours` use Sitrec's time zone for the sitch, which can differ from the user's zone, and `sitrec_set_datetime` sets that zone from its offset. The zone name also matters because on a daylight-saving changeover day tonight's offset is not today's.

Run the focused checks with:

```bash
npx jest tests/WebMCP.test.js tests/CSitrecAPI.test.js --runInBand
node scripts/security-scan-ai-surface.mjs
```
