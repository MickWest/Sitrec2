# Settings Manager

[`src/SettingsManager.js`](../../src/SettingsManager.js) owns Sitrec's per-user application
preferences. It creates defaults, validates the persisted allowlist, selects a storage path,
and suppresses unchanged writes. The Settings UI and save debounce live on `CCustomManager` in
[`src/CustomSupport.js`](../../src/CustomSupport.js).

Settings are not part of a sitch. They should contain only small, JSON-serializable preferences,
never credentials or other secrets.

## Components

- `src/SettingsManager.js` provides defaults, sanitization, storage helpers,
  `initializeSettings()`, `saveSettings()`, and `SettingsSaver`.
- [`sitrecServer/settings.php`](../../sitrecServer/settings.php) authenticates GET and POST
  requests, repeats the allowlist validation, and stores one JSON object per user.
- `src/CustomSupport.js` initializes settings, builds the Settings menu, applies settings with
  live side effects, and exposes `saveGlobalSettings(immediate)`.
- [`src/StartupDefaults.js`](../../src/StartupDefaults.js) applies new-sitch preferences before
  setup.
- `tests/SettingsManager.test.js` covers selected sanitizer behavior, while
  [`tests/settingsAllowlistParity.test.js`](../../tests/settingsAllowlistParity.test.js) enforces
  identical browser and PHP key lists.

## Storage Flags

Each browser-side backend has an independent build/runtime flag:

| Flag | Backend |
|---|---|
| `SETTINGS_SERVER_ENABLED` | Authenticated GET/POST through `sitrecServer/settings.php` |
| `SETTINGS_DB_ENABLED` | IndexedDB through `indexedDBManager` |
| `SETTINGS_COOKIES_ENABLED` | The `sitrecSettings` browser cookie |

An omitted flag is false at the `SettingsManager` boundary. Deployment configuration decides
which flags are enabled. The tracked `config/shared.env.example` enables server and cookie
storage; the serverless build helper currently disables the server and IndexedDB settings
backends, leaving cookies as its configured settings store.

The cookie is URL-encoded JSON with `path=/`, `SameSite=Lax`, and a one-year expiry. It is a
preference fallback, not a secure or high-capacity store.

The PHP endpoint requires an authenticated user. It writes
`settings/<userID>.json` to object storage when `$useAWS` is enabled, or to
`$UPLOAD_PATH/settings/<userID>.json` otherwise. When an object-storage ACL is configured, the
write explicitly uses a private ACL.

## Initialization and Load Order

The main boot path checks the deployment mode and login before calling
`CustomManager.initializeSettings()`. This happens before `NodeMan` and sitch nodes are created,
so terrain, rendering, and UI code can read `Globals.settings` during construction. Situation
setup checks initialization again before creating the Settings menu.

`initializeSettings()` performs these steps:

1. Create `Globals.settings` defaults if the object does not already exist.
2. Prime the browser-only provider-key cache and set `Globals.hasByokKeys`. This is independent
   of the settings storage backend.
3. In regression mode, force the Balanced rendering values, hide attribution, and return
   without reading persisted preferences.
4. In serverless mode, try enabled, non-empty IndexedDB settings; otherwise try the enabled
   cookie.
5. In server mode, try enabled, non-empty server settings for an effective user ID greater than
   zero; otherwise try the enabled cookie.
6. Merge loaded values over the defaults and record a sanitized JSON snapshot in
   `Globals.lastSettingsJSON`.

Loading never replaces the settings object. It uses `Object.assign`, so omitted or rejected
persisted keys retain their defaults.

## Save Behavior

`saveSettings()` takes no arguments; it reads `Globals.settings`. It sanitizes the object and
compares the JSON with `Globals.lastSettingsJSON`. An unchanged object returns `true` without a
write, and regression mode also returns `true` without writing.

For changed settings:

- Serverless mode attempts IndexedDB, then also calls the cookie helper as a backup. The return
  value is the IndexedDB result.
- Server mode with an authenticated effective user ID attempts the PHP endpoint. A successful
  server write is followed by a cookie backup.
- If the server write is unavailable or fails, or the user is anonymous, the code calls the
  cookie helper and returns `true`.

Every helper still honors its feature flag. Consequently, `saveSettings()` returning `true`
means the save path completed or no write was needed; it is not proof that a disabled fallback
stored data. Use a backend helper's boolean result when backend-level success matters.

`CCustomManager.saveGlobalSettings(immediate)` delegates to a `SettingsSaver` with a five-second
minimum interval:

- `saveGlobalSettings(true)` cancels a pending timer and saves immediately.
- `saveGlobalSettings()` saves immediately when the interval has elapsed; otherwise it replaces
  the pending timer with one scheduled for the remaining interval.
- `SettingsSaver.cancel()` clears a pending save, and `isPending()` reports whether one exists.

Checkboxes and dropdowns generally save immediately. Sliders apply live changes in
`onChange()` and save in `onFinishChange()`. Text-like fields can use a debounced `onChange()`
plus an immediate `onFinishChange()`.

## Exported API

### Validation

```javascript
const sanitized = sanitizeSettings({maxDetails: 100, unknown: true});
// {maxDetails: 30}
```

