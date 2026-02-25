import {DayNightStandardMaterial} from "./js/map33/material/DayNightStandardMaterial";

// Symbol used to stash original materials on meshes for clean restore
const ORIGINAL_MATERIAL = Symbol("TilesDayNight_originalMaterial");
const DEFAULT_GOOGLE_TILE_OUTPUT_GAMMA = 0.66;

// Plugin for 3d-tiles-renderer that replaces tile materials with
// DayNightStandardMaterial instances, giving the same sun-based day/night
// lighting as the terrain tiles while preserving PBR textures, vertex colors,
// and texture atlases from the original materials.
export class TilesDayNightPlugin {

    constructor(options = {}) {
        this.tiles = null;
        this.source = options.source ?? "cesium-osm";
        this.googleTileOutputGamma = options.googleTileOutputGamma ?? DEFAULT_GOOGLE_TILE_OUTPUT_GAMMA;
    }

    init(tiles) {
        this.tiles = tiles;
    }

    // Called by 3d-tiles-renderer for each tile's scene graph on load.
    processTileModel(scene, tile) {
        scene.traverse(child => {
            if (child.isMesh && child.material) {
                const original = child.material;
                if (original[ORIGINAL_MATERIAL]) return; // already replaced

                const tileOutputGamma = this.source === "google-photorealistic" ? this.googleTileOutputGamma : 1.0;
                const replacement = DayNightStandardMaterial.fromMaterial(original, {tileOutputGamma});
                replacement[ORIGINAL_MATERIAL] = original;
                child.material = replacement;
            }
        });
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
