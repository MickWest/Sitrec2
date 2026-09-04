# How to Add a User Setting

This guide covers settings stored in `Globals.settings` and, normally, exposed in the
Settings menu. These settings are per-user application preferences, not part of a saved
sitch.

## Where Settings Live

A persisted setting normally touches six places in five files:

1. Its default in [`src/SettingsManager.js`](../../src/SettingsManager.js).
2. The browser allowlist in `sanitizeSettings()` in that file.
3. The server allowlist in [`sitrecServer/settings.php`](../../sitrecServer/settings.php).
4. Its control and behavior in [`src/CustomSupport.js`](../../src/CustomSupport.js).
5. Its English label and tooltip in [`src/i18n/en.js`](../../src/i18n/en.js).
6. Its unit tests in [`tests/SettingsManager.test.js`](../../tests/SettingsManager.test.js).

The two sanitizers are both allowlists. A key omitted from either one is discarded. The
parity test in
[`tests/settingsAllowlistParity.test.js`](../../tests/settingsAllowlistParity.test.js)
checks that the browser and PHP lists contain exactly the same keys.

## 1. Add the Default

Add the property to the defaults created by `initializeSettings()`:

```javascript
Globals.settings = {
    // Existing defaults...
    yourNewSetting: false,
};
```

Choose a safe default that works before storage has loaded. Sitrec initializes settings after
the login check and before nodes are created, then verifies initialization again before it
builds the Settings menu. Feature code should read the initialized value; it should not call
`initializeSettings()` itself.

If the setting is one of the performance controls, also keep the defaults and the `Balanced`
entry in `PERFORMANCE_PRESETS` in `src/CustomSupport.js` consistent.

## 2. Add Browser-Side Sanitization

Add the key to `sanitizeSettings()` in `src/SettingsManager.js`. Reject non-finite numbers
before clamping them:

```javascript
if (typeof settings.yourNewSetting === "boolean") {
    sanitized.yourNewSetting = settings.yourNewSetting;
}

if (settings.yourNewNumber !== undefined) {
    const raw = settings.yourNewNumber;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        sanitized.yourNewNumber = Math.max(0, Math.min(100, raw));
    }
}

if (settings.yourNewChoice !== undefined) {
    const value = String(settings.yourNewChoice);
    if (["first", "second"].includes(value)) {
        sanitized.yourNewChoice = value;
    }
}
```

Keep settings small and JSON-serializable. Do not put credentials in `Globals.settings`:
cookies and server settings are not secret stores.

## 3. Add Matching Server-Side Sanitization

Add equivalent validation to `sanitizeSettings()` in `sitrecServer/settings.php`:

```php
if (isset($settings['yourNewSetting']) && is_bool($settings['yourNewSetting'])) {
    $sanitized['yourNewSetting'] = $settings['yourNewSetting'];
}

if (isset($settings['yourNewNumber'])
    && (is_int($settings['yourNewNumber']) || is_float($settings['yourNewNumber']))) {
    $value = floatval($settings['yourNewNumber']);
    if (is_finite($value)) {
        $sanitized['yourNewNumber'] = max(0, min(100, $value));
    }
}

if (isset($settings['yourNewChoice'])) {
    $value = strval($settings['yourNewChoice']);
    if (in_array($value, ['first', 'second'], true)) {
        $sanitized['yourNewChoice'] = $value;
    }
}
```

The JavaScript and PHP versions must accept, reject, coerce, and clamp values the same way.
The parity test checks key names, but behavior tests are still needed for the chosen type and
range.

## 4. Add the UI Control

`CCustomManager.setupSettingsMenu()` in `src/CustomSupport.js` creates the Settings folder.
Bind the controller directly to `Globals.settings`.

For a checkbox or dropdown, save immediately:

```javascript
settingsFolder.add(Globals.settings, "yourNewSetting")
    .name(t("custom.settings.yourNewSetting.label"))
    .tooltip(t("custom.settings.yourNewSetting.tooltip"))
    .onChange((value) => {
        Globals.settings.yourNewSetting = Boolean(value);
        applyYourNewSetting();
        this.saveGlobalSettings(true);
    })
    .listen();
```

For a slider, update the live effect in `onChange()` and save once the gesture finishes:

```javascript
settingsFolder.add(Globals.settings, "yourNewNumber", 0, 100, 1)
    .name(t("custom.settings.yourNewNumber.label"))
    .tooltip(t("custom.settings.yourNewNumber.tooltip"))
    .onChange((value) => {
        Globals.settings.yourNewNumber = Math.max(0, Math.min(100, Math.round(value)));
        applyYourNewNumber();
    })
    .onFinishChange(() => this.saveGlobalSettings(true))
    .listen();
```

For a text or number field that fires on every keystroke, use the debounced save during edits
and an immediate save on commit. `setupStartupSettings()` contains the current latitude,
longitude, and altitude examples:

```javascript
controller
    .onChange(() => this.saveGlobalSettings())
    .onFinishChange(() => this.saveGlobalSettings(true));
```

`.listen()` is needed when code can change the bound value without going through this
controller. It is harmless but not mandatory for a value that changes only through one
controller.

## 5. Add Translatable Text

Add the English strings under `custom.settings` in `src/i18n/en.js`:

```javascript
yourNewSetting: {
    label: "Your Setting",
    tooltip: "Explain what changes, including any important units or limits",
},
```

Use the matching keys in `.name()` and `.tooltip()`. Add translations to the other locale
files when available; a missing translation falls back to English.

## 6. Add Tests

Import and test the real sanitizer in `tests/SettingsManager.test.js`:

```javascript
import {sanitizeSettings} from "../src/SettingsManager";

test("sanitizes yourNewSetting as a boolean", () => {
    expect(sanitizeSettings({yourNewSetting: true}).yourNewSetting).toBe(true);
    expect(sanitizeSettings({yourNewSetting: false}).yourNewSetting).toBe(false);
    expect(sanitizeSettings({yourNewSetting: 0}).yourNewSetting).toBeUndefined();
    expect(sanitizeSettings({}).yourNewSetting).toBeUndefined();
});
```

For a number or enumerated string, cover valid values, both bounds, coercion, and rejected
input. The allowlist parity test requires no edit; it will fail until the PHP key has been
added.

Run the targeted tests:

```bash
npx jest tests/SettingsManager.test.js tests/settingsAllowlistParity.test.js --runInBand
```

Then run the complete unit suite and a build:

```bash
npm test
npm run build
```

## Browser Check

After building, verify the setting through the normal UI:

- Change it and confirm the effect is applied without a reload when appropriate.
- Reload and confirm that the value persists.
- Check both an authenticated server-backed session and the intended browser-only mode if
  the deployment supports both.
- Check the console and network response for a rejected or stripped setting.

## Common Failure Modes

- **Only one allowlist was updated.** The other sanitizer strips the key. The parity test is
  designed to catch this.
- **The two sanitizers disagree.** Matching key names do not guarantee matching coercion or
  ranges.
- **The setting was put in sitch serialization.** Global preferences belong in
  `Globals.settings`; a sitch-specific value belongs in the relevant node or sitch instead.
- **A slider saves every drag event.** Save in `onFinishChange()` unless each intermediate value
  genuinely must be persisted.
- **A programmatic update leaves the controller stale.** Add `.listen()` or explicitly update
  the controller display.
- **A setting stores sensitive data.** Use the dedicated browser-only key store instead of the
  settings backends.
