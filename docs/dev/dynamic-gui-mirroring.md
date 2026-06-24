# Dynamic GUI Mirroring

The dynamic GUI mirroring system allows you to create standalone floating menus that mirror any existing GUI folder or node controls. These mirrors automatically update when the original GUI changes, making them perfect for scenarios where menus are programmatically modified (like switching between model and geometry modes).

## Features

- **Automatic Updates**: Mirrors detect when original menus change and update accordingly
- **Event-Based Detection**: Uses efficient event hooking when possible, falls back to polling
- **Model/Geometry Switching**: Handles dynamic GUI changes like CNode3DObject switching modes
- **Manual Refresh**: Provides manual refresh capability when needed
- **Proper Cleanup**: Automatically cleans up resources when mirrors are destroyed

## Basic Usage

### Mirror a Standard GUI Menu

```javascript
// Mirror the objects menu
const objectsMirror = CustomManager.mirrorGUIFolder('objects', 'Objects Mirror', 300, 100);

// Mirror the effects menu
const effectsMirror = CustomManager.mirrorGUIFolder('effects', 'Effects Mirror', 400, 200);
```

### Mirror a Node's GUI

```javascript
// Mirror a specific node's GUI (useful for 3D objects)
const nodeMirror = CustomManager.mirrorNodeGUI('myObjectNode', 'Object Controls', 500, 150);
```

### Universal Mirror Creation

```javascript
// Create mirrors using the universal function
const menuMirror = CustomManager.createDynamicMirror('menu', 'objects', 'My Objects', 200, 100);
const nodeMirror = CustomManager.createDynamicMirror('node', 'myNode', 'My Node', 300, 200);
```

## Advanced Usage

### Manual Refresh

If automatic detection misses a change, you can manually refresh:

```javascript
const mirror = CustomManager.mirrorGUIFolder('objects', 'Objects Mirror');
mirror.refreshMirror(); // Force update
```

### Handling Model/Geometry Switching

The system automatically handles CNode3DObject switching between model and geometry modes:

```javascript
// Create a mirror for a 3D object
const objectMirror = CustomManager.mirrorNodeGUI('myObject', '3D Object Controls');

// When the object switches from model to geometry (or vice versa),
// the mirror will automatically update to show the new controls
```

### Multiple Mirrors

```javascript
// Create multiple mirrors for different menus
const mirrors = [];
['objects', 'effects', 'view'].forEach((menuName, index) => {
    const mirror = CustomManager.mirrorGUIFolder(
        menuName, 
        `${menuName} Mirror`, 
        200 + (index * 250), 
        100
    );
    mirrors.push(mirror);
});
```

## API Reference

### `mirrorGUIFolder(sourceFolderName, menuTitle, x, y)`

Creates a dynamic mirror of a GUI menu.

- `sourceFolderName` (string): Name of the menu in guiMenus to mirror
- `menuTitle` (string): Title for the mirrored menu
- `x` (number): X position for the menu (default: 200)
- `y` (number): Y position for the menu (default: 200)
- Returns: GUI object or null if source not found

### `mirrorNodeGUI(nodeId, menuTitle, x, y)`

Creates a dynamic mirror of a node's GUI.

- `nodeId` (string): ID of the node whose GUI to mirror
- `menuTitle` (string): Title for the mirrored menu
- `x` (number): X position for the menu (default: 200)
- `y` (number): Y position for the menu (default: 200)
- Returns: GUI object or null if node not found

### `createDynamicMirror(sourceType, sourceName, title, x, y)`

Universal function to create dynamic mirrors.

- `sourceType` (string): Either 'menu' or 'node'
- `sourceName` (string): Menu name or node ID
- `title` (string): Title for the mirrored menu
- `x` (number): X position (default: 200)
- `y` (number): Y position (default: 200)
- Returns: GUI object, or null if the source is not found or `sourceType` is not 'menu'/'node'

## How It Works

### Detection Methods

1. **Event-Based Detection** (Preferred): Hooks into GUI structure methods (`add()`, `addColor()`, `addFolder()`, `remove()`) and each controller's `destroy()` to detect changes immediately.

2. **Polling Detection** (Fallback): If event-based detection fails, falls back to checking for changes every 100ms using GUI signatures.

### GUI Signatures

The system creates signatures of GUI state by examining:
- Controller names, types, and visibility
- Folder names and open/closed state
- Recursive structure of nested folders

When signatures change, the mirror is rebuilt to match the new state.

### Cleanup

Mirrors automatically clean up when destroyed:
- Clears polling intervals
- Restores original GUI methods
- Removes event listeners
- Disposes of GUI elements

## Examples

See `tests/dynamic-mirroring.test.js` for usage examples, or use the console examples below.

## Console Usage

You can create mirrors directly from the browser console:

```javascript
// Mirror the objects menu
CustomManager.mirrorGUIFolder('objects', 'Objects Mirror');

// Mirror a specific node
CustomManager.mirrorNodeGUI('myNode', 'Node Mirror');

// Universal creation
CustomManager.createDynamicMirror('menu', 'effects', 'Effects Mirror');
```

## Troubleshooting

### Mirror Not Updating

1. Check if the original GUI is actually changing
2. Try manual refresh: `mirror.refreshMirror()`
3. Check console for error messages

### Performance Issues

1. Increase the polling interval by editing the hard-coded `checkInterval` value (default 100ms) in `setupDynamicMirroring` in `src/CustomManagerMirror.js`. Note this only affects the polling fallback; event-based detection is used when available.
2. Limit the number of active mirrors
3. Destroy unused mirrors to free resources

### Event Detection Not Working

The system automatically falls back to polling if event detection fails. Check console logs to see which method is being used.

## Best Practices

1. **Destroy Unused Mirrors**: Call `mirror.destroy()` when no longer needed
2. **Use Descriptive Titles**: Make it easy to identify different mirrors
3. **Position Strategically**: Place mirrors where they won't overlap with main UI
4. **Test Dynamic Changes**: Verify mirrors update correctly for your specific use case
5. **Monitor Performance**: Watch for performance impact with many active mirrors