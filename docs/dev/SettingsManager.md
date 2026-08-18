# Settings Manager

## Overview

The Settings Manager module provides a centralized system for managing user settings in Sitrec. It supports three storage backends, each gated by an environment-variable flag (`SETTINGS_SERVER_ENABLED`, `SETTINGS_DB_ENABLED`, `SETTINGS_COOKIES_ENABLED`): server-side storage via the PHP backend (S3, or local filesystem when S3 is not configured), browser IndexedDB (used in serverless mode), and client-side cookies as a fallback.

## Architecture

### Files

1. **`src/SettingsManager.js`** - Core settings management module
   - Handles loading and saving settings
   - Provides sanitization and validation
   - Manages fallback between server and cookies

2. **`sitrecServer/settings.php`** - PHP backend endpoint
   - GET: Fetches user settings (from S3 if configured, otherwise from local filesystem)
   - POST: Saves user settings (to S3 if configured, otherwise to local filesystem)
   - Requires user authentication
   - Stores settings at `settings/<userID>.json` (in S3, or under `$UPLOAD_PATH/settings/` locally)

3. **`src/CustomSupport.js`** - Integration point
   - Uses SettingsManager for initialization and saving
   - Provides UI for settings management

4. **`tests/SettingsManager.test.js`** - Comprehensive unit tests
   - Tests all functionality including edge cases
   - Validates sanitization and security measures

## Features

### Server-Side Storage
- Stored at `settings/<userID>.json` in S3 when AWS is configured, otherwise on the local filesystem under `$UPLOAD_PATH/settings/`
- S3 objects are written with a private ACL (`ACL => 'private'`) when an ACL is configured
- Requires user to be logged in (userID > 0)
- Graceful fallback to cookies if server unavailable

### Cookie Storage
- Used as fallback when server unavailable
- Used for non-logged-in users
- Always saved as backup even when server save succeeds
- 1-year expiration

### Security
- Settings are sanitized before saving/loading
- Only whitelisted settings are allowed
- Values are validated and clamped to safe ranges
- Private ACL on S3 files prevents public access

## API

### Functions

#### `sanitizeSettings(settings)`
Validates and sanitizes settings object.

```javascript
const sanitized = sanitizeSettings({ maxDetails: 100 });
// Returns: { maxDetails: 30 } (clamped to max)
```

#### `loadSettingsFromCookie()`
Loads settings from browser cookies.

```javascript
const settings = loadSettingsFromCookie();
// Returns: { maxDetails: 15 } or null
```

#### `saveSettingsToCookie(settings)`
Saves settings to browser cookies.

```javascript
saveSettingsToCookie({ maxDetails: 20 });
```

#### `loadSettingsFromServer()`
Async function to load settings from server (S3).

```javascript
const settings = await loadSettingsFromServer();
// Returns: { maxDetails: 15 } or null
```

#### `saveSettingsToServer(settings)`
Async function to save settings to server (S3).

```javascript
const success = await saveSettingsToServer({ maxDetails: 20 });
// Returns: true or false
```

#### `initializeSettings()`
Initializes `Globals.settings` by loading from server (if logged in) or cookies.

```javascript
await initializeSettings();
// Globals.settings is now populated
```

#### `saveSettings()`
Saves `Globals.settings` to the active backend (IndexedDB in serverless mode, else server if logged in, else cookies), with cookie backup. No-ops if settings are unchanged.

```javascript
await saveSettings();
```

(The debounced wrapper `CCustomManager.saveGlobalSettings(immediate)` in `CustomSupport.js` delegates to the `SettingsSaver` class, which calls `saveSettings()`.)

## Current Settings

The defaults below match the **Balanced** performance preset (see `PERFORMANCE_PRESETS` in `CustomSupport.js`). The whitelist lives in `sanitizeSettings()` and the defaults block in `initializeSettings()` (both in `SettingsManager.js`).

### maxDetails
- **Type**: Number
- **Range**: 5-30 (clamped)
- **Default**: 20
- **Description**: Maximum level of detail for terrain subdivision

### fpsLimit
- **Type**: Number (one of 60, 30, 20, 15)
- **Default**: 30
- **Description**: Frame-rate cap

### tileSegments
- **Type**: Number (clamped 16-256)
- **Default**: 32
- **Description**: Terrain tile subdivision segments