`sanitizeSettings(settings)` asserts that its input is a non-null object and returns a new
object. It always omits unknown keys. Known keys are coerced, clamped, accepted, or omitted
according to their individual rules.

### Backend Helpers

```javascript
const indexed = await loadSettingsFromIndexedDB(); // object or null
const indexedSaved = await saveSettingsToIndexedDB(settings); // boolean

const cookie = loadSettingsFromCookie(); // object or null
saveSettingsToCookie(settings); // no return value

const server = await loadSettingsFromServer(); // object or null
const serverSaved = await saveSettingsToServer(settings); // boolean
```

Disabled or failed load helpers return `null`. IndexedDB and server save helpers return a
success boolean. The cookie save helper logs failures but does not return a status.

### Orchestration

```javascript
await initializeSettings(); // also returns Globals.settings
await saveSettings();       // reads Globals.settings; returns a boolean

const saver = new SettingsSaver(5000);
await saver.save();      // immediate or debounced
await saver.save(true);  // force immediate
saver.cancel();
```

Application code normally uses `CustomManager.initializeSettings()` and
`CustomManager.saveGlobalSettings()` rather than constructing another saver.

## Persisted Settings

The defaults below are defined in `initializeSettings()`. Accepted values are defined by
`sanitizeSettings()` and duplicated in PHP.

| Setting | Accepted value | Default | Purpose |
|---|---|---:|---|
| `maxDetails` | Number, clamped to 5-30 | `20` | Terrain detail cap |
| `fpsLimit` | `60`, `30`, `20`, or `15` | `30` | Render-loop frame-rate cap |
| `tileSegments` | Rounded number, clamped to 16-256 | `32` | Terrain mesh segments per tile |
| `renderScale` | Nearest of `1`, `0.85`, `0.7`, `0.5`, `0.35` | `0.85` | Offscreen render resolution scale |
| `msaaSamples` | `0`, `2`, `4`, or `8` | `2` | Multisample antialiasing samples |
| `performancePreset` | `Quality`, `Balanced`, `Fast`, `Potato`, or `Custom` | `Balanced` | Named bundle of performance values |
| `videoMaxSize` | `None`, `1080P`, `720P`, `480P`, or `360P` | `720P` | Maximum decoded video size |
| `lastBuildingRotation` | Numeric radians | `0` | Last building rotation |
| `chatModel` | Empty or a validated `provider:model` identifier | `""` | Text assistant model |
| `enableOldAIModels` | Boolean coercion | `false` | Include superseded model families in the model list |
| `voiceModel` | Empty or a validated bare model identifier | `""` | Spoken assistant model |
| `centerSidebar` | Boolean coercion | `false` | Enable the center sidebar |
| `showAttribution` | Boolean coercion | `true` | Show map/elevation attribution |
| `showFilename` | Boolean coercion | `true` | Show the current video filename overlay |
| `language` | Lowercase two-letter code | `en` | Interface language |

The performance defaults intentionally match `PERFORMANCE_PRESETS.Balanced` in
`src/CustomSupport.js`. Regression mode explicitly repeats that preset so screenshots are not
affected by a user's saved performance preferences.

### New-Sitch Startup Preferences

These values are applied to `Sit` by `applyStartupDefaults()` before setup only for a fresh,
not-yet-established custom sitch. Named built-in sitches are tied to specific locations and are
left unchanged. A custom sitch loaded from a file or share link is already established, so its
saved units, camera, and terrain state also win over these preferences.

| Setting | Accepted value | Default | Purpose |
|---|---|---:|---|
| `startupUnits` | `nautical`, `imperial`, `metric`, or `feet` | `nautical` | Initial unit system |
| `startupLocation` | Boolean coercion | `false` | Use the custom start coordinates |
| `startupLat` | Finite number, clamped to -90..90 | `34` | Start latitude |
| `startupLon` | Finite number, clamped to -180..180 | `-118.3` | Start longitude |
| `startupAlt` | Finite number, clamped to 0..100000 | `0` | Metres above ground |
| `startupBuildings` | Boolean coercion | `false` | Enable available 3D buildings for a new sitch |

## Validation and Server Contract

Both sanitizers use a strict allowlist. The browser sanitizes before writing and after reading;
the server sanitizes both GET data and POST input. Unknown keys are omitted. The server returns
the sanitized object after a POST, and the browser verifies that expected keys survived and a
dummy unknown key did not.

This protects the settings contract but does not make settings a suitable secret store. Cookie
values are readable by browser JavaScript, and the server JSON contains ordinary user
preferences.

## Adding a Setting

Follow [How to Add a User Setting](ADDING_NEW_SETTINGS.md). It covers defaults, both allowlists,
the UI, translated text, save timing, and tests.

## Tests

Run the settings sanitizer and allowlist contract tests directly:

```bash
npx jest tests/SettingsManager.test.js tests/settingsAllowlistParity.test.js --runInBand
```

Run `npm test` for the complete unit suite.

## Failure Handling

- Disabled or empty primary storage falls through to the configured cookie path.
- Network, IndexedDB, JSON, and cookie parse failures are logged and converted to the helper's
  failure value.
- Rejected or missing persisted keys leave their defaults in place.
- A server request without authentication receives HTTP 401.
- Incomplete object-storage configuration returns HTTP 503 before a settings request is handled.
