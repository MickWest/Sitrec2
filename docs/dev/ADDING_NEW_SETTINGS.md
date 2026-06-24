# How to Add New Settings to Sitrec

This guide explains how to add a new user setting to the Sitrec application.

## Overview

Settings in Sitrec are:
- Stored on the server (S3) for logged-in users
- Stored in browser cookies as a fallback
- Sanitized on both client and server to prevent exploits
- Always available: the Settings menu/folder (language, performance, etc.) is created unconditionally on every sitch load. (`Sit.isCustom || Sit.canMod` gates the broader custom-sitch setup, not the settings menu.)

## Required Changes

When adding a new setting, you must make **6 changes across 5 files** (steps 1 and 2 both edit `SettingsManager.js`):

### 1. SettingsManager.js - Add Default Value

**File:** `sitrec/src/SettingsManager.js`

In the `initializeSettings()` function, add your default value:

```javascript
export async function initializeSettings() {
    if (!Globals.settings) {
        Globals.settings = {
            maxDetails: 20,
            yourNewSetting: defaultValue  // ← Add here
        };
    }
    // ...
}
```

### 2. SettingsManager.js - Add Sanitization (Client-Side)

**File:** `sitrec/src/SettingsManager.js`

In the `sanitizeSettings()` function, add validation:

```javascript
export function sanitizeSettings(settings) {
    const sanitized = {};
    
    // ... existing settings ...
    
    if (settings.yourNewSetting !== undefined) {
        // For boolean:
        sanitized.yourNewSetting = Boolean(settings.yourNewSetting);
        
        // For number with range:
        // const value = Number(settings.yourNewSetting);
        // sanitized.yourNewSetting = Math.max(min, Math.min(max, value));
        
        // For string:
        // sanitized.yourNewSetting = String(settings.yourNewSetting).substring(0, maxLength);
    }
    
    return sanitized;
}
```

### 3. settings.php - Add Sanitization (Server-Side)

**File:** `sitrec/sitrecServer/settings.php`

⚠️ **CRITICAL:** This is the most commonly forgotten step!

In the `sanitizeSettings()` function, add validation:

```php
function sanitizeSettings($settings) {
    // ... existing code ...
    
    if (isset($settings['yourNewSetting'])) {
        // For boolean:
        $sanitized['yourNewSetting'] = (bool)$settings['yourNewSetting'];
        
        // For number with range:
        // $value = floatval($settings['yourNewSetting']);
        // $sanitized['yourNewSetting'] = max($min, min($max, $value));
        
        // For string:
        // $sanitized['yourNewSetting'] = substr($settings['yourNewSetting'], 0, $maxLength);
    }
    
    return $sanitized;
}
```

### 4. CustomSupport.js - Add UI Control

**File:** `sitrec/src/CustomSupport.js`