### renderScale
- **Type**: Number (snapped to one of 1, 0.85, 0.7, 0.5, 0.35)
- **Default**: 0.85
- **Description**: Render resolution scale (1 = native)

### msaaSamples
- **Type**: Number (one of 0, 2, 4, 8)
- **Default**: 2
- **Description**: Multisample anti-aliasing samples

### performancePreset
- **Type**: String (one of Quality, Balanced, Fast, Potato, Custom)
- **Default**: Balanced
- **Description**: Named bundle of the performance knobs above

### videoMaxSize
- **Type**: String (one of None, 1080P, 720P, 480P, 360P)
- **Default**: 720P
- **Description**: Maximum decoded video resolution

### lastBuildingRotation
- **Type**: Number (radians)
- **Default**: 0
- **Description**: Last building rotation, persisted across sessions

### chatModel
- **Type**: String (`provider:model` or empty)
- **Default**: `""` (use first available)
- **Description**: AI chat model selection

### centerSidebar
- **Type**: Boolean
- **Default**: false
- **Description**: Enable center sidebar between split views

### showAttribution
- **Type**: Boolean
- **Default**: true
- **Description**: Show map/elevation data source attribution overlay

### showFilename
- **Type**: Boolean
- **Default**: true
- **Description**: Show the current video filename in the bottom overlay

### language
- **Type**: String (2-letter code)
- **Default**: `en`
- **Description**: UI language

### New-sitch startup preferences

These are applied to `Sit` before setup runs (see `applyStartupDefaults` in `StartupDefaults.js`)
and are never part of a sitch, so loading a saved sitch still restores that sitch's own units and
camera. The defaults reproduce the old hard-coded startup exactly.

| Setting | Type | Default | Description |
|---|---|---|---|
| `startupUnits` | String — one of `nautical`, `imperial`, `metric`, `feet` (keys of `SELECTABLE_UNITS` in `CUnits.js`) | `nautical` | Units a new sitch starts in |
| `startupLocation` | Boolean | `false` | `false` = use the sitch's own start location |
| `startupLat` | Number (clamped -90..90) | `34` | Only used when `startupLocation` is true |
| `startupLon` | Number (clamped -180..180) | `-118.3` | Only used when `startupLocation` is true |
| `startupAlt` | Number (clamped 0..100000) | `0` | Metres ABOVE GROUND; 0 = standing on the ground |
| `startupBuildings` | Boolean | `false` | 3D buildings on at startup (needs permission and a provider key) |

## Adding New Settings

See **[Adding New Settings](ADDING_NEW_SETTINGS.md)** for the full checklist. It is the
authoritative version: a new setting touches **six** places, not the four this section used to
list, and the UI step is internationalized (`t("custom.settings.<name>.label")`), so a hard-coded
English `.name()` is no longer correct.

The step most often forgotten is the server-side `sanitizeSettings()` in
`sitrecServer/settings.php` — it drops any key it does not recognize, so a setting whitelisted
only on the client silently fails to persist for logged-in users.

## Testing

Run the test suite:

```bash
npm test -- tests/SettingsManager.test.js
```

The test suite includes:
- Sanitization tests
- Cookie operations
- Server operations
- Integration tests
- Edge cases and error handling

## Local Development

In local development (when not logged into Metabunk), the system:
- Uses test user ID: `99999999`
- Falls back to cookie storage
- Still tests server endpoints if PHP backend is running

## User Experience

### Logged In Users
1. Settings are loaded from server on page load
2. Changes are saved to server immediately
3. Cookies are also updated as backup
4. Settings menu shows: "Per-user settings saved to server (with cookie backup)"

### Non-Logged In Users
1. Settings are loaded from cookies on page load
2. Changes are saved to cookies only
3. Settings menu shows: "Per-user settings saved in browser cookies"

## Error Handling

The system gracefully handles:
- Server unavailable (falls back to cookies)
- Network errors (falls back to cookies)
- Corrupted cookie data (uses defaults)
- Invalid settings values (sanitizes/clamps)
- Missing settings (uses defaults)

## Security Considerations

1. **Input Validation**: All settings are validated and sanitized
2. **Type Checking**: Values are converted to expected types
3. **Range Clamping**: Numeric values are clamped to safe ranges
4. **Whitelist Approach**: Only known settings are accepted
5. **Private Storage**: S3 files use private ACL
6. **Authentication**: Server endpoints require login
