# SitrecBridge Dev

A separate unpacked extension and MCP server for development. It includes the
normal Sitrec tools and adds browser-wide controls. The standard extension's
permissions and automatic content-script scope are unchanged.

## Build and install

From the repository root, run:

```sh
npm --prefix tools/SitrecBridge run build:dev
```

The output is `tools/SitrecBridge/dist/SitrecBridgeDev.zip`, with an unpacked
copy at `tools/SitrecBridge/dist/SitrecBridgeDev/`. The Dev distribution is excluded
from the application's automatic tools copy; it is packaged separately.

1. In `chrome://extensions`, disable the regular SitrecBridge extension so the
   two workers do not compete for the same bridge connections.
2. Enable Developer mode, choose **Load unpacked**, and select the generated
   `SitrecBridgeDev/extension/` directory. The extension is named
   **SitrecBridge Dev** and shows an orange **DEV** badge.
3. Point the MCP client's existing bridge entry at the generated
   `SitrecBridgeDev/run.sh` (Windows: `run.bat`), then reconnect that MCP server.
   This bundle enables Dev tools automatically. For source development, run
   `tools/SitrecBridge/run.sh --dev` instead (or set `SITREC_BRIDGE_DEV=1`).
4. After source edits, rebuild and reload the Dev extension. Restart the MCP
   server after server/tool-schema edits.

Both the server and extension must be the Dev version. Browser commands fail
explicitly against the standard extension. They work without a Sitrec tab open.
Browser tools use exact numeric tab IDs and intentionally reach beyond a paired
Sitrec origin. Existing `sitrec_*` tools retain their usual routing.

## Added tools

| Tool | Behavior |
|---|---|
| `browser_tabs` | All tabs, titles, URLs, IDs, windows and active state |
| `browser_tab` | Open, navigate, activate, reload (optionally bypass cache), close, back, forward |
| `browser_screenshot` | Viewport or full scrollable page as JPEG, without activating or resizing the tab |
| `browser_eval` | JavaScript evaluation on a web tab, including promises and exception reporting |
| `browser_cdp` | Chrome DevTools Protocol: DOM/accessibility, mouse/keyboard/touch input, device emulation, network and performance debugging |
| `browser_events` | Bounded event buffer for console/errors and explicitly enabled CDP domains |
| `browser_debugger_detach` | Release this extension's tab debugger and event buffer |
| `browser_desktop_capture` | Start, inspect, capture, and stop a shared screen/window |

Tab mutations require an explicit tab ID except opening, which defaults to a
background tab. Navigation, reload, and close can discard unsaved work.

Screenshots default to JPEG quality 75, maximum width 1920. Page captures also
limit total pixels and height for unusually long documents. Images are returned
inline to MCP and saved as temporary files, like existing Sitrec screenshots.
Page screenshots include web content; desktop capture includes browser chrome
and other visible applications in the selected screen/window.

## Desktop capture

Call `browser_desktop_capture` with `{"action":"start"}`, or use **Screen
capture controls** in the extension popup. Chrome displays its native source
picker. Select a screen, window, or tab, then switch back to your work.
Use `{"action":"status"}` to check readiness and `{"action":"capture"}`
for subsequent screenshots. Sharing persists until `{"action":"stop"}`,
Chrome's **Stop sharing** control, or closing the capture tab.

If the picker is canceled, use **Choose screen or window** in the capture tab
to retry. macOS may require Screen Recording permission for Chrome. The extension
does not bypass the picker or OS permissions; no native helper is installed.
See [Chrome's Desktop Capture API](https://developer.chrome.com/docs/extensions/reference/api/desktopCapture).

## Debugging and input

Use `browser_cdp` with `{"tab":123,"method":"Accessibility.getFullAXTree"}`
to inspect accessible UI. Send mouse/keyboard/touch sequences using the
`Input` domain; coordinates are CSS pixels in the tab viewport. For example,
`Input.dispatchMouseEvent` takes `type`, `x`, `y`, `button`, and `clickCount`;
send both `mousePressed` and `mouseReleased` for a click. Use
`Emulation.setTouchEmulationEnabled` before testing touch event sequences.

The debugger stays attached across evaluation/CDP/event calls, allowing input
sequences and event collection. Enable `Network.enable` before inspecting network
events, then read `browser_events`. Its in-memory buffer is limited to 200 events
and 512 KB; oversized events are dropped and counted. Events are cleared on read
unless `clear:false`. Nothing is collected before attachment or saved to disk.
When finished, reset any emulation overrides and call `browser_debugger_detach`.
Screenshots release a session they opened themselves, including on failure.

Chrome displays a debugger attachment banner. Opening DevTools can detach the
bridge. Chrome internal pages, other extensions, and policy-restricted targets
may refuse debugging; those errors are returned directly. File URLs need
**Allow access to file URLs** in extension details. Supported commands are
documented in [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
and the [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

The extra permissions are `<all_urls>`, `debugger`, `desktopCapture`, and
`storage` (for bridge diagnostics). Sitrec's page bridge is still injected only
on the original Sitrec URL patterns; browser tooling runs in the extension worker.
Keep the bridge listener on its default loopback address for local development.

## Tests

`npm --prefix tools/SitrecBridge test` runs unit and server lifecycle checks.
With the repository's Playwright Chromium installed,
`npm --prefix tools/SitrecBridge run test:browser` tests the MCP path in an isolated
browser profile and loopback port. It covers tab operations, Retina page captures,
mouse/keyboard/touch input, exceptions, and a screen-capture lifecycle using a
synthetic video source. Native screen selection and OS consent require manual QA.
