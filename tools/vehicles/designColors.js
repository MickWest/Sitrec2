import {ColorManagement} from "three";

// Designer swatches are sRGB. Three must decode them while constructing materials,
// vertex colors and lights, even when the host uses legacy color handling.
// Keep this scope synchronous so other renderers retain their own settings.
export function withSRGBInputs(create) {
    const previous = ColorManagement.enabled;
    ColorManagement.enabled = true;
    try {
        return create();
    } finally {
        ColorManagement.enabled = previous;
    }
}
