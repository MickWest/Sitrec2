import {DayNightStandardMaterial} from "./js/map33/material/DayNightStandardMaterial";
import {Globals} from "./Globals";

// Symbol used to stash original materials on meshes for clean restore
const ORIGINAL_MATERIAL = Symbol("TilesDayNight_originalMaterial");
// Prior to the linear-workflow fix (copy shader sRGB encoding), Google tiles
// needed manual gamma correction (0.50 = sqrt). With proper output encoding
// in the copy shader this is no longer needed.
const DEFAULT_GOOGLE_TILE_OUTPUT_GAMMA = 1.0;

// Plugin for 3d-tiles-renderer that replaces tile materials with
// DayNightStandardMaterial instances, giving the same sun-based day/night
// lighting as the terrain tiles while preserving PBR textures, vertex colors,
// and texture atlases from the original materials.
export class TilesDayNightPlugin {

    constructor(options = {}) {
        this.tiles = null;
        this.source = options.source ?? "cesium-osm";
        this.googleTileOutputGamma = options.googleTileOutputGamma ?? DEFAULT_GOOGLE_TILE_OUTPUT_GAMMA;
        // V5 material modes: "photo" (default), "flat", "halfPhoto". Mode
        // changes apply to FUTURE tile loads only — re-walking loaded tiles
        // is unsafe (breaks TilesFadePlugin.FadeMaterialManager's WeakMap).
        this.materialMode = options.materialMode ?? "photo";
        this.flatColor = options.flatColor ?? null;
    }

    init(tiles) {
        this.tiles = tiles;
    }

    // Per-tile post-load callback. Default "photo" mode is the §0 fast path:
    // applyMaterialMode is NOT called at all (not even as a no-op), so a
    // sitch with material mode unchanged from default has zero added work.
    processTileModel(scene, tile) {
        scene.traverse(child => {
            if (child.isMesh && child.material) {
                const original = child.material;
                if (original[ORIGINAL_MATERIAL]) return; // already replaced

                const tileOutputGamma = this.source === "google-photorealistic" ? this.googleTileOutputGamma : 1.0;
                const replacement = DayNightStandardMaterial.fromMaterial(original, {
                    tileOutputGamma,
                    useSitrecShadowCoords: this.source === "google-photorealistic",
                });
                if (this.materialMode !== "photo") {
                    this.applyMaterialMode(replacement, original);
                }
                replacement[ORIGINAL_MATERIAL] = original;
                child.material = replacement;
            }
        });
    }

    // Apply a non-photo material mode to a fresh DayNightStandardMaterial.
    // Counter increments on every call so the §0 invariant test can detect
    // accidental defaults-on activation.
    applyMaterialMode(replacement, original) {
        const sourceDefault = this.source === "google-photorealistic" ? 0xc0b8a8 : 0xb8b4ac;
        const flatHex = this.flatColor ?? sourceDefault;
        switch (this.materialMode) {
            case "flat":
                replacement.map = null;
                replacement.color.setHex(flatHex).convertSRGBToLinear();
                replacement.needsUpdate = true;
                break;
            case "halfPhoto":
                replacement.color.setRGB(0.6, 0.6, 0.6);
                break;
            default:
                return;
        }
        Globals.shadowDiagCounters.materialModeApplications++;
    }

    // Update the active material mode. Applies to FUTURE tile loads only —
    // re-walking already-loaded tiles would orphan TilesFadePlugin entries.
    setMaterialMode(mode, flatColor) {
        this.materialMode = mode ?? "photo";
        if (flatColor !== undefined) this.flatColor = flatColor;
    }

    // Called by 3d-tiles-renderer with no arguments when the plugin is
    // unregistered or the tiles renderer is disposed.
    dispose() {
        if (this.tiles) {
            this.tiles.forEachLoadedModel(scene => {
                scene.traverse(child => {
                    if (child.isMesh && child.material) {
                        const original = child.material[ORIGINAL_MATERIAL];
                        if (original) {
                            child.material.dispose();
                            child.material = original;
                        }
                    }
                });
            });
        }
        this.tiles = null;
    }
}
