# Shared Device Orientation Library

This directory contains shared JavaScript libraries that are used by both the main Sitrec application and standalone tools.

## DeviceOrientationCompass.js

A cross-platform library for reading device compass heading and elevation/tilt using device orientation sensors.

### Features

- **iOS Support**: Uses `webkitCompassHeading` with automatic tilt correction for the known 135° beta flip issue
- **Android Support**: Uses `deviceorientationabsolute` with calculated heading from alpha/beta/gamma
- **Screen Orientation**: Automatically adjusts readings for portrait/landscape/landscape-right orientations
- **Permission Handling**: Handles iOS 13+ permission requests
- **Edge Case Handling**: Smooth handling of iOS quirks and edge cases

### Usage in Main Sitrec App

```javascript
import { DeviceOrientationCompass } from "../tools/src/DeviceOrientationCompass.js";

const compass = new DeviceOrientationCompass();

// Set up callbacks
compass.onUpdate = (readings) => {
    console.log(`Heading: ${readings.heading}°, Elevation: ${readings.elevation}°`);
};

compass.onStatusChange = (message, isError) => {
    console.log(isError ? 'ERROR:' : 'INFO:', message);
};

// Request permission (required for iOS 13+)
const granted = await compass.requestPermission();

if (granted) {
    // Start listening to device orientation
    compass.startListening();
    
    // Get current readings at any time
    const readings = compass.getReadings();
    console.log(readings);
    // {
    //   heading: 45.2,        // 0-360°, 0 = North
    //   elevation: 85.3,      // Device tilt angle
    //   isAbsolute: true,     // Whether compass-based (true) or relative (false)
    //   raw: {
    //     alpha: 315.8,
    //     beta: 85.3,
    //     gamma: 2.1,
    //     webkit: 45,
    //     screenOrientation: 0
    //   }
    // }
}

// Stop listening when done
compass.stopListening();
```

### Usage in Standalone Tools (HTML)

```html
<!DOCTYPE html>
<html>
<head>
    <title>Compass Tool</title>
</head>
<body>
    <div id="heading">--</div>
    <div id="elevation">--</div>
    <button id="startBtn">Start Compass</button>

    <script type="module">
        import { DeviceOrientationCompass } from '../src/DeviceOrientationCompass.js';

        const compass = new DeviceOrientationCompass();
        
        compass.onUpdate = (readings) => {
            document.getElementById('heading').textContent = 
                `Heading: ${Math.round(readings.heading)}°`;
            document.getElementById('elevation').textContent = 
                `Elevation: ${Math.round(readings.elevation)}°`;
        };

        document.getElementById('startBtn').addEventListener('click', async () => {
            const granted = await compass.requestPermission();
            if (granted) {
                compass.startListening();
            }
        });
    </script>
</body>
</html>
```

### API Reference

#### Constructor

```javascript
const compass = new DeviceOrientationCompass();
```

Creates a new compass instance. Automatically detects iOS vs Android and sets up internal state.

#### Methods

##### `async requestPermission()`

Requests permission to access device orientation (required for iOS 13+). Returns a Promise that resolves to `true` if permission granted or not required, `false` otherwise.

##### `startListening()`

Starts listening to device orientation events. Returns `true` if started successfully, `false` if device orientation is not supported.

##### `stopListening()`

Stops listening to device orientation events and cleans up event listeners.

##### `getReadings()`

Returns current compass readings as an object:

```javascript
{
    heading: number,        // 0-360°, 0 = North, adjusted for screen orientation
    elevation: number,      // Device tilt angle, adjusted for screen orientation
    isAbsolute: boolean,    // Whether we have compass-based orientation (vs relative)
    raw: {
        alpha: number,           // Device orientation alpha (Z axis rotation)
        beta: number,            // Device orientation beta (X axis rotation)
        gamma: number,           // Device orientation gamma (Y axis rotation)
        webkit: number | null,   // iOS webkitCompassHeading (if available)
        screenOrientation: number // 0, 90, 270, or 180
    }
}
```

#### Callbacks

##### `onUpdate`

Called whenever device orientation changes. Receives readings object as parameter.

```javascript
compass.onUpdate = (readings) => {
    // Handle updated readings
};
```

##### `onStatusChange`

Called when the compass status changes (e.g., started, needs calibration, etc.).

```javascript
compass.onStatusChange = (message, isError) => {
    console.log(isError ? 'ERROR:' : 'INFO:', message);
};
```

### Coordinate Systems

#### Heading (Azimuth)
- Range: 0-360°
- 0° = North
- 90° = East
- 180° = South
- 270° = West
- Automatically adjusted for screen orientation (portrait/landscape)

#### Elevation (Tilt)
- In portrait mode, uses beta (front-to-back tilt)
- In landscape mode, uses gamma (side-to-side tilt) with corrections
- Values depend on device orientation
- For AR/PTZ usage: subtract 90° to get horizon-relative angle

### iOS Quirks Handled

1. **webkitCompassHeading 180° flip at ~135° beta**: When the device is tilted more than ~45° up or down in portrait mode, iOS flips the heading by 180°. The library detects and corrects this.

2. **Integer quantization**: webkitCompassHeading only provides integer degree values. For smooth AR applications, you may want to apply additional smoothing (see ARMode.js for example).

3. **Screen orientation**: webkitCompassHeading gives device-relative heading, which needs adjustment based on screen orientation.

### Examples

See:
- `/tools/compass/index.html` - Standalone compass tool using the library
- `/src/ARMode.js` - AR mode integration with PTZ system

### Development Notes

This library is placed in `/tools/src/` so that:
1. It gets automatically copied by webpack (via `{ from: "tools", to: "./tools" }`)
2. It can be imported by the main Sitrec app using relative imports
3. It can be used directly by standalone tools in the tools directory

No build step is required - both main app and tools use ES6 modules to import it directly.
