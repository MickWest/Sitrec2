import {Color} from "three";
import {SceneLineMaterial} from "./SceneLineMaterial";

// Shared styles; viewport sizing and antialiasing belong to each draw, so a
// material can be used safely by several views and quality presets.
const matLines = new Map();

export function makeMatLine(color, linewidth = 2, dashed = false) {
    if (typeof window === "undefined") return null;
    if (!color.isColor) color = new Color(color);
    const key = `${color.r},${color.g},${color.b}:${linewidth}:${dashed}`;
    let material = matLines.get(key);
    if (!material) {
        material = new SceneLineMaterial({color, linewidth, dashed});
        material.usageCount = 0;
        matLines.set(key, material);
    }
    material.usageCount++;
    return material;
}

export function disposeMatLine(material) {
    for (const [key, pooled] of matLines) {
        if (pooled !== material) continue;
        if (--material.usageCount <= 0) {
            material.dispose();
            matLines.delete(key);
        }
        break;
    }
}