In the `setupSettingsMenu()` method, add a UI control. The folder, labels, and
tooltips are internationalized: use `t("custom.settings.<yourSetting>.label")`
and `t("custom.settings.<yourSetting>.tooltip")` (you'll add those keys in step 6):

```javascript
setupSettingsMenu() {
    const settingsFolder = guiMenus.main.addFolder(t("custom.settings.title"))
        .tooltip(tooltipText)
        .close();
    
    // ... existing controls ...
    
    // For boolean (checkbox):
    settingsFolder.add(Globals.settings, "yourNewSetting")
        .name(t("custom.settings.yourNewSetting.label"))
        .tooltip(t("custom.settings.yourNewSetting.tooltip"))
        .onChange((value) => {
            Globals.settings.yourNewSetting = Boolean(value);
            this.saveGlobalSettings(true); // Immediate save for toggles
        })
        .listen();
    
    // For number (slider) — see the real maxDetails/tileSegments sliders:
    // don't save on every onChange frame; force an immediate save on release.
    // settingsFolder.add(Globals.settings, "yourNewSetting", min, max, step)
    //     .name(t("custom.settings.yourNewSetting.label"))
    //     .tooltip(t("custom.settings.yourNewSetting.tooltip"))
    //     .onChange((value) => {
    //         // Sanitize/clamp here, but do NOT save (this fires every frame of the drag)
    //         Globals.settings.yourNewSetting = value;
    //     })
    //     .onFinishChange(() => {
    //         this.saveGlobalSettings(true); // Force immediate save on release
    //     })
    //     .listen();
}
```

### 5. i18n/en.js - Add Label & Tooltip Strings

**File:** `sitrec/src/i18n/en.js`

The UI control's `.name()`/`.tooltip()` use `t(...)` keys, so add the strings
under the `custom.settings` object:

```javascript
custom: {
    settings: {
        // ... existing settings ...
        yourNewSetting: { label: "Your Setting Name", tooltip: "Description of what this setting does" },
    },
}
```

(Add matching keys to the other locale files if you want the setting translated;
untranslated keys fall back to English.)

### 6. SettingsManager.test.js - Add Tests

**File:** `sitrec/tests/SettingsManager.test.js`

Add test cases for your new setting:

```javascript
describe('sanitizeSettings', () => {
    // ... existing tests ...
    
    test('should sanitize yourNewSetting as boolean', () => {
        const input = { yourNewSetting: true };
        const result = sanitizeSettings(input);
        expect(result.yourNewSetting).toBe(true);
        expect(typeof result.yourNewSetting).toBe('boolean');
    });
    
    test('should convert truthy values to boolean for yourNewSetting', () => {
        const input = { yourNewSetting: 1 };
        const result = sanitizeSettings(input);
        expect(result.yourNewSetting).toBe(true);
    });
    
    test('should convert falsy values to boolean for yourNewSetting', () => {
        const input = { yourNewSetting: 0 };
        const result = sanitizeSettings(input);
        expect(result.yourNewSetting).toBe(false);
    });
});

describe('initializeSettings', () => {
    test('should initialize with default yourNewSetting', async () => {
        const result = await initializeSettings();
        expect(result.yourNewSetting).toBe(defaultValue);
    });
});
```

## Checklist

When adding a new setting, use this checklist:

- [ ] Add default value in `initializeSettings()` (SettingsManager.js)
- [ ] Add client-side sanitization in `sanitizeSettings()` (SettingsManager.js)
- [ ] Add server-side sanitization in `sanitizeSettings()` (settings.php) ⚠️
- [ ] Add UI control in `setupSettingsMenu()` (CustomSupport.js)
- [ ] Add label & tooltip strings under `custom.settings` (i18n/en.js)
- [ ] Add tests in SettingsManager.test.js
- [ ] Run `npm test` to verify all tests pass
- [ ] Run `npm run build` to verify build succeeds
- [ ] Test in browser:
  - [ ] Toggle/change the setting
  - [ ] Reload page and verify it persists
  - [ ] Check browser console for any errors

## Common Pitfalls

1. **Forgetting server-side sanitization** - This is the most common mistake! The PHP `sanitizeSettings()` function will strip out any settings it doesn't recognize.

2. **Type mismatches** - Make sure the sanitization on both client and server produces the same type (boolean, number, string).

3. **Not using `.listen()`** - GUI controls need `.listen()` to update when the value changes programmatically.

4. **Wrong save timing** - Use `saveGlobalSettings(true)` for immediate saves: call it directly from `.onChange()` for checkboxes/dropdowns, and from `.onFinishChange()` (on release) for sliders. Don't save on every slider `onChange` frame.

## Example: Adding a "Dark Mode" Setting

Here's a complete example:

```javascript
// 1. SettingsManager.js - initializeSettings()
Globals.settings = {
    maxDetails: 20,
    centerSidebar: false,
    darkMode: false  // ← New setting
};

// 2. SettingsManager.js - sanitizeSettings()
if (settings.darkMode !== undefined) {
    sanitized.darkMode = Boolean(settings.darkMode);
}

// 3. settings.php - sanitizeSettings()
if (isset($settings['darkMode'])) {
    $sanitized['darkMode'] = (bool)$settings['darkMode'];
}

// 4. CustomSupport.js - setupSettingsMenu()
settingsFolder.add(Globals.settings, "darkMode")
    .name(t("custom.settings.darkMode.label"))
    .tooltip(t("custom.settings.darkMode.tooltip"))
    .onChange((value) => {
        Globals.settings.darkMode = Boolean(value);
        this.saveGlobalSettings(true);
        // Apply dark mode styling here
        document.body.classList.toggle('dark-mode', value);
    })
    .listen();

// 5. i18n/en.js - custom.settings
darkMode: { label: "Dark Mode", tooltip: "Enable dark color scheme" },

// 6. SettingsManager.test.js
test('should sanitize darkMode as boolean', () => {
    const input = { darkMode: true };
    const result = sanitizeSettings(input);
    expect(result.darkMode).toBe(true);
});
```

## Testing Your Changes

1. **Build:** `npm run build`
2. **Test:** `npm test`
3. **Manual test:**
   - Load a custom sitch
   - Open browser console (F12)
   - Change your setting
   - Check console for save confirmation
   - Reload page
   - Verify setting persists

## Questions?

If you're unsure about any step, refer to the existing `maxDetails`, `centerSidebar`, or `showAttribution` settings as examples.